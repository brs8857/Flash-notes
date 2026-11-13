// Input controller: Pointer Events → tool actions, pinch/pan gestures, palm rejection, wheel,
// Safari trackpad gestures, two-finger-tap undo and keyboard shortcuts.
//
// An "action" is what one pointer is doing between pointerdown and pointerup:
//   { move(p, samples), end(p), cancel(commit:boolean), wantsCoalesced? }
// Tools (draw.js, eraser.js, selection.js, textedit.js) create them; pan/tap live here.

import { clampZoom } from './viewport.js';
import { clamp } from './geom.js';
import { COPY_MARKER, selectedText, pasteText, pasteImageFile } from './clipboard.js';

const TAP_SLOP = 10;        // px a finger may travel and still count as a tap
const EARLY_PINCH_MS = 150; // a 2nd finger this soon after the 1st cancels the 1st finger's stroke
const TWO_FINGER_TAP_MS = 350;
const PEN_GUARD_MS = 1000;  // no tap-undo this soon after the pencil lifted (resting palm)
const PEN_TEXT_GUARD_MS = 2000; // touches are ignored this long after the Pencil was last seen while a text box is open

const MAX_PREDICTED_TOUCH = 1, MAX_PREDICTED_PEN = 2;   // predicted samples drawn ahead of the pointer (live preview only)
const MAX_PREDICT_PX = 48;

const now = () => performance.now();

export class Input {
  constructor(view) {
    this.view = view;
    this.action = null;         // current one-pointer action
    this.touches = new Map();   // pointerId → {sx, sy, x0, y0, t0, moved}
    this.ignored = new Set();   // touch ids rejected as palm
    this.pinch = null;          // {a, b, d0, zoom0, wx, wy, mx, my}
    this.residual = null;       // one finger left after a pinch: it pans, never draws
    this.seq = null;            // touch sequence bookkeeping for tap gestures
    this.penId = null;
    this.penSeen = false;
    this.lastPen = -1e9;
    this.lastCopiedText = '';   // plain text we last put on the system clipboard (tells our own copy from foreign text)
    this.penNear = false;       // a Pencil has been seen (down, moving or hovering) inside the root
    this.space = false;
    this.gesture = null;        // Safari trackpad pinch
    this.inertiaRaf = 0;

    const r = view.root;
    this._l = [];
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this._l.push([target, type, fn, opts]); };
    on(r, 'pointerdown', (e) => this._down(e));
    on(r, 'pointermove', (e) => this._move(e));
    on(r, 'pointerup', (e) => this._up(e, false));
    on(r, 'pointercancel', (e) => this._up(e, true));
    on(r, 'pointerleave', (e) => { if (e.pointerType !== 'touch' && !this.action) view.eraser.hide(); });
    on(r, 'touchstart', (e) => { if (this._isCanvas(e.target) || this._handleOf(e.target)) e.preventDefault(); }, { passive: false });
    on(r, 'touchmove', (e) => { if (!this._isText(e.target)) e.preventDefault(); }, { passive: false });
    const lifted = (e) => { if (e.touches && e.touches.length === 0 && (this.touches.size || this.pinch || this.residual)) this._resetTouches(); };
    on(r, 'touchend', lifted, { passive: true });
    on(r, 'touchcancel', lifted, { passive: true });
    on(window, 'touchend', lifted, { passive: true });
    on(window, 'touchcancel', lifted, { passive: true });
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') this._resetTouches(); });
    on(r, 'wheel', (e) => this._wheel(e), { passive: false });
    on(r, 'gesturestart', (e) => this._gesture(e, 'start'), { passive: false });
    on(r, 'gesturechange', (e) => this._gesture(e, 'change'), { passive: false });
    on(r, 'gestureend', (e) => this._gesture(e, 'end'), { passive: false });
    on(r, 'contextmenu', (e) => { if (!this._isText(e.target)) e.preventDefault(); });   // Scribble / long-press menus in the text box
    on(r, 'selectstart', (e) => { if (!this._isText(e.target)) e.preventDefault(); });
    on(r, 'dragstart', (e) => e.preventDefault());
    on(document, 'paste', (e) => this._paste(e));
    on(document, 'copy', (e) => this._copyEvent(e, false));
    on(document, 'cut', (e) => this._copyEvent(e, true));
    on(window, 'keydown', (e) => this._key(e));
    on(window, 'keyup', (e) => { if (e.key === ' ') this._setSpace(false); });
    on(window, 'blur', () => { this._setSpace(false); this._resetTouches(); });
  }

  destroy() {
    clearTimeout(this._pasteTimer);
    this.abortAll();
    for (const [t, type, fn, opts] of this._l) t.removeEventListener(type, fn, opts);
    this._l.length = 0;
  }

  /** True while a pointer is down or a gesture is running. */
  get busy() { return !!this.action || this.touches.size > 0 || !!this.pinch || !!this.gesture || !!this.inertiaRaf; }

  /** Stop everything in flight (page swap, tool change, destroy). Pen/mouse work is kept; touch strokes are dropped only when `keepTouch` is false. */
  abortAll(keepTouch = true) {
    this.stopInertia();
    if (this.action) this._finish(keepTouch || this.action.type !== 'touch');
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear();
    this.pinch = this.residual = this.seq = this.gesture = null;
  }

  // ---- helpers -----------------------------------------------------------------------------------

  _isCanvas(t) { return t === this.view.live || t === this.view.main; }
  _isText(t) { return !!(t && t.closest && t.closest('textarea')); }
  _handleOf(t) { return t && t.closest ? t.closest('[data-cv-handle]') : null; }

  /** Pointer event → container px + world coordinates. Always via the container rect. */
  _pt(e, rect) {
    const v = this.view;
    rect = rect || this._measure();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    return {
      sx, sy, wx: v.view.x + sx / v.view.zoom, wy: v.view.y + sy / v.view.zoom,
      pressure: e.pressure, type: e.pointerType || 'mouse', id: e.pointerId,
    };
  }

  /**
   * Where the container is on screen. Reading layout on every pointer event is the classic way to make
   * drawing stutter, so it is measured when a pointer goes down and reused until every pointer is up.
   */
  _measure(fresh = false) {
    if (!fresh && this._rect && (this.action || this.touches.size || this.pinch)) return this._rect;
    const root = this.view.root, r = root.getBoundingClientRect();
    return (this._rect = { left: r.left + root.clientLeft, top: r.top + root.clientTop });
  }

  _capture(e) { try { e.target.setPointerCapture(e.pointerId); } catch { /* synthetic or stale pointer */ } }

  _setSpace(on) {
    this.space = on;
    this.view.root.classList.toggle('cv-space', on);
  }

  // ---- pointer events ----------------------------------------------------------------------------

  _down(e) {
    const v = this.view;
    // Every sign of the Pencil counts (also over the text box, where we otherwise stay out of the way).
    if (e.pointerType === 'pen') { this.lastPen = now(); this.penNear = true; v.smart.penActivity(); }
    const onCanvas = this._isCanvas(e.target);
    const handleEl = onCanvas ? null : this._handleOf(e.target);
    // textarea, menu buttons: leave native behaviour alone, except a finger joining a pan/pinch already under way
    // (a second finger resting on the text box must still zoom the page).
    if (!onCanvas && !handleEl && !(e.pointerType === 'touch' && this._isText(e.target) && (this.touches.size || this.pinch))) return;
    e.preventDefault();
    v.stopAnimations();
    const handle = handleEl ? handleEl.dataset.cvHandle : null;
    const p = this._pt(e, this.action || this.touches.size ? null : this._measure(true));

    if (p.type === 'touch') { this._touchDown(e, p, handle); return; }
    v.smart.pointerDown();
    if (p.type === 'pen') {
      if (!this.penSeen) {
        this.penSeen = true;
        try { v.opts.onPencilDetected && v.opts.onPencilDetected(); } catch (err) { console.error(err); }
      }
      this._dropTouches();          // the palm landed first: whatever it started is discarded
      if (this.action) this._finish(true);
      this.penId = e.pointerId;
      this.lastPen = now();
      this._capture(e);             // so the matching pointerup always reaches us (a stuck penId would block all touches)
    } else {
      if (e.button === 2) return;
      if (this.action) { if (e.button !== 0) return; this._finish(true); }
    }
    this._begin(e, p, handle, false);
  }

  /** Decide what this pointer does and start it. `fingerPan` = a finger in pencil-only mode. */
  _begin(e, p, handle, fingerPan) {
    const v = this.view, tool = v.tool;
    let wasEditing = false;
    // A finger that lands on empty canvas while a text box is open may be the start of a pan or pinch: keep the box
    // (and keyboard) open and only close it on a real tap. Everything else closes it straight away.
    const keepOpen = p.type === 'touch' && tool === 'text' && v.textEdit.active && !handle && !v.selection.has();
    if (!keepOpen && !(handle && handle.startsWith('text-'))) wasEditing = v.textEdit.commit();
    let a = null;
    if (keepOpen) a = this._tapOrPan(p, () => v.textEdit.commit());
    else if (handle === 'sel-resize') a = v.selection.beginResize(p);
    else if (handle === 'text-move') a = v.textEdit.beginMove(p);
    else if (handle === 'text-width') a = v.textEdit.beginWidth(p);
    else if (handle) a = null;
    else if (tool === 'hand' || (p.type === 'mouse' && (e.button === 1 || this.space))) a = this._pan(p);
    else if (v.selection.has() && v.selection.contains(p)) a = v.selection.beginMove(p);
    else {
      v.selection.clear();
      const openText = (q) => v.textEdit.tapAt(q);
      if (fingerPan) a = tool === 'text' && !wasEditing ? this._tapOrPan(p, openText) : this._pan(p);
      else if (tool === 'pen' || tool === 'highlighter') a = v.draw.begin(p, tool) || (p.type === 'touch' ? this._pan(p) : null);
      else if (tool === 'eraser') a = v.eraser.begin(p);
      else if (tool === 'lasso') a = v.selection.beginLasso(p);
      else if (tool === 'text' && !wasEditing) a = p.type === 'touch' ? this._tapOrPan(p, openText) : this._tap(p, openText);
    }
    if (!a) return;
    a.id = e.pointerId;
    a.type = p.type;
    this.action = a;
    this._capture(e);
  }

  /** Forget every finger: pan/pinch/residual/tap state. Used when events were lost (keyboard opened, system gesture,
   *  tool switch) so a ghost finger can never turn the next single touch into a two-finger pinch. */
  _resetTouches() {
    if (this.action && this.action.type === 'touch') this._finish(true);
    this.touches.clear();
    this.ignored.clear();
    const had = !!(this.pinch || this.residual);
    this.pinch = this.residual = this.seq = null;
    if (had) this.view.settleZoom();
  }

  _touchDown(e, p, handle) {
    const v = this.view, t = now();
    // The first finger of a new gesture is always `isPrimary`. If we still think fingers are down, a pointerup/cancel
    // was lost: start clean instead of treating this finger as the second of a pinch (which only pans and never draws).
    if (e.isPrimary && (this.touches.size || this.pinch || this.residual)) this._resetTouches();
    if (this.penId !== null) { this.ignored.add(e.pointerId); return; } // palm while writing
    // Scribble: the Pencil writes into the textarea without us seeing a pen-down (penId stays null), so a
    // resting palm must not close the box. Fingers work again once the Pencil has been away for 2 s.
    if (v.textEdit.active && t - this.lastPen < PEN_TEXT_GUARD_MS) { this.ignored.add(e.pointerId); return; }
    if (!v.pencilOnly && v.tool !== 'hand') v.smart.pointerDown();
    this.touches.set(e.pointerId, { sx: p.sx, sy: p.sy, x0: p.sx, y0: p.sy, t0: t, moved: false });
    const n = this.touches.size;
    if (n === 1) {
      this.seq = { t0: t, max: 1, tap: !handle };
      this.residual = null;
      this._begin(e, p, handle, v.pencilOnly);
      return;
    }
    if (!this.seq) this.seq = { t0: t, max: n, tap: false };
    this.seq.max = Math.max(this.seq.max, n);
    if (this.action) {
      // A second finger: this is a pinch, not a stroke. Drop the first finger's ink when it has barely
      // started; keep it if the user was genuinely mid-stroke.
      const first = this.touches.get(this.action.id);
      const early = !first || t - first.t0 < EARLY_PINCH_MS || !first.moved;
      this._finish(!early);
    }
    this.residual = null;
    this._capture(e);
    this._startPinch();
  }

  _move(e) {
    const v = this.view, id = e.pointerId;
    if (e.pointerType === 'pen') { this.lastPen = now(); this.penNear = true; if (!this.action) v.smart.penActivity(); }
    if (e.pointerType === 'touch') {
      if (this.ignored.has(id)) return;
      const t = this.touches.get(id);
      if (!t) return;
      const p = this._pt(e);
      t.sx = p.sx; t.sy = p.sy;
      if (!t.moved && Math.hypot(p.sx - t.x0, p.sy - t.y0) > TAP_SLOP) {
        t.moved = true;
        if (this.seq) this.seq.tap = false;
      }
      if (this.pinch) { this._pinchMove(); return; }
      if (this.residual && this.residual.id === id) {
        const z = v.view.zoom;
        v.applyView({ x: this.residual.wx - p.sx / z, y: this.residual.wy - p.sy / z, zoom: z }, { interactive: true, user: true });
        return;
      }
      if (this.action && this.action.id === id) this._actionMove(e, p);
      return;
    }
    if (this.action && this.action.id === id) {
      this._actionMove(e, this._pt(e));
    } else if (!this.action && v.tool === 'eraser' && this._isCanvas(e.target)) {
      v.eraser.hover(this._pt(e)); // Apple Pencil hover / mouse: only the cursor follows
    }
  }

  _actionMove(e, p) {
    const a = this.action;
    let list = null, pred = null;
    if (a.wantsCoalesced) {
      // Every sample the hardware took since the last event (Apple Pencil reports faster than the display refreshes).
      if (e.getCoalescedEvents) {
        let ce = null;
        try { ce = e.getCoalescedEvents(); } catch { /* ignore */ }
        if (ce && ce.length > 1) {
          const rect = this._measure();
          list = ce.map((c) => this._pt(c, rect));
        }
      }
      // Where the browser expects the pointer to be next: shown in the live stroke only, never stored.
      if (e.getPredictedEvents) {
        let pe = null;
        try { pe = e.getPredictedEvents(); } catch { /* ignore */ }
        if (pe && pe.length) {
          const v = this.view, rect = this._measure(), z = v.view.zoom;
          const n = Math.min(pe.length, p.type === 'pen' ? MAX_PREDICTED_PEN : MAX_PREDICTED_TOUCH);
          pred = [];
          for (let i = 0; i < n; i++) {
            const sx = pe[i].clientX - rect.left, sy = pe[i].clientY - rect.top;
            // A wild guess (direction change, lifted finger) is worse than none; so is a missing coordinate.
            if (!(Math.hypot(sx - p.sx, sy - p.sy) <= MAX_PREDICT_PX)) break;
            pred.push([v.view.x + sx / z, v.view.y + sy / z, p.type === 'pen' ? clamp(pe[i].pressure || p.pressure || 0.5, 0.05, 1) : 0.5]);
          }
        }
      }
    }
    a.move(p, list || [p], pred);
  }

  _up(e, cancelled) {
    const v = this.view, id = e.pointerId;
    if (e.pointerType === 'touch') {
      if (this.ignored.delete(id)) return;
      if (!this.touches.has(id)) return;
      const p = this._pt(e);
      this.touches.delete(id);
      if (cancelled && this.seq) this.seq.tap = false;
      if (this.pinch) {
        if (this.touches.size >= 2) this._startPinch();
        else {
          this.pinch = null;
          const rest = this.touches.entries().next().value;
          if (rest) this.residual = { id: rest[0], wx: v.view.x + rest[1].sx / v.view.zoom, wy: v.view.y + rest[1].sy / v.view.zoom };
        }
      } else if (this.action && this.action.id === id) {
        if (cancelled) this._finish(false); else this._end(p); // cancelled touch stroke: discard
      }
      if (this.touches.size === 0) {
        const seq = this.seq;
        this.seq = this.residual = null;
        v.settleZoom();
        if (seq && seq.tap && seq.max >= 2 && now() - seq.t0 < TWO_FINGER_TAP_MS
          && v.twoFingerUndo && this.penId === null && now() - this.lastPen > PEN_GUARD_MS) {
          if (seq.max === 2) v.undo(); else if (seq.max === 3) v.redo();
        }
      }
      return;
    }
    if (e.pointerType === 'pen' && id === this.penId) { this.penId = null; this.lastPen = now(); }
    if (this.action && this.action.id === id) {
      // A cancelled pen stroke is committed: iPadOS cancels on system interruptions, never lose ink.
      if (cancelled) this._finish(e.pointerType === 'pen'); else this._end(this._pt(e));
    }
  }

  _end(p) {
    const a = this.action;
    this.action = null;
    if (a) a.end(p);
  }

  _finish(commit) {
    const a = this.action;
    this.action = null;
    if (a) a.cancel(commit);
  }

  resetTouches() { this._resetTouches(); }

  /** Public: commit whatever the active pointer is doing (tool switch mid-stroke). */
  finishAction() { if (this.action) this._finish(true); }

  _dropTouches() {
    if (this.action && this.action.type === 'touch') this._finish(false);
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear();
    if (this.pinch || this.residual) this.view.settleZoom();
    this.pinch = this.residual = this.seq = null;
  }

  // ---- built-in actions --------------------------------------------------------------------------

  _pan(p) {
    const v = this.view;
    const wx = p.wx, wy = p.wy;
    const trail = [[now(), p.sx, p.sy]];
    v.root.classList.add('cv-panning');
    const stop = () => v.root.classList.remove('cv-panning');
    return {
      move: (q) => {
        const z = v.view.zoom;
        v.applyView({ x: wx - q.sx / z, y: wy - q.sy / z, zoom: z }, { interactive: true, user: true });
        const t = now();
        trail.push([t, q.sx, q.sy]);
        while (trail.length > 2 && t - trail[0][0] > 90) trail.shift();
      },
      end: (q) => {
        stop();
        const t = now(), first = trail[0];
        const dt = t - first[0];
        if (q.type === 'touch' && trail.length > 1 && dt > 8 && dt < 200) {
          this._inertia((q.sx - first[1]) / dt, (q.sy - first[2]) / dt);
        }
      },
      cancel: stop,
    };
  }

  /** Momentum scrolling after a finger pan (iOS-like exponential decay). */
  _inertia(vx, vy) {
    const v = this.view;
    if (Math.hypot(vx, vy) < 0.25 || v.reducedMotion()) return;
    let last = now();
    const tick = () => {
      const t = now(), dt = Math.min(48, t - last);
      last = t;
      const z = v.view.zoom, before = v.view;
      v.applyView({ x: before.x - (vx * dt) / z, y: before.y - (vy * dt) / z, zoom: z }, { interactive: true, user: true });
      const k = Math.exp(-dt / 325);
      vx *= k; vy *= k;
      const stuck = v.view === before; // clamped at an edge
      this.inertiaRaf = !stuck && Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(tick) : 0;
    };
    this.inertiaRaf = requestAnimationFrame(tick);
  }

  stopInertia() {
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    this.inertiaRaf = 0;
  }

  _tap(p, fn) {
    let moved = false;
    return {
      move: (q) => { if (Math.hypot(q.sx - p.sx, q.sy - p.sy) > 8) moved = true; },
      end: (q) => { if (!moved) fn(q); },
      cancel: () => {},
    };
  }

  /** Finger with the text tool: a tap places/edits text, a drag pans. */
  _tapOrPan(p, fn) {
    const pan = this._pan(p);
    this.view.root.classList.remove('cv-panning');
    let moved = false;
    return {
      move: (q) => {
        if (!moved && Math.hypot(q.sx - p.sx, q.sy - p.sy) > 8) moved = true;
        if (moved) pan.move(q);
      },
      end: (q) => { if (moved) pan.end(q); else { pan.cancel(); fn(q); } },
      cancel: () => pan.cancel(),
    };
  }

  // ---- pinch -------------------------------------------------------------------------------------
  // Always computed from the state at pinch start (never incremental deltas, which drift): the world
  // point under the initial midpoint stays under the current midpoint.

  _startPinch() {
    const v = this.view;
    const [a, b] = [...this.touches.keys()];
    const ta = this.touches.get(a), tb = this.touches.get(b);
    const mx = (ta.sx + tb.sx) / 2, my = (ta.sy + tb.sy) / 2;
    this.pinch = {
      a, b, d0: Math.max(8, Math.hypot(ta.sx - tb.sx, ta.sy - tb.sy)), zoom0: v.view.zoom,
      wx: v.view.x + mx / v.view.zoom, wy: v.view.y + my / v.view.zoom, mx, my,
    };
  }

  _pinchMove() {
    const v = this.view, pn = this.pinch;
    const ta = this.touches.get(pn.a), tb = this.touches.get(pn.b);
    if (!ta || !tb) return;
    const d = Math.max(8, Math.hypot(ta.sx - tb.sx, ta.sy - tb.sy));
    const mx = (ta.sx + tb.sx) / 2, my = (ta.sy + tb.sy) / 2;
    const z = clampZoom((pn.zoom0 * d) / pn.d0, v.mode, true); // soft limits, spring back on release
    pn.mx = mx; pn.my = my;
    v.focal = [mx, my];
    v.applyView({ x: pn.wx - mx / z, y: pn.wy - my / z, zoom: z }, { interactive: true, user: true });
  }

  // ---- wheel & Safari gestures -------------------------------------------------------------------

  _wheel(e) {
    if (this._isText(e.target)) return;
    e.preventDefault();
    const v = this.view;
    v.stopAnimations();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= v.cssW; dy *= v.cssH; }
    const z = v.view.zoom;
    if (e.ctrlKey || e.metaKey) { // trackpad pinch (Chrome/Firefox) or ctrl+wheel
      const p = this._pt(e);
      v.zoomAt(p.sx, p.sy, clampZoom(z * Math.exp(-clamp(dy, -80, 80) * 0.01), v.mode), { interactive: true });
    } else {
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      v.applyView({ x: v.view.x + dx / z, y: v.view.y + dy / z, zoom: z }, { interactive: true, user: true });
    }
  }

  /** Desktop Safari trackpad pinch. On iPad these fire next to touch pointers and are ignored. */
  _gesture(e, phase) {
    e.preventDefault();
    const v = this.view;
    if (this.touches.size || this.pinch) { this.gesture = null; return; }
    if (phase === 'start') { v.stopAnimations(); this.gesture = { zoom0: v.view.zoom }; return; }
    if (!this.gesture) return;
    if (phase === 'change' && Number.isFinite(e.scale) && e.scale > 0) {
      const p = this._pt(e);
      v.zoomAt(p.sx, p.sy, clampZoom(this.gesture.zoom0 * e.scale, v.mode, true), { interactive: true });
    } else if (phase === 'end') {
      this.gesture = null;
      v.settleZoom();
    }
  }

  // ---- keyboard ----------------------------------------------------------------------------------

  // ---- system clipboard ---------------------------------------------------------------------------

  /** Events from a text box / input / dialog belong to that control, not to the canvas. */
  _clipboardTarget(e) {
    const v = this.view, t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]')) return false;
    return v.root.isConnected && v.root.getClientRects().length > 0;
  }

  /** Copy the selection: in-memory (strokes, text, images) and, as plain text, to the system clipboard. */
  exportClipboard() {
    const v = this.view;
    if (!v.selection.copy()) return null;
    const text = selectedText(v);
    this.lastCopiedText = text;
    this._copiedAt = now();
    try { const p = navigator.clipboard && navigator.clipboard.writeText(text || COPY_MARKER); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed here */ }
    return text;
  }

  _copyEvent(e, cut) {
    const v = this.view;
    if (!this._clipboardTarget(e) || !v.selection.has() || !e.clipboardData) return;
    const text = this.exportClipboard();
    if (text === null) return;
    try { e.clipboardData.setData('text/plain', text || COPY_MARKER); e.preventDefault(); } catch { /* ignore */ }
    if (cut) v.selection.delete();
  }

  _paste(e) {
    const v = this.view;
    if (!this._clipboardTarget(e)) return;
    clearTimeout(this._pasteTimer);
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...(cd.files || [])].filter((f) => /^image\//.test(f.type));
    const text = cd.getData('text/plain') || '';
    const internal = v.selection.canPaste();
    // Our own copy: the marker, or the exact text we put there, or nothing else on the clipboard.
    const ours = internal && (text === COPY_MARKER || (text !== '' && text === this.lastCopiedText) || (!text.trim() && !files.length));
    e.preventDefault();
    v.stopAnimations();
    if (ours) { v.requestTool('lasso'); v.selection.paste(); }
    else if (files.length) pasteImageFile(v, files[0]);
    else if (text.trim()) pasteText(v, text);
    else if (internal) { v.requestTool('lasso'); v.selection.paste(); }
  }

  _key(e) {
    const v = this.view;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]')) return;
    if (!v.root.isConnected || !v.root.getClientRects().length) return; // hidden behind another screen
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const take = () => { e.preventDefault(); };
    if (mod) {
      if (k === 'z') { take(); if (e.shiftKey) v.redo(); else v.undo(); }
      else if (k === 'y') { take(); v.redo(); }
      else if (k === 'c' && v.selection.has()) { this.exportClipboard(); }                 // no preventDefault: Safari may still fire 'copy'
      else if (k === 'x' && v.selection.has()) { this.exportClipboard(); v.selection.delete(); }
      else if (k === 'v') {
        // The 'paste' event (text/images from other apps) decides what to do; if the browser sends none, paste our own copy.
        clearTimeout(this._pasteTimer);
        this._pasteTimer = setTimeout(() => { if (v.selection.canPaste()) { v.requestTool('lasso'); v.selection.paste(); } }, 200);
        return;
      }
      else if (k === 'd' && v.selection.has()) { take(); v.selection.duplicate(); }
      else if (k === 'a') { take(); v.requestTool('lasso'); v.selection.set(v.items.map((it) => it.id)); }
      return;
    }
    if (e.altKey) return;
    if (k === 'Delete' || k === 'Backspace') { if (v.selection.has()) { take(); v.selection.delete(); } return; }
    if (k === 'Escape') { v.selection.clear(); return; }
    if (k === ' ') {
      if (t && t.closest && t.closest('button, a, summary')) return;   // Space must still activate a focused button
      take(); if (!e.repeat) this._setSpace(true); return;
    }
    const tool = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text' }[k];
    if (tool && !e.repeat) { take(); v.requestTool(tool); }
  }
}

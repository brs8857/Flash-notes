// Smart ink controller (SPEC v1.1): auto shapes, auto-tidy, the "Keep original" pill and the morph
// effect. It owns ALL of their timers and state; `cancel()` drops everything and is called by the view
// on load / destroy / page hide / undo / redo / engine-initiated tool changes.
//
// Strokes are tracked by object identity (items are immutable), never by id.

import { PAGE_W, PAGE_H } from './constants.js';
import { bboxOfItems, bboxContains, bboxIntersects } from './geom.js';
import { recognizeShape, SHAPE_LABELS } from './shapes.js';
import { tidyStrokes, markTidied } from './tidy.js';
import { finalizeItem } from './items.js';
import { strokePath } from './strokes.js';
import { displayColor } from './paper.js';

const IDLE_MS = 4000;      // pen away (no hover, no touch-down) this long → tidy what is pending
const REARM_MS = 1000;     // busy at fire time → try again
const PILL_MS = 3000;
const MORPH_MS = 180;
const MORPH_MAX = 300;     // no morph for bigger conversions
const HAND_MAX_H = 120;    // taller strokes are drawing, not handwriting
const RULES = { lined: [120, 32], narrow: [96, 24], cornell: [142, 32] };
const SHAPE_ICONS = { line: '／', arrow: '→', axes: '└', polyline: '∧', circle: '◯', ellipse: '⬭', rectangle: '▭', square: '□', triangle: '△' };

const now = () => performance.now();
function median(list) {
  const a = list.slice().sort((x, y) => x - y), m = a.length >> 1;
  return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : 0;
}

export class SmartInk {
  constructor(view) {
    this.view = view;
    this.autoShapes = true;
    this.autoTidy = true;
    this.pending = [];        // committed raw pen strokes waiting to be tidied
    this.pageSeq = 0;         // bumped on every page swap: stale timers do nothing
    this.idleT = 0; this.armT = 0; this.pillT = 0;
    this.act = 0;             // last sign of the pen (pointerup / hover): the idle clock counts from here
    this.armed = null;        // snapshot of `pending` taken when the pen moved to a new line
    this.line = null;         // {bottoms:[], } strokes of the line being written
    this.newLine = false;
    this.last = null;         // previous raw pen stroke {bbox, t} (letter-in-word guard)
    this.fx = null;           // {items, t0} raw ink fading out over its replacement
    this.keep = null;         // {added, removed, bbox} behind the pill
    this.pill = null;
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  /** Drop every timer, the pending list, the pill and the effect. */
  cancel() {
    clearTimeout(this.idleT); clearTimeout(this.armT);
    this.idleT = this.armT = 0;
    this.pending = [];
    this.armed = null; this.line = null; this.last = null; this.newLine = false;
    this.hidePill();
    this.stopFx();
  }

  destroy() {
    this.cancel();
    if (this.pill) { this.pill.remove(); this.pill = null; }
  }

  pageChanged() { this.pageSeq++; }

  setOptions(o) {
    if (typeof o.autoShapes === 'boolean') this.autoShapes = o.autoShapes;
    if (typeof o.autoTidy === 'boolean' && o.autoTidy !== this.autoTidy) {
      this.autoTidy = o.autoTidy;
      if (!this.autoTidy) {       // no stray tidy later
        clearTimeout(this.idleT); clearTimeout(this.armT);
        this.idleT = this.armT = 0;
        this.pending = []; this.armed = null; this.line = null;
      }
    }
  }

  /** setTimeout that does nothing once the view is destroyed or shows another page. */
  _timer(fn, ms) {
    const seq = this.pageSeq;
    return setTimeout(() => { if (!this.view.destroyed && seq === this.pageSeq) fn(); }, ms);
  }

  // ---- hooks called by the view / input / tools --------------------------------------------------------

  /** A pointer went down on the canvas to use a tool. */
  pointerDown() {
    this.hidePill();
    this.stopFx();
    clearTimeout(this.idleT); this.idleT = 0;
  }

  /**
   * Pencil hover or any other sign that the pen is still around: the idle clock starts again. This runs
   * on every hover event, so it only stores a timestamp (the timer re-checks it when it fires) and
   * re-arms a clock that a finger / eraser / tool change had stopped.
   */
  penActivity() {
    this.act = now();
    if (!this.idleT && this.pending.length && this.autoTidy && this.view.tool === 'pen') this._idle();
  }

  /** Switching tools: the pill and the effect go. The clocks keep running (a tidy that is busy re-arms every second, SPEC). */
  toolChanged() { this.hidePill(); this.stopFx(); }

  /** Every view.commit(). Anything but ink being added (or our own conversions) ends the pending tidy. */
  onCommit(reason) {
    this.hidePill();
    if (reason === 'stroke' || reason === 'shape' || reason === 'tidy') return;
    clearTimeout(this.idleT); clearTimeout(this.armT);
    this.idleT = this.armT = 0;
    this.pending = []; this.armed = null; this.line = null; this.last = null;
  }

  /** Pen tool went down at world point p: a new line of writing arms the tidy of the lines above. */
  penDown(p) {
    this.newLine = false;
    this.armed = null;          // a stroke that never finished (cancelled) must not leave a stale arm behind
    if (!this.line) return;
    const v = this.view;
    const base = median(this.line.bottoms);
    const h = Math.max(6, median(this.pending.map((it) => it.bbox[3] - it.bbox[1])));
    const rule = v.mode === 'page' ? RULES[v.paper.style] : null;
    let below;
    if (rule) {
      const band = Math.round((base - rule[0]) / rule[1]);
      below = Math.ceil((p.wy - rule[0] - 0.25 * rule[1]) / rule[1]) > band;
    } else below = p.wy > base + 1.2 * h;
    if (!below) return;
    if (this.pending.some((it) => bboxContains(it.bbox, p.wx, p.wy, 16))) return;
    this.newLine = true;
    if (this.autoTidy && this.pending.length) this.armed = this.pending.slice();
  }

  /**
   * Auto shapes: should the pen stroke that just ended become a shape?
   * @returns {null | {kind, points}}
   */
  autoShape(points, bbox) {
    if (!this.autoShapes) return null;
    const v = this.view;
    if (Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]) < 90) return null;     // ordinary handwriting: below every size gate
    const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
    // Local handwriting scale: median size of the nearby writing (needs a few samples to mean anything).
    const sizes = [];
    for (let i = v.items.length - 1; i >= 0 && sizes.length < 30; i--) {
      const it = v.items[i];
      if (it.type !== 'stroke' || it.tool !== 'pen' || it.shape || it.uniform) continue;
      const b = it.bbox, w = b[2] - b[0], h = b[3] - b[1];
      if (h >= HAND_MAX_H || w >= 3 * HAND_MAX_H) continue;
      if (Math.hypot((b[0] + b[2]) / 2 - cx, (b[1] + b[3]) / 2 - cy) > 600) continue;
      sizes.push(Math.hypot(w, h));
    }
    const prev = this.last ? { bbox: this.last.bbox, dt: now() - this.last.t } : undefined;
    let r = null;
    try {
      r = recognizeShape(points, { mode: 'auto', zoom: v.view.zoom, scale: sizes.length >= 5 ? median(sizes) : undefined, prev });
    } catch (err) { console.error(err); }
    return r;
  }

  /** A pen stroke was committed. `raw` = the free-hand stroke it replaced when `item` is a shape. */
  strokeDone(item, raw) {
    const v = this.view;
    if (raw) {
      this.last = null;
      this.showPill(`${SHAPE_ICONS[item.shape.kind] || ''} ${SHAPE_LABELS[item.shape.kind] || 'Shape'}`.trim(), [item], [raw]);
    } else {
      const b = item.bbox;
      this.last = { bbox: b, t: now() };
      if (this.autoTidy && b[3] - b[1] < HAND_MAX_H + item.size * 2) {
        this.pending.push(item);
        if (this.newLine || !this.line) this.line = { bottoms: [] };
        this.line.bottoms.push(b[3] - item.size);
      }
    }
    this.newLine = false;
    if (this.armed) {
      // Run after this pointerup, never during the stroke: the first stroke of the new line has no hitch.
      const list = this.armed;
      this.armed = null;
      clearTimeout(this.armT);
      this.armT = this._timer(() => { this.armT = 0; this._fire(list, false); }, 0);
    }
    if (v.tool === 'pen') this._idle();
  }

  // ---- auto-tidy ---------------------------------------------------------------------------------------

  _idle() {
    clearTimeout(this.idleT); this.idleT = 0;
    this.act = now();
    if (!this.autoTidy || !this.pending.length) return;
    this.idleT = this._timer(() => this._idleFire(), IDLE_MS);
  }

  /** The idle timer ran out: tidy only if the pen really has been away since (hover moves `act`). */
  _idleFire() {
    this.idleT = 0;
    const left = IDLE_MS - (now() - this.act);
    if (left > 50) { this.idleT = this._timer(() => this._idleFire(), left); return; }
    this._fire(null, true);
  }

  _busy() {
    const v = this.view;
    return v.isBusy() || v.input.busy || v.selection.has() || !!v.selection.lasso || v.textEdit.active || v.tool !== 'pen';
  }

  /** Tidy `list` (or everything pending). Busy → try again in a second; pending cleared → nothing. */
  _fire(list, idle) {
    const v = this.view;
    if (!this.autoTidy) return;
    this.pending = this.pending.filter((it) => v.items.includes(it));
    if (list) list = list.filter((it) => this.pending.includes(it));
    if (!this.pending.length || (list && !list.length)) return;
    if (this._busy()) {
      if (idle) { clearTimeout(this.idleT); this.idleT = this._timer(() => this._idleFire(), REARM_MS); }
      else { clearTimeout(this.armT); this.armT = this._timer(() => { this.armT = 0; this._fire(list, false); }, REARM_MS); }
      return;
    }
    const strokes = list || this.pending.slice();
    // Each stroke gets one automatic chance: whatever happens, these leave the pending list.
    this.pending = this.pending.filter((it) => !strokes.includes(it));
    if (idle) this.line = null;
    this.tidy(strokes, { auto: true });
    if (this.pending.length) this._idle();
  }

  /**
   * Tidy the given pen strokes in place (one history entry). @returns {object[]|null} the items that
   * replaced them (same order; untouched strokes are the same objects), or null when nothing changed.
   */
  tidy(strokes, { auto = false } = {}) {
    const v = this.view;
    strokes = strokes.filter((it) => it.type === 'stroke' && it.tool === 'pen' && v.items.includes(it));
    if (!strokes.length) return null;
    const mine = new Set(strokes);
    const obstacles = auto
      ? v.items.filter((it) => it.type !== 'stroke' || it.tool === 'highlighter' || (it.uniform && !mine.has(it))).map((it) => it.bbox)
      : [];
    let res;
    try {
      res = tidyStrokes(strokes, {
        mode: auto ? 'auto' : 'manual',
        paper: v.mode === 'page' ? v.paper : undefined,
        bounds: v.mode === 'page' ? [0, 0, PAGE_W, PAGE_H] : undefined,
        obstacles,
      });
    } catch (err) { console.error(err); return null; }
    if (!res.changed) return null;
    const swap = new Map(), added = [], removed = [];
    const out = strokes.map((orig, i) => {
      if (res.strokes[i] === orig) return orig;
      const next = finalizeItem(res.strokes[i]);
      markTidied(next);
      swap.set(orig, next); added.push(next); removed.push(orig);
      return next;
    });
    if (!added.length) return null;
    if (!auto && removed.length <= MORPH_MAX) this.morph(removed);
    const next = v.items.map((it) => swap.get(it) || it);       // in place: z-order and indices unchanged
    v.commit(v.items, next, 'tidy');
    this.showPill('✨ Tidied', added, removed, !auto);
    return out;
  }

  // ---- "Keep original" pill ----------------------------------------------------------------------------

  showPill(label, added, removed, below = false) {
    const v = this.view;
    if (!this.pill) {
      const b = this.pill = document.createElement('button');
      b.type = 'button';
      b.className = 'cv-pill';
      b.hidden = true;
      const l = document.createElement('span');
      l.className = 'cv-pill-label';
      l.setAttribute('aria-live', 'polite');
      const k = document.createElement('span');
      k.className = 'cv-pill-keep';
      k.textContent = 'Keep original';
      b.append(l, k);
      b.addEventListener('click', (e) => { e.stopPropagation(); this.keepOriginal(); });
      v.overlay.append(b);
    }
    this.keep = { added, removed, bbox: bboxOfItems(added), below };
    this.pill.firstChild.textContent = label;
    this.pill.hidden = false;
    this.pill.classList.remove('cv-pop');
    this.pillSize = [this.pill.offsetWidth, this.pill.offsetHeight];
    if (!v.reducedMotion()) this.pill.classList.add('cv-pop');
    this.sync();
    clearTimeout(this.pillT);
    this.pillT = this._timer(() => this.hidePill(), PILL_MS);
  }

  hidePill() {
    clearTimeout(this.pillT); this.pillT = 0;
    this.keep = null;                       // the closure (and the original ink) is dropped
    if (this.pill) this.pill.hidden = true;
  }

  /** Put the original ink back: a new history entry, so undo returns to the converted version. */
  keepOriginal() {
    const k = this.keep, v = this.view;
    this.hidePill();
    this.stopFx();
    if (!k || v.destroyed) return;
    if (!k.added.every((it) => v.items.includes(it))) return;       // something changed meanwhile
    const back = new Map(k.added.map((it, i) => [it, k.removed[i]]));
    const ids = v.selection.has() ? new Set(v.selection.ids) : null;
    const next = v.items.map((it) => back.get(it) || it);
    v.commit(v.items, next, 'keep-original');
    if (ids) {                              // a lasso selection follows its ink back
      for (const [a, r] of back) if (ids.delete(a.id)) ids.add(r.id);
      v.selection.set([...ids]);
    }
  }

  /** Reposition the pill (screen space) after a view change. */
  sync() {
    const k = this.keep;
    if (!k || !this.pill || this.pill.hidden) return;
    const v = this.view, z = v.view.zoom, u = v.usable();
    const [w, h] = this.pillSize || [0, 0];
    const b = k.bbox;
    const cx = ((b[0] + b[2]) / 2 - v.view.x) * z;
    const top = (b[1] - v.view.y) * z, bottom = (b[3] - v.view.y) * z;
    let y = k.below ? bottom + 34 : top - h - 12;
    if (!k.below && y < u.y + 8) y = bottom + 12;
    y = Math.min(Math.max(y, u.y + 8), Math.max(u.y + 8, u.y + u.h - h - 8));
    const x = Math.min(Math.max(cx - w / 2, u.x + 8), Math.max(u.x + 8, u.x + u.w - w - 8));
    this.pill.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---- morph: the raw ink fades out over what replaced it ---------------------------------------------

  morph(items) {
    const v = this.view;
    if (v.reducedMotion() || !items.length) return;
    this.fx = { items, t0: now() };
    v.invalidateLive();
  }

  stopFx() {
    if (!this.fx) return;
    this.fx = null;
    this.view.invalidateLive();
  }

  /** Called by the view's live-layer draw (ctx in world coordinates). @returns {boolean} drew something */
  renderLive(ctx) {
    const fx = this.fx;
    if (!fx) return false;
    const v = this.view;
    const t = (now() - fx.t0) / MORPH_MS;
    if (t >= 1) { this.fx = null; return false; }
    const vis = [v.view.x, v.view.y, v.view.x + v.cssW / v.view.zoom, v.view.y + v.cssH / v.view.zoom];
    ctx.save();
    ctx.globalAlpha = (1 - t) * (1 - t) * 0.85;
    const dark = v.isDark();
    for (const it of fx.items) {
      if (!bboxIntersects(it.bbox, vis)) continue;
      ctx.fillStyle = displayColor(it.color, dark);
      ctx.fill(strokePath(it));
    }
    ctx.restore();
    v.invalidateLive();          // next frame
    return true;
  }
}

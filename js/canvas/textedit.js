// Text boxes: an auto-growing <textarea> in the overlay, laid out at WORLD scale and CSS-scaled by the
// zoom (its computed font-size therefore never drops below 16px, so iOS does not zoom the page on
// focus). Committed text is drawn on the canvas by text.js using the same layout.

import { PAGE_W, PAGE_H, LINE_HEIGHT, MIN_FONT_SIZE, TEXT_DEFAULT_W, newId } from './constants.js';
import { clamp, round2 } from './geom.js';
import { computeLayout, fontFamily } from './text.js';
import { finalizeItem, hitTestItems } from './items.js';
import { displayColor } from './paper.js';

const FRAME_PAD = 8; // screen px between the text and its frame

export class TextEditor {
  constructor(view) {
    this.view = view;
    this.cur = null; // {item (mutable working copy), original, isNew, wrap, ta, frame}
    this._onVV = () => this._viewportChanged();
  }

  get active() { return !!this.cur; }

  /** Tap with the text tool: edit the text box under the point or create a new one. Must be called
   *  synchronously from a user gesture (pointerup) so iOS raises the keyboard. */
  tapAt(p) {
    const v = this.view;
    const hit = hitTestItems(v.items, p.wx, p.wy, 12 / v.view.zoom, ['text']);
    if (hit) { this.open(hit, false); return; }
    if (v.mode === 'page' && !v.inPage(p.wx, p.wy)) return;
    this.createAt(p.wx, p.wy);
  }

  /** New empty box whose first line is vertically centred on (wx, wy). */
  createAt(wx, wy) {
    const v = this.view, o = v.toolOpts.text;
    const fontSize = Math.max(MIN_FONT_SIZE, o.size);
    let x = wx, y = wy - (fontSize * LINE_HEIGHT) / 2, w = TEXT_DEFAULT_W;
    if (v.mode === 'page') {
      x = clamp(x, 8, PAGE_W - 136);
      w = clamp(PAGE_W - 16 - x, 120, TEXT_DEFAULT_W);
      y = clamp(y, 0, PAGE_H - fontSize * LINE_HEIGHT);
    }
    this.open({ id: newId(), type: 'text', x: round2(x), y: round2(y), w, text: '', color: o.color, fontSize, font: o.font }, true);
  }

  open(item, isNew) {
    this.commit();
    const v = this.view;
    v.selection.clear();
    const wrap = document.createElement('div');
    wrap.className = 'cv-text-edit';
    const ta = document.createElement('textarea');
    ta.className = 'cv-textarea';
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('aria-label', 'Text box');
    ta.spellcheck = false;
    ta.rows = 1;
    ta.placeholder = 'Type here';
    ta.value = item.text || '';
    wrap.appendChild(ta);

    const frame = document.createElement('div');
    frame.className = 'cv-text-frame';
    const move = document.createElement('div');
    move.className = 'cv-handle cv-handle--move';
    move.dataset.cvHandle = 'text-move';
    move.setAttribute('aria-label', 'Move text box');
    const width = document.createElement('div');
    width.className = 'cv-handle cv-handle--width';
    width.dataset.cvHandle = 'text-width';
    width.setAttribute('aria-label', 'Change text box width');
    frame.append(move, width);

    const c = this.cur = { item: { ...item }, original: item, isNew, wrap, ta, frame };
    if (!isNew) { v.hidden.add(item.id); v.invalidate(); }
    v.overlay.append(frame, wrap);
    this._style();
    this._layout();
    this.sync();

    ta.addEventListener('input', () => { this._layout(); this.sync(); this._ensureCaret(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.commit(); }
    });
    // Synchronous focus inside the gesture: the only way to raise the iOS keyboard.
    try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* ignore */ }
    const vv = window.visualViewport;
    if (vv) { vv.addEventListener('resize', this._onVV); vv.addEventListener('scroll', this._onVV); }
    v.root.classList.add('cv-editing');
    this._ensureCaret();
    return c;
  }

  /** Apply text tool options (colour / size / font) to the box being edited. */
  setOptions(o) {
    const c = this.cur;
    if (!c) return;
    if (o.color) c.item.color = o.color;
    if (o.size) c.item.fontSize = Math.max(MIN_FONT_SIZE, o.size);
    if (o.font) c.item.font = o.font;
    this._style();
    this._layout();
    this.sync();
  }

  _style() {
    const { item, ta } = this.cur;
    ta.style.fontSize = item.fontSize + 'px';
    ta.style.fontFamily = fontFamily(item.font);
    ta.style.color = displayColor(item.color, this.view.isDark());
  }

  /** Recompute the height from the shared layout and grow the textarea to match. */
  _layout() {
    const c = this.cur;
    c.item.text = c.ta.value;
    c.wrap.style.width = c.item.w + 'px';
    let h = computeLayout(c.item).h;
    c.ta.style.height = h + 'px';
    if (c.ta.scrollHeight > h + 1) { // browser wrapped a line differently: never clip while typing
      h = c.ta.scrollHeight;
      c.ta.style.height = h + 'px';
    }
    c.h = h;
  }

  /** Position the editor (world-scaled) and its frame (screen space). */
  sync() {
    const c = this.cur;
    if (!c) return;
    const v = this.view, z = v.view.zoom;
    const [sx, sy] = v.toScreen(c.item.x, c.item.y);
    c.wrap.style.transform = `translate(${sx}px, ${sy}px) scale(${z})`;
    const f = c.frame.style;
    f.transform = `translate(${sx - FRAME_PAD}px, ${sy - FRAME_PAD}px)`;
    f.width = c.item.w * z + FRAME_PAD * 2 + 'px';
    f.height = c.h * z + FRAME_PAD * 2 + 'px';
  }

  beginMove(p) {
    const c = this.cur;
    if (!c) return null;
    const v = this.view, x0 = c.item.x, y0 = c.item.y;
    return {
      move: (q) => {
        let x = x0 + q.wx - p.wx, y = y0 + q.wy - p.wy;
        if (v.mode === 'page') { x = clamp(x, -c.item.w + 40, PAGE_W - 40); y = clamp(y, 0, PAGE_H - 20); }
        c.item.x = round2(x); c.item.y = round2(y);
        this.sync();
      },
      end: () => {},
      cancel: () => {},
    };
  }

  beginWidth(p) {
    const c = this.cur;
    if (!c) return null;
    const w0 = c.item.w;
    return {
      move: (q) => {
        c.item.w = round2(clamp(w0 + q.wx - p.wx, 60, 4000));
        this._layout();
        this.sync();
      },
      end: () => {},
      cancel: () => {},
    };
  }

  /** Finish editing. Empty text removes the box. @returns {boolean} whether an edit was open */
  commit() {
    const c = this.cur;
    if (!c) return false;
    const v = this.view;
    this.cur = null;
    const vv = window.visualViewport;
    if (vv) { vv.removeEventListener('resize', this._onVV); vv.removeEventListener('scroll', this._onVV); }
    const text = c.ta.value;
    c.wrap.remove();
    c.frame.remove();
    v.root.classList.remove('cv-editing');
    v.hidden.delete(c.item.id);
    if (v.kbInset) { v.kbInset = 0; v.applyView(v.view, { silent: true }); }
    const empty = text.trim() === '';
    const o = c.original;
    if (c.isNew) {
      if (!empty) v.addItems([finalizeItem({ ...c.item, text })], 'text');
    } else if (empty) {
      v.commit(v.items, v.items.filter((it) => it !== o), 'text');
    } else if (text !== o.text || c.item.x !== o.x || c.item.y !== o.y || c.item.w !== o.w
      || c.item.color !== o.color || c.item.fontSize !== o.fontSize || c.item.font !== o.font) {
      const next = finalizeItem({ ...c.item, text });
      v.commit(v.items, v.items.map((it) => (it === o ? next : it)), 'text');
    }
    v.invalidate();
    return true;
  }

  // ---- On-screen keyboard ------------------------------------------------------------------------
  // The iOS keyboard overlays the bottom of the layout viewport and pans the visual viewport. Treat
  // the covered strip as an extra bottom inset and keep the caret line above it.

  _viewportChanged() {
    if (!this.cur) return;
    const v = this.view, vv = window.visualViewport;
    const r = v.root.getBoundingClientRect();
    const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    v.kbInset = Math.max(0, Math.round(r.bottom - visibleBottom));
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    this._ensureCaret();
  }

  _ensureCaret() {
    const c = this.cur;
    if (!c) return;
    const v = this.view, z = v.view.zoom;
    const u = v.usable();
    let caret = c.ta.value.length;
    try { caret = c.ta.selectionEnd ?? caret; } catch { /* ignore */ }
    const lay = computeLayout({ ...c.item, text: c.ta.value.slice(0, caret) });
    const bottom = (c.item.y + lay.h - v.view.y) * z;
    const top = bottom - lay.lineHeight * z;
    const limit = u.y + u.h - 24;
    let dy = 0;
    if (bottom > limit) dy = bottom - limit;
    else if (top < u.y + 8) dy = top - (u.y + 8);
    if (Math.abs(dy) > 0.5) v.applyView({ x: v.view.x, y: v.view.y + dy / z, zoom: z }, { user: true });
  }
}

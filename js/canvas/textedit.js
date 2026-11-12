// Text boxes: an auto-growing <textarea> in the overlay, laid out at WORLD scale and CSS-scaled by the
// zoom (its computed font-size therefore never drops below 16px, so iOS does not zoom the page on
// focus). Committed text is drawn on the canvas by text.js using the same layout.

import { PAGE_W, PAGE_H, LINE_HEIGHT, MIN_FONT_SIZE, TEXT_DEFAULT_W, PEN_BOX_W, newId } from './constants.js';
import { clamp, round2 } from './geom.js';
import { computeLayout, fontFamily } from './text.js';
import { finalizeItem, hitTestItems } from './items.js';
import { displayColor } from './paper.js';

const FRAME_PAD = 8; // screen px between the text and its frame
// Pencil writing boxes (Scribble): the textarea is padded by PEN_PAD screen px on every side so writing
// may start a little outside the text, and the frame (with its handles) sits just outside that padding.
const PEN_PAD = 28, PEN_FRAME_PAD = 32, PEN_MIN_H = 96;
const PEN_PLACEHOLDER = 'Write here with Apple Pencil…';

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
    if (p.type === 'pen') this.createPenBox(p.wx, p.wy); else this.createAt(p.wx, p.wy);
  }

  /**
   * Apple Pencil tapped with the text tool: a roomy writing box in the handwriting font and the pen's
   * colour, ready for Scribble. The tap point ends up at the start of the first line, PEN_PAD px inside
   * the editable area. Does not change the text tool's own font.
   */
  createPenBox(wx, wy) {
    const v = this.view, o = v.toolOpts.text;
    const fontSize = Math.max(24, MIN_FONT_SIZE, o.size);
    let x = wx, y = wy - (fontSize * LINE_HEIGHT) / 2, w = PEN_BOX_W;
    if (v.mode === 'page') {
      x = clamp(x, 8, PAGE_W - 136);
      w = clamp(PAGE_W - 16 - x, 120, PEN_BOX_W);
      y = clamp(y, 0, PAGE_H - fontSize * LINE_HEIGHT);
    }
    const c = this.open({ id: newId(), type: 'text', x: round2(x), y: round2(y), w, text: '', color: v.toolOpts.pen.color, fontSize, font: 'hand' }, true, true);
    if (typeof v.opts.onPencilTextBox === 'function') {
      try { v.opts.onPencilTextBox(); } catch (err) { console.error(err); }
    }
    return c;
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

  open(item, isNew, pen = false) {
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
    ta.placeholder = pen ? PEN_PLACEHOLDER : 'Type here';
    if (pen) { wrap.classList.add('cv-text-edit--pen'); ta.classList.add('cv-textarea--pen'); }
    ta.value = item.text || '';
    wrap.appendChild(ta);

    const frame = document.createElement('div');
    frame.className = 'cv-text-frame' + (pen ? ' cv-text-frame--pen' : '');
    const move = document.createElement('div');
    move.className = 'cv-handle cv-handle--move';
    move.dataset.cvHandle = 'text-move';
    move.setAttribute('aria-label', 'Move text box');
    const width = document.createElement('div');
    width.className = 'cv-handle cv-handle--width';
    width.dataset.cvHandle = 'text-width';
    width.setAttribute('aria-label', 'Change text box width');
    frame.append(move, width);

    const c = this.cur = { item: { ...item }, original: item, isNew, pen, wrap, ta, frame, pad: 0, minH: 0 };
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

  /** The font arrived (or changed): measure and place the open box again. */
  relayout() {
    if (!this.cur) return;
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
    if (c.pen) {
      // Real padding (in world units, so PEN_PAD px on screen) cancelled by a negative margin: the text
      // origin does not move, but the Pencil can land anywhere in the padded area.
      const z = this.view.view.zoom;
      c.pad = PEN_PAD / z;
      c.minH = Math.max(2 * c.item.fontSize * LINE_HEIGHT, PEN_MIN_H / z);
      c.ta.style.padding = c.pad + 'px';
      c.ta.style.margin = -c.pad + 'px';
    }
    let h = Math.max(computeLayout(c.item).h, c.minH);
    c.ta.style.height = h + 'px';
    const sh = c.ta.scrollHeight - 2 * c.pad;
    if (sh > h + 1) { // browser wrapped a line differently: never clip while typing
      h = sh;
      c.ta.style.height = h + 'px';
    }
    c.h = h;
  }

  /** Position the editor (world-scaled) and its frame (screen space). */
  sync() {
    const c = this.cur;
    if (!c) return;
    const v = this.view, z = v.view.zoom;
    if (c.pen && Math.abs(c.pad * z - PEN_PAD) > 0.5) this._layout();      // zoom changed: keep the padding at PEN_PAD px
    const [sx, sy] = v.toScreen(c.item.x, c.item.y);
    c.wrap.style.transform = `translate(${sx}px, ${sy}px) scale(${z})`;
    const f = c.frame.style, fp = c.pen ? PEN_FRAME_PAD : FRAME_PAD;
    f.transform = `translate(${sx - fp}px, ${sy - fp}px)`;
    f.width = c.item.w * z + fp * 2 + 'px';
    f.height = c.h * z + fp * 2 + 'px';
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
    // WebKit finishes marked text / an in-flight Scribble composition on blur: blur first, then read.
    try { c.ta.blur(); } catch { /* ignore */ }
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

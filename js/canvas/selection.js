// Lasso + selection: freeform lasso, tap-to-select, move, uniform resize, and the floating
// context menu (Delete · Duplicate · Colour ▸ · Copy / Paste).

import { PAGE_W, PAGE_H, INK_COLORS, newId } from './constants.js';
import { bboxOfItems, bboxContains, bboxIntersects, pointInPolygon, clamp } from './geom.js';
import { transformItem, hitTestItems } from './items.js';
import { drawItems } from './render.js';

const PAD = 8;            // screen px between the items' bbox and the dashed outline
const SVG_NS = 'http://www.w3.org/2000/svg';

// In-memory clipboard, shared by every CanvasView so copy → change page → paste works.
let clipboard = null;

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

export class Selection {
  constructor(view) {
    this.view = view;
    this.ids = new Set();
    this.bbox = null;       // world bbox of the selected items
    this.xf = null;         // {s, ox, oy, dx, dy, items} while dragging / resizing
    this.lasso = null;      // world points of the lasso being drawn
    this.pasteAt = null;    // world point of the "Paste" bubble
    this.menuMode = 'main';
    this.menuSize = [0, 0];

    this.box = el('div', 'cv-sel');
    const svg = document.createElementNS(SVG_NS, 'svg');
    this.rect = document.createElementNS(SVG_NS, 'rect');
    this.rect.setAttribute('x', '1'); this.rect.setAttribute('y', '1');
    svg.appendChild(this.rect);
    this.box.appendChild(svg);
    this.handle = el('div', 'cv-handle cv-handle--resize', { 'data-cv-handle': 'sel-resize', role: 'button', 'aria-label': 'Resize selection' });
    this.menu = el('div', 'cv-menu', { role: 'toolbar', 'aria-label': 'Selection actions' });
    this.box.hidden = this.handle.hidden = this.menu.hidden = true;
    view.overlay.append(this.box, this.handle, this.menu);
  }

  has() { return this.ids.size > 0; }
  selected() { return this.view.items.filter((it) => this.ids.has(it.id)); }

  /** Select the given item ids (replaces the current selection). */
  set(ids) {
    this._hideAll();
    this.ids = new Set(ids);
    this._refresh();
  }

  _refresh() {
    const items = this.selected();
    if (!items.length) { this.clear(); return; }
    this.ids = new Set(items.map((it) => it.id));
    this.bbox = bboxOfItems(items);
    this.pasteAt = null;
    this._renderMenu('main');
    this.box.hidden = this.handle.hidden = false;
    this.sync();
  }

  _hideAll() {
    this.box.hidden = this.handle.hidden = this.menu.hidden = true;
  }

  clear() {
    if (this.xf) this._abortXf();
    if (!this.ids.size && !this.pasteAt) return;
    this.ids = new Set();
    this.bbox = null;
    this.pasteAt = null;
    this._hideAll();
  }

  /** Is the pointer inside the selection rectangle? */
  contains(p) {
    return !!this.bbox && bboxContains(this.bbox, p.wx, p.wy, PAD / this.view.view.zoom);
  }

  // ---- Lasso -----------------------------------------------------------------------------------

  beginLasso(p) {
    const v = this.view;
    this.clear();
    const L = this.lasso = { pts: [[p.wx, p.wy]], moved: false };
    return {
      move: (q) => {
        if (!L.moved && Math.hypot(q.sx - p.sx, q.sy - p.sy) > 6) L.moved = true;
        const last = L.pts[L.pts.length - 1];
        if (Math.hypot(q.wx - last[0], q.wy - last[1]) * v.view.zoom >= 2) L.pts.push([q.wx, q.wy]);
        v.invalidateLive();
      },
      end: (q) => {
        this.lasso = null;
        v.invalidateLive();
        if (L.moved) this._selectInside(L.pts); else this._tap(q);
      },
      cancel: () => { this.lasso = null; v.invalidateLive(); },
    };
  }

  _tap(p) {
    const v = this.view;
    const hit = hitTestItems(v.items, p.wx, p.wy, 10 / v.view.zoom);
    if (hit) this.set([hit.id]);
    else if (clipboard) this._showPaste(p);
  }

  _selectInside(poly) {
    if (poly.length < 3) return;
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of poly) box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])];
    const ids = [];
    for (const it of this.view.items) {
      if (!bboxIntersects(it.bbox, box)) continue;
      if (it.type === 'stroke') {
        let inside = 0;
        for (const pt of it.points) if (pointInPolygon(pt[0], pt[1], poly)) inside++;
        if (inside * 2 >= it.points.length) ids.push(it.id);
      } else if (pointInPolygon((it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2, poly)) ids.push(it.id);
    }
    if (ids.length) this.set(ids);
  }

  // ---- Move / resize ---------------------------------------------------------------------------
  // While dragging, the selected items are hidden on the main canvas and drawn on the live canvas
  // under a temporary transform; geometry is rewritten once, on release.

  _startXf() {
    const v = this.view;
    this.xf = { s: 1, ox: 0, oy: 0, dx: 0, dy: 0, items: this.selected() };
    for (const id of this.ids) v.hidden.add(id);
    this.menu.classList.add('cv-out');
    this.box.classList.add('cv-sel--drag');
    v.invalidate();
  }

  _endXf() {
    const v = this.view;
    for (const id of this.ids) v.hidden.delete(id);
    this.xf = null;
    this.menu.classList.remove('cv-out');
    this.box.classList.remove('cv-sel--drag');
    v.invalidate();
    v.invalidateLive();
  }

  _abortXf() { this._endXf(); this.sync(); }

  _applyXf() {
    const v = this.view;
    const { s, ox, oy, dx, dy } = this.xf;
    const ids = this.ids;
    this._endXf();
    if (s !== 1 || dx || dy) {
      const after = v.items.map((it) => (ids.has(it.id) ? transformItem(it, s, ox, oy, dx, dy) : it));
      v.commit(v.items, after, s === 1 ? 'move' : 'resize');
    }
    this._refresh();
  }

  beginMove(p) {
    const v = this.view;
    let moved = false;
    return {
      move: (q) => {
        if (!moved) {
          if (Math.hypot(q.sx - p.sx, q.sy - p.sy) < 4) return;
          moved = true;
          this._startXf();
        }
        let dx = q.wx - p.wx, dy = q.wy - p.wy;
        if (v.mode === 'page') { // keep the selection's centre on the page so it cannot be lost
          const b = this.bbox, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
          dx = clamp(dx, -cx, PAGE_W - cx);
          dy = clamp(dy, -cy, PAGE_H - cy);
        }
        this.xf.dx = dx; this.xf.dy = dy;
        v.invalidateLive();
        this.sync();
      },
      end: () => { if (moved) this._applyXf(); },
      cancel: (commit) => { if (moved) { if (commit) this._applyXf(); else this._abortXf(); } },
    };
  }

  beginResize(p) {
    const v = this.view;
    const b = this.bbox;
    if (!b) return null;
    const ox = b[0], oy = b[1];
    const w = Math.max(b[2] - b[0], 0.01), h = Math.max(b[3] - b[1], 0.01);
    const d2 = w * w + h * h;
    const proj = (q) => ((q.wx - ox) * w + (q.wy - oy) * h) / d2; // along the box diagonal
    const s0 = Math.max(proj(p), 0.05);
    const minS = Math.min(1, 12 / v.view.zoom / Math.max(w, h));
    this._startXf();
    this.xf.ox = ox; this.xf.oy = oy;
    return {
      move: (q) => {
        this.xf.s = clamp(proj(q) / s0, minS, 40);
        v.invalidateLive();
        this.sync();
      },
      end: () => this._applyXf(),
      cancel: (commit) => { if (commit) this._applyXf(); else this._abortXf(); },
    };
  }

  // ---- Actions ---------------------------------------------------------------------------------

  delete() {
    if (!this.has()) return;
    const v = this.view, ids = this.ids;
    this.clear();
    v.commit(v.items, v.items.filter((it) => !ids.has(it.id)), 'delete');
  }

  duplicate() {
    if (!this.has()) return;
    const v = this.view;
    const d = Math.max(12, 20 / v.view.zoom);
    const copies = this.selected().map((it) => transformItem(it, 1, 0, 0, d, d, newId()));
    v.addItems(copies, 'duplicate');
    this.set(copies.map((it) => it.id));
  }

  recolor(color) {
    if (!this.has()) return;
    const v = this.view, ids = this.ids;
    const after = v.items.map((it) => (ids.has(it.id) && it.type !== 'image' && it.color !== color ? { ...it, color } : it));
    v.commit(v.items, after, 'recolor');
  }

  copy() {
    const items = this.selected();
    if (!items.length) return false;
    clipboard = { items, bbox: bboxOfItems(items) };
    return true;
  }

  canPaste() { return !!clipboard; }

  /** Paste the clipboard centred on a world point (default: centre of the visible area). */
  paste(at) {
    if (!clipboard) return;
    const v = this.view;
    const b = clipboard.bbox;
    let [cx, cy] = at || this.pasteAt || v.centerWorld();
    if (v.mode === 'page') { cx = clamp(cx, 0, PAGE_W); cy = clamp(cy, 0, PAGE_H); }
    const dx = cx - (b[0] + b[2]) / 2, dy = cy - (b[1] + b[3]) / 2;
    const copies = clipboard.items.map((it) => transformItem(it, 1, 0, 0, dx, dy, newId()));
    this.clear();
    v.addItems(copies, 'paste');
    this.set(copies.map((it) => it.id));
  }

  // ---- Context menu ----------------------------------------------------------------------------

  _showPaste(p) {
    this.pasteAt = [p.wx, p.wy];
    this._renderMenu('paste');
    this.sync();
  }

  _button(label, onClick, className) {
    const b = el('button', 'cv-menu-btn' + (className ? ' ' + className : ''), { type: 'button' });
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
    return b;
  }

  _renderMenu(mode) {
    const m = this.menu;
    this.menuMode = mode;
    m.textContent = '';
    m.classList.toggle('cv-menu--colors', mode === 'colors');
    if (mode === 'paste') {
      m.append(this._button('Paste', () => this.paste()));
    } else if (mode === 'colors') {
      const back = this._button('', () => this._renderMenu('main'), 'cv-menu-back');
      back.setAttribute('aria-label', 'Back');
      m.append(back);
      for (const c of INK_COLORS) {
        const sw = el('button', 'cv-swatch', { type: 'button', 'aria-label': 'Colour ' + c });
        sw.style.setProperty('--cv-swatch', c);
        sw.addEventListener('click', (e) => { e.stopPropagation(); this.recolor(c); });
        m.append(sw);
      }
    } else {
      const colour = this._button('Colour', () => this._renderMenu('colors'), 'cv-menu-more');
      m.append(
        this._button('Delete', () => this.delete(), 'cv-menu-danger'),
        this._button('Duplicate', () => this.duplicate()),
        colour,
        this._button('Copy', (b) => {
          if (!this.copy()) return;
          b.textContent = 'Copied';
          b.classList.add('cv-menu-done');
          setTimeout(() => { if (b.isConnected) { b.textContent = 'Copy'; b.classList.remove('cv-menu-done'); } }, 1100);
        }),
      );
    }
    m.hidden = false;
    // Restart the pop-in animation and cache the size (used for positioning on every view change).
    m.classList.remove('cv-pop');
    this.menuSize = [m.offsetWidth, m.offsetHeight];
    m.classList.add('cv-pop');
    this.sync();
  }

  /** Reposition the outline, handle and menu (screen space) after a view or selection change. */
  sync() {
    const v = this.view, z = v.view.zoom;
    const u = v.usable();
    const [mw, mh] = this.menuSize;
    if (this.pasteAt && !this.ids.size) {
      const [sx, sy] = v.toScreen(this.pasteAt[0], this.pasteAt[1]);
      const mx = clamp(sx - mw / 2, u.x + 8, Math.max(u.x + 8, u.x + u.w - mw - 8));
      const my = sy - mh - 14 < u.y + 8 ? sy + 18 : sy - mh - 14;
      this.menu.style.left = mx + 'px';
      this.menu.style.top = my + 'px';
      return;
    }
    if (!this.bbox) return;
    let [x0, y0, x1, y1] = this.bbox;
    if (this.xf) {
      const { s, ox, oy, dx, dy } = this.xf;
      x0 = ox + (x0 - ox) * s + dx; x1 = ox + (x1 - ox) * s + dx;
      y0 = oy + (y0 - oy) * s + dy; y1 = oy + (y1 - oy) * s + dy;
    }
    const L = (x0 - v.view.x) * z - PAD, T = (y0 - v.view.y) * z - PAD;
    const W = Math.max(20, (x1 - x0) * z + PAD * 2), H = Math.max(20, (y1 - y0) * z + PAD * 2);
    this.box.style.transform = `translate(${L}px, ${T}px)`;
    this.box.style.width = W + 'px';
    this.box.style.height = H + 'px';
    this.rect.setAttribute('width', Math.max(0, W - 2));
    this.rect.setAttribute('height', Math.max(0, H - 2));
    this.rect.setAttribute('rx', Math.min(12, W / 2, H / 2));
    this.handle.style.transform = `translate(${L + W}px, ${T + H}px)`;

    const mx = clamp(L + W / 2 - mw / 2, u.x + 8, Math.max(u.x + 8, u.x + u.w - mw - 8));
    let my = T - mh - 12;
    if (my < u.y + 8) {
      my = T + H + 30;
      if (my + mh > u.y + u.h - 8) my = clamp(T + 12, u.y + 8, Math.max(u.y + 8, u.y + u.h - mh - 8));
    }
    this.menu.style.left = mx + 'px';
    this.menu.style.top = my + 'px';
  }

  /** Lasso path and the items being dragged (ctx in world coordinates). */
  renderLive(ctx) {
    const v = this.view, z = v.view.zoom;
    let drew = false;
    if (this.xf) {
      const { s, ox, oy, dx, dy, items } = this.xf;
      ctx.save();
      ctx.translate(ox + dx, oy + dy);
      ctx.scale(s, s);
      ctx.translate(-ox, -oy);
      drawItems(ctx, items, { zoom: z * s, dark: v.isDark(), getImage: (it) => v.images.get(it) });
      ctx.restore();
      drew = true;
    }
    if (this.lasso && this.lasso.pts.length > 1) {
      const pts = this.lasso.pts;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = v.theme.accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = v.theme.accent;
      ctx.lineWidth = 1.75 / z;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([6 / z, 6 / z]);
      ctx.stroke();
      ctx.globalAlpha = 0.35; // faint closing edge shows what will be enclosed
      ctx.beginPath();
      ctx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx.lineTo(pts[0][0], pts[0][1]);
      ctx.stroke();
      ctx.restore();
      drew = true;
    }
    return drew;
  }
}

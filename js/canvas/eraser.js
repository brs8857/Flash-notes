// Eraser: whole-stroke mode and precise ("area") mode, plus the circular on-screen cursor.
// Text and images are never erased. One history entry per gesture.

import { bboxIntersects } from './geom.js';
import { strokeHitsSegment, eraseFromStroke } from './strokes.js';

export class EraserTool {
  constructor(view) {
    this.view = view;
    this.cursor = document.createElement('div');
    this.cursor.className = 'cv-eraser';
    this.cursor.hidden = true;
    view.overlay.appendChild(this.cursor);
  }

  begin(p) {
    const v = this.view;
    const before = v.items;
    let last = [p.wx, p.wy];
    const step = (q) => { this._erase(last[0], last[1], q.wx, q.wy); last = [q.wx, q.wy]; };
    step(p);
    this._show(p, true);
    const done = (commit, type) => {
      if (type === 'mouse') this.cursor.classList.remove('cv-eraser--down'); else this.hide();
      if (commit) v.commit(before, v.items, 'erase');
      else { v.items = before; v.invalidate(); }
    };
    return {
      wantsCoalesced: true,
      move: (q, list) => { for (const s of list) step(s); this._show(q, true); },
      end: (q) => { step(q); done(true, q.type); },
      cancel: (commit) => done(commit, p.type),
    };
  }

  _erase(ax, ay, bx, by) {
    const v = this.view, o = v.toolOpts.eraser;
    const r = o.size / 2 / v.view.zoom;
    const area = o.eraseMode === 'area';
    const items = v.items;
    let out = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let rep = null;
      if (it.type === 'stroke') {
        const pad = r + it.size;
        const box = [Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad];
        if (bboxIntersects(it.bbox, box)) {
          if (area) rep = eraseFromStroke(it, ax, ay, bx, by, r);
          else if (strokeHitsSegment(it, ax, ay, bx, by, r)) rep = [];
        }
      }
      if (rep) {
        if (!out) out = items.slice(0, i);
        for (const piece of rep) out.push(piece);
      } else if (out) out.push(it);
    }
    if (out) { v.items = out; v.invalidate(); }
  }

  _show(p, down) {
    const d = this.view.toolOpts.eraser.size;
    const s = this.cursor.style;
    s.width = s.height = d + 'px';
    s.transform = `translate(${p.sx - d / 2}px, ${p.sy - d / 2}px)`;
    this.cursor.classList.toggle('cv-eraser--down', !!down);
    this.cursor.hidden = false;
  }

  /** Pencil hover / mouse move with the eraser selected. */
  hover(p) { this._show(p, false); }
  hide() { this.cursor.hidden = true; }
}

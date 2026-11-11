// Pen and highlighter: collects samples for the stroke in progress and draws it on the live canvas.

import { PAGE_W, PAGE_H, HIGHLIGHT_ALPHA, newId } from './constants.js';
import { clamp, round2 } from './geom.js';
import { penPath, highlighterPath, strokeBBox } from './strokes.js';
import { displayColor } from './paper.js';

// Long strokes: outlines of everything but the tail are frozen into Path2Ds so the per-frame cost of
// the live stroke stays bounded however long the user keeps the pen down.
const FREEZE_AT = 800, KEEP_TAIL = 200, OVERLAP = 40;
const HOLD_MS = 500, HOLD_PX = 2;

export class DrawTool {
  constructor(view) {
    this.view = view;
    this.cur = null;
  }

  get active() { return !!this.cur; }

  /** @returns an action for the input controller, or null when the stroke may not start here. */
  begin(p, tool) {
    const v = this.view;
    if (v.mode === 'page' && !v.inPage(p.wx, p.wy)) return null;
    const o = v.toolOpts[tool];
    const c = this.cur = {
      tool, color: o.color, size: o.size, sim: p.type !== 'pen',
      pts: [], frozen: [], tail: 0,
      straight: false, end: null, anchor: null, timer: 0,
    };
    this._add(c, p);
    v.live.classList.toggle('cv-live--multiply', tool === 'highlighter' && !v.isDark());
    v.invalidateLive();
    return {
      wantsCoalesced: true,
      move: (_p, list) => { for (const q of list) this._add(c, q); v.invalidateLive(); },
      end: (q) => { this._add(c, q); this._finish(c, true); },
      cancel: (commit) => this._finish(c, commit),
    };
  }

  _add(c, p) {
    const v = this.view, zoom = v.view.zoom;
    let x = p.wx, y = p.wy;
    if (v.mode === 'page') { x = clamp(x, 0, PAGE_W); y = clamp(y, 0, PAGE_H); }
    const pr = c.sim ? 0.5 : clamp(p.pressure || 0, 0.05, 1);

    if (c.tool === 'highlighter') {
      // Straight-line assist: hold still (≤2px) for 500ms while down → snap to a straight line.
      if (!c.anchor || Math.hypot(p.sx - c.anchor[0], p.sy - c.anchor[1]) > HOLD_PX) {
        c.anchor = [p.sx, p.sy];
        clearTimeout(c.timer);
        if (!c.straight) {
          c.timer = setTimeout(() => {
            if (this.cur !== c || !c.pts.length) return;
            const s = c.pts[0], e = c.end || s;
            if (Math.hypot(e[0] - s[0], e[1] - s[1]) * v.view.zoom < 12) return;
            c.straight = true;
            v.invalidateLive();
          }, HOLD_MS);
        }
      }
      c.end = [x, y, pr];
      if (c.straight) return;
    }

    const last = c.pts[c.pts.length - 1];
    // Drop samples closer than 0.75 screen px: at high zoom raw input is far denser than useful.
    if (last && Math.hypot(x - last[0], y - last[1]) < 0.75 / zoom) return;
    c.pts.push([x, y, pr]);

    if (c.tool === 'pen' && c.pts.length - c.tail > FREEZE_AT) {
      const cut = c.pts.length - KEEP_TAIL;
      c.frozen.push(penPath(c.pts.slice(c.tail, cut + 1), c.size, c.sim, false));
      c.tail = Math.max(0, cut - OVERLAP);
    }
  }

  _finish(c, commit) {
    if (this.cur !== c) return;
    const v = this.view;
    clearTimeout(c.timer);
    this.cur = null;
    v.live.classList.remove('cv-live--multiply');
    v.invalidateLive();
    if (!commit || !c.pts.length) return;
    const src = c.straight && c.end ? [c.pts[0], c.end] : c.pts;
    const item = {
      id: newId(), type: 'stroke', tool: c.tool, color: c.color, size: c.size,
      points: src.map((p) => [round2(p[0]), round2(p[1]), round2(p[2])]),
    };
    if (c.sim) item.sim = true;
    item.bbox = strokeBBox(item);
    v.addStroke(item);
  }

  /** Draw the stroke in progress (ctx is in world coordinates). Returns true if anything was drawn. */
  renderLive(ctx) {
    const c = this.cur;
    if (!c || !c.pts.length) return false;
    const v = this.view, zoom = v.view.zoom;
    if (c.tool === 'highlighter') {
      ctx.save();
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.strokeStyle = c.color;
      ctx.lineWidth = Math.max(c.size, 1 / zoom);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(highlighterPath(c.straight && c.end ? [c.pts[0], c.end] : c.pts));
      ctx.restore();
      return true;
    }
    const color = displayColor(c.color, v.isDark());
    ctx.fillStyle = color;
    const thin = c.size * zoom < 1;
    if (thin) { ctx.strokeStyle = color; ctx.lineWidth = 1 / zoom; }
    const tail = penPath(c.tail ? c.pts.slice(c.tail) : c.pts, c.size, c.sim, false);
    for (const path of [...c.frozen, tail]) {
      ctx.fill(path);
      if (thin) ctx.stroke(path);
    }
    return true;
  }
}

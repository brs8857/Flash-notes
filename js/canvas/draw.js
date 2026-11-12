// Pen and highlighter: collects samples for the stroke in progress and draws it on the live canvas.

import { PAGE_W, PAGE_H, HIGHLIGHT_ALPHA, HOLD_MS, HOLD_PX, newId } from './constants.js';
import { clamp, round2 } from './geom.js';
import { penPath, shapePath, highlighterPath, strokeBBox } from './strokes.js';
import { recognizeShape, lineShape, arrowShape } from './shapes.js';
import { displayColor } from './paper.js';

// Long strokes: outlines of everything but the tail are frozen into Path2Ds so the per-frame cost of
// the live stroke stays bounded however long the user keeps the pen down.
const FREEZE_AT = 800, KEEP_TAIL = 200, OVERLAP = 40;
const POP_MS = 160;   // scale "pop" when a held stroke snaps into a shape

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
      straight: false, end: null, anchor: null, anchorT: 0, timer: 0,
      snapped: null,   // pen hold-to-snap: {kind, points, start, follow, t0}
    };
    if (tool === 'pen') v.smart.penDown(p);
    this._add(c, p);
    v.live.classList.toggle('cv-live--multiply', tool === 'highlighter' && !v.isDark());
    v.invalidateLive();
    return {
      wantsCoalesced: true,
      move: (_p, list) => { for (const q of list) this._add(c, q); v.invalidateLive(); },
      end: (q) => { this._add(c, q); this._finish(c, true, true); },
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
    } else {
      // Hold to snap: after a snap no raw points are added. A line / arrow keeps following the pointer
      // with its far end; every other shape ignores further movement until the pen lifts.
      const s = c.snapped;
      if (s) {
        if (s.follow && Math.hypot(x - s.start[0], y - s.start[1]) * zoom > 6) {
          s.points = s.kind === 'arrow' ? arrowShape(s.start, [x, y]) : lineShape(s.start, [x, y]);
        }
        return;
      }
      // One timer per stroke, not one per moved sample (this is the pointermove hot path): the timer
      // looks at when the pen last left its anchor and waits out the rest when it fires early.
      if (!c.anchor || Math.hypot(p.sx - c.anchor[0], p.sy - c.anchor[1]) > HOLD_PX) {
        if (c.anchor) { c.anchor[0] = p.sx; c.anchor[1] = p.sy; } else c.anchor = [p.sx, p.sy];
        c.anchorT = performance.now();
        if (!c.timer) c.timer = setTimeout(() => this._holdTick(c), HOLD_MS);
      }
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

  _holdTick(c) {
    c.timer = 0;
    if (this.cur !== c) return;
    const left = HOLD_MS - (performance.now() - c.anchorT);
    if (left > 20) c.timer = setTimeout(() => this._holdTick(c), left);
    else this._hold(c);
  }

  /** The pen has rested for HOLD_MS: if the stroke so far is a shape, show it instead. Otherwise do
   *  nothing at all (a pen stroke the student pauses on must never be flattened). */
  _hold(c) {
    const v = this.view;
    if (this.cur !== c || v.destroyed || c.snapped || c.pts.length < 3) return;
    let r = null;
    try { r = recognizeShape(c.pts, { mode: 'hold', zoom: v.view.zoom }); } catch (err) { console.error(err); }
    if (!r) return;
    const first = r.points[0];
    c.snapped = {
      kind: r.kind, points: r.points, start: r.start || [first[0], first[1]],
      follow: r.kind === 'line' || r.kind === 'arrow', t0: performance.now(),
    };
    v.invalidateLive();
  }

  _finish(c, commit, lifted = false) {
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
    if (c.tool !== 'pen') { v.addStroke(item); return; }
    // Shapes: a hold-snapped preview, or (only for a stroke that ended by lifting the pen) auto shapes.
    const shape = c.snapped || (lifted ? v.smart.autoShape(c.pts, item.bbox) : null);
    if (!shape || !shape.points || shape.points.length < 2) {
      v.addStroke(item);
      v.smart.strokeDone(item, null);
      return;
    }
    // The raw stroke never enters `items`: only the shape is committed (one history entry).
    let pts = shape.points;
    if (v.mode === 'page') pts = pts.map((q) => [clamp(q[0], 0, PAGE_W), clamp(q[1], 0, PAGE_H), q[2]]);   // a fitted circle may bulge past the edge
    const neat = { id: newId(), type: 'stroke', tool: 'pen', color: c.color, size: c.size, points: pts, shape: { kind: shape.kind }, uniform: true };
    neat.bbox = strokeBBox(neat);
    if (!c.snapped) v.smart.morph([item]);
    v.addStroke(neat, 'shape');
    v.smart.strokeDone(neat, item);
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
    if (c.snapped) {
      // Same path builder as the committed shape, so preview == result. Brief scale "pop" on the snap.
      const s = c.snapped, t = (performance.now() - s.t0) / POP_MS;
      const path = shapePath(s.points, c.size);
      ctx.save();
      if (t < 1 && !v.reducedMotion()) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of s.points) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
        const k = 1 + 0.05 * Math.sin(Math.PI * t), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        ctx.translate(cx, cy); ctx.scale(k, k); ctx.translate(-cx, -cy);
        v.invalidateLive();
      }
      ctx.fill(path);
      if (c.size * zoom < 1) { ctx.strokeStyle = color; ctx.lineWidth = 1 / zoom; ctx.stroke(path); }
      ctx.restore();
      return true;
    }
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

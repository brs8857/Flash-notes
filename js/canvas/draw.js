// Pen and highlighter: collects samples for the stroke in progress and draws it on the live canvas.

//
// Live rendering is incremental (v1.2). The stroke is cut into short chunks as it grows; a chunk is turned
// into a Path2D once and painted onto the live canvas once ("baked"). Each new sample then only clears and
// repaints a small rectangle around the still-changing tail, so the cost of a frame does not depend on how
// long the stroke is or how busy the page is. The tail always ends exactly at the pointer (plus, where the
// browser offers them, predicted points that are never committed), so the ink does not trail the finger.

import { PAGE_W, PAGE_H, HOLD_MS, HOLD_PX, newId } from './constants.js';
import { clamp, round2, bboxIntersects } from './geom.js';
import { LiveStroke, shapePath, highlighterPath, chiselPath, strokeBBox } from './strokes.js';
import { getBrush, brushReach, strokeOpacity, tintColor, grainStyle, DEFAULT_BRUSH } from './brushes.js';
import { recognizeShape, lineShape, arrowShape } from './shapes.js';
import { displayColor } from './paper.js';

const CHUNK = 24;     // new points per baked chunk
const BACK = 12;      // points of context before a chunk / the tail (lets the width filter settle; hidden by the overlap)
const HOLD = 3;       // newest points are never baked: their outline still depends on what comes next
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
    const brush = getBrush(o.brush, tool) || getBrush(DEFAULT_BRUSH[tool], tool);
    const sim = p.type !== 'pen';
    const hl = tool === 'highlighter';
    const k = v.dpr * v.view.zoom;
    const ink = tintColor(hl ? o.color : displayColor(o.color, v.isDark()), brush.tint);
    const c = this.cur = {
      tool, brush, color: o.color, size: o.size, sim,
      pts: [],
      straight: false, end: null, anchor: null, anchorT: 0, timer: 0,
      snapped: null,   // pen hold-to-snap: {kind, points, start, follow, t0}
      // live rendering
      mode: hl ? (brush.tip === 'chisel' ? 'chisel' : 'line') : 'pen',
      ls: hl ? null : new LiveStroke(brush, o.size, sim),
      style: brush.grain ? grainStyle(brush.grain, ink, k) : ink,
      replace: !!brush.grain,          // textured ink: a chunk replaces what is under it (no doubled grain where chunks overlap)
      pad: o.size * brushReach(brush) + 2 / v.view.zoom,
      chunks: [], bakedTo: 0, tailBox: null, painted: false, pred: [],
      psum: 0, alpha: 1,
    };
    if (tool === 'pen') v.smart.penDown(p);
    this._add(c, p);
    v.live.classList.toggle('cv-live--multiply', hl && !v.isDark());
    this._opacity(c);
    v.invalidateLive();
    v.drawLiveNow();                   // the dot appears with the touch, not a frame later
    return {
      wantsCoalesced: true,
      move: (_p, list, pred) => {
        for (const q of list) this._add(c, q);
        c.pred = pred || [];
        this._opacity(c);
        v.drawLiveNow();
      },
      end: (q) => { c.pred = []; this._add(c, q); this._finish(c, true, true); },
      cancel: (commit) => { c.pred = []; this._finish(c, commit); },
    };
  }

  /** The stroke's opacity (brush, Pencil pressure) is applied to the whole live layer, so chunks never stack up darker. */
  _opacity(c) {
    const a = strokeOpacity(c.brush, c.pts.length ? c.psum / c.pts.length : 0.5, c.sim);
    if (Math.abs(a - c.alpha) < 0.015 && c.alphaSet) return;
    c.alpha = a; c.alphaSet = true;
    this.view.live.style.opacity = a === 1 ? '' : String(a);
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
    c.psum += pr;
    if (c.ls) c.ls.add(x, y, pr);
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
    v.live.style.opacity = '';
    v.invalidateLive();
    if (!commit || !c.pts.length) return;
    const src = c.straight && c.end ? [c.pts[0], c.end] : c.pts;
    const item = {
      id: newId(), type: 'stroke', tool: c.tool, brush: c.brush.id, color: c.color, size: c.size,
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
    const neat = { id: newId(), type: 'stroke', tool: 'pen', brush: c.brush.id, color: c.color, size: c.size, points: pts, shape: { kind: shape.kind }, uniform: true };
    neat.bbox = strokeBBox(neat);
    if (!c.snapped) v.smart.morph([item]);
    v.addStroke(neat, 'shape');
    v.smart.strokeDone(neat, item);
  }

  // ---- live rendering ----------------------------------------------------------------------------

  /** True while the stroke can be drawn incrementally (a snapped shape / straight line is redrawn whole). */
  incremental() {
    const c = this.cur;
    return !!c && c.painted && !c.snapped && !c.straight && c.pts.length > 0;
  }

  /** The points the chunks are cut from: smoothed stroke points for pens, raw samples for highlighters. */
  _src(c) { return c.ls ? c.ls.sp : c.pts; }

  _chunkPath(c, pts, last) {
    if (c.mode === 'pen') return c.ls.outline(pts, last);
    return c.mode === 'chisel' ? chiselPath(pts, c.size) : highlighterPath(pts);
  }

  _box(c, pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) {
      const p = q.point || q;
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return [x0 - c.pad, y0 - c.pad, x1 + c.pad, y1 + c.pad];
  }

  _paint(ctx, c, path, zoom) {
    if (c.mode === 'line') {
      ctx.lineWidth = Math.max(c.size, 1 / zoom);
      ctx.stroke(path);
      return;
    }
    if (c.replace) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      ctx.fill(path);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = c.style;
    }
    ctx.fill(path);
    if (c.size * zoom < 1) { ctx.lineWidth = 1 / zoom; ctx.stroke(path); }
  }

  _style(ctx, c) {
    ctx.fillStyle = c.style;
    ctx.strokeStyle = c.style;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /** Freeze everything but the tail into chunks. @returns the chunks made by this call */
  _bake(c) {
    const src = this._src(c), made = [];
    for (;;) {
      const e = src.length - 1 - HOLD;
      if (e - c.bakedTo < CHUNK) break;
      // How far this chunk is final: its far end is a cap (and, for tapering brushes, a taper) that the
      // next chunk must paint over at full width.
      let g = e - 1;
      if (c.ls) {
        const reach = src[e].runningLength - (c.ls.opts.end ? c.ls.opts.end.taper : 0) - Math.max(3, c.size);
        while (g > c.bakedTo && src[g].runningLength > reach) g--;
        if (g - c.bakedTo < CHUNK / 2) break;
      }
      const pts = src.slice(Math.max(0, c.bakedTo - BACK), e + 1);
      const chunk = { path: this._chunkPath(c, pts, false), box: this._box(c, pts) };
      c.chunks.push(chunk);
      made.push(chunk);
      c.bakedTo = g;
    }
    return made;
  }

  _tail(c) {
    const from = Math.max(0, c.bakedTo - (c.bakedTo ? BACK : 0));
    if (c.ls) {
      const tips = c.pred.length ? [c.pts[c.pts.length - 1], ...c.pred] : [c.pts[c.pts.length - 1]];
      const pts = c.ls.tail(from, tips);
      return { path: c.ls.outline(pts, true), box: this._box(c, pts) };
    }
    const pts = c.pred.length ? c.pts.slice(from).concat(c.pred) : c.pts.slice(from);
    return { path: this._chunkPath(c, pts, true), box: this._box(c, pts) };
  }

  /**
   * Incremental update: bake finished chunks, then repaint only the rectangle the tail occupied or
   * occupies now. The live canvas must already hold this stroke (the engine guarantees it).
   */
  renderIncremental(ctx) {
    const c = this.cur, v = this.view, zoom = v.view.zoom;
    this._style(ctx, c);
    for (const chunk of this._bake(c)) this._paint(ctx, c, chunk.path, zoom);
    const tail = this._tail(c);
    const a = c.tailBox, b = tail.box;
    const box = a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
    // Whole device pixels, so the cleared edge never leaves half-erased pixels behind.
    const k = v.dpr * zoom;
    const x0 = Math.floor((box[0] - v.view.x) * k) - 1, y0 = Math.floor((box[1] - v.view.y) * k) - 1;
    const x1 = Math.ceil((box[2] - v.view.x) * k) + 1, y1 = Math.ceil((box[3] - v.view.y) * k) + 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setTransform(k, 0, 0, k, -v.view.x * k, -v.view.y * k);
    for (const chunk of c.chunks) if (bboxIntersects(chunk.box, box)) this._paint(ctx, c, chunk.path, zoom);
    this._paint(ctx, c, tail.path, zoom);
    ctx.restore();
    c.tailBox = b;
  }

  /** Draw the whole stroke in progress on a cleared canvas (ctx in world coordinates). Returns true if anything was drawn. */
  renderLive(ctx) {
    const c = this.cur;
    if (!c || !c.pts.length) return false;
    const v = this.view, zoom = v.view.zoom;
    c.painted = false;
    if (c.straight && c.end) {
      const pts = [c.pts[0], c.end];
      ctx.save();
      this._style(ctx, c);
      if (c.mode === 'chisel') ctx.fill(chiselPath(pts, c.size));
      else { ctx.lineWidth = Math.max(c.size, 1 / zoom); ctx.stroke(highlighterPath(pts)); }
      ctx.restore();
      return true;
    }
    if (c.snapped) {
      // Same path builder as the committed shape, so preview == result. Brief scale "pop" on the snap.
      const s = c.snapped, t = (performance.now() - s.t0) / POP_MS;
      const path = shapePath(s.points, c.size);
      ctx.save();
      this._style(ctx, c);
      if (t < 1 && !v.reducedMotion()) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of s.points) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
        const k = 1 + 0.05 * Math.sin(Math.PI * t), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        ctx.translate(cx, cy); ctx.scale(k, k); ctx.translate(-cx, -cy);
        v.invalidateLive();
      }
      ctx.fill(path);
      if (c.size * zoom < 1) { ctx.lineWidth = 1 / zoom; ctx.stroke(path); }
      ctx.restore();
      return true;
    }
    ctx.save();
    this._style(ctx, c);
    this._bake(c);
    for (const chunk of c.chunks) this._paint(ctx, c, chunk.path, zoom);
    const tail = this._tail(c);
    this._paint(ctx, c, tail.path, zoom);
    ctx.restore();
    c.tailBox = tail.box;
    c.painted = true;
    return true;
  }
}

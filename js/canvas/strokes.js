// Stroke geometry: perfect-freehand outlines → Path2D (cached), highlighter paths, bboxes,
// eraser hit-testing and precise ("area") erasing.
//
// Items are treated as IMMUTABLE by the whole engine: any change produces a new item object. That
// lets us cache derived data (Path2D, text layout) in WeakMaps keyed by the item itself; the cache
// invalidates automatically when the points change and is garbage-collected with the item.

import { getStroke, getStrokeOutlinePoints } from '../../vendor/perfect-freehand.js';
import { distPointSeg, distSegSeg, round2 } from './geom.js';
import { newId } from './constants.js';
import { LEGACY_PEN, brushOf, freehandOptions, brushReach, strokeOpacity, tintColor, grainStyle } from './brushes.js';

// Recognised shapes (`uniform` strokes): constant width, no pressure, corners not rounded off.
const SHAPE_OPTS = { thinning: 0, smoothing: 0.5, streamline: 0, simulatePressure: false, last: true };
const pathCache = new WeakMap();
const alphaCache = new WeakMap();

/** Closed, smoothed Path2D from a perfect-freehand outline polygon. */
function outlineToPath(pts) {
  const path = new Path2D();
  const n = pts.length;
  if (!n) return path;
  if (n < 3) {
    path.arc(pts[0][0], pts[0][1], 0.5, 0, Math.PI * 2);
    return path;
  }
  path.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  for (let i = 1; i <= n; i++) {
    const a = pts[i % n], b = pts[(i + 1) % n];
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}

/** Radius of the dot a tap leaves. */
function dotRadius(brush, size, sim, pressure) {
  return Math.max(0.3, size * (0.5 - (brush.thinning || 0) * (0.5 - (sim ? 0.5 : pressure ?? 0.5))));
}

/** Pen outline for a brush. `last` = stroke finished (snaps the end to the final point). */
export function penPath(points, size, sim, last, brush = LEGACY_PEN) {
  if (!points.length) return new Path2D();
  if (points.length === 1) {
    // A tap leaves a dot.
    const p = points[0];
    const path = new Path2D();
    path.arc(p[0], p[1], dotRadius(brush, size, sim, p[2]), 0, Math.PI * 2);
    return path;
  }
  let outline;
  try {
    outline = getStroke(points, freehandOptions(brush, size, sim, last));
  } catch { outline = []; }
  return outlineToPath(outline);
}

/**
 * Incremental twin of perfect-freehand's getStrokePoints (the streamline filter): feed it raw samples one
 * at a time and it keeps the smoothed "stroke points" up to date in O(1) per sample, so the live stroke
 * never has to be re-smoothed from its first point. Slices of `sp` go to `liveOutline`.
 */
export class LiveStroke {
  constructor(brush, size, sim) {
    this.opts = freehandOptions(brush, size, sim, false);
    this.brush = brush; this.size = size; this.sim = sim;
    this.k = 0.15 + (1 - this.opts.streamline) * 0.85;
    this.sp = [];
    this.run = 0;
    this.started = false;
  }

  add(x, y, pressure) {
    const sp = this.sp;
    if (!sp.length) {
      sp.push({ point: [x, y], pressure: pressure >= 0 ? pressure : 0.25, vector: [1, 1], distance: 0, runningLength: 0 });
      return;
    }
    const m = sp[sp.length - 1], k = this.k;
    const px = m.point[0] + (x - m.point[0]) * k, py = m.point[1] + (y - m.point[1]) * k;
    if (px === m.point[0] && py === m.point[1]) return;
    const d = Math.hypot(px - m.point[0], py - m.point[1]);
    this.run += d;
    if (!this.started) {                      // nothing is emitted until the pen has travelled its own width
      if (this.run < this.size) return;
      this.started = true;
    }
    const pt = { point: [px, py], pressure: pressure >= 0 ? pressure : 0.5, vector: [(m.point[0] - px) / d, (m.point[1] - py) / d], distance: d, runningLength: this.run };
    sp.push(pt);
    if (sp.length === 2) sp[0].vector = pt.vector;
  }

  /**
   * Stroke points from index `from` to the end, plus the pointer's true position (and any predicted
   * positions) so the ink reaches the finger instead of trailing behind the smoothing filter.
   * @param {number[][]} tips [[x, y, pressure], ...] newest raw sample first, then predictions
   */
  tail(from, tips) {
    const out = this.sp.slice(from);
    let m = out[out.length - 1];
    for (const t of tips) {
      const d = Math.hypot(t[0] - m.point[0], t[1] - m.point[1]);
      if (d < 1e-6) continue;
      m = { point: [t[0], t[1]], pressure: t[2] >= 0 ? t[2] : 0.5, vector: [(m.point[0] - t[0]) / d, (m.point[1] - t[1]) / d], distance: d, runningLength: m.runningLength + d };
      out.push(m);
    }
    if (out.length > 1 && from === 0) out[0] = { ...out[0], vector: out[1].vector };
    return out;
  }

  /** Outline Path2D for a run of stroke points (a baked chunk, or the tail with `last`). */
  outline(points, last) {
    if (!points.length) return new Path2D();
    if (points.length === 1) {
      const p = points[0], path = new Path2D();
      path.arc(p.point[0], p.point[1], dotRadius(this.brush, this.size, this.sim, p.pressure), 0, Math.PI * 2);
      return path;
    }
    let outline;
    try { outline = getStrokeOutlinePoints(points, last ? { ...this.opts, last: true } : this.opts); } catch { outline = []; }
    return outlineToPath(outline);
  }
}

/** Crisp constant-width outline for a recognised shape (live preview and committed stroke use the same call). */
export function shapePath(points, size) {
  if (points.length < 2) return penPath(points, size, true, true);
  let outline;
  try { outline = getStroke(points, { size, ...SHAPE_OPTS }); } catch { outline = []; }
  return outlineToPath(outline);
}

/** Constant-width centre line for the highlighter (stroked by the renderer). */
export function highlighterPath(points) {
  const path = new Path2D();
  const n = points.length;
  if (!n) return path;
  path.moveTo(points[0][0], points[0][1]);
  if (n === 1) {
    path.lineTo(points[0][0] + 0.01, points[0][1]);
  } else if (n === 2) {
    path.lineTo(points[1][0], points[1][1]);
  } else {
    for (let i = 1; i < n - 1; i++) {
      const a = points[i], b = points[i + 1];
      path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    path.lineTo(points[n - 1][0], points[n - 1][1]);
  }
  return path;
}

// Chisel highlighter: a flat nib (size × 0.3·size) held at a fixed angle, like a real highlighter tip.
const NIB_ANGLE = -68 * Math.PI / 180;      // long edge leans like "/"
const NIB_THICK = 0.3;

/** Corners of the nib centred on the origin, in drawing order. */
export function chiselNib(size) {
  const ux = Math.cos(NIB_ANGLE) * size / 2, uy = Math.sin(NIB_ANGLE) * size / 2;
  const t = size * NIB_THICK / 2, vx = -Math.sin(NIB_ANGLE) * t, vy = Math.cos(NIB_ANGLE) * t;
  return [[-ux - vx, -uy - vy], [ux - vx, uy - vy], [ux + vx, uy + vy], [-ux + vx, -uy + vy]];
}

/**
 * Area swept by the chisel nib along the centre line: one convex hull (nib at A ∪ nib at B) per segment,
 * all wound the same way, so a single non-zero fill gives their union with no darker overlaps.
 */
export function chiselPath(points, size) {
  const path = new Path2D();
  const nib = chiselNib(size), n = points.length;
  const rect = (x, y) => {
    path.moveTo(x + nib[0][0], y + nib[0][1]);
    for (let j = 1; j < 4; j++) path.lineTo(x + nib[j][0], y + nib[j][1]);
    path.closePath();
  };
  if (!n) return path;
  if (n === 1) { rect(points[0][0], points[0][1]); return path; }
  // Samples closer together than a sliver of the nib add nothing but path complexity.
  const minStep = size * 0.08;
  let ax = points[0][0], ay = points[0][1], any = false;
  for (let i = 1; i < n; i++) {
    const dx = points[i][0] - ax, dy = points[i][1] - ay;
    if (i < n - 1 ? Math.hypot(dx, dy) < minStep : (!dx && !dy)) continue;
    any = true;
    // An edge of the nib faces forwards when its outward normal points along the movement.
    let first = true;
    const put = (x, y) => { if (first) { path.moveTo(x, y); first = false; } else path.lineTo(x, y); };
    for (let j = 0; j < 4; j++) {
      const p = nib[(j + 3) % 4], c = nib[j], q = nib[(j + 1) % 4];
      const prevFront = (c[1] - p[1]) * dx - (c[0] - p[0]) * dy > 0;
      const nextFront = (q[1] - c[1]) * dx - (q[0] - c[0]) * dy > 0;
      const x = ax + c[0], y = ay + c[1];
      if (prevFront && nextFront) put(x + dx, y + dy);
      else if (!prevFront && !nextFront) put(x, y);
      else if (!prevFront && nextFront) { put(x, y); put(x + dx, y + dy); }
      else { put(x + dx, y + dy); put(x, y); }
    }
    path.closePath();
    ax += dx; ay += dy;
  }
  if (!any) rect(ax, ay);
  return path;
}

/** Cached Path2D (world coordinates) for a committed stroke item. */
export function strokePath(item) {
  let p = pathCache.get(item);
  if (!p) {
    const brush = brushOf(item);
    p = item.tool === 'highlighter' ? (brush.tip === 'chisel' ? chiselPath(item.points, item.size) : highlighterPath(item.points))
      : item.uniform ? shapePath(item.points, item.size) : penPath(item.points, item.size, item.sim, true, brush);
    pathCache.set(item, p);
  }
  return p;
}

/** Opacity of a committed stroke (cached; see strokeOpacity). */
export function strokeAlpha(item, brush = brushOf(item)) {
  if (!brush.pressureAlpha || item.sim) return brush.alpha ?? 1;
  let a = alphaCache.get(item);
  if (a === undefined) {
    let sum = 0;
    for (const p of item.points) sum += p[2] ?? 0.5;
    a = strokeOpacity(brush, sum / item.points.length, false);
    alphaCache.set(item, a);
  }
  return a;
}

export function strokeBBox(item) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of item.points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  // Pen outlines can reach 0.8 × size from the centre line at full pressure (more for the brush pen).
  const pad = item.size * brushReach(brushOf(item)) + 0.5;
  return [round2(minX - pad), round2(minY - pad), round2(maxX + pad), round2(maxY + pad)];
}

/** Device px per world unit of a context's current transform (picks the grain resolution). */
export function deviceScale(ctx) {
  try { const m = ctx.getTransform(); return Math.hypot(m.a, m.b) || 1; } catch { return 1; }
}

/**
 * Draw one stroke with its brush: opacity (multiplied into the caller's globalAlpha), flat ink or grain.
 * `k` = device px per world unit (pass it when drawing many strokes; measured from the context otherwise).
 */
export function drawStroke(ctx, item, zoom, color, k) {
  const brush = brushOf(item);
  const path = strokePath(item);
  const alpha = strokeAlpha(item, brush), base = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = base * alpha;
  if (brush.tint) color = tintColor(color, brush.tint);
  if (item.tool === 'highlighter' && brush.tip !== 'chisel') {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(item.size, 1 / zoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  } else {
    const style = brush.grain ? grainStyle(brush.grain, color, k || deviceScale(ctx)) : color;
    ctx.fillStyle = style;
    ctx.fill(path);
    if (item.size * zoom < 1) { // keep hairlines visible when zoomed far out
      ctx.strokeStyle = style;
      ctx.lineWidth = 1 / zoom;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    }
  }
  if (alpha !== 1) ctx.globalAlpha = base;
}

/** True when the eraser segment A→B (radius r) touches the stroke. */
export function strokeHitsSegment(item, ax, ay, bx, by, r) {
  const pts = item.points;
  const reach = r + item.size / 2;
  if (pts.length === 1) return distPointSeg(pts[0][0], pts[0][1], ax, ay, bx, by) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distSegSeg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], ax, ay, bx, by) <= reach) return true;
  }
  return false;
}

/**
 * Precise eraser: remove the parts of a stroke within `r` of segment A→B.
 * Returns null when untouched, otherwise an array of new stroke items (possibly empty).
 */
export function eraseFromStroke(item, ax, ay, bx, by, r) {
  const src = item.points;
  const reach = r + item.size * 0.3;
  const step = Math.max(r / 2, 0.2);
  // 1. Densify only the segments near the eraser so sparse strokes (straight lines) cut cleanly.
  const pts = [src[0]];
  let near = false;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    if (distSegSeg(a[0], a[1], b[0], b[1], ax, ay, bx, by) <= reach + step) {
      near = true;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.min(4000, Math.ceil(len / step));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] ?? 0.5) + ((b[2] ?? 0.5) - (a[2] ?? 0.5)) * t]);
      }
    }
    pts.push(b);
  }
  if (src.length === 1) near = distPointSeg(src[0][0], src[0][1], ax, ay, bx, by) <= reach;
  if (!near) return null;
  // 2. Split into runs of surviving points.
  const runs = [];
  let run = [], erased = false;
  for (const p of pts) {
    if (distPointSeg(p[0], p[1], ax, ay, bx, by) <= reach) {
      erased = true;
      if (run.length) runs.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length) runs.push(run);
  if (!erased) return null;
  // Drop slivers shorter than ~half a pen width: they would render as stray blobs next to the cut.
  const runLen = (pp) => { let d = 0; for (let i = 1; i < pp.length; i++) d += Math.hypot(pp[i][0] - pp[i - 1][0], pp[i][1] - pp[i - 1][1]); return d; };
  return runs
    .filter((pp) => src.length === 1 || (pp.length > 1 && runLen(pp) >= item.size * 0.4))
    .map((pp) => {
      const piece = { ...item, id: newId(), points: pp.map((p) => [round2(p[0]), round2(p[1]), round2(p[2] ?? 0.5)]) };
      piece.bbox = strokeBBox(piece);
      return piece;
    });
}

/** Distance from a point to the stroke's centre line (for tap-to-select). */
export function distToStroke(item, x, y) {
  const pts = item.points;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distPointSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (d < best) best = d;
  }
  return best;
}

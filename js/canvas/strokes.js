// Stroke geometry: perfect-freehand outlines → Path2D (cached), highlighter paths, bboxes,
// eraser hit-testing and precise ("area") erasing.
//
// Items are treated as IMMUTABLE by the whole engine: any change produces a new item object. That
// lets us cache derived data (Path2D, text layout) in WeakMaps keyed by the item itself; the cache
// invalidates automatically when the points change and is garbage-collected with the item.

import { getStroke } from '../../vendor/perfect-freehand.js';
import { distPointSeg, distSegSeg, round2 } from './geom.js';
import { newId } from './constants.js';

const PEN_OPTS = { thinning: 0.6, smoothing: 0.5, streamline: 0.45 };
const pathCache = new WeakMap();

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

/** Pressure-sensitive pen outline. `last` = stroke finished (snaps the end to the final point). */
export function penPath(points, size, sim, last) {
  if (!points.length) return new Path2D();
  if (points.length === 1) {
    // A tap leaves a dot.
    const p = points[0];
    const r = Math.max(0.3, size * (sim ? 0.5 : 0.2 + 0.6 * (p[2] ?? 0.5)));
    const path = new Path2D();
    path.arc(p[0], p[1], r, 0, Math.PI * 2);
    return path;
  }
  let outline;
  try {
    outline = getStroke(points, { size, ...PEN_OPTS, simulatePressure: !!sim, last });
  } catch { outline = []; }
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

/** Cached Path2D (world coordinates) for a committed stroke item. */
export function strokePath(item) {
  let p = pathCache.get(item);
  if (!p) {
    p = item.tool === 'highlighter' ? highlighterPath(item.points) : penPath(item.points, item.size, item.sim, true);
    pathCache.set(item, p);
  }
  return p;
}

export function strokeBBox(item) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of item.points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  // Pen outlines can reach 0.8 × size from the centre line at full pressure.
  const pad = item.tool === 'highlighter' ? item.size / 2 + 0.5 : item.size * 0.85 + 0.5;
  return [round2(minX - pad), round2(minY - pad), round2(maxX + pad), round2(maxY + pad)];
}

/** Draw one stroke. The caller sets globalAlpha for the highlighter pass. */
export function drawStroke(ctx, item, zoom, color) {
  const path = strokePath(item);
  if (item.tool === 'highlighter') {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(item.size, 1 / zoom);
    ctx.stroke(path);
  } else {
    ctx.fillStyle = color;
    ctx.fill(path);
    if (item.size * zoom < 1) { // keep hairlines visible when zoomed far out
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / zoom;
      ctx.stroke(path);
    }
  }
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

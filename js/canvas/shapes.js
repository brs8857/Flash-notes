// Shape recognition (SPEC v1.1 §A). Pure maths on plain arrays: no DOM, runs in Node for the tests.
//
//   recognizeShape(points, {mode:'auto'|'hold', zoom, scale?, prev?}) → null | {kind, confidence, points}
//
// Pipeline: resample + light smoothing → closed/open test → corners → per-kind fit error normalised by
// size → best kind → the gates for the mode. Everything that is not clearly a shape returns null, and
// smooth curves (demand/supply curves, S-curves, waves, arcs) are never converted.

export const SHAPE_KINDS = ['line', 'arrow', 'axes', 'polyline', 'circle', 'ellipse', 'rectangle', 'square', 'triangle'];
export const SHAPE_LABELS = {
  line: 'Line', arrow: 'Arrow', axes: 'Axes', polyline: 'Lines', circle: 'Circle', ellipse: 'Ellipse',
  rectangle: 'Rectangle', square: 'Square', triangle: 'Triangle',
};
const CLOSED_KINDS = new Set(['circle', 'ellipse', 'rectangle', 'square', 'triangle']);

const DEG = Math.PI / 180;
const MAX_INPUT = 4000;
const STEP = 2;                      // output sampling (world units)

// ---- Gates (SPEC table) -------------------------------------------------------------------------
const GATE = {
  auto: { open: 90, closed: 120, screen: 100, confOpen: 0.9, confClosed: 0.85 },
  hold: { open: 40, closed: 40, screen: 40, confOpen: 0.7, confClosed: 0.7 },
};
const MAX_CORNERS = 6;
const LINE_DEV = { auto: 0.03, hold: 0.08 };   // max perpendicular deviation ÷ length of a straight part
const CURVE_TURN = 25 * DEG;         // an open stroke that turns more than this with no corner is a curve
const SEG_MIN = 50;                  // polyline segment length (auto)
const AXES_TILT = 20 * DEG;          // an "L" rotated further than this from horizontal/vertical is not an axis pair
const ARM_MIN = 80;                  // axes arm length (auto)
const TURN_MIN = 25 * DEG, TURN_MAX = 140 * DEG;
const ZIGZAG = 95 * DEG;              // two consecutive opposite turns sharper than this = zig-zag (spec: 110°; stricter is safer)
const LOCAL = 0.6;                   // share of a corner's turning that must happen inside the window

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const r2 = (n) => Math.round(n * 100) / 100;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

function pathLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }

/** n points equally spaced along the path (n ≥ 2). `cyclic` closes the loop first. */
function resample(pts, n, cyclic = false) {
  const src = cyclic ? pts.concat([pts[0]]) : pts;
  const L = pathLen(src);
  const out = [];
  const m = cyclic ? n : n - 1;
  if (L <= 0) { for (let i = 0; i < n; i++) out.push([src[0][0], src[0][1]]); return out; }
  const step = L / m;
  let j = 1, acc = 0, seg = dist(src[0], src[1]);
  for (let i = 0; i < n; i++) {
    const target = i * step;
    while (j < src.length - 1 && acc + seg < target) { acc += seg; j++; seg = dist(src[j - 1], src[j]); }
    const t = seg > 0 ? clamp((target - acc) / seg, 0, 1) : 0;
    const a = src[j - 1], b = src[j];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  if (!cyclic) out[n - 1] = [src[src.length - 1][0], src[src.length - 1][1]];
  return out;
}

/** Triangular moving average; the window shrinks towards the ends so the end points stay put. */
function smooth(pts, w) {
  const n = pts.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(w, i, n - 1 - i);
    let sx = 0, sy = 0, sw = 0;
    for (let d = -k; d <= k; d++) {
      const wt = k + 1 - Math.abs(d);
      sx += pts[i + d][0] * wt; sy += pts[i + d][1] * wt; sw += wt;
    }
    out[i] = [sx / sw, sy / sw];
  }
  return out;
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}

function prep(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let src = points;
  if (src.length > MAX_INPUT) {
    const k = src.length / MAX_INPUT, cut = [];
    for (let i = 0; i < MAX_INPUT; i++) cut.push(src[Math.floor(i * k)]);
    cut.push(src[src.length - 1]);
    src = cut;
  }
  const raw = [];
  for (const p of src) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = raw[raw.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) raw.push([p[0], p[1]]);
  }
  if (raw.length < 2) return null;
  const L0 = pathLen(raw);
  if (!(L0 > 1)) return null;
  const dense = smooth(resample(raw, clamp(Math.round(L0 / 2.5), 24, 240)), 2);
  const L = pathLen(dense);
  const pts = resample(dense, clamp(Math.round(L / 4), 32, 128));
  const bb = bboxOf(pts);
  return { raw, pts, L, bbox: bb, diag: Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) };
}

// ---- Line fitting ---------------------------------------------------------------------------------

/** Total-least-squares line through pts[i0..i1]: {cx, cy, dx, dy (unit, pointing i0→i1), dev (max ⟂ distance), len}. */
function fitLine(pts, i0, i1) {
  let cx = 0, cy = 0;
  const n = i1 - i0 + 1;
  for (let i = i0; i <= i1; i++) { cx += pts[i][0]; cy += pts[i][1]; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = i0; i <= i1; i++) {
    const x = pts[i][0] - cx, y = pts[i][1] - cy;
    sxx += x * x; sxy += x * y; syy += y * y;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(th), dy = Math.sin(th);
  if ((pts[i1][0] - pts[i0][0]) * dx + (pts[i1][1] - pts[i0][1]) * dy < 0) { dx = -dx; dy = -dy; }
  let dev = 0;
  for (let i = i0; i <= i1; i++) {
    const d = Math.abs((pts[i][0] - cx) * -dy + (pts[i][1] - cy) * dx);
    if (d > dev) dev = d;
  }
  return { cx, cy, dx, dy, dev, len: dist(pts[i0], pts[i1]) };
}

function project(f, p) {
  const t = (p[0] - f.cx) * f.dx + (p[1] - f.cy) * f.dy;
  return [f.cx + f.dx * t, f.cy + f.dy * t];
}

function intersect(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / den;
  return [a.cx + a.dx * t, a.cy + a.dy * t];
}

/** Douglas–Peucker: indices of the kept vertices of pts[i0..i1]. */
function dpIndices(pts, eps) {
  const keep = [0, pts.length - 1];
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) {
      const d = len > 1e-9 ? Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len : dist(pts[i], pts[a]);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep.push(best); stack.push([a, best], [best, b]); }
  }
  return keep.sort((x, y) => x - y);
}

/** Signed total turning of a path (radians). */
function totalTurning(pts) {
  let sum = 0, prev = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    if (dx * dx + dy * dy < 1e-12) continue;
    const a = Math.atan2(dy, dx);
    if (prev !== null) sum += angDiff(a, prev);
    prev = a;
  }
  return sum;
}

// ---- Output geometry ------------------------------------------------------------------------------

/** Points every ~STEP units along a polyline of vertices, constant pressure, no duplicates. */
function samplePolyline(verts) {
  const out = [];
  const push = (x, y) => {
    x = r2(x); y = r2(y);
    const q = out[out.length - 1];
    if (!q || q[0] !== x || q[1] !== y) out.push([x, y, 0.5]);
  };
  push(verts[0][0], verts[0][1]);
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / STEP));
    for (let k = 1; k <= n; k++) push(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
  }
  return out;
}

function sampleEllipse(cx, cy, a, b, rot, start) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const fine = [], m = 720;
  for (let i = 0; i <= m; i++) {
    const t = start + (i / m) * 2 * Math.PI;
    const u = a * Math.cos(t), v = b * Math.sin(t);
    fine.push([cx + u * c - v * s, cy + u * s + v * c]);
  }
  const verts = resample(fine, Math.max(24, Math.ceil(pathLen(fine) / STEP)) + 1);
  const out = [];
  for (const p of verts) {
    const x = r2(p[0]), y = r2(p[1]);
    const q = out[out.length - 1];
    if (!q || q[0] !== x || q[1] !== y) out.push([x, y, 0.5]);
  }
  return out;
}

/** Snap a direction: exactly horizontal/vertical within 6°, 45° within 4°. Returns the angle (radians). */
function snapAngle(a) {
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(angDiff(a, q)) <= 6 * DEG) return q;
  const d = (Math.round((a - Math.PI / 4) / (Math.PI / 2)) * Math.PI) / 2 + Math.PI / 4;
  if (Math.abs(angDiff(a, d)) <= 4 * DEG) return d;
  return a;
}

/** End point of start→end after the angle snaps (length kept, start fixed). */
function snapEnd(start, end) {
  const len = dist(start, end);
  const a = snapAngle(Math.atan2(end[1] - start[1], end[0] - start[0]));
  return [start[0] + Math.cos(a) * len, start[1] + Math.sin(a) * len];
}

/**
 * A straight line start→end with the angle snaps. `pivot` 'start' keeps the start fixed (used while the
 * end follows the pointer after a hold-snap); 'mid' turns the line about its middle.
 * @returns {number[][]} shape points
 */
export function lineShape(start, end, pivot = 'start') {
  const [a, b] = lineEnds(start, end, pivot);
  return samplePolyline([a, b]);
}

function lineEnds(start, end, pivot) {
  if (pivot !== 'mid') return [[start[0], start[1]], snapEnd(start, end)];
  const len = dist(start, end);
  const a = snapAngle(Math.atan2(end[1] - start[1], end[0] - start[0]));
  const mx = (start[0] + end[0]) / 2, my = (start[1] + end[1]) / 2;
  const hx = (Math.cos(a) * len) / 2, hy = (Math.sin(a) * len) / 2;
  return [[mx - hx, my - hy], [mx + hx, my + hy]];
}

/** Clean arrow: straight shaft start→tip plus a symmetric 30° head, drawn as one path. */
export function arrowShape(start, tip, pivot = 'start') {
  const [a, b] = lineEnds(start, tip, pivot);
  const len = dist(a, b);
  if (len < 1e-6) return samplePolyline([a, b]);
  const head = Math.min(clamp(len * 0.12, 10, 40), len * 0.6);
  const back = Math.atan2(a[1] - b[1], a[0] - b[0]);
  const b1 = [b[0] + Math.cos(back + 30 * DEG) * head, b[1] + Math.sin(back + 30 * DEG) * head];
  const b2 = [b[0] + Math.cos(back - 30 * DEG) * head, b[1] + Math.sin(back - 30 * DEG) * head];
  return samplePolyline([a, b, b1, b, b2]);
}

// ---- Open shapes ----------------------------------------------------------------------------------

/** Single-stroke arrow: shaft to the tip, a barb, back to the tip, the second barb (or shaft + one barb when `allowOne`). */
function detectArrow(s, mode) {
  const pts = s.pts, n = pts.length, start = pts[0];
  let dmax = 0;
  const d = pts.map((p) => { const v = dist(p, start); if (v > dmax) dmax = v; return v; });
  if (dmax < 30) return null;
  let ti = 0;
  while (ti < n - 1 && d[ti] < dmax * 0.97) ti++;
  while (ti < n - 1 && d[ti + 1] >= d[ti]) ti++;
  if (ti < n * 0.35 || ti > n - 3) return null;
  const tip = pts[ti];
  const shaft = fitLine(pts, 0, ti);
  const S = dist(start, tip);
  const devRel = shaft.dev / S;
  if (devRel > LINE_DEV[mode]) return null;

  // Distance from the tip along the head: up to barb 1, back down to the tip, up again to barb 2.
  const e = [];
  for (let i = ti; i < n; i++) e.push(dist(pts[i], tip));
  let j1 = 0;
  for (let j = 1; j < e.length; j++) { if (e[j] > e[j1]) j1 = j; else if (e[j] < e[j1] * 0.6) break; }
  const len1 = e[j1];
  if (len1 < S * 0.08 || len1 > S * 0.42) return null;
  let j2 = j1;
  for (let j = j1 + 1; j < e.length; j++) { if (e[j] < e[j2]) j2 = j; else if (e[j] > e[j2] + len1 * 0.5) break; }
  const b1 = pts[ti + j1];
  const backA = Math.atan2(start[1] - tip[1], start[0] - tip[0]);
  const a1 = angDiff(Math.atan2(b1[1] - tip[1], b1[0] - tip[0]), backA);
  const okAngle = (a) => Math.abs(a) >= 14 * DEG && Math.abs(a) <= 58 * DEG;
  if (!okAngle(a1)) return null;
  const headLen = pathLen(pts.slice(ti));
  let quality = 1;
  if (j2 === j1 || e[j2] > len1 * 0.45) {
    // Only one barb (start, tip, b1): accepted in hold mode.
    if (mode !== 'hold') return null;
    if (j1 < e.length - 3 && e[e.length - 1] < len1 * 0.75) return null;   // wandered back without a second barb
    if (headLen > len1 * 1.6) return null;
    quality = 0.92;
  } else {
    let j3 = j2;
    for (let j = j2 + 1; j < e.length; j++) if (e[j] > e[j3]) j3 = j;
    const len2 = e[j3];
    if (len2 < S * 0.08 || len2 > S * 0.42) return null;
    if (j3 < e.length - 1 - Math.max(2, Math.round(e.length * 0.2))) return null;   // stroke carries on after the head
    const b2 = pts[ti + j3];
    const a2 = angDiff(Math.atan2(b2[1] - tip[1], b2[0] - tip[0]), backA);
    if (!okAngle(a2) || a1 * a2 > 0) return null;                          // barbs on opposite sides of the shaft
    if (headLen > (2 * len1 + len2) * 1.5) return null;
    quality = 1 - Math.min(0.06, (Math.abs(len1 - len2) / Math.max(len1, len2)) * 0.06);
  }
  const conf = clamp(quality - devRel * (0.1 / LINE_DEV.auto), 0, 1);
  return { kind: 'arrow', confidence: conf, points: arrowShape(start, tip, 'start'), start: [start[0], start[1]] };
}

/** Share of a corner's turning that happens within ±win samples of vertex v (chord based, best of v±2). */
function localTurn(pts, v, win) {
  let best = 0;
  for (let c = Math.max(win, v - 2); c <= Math.min(pts.length - 1 - win, v + 2); c++) {
    const a = Math.atan2(pts[c][1] - pts[c - win][1], pts[c][0] - pts[c - win][0]);
    const b = Math.atan2(pts[c + win][1] - pts[c][1], pts[c + win][0] - pts[c][0]);
    best = Math.max(best, Math.abs(angDiff(b, a)));
  }
  return best;
}

function detectOpen(s, mode) {
  const arrow = detectArrow(s, mode);
  if (arrow) return arrow;

  const pts = s.pts, n = pts.length;
  const eps = Math.max(2, s.diag * 0.035);
  let idx = dpIndices(pts, eps);
  // Hooks: a tiny first/last piece (pen landing or lifting) is not a segment.
  const hook = Math.max(s.L * 0.04, 4);
  while (idx.length > 2 && pathLen(pts.slice(idx[0], idx[1] + 1)) < hook) idx.splice(0, 1);
  while (idx.length > 2 && pathLen(pts.slice(idx[idx.length - 2], idx[idx.length - 1] + 1)) < hook) idx.pop();
  const segs = idx.length - 1;
  if (segs - 1 > MAX_CORNERS) return null;
  const lim = LINE_DEV[mode];
  const k = 0.1 / LINE_DEV.auto;       // deviation → confidence: 3% ↔ 0.9

  // One straight line? (In hold mode the tolerance is wider than the corner detector's, so test it first.)
  const whole = fitLine(pts, idx[0], idx[idx.length - 1]);
  const chord = dist(pts[idx[0]], pts[idx[idx.length - 1]]);
  if (segs === 1 || (mode === 'hold' && chord > 0.9 * s.L && whole.dev / chord <= lim)) {
    const f = whole;
    // Deviation from the chord (ends averaged over a few samples), as the spec defines it: an arc
    // with a 5% sagitta is a curve even though it stays within 3.3% of its best-fit line.
    const m3 = Math.min(3, n >> 3);
    const ea = [0, 0], eb = [0, 0];
    for (let i = 0; i < m3; i++) { ea[0] += pts[i][0] / m3; ea[1] += pts[i][1] / m3; eb[0] += pts[n - 1 - i][0] / m3; eb[1] += pts[n - 1 - i][1] / m3; }
    const cl = dist(ea, eb) || 1;
    let cdev = 0;
    for (let i = m3; i < n - m3; i++) cdev = Math.max(cdev, Math.abs((pts[i][0] - ea[0]) * (eb[1] - ea[1]) - (pts[i][1] - ea[1]) * (eb[0] - ea[0])) / cl);
    const devRel = Math.max(f.dev, cdev) / chord;
    if (devRel > lim) return null;
    const m = Math.max(2, Math.round(n * 0.15));
    const fa = fitLine(pts, 0, m), fb = fitLine(pts, n - 1 - m, n - 1);
    const turn = Math.abs(angDiff(Math.atan2(fb.dy, fb.dx), Math.atan2(fa.dy, fa.dx)));
    if (turn > CURVE_TURN && mode === 'auto') return null;          // a curve, however shallow
    const a = project(f, pts[0]), b = project(f, pts[n - 1]);
    const ends = lineEnds(a, b, 'mid');
    return { kind: 'line', confidence: clamp(1 - devRel * k, 0, 1), points: samplePolyline(ends), start: ends[0] };
  }
  if (segs > 4) return null;

  // 2–4 straight segments joined by localized corners.
  const fits = [];
  let worst = 0;
  const minSeg = mode === 'auto' ? SEG_MIN : 14;
  for (let i = 0; i < segs; i++) {
    const a = idx[i], b = idx[i + 1];
    if (b - a < 2) return null;
    const f = fitLine(pts, a + (i > 0 ? 1 : 0), b - (i < segs - 1 ? 1 : 0));   // skip the (smoothed) corner sample
    const len = dist(pts[a], pts[b]);
    if (len < minSeg) return null;
    const devRel = f.dev / len;
    if (devRel > lim) return null;
    if (devRel > worst) worst = devRel;
    fits.push(f);
  }
  const win = Math.max(2, Math.round(n * 0.075));      // ±7.5% → a 15% window
  const turns = [];
  for (let i = 1; i < segs; i++) {
    const t = angDiff(Math.atan2(fits[i].dy, fits[i].dx), Math.atan2(fits[i - 1].dy, fits[i - 1].dx));
    const at = Math.abs(t);
    if (at < TURN_MIN || at > TURN_MAX) return null;
    if (localTurn(pts, idx[i], win) < at * LOCAL) return null;       // a bend spread along the stroke is a curve
    turns.push(t);
  }
  for (let i = 1; i < turns.length; i++) {
    if (Math.abs(turns[i]) > ZIGZAG && Math.abs(turns[i - 1]) > ZIGZAG && turns[i] * turns[i - 1] < 0) return null; // N, Z, W, M, cross-outs
  }
  // Vertices: ends projected onto their fitted lines, corners at the intersections.
  const verts = [project(fits[0], pts[0])];
  for (let i = 1; i < segs; i++) verts.push(intersect(fits[i - 1], fits[i]) || pts[idx[i]]);
  verts.push(project(fits[segs - 1], pts[n - 1]));
  for (let i = 1; i < verts.length - 1; i++) if (dist(verts[i], pts[idx[i]]) > Math.max(12, s.diag * 0.08)) verts[i] = pts[idx[i]];
  const conf = clamp(1 - worst * k, 0, 1);

  if (segs === 2) {
    const A = dist(verts[0], verts[1]), B = dist(verts[1], verts[2]);
    const inner = Math.PI - Math.abs(turns[0]);
    const armMin = mode === 'auto' ? ARM_MIN : 20;
    if (inner >= 70 * DEG && inner <= 110 * DEG && A >= armMin && B >= armMin && Math.min(A, B) >= 0.35 * Math.max(A, B)) {
      // An L is axis-shaped: its arms run (roughly) along the page's horizontal and vertical. A tick or a
      // tilted "V" has the same 90° corner at 45° and must keep its own angles (it falls through to "Lines").
      const ax = axesVerts(verts, turns[0]);
      if (ax.tilt <= AXES_TILT) return { kind: 'axes', confidence: conf, points: samplePolyline(ax.verts) };
    }
  }
  return { kind: 'polyline', confidence: conf, points: samplePolyline(snapPolyline(verts)) };
}

/** An "L" with a true 90° corner; axis-aligned when it is rotated less than 12°. */
function axesVerts(verts, turn) {
  const c = verts[1];
  const A = dist(verts[0], c), B = dist(c, verts[2]);
  let a1 = Math.atan2(verts[0][1] - c[1], verts[0][0] - c[0]);
  let a2 = Math.atan2(verts[2][1] - c[1], verts[2][0] - c[0]);
  // Split the error between the two arms so the corner becomes exactly 90°.
  const between = angDiff(a2, a1);
  const fix = (Math.abs(between) - Math.PI / 2) / 2 * Math.sign(between);
  a1 += fix; a2 -= fix;
  const q = Math.round(a1 / (Math.PI / 2)) * (Math.PI / 2);
  const rot = angDiff(q, a1);
  const tilt = Math.abs(rot);
  if (tilt < 12 * DEG) { a1 += rot; a2 += rot; }
  void turn;
  return { tilt, verts: [[c[0] + Math.cos(a1) * A, c[1] + Math.sin(a1) * A], [c[0], c[1]], [c[0] + Math.cos(a2) * B, c[1] + Math.sin(a2) * B]] };
}

/** Segments within 6° of horizontal/vertical become exactly so (later vertices follow). */
function snapPolyline(verts) {
  const out = verts.map((p) => [p[0], p[1]]);
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const q = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(angDiff(ang, q)) <= 6 * DEG) {
      if (Math.abs(Math.cos(q)) > 0.5) b[1] = a[1]; else b[0] = a[0];
    }
  }
  return out;
}

// ---- Closed shapes --------------------------------------------------------------------------------

/** Cut the overlap / gap where the stroke meets itself and resample the loop cyclically. */
function closeLoop(s) {
  const pts = s.pts, n = pts.length;
  const span = Math.max(1, Math.round(n * 0.15));
  let bi = 0, bj = n - 1, bd = Infinity;
  for (let i = 0; i <= span; i++) {
    for (let j = n - 1 - span; j < n; j++) {
      const d = dist(pts[i], pts[j]);
      if (d < bd - 1e-9) { bd = d; bi = i; bj = j; }
    }
  }
  // Drop the last sample when it lands on (or just past) the first: the closing step must not point backwards.
  const step = s.L / (n - 1);
  const loop = pts.slice(bi, bd < step * 1.5 && bj - bi > 8 ? bj : bj + 1);
  return resample(loop, 72, true);
}

/** Corner candidates on a cyclic loop: local maxima of the chord-to-chord turning angle. */
function loopCorners(loop, win, minTurn) {
  const n = loop.length;
  const th = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = loop[(i - win + n) % n], b = loop[i], c = loop[(i + win) % n];
    th[i] = Math.abs(angDiff(Math.atan2(c[1] - b[1], c[0] - b[0]), Math.atan2(b[1] - a[1], b[0] - a[0])));
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (th[i] < minTurn) continue;
    let peak = true;
    for (let d = 1; d <= win && peak; d++) {
      if (th[(i + d) % n] > th[i] || th[(i - d + n) % n] >= th[i]) peak = false;
    }
    if (peak) out.push(i);
  }
  return out;
}

function fitEllipse(loop) {
  const n = loop.length;
  let cx = 0, cy = 0;
  for (const p of loop) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of loop) { const x = p[0] - cx, y = p[1] - cy; sxx += x * x; sxy += x * y; syy += y * y; }
  const rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(rot), s = Math.sin(rot);
  let u4 = 0, v4 = 0, u2v2 = 0, u2 = 0, v2 = 0, rsum = 0;
  const uv = loop.map((p) => {
    const x = p[0] - cx, y = p[1] - cy;
    const u = x * c + y * s, v = -x * s + y * c;
    u4 += u ** 4; v4 += v ** 4; u2v2 += u * u * v * v; u2 += u * u; v2 += v * v;
    rsum += Math.hypot(x, y);
    return [u, v];
  });
  const den = u4 * v4 - u2v2 * u2v2;
  if (Math.abs(den) < 1e-9) return null;
  const A = (u2 * v4 - v2 * u2v2) / den, B = (v2 * u4 - u2 * u2v2) / den;
  if (!(A > 0) || !(B > 0)) return null;
  const a = 1 / Math.sqrt(A), b = 1 / Math.sqrt(B);
  let err = 0, worst = 0;
  for (const [u, v] of uv) {
    const e = Math.abs(Math.sqrt(u * u * A + v * v * B) - 1);
    err += e; if (e > worst) worst = e;
  }
  return { cx, cy, a, b, rot, err: err / n, worst, rMean: rsum / n };
}

function sideFits(loop, corners) {
  const n = loop.length, k = corners.length, fits = [];
  let err = 0, count = 0, per = 0;
  for (let i = 0; i < k; i++) {
    const a = corners[i], b = corners[(i + 1) % k];
    const seg = [];
    for (let j = a; ; j = (j + 1) % n) { seg.push(loop[j]); if (j === b) break; }
    if (seg.length < 4) return null;
    const trim = seg.length > 8 ? 2 : 1;
    const f = fitLine(seg, trim, seg.length - 1 - trim);
    for (let j = trim; j < seg.length - trim; j++) {
      err += Math.abs((seg[j][0] - f.cx) * -f.dy + (seg[j][1] - f.cy) * f.dx);
      count++;
    }
    f.rel = f.dev / Math.max(1, dist(seg[0], seg[seg.length - 1]));
    per += dist(seg[0], seg[seg.length - 1]);
    fits.push(f);
  }
  const verts = [];
  for (let i = 0; i < k; i++) {
    const p = intersect(fits[(i - 1 + k) % k], fits[i]);
    // The true corner may be cut off where the stroke starts/ends, so only insist that it is nearby.
    if (!p || dist(p, loop[corners[i]]) > per * 0.2) return null;
    verts.push(p);
  }
  return { fits, verts, err: err / Math.max(1, count) / (per / k), per };
}

function detectClosed(s, mode) {
  const loop = closeLoop(s);
  const n = loop.length;
  // Tangent winding of the closed loop: exactly one turn. Spirals, double loops and figure-eights are not.
  const turn = Math.abs(totalTurning([...loop, loop[0], loop[1]]));
  if (turn < 300 * DEG || turn > 450 * DEG) return null;
  if (Math.abs(totalTurning(s.pts)) > 520 * DEG) return null;
  const win = Math.round(n / 16);
  const corners = loopCorners(loop, win, 48 * DEG);
  if (corners.length > MAX_CORNERS) return null;
  const sharp = loopCorners(loop, Math.max(2, Math.round(win / 2)), 62 * DEG);
  let best = null;
  const take = (c) => { if (c && (!best || c.confidence > best.confidence)) best = c; };

  if (corners.length === 4) {
    const r = sideFits(loop, corners);
    if (r) {
      let ok = true, tilt = 0;
      for (let i = 0; i < 4; i++) {
        const f = r.fits[i], g = r.fits[(i + 1) % 4];
        const inner = Math.PI - Math.abs(angDiff(Math.atan2(g.dy, g.dx), Math.atan2(f.dy, f.dx)));
        if (inner < 75 * DEG || inner > 105 * DEG) ok = false;
        const a = Math.atan2(f.dy, f.dx);
        tilt = Math.max(tilt, Math.abs(angDiff(a, Math.round(a / (Math.PI / 2)) * (Math.PI / 2))));
      }
      if (ok && tilt <= 10 * DEG) {
        const xs = r.verts.map((p) => p[0]).sort((a, b) => a - b), ys = r.verts.map((p) => p[1]).sort((a, b) => a - b);
        let x0 = (xs[0] + xs[1]) / 2, x1 = (xs[2] + xs[3]) / 2, y0 = (ys[0] + ys[1]) / 2, y1 = (ys[2] + ys[3]) / 2;
        let w = x1 - x0, h = y1 - y0, kind = 'rectangle';
        if (Math.abs(w - h) <= 0.12 * Math.max(w, h)) {
          const side = (w + h) / 2, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          x0 = mx - side / 2; x1 = mx + side / 2; y0 = my - side / 2; y1 = my + side / 2; w = h = side; kind = 'square';
        }
        if (w > 8 && h > 8) {
          take({ kind, confidence: clamp(1 - r.err * 5, 0, 1), points: samplePolyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]) });
        }
      }
    }
  } else if (corners.length === 3) {
    const r = sideFits(loop, corners);
    if (r) {
      const v = snapPolyline([...r.verts, r.verts[0]]).slice(0, 3);
      const area = Math.abs((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1])) / 2;
      if (area > r.per * r.per * 0.012) {
        take({ kind: 'triangle', confidence: clamp(1 - r.err * 5, 0, 1), points: samplePolyline([v[0], v[1], v[2], v[0]]) });
      }
    }
  }

  {
    // Round shapes have at most one corner (where the stroke meets itself). The tips of a slim ellipse
    // look like corners to the detector, so a near-perfect ellipse fit is accepted regardless.
    const e = fitEllipse(loop);
    if (e && ((sharp.length <= 1 && corners.length <= 2) || (e.err <= 0.035 && corners.length <= 2))) {
      const hi = Math.max(e.a, e.b), lo = Math.min(e.a, e.b), ratio = lo / hi;
      if (ratio >= 0.25) {
        const conf = clamp(1 - e.err * 2.5 - Math.max(0, e.worst - 0.12) * 0.8, 0, 1);
        const start = Math.atan2(loop[0][1] - e.cy, loop[0][0] - e.cx);
        if (ratio >= 0.85) {
          take({ kind: 'circle', confidence: conf, points: sampleEllipse(e.cx, e.cy, e.rMean, e.rMean, 0, start) });
        } else {
          let rot = e.rot;
          const q = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
          if (Math.abs(angDiff(rot, q)) <= 10 * DEG) rot = q;
          take({ kind: 'ellipse', confidence: conf, points: sampleEllipse(e.cx, e.cy, e.a, e.b, rot, 0) });
        }
      }
    }
  }
  return best;
}

// ---- Public ---------------------------------------------------------------------------------------

/**
 * Letter-in-word guard: a stroke drawn right after (and right next to) a similar-sized piece of
 * handwriting is the next letter of a word, not a shape.
 * @param {number[]} bbox  this stroke [x0,y0,x1,y1]
 * @param {{bbox:number[], dt:number}|null} prev  previous raw pen stroke and ms since it ended
 */
export function inWordGuard(bbox, prev) {
  if (!prev || !prev.bbox || !(prev.dt < 1500)) return false;
  const w = bbox[2] - bbox[0], h = Math.max(1, bbox[3] - bbox[1]);
  const diag = Math.hypot(w, h);
  const pb = prev.bbox, ph = Math.max(1, pb[3] - pb[1]);
  const gap = Math.max(0, bbox[0] - pb[2], pb[0] - bbox[2]);
  return gap <= 0.75 * diag && ph >= 0.5 * h && ph <= 2 * h;
}

/**
 * @param {number[][]} points  [[x, y, pressure?], …] in world units
 * @param {{mode?:'auto'|'hold', zoom?:number, scale?:number, prev?:{bbox:number[], dt:number}}} opts
 *   zoom: screen px per world unit (screen-size gate). scale: median bbox diagonal of the handwriting
 *   around the stroke. prev: the previous raw pen stroke (letter-in-word guard, auto mode only).
 * @returns {null | {kind:string, confidence:number, points:number[][], start?:number[]}}
 */
export function recognizeShape(points, opts = {}) {
  const mode = opts.mode === 'hold' ? 'hold' : 'auto';
  const zoom = opts.zoom > 0 ? opts.zoom : 1;
  const g = GATE[mode];
  const s = prep(points);
  if (!s) return null;
  // Cheap size gates first: ordinary handwriting never gets as far as the fitting.
  if (s.diag < g.open || s.diag * zoom < g.screen) return null;
  if (mode === 'auto') {
    if (opts.scale > 0 && s.diag < 4 * opts.scale) return null;
    if (inWordGuard(s.bbox, opts.prev)) return null;
  }
  const gap = dist(s.pts[0], s.pts[s.pts.length - 1]);
  const closed = gap <= 0.2 * s.L && gap <= 0.5 * s.diag;
  const res = closed ? detectClosed(s, mode) : detectOpen(s, mode);
  if (!res || !res.points || res.points.length < 2) return null;
  const isClosed = CLOSED_KINDS.has(res.kind);
  if (isClosed && s.diag < g.closed) return null;
  if (res.confidence < (isClosed ? g.confClosed : g.confOpen)) return null;
  const out = { kind: res.kind, confidence: r2(res.confidence), points: res.points };
  if (res.start) out.start = [r2(res.start[0]), r2(res.start[1])];
  return out;
}

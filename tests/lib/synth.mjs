// Synthetic pen input for the Node tests: a seeded PRNG, a "hand" that turns ideal paths into noisy,
// unevenly sampled strokes, and a small stick-letter alphabet for fake handwriting.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rnd = (rng, lo, hi) => lo + (hi - lo) * rng();
export const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Straight-edged path through vertices, a point every `step` units. */
export function densify(verts, step = 0.5) {
  const out = [[verts[0][0], verts[0][1]]];
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Smooth path through control points (centripetal-ish Catmull-Rom), a point every ~`step` units. */
export function catmull(ctrl, step = 0.5) {
  if (ctrl.length < 3) return densify(ctrl, step);
  const out = [];
  const P = (i) => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const n = Math.max(2, Math.ceil(dist(p1, p2) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(ctrl[ctrl.length - 1].slice(0, 2));
  return out;
}

/** Parametric curve fn(t) for t in [t0, t1] sampled finely. */
export function curve(fn, t0, t1, n = 600) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(fn(t0 + ((t1 - t0) * i) / n));
  return out;
}

export function pathLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }

/**
 * Draw an ideal dense path "by hand": uneven sample spacing (speed changes), hand noise and pressure.
 * `jitter` is the peak-to-peak width of the noise band in world units: 60% of it is per-sample tremor,
 * 40% a slow wobble along the stroke (what a hand-drawn "straight" line really looks like).
 * @returns {number[][]} [[x, y, pressure], …]
 */
export function pen(path, rng, { jitter = 0, minStep = 1, maxStep = 6 } = {}) {
  const L = pathLength(path);
  const tremor = jitter * 0.3, wob = jitter * 0.2;       // amplitudes (half the band each)
  const l1 = L * rnd(rng, 0.45, 0.9), l2 = L * rnd(rng, 0.3, 0.7);
  const f1 = rnd(rng, 0, 6.283), f2 = rnd(rng, 0, 6.283);
  const out = [];
  let s = 0, next = 0, speed = rnd(rng, minStep, maxStep);
  let px = 0, py = 0;
  for (let i = 0; i < path.length; i++) {
    if (i) s += dist(path[i - 1], path[i]);
    if (s + 1e-9 < next && i < path.length - 1) continue;
    speed = Math.min(maxStep, Math.max(minStep, speed + rnd(rng, -1.2, 1.2)));
    next = s + speed;
    // tremor: fresh random offset each sample, slightly correlated with the previous one
    px = px * 0.3 + rnd(rng, -1, 1) * tremor; py = py * 0.3 + rnd(rng, -1, 1) * tremor;
    const wx = wob * Math.sin((s / l1) * 6.283 + f1), wy = wob * Math.sin((s / l2) * 6.283 + f2);
    const pr = 0.5 + 0.25 * Math.sin(s / 40 + f1) + rnd(rng, -0.05, 0.05);
    out.push([path[i][0] + px + wx, path[i][1] + py + wy, Math.max(0.05, Math.min(1, pr))]);
  }
  return out;
}

export function transform(pts, { scale = 1, rot = 0, dx = 0, dy = 0 } = {}) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return pts.map((p) => [(p[0] * c - p[1] * s) * scale + dx, (p[0] * s + p[1] * c) * scale + dy]);
}

// ---- Stick-letter alphabet. Units: x-height = 1, baseline y = 0, up is negative. -----------------
// Each letter: {w: advance width, s: [strokes]}, a stroke = control points (smoothed) or {poly:[…]}.
const O = (() => { const o = []; for (let i = 0; i <= 16; i++) { const t = -1.2 + (i / 16) * 6.6; o.push([0.42 + 0.34 * Math.cos(t), -0.5 + 0.47 * Math.sin(t)]); } return o; })();
export const LETTERS = {
  a: { w: 0.9, s: [[[0.7, -0.75], [0.4, -0.95], [0.1, -0.6], [0.15, -0.15], [0.45, -0.02], [0.7, -0.35], [0.72, -0.95], [0.72, -0.2], [0.85, 0]]] },
  c: { w: 0.75, s: [[[0.65, -0.8], [0.4, -0.97], [0.12, -0.6], [0.2, -0.12], [0.45, -0.02], [0.68, -0.2]]] },
  d: { w: 0.9, s: [[[0.7, -0.7], [0.4, -0.95], [0.1, -0.55], [0.2, -0.1], [0.5, -0.05], [0.72, -0.4], [0.74, -1.9], [0.74, -0.2], [0.86, 0]]] },
  e: { w: 0.8, s: [[[0.12, -0.5], [0.6, -0.55], [0.66, -0.8], [0.4, -0.97], [0.12, -0.55], [0.25, -0.1], [0.5, -0.02], [0.7, -0.2]]] },
  g: { w: 0.85, s: [[[0.7, -0.75], [0.4, -0.95], [0.12, -0.55], [0.25, -0.1], [0.5, -0.08], [0.7, -0.4], [0.72, -0.95], [0.72, 0.5], [0.45, 0.9], [0.15, 0.7]]] },
  h: { w: 0.8, s: [[[0.12, -1.9], [0.12, 0], [0.14, -0.55], [0.4, -0.92], [0.64, -0.7], [0.66, 0]]] },
  i: { w: 0.35, s: [[[0.15, -0.95], [0.15, -0.5], [0.15, 0]], { poly: [[0.14, -1.42], [0.17, -1.36]] }] },
  l: { w: 0.35, s: [[[0.15, -1.9], [0.14, -0.9], [0.14, -0.1], [0.24, 0]]] },
  m: { w: 1.2, s: [[[0.1, -0.95], [0.1, 0], [0.12, -0.6], [0.35, -0.92], [0.55, -0.6], [0.56, 0], [0.58, -0.6], [0.8, -0.92], [1.0, -0.6], [1.02, 0]]] },
  n: { w: 0.8, s: [[[0.1, -0.95], [0.1, 0], [0.12, -0.6], [0.4, -0.92], [0.64, -0.6], [0.66, 0]]] },
  o: { w: 0.85, s: [O] },
  r: { w: 0.6, s: [[[0.1, -0.95], [0.1, 0], [0.12, -0.6], [0.3, -0.9], [0.52, -0.85]]] },
  s: { w: 0.7, s: [[[0.6, -0.82], [0.35, -0.97], [0.14, -0.75], [0.35, -0.5], [0.58, -0.27], [0.38, -0.03], [0.1, -0.15]]] },
  t: { w: 0.65, s: [[[0.3, -1.6], [0.3, -0.8], [0.3, -0.15], [0.45, 0], [0.6, -0.08]], { poly: [[0.05, -0.95], [0.58, -0.95]] }] },
  u: { w: 0.85, s: [[[0.1, -0.95], [0.12, -0.3], [0.35, -0.03], [0.6, -0.3], [0.64, -0.95], [0.64, -0.1], [0.75, 0]]] },
  w: { w: 1.05, s: [{ poly: [[0.05, -0.95], [0.25, 0], [0.5, -0.8], [0.75, 0], [0.95, -0.95]] }] },
  y: { w: 0.75, s: [{ poly: [[0.08, -0.95], [0.36, -0.05]] }, [[0.66, -0.95], [0.45, -0.1], [0.3, 0.5], [0.1, 0.85]]] },
  // Capitals / digits used as "big last letter" negatives.
  O: { w: 0.9, s: [O.map((p) => [p[0], p[1] * 2])] },
  L: { w: 0.8, s: [{ poly: [[0.1, -2], [0.1, 0], [0.75, 0]] }] },
  Z: { w: 0.9, s: [{ poly: [[0.05, -2], [0.85, -2], [0.05, 0], [0.85, 0]] }] },
  N: { w: 0.9, s: [{ poly: [[0.05, 0], [0.05, -2], [0.85, 0], [0.85, -2]] }] },
  W: { w: 1.3, s: [{ poly: [[0.05, -2], [0.35, 0], [0.65, -1.5], [0.95, 0], [1.25, -2]] }] },
  M: { w: 1.3, s: [{ poly: [[0.05, 0], [0.05, -2], [0.65, -0.6], [1.25, -2], [1.25, 0]] }] },
  7: { w: 0.8, s: [{ poly: [[0.05, -2], [0.8, -2], [0.3, 0]] }] },
  V: { w: 0.9, s: [{ poly: [[0.05, -2], [0.45, 0], [0.85, -2]] }] },
};

/** Ideal dense paths (world units) of one letter placed with its left edge at x and baseline at `base`. */
export function letterPaths(ch, x, base, xh, { slant = 0 } = {}) {
  const L = LETTERS[ch];
  if (!L) throw new Error('no glyph for ' + ch);
  return L.s.map((st) => {
    const ctrl = (st.poly || st).map((p) => [x + (p[0] - p[1] * slant) * xh, base + p[1] * xh]);
    return st.poly ? densify(ctrl, 0.4) : catmull(ctrl, 0.4);
  });
}

/**
 * Write a word by hand. @returns {{strokes:number[][][], width:number}} one array of [x,y,p] per stroke.
 * opts: {slant (x shear per unit height), jitter (world units), gap (letter gap ÷ x-height)}
 */
export function writeWord(word, x, base, xh, rng, opts = {}) {
  const strokes = [];
  let cx = x;
  for (const ch of word) {
    for (const path of letterPaths(ch, cx, base + rnd(rng, -0.03, 0.03) * xh, xh, opts)) {
      strokes.push(pen(path, rng, { jitter: opts.jitter ?? xh * 0.04, minStep: 0.8, maxStep: Math.max(1.2, xh * 0.18) }));
    }
    cx += (LETTERS[ch].w + (opts.gap ?? 0.12)) * xh;
  }
  return { strokes, width: cx - x - (opts.gap ?? 0.12) * xh };
}

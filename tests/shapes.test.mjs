// node tests/shapes.test.mjs — shape recognition on seeded, noisy synthetic strokes.
// Prints a confusion table; exits non-zero on any false positive or recall below 90%.
import { recognizeShape, lineShape, arrowShape, inWordGuard, SHAPE_KINDS } from '../js/canvas/shapes.js';
import { mulberry32, rnd, pick, densify, catmull, curve, pen, transform, letterPaths, writeWord, pathLength } from './lib/synth.mjs';

const SEED = Number(process.env.SEED || 20261111);
const PER_KIND = Number(process.env.N || 60);
const rng = mulberry32(SEED);
const DEG = Math.PI / 180;
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const bbox = (pts) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); } return [a, b, c, d]; };
const diagOf = (pts) => { const b = bbox(pts); return Math.hypot(b[2] - b[0], b[3] - b[1]); };

/** Hand-draw an ideal path: jitter band 2–4% of the shape's size, varied speed, uneven sampling. */
function hand(path, size, o = {}) {
  const fast = rng() < 0.4;
  return pen(path, rng, { jitter: size * rnd(rng, 0.02, 0.04) * (o.calm ?? 1), minStep: fast ? 2.5 : 0.8, maxStep: fast ? 7 : 3.5 });
}
const place = (pts, rot = 0) => transform(pts, { rot, dx: rnd(rng, 150, 600), dy: rnd(rng, 200, 900) });

/** Closed polygon drawn from a random point on its outline, either way round, ending a bit short or long. */
function loopPath(verts, { round = 0 } = {}) {
  let ring = densify([...verts, verts[0]], 0.5).slice(0, -1);
  if (round > 0) { // soften corners the way a quick hand does
    const k = Math.round(round / 0.5);
    ring = ring.map((_, i) => { let x = 0, y = 0; for (let d = -k; d <= k; d++) { const p = ring[(i + d + ring.length) % ring.length]; x += p[0]; y += p[1]; } return [x / (2 * k + 1), y / (2 * k + 1)]; });
  }
  if (rng() < 0.5) ring.reverse();
  const n = ring.length, start = Math.floor(rng() * n);
  const count = Math.round(n * (1 + rnd(rng, -0.05, 0.07)));
  const out = [];
  for (let i = 0; i <= count; i++) out.push(ring[(start + i) % n]);
  return out;
}

const GEN = {
  line() {
    const len = rnd(rng, 110, 520);
    return { pts: hand(place(densify([[0, 0], [len, 0]]), rnd(rng, 0, 360) * DEG), len), want: ['line'] };
  },
  arrow() {
    const S = rnd(rng, 130, 420), b1 = S * rnd(rng, 0.14, 0.3), b2 = b1 * rnd(rng, 0.8, 1.2);
    const a1 = rnd(rng, 24, 46) * DEG, a2 = rnd(rng, 24, 46) * DEG, side = rng() < 0.5 ? 1 : -1;
    const tip = [S, 0], back = [S - rnd(rng, 0, 3), rnd(rng, -2, 2)];
    const path = densify([[0, 0], tip, [S - b1 * Math.cos(a1), side * b1 * Math.sin(a1)], back, [S - b2 * Math.cos(a2), -side * b2 * Math.sin(a2)]]);
    return { pts: hand(place(path, rnd(rng, 0, 360) * DEG), S, { calm: 0.8 }), want: ['arrow'] };
  },
  axes(orient) {
    const A = rnd(rng, 110, 360), B = Math.max(95, A * rnd(rng, 0.5, 1.6)), skew = rnd(rng, -9, 9) * DEG;
    let verts = [[0, -A], [0, 0], [B * Math.cos(skew), B * Math.sin(skew)]];
    if (rng() < 0.4) verts.reverse();
    const path = densify(verts);
    return { pts: hand(place(path, orient * 90 * DEG + rnd(rng, -8, 8) * DEG), Math.min(A, B) * 1.3), want: ['axes'] };
  },
  polyline() {
    // Kinked demand curve (2 segments) or a 3-segment step, never a zig-zag.
    const three = rng() < 0.35;
    const l1 = rnd(rng, 80, 260), l2 = rnd(rng, 80, 260), t1 = rnd(rng, 30, 65) * DEG * (rng() < 0.5 ? 1 : -1);
    const verts = [[0, 0], [l1, 0], [l1 + l2 * Math.cos(t1), l2 * Math.sin(t1)]];
    let shortest = Math.min(l1, l2);
    if (three) {
      const l3 = rnd(rng, 80, 220); shortest = Math.min(shortest, l3);
      const t2 = t1 + rnd(rng, 35, 80) * DEG * (rng() < 0.5 ? 1 : -1);
      verts.push([verts[2][0] + l3 * Math.cos(t2), verts[2][1] + l3 * Math.sin(t2)]);
    }
    const path = densify(verts);
    return { pts: hand(place(path, rnd(rng, 0, 360) * DEG), shortest * 1.3), want: ['polyline'] };
  },
  circle() {
    const r = rnd(rng, 50, 190), egg = rnd(rng, 0.93, 1), dir = rng() < 0.5 ? 1 : -1, a0 = rnd(rng, 0, 6.28), sweep = 6.283 * (1 + rnd(rng, -0.05, 0.09));
    const path = curve((t) => [r * Math.cos(a0 + dir * t), r * egg * Math.sin(a0 + dir * t)], 0, sweep);
    return { pts: hand(place(path, rnd(rng, 0, 6.28)), 2 * r), want: ['circle'] };
  },
  ellipse() {
    const a = rnd(rng, 75, 220), b = a * rnd(rng, 0.33, 0.72), dir = rng() < 0.5 ? 1 : -1, a0 = rnd(rng, 0, 6.28), sweep = 6.283 * (1 + rnd(rng, -0.05, 0.08));
    const path = curve((t) => [a * Math.cos(a0 + dir * t), b * Math.sin(a0 + dir * t)], 0, sweep);
    return { pts: hand(place(path, rnd(rng, 0, 6.28)), a + b), want: ['ellipse'] };
  },
  rectangle() {
    const w = rnd(rng, 130, 420), h = w * (rng() < 0.5 ? rnd(rng, 0.35, 0.72) : rnd(rng, 1.4, 2.2));
    const path = loopPath([[0, 0], [w, 0], [w, h], [0, h]], { round: rng() < 0.5 ? Math.min(w, h) * 0.03 : 0 });
    return { pts: hand(place(path, rnd(rng, -5, 5) * DEG), Math.min(w, h)), want: ['rectangle'] };
  },
  square() {
    const w = rnd(rng, 110, 360), h = w * rnd(rng, 0.96, 1.04);
    const path = loopPath([[0, 0], [w, 0], [w, h], [0, h]], { round: rng() < 0.5 ? w * 0.03 : 0 });
    return { pts: hand(place(path, rnd(rng, -5, 5) * DEG), w), want: ['square'] };
  },
  triangle() {
    const base = rnd(rng, 130, 380), apexX = base * rnd(rng, 0.2, 0.8), hgt = base * rnd(rng, 0.6, 1.1);
    const path = loopPath([[0, 0], [base, 0], [apexX, -hgt]]);
    return { pts: hand(place(path, rnd(rng, 0, 360) * DEG), base * 0.8), want: ['triangle'] };
  },
};

// ---- Positives -----------------------------------------------------------------------------------
const cols = [...SHAPE_KINDS, 'null'];
const table = {};
const rows = ['line', 'arrow', 'axes ┘', 'axes └', 'axes ┌', 'axes ┐', 'polyline', 'circle', 'ellipse', 'rectangle', 'square', 'triangle'];
let ms = 0, calls = 0, worstMs = 0;
function run(pts, opts) {
  const t0 = performance.now();
  const r = recognizeShape(pts, opts);
  const dt = performance.now() - t0;
  ms += dt; calls++; if (dt > worstMs) worstMs = dt;
  return r;
}
function checkOutput(name, r) {
  const p = r.points;
  if (!Array.isArray(p) || p.length < 2) return fail(`${name}: no output points`);
  for (let i = 0; i < p.length; i++) {
    if (p[i].length !== 3 || p[i][2] !== 0.5 || !Number.isFinite(p[i][0]) || !Number.isFinite(p[i][1])) return fail(`${name}: bad point ${JSON.stringify(p[i])}`);
    if (i && p[i][0] === p[i - 1][0] && p[i][1] === p[i - 1][1]) return fail(`${name}: duplicate point`);
    if (i && Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) > 2.6) return fail(`${name}: sampling gap`);
  }
  if (!(r.confidence >= 0 && r.confidence <= 1)) fail(`${name}: confidence ${r.confidence}`);
}
for (const row of rows) {
  table[row] = Object.fromEntries(cols.map((c) => [c, 0]));
  const kind = row.split(' ')[0];
  const orient = ['axes ┘', 'axes └', 'axes ┌', 'axes ┐'].indexOf(row);
  for (let i = 0; i < PER_KIND; i++) {
    const g = GEN[kind](Math.max(0, orient));
    const r = run(g.pts, { mode: 'auto', zoom: 1 });
    table[row][r ? r.kind : 'null']++;
    if (r) checkOutput(row, r);
  }
}
console.log(`\nShape recognition — seed ${SEED}, ${PER_KIND} noisy strokes per row, mode auto`);
console.log('expected'.padEnd(11) + cols.map((c) => c.slice(0, 6).padStart(7)).join('') + '   recall');
let totalOk = 0, total = 0;
for (const row of rows) {
  const kind = row.split(' ')[0];
  const ok = table[row][kind], recall = ok / PER_KIND;
  totalOk += ok; total += PER_KIND;
  console.log(row.padEnd(11) + cols.map((c) => String(table[row][c] || '·').padStart(7)).join('') + `   ${(recall * 100).toFixed(0)}%`);
  if (recall < 0.9) fail(`recall for ${row} is ${(recall * 100).toFixed(0)}% (< 90%)`);
  const wrong = PER_KIND - ok - table[row].null;
  // rectangle ↔ square near the 12% boundary is the only tolerated confusion
  if (wrong > 0 && !(kind === 'rectangle' || kind === 'square')) fail(`${row}: ${wrong} converted to the wrong shape`);
}
console.log(`overall recall ${(100 * totalOk / total).toFixed(1)}%`);

// ---- Geometry of the outputs ----------------------------------------------------------------------
{
  const horiz = recognizeShape(hand(densify([[100, 300], [400, 309]]), 300), { mode: 'auto', zoom: 1 });
  if (!horiz || horiz.kind !== 'line' || horiz.points[0][1] !== horiz.points.at(-1)[1]) fail('a 2° line must snap to horizontal');
  const diag45 = recognizeShape(hand(densify([[100, 300], [300, 494]]), 280), { mode: 'auto', zoom: 1 });
  if (!diag45 || Math.abs(Math.abs(diag45.points.at(-1)[0] - diag45.points[0][0]) - Math.abs(diag45.points.at(-1)[1] - diag45.points[0][1])) > 0.05) fail('a 44° line must snap to 45°');
  const free = recognizeShape(hand(densify([[100, 300], [300, 380]]), 215), { mode: 'auto', zoom: 1 });
  if (!free || Math.abs(Math.atan2(free.points.at(-1)[1] - free.points[0][1], free.points.at(-1)[0] - free.points[0][0]) / DEG - 21.8) > 2) fail('a 22° line keeps its angle');
  const ax = recognizeShape(hand(densify([[205, 100], [200, 400], [520, 408]]), 300), { mode: 'auto', zoom: 1 });
  if (!ax || ax.kind !== 'axes') fail('L-axes not recognised');
  else {
    const xs = new Set(ax.points.map((p) => p[0])), ys = new Set(ax.points.map((p) => p[1]));
    const vert = ax.points.filter((p) => p[0] === ax.points[0][0]).length, hor = ax.points.filter((p) => p[1] === ax.points.at(-1)[1]).length;
    if (vert < 100 || hor < 100 || xs.size < 100 || ys.size < 100) fail('axes must be axis-aligned with a true 90° corner');
  }
  const sq = recognizeShape(hand(loopPath([[0, 0], [200, 0], [200, 204], [0, 204]]).map((p) => [p[0] + 300, p[1] + 300]), 200), { mode: 'auto', zoom: 1 });
  if (!sq || sq.kind !== 'square') fail('square not recognised');
  else { const b = bbox(sq.points); if (Math.abs((b[2] - b[0]) - (b[3] - b[1])) > 0.05) fail('square sides differ'); }
  const ci = recognizeShape(hand(curve((t) => [400 + 100 * Math.cos(t), 400 + 100 * Math.sin(t)], 0, 6.4), 200), { mode: 'auto', zoom: 1 });
  if (!ci || ci.kind !== 'circle') fail('circle not recognised');
  else { const rs = ci.points.map((p) => Math.hypot(p[0] - 400, p[1] - 400)); if (Math.max(...rs) - Math.min(...rs) > 8) fail('circle output is not round'); }
  const l = lineShape([0, 0], [100, 3]);
  if (l.at(-1)[1] !== 0 || l[0][0] !== 0) fail('lineShape snaps about its start');
  const ar = arrowShape([0, 0], [200, 0]);
  const ys = ar.map((p) => p[1]);
  if (Math.abs(Math.max(...ys) + Math.min(...ys)) > 0.02 || Math.max(...ys) < 9) fail('arrow head must be symmetric');
}

// ---- Negatives: nothing here may be converted in auto mode ------------------------------------------
const neg = [];   // {name, pts, opts}
const N = (name, pts, opts = {}) => neg.push({ name, pts, opts: { mode: 'auto', zoom: 1, ...opts } });
const handwriting = (ch, xh) => letterPaths(ch, rnd(rng, 100, 500), rnd(rng, 200, 800), xh, { slant: rnd(rng, 0, 0.25) }).map((p) => pen(p, rng, { jitter: xh * 0.05, minStep: 0.8, maxStep: 2.5 }));

// 1. ordinary small handwriting
for (const ch of ['e', 'a', 'o', 'l', 't', 'h', 's', 'g', 'y', 'm', 'w', 'd', 'c', 'u', 'n', 'r', 'i']) {
  for (const xh of [10, 16, 24]) handwriting(ch, xh).forEach((st, i) => N(`letter ${ch}/${i} xh${xh}`, st));
}
for (const xh of [12, 20]) for (const w of ['the', 'then', 'dog', 'small']) writeWord(w, 120, 300, xh, rng).strokes.forEach((st, i) => N(`word "${w}" stroke ${i} xh${xh}`, st));
// 2. cursive loops and scribbles big enough to pass the size gates
for (let i = 0; i < 6; i++) {
  const h = rnd(rng, 18, 60), n = Math.round(rnd(rng, 3, 8));
  N(`cursive loops ×${n} h${h | 0}`, hand(curve((t) => [200 + h * 0.55 * (t - 1.5 * Math.sin(t)), 400 - h * 0.5 * (1 - Math.cos(t))], 0, n * 6.283, 900), h, { calm: 0.5 }));
}
N('single open loop (ℓ)', hand(curve((t) => [300 + 60 * (t / 2 - Math.sin(t)), 500 - 90 * (1 - Math.cos(t))], 0, 6.283), 100, { calm: 0.5 }));
// 3. short underlines / hatching / dashes
for (let i = 0; i < 4; i++) N(`short underline ${i}`, hand(densify([[200, 400], [200 + rnd(rng, 40, 86), 400 + rnd(rng, -3, 3)]]), 60));
for (let i = 0; i < 6; i++) { const x = 300 + i * 14; N(`hatching stroke ${i}`, hand(densify([[x, 500], [x + 45, 440]]), 70)); }
for (let i = 0; i < 6; i++) { const x = 200 + i * 40; N(`dash ${i}`, hand(densify([[x, 600], [x + rnd(rng, 14, 30), 600]]), 20)); }
{ // long hatching drawn quickly next to the previous line: the letter-in-word guard keeps it raw
  const a = hand(densify([[300, 520], [380, 420]]), 120), b = hand(densify([[318, 520], [398, 420]]), 120);
  N('long hatching stroke after its neighbour', b, { prev: { bbox: bbox(a), dt: 350 } });
}
// 4. big letters as the last glyph of a word (previous letter just written beside them)
for (const ch of ['O', 'L', 'Z', 'N', 'W', 'M', '7', 'V']) {
  for (const xh of [48, 70]) {
    const x = rnd(rng, 200, 400), base = rnd(rng, 400, 700);
    const prevCh = pick(rng, ['h', 'l', 'd', 't']);
    const prev = pen(letterPaths(prevCh, x - xh * 0.9, base, xh)[0], rng, { jitter: 2 });
    const st = pen(letterPaths(ch, x, base, xh)[0], rng, { jitter: xh * 0.05, minStep: 1, maxStep: 4 });
    if (diagOf(st) < 90) throw new Error('test bug: big letter too small');
    N(`big "${ch}" ending a word (${Math.round(xh * 2)} tall)`, st, { prev: { bbox: bbox(prev), dt: rnd(rng, 150, 900) } });
  }
}
// zig-zag letters are rejected even with no neighbour at all
for (const ch of ['Z', 'N', 'W', 'M']) N(`standalone big "${ch}"`, pen(letterPaths(ch, 300, 600, 80)[0], rng, { jitter: 4, minStep: 1, maxStep: 4 }));
// 5. local-scale gate: a 100-unit letter among 40-unit handwriting
for (const ch of ['O', 'L', 'V', '7']) N(`"${ch}" 100 tall among 40-unit writing`, pen(letterPaths(ch, 300, 600, 50)[0], rng, { jitter: 3 }), { scale: 40 });
// 6. zoomed out: handwriting 100 world units tall at zoom 0.3 is only 30 px on screen
for (const ch of ['O', 'L', 'l', 'V', '7', 'o']) N(`"${ch}" 100 units tall at zoom 0.3`, pen(letterPaths(ch, 300, 600, ch === 'o' ? 100 : 50)[0], rng, { jitter: 3 }), { zoom: 0.3 });
// 7. economics curves and other smooth curves (well above every size gate)
const arcBy = (x0, y0, x1, y1, sag) => { // quadratic curve with the given sagitta ÷ chord
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0;
  const cx = mx - dy * sag * 2, cy = my + dx * sag * 2;
  return curve((t) => [(1 - t) * (1 - t) * x0 + 2 * t * (1 - t) * cx + t * t * x1, (1 - t) * (1 - t) * y0 + 2 * t * (1 - t) * cy + t * t * y1], 0, 1);
};
for (const sag of [0.05, 0.1, 0.2]) {
  for (const size of [160, 300]) {
    N(`demand curve (down) sag ${sag} size ${size}`, hand(arcBy(200, 300, 200 + size, 300 + size * 0.9, -sag), size, { calm: 0.6 }));
    N(`supply curve (up) sag ${sag} size ${size}`, hand(arcBy(200, 300 + size * 0.9, 200 + size, 300, sag), size, { calm: 0.6 }));
    N(`demand curve reversed sag ${sag} size ${size}`, hand(arcBy(200 + size, 300 + size * 0.9, 200, 300, sag), size, { calm: 0.6 }));
  }
}
for (const size of [150, 320]) {
  N(`hyperbola demand curve ${size}`, hand(curve((t) => [200 + size * t, 300 + size * 0.22 / (t + 0.2)], 0, 1), size, { calm: 0.6 }));
  N(`S-curve ${size}`, hand(curve((t) => [200 + size * t, 500 - size * 0.6 / (1 + Math.exp(-10 * (t - 0.5)))], 0, 1), size, { calm: 0.6 }));
  N(`parabola ${size}`, hand(curve((t) => [300 + size * t, 300 + size * 1.2 * t * t], -0.6, 0.6), size, { calm: 0.6 }));
  N(`U-shaped cost curve ${size}`, hand(curve((t) => [300 + size * t, 500 + size * 0.5 * t * t], -0.8, 0.8), size, { calm: 0.6 }));
  N(`sine wave 1 period ${size}`, hand(curve((t) => [200 + size * t / 6.283, 400 + size * 0.15 * Math.sin(t)], 0, 6.283), size, { calm: 0.6 }));
  N(`sine wave 2.5 periods ${size}`, hand(curve((t) => [200 + size * t / 15.7, 400 + size * 0.12 * Math.sin(t)], 0, 15.7), size, { calm: 0.6 }));
  N(`shallow sine ${size}`, hand(curve((t) => [200 + size * t / 6.283, 400 + size * 0.06 * Math.sin(t)], 0, 6.283), size, { calm: 0.5 }));
  N(`bell curve ${size}`, hand(curve((t) => [300 + size * t, 500 - size * 0.5 * Math.exp(-t * t * 8)], -0.7, 0.7), size, { calm: 0.6 }));
  for (const sweep of [60, 90, 180, 270]) N(`arc ${sweep}° ${size}`, hand(curve((t) => [400 + size * 0.5 * Math.cos(t), 400 + size * 0.5 * Math.sin(t)], 0.3, 0.3 + sweep * DEG), size, { calm: 0.6 }));
  for (const turns of [1.6, 2, 3]) N(`spiral ${turns} turns ${size}`, hand(curve((t) => [400 + size * 0.08 * t * Math.cos(t), 400 + size * 0.08 * t * Math.sin(t)], 1, turns * 6.283), size, { calm: 0.5 }));
  N(`double circle scribble ${size}`, hand(curve((t) => [400 + size * 0.5 * Math.cos(t), 400 + size * 0.48 * Math.sin(t)], 0, 12.3), size, { calm: 0.6 }));
  N(`figure eight ${size}`, hand(curve((t) => [400 + size * 0.4 * Math.sin(t), 400 + size * 0.25 * Math.sin(2 * t)], 0, 6.283), size, { calm: 0.6 }));
  N(`long-run average cost (flat U) ${size}`, hand(curve((t) => [300 + size * t, 500 + size * 0.9 * t * t * t * t], -0.8, 0.8), size, { calm: 0.6 }));
}
// 8. zig-zag cross-outs
for (let i = 0; i < 6; i++) {
  const n = Math.round(rnd(rng, 3, 9)), h = rnd(rng, 30, 90), w = n * h * rnd(rng, 0.2, 0.45), verts = [];  // sharp reversals
  for (let k = 0; k <= n; k++) verts.push([200 + (w * k) / n, 400 + (k % 2 ? h : 0)]);
  N(`zig-zag cross-out ${n} strokes`, hand(densify(verts), h, { calm: 0.8 }));
}
for (let i = 0; i < 3; i++) { // back-and-forth scribble over a word
  const verts = []; for (let k = 0; k < 8; k++) verts.push([200 + (k % 2 ? 150 : 0) + rnd(rng, -8, 8), 400 + k * 4]);
  N(`back-and-forth scribble ${i}`, hand(densify(verts), 40));
}
// 9. things that are almost shapes but are not
N('tick ✓', hand(densify([[200, 400], [230, 440], [330, 300]]), 100), { prev: null });
N('letter C, large', hand(curve((t) => [400 + 80 * Math.cos(t), 400 + 100 * Math.sin(t)], 0.9, 5.4), 180, { calm: 0.6 }));
N('question-mark hook', hand(catmull([[300, 300], [350, 260], [400, 300], [360, 360], [350, 420]]), 120, { calm: 0.5 }));
N('bracket (', hand(arcBy(300, 300, 300, 500, 0.12), 200, { calm: 0.5 }));
N('curly underline', hand(curve((t) => [200 + 40 * t, 500 + 6 * Math.sin(t * 3)], 0, 6), 30));
N('integral-like S', hand(catmull([[400, 300], [370, 290], [350, 330], [350, 470], [330, 510], [300, 500]]), 200, { calm: 0.5 }));

// A tick / tilted V has a ~90° corner at 45°: it may be straightened, but never become an axis pair.
for (const [name, verts] of [['tick 70/130', [[200, 400], [270, 480], [400, 310]]], ['big tick', [[200, 400], [280, 490], [430, 280]]], ['tilted V', [[200, 400], [260, 520], [340, 400]]]]) {
  for (let k = 0; k < 10; k++) {
    const r = run(hand(densify(verts), 110), { mode: 'auto', zoom: 1 });
    if (r && r.kind === 'axes') fail(`${name} became axes`);
  }
}

let fp = 0;
for (const c of neg) {
  const r = run(c.pts, c.opts);
  if (r) { fp++; fail(`false positive: ${c.name} → ${r.kind} (confidence ${r.confidence})`); }
}
console.log(`\nNegatives (auto mode): ${neg.length} strokes, ${fp} converted`);
if (neg.length < 40) fail('fewer than 40 negatives');
{ // sanity: the gates are what protects the guarded cases (the same strokes convert without them)
  const o = pen(letterPaths('O', 300, 600, 70)[0], rng, { jitter: 3 });
  if (!recognizeShape(o, { mode: 'auto', zoom: 1 })) fail('control: a lone 140-unit "O" should become an ellipse/circle');
  if (!inWordGuard([0, 0, 50, 100], { bbox: [-60, 0, -10, 90], dt: 400 })) fail('inWordGuard basic case');
  if (inWordGuard([0, 0, 50, 100], { bbox: [-60, 0, -10, 90], dt: 1600 })) fail('inWordGuard must expire after 1.5 s');
  if (inWordGuard([0, 0, 300, 4], { bbox: [0, -30, 290, -4], dt: 300 })) fail('an underline right after a word is not guarded');
}

// ---- Hold mode ------------------------------------------------------------------------------------
{
  const H = (pts, zoom = 1) => recognizeShape(pts, { mode: 'hold', zoom });
  const wobbly = pen(curve((t) => [200 + 180 * t, 300 + 60 * t + 9 * Math.sin(t * 5)], 0, 1), rng, { jitter: 3 });
  const r1 = H(wobbly);
  if (!r1 || r1.kind !== 'line') fail(`hold: straight-ish line → ${r1 && r1.kind}`);
  if (recognizeShape(wobbly, { mode: 'auto', zoom: 1 })) fail('auto must not straighten the same 5%-wobbly line');
  const smallLine = H(pen(densify([[200, 300], [250, 310]]), rng, { jitter: 1 }));
  if (!smallLine || smallLine.kind !== 'line') fail('hold: 50-unit line');
  const c = H(pen(curve((t) => [300 + 30 * Math.cos(t), 300 + 27 * Math.sin(t)], 0, 6.5), rng, { jitter: 2 }));
  if (!c || (c.kind !== 'circle' && c.kind !== 'ellipse')) fail(`hold: small circle → ${c && c.kind}`);
  const rect = H(pen(loopPath([[0, 0], [90, 0], [90, 50], [0, 50]]).map((p) => [p[0] + 300, p[1] + 300]), rng, { jitter: 2 }));
  if (!rect || rect.kind !== 'rectangle') fail(`hold: rectangle → ${rect && rect.kind}`);
  const oneBarb = H(pen(densify([[200, 400], [400, 400], [370, 380]]), rng, { jitter: 2 }));
  if (!oneBarb || oneBarb.kind !== 'arrow') fail(`hold: shaft + one barb → ${oneBarb && oneBarb.kind}`);
  for (const sag of [0.12, 0.2, 0.3]) {
    const r = H(pen(arcBy(200, 300, 420, 500, -sag), rng, { jitter: 3 }));
    if (r) fail(`hold: smooth curve (sag ${sag}) must stay raw, got ${r.kind}`);
  }
  if (H(pen(curve((t) => [200 + 250 * t, 500 - 200 / (1 + Math.exp(-14 * (t - 0.5)))], 0, 1), rng, { jitter: 3 }))) fail('hold: S-curve must stay raw');
  if (H(pen(densify([[200, 300], [230, 304]]), rng, { jitter: 0.5 }))) fail('hold: 30-unit line is below the size gate');
  if (H(pen(densify([[200, 300], [260, 304]]), rng, { jitter: 0.5 }), 0.5)) fail('hold: 60 units at zoom 0.5 is under 40 screen px');
}

// ---- Robustness -----------------------------------------------------------------------------------
{
  for (const bad of [null, [], [[1, 2, 0.5]], [[1, 2, 0.5], [1, 2, 0.5]], [[NaN, 1], [2, 3]], 'x']) {
    try { if (recognizeShape(bad, { mode: 'auto', zoom: 1 }) !== null) fail('degenerate input must return null'); } catch (e) { fail('threw on degenerate input: ' + e.message); }
  }
  const huge = []; for (let i = 0; i < 20000; i++) huge.push([100 + i * 0.03, 300 + Math.sin(i / 2000) * 0.5, 0.5]);
  const t0 = performance.now(); const r = recognizeShape(huge, { mode: 'auto', zoom: 1 }); const dt = performance.now() - t0;
  if (!r || r.kind !== 'line') fail('20,000-point line');
  if (dt > 25) fail(`20,000-point stroke took ${dt.toFixed(1)} ms`);
  const mean = ms / calls;
  console.log(`\nTiming: mean ${mean.toFixed(3)} ms, worst ${worstMs.toFixed(2)} ms over ${calls} calls; 20k points ${dt.toFixed(2)} ms`);
  if (mean > 5) fail(`mean recognition time ${mean.toFixed(2)} ms (> 5 ms)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nshapes: all checks passed');
process.exit(failures ? 1 : 0);

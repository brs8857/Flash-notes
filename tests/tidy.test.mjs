// node tests/tidy.test.mjs — Tidy ink on seeded synthetic handwriting. Prints metrics; exits non-zero on failure.
import { tidyStrokes } from '../js/canvas/tidy.js';
import { mulberry32, rnd, writeWord, pen, curve, densify, LETTERS } from './lib/synth.mjs';

const SEED = Number(process.env.SEED || 20261111);
const DEG = Math.PI / 180;
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, msg) => { if (!cond) fail(msg); };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const cv = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) / m; };
const bboxP = (pts) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); } return [a, b, c, d]; };
function freeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) freeze(o[k]); } return o; }
let idc = 0;
const item = (points, extra = {}) => ({ id: 's' + (++idc), type: 'stroke', tool: 'pen', color: '#1C1C1E', size: 3, points: points.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round((p[2] ?? 0.5) * 100) / 100]), bbox: bboxP(points), ...extra });
/** Position at an arc-length fraction: lets us compare a stroke before/after resampling. */
function at(pts, f) {
  let L = 0; const acc = [0];
  for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); acc.push(L); }
  const t = L * f; let j = 1; while (j < pts.length - 1 && acc[j] < t) j++;
  const seg = acc[j] - acc[j - 1] || 1, k = Math.min(1, Math.max(0, (t - acc[j - 1]) / seg));
  return [pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * k, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * k];
}
function maxMove(a, b) {
  let m = 0;
  for (let i = 0; i <= 24; i++) { const p = at(a, i / 24), q = at(b, i / 24); m = Math.max(m, Math.hypot(p[0] - q[0], p[1] - q[1])); }
  return m;
}

const PLAIN = new Set('aceomnrsu'.split(''));      // x-height letters with no ascender/descender
/**
 * A messy line of handwriting: sloping, wavy baseline, uneven word sizes, slants and gaps.
 * @returns {{items, words:[{from,to,letters:[{ch,from,to}]}]}}
 */
function messyLine(rng, text, { x = 110, base = 300, xh = 13, slope = 3, wave = 3, sizes = [0.78, 1.3], slants = [0, 0.32], gaps = [0.6, 1.7] } = {}) {
  const items = [], words = [];
  let cx = x;
  const list = text.split(' ');
  list.forEach((word, wi) => {
    const k = rnd(rng, sizes[0], sizes[1]), sl = rnd(rng, slants[0], slants[1]);
    const by = base + Math.tan(slope * DEG) * (cx - x) + wave * Math.sin(wi * 1.9 + 0.7) + rnd(rng, -1, 1);
    const w = { from: items.length, letters: [] };
    let lx = cx;
    for (const ch of word) {
      const from = items.length;
      const one = writeWord(ch, lx, by + Math.tan(slope * DEG) * (lx - cx), xh * k, rng, { slant: sl, jitter: 0.5, gap: 0 });
      for (const st of one.strokes) items.push(item(st));
      w.letters.push({ ch, from, to: items.length });
      lx += (LETTERS[ch].w + 0.12) * xh * k;
    }
    w.to = items.length;
    words.push(w);
    cx = lx + xh * rnd(rng, gaps[0], gaps[1]);
  });
  return { items, words };
}

/** Independent measurements of a line (from the known letter structure, not from tidy.js internals). */
function measure(strokes, words) {
  const bases = [], heights = [], centres = [], slants = [], boxes = [];
  for (const w of words) {
    const bottoms = [], tops = [];
    let sx = 0, sw = 0;
    for (const L of w.letters) {
      const st = strokes[L.from];                       // first stroke of the letter (stems, bowls)
      const b = bboxP(st.points);
      if (!'gy'.includes(L.ch)) bottoms.push(b[3]);
      if (PLAIN.has(L.ch)) tops.push(b[1]);
      if ('hldt'.includes(L.ch)) {                      // slant of the tall stems
        const top = st.points.reduce((a, p) => (p[1] < a[1] ? p : a)), bot = st.points.reduce((a, p) => (p[1] > a[1] ? p : a));
        sx += (top[0] - bot[0]) / (bot[1] - top[1]); sw++;
      }
    }
    const all = bboxP(strokes.slice(w.from, w.to).flatMap((s) => s.points));
    boxes.push(all);
    bases.push(median(bottoms)); centres.push((all[0] + all[2]) / 2);
    if (tops.length) heights.push(median(bottoms) - median(tops));
    if (sw) slants.push(sx / sw);
  }
  // least-squares baseline angle
  const mx = mean(centres), my = mean(bases);
  let num = 0, den = 0;
  centres.forEach((x, i) => { num += (x - mx) * (bases[i] - my); den += (x - mx) ** 2; });
  const slope = num / den;
  const resid = bases.map((y, i) => y - (my + slope * (centres[i] - mx)));
  const gaps = boxes.slice(1).map((b, i) => b[0] - boxes[i][2]);
  return {
    angle: Math.atan(slope) / DEG, wobble: Math.sqrt(mean(resid.map((r) => r * r))), baseY: my,
    heightCV: cv(heights), gapCV: cv(gaps), slantSD: Math.sqrt(mean(slants.map((s) => (s - mean(slants)) ** 2))), bases,
  };
}

const TEXT = 'the cat sat on a mat and then ate lunch';
const PAGE = [0, 0, 800, 1131];
console.log(`Tidy ink — seed ${SEED}`);

// ---- 1. The main case: a sloping, wavy, uneven line on lined paper ---------------------------------
const rows = [];
let capped = 0, coldChanged = 0, coldMove = 0, snapped = 0;
for (let trial = 0; trial < 12; trial++) {
  const rng = mulberry32(SEED + trial * 101);
  const slope = (trial % 2 ? rnd(rng, 2.2, 3.5) : rnd(rng, 0.3, 2)) * (rng() < 0.5 ? -1 : 1);
  const line = messyLine(rng, TEXT, { slope, base: 312 + rnd(rng, -9, 9) });
  // things that must never be touched, mixed into the same call
  const diagram = item(pen(curve((t) => [520 + 70 * Math.cos(t), 620 + 70 * Math.sin(t)], 0, 6.3), rng, { jitter: 2 }));
  const curveSt = item(pen(curve((t) => [150 + 200 * t, 700 + 120 * t * t], 0, 1), rng, { jitter: 2 }));
  const shape = item(densify([[100, 560], [400, 560]], 2), { shape: { kind: 'line' }, uniform: true });
  const label = messyLine(rng, 'de', { x: 600, base: 700, slope: 6, sizes: [1, 1] }).items;           // 2 strokes: a diagram label
  const hl = item(densify([[110, 290], [500, 300]], 4), { tool: 'highlighter', size: 20, color: '#FFE066' });
  const under = messyLine(rng, 'some notes on the old mat', { x: 120, base: 900, slope: 3 }).items;      // sits on an image
  const input = freeze([...line.items, diagram, curveSt, shape, ...label, hl, ...under]);
  const obstacles = [[100, 860, 500, 940]];
  const before = measure(input, line.words);
  const t0 = performance.now();
  const res = tidyStrokes(input, { paper: { style: 'lined' }, mode: 'manual', bounds: PAGE, obstacles });
  const dt = performance.now() - t0;
  const after = measure(res.strokes, line.words);
  const T = `trial ${trial} (slope ${slope.toFixed(1)}°)`;

  ok(res.changed === true, `${T}: changed should be true`);
  ok(res.strokes.length === input.length, `${T}: stroke count changed`);
  let moved = 0, sameIds = 0;
  line.items.forEach((orig, i) => {
    const now = res.strokes[i];
    if (now === orig) return;
    if (now.id === orig.id) sameIds++;
    ok(now.tool === orig.tool && now.color === orig.color && now.size === orig.size && now.type === 'stroke' && now.sim === orig.sim, `${T}: stroke ${i} lost its style`);
    ok(now.points.every((p) => p.length === 3 && p.every(Number.isFinite) && p[2] >= 0 && p[2] <= 1), `${T}: stroke ${i} has bad points`);
    moved = Math.max(moved, maxMove(orig.points, now.points));
    // order preserved: the same letter is still at the same index (its centre is where the original's was, give or take the move limit)
    const a = bboxP(orig.points), b = bboxP(now.points);
    ok(Math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2) <= 25.5, `${T}: stroke ${i} is not where its original was (order broken?)`);
    ok(b[0] >= 0 && b[1] >= 0 && b[2] <= 800 && b[3] <= 1131, `${T}: stroke ${i} left the page`);
  });
  ok(sameIds === 0, `${T}: tidied strokes must get new ids`);
  const tidied = line.items.filter((orig, i) => res.strokes[i] !== orig).length;
  ok(tidied === line.items.length, `${T}: only ${tidied}/${line.items.length} strokes of the line were tidied`);
  for (let i = line.items.length; i < input.length; i++) ok(res.strokes[i] === input[i], `${T}: untouchable stroke ${i} (${input[i].shape ? 'shape' : input[i].tool}) was replaced`);

  ok(Math.abs(after.angle) < 1, `${T}: baseline angle ${after.angle.toFixed(2)}° (was ${before.angle.toFixed(2)}°)`);
  ok(after.heightCV < before.heightCV + 0.02, `${T}: word-height CV ${before.heightCV.toFixed(3)} → ${after.heightCV.toFixed(3)}`);
  ok(after.wobble < before.wobble, `${T}: baseline wobble ${before.wobble.toFixed(2)} → ${after.wobble.toFixed(2)}`);
  ok(after.gapCV < before.gapCV + 0.03, `${T}: gap CV ${before.gapCV.toFixed(3)} → ${after.gapCV.toFixed(3)}`);
  ok(moved <= 25.5, `${T}: a point moved ${moved.toFixed(1)} units (> 25)`);
  // gentle slopes pivot about the left end, which started within 9 units of the rule at y = 312
  { // on a rule, unless the line's pivot was too far from every rule to snap (more than 40% of the spacing)
    const d = Math.abs(after.baseY - (120 + 32 * Math.round((after.baseY - 120) / 32)));
    ok(d < 2.5 || d > 9, `${T}: baseline ${after.baseY.toFixed(1)} is neither on a rule nor left alone`);
    if (d < 2.5) snapped++;
  }

  // idempotent: a second pass over its own output changes nothing
  const again = tidyStrokes(res.strokes, { paper: { style: 'lined' }, mode: 'manual', bounds: PAGE, obstacles });
  ok(again.changed === false, `${T}: second pass reported changed`);
  ok(again.strokes.every((s, i) => s === res.strokes[i]), `${T}: second pass replaced strokes`);
  // "Cold" second pass (as after a reload: same ink, new objects): the hysteresis bands should make this a
  // no-op too. Where the 25-unit limit cut the first pass short it may finish the job, but must settle.
  const cold = tidyStrokes(structuredClone(res.strokes), { paper: { style: 'lined' }, mode: 'manual', bounds: PAGE, obstacles });
  let extra = 0;
  if (cold.changed) {
    coldChanged++; if (moved >= 24.5) capped++;
    line.items.forEach((_, i) => { extra = Math.max(extra, maxMove(res.strokes[i].points, cold.strokes[i].points)); });
    const m3 = measure(cold.strokes, line.words);
    ok(Math.abs(m3.angle) < 1 && m3.wobble < before.wobble, `${T}: a cold second pass made the line worse`);
  }
  coldMove = Math.max(coldMove, extra);
  rows.push({ slope, before, after, moved, dt });
}
console.log('\n  trial  slope   angle° before→after   height CV      gap CV       slant SD     wobble       max move   ms');
rows.forEach((r, i) => console.log(`  ${String(i).padStart(3)}   ${r.slope.toFixed(1).padStart(5)}   ${r.before.angle.toFixed(2).padStart(6)} → ${r.after.angle.toFixed(2).padStart(5)}    ${r.before.heightCV.toFixed(3)}→${r.after.heightCV.toFixed(3)}   ${r.before.gapCV.toFixed(3)}→${r.after.gapCV.toFixed(3)}  ${r.before.slantSD.toFixed(3)}→${r.after.slantSD.toFixed(3)}  ${r.before.wobble.toFixed(2)}→${r.after.wobble.toFixed(2)}   ${r.moved.toFixed(1).padStart(5)}   ${r.dt.toFixed(1)}`));
console.log(`  mean: |angle| ${mean(rows.map((r) => Math.abs(r.before.angle))).toFixed(2)}° → ${mean(rows.map((r) => Math.abs(r.after.angle))).toFixed(2)}°, height CV ${mean(rows.map((r) => r.before.heightCV)).toFixed(3)} → ${mean(rows.map((r) => r.after.heightCV)).toFixed(3)}, gap CV ${mean(rows.map((r) => r.before.gapCV)).toFixed(3)} → ${mean(rows.map((r) => r.after.gapCV)).toFixed(3)}, slant SD ${mean(rows.map((r) => r.before.slantSD)).toFixed(3)} → ${mean(rows.map((r) => r.after.slantSD)).toFixed(3)}, max move ${Math.max(...rows.map((r) => r.moved)).toFixed(1)}`);
ok(mean(rows.map((r) => r.after.heightCV)) < 0.8 * mean(rows.map((r) => r.before.heightCV)), 'word-height CV should drop by at least 20% on average');
ok(mean(rows.map((r) => r.after.gapCV)) < 0.85 * mean(rows.map((r) => r.before.gapCV)), 'word-gap CV should drop by at least 15% on average');
ok(mean(rows.map((r) => r.after.slantSD)) < mean(rows.map((r) => r.before.slantSD)), 'slant spread should shrink on average');
console.log(`  second pass over its own output: unchanged on ${rows.length}/${rows.length} lines`);
console.log(`  cold second pass (cloned output, as after a reload): unchanged on ${rows.length - coldChanged}/${rows.length}; of the rest ${capped} had hit the 25-unit limit; largest extra move ${coldMove.toFixed(1)} units`);
ok(coldMove <= 25.5, `cold second pass moved ink by ${coldMove.toFixed(1)} units`);
console.log(`  baseline snapped onto a rule on ${snapped}/${rows.length} lines`);
ok(snapped >= rows.length * 0.6, 'too few lines were snapped to a rule');

// ---- 2. Other papers, modes and edge cases ----------------------------------------------------------
{
  const rng = mulberry32(SEED + 7);
  const mk = (o) => messyLine(mulberry32(SEED + 7), TEXT, o);
  // blank paper: straightened but not snapped anywhere
  const a = mk({ slope: 2.5, base: 305 });
  const ra = tidyStrokes(a.items, { paper: { style: 'blank' }, mode: 'auto', bounds: PAGE });
  const ma = measure(ra.strokes, a.words), m0 = measure(a.items, a.words);
  ok(ra.changed && Math.abs(ma.angle) < 1, `blank paper: angle ${ma.angle.toFixed(2)}`);
  ok(Math.abs(ma.bases[0] - m0.bases[0]) < 13, `blank paper: the start of the line should stay close (moved ${(ma.bases[0] - m0.bases[0]).toFixed(1)})`);
  // narrow rules
  const n = mk({ slope: -2, base: 340, xh: 10 });
  const rn = tidyStrokes(n.items, { paper: { style: 'narrow' }, mode: 'auto', bounds: PAGE });
  const mn = measure(rn.strokes, n.words);
  ok(Math.abs(((mn.baseY - 96) / 24) - Math.round((mn.baseY - 96) / 24)) * 24 < 2.5, `narrow paper: baseline ${mn.baseY.toFixed(1)} not on a rule`);
  // no opts at all
  ok(tidyStrokes(a.items).changed === true, 'works without options');
  // steep writing: auto leaves it alone, manual turns it by at most 8°
  const steep = mk({ slope: 14, base: 300, wave: 0 });
  const rs = tidyStrokes(steep.items, { mode: 'auto' });
  ok(!rs.changed && rs.strokes.every((s, i) => s === steep.items[i]), 'auto mode must not touch a line written at 14°');
  const rm = tidyStrokes(steep.items, { mode: 'manual' });
  const ms = measure(rm.strokes, steep.words);
  ok(rm.changed && ms.angle > 5 && ms.angle < 14, `manual mode turns a 14° line by at most 8° (now ${ms.angle.toFixed(1)}°)`);
  // too few strokes / a short label
  const few = messyLine(rng, 'an', { slope: 5 }).items.slice(0, 3);
  ok(!tidyStrokes(few, { mode: 'manual' }).changed, 'fewer than 4 strokes is never tidied');
  const lab = messyLine(rng, 'mc', { slope: 6, sizes: [1, 1] });
  ok(lab.items.length < 4 || !tidyStrokes(lab.items, { mode: 'manual' }).changed, 'a 2-letter label is left alone');
  // a label far to the right of a line is its own group and stays where it is
  const main = messyLine(mulberry32(SEED + 3), 'the cat sat on a mat', { slope: 3, base: 300 });
  const mainEnd = Math.max(...main.items.map((s) => bboxP(s.points)[2]));
  const far = messyLine(rng, 'de', { x: mainEnd + 130, base: 318, slope: 0, sizes: [1, 1] }).items;
  const rf = tidyStrokes([...main.items, ...far], { mode: 'manual' });
  ok(far.every((s) => rf.strokes.includes(s)), 'a label beyond 4× the letter height is not pulled into the line');
  // two lines of writing are tidied separately and do not merge
  const l1 = mk({ slope: 1.5, base: 300 }), l2 = messyLine(mulberry32(SEED + 9), 'under the same old moon and stars', { slope: -1.5, base: 368 });
  const r2 = tidyStrokes([...l1.items, ...l2.items], { paper: { style: 'lined' }, mode: 'auto', bounds: PAGE });
  const m1 = measure(r2.strokes.slice(0, l1.items.length), l1.words);
  const m2 = measure(r2.strokes.slice(l1.items.length), l2.words.map((w) => w));
  ok(Math.abs(m1.angle) < 1 && Math.abs(m2.angle) < 1, `two lines: angles ${m1.angle.toFixed(2)}, ${m2.angle.toFixed(2)}`);
  ok(m2.baseY - m1.baseY > 40, `two lines must stay two lines (baselines ${m1.baseY.toFixed(0)}, ${m2.baseY.toFixed(0)})`);
  // page bounds: a line that would be pushed off the page is skipped
  const edge = mk({ slope: 3.4, base: 1120, x: 110 });
  const re = tidyStrokes(edge.items, { paper: { style: 'blank' }, mode: 'manual', bounds: PAGE });
  re.strokes.forEach((s, i) => { if (s === edge.items[i]) return; const b = bboxP(s.points); ok(b[3] <= 1131 && b[1] >= 0 && b[0] >= 0 && b[2] <= 800, 'result outside the page bounds'); });
  const tight = tidyStrokes(a.items, { mode: 'manual', bounds: [0, 0, 800, 306] });
  ok(!tight.changed, 'a group that would leave the bounds is skipped');
  // junk input
  for (const bad of [null, undefined, [], [null], [{}], [{ points: [] }]]) {
    try { const r = tidyStrokes(bad, {}); ok(r.changed === false && Array.isArray(r.strokes), 'junk input'); } catch (e) { fail('threw on junk input: ' + e.message); }
  }
  // 400 strokes stays fast
  const big = [];
  for (let k = 0; k < 9; k++) big.push(...messyLine(mulberry32(SEED + k), TEXT, { slope: 2, base: 152 + k * 64 }).items);
  const t0 = performance.now(); const rb = tidyStrokes(big, { paper: { style: 'lined' }, mode: 'manual', bounds: PAGE }); const dt = performance.now() - t0;
  console.log(`\n  ${big.length} strokes (9 lines) tidied in ${dt.toFixed(1)} ms, changed=${rb.changed}`);
  ok(dt < 250, `too slow: ${dt.toFixed(0)} ms`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\ntidy: all checks passed');
process.exit(failures ? 1 : 0);

// Tidy ink (SPEC v1.1 §B): makes handwriting neater while keeping it the student's own handwriting.
// No recognition: only geometry. Pure maths on plain items, runs in Node for the tests.
//
//   tidyStrokes(strokes, {paper?, mode:'manual'|'auto', bounds?, obstacles?}) → {strokes, changed}
//
// Per line of writing: straighten the baseline (and sit it on the rule of lined paper), bring each word
// back onto the baseline, even out word sizes, slant and spacing, then lightly smooth the ink. Every
// correction is a projection into a tolerance band around the line's own median, so writing that is
// already tidy is left exactly as it is. Each correction has hysteresis (it starts outside an outer
// tolerance and lands inside a tighter one), so a second pass over the output changes nothing.

import { newId } from './constants.js';

const DEG = Math.PI / 180;
const MAX_MOVE = 25;            // no point travels further than this (world units)
const MAX_ROT = 8 * DEG;        // baseline rotation cap
const ROT_DEAD = 0.5 * DEG;     // slopes below this are "straight"
const MOVED = 1.5;              // a group whose points all move less than this is unchanged
const MIN_STROKES = 4;
const WORD_GAP = 0.6;           // × median stroke height → a new word
const LINE_GAP = 4;             // × median stroke height → a separate group (label next to text)
const TALL = 3;                 // × median stroke height → not handwriting (brackets, arrows, diagrams)
// [outer, inner]: a correction is made when the measure is outside `outer`, and lands inside `inner`.
const BASE_BAND = [0.09, 0.03]; // word baseline offset ÷ median stroke height
const SIZE_BAND = [[0.87, 1.15], [0.94, 1.06]];   // word height ÷ line median
const SIZE_RANGE = [0.72, 1.38]; // outside this a word is a heading / sub-script, or its height was
                                // misjudged: leave its size alone. (Scale factors stay within 0.8–1.25.)
const SLANT_BAND = [Math.tan(6 * DEG), Math.tan(2.5 * DEG)];   // difference from the line's median slant
const SLANT_STEP = Math.tan(15 * DEG);   // most a word is sheared; further off than this = left alone
const GAP_BAND = [[0.7, 1.4], [0.82, 1.25]];   // word gap ÷ median gap
const SNAP_MIN = 1;             // baseline closer to its rule than this: already on it   // word gap ÷ median gap after tidying
const RULES = {
  lined: { start: 120, gap: 32 },
  narrow: { start: 96, gap: 24 },
  cornell: { start: 142, gap: 32, minX: 220, maxY: 931 },
};

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const r2 = (n) => Math.round(n * 100) / 100;
function median(list) {
  if (!list.length) return 0;
  const a = list.slice().sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function quantile(list, q) {
  const a = list.slice().sort((x, y) => x - y);
  return a[clamp(Math.round((a.length - 1) * q), 0, a.length - 1)];
}

function box(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}
const hits = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// ---- 1. Lines of writing ---------------------------------------------------------------------------

/**
 * Groups of stroke indices that form one line of writing.
 * Letters are chained to their neighbours when their vertical centres are close (ascenders, descenders
 * and x-height letters of one line all sit within ~¾ of a letter height of each other, while the next
 * rule of writing is further away) and the horizontal gap is at most LINE_GAP letter heights. Dots,
 * crosses and punctuation then join the single nearest letter, so they can never bridge two lines.
 */
function groupLines(cand, boxes, medH) {
  const parent = cand.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const order = cand.map((_, i) => i).sort((a, b) => boxes[cand[a]][0] - boxes[cand[b]][0]);
  const reach = LINE_GAP * medH, near = 0.75 * medH;
  const isSmall = cand.map((ci) => boxes[ci][3] - boxes[ci][1] < 0.4 * medH);
  const cy = cand.map((ci) => (boxes[ci][1] + boxes[ci][3]) / 2);
  for (let a = 0; a < order.length; a++) {
    const i = order[a], A = boxes[cand[i]];
    if (isSmall[i]) continue;
    for (let b = a + 1; b < order.length; b++) {
      const j = order[b], B = boxes[cand[j]];
      if (B[0] - A[2] > reach) break;                    // sorted by left edge: nothing further can be near
      if (!isSmall[j] && Math.abs(cy[i] - cy[j]) <= near) parent[find(i)] = find(j);
    }
  }
  for (let i = 0; i < cand.length; i++) {
    if (!isSmall[i]) continue;
    const S = boxes[cand[i]];
    let best = -1, score = Infinity;
    for (let j = 0; j < cand.length; j++) {
      if (isSmall[j]) continue;
      const T = boxes[cand[j]];
      const gap = Math.max(0, T[0] - S[2], S[0] - T[2]);
      if (gap > 1.5 * medH) continue;
      // Above its letter (i-dot, t-cross) is normal; hanging below a letter is much less likely.
      const dv = cy[i] < T[1] ? T[1] - cy[i] : cy[i] > T[3] ? (cy[i] - T[3]) * 4 : 0;
      if (dv > medH) continue;
      if (gap + dv < score) { score = gap + dv; best = j; }
    }
    if (best >= 0) parent[find(i)] = find(best);
  }
  const groups = new Map();
  cand.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(cand[i]); });
  return [...groups.values()];
}

// ---- 2. Measurements ---------------------------------------------------------------------------------

/** Lower and upper envelope of a set of point lists, one sample per x-bin. */
function envelopes(lists, bw, x0 = 0) {
  const lo = new Map(), hi = new Map();
  for (const pts of lists) {
    for (const p of pts) {
      const k = Math.floor((p[0] - x0) / bw);
      if (!lo.has(k) || p[1] > lo.get(k)) lo.set(k, p[1]);
      if (!hi.has(k) || p[1] < hi.get(k)) hi.set(k, p[1]);
    }
  }
  const bottoms = [], tops = [];
  for (const [k, y] of lo) { bottoms.push([x0 + (k + 0.5) * bw, y]); tops.push([x0 + (k + 0.5) * bw, hi.get(k)]); }
  return { bottoms, tops };
}

/** Theil–Sen slope (median of pairwise slopes): descenders and stray marks do not tilt it. */
function robustSlope(pts, minDx) {
  let list = pts;
  if (list.length > 160) { const k = list.length / 160; list = Array.from({ length: 160 }, (_, i) => pts[Math.floor(i * k)]); }
  const slopes = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const dx = list[j][0] - list[i][0];
      if (Math.abs(dx) >= minDx) slopes.push((list[j][1] - list[i][1]) / dx);
    }
  }
  return slopes.length >= 3 ? median(slopes) : null;
}

/**
 * Slant of a word: x-shear per unit of height, measured on its stems (long near-vertical runs: the
 * backs of h, l, d, t, the legs of n and m). Round letters say little about slant and are ignored.
 * @returns {number|null} null when the word has no stems to measure
 */
function slantOf(lists, step, minRun) {
  let sum = 0, weight = 0;
  for (const pts of lists) {
    // Regression of x on y over pts[i0..i1]: steadier than the slope between the two end points.
    const close = (i0, i1) => {
      const span = Math.abs(pts[i1][1] - pts[i0][1]);
      if (span < minRun || i1 - i0 < 2) return;
      let my = 0, mx = 0;
      for (let i = i0; i <= i1; i++) { mx += pts[i][0]; my += pts[i][1]; }
      mx /= i1 - i0 + 1; my /= i1 - i0 + 1;
      let sxy = 0, syy = 0;
      for (let i = i0; i <= i1; i++) { sxy += (pts[i][0] - mx) * (pts[i][1] - my); syy += (pts[i][1] - my) ** 2; }
      if (syy > 0) { sum += (-sxy / syy) * span * span; weight += span * span; }   // long stems dominate
    };
    let a = 0, start = -1, dir = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[a][0], dy = pts[i][1] - pts[a][1];
      if (Math.hypot(dx, dy) < step && i < pts.length - 1) continue;
      const vertical = Math.abs(dx) <= 0.85 * Math.abs(dy) && dy !== 0;
      const d = Math.sign(dy);
      if (!(vertical && start >= 0 && d === dir)) {
        if (start >= 0) close(start, a);
        start = vertical ? a : -1; dir = d;
      }
      a = i;
    }
    if (start >= 0) close(start, a);
  }
  return weight > 0 ? sum / weight : null;
}

// ---- 3. Smoothing ------------------------------------------------------------------------------------

/** Even out the sampling and take the tremor off, keeping corners, the ends and the pressure profile. */
function smoothPoints(pts) {
  const n = pts.length;
  if (n < 5) return pts.map((p) => [r2(p[0]), r2(p[1]), r2(p[2] ?? 0.5)]);
  let L = 0;
  const acc = [0];
  for (let i = 1; i < n; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); acc.push(L); }
  if (L < 4) return pts.map((p) => [r2(p[0]), r2(p[1]), r2(p[2] ?? 0.5)]);
  const spacing = clamp(L / (n - 1), 0.8, 2);
  const m = Math.max(4, Math.round(L / spacing));
  const rs = [];
  let j = 1;
  for (let i = 0; i <= m; i++) {
    const t = (L * i) / m;
    while (j < n - 1 && acc[j] < t) j++;
    const seg = acc[j] - acc[j - 1], f = seg > 0 ? clamp((t - acc[j - 1]) / seg, 0, 1) : 0;
    const a = pts[j - 1], b = pts[j];
    rs.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, (a[2] ?? 0.5) + ((b[2] ?? 0.5) - (a[2] ?? 0.5)) * f]);
  }
  const out = [];
  const w = Math.max(1, Math.round(2.5 / (L / m)));      // corner test looks ~2.5 units either side
  for (let i = 0; i <= m; i++) {
    const p = rs[i];
    if (i === 0 || i === m) { out.push([r2(p[0]), r2(p[1]), r2(p[2])]); continue; }
    const a = rs[i - 1], b = rs[i + 1];
    const pa = rs[Math.max(0, i - w)], pb = rs[Math.min(m, i + w)];
    const ux = p[0] - pa[0], uy = p[1] - pa[1], vx = pb[0] - p[0], vy = pb[1] - p[1];
    const dot = ux * vx + uy * vy, mag = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const corner = mag > 0 && dot / mag < 0.64;          // turns more than ~50°: keep the corner sharp
    const pr = 0.25 * a[2] + 0.5 * p[2] + 0.25 * b[2];
    if (corner) out.push([r2(p[0]), r2(p[1]), r2(pr)]);
    else out.push([r2(0.25 * a[0] + 0.5 * p[0] + 0.25 * b[0]), r2(0.25 * a[1] + 0.5 * p[1] + 0.25 * b[1]), r2(pr)]);
  }
  return out;
}

// ---- 4. One line of writing ----------------------------------------------------------------------------

/**
 * @returns {null | {points:number[][][], moved:number, angle:number}} new point lists (same order as `lists`)
 */
function tidyLine(lists, medH, opts) {
  const n = lists.length;
  const bw = Math.max(4, medH * 0.8);
  const boxes0 = lists.map(box);
  const isBody = boxes0.map((b) => b[3] - b[1] >= 0.4 * medH);
  const bodyLists = lists.filter((_, i) => isBody[i]);
  if (bodyLists.length < 3) return null;
  let x0 = Infinity, x1 = -Infinity;
  for (const b of boxes0) { if (b[0] < x0) x0 = b[0]; if (b[2] > x1) x1 = b[2]; }
  const W = x1 - x0;

  // -- baseline: robust fit through the lower envelope, then rotate the line to horizontal
  const env = envelopes(bodyLists, bw);
  if (env.bottoms.length < 4) return null;
  const slope = robustSlope(env.bottoms, bw * 1.5);
  if (slope === null) return null;
  const theta = Math.atan(slope);
  if (opts.mode === 'auto' && Math.abs(theta) > MAX_ROT) return null;      // written at an angle on purpose
  const rot = Math.abs(theta) < ROT_DEAD ? 0 : -clamp(theta, -MAX_ROT, MAX_ROT);
  const icpt = median(env.bottoms.map((p) => p[1] - slope * p[0]));
  // Sanity: the bottoms of one line of writing hug its baseline. A wide spread means this is not a
  // single line (two lines run together, a list, a doodle): leave it alone.
  if (quantile(env.bottoms.map((p) => Math.abs(p[1] - slope * p[0] - icpt)), 0.8) > 0.6 * medH) return null;
  // Pivot: the left end of the line, moved towards the middle only as far as needed to respect MAX_MOVE.
  const swing = W * Math.abs(Math.tan(rot));
  const pf = swing > MAX_MOVE * 0.45 ? clamp(1 - (MAX_MOVE * 0.45) / swing, 0, 0.5) : 0;
  const px = x0 + W * pf, py = slope * px + icpt;
  const c = Math.cos(rot), s = Math.sin(rot);
  let cur = lists.map((pts) => pts.map((p) => {
    const dx = p[0] - px, dy = p[1] - py;
    return [px + dx * c - dy * s, py + dx * s + dy * c, p[2] ?? 0.5];
  }));

  // -- words
  const boxes = cur.map(box);
  const order = cur.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
  const words = [];
  let right = -Infinity;
  for (const i of order) {
    if (!words.length || boxes[i][0] - right > WORD_GAP * medH) words.push({ idx: [] });
    words[words.length - 1].idx.push(i);
    right = Math.max(right, boxes[i][2]);
  }
  for (const w of words) {
    const body = w.idx.filter((i) => isBody[i]).map((i) => cur[i]);
    w.box = box(w.idx.flatMap((i) => cur[i]));
    w.major = false;
    if (!body.length) continue;
    // Measurements are taken per letter stroke where there are several (they do not change when the word
    // is moved, scaled or sheared about its baseline, which keeps a second tidy pass a no-op).
    const bxs = body.map(box);
    if (body.length >= 2) {
      w.base = quantile(bxs.map((b) => b[3]), 0.4);        // descenders are the minority below
      // x-height: the shortest letters of the word (ascenders stand above them).
      const hs = bxs.map((b) => w.base - b[1]).filter((h) => h > 0.3 * medH).sort((a, b) => a - b);
      const low = hs.filter((h) => h <= hs[0] * 1.25);
      w.top = hs.length ? w.base - low.reduce((a, h) => a + h, 0) / low.length : w.base;
    } else {
      // One stroke for the whole word (joined-up writing): use its lower / upper envelope.
      const bb = bxs[0], hb = Math.max(2, bb[3] - bb[1]);
      w.base = quantile(envelopes(body, Math.max(3, hb * 0.45), bb[0]).bottoms.map((p) => p[1]), 0.4);
      w.top = quantile(envelopes(body, Math.max(1.5, hb * 0.2), bb[0]).tops.map((p) => p[1]), 0.7);
    }
    w.height = w.base - w.top;
    w.major = w.height >= 0.35 * medH;
    if (w.major) w.slant = slantOf(body, Math.max(1.2, medH * 0.12), w.height * 0.8);
  }
  const major = words.filter((w) => w.major);
  if (major.length < 1) return null;
  const lineBase = median(major.map((w) => w.base));
  const lineHeight = median(major.map((w) => w.height));
  const slants = major.filter((w) => w.slant !== null && w.slant !== undefined).map((w) => w.slant);
  const lineSlant = slants.length >= 2 ? median(slants) : null;

  // -- sit the baseline on the nearest rule of lined paper
  let snap = 0;
  const rule = RULES[opts.paper && opts.paper.style];
  if (rule && !(rule.minX && x0 < rule.minX - 4) && !(rule.maxY && lineBase > rule.maxY + 4)) {
    const k = Math.round((lineBase - rule.start) / rule.gap);
    const y = rule.start + Math.max(0, k) * rule.gap;
    if (Math.abs(y - lineBase) <= 0.4 * rule.gap && !(rule.maxY && y > rule.maxY)) snap = y - lineBase;
    if (Math.abs(snap) < SNAP_MIN) snap = 0;
  }

  // Word gaps as written (before any word is resized), so resizing a word never changes its spacing.
  const gaps = [];
  for (let i = 1; i < words.length; i++) gaps.push(words[i].box[0] - words[i - 1].box[2]);

  // -- per word: back onto the baseline, towards the median size, towards the median slant
  const baseOut = Math.max(1.2, BASE_BAND[0] * medH), baseIn = BASE_BAND[1] * medH;
  for (const w of words) {
    w.dy = snap; w.scale = 1; w.shear = 0;
    if (!w.major) {
      // Punctuation / a dash on its own follows the line, nothing else.
      continue;
    }
    const off = w.base - lineBase;
    if (Math.abs(off) > baseOut && Math.abs(off) <= 0.5 * medH) w.dy += clamp(off, -baseIn, baseIn) - off;   // further away = super/subscript: leave it
    const ratio = w.height / lineHeight;
    if (ratio >= SIZE_RANGE[0] && ratio <= SIZE_RANGE[1] && (ratio < SIZE_BAND[0][0] || ratio > SIZE_BAND[0][1])) w.scale = clamp(ratio, SIZE_BAND[1][0], SIZE_BAND[1][1]) / ratio;
    if (lineSlant !== null && w.slant !== null && w.slant !== undefined) {
      const off2 = w.slant - lineSlant;
      const sh = clamp(off2, -SLANT_BAND[1], SLANT_BAND[1]) - off2;
      if (Math.abs(off2) > SLANT_BAND[0] && Math.abs(sh) <= SLANT_STEP) w.shear = sh;
    }
    if (w.scale !== 1 || w.shear !== 0) {
      const ox = w.box[0], oy = w.base;
      for (const i of w.idx) {
        cur[i] = cur[i].map((p) => {
          const y = oy + (p[1] - oy) * w.scale;
          const x = ox + (p[0] - ox) * w.scale + w.shear * (oy - y);
          return [x, y, p[2]];
        });
      }
      w.box = box(w.idx.flatMap((i) => cur[i]));
    }
  }

  // -- even word spacing (the left edge of the line stays where it is)
  {
    const med = median(gaps);
    const even = words.length >= 3 && med > 0;
    words[0].dx = 0;
    for (let i = 1; i < words.length; i++) {
      let g = gaps[i - 1];
      if (even && g > 0 && (g < GAP_BAND[0][0] * med || g > GAP_BAND[0][1] * med)) g = clamp(g, GAP_BAND[1][0] * med, GAP_BAND[1][1] * med);
      words[i].dx = words[i - 1].box[2] + words[i - 1].dx + g - words[i].box[0];
    }
  }
  // Essential part of the correction (straight baseline, on the rule) vs the cosmetic part (word size,
  // slant, spacing). They are kept apart so the move limit can trim the cosmetic part first.
  const ess = lists.map(() => null);
  for (const w of words) {
    for (const i of w.idx) {
      ess[i] = lists[i].map((p) => {
        const dx = p[0] - px, dy = p[1] - py;
        return [px + dx * c - dy * s, py + dx * s + dy * c + w.dy];
      });
      if (w.dx || w.dy) cur[i] = cur[i].map((p) => [p[0] + w.dx, p[1] + w.dy, p[2]]);
    }
  }

  // -- limits: nothing moves further than MAX_MOVE (the correction is scaled down, never clipped)
  const LIMIT = MAX_MOVE - 0.6;                                             // leaves room for the smoothing
  const reachOf = (f, g) => {
    let m = 0;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < lists[i].length; k++) {
        const o = lists[i][k], e = ess[i][k], q = cur[i][k];
        const x = (e[0] - o[0]) * g + (q[0] - e[0]) * f, y = (e[1] - o[1]) * g + (q[1] - e[1]) * f;
        const d = x * x + y * y;
        if (d > m) m = d;
      }
    }
    return Math.sqrt(m);
  };
  let moved = reachOf(1, 1);
  if (moved <= MOVED && Math.abs(theta) <= ROT_DEAD) return null;           // already neat
  if (moved > LIMIT) {
    let f = 0, g = 1;
    const base = reachOf(0, 1);
    if (base > LIMIT) g = LIMIT / base;
    else {
      let lo = 0, hi = 1;
      for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (reachOf(mid, 1) <= LIMIT) lo = mid; else hi = mid; }
      f = lo;
    }
    cur = cur.map((pts, i) => pts.map((q, k) => {
      const o = lists[i][k], e = ess[i][k];
      return [o[0] + (e[0] - o[0]) * g + (q[0] - e[0]) * f, o[1] + (e[1] - o[1]) * g + (q[1] - e[1]) * f, q[2]];
    }));
    moved = reachOf(f, g);
  }
  if (opts.bounds) {
    const B = opts.bounds;
    for (const pts of cur) for (const p of pts) if (p[0] < B[0] || p[1] < B[1] || p[0] > B[2] || p[1] > B[3]) return null;
  }
  return { points: cur.map(smoothPoints), moved, angle: theta };
}

// ---- Public --------------------------------------------------------------------------------------------

// Strokes this module has already tidied (by object identity; items are immutable in the engine).
// They are never tidied twice, so "Tidy" on its own output is exactly a no-op whatever the rounding.
const tidied = new WeakSet();

/**
 * @param {object[]} strokes  pen stroke items ({points, tool, shape?, uniform?, …}); never mutated
 * @param {{paper?:{style:string}, mode?:'manual'|'auto', bounds?:number[], obstacles?:number[][]}} opts
 * @returns {{strokes:object[], changed:boolean}} same length and order as the input. Tidied strokes are
 *   new items with new ids (bbox is left for the engine's finalizeItem); the rest are the same objects.
 *   Note: the engine's finalizeItem copies the item, so it must call `markTidied` on the copy.
 */
export function tidyStrokes(strokes, opts = {}) {
  const out = Array.isArray(strokes) ? strokes.slice() : [];
  const o = { mode: opts.mode === 'auto' ? 'auto' : 'manual', paper: opts.paper, bounds: opts.bounds };
  const obstacles = Array.isArray(opts.obstacles) ? opts.obstacles : [];
  const boxes = out.map((st) => (st && Array.isArray(st.points) && st.points.length ? box(st.points) : null));
  let cand = [];
  out.forEach((st, i) => {
    if (!boxes[i] || (st.type && st.type !== 'stroke') || st.tool === 'highlighter' || st.shape || st.uniform || tidied.has(st)) return;
    if (!boxes[i].every(Number.isFinite)) return;
    if (obstacles.some((b) => hits(boxes[i], b))) return;
    cand.push(i);
  });
  if (cand.length < MIN_STROKES) return { strokes: out, changed: false };
  const hOf = (i) => Math.max(1, boxes[i][3] - boxes[i][1]);
  const allH = Math.max(4, median(cand.map(hOf)));
  cand = cand.filter((i) => hOf(i) <= TALL * allH && boxes[i][2] - boxes[i][0] <= 60 * allH);
  if (cand.length < MIN_STROKES) return { strokes: out, changed: false };

  let changed = false;
  for (const g of groupLines(cand, boxes, allH)) {
    if (g.length < MIN_STROKES) continue;
    const medH = Math.max(4, median(g.map(hOf)));
    let gx0 = Infinity, gx1 = -Infinity;
    for (const i of g) { gx0 = Math.min(gx0, boxes[i][0]); gx1 = Math.max(gx1, boxes[i][2]); }
    if (gx1 - gx0 < 4 * medH) continue;                  // a label, not a line of writing
    const res = tidyLine(g.map((i) => out[i].points), medH, o);
    if (!res) continue;
    g.forEach((i, k) => {
      const next = { ...out[i], id: newId(), points: res.points[k] };
      delete next.bbox;
      tidied.add(next);
      out[i] = next;
    });
    changed = true;
  }
  return { strokes: out, changed };
}

/** Tell the module that `item` is (a copy of) one of its results, so it is not tidied a second time. */
export function markTidied(item) { if (item && typeof item === 'object') tidied.add(item); }

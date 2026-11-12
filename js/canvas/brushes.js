// Brush library (v1.2): the table of pens, pencils and highlighters, and the procedural grain textures.
//
// A stroke item carries an optional `brush` id. Strokes saved before v1.2 have none and are drawn with the
// LEGACY_* entries, which reproduce the v1.1 look exactly.
//
// Every brush is still ONE vector outline per stroke (perfect-freehand polygon, or a centre line / swept
// nib for highlighters). What differs is the outline's parameters, the opacity, and what the outline is
// filled with: a flat colour, or a tiling "grain" texture tinted in the stroke colour. The grain is a
// periodic noise function of WORLD coordinates, sampled into a small tile at roughly the current device
// resolution, so it stays put on the page when you pan or redraw, grows with the ink when you zoom, and
// costs one pattern fill per stroke.
//
// The table and the maths are pure (Node-testable); only grainStyle() touches the DOM.

import { HIGHLIGHT_ALPHA } from './constants.js';

/**
 * kind       'pen' | 'highlighter'  (which tool the brush belongs to; highlighters render beneath ink)
 * size       default width (world units); min/max = slider range; sizes = the three quick sizes
 * thinning   how much pressure (or, for fingers, speed) changes the width: 0 = constant
 * streamline input smoothing for Pencil; simStreamline for finger/mouse (their samples jitter less, and
 *            heavy smoothing is what makes ink feel as if it trails the finger)
 * taper      [start, end] taper lengths as multiples of the size
 * alpha      opacity of the whole stroke (applied once per stroke: no darker patches where it crosses itself)
 * pressureAlpha  lowest opacity factor for the lightest Pencil pressure (pressure → darkness)
 * grain      id of a GRAINS texture, or null for flat ink
 * tip        highlighters: 'round' (centre line with round caps) | 'chisel' (flat angled nib)
 * tint       mix the colour this far towards white before drawing (pastel)
 */
export const BRUSHES = [
  { id: 'pen', kind: 'pen', label: 'Pen', size: 3, min: 1, max: 12, sizes: [1.5, 3, 6],
    thinning: 0.6, smoothing: 0.5, streamline: 0.45, simStreamline: 0.32, alpha: 1, grain: null },
  { id: 'fineliner', kind: 'pen', label: 'Fineliner', size: 1.6, min: 0.6, max: 5, sizes: [1, 1.6, 2.6],
    thinning: 0, smoothing: 0.5, streamline: 0.4, simStreamline: 0.3, alpha: 1, grain: null },
  { id: 'ballpoint', kind: 'pen', label: 'Ballpoint', size: 2, min: 0.8, max: 6, sizes: [1.4, 2, 3],
    thinning: 0.28, smoothing: 0.5, streamline: 0.42, simStreamline: 0.3, alpha: 0.92, grain: 'ball' },
  { id: 'fountain', kind: 'pen', label: 'Fountain', size: 3.6, min: 1.5, max: 12, sizes: [2.4, 3.6, 5.5],
    thinning: 0.86, smoothing: 0.62, streamline: 0.5, simStreamline: 0.36, taper: [0.6, 1.2], alpha: 1, grain: null },
  { id: 'brush', kind: 'pen', label: 'Brush pen', size: 9, min: 3, max: 30, sizes: [6, 9, 15],
    thinning: 0.92, smoothing: 0.6, streamline: 0.5, simStreamline: 0.38, taper: [1.4, 4], alpha: 1, grain: null },
  { id: 'marker', kind: 'pen', label: 'Marker', size: 7, min: 2, max: 30, sizes: [4, 7, 12],
    thinning: 0, smoothing: 0.5, streamline: 0.42, simStreamline: 0.32, alpha: 0.8, grain: null },
  { id: 'pencil', kind: 'pen', label: 'Pencil HB', size: 2.6, min: 1, max: 12, sizes: [1.8, 2.6, 4.5],
    thinning: 0.5, smoothing: 0.45, streamline: 0.38, simStreamline: 0.28, alpha: 0.9, pressureAlpha: 0.5, grain: 'graphite' },
  { id: 'mechanical', kind: 'pen', label: 'Mechanical', size: 1.3, min: 0.6, max: 4, sizes: [0.9, 1.3, 2],
    thinning: 0.18, smoothing: 0.45, streamline: 0.36, simStreamline: 0.28, alpha: 0.86, pressureAlpha: 0.65, grain: 'fine' },
  { id: 'charcoal', kind: 'pen', label: 'Charcoal', size: 12, min: 4, max: 40, sizes: [8, 12, 20],
    thinning: 0.4, smoothing: 0.5, streamline: 0.42, simStreamline: 0.32, alpha: 0.92, pressureAlpha: 0.55, grain: 'charcoal' },

  { id: 'chisel', kind: 'highlighter', label: 'Chisel', size: 22, min: 8, max: 60, sizes: [14, 22, 34],
    tip: 'chisel', alpha: HIGHLIGHT_ALPHA, grain: null },
  { id: 'round', kind: 'highlighter', label: 'Round', size: 20, min: 6, max: 60, sizes: [12, 20, 32],
    tip: 'round', alpha: HIGHLIGHT_ALPHA, grain: null },
  { id: 'pastel', kind: 'highlighter', label: 'Pastel', size: 30, min: 10, max: 70, sizes: [20, 30, 44],
    tip: 'round', alpha: 0.5, tint: 0.45, grain: null, color: '#FFC9DE' },
];

const BY_ID = new Map(BRUSHES.map((b) => [b.id, b]));

// Strokes without a `brush` (everything saved before v1.2): identical to the v1.1 renderer.
export const LEGACY_PEN = { ...BY_ID.get('pen'), id: '', simStreamline: 0.45 };
export const LEGACY_HIGHLIGHTER = { ...BY_ID.get('round'), id: '' };

export const DEFAULT_BRUSH = { pen: 'pen', highlighter: 'round' };

/** The brush called `id`, when it exists and belongs to `tool`; otherwise null. */
export function getBrush(id, tool) {
  const b = typeof id === 'string' ? BY_ID.get(id) : null;
  return b && (!tool || b.kind === (tool === 'highlighter' ? 'highlighter' : 'pen')) ? b : null;
}

/** Rendering parameters for a stroke item (never null). */
export function brushOf(item) {
  const hl = item.tool === 'highlighter';
  return getBrush(item.brush, hl ? 'highlighter' : 'pen') || (hl ? LEGACY_HIGHLIGHTER : LEGACY_PEN);
}

/** What the app needs to build its brush picker. */
export function listBrushes() {
  return BRUSHES.map((b) => ({ id: b.id, label: b.label, kind: b.kind, size: b.size, min: b.min, max: b.max, sizes: b.sizes.slice(), color: b.color || null }));
}

/** perfect-freehand options for a pen-kind brush. */
export function freehandOptions(brush, size, sim, last) {
  const o = {
    size, thinning: brush.thinning, smoothing: brush.smoothing,
    streamline: sim ? brush.simStreamline : brush.streamline,
    simulatePressure: !!sim, last: !!last,
  };
  if (brush.taper) {
    o.start = { taper: size * brush.taper[0], cap: true };
    o.end = { taper: size * brush.taper[1], cap: true };
  }
  return o;
}

/** Furthest the ink reaches from the centre line, as a multiple of the size (for bounding boxes). */
export function brushReach(brush) {
  if (brush.kind === 'highlighter') return brush.tip === 'chisel' ? 0.56 : 0.5;
  return Math.max(0.85, 0.5 + 0.5 * (brush.thinning || 0));
}

/** Opacity of one stroke: the brush's own, darker with firmer Pencil pressure where the brush says so. */
export function strokeOpacity(brush, meanPressure, sim) {
  let a = brush.alpha ?? 1;
  if (brush.pressureAlpha && !sim) {
    const p = Math.min(1, Math.max(0, meanPressure));
    a *= brush.pressureAlpha + (1 - brush.pressureAlpha) * Math.min(1, p * 1.25);
  }
  return Math.round(a * 1000) / 1000;
}

const tints = new Map();
/** '#rrggbb' mixed `amount` of the way to white (pastel highlighter). Other colour strings pass through. */
export function tintColor(color, amount) {
  if (!amount) return color;
  const key = color + amount;
  let out = tints.get(key);
  if (out) return out;
  const m = /^#([0-9a-f]{6})$/i.exec(String(color));
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const mix = (v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0');
  out = '#' + mix(n >> 16) + mix((n >> 8) & 255) + mix(n & 255);
  if (tints.size > 200) tints.clear();
  tints.set(key, out);
  return out;
}

// ---- Grain ------------------------------------------------------------------------------------------
// alpha(x, y) = floor + (1 − floor) × smoothstep(lo, hi, noise), where noise mixes a fine and a coarse
// octave of periodic value noise. `period` is the tile size in world units; `cells` are lattice cells per
// world unit for the two octaves (period × cells must be whole numbers so the tile repeats seamlessly).

export const GRAINS = {
  ball: { period: 16, cells: [3, 0.5], mix: 0.7, lo: 0.2, hi: 0.5, floor: 0.6, seed: 11 },
  graphite: { period: 16, cells: [2.5, 0.5], mix: 0.72, lo: 0.24, hi: 0.6, floor: 0.2, seed: 23 },
  fine: { period: 16, cells: [3.5, 0.75], mix: 0.78, lo: 0.26, hi: 0.6, floor: 0.3, seed: 37 },
  charcoal: { period: 32, cells: [2, 0.25], mix: 0.7, lo: 0.3, hi: 0.6, floor: 0.1, seed: 53 },
};

function lattice(n, seed) {
  const a = new Float32Array(n * n);
  let s = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < a.length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;   // xorshift32
    a[i] = s / 4294967296;
  }
  return a;
}

const lattices = new Map();
function latticeFor(g, octave) {
  const key = g.seed * 10 + octave;
  let l = lattices.get(key);
  if (!l) {
    const n = Math.round(g.period * g.cells[octave]);
    l = { n, a: lattice(n, g.seed + octave * 101) };
    lattices.set(key, l);
  }
  return l;
}

function valueNoise(l, x, y) {
  const n = l.n, a = l.a;
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % n) + n) % n, y0 = ((yi % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const top = a[y0 * n + x0] + (a[y0 * n + x1] - a[y0 * n + x0]) * fx;
  const bot = a[y1 * n + x0] + (a[y1 * n + x1] - a[y1 * n + x0]) * fx;
  return top + (bot - top) * fy;
}

/** Grain opacity (0..1) at a world position. Periodic in both axes with the grain's period. */
export function grainAlpha(g, x, y) {
  const fine = valueNoise(latticeFor(g, 0), x * g.cells[0], y * g.cells[0]);
  const coarse = valueNoise(latticeFor(g, 1), x * g.cells[1], y * g.cells[1]);
  const n = g.mix * fine + (1 - g.mix) * coarse;
  let t = (n - g.lo) / (g.hi - g.lo);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return g.floor + (1 - g.floor) * t * t * (3 - 2 * t);
}

/** Tile resolution (px per side) for a device scale of `k` px per world unit: about one texel per pixel. */
export function grainResolution(g, k) {
  let res = 32;
  while (res < g.period * k && res < g.period * 16) res *= 2;   // ≤ 16 texels per world unit (256 or 512 px tiles)
  return res;
}

const masks = new Map();       // `${grain}|${res}` → canvas (white, alpha = grain)
const styles = new Map();      // `${grain}|${res}|${color}` → {pattern, canvas}  (insertion order = LRU)
const MAX_STYLES = 40;

function maskFor(id, g, res) {
  const key = id + '|' + res;
  let cv = masks.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = cv.height = res;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(res, res);
  const d = img.data, step = g.period / res;
  for (let y = 0, i = 0; y < res; y++) {
    for (let x = 0; x < res; x++, i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(255 * grainAlpha(g, (x + 0.5) * step, (y + 0.5) * step));
    }
  }
  ctx.putImageData(img, 0, 0);
  masks.set(key, cv);
  return cv;
}

/**
 * Fill style for a grainy brush: a repeating pattern in `color`, anchored to world coordinates (use it
 * with the context in world space). `k` = device px per world unit. Falls back to the flat colour when
 * patterns are unavailable.
 */
export function grainStyle(id, color, k) {
  const g = GRAINS[id];
  if (!g || typeof document === 'undefined') return color;
  const res = grainResolution(g, k > 0 ? k : 1);
  const key = id + '|' + res + '|' + color;
  let s = styles.get(key);
  if (s) {
    styles.delete(key); styles.set(key, s);     // most recently used last
    return s.pattern;
  }
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = res;
    const ctx = cv.getContext('2d');
    ctx.drawImage(maskFor(id, g, res), 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, res, res);
    const pattern = ctx.createPattern(cv, 'repeat');
    if (!pattern || !pattern.setTransform || typeof DOMMatrix === 'undefined') { cv.width = cv.height = 0; return color; }
    const f = g.period / res;
    pattern.setTransform(new DOMMatrix([f, 0, 0, f, 0, 0]));
    s = { pattern, canvas: cv };
  } catch { return color; }
  styles.set(key, s);
  if (styles.size > MAX_STYLES) {
    const oldest = styles.keys().next().value;
    const old = styles.get(oldest);
    styles.delete(oldest);
    old.canvas.width = old.canvas.height = 0;   // Safari holds canvas memory until GC otherwise
  }
  return s.pattern;
}

// Item helpers: validation/normalisation on load, bbox, transforms and point hit-testing.
// Items are immutable — every helper returns new objects.

import { MIN_FONT_SIZE, TEXT_DEFAULT_W, newId } from './constants.js';
import { round2, bboxContains } from './geom.js';
import { strokeBBox, distToStroke } from './strokes.js';
import { layoutText } from './text.js';
import { SHAPE_KINDS } from './shapes.js';
import { getBrush } from './brushes.js';

const fin = Number.isFinite;

/** Recompute the engine-owned fields (bbox, text h). Returns a new item. */
export function finalizeItem(item) {
  if (item.type === 'stroke') return { ...item, bbox: strokeBBox(item) };
  if (item.type === 'text') {
    const base = { ...item };
    delete base.bbox; delete base.h;
    const h = round2(layoutText(base).h);
    return { ...base, h, bbox: [base.x, base.y, round2(base.x + base.w), round2(base.y + h)] };
  }
  return { ...item, bbox: [item.x, item.y, round2(item.x + item.w), round2(item.y + item.h)] };
}

/**
 * Validate and normalise stored items: drops malformed entries, never trusts stored bbox/h.
 * The input must already be a private copy (the engine clones the caller's page first).
 */
export function normalizeItems(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    let item = null;
    if (it.type === 'stroke') {
      const points = Array.isArray(it.points)
        ? it.points.filter((p) => Array.isArray(p) && fin(p[0]) && fin(p[1])).map((p) => [p[0], p[1], fin(p[2]) ? p[2] : 0.5])
        : [];
      if (!points.length) continue;
      item = {
        id: it.id, type: 'stroke', tool: it.tool === 'highlighter' ? 'highlighter' : 'pen',
        color: typeof it.color === 'string' ? it.color : '#1C1C1E',
        size: fin(it.size) && it.size > 0 ? it.size : 3, points,
      };
      if (it.sim) item.sim = true;
      if (getBrush(it.brush, item.tool)) item.brush = it.brush;   // v1.2; unknown ids fall back to the default look
      // Recognised shapes (v1.1): keep the crisp rendering flag and the kind, nothing else.
      if (item.tool === 'pen' && it.uniform === true) item.uniform = true;
      if (item.tool === 'pen' && it.shape && SHAPE_KINDS.includes(it.shape.kind)) item.shape = { kind: it.shape.kind };
    } else if (it.type === 'text') {
      if (!fin(it.x) || !fin(it.y)) continue;
      item = {
        id: it.id, type: 'text', x: it.x, y: it.y, w: fin(it.w) && it.w > 0 ? it.w : TEXT_DEFAULT_W,
        text: String(it.text ?? ''), color: typeof it.color === 'string' ? it.color : '#1C1C1E',
        fontSize: Math.max(MIN_FONT_SIZE, fin(it.fontSize) ? it.fontSize : 20),
        font: typeof it.font === 'string' ? it.font : 'sans',
      };
    } else if (it.type === 'image') {
      if (![it.x, it.y, it.w, it.h].every(fin) || typeof it.src !== 'string' || it.w <= 0 || it.h <= 0) continue;
      item = { id: it.id, type: 'image', x: it.x, y: it.y, w: it.w, h: it.h, src: it.src };
    } else continue;
    if (typeof item.id !== 'string' || !item.id || seen.has(item.id)) item.id = newId();
    seen.add(item.id);
    out.push(finalizeItem(item));
  }
  return out;
}

/**
 * Uniform scale `s` about (ox, oy) followed by a translation (dx, dy).
 * Pass `id` to mint a copy. Text never goes below the 16px floor.
 */
export function transformItem(item, s, ox, oy, dx, dy, id = item.id) {
  const tx = (x) => round2(ox + (x - ox) * s + dx), ty = (y) => round2(oy + (y - oy) * s + dy);
  if (item.type === 'stroke') {
    return finalizeItem({
      ...item, id,
      size: s === 1 ? item.size : Math.max(0.2, round2(item.size * s)),
      points: item.points.map((p) => [tx(p[0]), ty(p[1]), p[2]]),
    });
  }
  if (item.type === 'text') {
    return finalizeItem({
      ...item, id, x: tx(item.x), y: ty(item.y),
      w: s === 1 ? item.w : Math.max(40, round2(item.w * s)),
      fontSize: s === 1 ? item.fontSize : Math.max(MIN_FONT_SIZE, round2(item.fontSize * s)),
    });
  }
  return finalizeItem({ ...item, id, x: tx(item.x), y: ty(item.y), w: Math.max(2, round2(item.w * s)), h: Math.max(2, round2(item.h * s)) });
}

/** Topmost item under a world point (text → pen → highlighter → image), or null. `slop` in world units. */
export function hitTestItems(items, x, y, slop, types = ['text', 'pen', 'highlighter', 'image']) {
  for (const kind of types) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (kind === 'text' || kind === 'image') {
        if (it.type === kind && bboxContains(it.bbox, x, y, kind === 'text' ? slop / 2 : 0)) return it;
      } else if (it.type === 'stroke' && it.tool === kind && bboxContains(it.bbox, x, y, slop)) {
        if (distToStroke(it, x, y) <= slop + it.size / 2) return it;
      }
    }
  }
  return null;
}

// Scene rendering shared by the live view and the pure export helpers (thumbnails, PNG, PDF).

import { PAGE_W, PAGE_H, HIGHLIGHT_ALPHA } from './constants.js';
import { bboxIntersects, bboxOfItems } from './geom.js';
import { drawStroke } from './strokes.js';
import { drawText } from './text.js';
import { decodeImage } from './images.js';
import { normalizeItems } from './items.js';
import { paperFill, isDarkPaper, displayColor, drawPaperRules, drawBoardBackground } from './paper.js';

/**
 * Draw items in world coordinates (the ctx transform must already map world → device).
 * Pass order: images → highlighters → pens → text; array order is the z-order within a pass.
 * @param {object} o {zoom, dark, visible?:bbox, skip?:Set<id>, getImage(item) → drawable|null}
 */
export function drawItems(ctx, items, o) {
  const images = [], highlights = [], pens = [], texts = [];
  for (const it of items) {
    if (o.skip && o.skip.has(it.id)) continue;
    if (o.visible && !bboxIntersects(it.bbox, o.visible)) continue;
    if (it.type === 'image') images.push(it);
    else if (it.type === 'text') texts.push(it);
    else if (it.tool === 'highlighter') highlights.push(it);
    else pens.push(it);
  }
  for (const it of images) {
    const img = o.getImage ? o.getImage(it) : null;
    if (img) {
      try { ctx.drawImage(img, it.x, it.y, it.w, it.h); } catch { /* broken image */ }
    } else {
      ctx.fillStyle = o.dark ? 'rgba(255,255,255,0.08)' : 'rgba(120,120,128,0.14)';
      ctx.fillRect(it.x, it.y, it.w, it.h);
    }
  }
  if (highlights.length) {
    ctx.save();
    ctx.globalAlpha = HIGHLIGHT_ALPHA;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const it of highlights) drawStroke(ctx, it, o.zoom, it.color);
    ctx.restore();
  }
  ctx.lineJoin = 'round';
  for (const it of pens) drawStroke(ctx, it, o.zoom, displayColor(it.color, o.dark));
  for (const it of texts) drawText(ctx, it, displayColor(it.color, o.dark));
}

// ---- Pure render helpers ----------------------------------------------------------------------

const MAX_SIDE = 4096, MAX_PIXELS = 16e6;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Limit an output scale so the canvas stays within Safari's limits. */
function safeScale(scale, w, h) {
  let s = Math.max(0.01, scale);
  s = Math.min(s, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / (w * h)));
  return s;
}

async function decodeAll(items) {
  const map = new Map();
  await Promise.all(items.filter((it) => it.type === 'image').map(async (it) => {
    const img = await decodeImage(it.src);
    if (img) map.set(it.id, img);
  }));
  return map;
}

function prepItems(page) {
  let copy;
  try { copy = structuredClone(page?.items || []); } catch { copy = JSON.parse(JSON.stringify(page?.items || [])); }
  return normalizeItems(copy);
}

/**
 * Full A4 notebook page. `width` (px) overrides `scale`; `background:false` → transparent, no rules.
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderPageToCanvas(page, opts = {}) {
  const items = prepItems(page);
  const images = await decodeAll(items);
  const want = opts.width ? opts.width / PAGE_W : (opts.scale || 1);
  const s = safeScale(want, PAGE_W, PAGE_H);
  const canvas = makeCanvas(PAGE_W * s, PAGE_H * s);
  const ctx = canvas.getContext('2d');
  const paper = page?.paper || {};
  ctx.setTransform(canvas.width / PAGE_W, 0, 0, canvas.height / PAGE_H, 0, 0);
  if (opts.background !== false) {
    ctx.fillStyle = paperFill(paper);
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    drawPaperRules(ctx, paper, s);
  }
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
  drawItems(ctx, items, { zoom: s, dark: isDarkPaper(paper), getImage: (it) => images.get(it.id) || null });
  for (const img of images.values()) img.src = '';
  return canvas;
}

/**
 * Whiteboard export: the bounding box of all items plus padding (blank 800×600 when empty), scaled so
 * the longest side is ≤ maxSize (up to 2× for small boards).
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderBoardToCanvas(page, opts = {}) {
  const items = prepItems(page);
  const images = await decodeAll(items);
  const pad = opts.padding ?? 40;
  const maxSize = Math.min(MAX_SIDE, opts.maxSize || 2048);
  const paper = page?.paper || {};
  const dark = isDarkPaper(paper);
  let box = bboxOfItems(items);
  box = box ? [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad] : [0, 0, 800, 600];
  const bw = Math.max(1, box[2] - box[0]), bh = Math.max(1, box[3] - box[1]);
  // An empty board is exactly 800×600; otherwise up to 2× for sharpness.
  const s = safeScale(Math.min(bboxOfItems(items) ? 2 : 1, maxSize / Math.max(bw, bh)), bw, bh);
  const canvas = makeCanvas(bw * s, bh * s);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = paperFill(paper);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawBoardBackground(ctx, canvas.width, canvas.height, { x: box[0], y: box[1], zoom: s }, opts.background || 'blank', dark);
  ctx.setTransform(s, 0, 0, s, -box[0] * s, -box[1] * s);
  drawItems(ctx, items, { zoom: s, dark, getImage: (it) => images.get(it.id) || null });
  for (const img of images.values()) img.src = '';
  return canvas;
}

/**
 * JPEG thumbnail (quality 0.78), 480px wide. Notebook → the whole page; whiteboard → a 4:3 card with
 * the content fitted and centred.
 * @returns {Promise<string>} data:image/jpeg;base64,…
 */
export async function makeThumbnail(page, kind) {
  let canvas;
  if (kind === 'whiteboard') {
    const W = 480, H = 360;
    const content = await renderBoardToCanvas(page, { maxSize: 960, padding: 32 });
    canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = paperFill(page?.paper);
    ctx.fillRect(0, 0, W, H);
    const k = Math.min(W / content.width, H / content.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(content, (W - content.width * k) / 2, (H - content.height * k) / 2, content.width * k, content.height * k);
    content.width = content.height = 0;
  } else {
    canvas = await renderPageToCanvas(page, { width: 480, background: true });
  }
  const url = canvas.toDataURL('image/jpeg', 0.78);
  canvas.width = canvas.height = 0; // Safari keeps canvas memory alive otherwise
  return url;
}

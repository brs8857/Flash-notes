// Scene rendering shared by the live view and the pure export helpers (thumbnails, PNG, PDF).

import { PAGE_W, PAGE_H } from './constants.js';
import { bboxIntersects, bboxOfItems } from './geom.js';
import { drawStroke, deviceScale } from './strokes.js';
import { drawText, resetTextLayout } from './text.js';
import { decodeImage } from './images.js';
import { normalizeItems } from './items.js';
import { ensureHandFont, handReady, usesHandFont } from './fonts.js';
import { getBrush, DEFAULT_BRUSH } from './brushes.js';
import { PAPER_COLORS } from './constants.js';
import { paperFill, isDarkPaper, displayColor, drawPaperRules, drawBoardBackground } from './paper.js';

/**
 * Draw items in world coordinates (the ctx transform must already map world → device).
 * Pass order: images → highlighters → pens → text; array order is the z-order within a pass.
 * @param {object} o {zoom, dark, visible?:bbox, skip?:Set<id>, getImage(item) → drawable|null}
 * @returns {number} how many items were drawn
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
  // Each stroke brings its own opacity and texture (brushes.js).
  const k = highlights.length || pens.length ? deviceScale(ctx) : 1;
  for (const it of highlights) drawStroke(ctx, it, o.zoom, it.color, k);
  ctx.lineJoin = 'round';
  for (const it of pens) drawStroke(ctx, it, o.zoom, displayColor(it.color, o.dark), k);
  for (const it of texts) drawText(ctx, it, displayColor(it.color, o.dark));
  return images.length + highlights.length + pens.length + texts.length;
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

/** Pages with handwriting-font text wait for the font (other pages never do), then lay out afresh. */
async function fontsFor(page) {
  if (handReady() || !usesHandFont(page?.items)) return;
  if (await ensureHandFont()) resetTextLayout();
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
  await fontsFor(page);
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
  await fontsFor(page);
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

// ---- Brush previews (tool options) ----------------------------------------------------------------

const previewPoints = new Map();
/** An "S" squiggle with a pressure swell, w × h world units, as stroke points. */
function squiggle(w, h, inset) {
  const key = w + '|' + h + '|' + inset;
  let pts = previewPoints.get(key);
  if (!pts) {
    pts = [];
    const n = 44, x0 = inset, x1 = w - inset, amp = (h - inset * 2) * 0.3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([x0 + (x1 - x0) * t, h / 2 - Math.sin(t * Math.PI * 2) * amp * (0.9 + 0.1 * t), 0.18 + 0.8 * Math.pow(Math.sin(t * Math.PI), 1.3)]);
    }
    previewPoints.set(key, pts);
  }
  return pts;
}

/**
 * Draw a sample stroke of a brush into a canvas (the app's brush picker). The canvas is sized by the
 * caller (backing store = CSS size × devicePixelRatio); the sample is drawn with the real renderer.
 * @param {HTMLCanvasElement} canvas
 * @param {{tool:'pen'|'highlighter', brush:string, color:string, size:number, dark?:boolean, paper?:boolean}} o
 */
export function renderBrushPreview(canvas, o) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!W || !H) return;
  const tool = o.tool === 'highlighter' ? 'highlighter' : 'pen';
  const brush = getBrush(o.brush, tool) || getBrush(DEFAULT_BRUSH[tool], tool);
  const cssH = o.cssHeight || 44, dpr = H / cssH;
  // World units → CSS px: like a page at 140%, but thick brushes are scaled down to fit the swatch.
  const size = o.size > 0 ? o.size : brush.size;
  const maxPx = cssH * (tool === 'highlighter' ? 0.5 : 0.36);
  const z = Math.min(1.4, maxPx / size);
  const k = z * dpr;
  if (o.paper) { ctx.fillStyle = PAPER_COLORS[o.dark ? 'dark' : 'white']; ctx.fillRect(0, 0, W, H); }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const inset = Math.min(size * 0.7 + 2, (W / k) * 0.2);
  const item = { type: 'stroke', tool, brush: brush.id, color: o.color, size, points: squiggle(Math.round(W / k), Math.round(H / k), Math.round(inset)) };
  ctx.lineJoin = 'round';
  drawStroke(ctx, item, z, tool === 'highlighter' ? o.color : displayColor(o.color, !!o.dark), k);
}

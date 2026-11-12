// Text layout and drawing. `layoutText` is the ONLY source of a text item's wrapping, height and
// bbox, so the editing textarea, the canvas, thumbnails and exports always agree.

import { FONT_STACKS, LINE_HEIGHT, MIN_FONT_SIZE } from './constants.js';

let measureCtx = null;
function getMeasureCtx() {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    measureCtx = c.getContext('2d');
  }
  return measureCtx;
}

export function fontFamily(font) { return FONT_STACKS[font] || FONT_STACKS.sans; }
export function fontString(item) {
  return `${Math.max(MIN_FONT_SIZE, +item.fontSize || MIN_FONT_SIZE)}px ${fontFamily(item.font)}`;
}

let layoutCache = new WeakMap();

/** Forget every cached layout (a web font arrived: text measured with the fallback font is stale). */
export function resetTextLayout() { layoutCache = new WeakMap(); }

/**
 * Wrap an item's text with CSS `white-space: pre-wrap; overflow-wrap: break-word` semantics:
 * break after spaces, hard-break words wider than the box, keep trailing spaces on the line.
 * @returns {{lines:string[], h:number, lineHeight:number, baseline:number}}
 */
export function layoutText(item, ctx) {
  const cached = layoutCache.get(item);
  if (cached) return cached;
  const out = computeLayout(item, ctx);
  layoutCache.set(item, out);
  return out;
}

/** Uncached variant (used for the mutable item being edited). */
export function computeLayout(item, ctx) {
  ctx = ctx || getMeasureCtx();
  const fontSize = Math.max(MIN_FONT_SIZE, +item.fontSize || MIN_FONT_SIZE);
  const maxW = Math.max(1, +item.w || 1);
  const prevFont = ctx.font;
  ctx.font = fontString(item);
  const width = (s) => ctx.measureText(s).width;
  const lines = [];
  for (const para of String(item.text ?? '').split('\n')) {
    const tokens = para.match(/\s+|\S+/g) || [];
    let line = '';
    for (const tok of tokens) {
      if (/^\s/.test(tok)) { line += tok; continue; }          // spaces hang at the end of a line
      if (line === '' || width(line + tok) <= maxW) {
        if (line === '' && width(tok) > maxW) line = hardBreak(tok, maxW, width, lines);
        else line += tok;
        continue;
      }
      lines.push(line);
      line = width(tok) > maxW ? hardBreak(tok, maxW, width, lines) : tok;
    }
    lines.push(line);
  }
  const lineHeight = fontSize * LINE_HEIGHT;
  // Baseline position inside a CSS line box. Browsers round the font's ascent/descent to whole px and
  // floor the half-leading, so do the same or canvas text sits ~1px below the textarea it replaces.
  const m = ctx.measureText('Mg');
  const asc = Math.round(m.fontBoundingBoxAscent ?? fontSize * 0.93);
  const desc = Math.round(m.fontBoundingBoxDescent ?? fontSize * 0.25);
  const baseline = asc + Math.floor((lineHeight - (asc + desc)) / 2);
  ctx.font = prevFont;
  return {
    lines,
    lineHeight,
    baseline,
    h: Math.max(1, lines.length) * lineHeight,
  };
}

/** Break an over-long word; pushes full lines and returns the remainder. */
function hardBreak(word, maxW, width, lines) {
  let cur = '';
  for (const ch of Array.from(word)) {
    if (cur !== '' && width(cur + ch) > maxW) { lines.push(cur); cur = ch; } else cur += ch;
  }
  return cur;
}

/** Draw a committed text item in world coordinates. */
export function drawText(ctx, item, color) {
  const lay = layoutText(item);
  ctx.font = fontString(item);
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (let i = 0; i < lay.lines.length; i++) {
    if (lay.lines[i]) ctx.fillText(lay.lines[i], item.x, item.y + i * lay.lineHeight + lay.baseline);
  }
}

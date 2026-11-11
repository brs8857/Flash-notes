// Paper templates (notebook pages, world units) and the adaptive whiteboard background (screen space).

import { PAGE_W, PAGE_H, PAPER_COLORS, DARK_INK, LIGHT_INK } from './constants.js';
import { clamp } from './geom.js';

export function paperFill(paper) { return PAPER_COLORS[paper?.color] || PAPER_COLORS.white; }
export function isDarkPaper(paper) { return paper?.color === 'dark'; }

/**
 * Display-only ink swap: near-black ink is shown light on dark paper, and white ink is shown dark on
 * light paper, so notes stay readable when the paper colour changes. Stored colours never change.
 */
export function displayColor(color, dark) {
  const c = String(color || DARK_INK).toUpperCase();
  if (dark) return c === DARK_INK ? LIGHT_INK : color;
  return c === '#FFFFFF' || c === '#FFF' ? DARK_INK : color;
}

/** Soft layered shadow around the page rectangle (screen px; cheaper than ctx.shadowBlur). */
export function drawPageShadow(ctx, x, y, w, h, dark) {
  ctx.fillStyle = dark ? 'rgba(0,0,0,0.05)' : 'rgba(30,25,15,0.017)';
  for (let i = 1; i <= 8; i++) {
    const g = i * 2.2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - g, y - g + 4, w + g * 2, h + g * 2, g + 2) : ctx.rect(x - g, y - g + 4, w + g * 2, h + g * 2);
    ctx.fill();
  }
}

/**
 * Draw rules/grid/dots for a paper style. The context must already be in world (page) coordinates;
 * `zoom` = device px per world unit ÷ dpr, used to keep rules ~1 screen px wide at every zoom.
 */
export function drawPaperRules(ctx, paper, zoom) {
  const style = paper?.style || 'blank';
  if (style === 'blank') return;
  const dark = isDarkPaper(paper);
  const rule = dark ? 'rgba(255,255,255,0.12)' : 'rgba(80,130,200,0.28)';
  const lw = clamp(1, 0.75 / zoom, 1.5 / zoom);
  ctx.lineWidth = lw;
  ctx.strokeStyle = rule;
  ctx.lineCap = 'butt';
  const hline = (y, x0 = 0, x1 = PAGE_W) => { ctx.moveTo(x0, y); ctx.lineTo(x1, y); };
  const vline = (x, y0 = 0, y1 = PAGE_H) => { ctx.moveTo(x, y0); ctx.lineTo(x, y1); };

  ctx.beginPath();
  if (style === 'lined' || style === 'narrow') {
    const gap = style === 'lined' ? 32 : 24, start = style === 'lined' ? 120 : 96;
    for (let y = start; y < PAGE_H - 16; y += gap) hline(y);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = dark ? 'rgba(255,120,120,0.45)' : 'rgba(224,70,70,0.6)';
    vline(88);
    ctx.stroke();
  } else if (style === 'grid') {
    for (let x = 25; x < PAGE_W; x += 25) vline(x);
    for (let y = 25; y < PAGE_H; y += 25) hline(y);
    ctx.stroke();
  } else if (style === 'dotted') {
    const r = clamp(1.3, 0.9 / zoom, 2.2 / zoom);
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(80,110,170,0.42)';
    for (let y = 25; y < PAGE_H; y += 25) {
      for (let x = 25; x < PAGE_W; x += 25) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    }
    ctx.fill();
  } else if (style === 'cornell') {
    for (let y = 142; y < 931; y += 32) hline(y, 220, PAGE_W);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.26)' : 'rgba(80,130,200,0.6)';
    ctx.lineWidth = lw * 1.4;
    hline(110); hline(931); vline(220, 110, 931);
    ctx.stroke();
  }
}

/**
 * Whiteboard background in screen space. The 25-unit base lattice is shown at whichever power-of-5
 * multiple lands between 12 and 60 screen px; the finer level fades in as you zoom, so it is never a
 * dense mess at 10% nor sparse at 1000%.
 */
export function drawBoardBackground(ctx, w, h, view, bg, dark) {
  if (bg !== 'dots' && bg !== 'grid') return;
  const MIN = 12, MAX = MIN * 5;
  const g = 25 * view.zoom;
  const s = g * Math.pow(5, Math.ceil(Math.log(MIN / g) / Math.log(5) - 1e-9)); // MIN ≤ s < MAX
  const ramp = clamp((s - MIN) / 10, 0, 1);
  const sw = s / view.zoom; // lattice spacing in world units
  const rgb = dark ? '255,255,255' : '50,55,80';
  const kx0 = Math.floor(view.x / sw), ky0 = Math.floor(view.y / sw);
  const X = (k) => (k * sw - view.x) * view.zoom, Y = (k) => (k * sw - view.y) * view.zoom;
  void MAX;

  if (bg === 'grid') {
    const base = dark ? 0.09 : 0.1;
    ctx.lineWidth = 1;
    for (const major of [false, true]) {
      const a = major ? base : base * ramp;
      if (a < 0.004) continue;
      ctx.strokeStyle = `rgba(${rgb},${a})`;
      ctx.beginPath();
      for (let k = kx0; X(k) <= w; k++) {
        if ((k % 5 === 0) !== major) continue;
        const x = Math.round(X(k)) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
      }
      for (let k = ky0; Y(k) <= h; k++) {
        if ((k % 5 === 0) !== major) continue;
        const y = Math.round(Y(k)) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(w, y);
      }
      ctx.stroke();
    }
    return;
  }
  const base = dark ? 0.2 : 0.26;
  const r = 1.35;
  for (const major of [false, true]) {
    const a = major ? base : base * ramp;
    if (a < 0.004) continue;
    ctx.fillStyle = `rgba(${rgb},${a})`;
    ctx.beginPath();
    for (let ky = ky0; Y(ky) <= h + r; ky++) {
      const y = Y(ky), rowMajor = ky % 5 === 0;
      for (let kx = kx0; X(kx) <= w + r; kx++) {
        if ((rowMajor && kx % 5 === 0) !== major) continue;
        const x = X(kx);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
}

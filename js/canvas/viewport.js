// Pure viewport maths. view = {x, y, zoom}: (x, y) is the world point at the container's top-left,
// screen = (world − {x, y}) × zoom.

import { PAGE_W, PAGE_H, ZOOM, WORLD_LIMIT, PAGE_MARGIN } from './constants.js';
import { clamp } from './geom.js';

/** The part of the container not covered by the app's glass bars (CSS px). */
export function usableRect(w, h, ins) {
  const x = Math.min(ins.left, w * 0.4), y = Math.min(ins.top, h * 0.4);
  return { x, y, w: Math.max(40, w - x - Math.min(ins.right, w * 0.4)), h: Math.max(40, h - y - Math.min(ins.bottom, h * 0.5)) };
}

/** `soft` allows a 10% overshoot while pinching (springs back on release). */
export function clampZoom(z, mode, soft = false) {
  const lim = ZOOM[mode] || ZOOM.page;
  if (!Number.isFinite(z) || z <= 0) z = 1;
  const k = soft ? 1.1 : 1;
  return clamp(z, lim.min / k, lim.max * k);
}

/** Snap a zoom that is within 0.2% of a hard limit onto it, so the UI reads exactly 1000% / 10% (no 999%). */
export function snapZoom(z, mode) {
  const lim = ZOOM[mode] || ZOOM.page;
  if (Math.abs(z - lim.max) < lim.max * 0.002) return lim.max;
  if (Math.abs(z - lim.min) < lim.min * 0.002) return lim.min;
  return z;
}

export function fitWidthZoom(w, h, ins) {
  const u = usableRect(w, h, ins);
  return clampZoom((u.w - PAGE_MARGIN * 2) / PAGE_W, 'page');
}

/**
 * Keep the view sensible. Page mode behaves like a scroll view: the page is centred on an axis when it
 * fits, otherwise it stops a margin past its edges — except that the bottom of the page may be pulled
 * up to ~45% of the visible height so the last lines can be written at a comfortable position (and
 * above the on-screen keyboard). Board mode only limits coordinates to ±WORLD_LIMIT.
 */
export function clampView(v, mode, w, h, ins) {
  const zoom = v.zoom;
  let { x, y } = v;
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  if (!w || !h) return { x, y, zoom };
  if (mode === 'board') {
    return {
      x: clamp(x, -WORLD_LIMIT, Math.max(-WORLD_LIMIT, WORLD_LIMIT - w / zoom)),
      y: clamp(y, -WORLD_LIMIT, Math.max(-WORLD_LIMIT, WORLD_LIMIT - h / zoom)),
      zoom,
    };
  }
  const u = usableRect(w, h, ins), M = PAGE_MARGIN;
  const pw = PAGE_W * zoom, ph = PAGE_H * zoom;
  let sx = -x * zoom, sy = -y * zoom; // screen position of the page's top-left
  if (pw + M * 2 <= u.w + 0.5) sx = u.x + (u.w - pw) / 2;
  else sx = clamp(sx, u.x + u.w - M - pw, u.x + M);
  if (ph + M * 2 <= u.h + 0.5) sy = u.y + (u.h - ph) / 2;
  else sy = clamp(sy, Math.min(u.y + u.h * 0.45 - ph, u.y + u.h - M - ph), u.y + M);
  return { x: -sx / zoom, y: -sy / zoom, zoom };
}

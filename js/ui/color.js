// Colour maths and palettes for the colour picker. Pure (no DOM): tested by tests/color.test.mjs.

/** '#rgb', 'rgb', '#RRGGBB', 'rrggbb' → '#RRGGBB' (upper case), or null when it is not a hex colour. */
export function normalizeHex(input) {
  let s = String(input ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return /^[0-9a-f]{6}$/i.test(s) ? '#' + s.toUpperCase() : null;
}

export function hexToRgb(hex) {
  const h = normalizeHex(hex);
  if (!h) return null;
  const n = parseInt(h.slice(1), 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}

const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
export function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** r, g, b 0–255 → h 0–360 (exclusive), s and v 0–1. Greys have h = 0. */
export function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s)); v = Math.max(0, Math.min(1, v));
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) };
}

export const hexToHsv = (hex) => { const rgb = hexToRgb(hex); return rgb ? rgbToHsv(rgb) : null; };
export const hsvToHex = (hsv) => rgbToHex(hsvToRgb(hsv));

export const sameColor = (a, b) => { const x = normalizeHex(a); return !!x && x === normalizeHex(b); };

/** Put `color` at the front of a most-recent-first list (no duplicates, at most `max`). Returns a new array. */
export function pushRecent(list, color, max = 8) {
  const c = normalizeHex(color);
  if (!c) return (list || []).slice(0, max);
  return [c, ...(list || []).filter((x) => !sameColor(x, c))].slice(0, max);
}

/** Add to the saved swatches (kept in the order they were saved, at most `max`). Returns a new array. */
export function addSaved(list, color, max = 24) {
  const c = normalizeHex(color);
  const cur = (list || []).map(normalizeHex).filter(Boolean);
  if (!c || cur.includes(c)) return cur.slice(0, max);
  return [...cur, c].slice(-max);
}

export const removeSaved = (list, color) => (list || []).filter((x) => !sameColor(x, color));

// ---- Palettes (8 per row) ---------------------------------------------------------------------------
// The first rows are the engine's INK_COLORS / HIGHLIGHT_COLORS, so older notes' colours are all here.
export const PALETTES = {
  ink: ['#1C1C1E', '#3B5BDB', '#E03131', '#2F9E44', '#F08C00', '#9C36B5', '#0C8599', '#FFFFFF'],
  pastel: ['#FFADAD', '#FFD6A5', '#FDF3A0', '#B9F2B0', '#9BE7F5', '#A0C4FF', '#C4B5FD', '#FFC6FF'],
  deep: ['#495057', '#868E96', '#ADB5BD', '#5C3D2E', '#8D6E63', '#7F1D1D', '#1E3A8A', '#14532D'],
  highlight: ['#FFE066', '#8CE99A', '#74C0FC', '#FFA8A8', '#E599F7', '#FFC078', '#63E6BE', '#B197FC'],
  highlightSoft: ['#FFF3BF', '#D3F9D8', '#D0EBFF', '#FFE3E3', '#F3D9FA', '#FFE8CC', '#C3FAE8', '#E5DBFF'],
};

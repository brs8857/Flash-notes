// Flash Notes — shared constants (SPEC §3). Owned by Builder A, imported by the app.

export const PAGE_W = 800, PAGE_H = 1131;
export const PAPER_STYLES = ['blank', 'lined', 'narrow', 'grid', 'dotted', 'cornell'];
export const PAPER_COLORS = { white: '#FFFFFF', cream: '#FBF6E9', dark: '#1E1F24' };
export const BOARD_BACKGROUNDS = ['dots', 'grid', 'blank'];
export const ZOOM = { page: { min: 0.25, max: 6 }, board: { min: 0.1, max: 10 } }; // screen px per world unit
export const INK_COLORS = ['#1C1C1E', '#3B5BDB', '#E03131', '#2F9E44', '#F08C00', '#9C36B5', '#0C8599', '#FFFFFF'];
export const HIGHLIGHT_COLORS = ['#FFE066', '#8CE99A', '#74C0FC', '#FFA8A8', '#E599F7'];
// Units: pen/highlighter/text = WORLD units; eraser = SCREEN px diameter.
export const SIZES = { pen: [1.5, 3, 6], highlighter: [12, 20, 32], eraser: [10, 24, 48], text: [16, 22, 32] };

/** Unique id for docs, pages and items. */
export function newId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* insecure context: fall through */ }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---- Engine-internal constants (the app does not need these) -------------------------------

export const FONT_STACKS = {
  sans: '-apple-system, "SF Pro Text", system-ui, sans-serif',
  serif: 'ui-serif, "New York", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  round: 'ui-rounded, "SF Pro Rounded", system-ui',
  hand: '"FN Hand", "Patrick Hand", ui-rounded, "SF Pro Rounded", cursive',   // bundled, see css/canvas.css
};
export const LINE_HEIGHT = 1.35;      // × fontSize
export const MIN_FONT_SIZE = 16;      // iOS zooms the page when focusing inputs below 16px
export const TEXT_DEFAULT_W = 320;    // world units
export const HIGHLIGHT_ALPHA = 0.45;
export const DARK_INK = '#1C1C1E';    // displayed as LIGHT_INK on dark paper
export const LIGHT_INK = '#F2F2F7';
export const WORLD_LIMIT = 50000;     // board coordinates are clamped to ±this (float precision)
export const PAGE_MARGIN = 24;        // screen px kept around a notebook page
export const MAX_CANVAS_PIXELS = 12e6; // both on-screen canvases combined (Safari memory cap)
export const HISTORY_LIMIT = 200;
export const HOLD_MS = 500, HOLD_PX = 2;   // hold still this long / within this many screen px → snap (pen shapes, highlighter line)
export const PEN_BOX_W = 420;         // width of a Pencil writing box (world units)

// Flash Notes drawing engine — public entry point (SPEC §4).
//
//   import { CanvasView, renderPageToCanvas, renderBoardToCanvas, makeThumbnail } from './js/canvas/engine.js';
//
// Module map:
//   engine.js    CanvasView: DOM, backing stores, render loop, viewport, items + history, public API
//   input.js     pointer/touch/pen/mouse/keyboard → actions, pinch, palm rejection
//   draw.js      pen + highlighter (live stroke)        eraser.js    stroke / precise eraser
//   selection.js lasso, move/resize, context menu       textedit.js  text boxes (textarea overlay)
//   render.js    scene drawing + export helpers         paper.js     paper templates, board background
//   strokes.js   perfect-freehand outlines, Path2D cache, erase maths
//   text.js      layoutText (single source of wrapping) items.js     normalise / transform / hit-test
//   images.js    decoded image LRU    history.js  undo stack    viewport.js  clamp/fit maths
//   brushes.js   brush table (pens, pencils, highlighters) + procedural grain textures
//   smartink.js  auto shapes / auto-tidy / "Keep original" pill (owns their timers)
//   shapes.js    shape recognition (pure)   tidy.js  handwriting tidy (pure)   fonts.js  handwriting font

import {
  PAGE_W, PAGE_H, PAPER_STYLES, PAPER_COLORS, BOARD_BACKGROUNDS, INK_COLORS, HIGHLIGHT_COLORS,
  FONT_STACKS, MIN_FONT_SIZE, PAGE_MARGIN, MAX_CANVAS_PIXELS, newId,
} from './constants.js';
import { SmartInk } from './smartink.js';
import { ensureHandFont, handReady, onLateHandFont } from './fonts.js';
import { resetTextLayout } from './text.js';
import { round2, bboxOfItems, bboxIntersects } from './geom.js';
import { drawStroke } from './strokes.js';
import { getBrush, listBrushes, grainStyle, DEFAULT_BRUSH } from './brushes.js';
import { usableRect, clampZoom, snapZoom, clampView, fitWidthZoom } from './viewport.js';
import { paperFill, isDarkPaper, displayColor, drawPaperRules, drawPageShadow, drawBoardBackground } from './paper.js';
import { drawItems } from './render.js';
import { normalizeItems, finalizeItem } from './items.js';
import { History, diffItems } from './history.js';
import { ImageCache } from './images.js';
import { Input } from './input.js';
import { pasteText as clipPasteText, pasteImageFile as clipPasteImage } from './clipboard.js';
import { DrawTool } from './draw.js';
import { EraserTool } from './eraser.js';
import { Selection } from './selection.js';
import { TextEditor } from './textedit.js';

export { renderPageToCanvas, renderBoardToCanvas, makeThumbnail, renderBrushPreview } from './render.js';
export { listBrushes } from './brushes.js';

const TOOLS = ['pen', 'highlighter', 'eraser', 'lasso', 'text', 'hand'];
const SLOW_DRAW_MS = 10;   // above this, gestures transform the bitmap and redraw crisply on settle
const SETTLE_MS = 100;
const HEAVY_ITEMS = 250;   // this many items on screen: a pinch/pan moves the bitmap (canvas calls are only recorded during
                           // the draw, so the measured draw time alone under-reports how long a busy page takes to rasterise)
const MAX_STALE_MS = 250;  // longest a transformed bitmap is shown before a real redraw during a gesture

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function hexLuminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

export class CanvasView {
  /**
   * @param {HTMLElement} container
   * @param {{mode:'page'|'board', page?:object, background?:string, onChange?:Function,
   *          onViewChange?:Function, onHistory?:Function, onPencilDetected?:Function,
   *          onToolRequest?:Function}} opts
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('CanvasView: container element required');
    this.root = container;
    this.opts = opts;
    this.mode = opts.mode === 'board' ? 'board' : 'page';
    this.background = BOARD_BACKGROUNDS.includes(opts.background) ? opts.background : 'dots';
    this.destroyed = false;

    this.tool = 'pen';
    this.toolOpts = {
      pen: { brush: DEFAULT_BRUSH.pen, color: INK_COLORS[0], size: 3 },
      highlighter: { brush: DEFAULT_BRUSH.highlighter, color: HIGHLIGHT_COLORS[0], size: 20 },
      eraser: { size: 24, eraseMode: 'stroke' },
      text: { color: INK_COLORS[0], size: 22, font: 'sans' },
      lasso: {}, hand: {},
    };
    this.brushMemo = { pen: {}, highlighter: {} };   // brush id → {color, size}: every brush remembers its own
    this.pencilOnly = false;
    this.twoFingerUndo = true;
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    if (opts.insets) {     // known up front: the very first draw is at the final view, not drawn twice
      const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
      this.insets = { top: n(opts.insets.top), right: n(opts.insets.right), bottom: n(opts.insets.bottom), left: n(opts.insets.left) };
    }
    this.kbInset = 0;              // on-screen keyboard overlap while editing text (CSS px)

    this.view = { x: 0, y: 0, zoom: 1 };
    this.pristine = true;          // view not yet chosen by the user/app → keep auto-fitting
    this.focal = null;             // last pinch midpoint (for the spring-back)
    this.cssW = 0; this.cssH = 0; this.dpr = 1;

    this.pageId = '';
    this.paper = { style: 'blank', color: 'white' };
    this.items = [];               // immutable items; the array is replaced on every change
    this.hidden = new Set();       // ids not drawn on the main canvas (being edited / dragged)
    this.history = new History();
    this.images = new ImageCache(() => this.invalidate());
    this.theme = { desk: '#E6E3DD', accent: '#4C6EF5', deskDark: false };

    // --- DOM ---
    container.classList.add('cv-root');
    container.dataset.mode = this.mode;
    container.dataset.tool = this.tool;
    this.main = document.createElement('canvas');
    this.main.className = 'cv-canvas cv-main';
    this.live = document.createElement('canvas');
    this.live.className = 'cv-canvas cv-live';
    this.overlay = document.createElement('div');
    this.overlay.className = 'cv-overlay';
    container.append(this.main, this.live, this.overlay);
    this.ctx = this.main.getContext('2d', { alpha: false });
    this.lctx = this.live.getContext('2d');

    // --- render-loop state ---
    this._raf = 0; this._needMain = false; this._needLive = false; this._liveHas = false;
    this._liveFull = true; this._liveView = null; this._heavy = false; this._gestureAt = 0; this._gestureSlow = 0;
    this._drawnView = null; this._lastDrawMs = 0; this._lastDrawAt = 0; this._bitmap = false;
    this._settleT = 0; this._viewT = 0; this._viewAt = 0; this._anim = 0; this._probe = 0;
    this._frame = this._frame.bind(this);

    // --- tools ---
    this.smart = new SmartInk(this);
    this.selection = new Selection(this);
    this.textEdit = new TextEditor(this);
    this.draw = new DrawTool(this);
    this.eraser = new EraserTool(this);
    this.input = new Input(this);

    // --- environment listeners ---
    this._readTheme();
    this._onTheme = () => { this._readTheme(); this.invalidate(); };
    this._mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (this._mq) this._mq.addEventListener ? this._mq.addEventListener('change', this._onTheme) : this._mq.addListener(this._onTheme);
    this._mo = new MutationObserver(this._onTheme);
    this._mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    // Capture phase so open text is committed before the app's own "flush on hide" listeners run.
    this._onHide = () => { if (document.visibilityState === 'hidden') this._commitPending(); };
    this._onPageHide = () => this._commitPending();
    document.addEventListener('visibilitychange', this._onHide, true);
    window.addEventListener('pagehide', this._onPageHide, true);
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro) this._ro.observe(container);
    this._onWinResize = () => this.resize();
    window.addEventListener('resize', this._onWinResize);

    this._setPage(opts.page);
    this.resize(true);
    // Defensive: the app also starts this at boot. Text laid out before the font arrived is redone.
    if (!handReady()) {
      const redo = () => this._handFontReady();
      ensureHandFont().then((ok) => { if (ok) redo(); else if (!this.destroyed) this._unlate = onLateHandFont(redo); });
    }
  }

  // =================================================================================================
  // Public API
  // =================================================================================================

  setTool(tool) {
    if (!TOOLS.includes(tool) || tool === this.tool) return;
    this.textEdit.commit();
    this.input.finishAction();              // switching mid-stroke keeps the stroke
    this.input.resetTouches();              // a tool switch is a clean slate for fingers (no ghost-pinch state)
    this.smart.toolChanged();
    if (tool !== 'lasso') this.selection.clear();
    this.eraser.hide();
    this.tool = tool;
    this.root.dataset.tool = tool;
  }

  getTool() { return this.tool; }

  setToolOptions(tool, opts) {
    const o = this.toolOpts[tool];
    if (!o || !opts) return;
    if (tool === 'pen' || tool === 'highlighter') {
      const memo = this.brushMemo[tool];
      const next = typeof opts.brush === 'string' ? getBrush(opts.brush, tool) : null;
      if (next && next.id !== o.brush) {
        // Switching brush: put the old one's colour and size away, take out the new one's.
        memo[o.brush] = { color: o.color, size: o.size };
        const m = memo[next.id];
        o.brush = next.id;
        o.color = m ? m.color : next.color || o.color;
        o.size = m ? m.size : next.size;
        this._warmBrush(tool);
      }
      if (typeof opts.color === 'string' && opts.color) o.color = opts.color;
      if (Number.isFinite(opts.size) && opts.size > 0) o.size = Math.min(200, Math.max(0.2, opts.size));
      memo[o.brush] = { color: o.color, size: o.size };
      if (tool === 'pen') this.smart.setOptions(opts);   // {autoShapes, autoTidy}: booleans only
      return;
    }
    if (typeof opts.color === 'string' && opts.color) o.color = opts.color;
    if (Number.isFinite(opts.size) && opts.size > 0) o.size = tool === 'text' ? Math.max(MIN_FONT_SIZE, opts.size) : opts.size;
    if (opts.eraseMode === 'stroke' || opts.eraseMode === 'area') o.eraseMode = opts.eraseMode;
    else if (opts.eraseMode === 'precise') o.eraseMode = 'area';
    if (typeof opts.font === 'string' && FONT_STACKS[opts.font]) o.font = opts.font;
    if (tool === 'text') this.textEdit.setOptions({ color: opts.color, size: opts.size && o.size, font: opts.font && o.font });
  }

  /** Current options of a tool (a copy): {brush, color, size} for pen / highlighter. */
  getToolOptions(tool) { return this.toolOpts[tool] ? { ...this.toolOpts[tool] } : null; }

  /** The brush library: [{id, label, kind:'pen'|'highlighter', size, min, max, sizes:[3 quick sizes], color}]. */
  getBrushes() { return listBrushes(); }

  /** Build a textured brush's grain tile ahead of the first stroke (it takes a few ms once per zoom level). */
  _warmBrush(tool) {
    const o = this.toolOpts[tool], b = getBrush(o.brush, tool);
    if (!b || !b.grain || this.destroyed) return;
    clearTimeout(this._warmT);
    this._warmT = setTimeout(() => {
      if (this.destroyed || this.input.busy) return;
      grainStyle(b.grain, displayColor(o.color, this.isDark()), this.dpr * this.view.zoom);
    }, 60);
  }

  setPencilOnly(on) { this.pencilOnly = !!on; }
  setTwoFingerUndo(on) { this.twoFingerUndo = !!on; }

  setInsets(insets) {
    const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const next = { top: n(insets?.top), right: n(insets?.right), bottom: n(insets?.bottom), left: n(insets?.left) };
    const cur = this.insets;
    if (next.top === cur.top && next.right === cur.right && next.bottom === cur.bottom && next.left === cur.left) return;
    this.insets = next;
    if (this.pristine) this._resetView(true);
    else this.applyView(this.view, { force: true });
    this._syncOverlay();
  }

  setPaper(paper) {
    if (!paper) return;
    this.paper = {
      style: PAPER_STYLES.includes(paper.style) ? paper.style : this.paper.style,
      color: PAPER_COLORS[paper.color] ? paper.color : this.paper.color,
    };
    this.root.dataset.paper = this.paper.color;
    this.invalidate();
  }

  setBackground(bg) {
    if (!BOARD_BACKGROUNDS.includes(bg)) return;
    this.background = bg;
    this.invalidate();
  }

  load(page) {
    if (this.destroyed) return;
    // Finish work on the OLD page first (fires onChange with the old pageId).
    this.smart.cancel();
    this.textEdit.commit();
    this.input.abortAll(false);
    this.stopAnimations();
    this._setPage(page);
    this._emitHistory();
  }

  getItems() { return clone(this.items); }

  /** Commit anything still open (text box, stroke in progress) so getItems() is complete. */
  commitPending() { this._commitPending(); }

  isBusy() { return this.input.busy || this.textEdit.active || !!this._anim || this.draw.active; }

  undo() { this._timeTravel('undo'); }
  redo() { this._timeTravel('redo'); }
  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }

  /** Insert an image (data URL) centred in the visible area, ≤60% of its width, and select it. */
  insertImage(src, naturalW, naturalH) {
    if (typeof src !== 'string' || !src) return;
    this.textEdit.commit();
    const nw = naturalW > 0 ? naturalW : 400, nh = naturalH > 0 ? naturalH : 300;
    const u = this.usable(), z = this.view.zoom;
    let w = Math.min(nw, (u.w * 0.6) / z, (u.h * 0.7 * nw) / nh / z);
    if (this.mode === 'page') w = Math.min(w, PAGE_W * 0.8, (PAGE_H * 0.8 * nw) / nh);
    w = Math.max(w, 8);
    const h = (w * nh) / nw;
    let [cx, cy] = this.centerWorld();
    if (this.mode === 'page') {
      cx = Math.min(Math.max(cx, w / 2), PAGE_W - w / 2);
      cy = Math.min(Math.max(cy, h / 2), PAGE_H - h / 2);
    }
    const item = finalizeItem({ id: newId(), type: 'image', x: round2(cx - w / 2), y: round2(cy - h / 2), w: round2(w), h: round2(h), src });
    this.requestTool('lasso');
    this.addItems([item], 'insert');
    this.selection.set([item.id]);
  }

  /** New empty text box near the centre of the view, focused. Call from a tap (iOS keyboard rule). */
  insertText() {
    this.input.finishAction();
    this.textEdit.commit();
    const u = this.usable(), z = this.view.zoom;
    const w = Math.min(320, (u.w - 32) / z);
    let [wx, wy] = this.toWorld(u.x + u.w / 2 - (Math.min(320, w) * z) / 2, u.y + u.h * 0.3);
    if (this.mode === 'page') { wx = Math.min(Math.max(wx, 16), PAGE_W - 136); wy = Math.min(Math.max(wy, 24), PAGE_H - 40); }
    this.textEdit.createAt(wx, wy);
  }

  /** Paste plain text from the system clipboard as a text box / an image file as an image (also used by ⌘V). */
  pasteText(text) { return clipPasteText(this, text); }
  pasteImage(file) { return clipPasteImage(this, file); }

  deleteSelection() { this.selection.delete(); }
  clearSelection() { this.selection.clear(); }

  getZoom() { return this.view.zoom; }

  /** Zoom keeping the centre of the visible area fixed. */
  setZoom(z, opts = {}) {
    if (!Number.isFinite(z) || z <= 0) return;
    const u = this.usable();
    const fx = u.x + u.w / 2, fy = u.y + u.h / 2;
    z = clampZoom(z, this.mode);
    this.stopAnimations();
    if (opts.animate && !this.reducedMotion() && this.cssW) this._animateZoom(z, fx, fy);
    else this.zoomAt(fx, fy, z);
  }

  zoomBy(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const target = this._animTarget || this.view.zoom; // repeated taps accumulate
    this.setZoom(target * factor, { animate: true });
  }

  fitWidth() {
    this.stopAnimations();
    if (this.mode !== 'page') { this._resetView(false); return; }
    const u = this.usable();
    const z = fitWidthZoom(this.cssW || 1, this.cssH || 1, this._insets());
    const topWorld = this.view.y + u.y / this.view.zoom;
    this.applyView({ x: 0, y: topWorld - u.y / z, zoom: z }, { force: true });
  }

  resetView() {
    this.stopAnimations();
    this._resetView(false);
  }

  getView() { return { x: this.view.x, y: this.view.y, zoom: this.view.zoom }; }

  setView(v) {
    if (!v || ![v.x, v.y, v.zoom].every(Number.isFinite)) return;
    this.stopAnimations();
    this.pristine = false;
    this.applyView({ x: v.x, y: v.y, zoom: clampZoom(v.zoom, this.mode) }, { force: true, silent: true });
  }

  /** Re-measure the container (also called automatically by a ResizeObserver). `defer`: the first paint waits for
   *  the next frame (constructor: nothing is on screen yet, and the app is about to set the view). */
  resize(defer = false) {
    if (this.destroyed) return;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (!w || !h) return;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    while (dpr > 1 && 2 * w * h * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.max(1, dpr - 0.25);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    const sized = bw !== this.main.width || bh !== this.main.height;
    if (!sized && w === this.cssW && h === this.cssH) return;
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    if (sized) {
      this.main.width = this.live.width = bw;
      this.main.height = this.live.height = bh;
      this._liveHas = true;
    }
    this._liveFull = true;
    if (this.pristine) this._resetView(true);
    else this.applyView(this.view, { force: true, silent: true });
    this._syncOverlay();
    this._needLive = true;
    this.invalidate();
    // Draw in this task: assigning canvas.width clears the bitmap, waiting for rAF would flash.
    if (sized && !defer) this._flush();
  }

  destroy() {
    if (this.destroyed) return;
    this._commitPending();
    this.smart.destroy();
    if (this._unlate) this._unlate();
    this.destroyed = true;
    this.stopAnimations();
    this.input.destroy();
    cancelAnimationFrame(this._raf);
    clearTimeout(this._warmT);
    clearTimeout(this._settleT);
    clearTimeout(this._viewT);
    if (this._ro) this._ro.disconnect();
    this._mo.disconnect();
    if (this._mq) this._mq.removeEventListener ? this._mq.removeEventListener('change', this._onTheme) : this._mq.removeListener(this._onTheme);
    document.removeEventListener('visibilitychange', this._onHide, true);
    window.removeEventListener('pagehide', this._onPageHide, true);
    window.removeEventListener('resize', this._onWinResize);
    this.images.clear();
    // Release backing stores now (Safari keeps canvas memory until GC otherwise).
    this.main.width = this.main.height = this.live.width = this.live.height = 0;
    this.main.remove(); this.live.remove(); this.overlay.remove();
    this.root.classList.remove('cv-root', 'cv-editing', 'cv-panning', 'cv-space');
    delete this.root.dataset.mode; delete this.root.dataset.tool; delete this.root.dataset.paper;
  }

  // =================================================================================================
  // Internal API used by the tool modules
  // =================================================================================================

  isDark() { return isDarkPaper(this.paper); }
  inPage(wx, wy) { return wx >= 0 && wy >= 0 && wx <= PAGE_W && wy <= PAGE_H; }
  toScreen(wx, wy) { return [(wx - this.view.x) * this.view.zoom, (wy - this.view.y) * this.view.zoom]; }
  toWorld(sx, sy) { return [this.view.x + sx / this.view.zoom, this.view.y + sy / this.view.zoom]; }
  reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  _insets() {
    const i = this.insets;
    return this.kbInset > i.bottom ? { top: i.top, right: i.right, left: i.left, bottom: this.kbInset } : i;
  }

  /** Visible rect inside the app's bars (and above the keyboard), container CSS px. */
  usable() { return usableRect(this.cssW || 1, this.cssH || 1, this._insets()); }

  centerWorld() {
    const u = this.usable();
    return this.toWorld(u.x + u.w / 2, u.y + u.h / 2);
  }

  /** Ask the app to switch tool; falls back to switching directly when the app does not listen. */
  requestTool(tool) {
    if (tool === this.tool) return;
    if (tool !== 'pen') this.smart.cancel();
    if (typeof this.opts.onToolRequest === 'function') {
      try { this.opts.onToolRequest(tool); } catch (err) { console.error(err); }
    } else this.setTool(tool);
  }

  /**
   * Commit a change: `before` → `after` item arrays. Records one history entry and notifies the app.
   * @returns {boolean} whether anything changed
   */
  commit(before, after, reason, skipRedraw = false) {
    const cmd = diffItems(before, after);
    this.items = after;
    if (!skipRedraw) this.invalidate();
    if (!cmd.removed.length && !cmd.added.length) return false;
    this.history.push(cmd);
    this.smart.onCommit(reason);
    this._emitHistory();
    this._emitChange(reason);
    return true;
  }

  addItems(list, reason) { return this.commit(this.items, this.items.concat(list), reason); }

  /**
   * Add a finished pen/highlighter stroke. When it cannot change the stacking order of what is already
   * on the main canvas (pens sit under text, highlighters under pens and text, later strokes over earlier
   * ones of their own kind) it is painted straight onto the committed bitmap instead of re-rendering the
   * whole scene. Anything uncertain falls back to the full redraw.
   */
  addStroke(item, reason = 'stroke') {
    const fast = this._canPaintStroke(item);
    if (fast) this._paintStroke(item);
    const changed = this.commit(this.items, this.items.concat([item]), reason, fast);
    if (fast) this._flush();   // clear the live stroke in the same task as the bitmap update (no double-darkened frame)
    return changed;
  }

  _canPaintStroke(item) {
    // The main canvas must show exactly the current view, with nothing pending, hidden or CSS-transformed.
    if (this._needMain || this._bitmap || this.hidden.size || !this._drawnView || this._drawnView !== this.view) return false;
    const bb = item.bbox, hl = item.tool === 'highlighter';
    for (const it of this.items) {
      if (!bboxIntersects(it.bbox, bb)) continue;
      if (it.type === 'text') return false;                                  // text always paints over strokes
      if (hl && it.type === 'stroke' && it.tool !== 'highlighter') return false; // pens paint over highlighters
    }
    return true;
  }

  _paintStroke(item) {
    const ctx = this.ctx, z = this.view.zoom;
    ctx.save();
    this._worldTransform(ctx);
    if (this.mode === 'page') { ctx.beginPath(); ctx.rect(0, 0, PAGE_W, PAGE_H); ctx.clip(); }
    ctx.lineJoin = 'round';
    drawStroke(ctx, item, z, item.tool === 'highlighter' ? item.color : displayColor(item.color, this.isDark()), this.dpr * z);
    ctx.restore();
  }

  /**
   * Set the view (clamped). `interactive` = part of a gesture/animation (may use the fast bitmap
   * path), `user` = the user chose this view (stops auto-fitting), `silent` = no onViewChange.
   */
  applyView(next, o = {}) {
    const v = clampView({ ...next, zoom: snapZoom(next.zoom, this.mode) }, this.mode, this.cssW, this.cssH, this._insets());
    const cur = this.view;
    const same = Math.abs(v.x - cur.x) < 1e-7 && Math.abs(v.y - cur.y) < 1e-7 && Math.abs(v.zoom - cur.zoom) < 1e-9;
    if (same && !o.force) return;
    if (!same) this.view = v;
    if (o.user) this.pristine = false;
    this._syncOverlay();
    if (o.interactive && (this._heavy || this._lastDrawMs > SLOW_DRAW_MS) && this._drawnView && !this._needMain) {
      // Heavy page: move the existing bitmap now, redraw crisply when the gesture pauses.
      this._bitmapTransform();
      clearTimeout(this._settleT);
      if (performance.now() - this._lastDrawAt > Math.max(MAX_STALE_MS, this._lastDrawMs * 6)) this.invalidate();
      else this._settleT = setTimeout(() => this.invalidate(), SETTLE_MS);
    } else {
      this.invalidate();
    }
    if (!same && !o.silent) this._emitView();
  }

  /** Zoom so the world point under screen point (sx, sy) stays put. */
  zoomAt(sx, sy, zoom, o = {}) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.focal = [sx, sy];
    this.applyView({ x: wx - sx / zoom, y: wy - sy / zoom, zoom }, { user: true, ...o });
  }

  /** After a pinch: spring back inside the hard zoom limits and guarantee a crisp vector redraw. */
  settleZoom() {
    const hard = clampZoom(this.view.zoom, this.mode);
    if (Math.abs(hard - this.view.zoom) > 1e-6) {
      const u = this.usable();
      const [fx, fy] = this.focal || [u.x + u.w / 2, u.y + u.h / 2];
      if (this.reducedMotion()) this.zoomAt(fx, fy, hard);
      else this._animateZoom(hard, fx, fy, 260);
    } else if (this._bitmap) this.invalidate();
  }

  stopAnimations() {
    if (this._anim) cancelAnimationFrame(this._anim);
    this._anim = 0;
    this._animTarget = 0;
    this.input.stopInertia();
  }

  invalidate() {
    this._needMain = true;
    this._schedule();
  }

  /** The live layer must be redrawn from scratch (next frame). */
  invalidateLive() {
    this._liveFull = true;
    this._needLive = true;
    this._schedule();
  }

  /**
   * Draw the live layer right now, inside the pointer event, instead of waiting for the next animation
   * frame: the newest ink reaches the screen up to a frame sooner. Only the stroke's tail is repainted
   * (see draw.js), so this is cheap. Falls back to the frame loop while the main canvas is not settled.
   */
  drawLiveNow() {
    if (this.destroyed) return;
    if (!this.cssW || this._needMain || this._bitmap) { this._needLive = true; this._schedule(); return; }
    this._needLive = false;
    this._drawLive();
  }

  // =================================================================================================
  // Private
  // =================================================================================================

  _setPage(page) {
    this.pageId = page && page.id != null ? page.id : '';
    this.paper = {
      style: PAPER_STYLES.includes(page?.paper?.style) ? page.paper.style : 'blank',
      color: PAPER_COLORS[page?.paper?.color] ? page.paper.color : 'white',
    };
    this.root.dataset.paper = this.paper.color;
    this.smart.pageChanged();
    // normalizeItems builds brand-new items (points, shape, text) and never touches the input, so the page record the
    // app keeps is not copied first (a structured clone of 500 strokes is ~8 ms; of an image item, megabytes).
    this.items = normalizeItems(Array.isArray(page?.items) ? page.items : []);
    this.history.clear();
    this.selection.clear();
    this.hidden.clear();
    this.images.clear();
    clearTimeout(this._viewT); this._viewT = 0;
    this.pristine = true;
    this._resetView(true);
    this._needLive = true;
    this._liveFull = true;
    this.invalidate();
  }

  _resetView(silent) {
    const u = this.usable();
    let v;
    if (this.mode === 'page') {
      const z = fitWidthZoom(this.cssW || 1, this.cssH || 1, this._insets());
      v = { x: 0, y: -(u.y + PAGE_MARGIN) / z, zoom: z };
    } else {
      const b = bboxOfItems(this.items);
      const cx = b ? (b[0] + b[2]) / 2 : 0, cy = b ? (b[1] + b[3]) / 2 : 0;
      v = { x: cx - (u.x + u.w / 2), y: cy - (u.y + u.h / 2), zoom: 1 };
    }
    this.pristine = true;
    this.applyView(v, { force: true, silent });
  }

  _timeTravel(dir) {
    if (this.destroyed || this.input.action || this.input.pinch) return;
    this.smart.cancel();
    this.textEdit.commit();
    const stack = dir === 'undo' ? this.history.undoStack : this.history.redoStack;
    const cmd = stack[stack.length - 1];
    const region = cmd ? this._changeRegion(cmd) : null;
    const next = dir === 'undo' ? this.history.undo(this.items) : this.history.redo(this.items);
    if (!next) return;
    this.selection.clear();
    this.items = next;
    // A few items came or went: repaint just where they were (a full redraw of a busy page is 15-40 ms).
    if (region) this._drawMain(region); else this.invalidate();
    this._emitHistory();
    this._emitChange(dir);
  }

  /** World bbox covering the items of an undo / redo command, or null when a full redraw is the safer choice. */
  _changeRegion(cmd) {
    if (this._needMain || this._bitmap || this.hidden.size || !this.cssW || !this._drawnView || this._drawnView !== this.view) return null;
    const list = cmd.added.concat(cmd.removed);
    if (!list.length || list.length > 40) return null;
    const b = bboxOfItems(list.map(([, it]) => it));
    if (!b || !b.every(Number.isFinite)) return null;
    const z = this.view.zoom, area = (b[2] - b[0]) * (b[3] - b[1]) * z * z;
    return area > this.cssW * this.cssH * 0.5 ? null : b;
  }

  /** Page is being hidden/destroyed: make sure nothing typed or drawn is left uncommitted. */
  _commitPending() {
    if (this.destroyed) return;
    this.input.finishAction();
    this.textEdit.commit();
    this.smart.cancel();            // never tidy in the background
  }

  /** The handwriting font arrived after text was measured with the fallback: measure again. Display-only
   *  (stored data has no layout), so no history entry and no onChange; items keep their identity. */
  _handFontReady() {
    if (this.destroyed) return;
    resetTextLayout();
    const fix = (it) => {
      if (!it || it.type !== 'text' || it.font !== 'hand') return;
      const f = finalizeItem(it);
      it.h = f.h; it.bbox = f.bbox;
    };
    this.items.forEach(fix);
    for (const cmd of [...this.history.undoStack, ...this.history.redoStack]) {
      for (const [, it] of cmd.removed) fix(it);
      for (const [, it] of cmd.added) fix(it);
    }
    this.textEdit.relayout();
    if (this.selection.has()) this.selection.set([...this.selection.ids]);
    this.invalidate();
  }

  _emitChange(reason) {
    if (typeof this.opts.onChange !== 'function') return;
    try { this.opts.onChange({ reason, pageId: this.pageId }); } catch (err) { console.error(err); }
  }

  _emitHistory() {
    if (typeof this.opts.onHistory !== 'function') return;
    try { this.opts.onHistory({ canUndo: this.history.canUndo(), canRedo: this.history.canRedo() }); } catch (err) { console.error(err); }
  }

  /** onViewChange, throttled to ≤10 per second (leading + trailing). */
  _emitView() {
    if (typeof this.opts.onViewChange !== 'function') return;
    const fire = () => {
      this._viewT = 0;
      this._viewAt = performance.now();
      if (this.destroyed) return;
      try { this.opts.onViewChange(this.getView()); } catch (err) { console.error(err); }
    };
    const wait = 100 - (performance.now() - this._viewAt);
    if (wait <= 0 && !this._viewT) fire();
    else if (!this._viewT) this._viewT = setTimeout(fire, Math.max(0, wait));
  }

  _syncOverlay() {
    this.selection.sync();
    this.textEdit.sync();
    this.smart.sync();
  }

  _readTheme() {
    let cs = null;
    try { cs = getComputedStyle(this.root); } catch { /* detached */ }
    const desk = (cs && cs.getPropertyValue('--desk').trim()) || '#E6E3DD';
    const accent = (cs && cs.getPropertyValue('--accent').trim()) || '#4C6EF5';
    this.theme = { desk, accent, deskDark: hexLuminance(desk) < 0.4 };
  }

  _animateZoom(target, fx, fy, dur = 240) {
    const z0 = this.view.zoom;
    if (Math.abs(target - z0) < 1e-6) return;
    const t0 = performance.now();
    this._animTarget = target;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic, in log-zoom space
      this.zoomAt(fx, fy, t < 1 ? z0 * Math.pow(target / z0, e) : target, { interactive: t < 1 });
      if (t < 1) this._anim = requestAnimationFrame(step);
      else { this._anim = 0; this._animTarget = 0; this.invalidate(); }
    };
    this._anim = requestAnimationFrame(step);
  }

  // ---- rendering -----------------------------------------------------------------------------------

  _schedule() {
    if (!this._raf && !this.destroyed) this._raf = requestAnimationFrame(this._frame);
  }

  _frame() {
    this._raf = 0;
    // Canvas 2D calls are only recorded during the draw; rasterisation happens afterwards. So the
    // honest cost of a redraw is how late the NEXT frame arrives, not the time spent in _drawMain.
    if (this._probe) {
      const late = performance.now() - this._probe - 17;
      this._probe = 0;
      if (late > this._lastDrawMs) this._lastDrawMs = late;
    }
    const drew = this._needMain;
    this._flush();
    if (drew && !this._needMain) {
      this._probe = performance.now();
      this._schedule();
    }
  }

  /** Main canvas first, then live — in the same task, so a committed stroke never flickers. */
  _flush() {
    if (this.destroyed || !this.cssW) return;
    if (this._needMain) { this._needMain = false; this._drawMain(); }
    if (this._needLive) { this._needLive = false; this._drawLive(); }
  }

  _worldTransform(ctx) {
    const k = this.dpr * this.view.zoom;
    ctx.setTransform(k, 0, 0, k, -this.view.x * k, -this.view.y * k);
  }

  _bitmapTransform() {
    const d = this._drawnView, v = this.view;
    const s = v.zoom / d.zoom;
    const t = `translate(${(d.x - v.x) * v.zoom}px, ${(d.y - v.y) * v.zoom}px) scale(${s})`;
    this.main.style.transform = t;
    this.live.style.transform = t;
    this._bitmap = true;
  }

  /** Redraw the main canvas; with `region` (world bbox) only that rectangle is repainted (undo / redo of a few items). */
  _drawMain(region = null) {
    const t0 = performance.now();
    const { ctx, dpr, cssW: w, cssH: h, view } = this;
    const z = view.zoom;
    const dark = this.isDark();
    const getImage = (it) => this.images.get(it);
    let visible = [view.x, view.y, view.x + w / z, view.y + h / z];
    let drawn = 0;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (region) {
      // Whole device pixels (+2 for anti-aliasing), so the repaint meets the untouched bitmap seamlessly.
      const k = dpr * z;
      const x0 = Math.max(0, Math.floor((region[0] - view.x) * k) - 2), y0 = Math.max(0, Math.floor((region[1] - view.y) * k) - 2);
      const x1 = Math.min(this.main.width, Math.ceil((region[2] - view.x) * k) + 2), y1 = Math.min(this.main.height, Math.ceil((region[3] - view.y) * k) + 2);
      if (x1 <= x0 || y1 <= y0) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      visible = [view.x + x0 / k, view.y + y0 / k, view.x + x1 / k, view.y + y1 / k];
    }
    if (this.mode === 'page') {
      ctx.fillStyle = this.theme.desk;
      ctx.fillRect(0, 0, w, h);
      const px = -view.x * z, py = -view.y * z;
      drawPageShadow(ctx, px, py, PAGE_W * z, PAGE_H * z, this.theme.deskDark);
      this._worldTransform(ctx);
      ctx.fillStyle = paperFill(this.paper);
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      drawPaperRules(ctx, this.paper, z);
      visible = [Math.max(visible[0], 0), Math.max(visible[1], 0), Math.min(visible[2], PAGE_W), Math.min(visible[3], PAGE_H)];
      drawn = drawItems(ctx, this.items, { zoom: z, dark, visible, skip: this.hidden.size ? this.hidden : null, getImage });
      ctx.restore();
    } else {
      ctx.fillStyle = paperFill(this.paper);
      ctx.fillRect(0, 0, w, h);
      drawBoardBackground(ctx, w, h, view, this.background, dark);
      this._worldTransform(ctx);
      drawn = drawItems(ctx, this.items, { zoom: z, dark, visible, skip: this.hidden.size ? this.hidden : null, getImage });
    }
    if (region) { ctx.restore(); return; }
    this.images.endFrame();

    this._drawnView = view;
    this._heavy = drawn > HEAVY_ITEMS;
    if (this._bitmap) {
      this.main.style.transform = '';
      this.live.style.transform = '';
      this._bitmap = false;
      this._needLive = true; // the live layer was transformed too: redraw it at the new view
      this._liveFull = true;
    }
    clearTimeout(this._settleT);
    this._lastDrawAt = performance.now();
    this._lastDrawMs = this._lastDrawAt - t0;
  }

  _drawLive() {
    const ctx = this.lctx;
    const others = !!(this.selection.xf || this.selection.lasso || this.smart.fx);
    // Stroke in progress and the canvas already holds it at this view: repaint only its tail.
    if (!this._liveFull && !others && this._liveView === this.view && this.draw.incremental()) {
      this._worldTransform(ctx);
      this.draw.renderIncremental(ctx);
      return;
    }
    if (this._liveHas) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.live.width, this.live.height);
      this._liveHas = false;
    }
    this._worldTransform(ctx);
    const a = this.draw.renderLive(ctx);
    const b = this.selection.renderLive(ctx);
    const c = this.smart.renderLive(ctx);
    this._liveHas = a || b || c;
    this._liveView = this.view;
    this._liveFull = others || !this.draw.incremental();
  }
}

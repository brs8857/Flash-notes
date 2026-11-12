# Flash Notes — Technical Spec & API Contract (v1.0)

Author: Opus (architect). This file is the single source of truth. Builders must not change a contract
in section 4 without writing the change into this file under "Contract changes" at the bottom.

## 1. Constraints
- **Static site, no build step, no backend.** Plain HTML + CSS + native ES modules (`<script type="module">`).
  Served from GitHub Pages under a sub-path (`https://brs8857.github.io/Flash-notes/`), so **every URL
  must be relative** (`./js/app.js`, never `/js/app.js`).
- **No npm runtime deps.** The only third-party code is `vendor/perfect-freehand.js`
  (ESM; `import { getStroke } from '../../vendor/perfect-freehand.js'`). Do not edit it.
- **Primary target: iPadOS Safari 17+ (PWA standalone + browser tab) with Apple Pencil.** Must also work in
  desktop Chrome/Safari/Firefox with mouse, and on iPhone.
- Storage: IndexedDB only (localStorage only for tiny UI prefs). No size caps in our code → "unlimited".
- Accessibility: buttons are `<button>` with `aria-label`; respects `prefers-reduced-motion`,
  `prefers-color-scheme`. Minimum hit target 44×44 px.
- Performance: drawing latency must feel instant; 60 fps pan/zoom with 2,000 strokes on screen.
- **iOS UI rules (all UI, both builders)**: every `input/textarea/select` has computed `font-size ≥ 16px`
  (iOS zooms the page on focus otherwise; `user-scalable=no` is ignored by iOS). `html,body{touch-action:
  manipulation}` (kills double-tap zoom). `-webkit-touch-callout:none; -webkit-user-select:none;
  user-select:none; -webkit-tap-highlight-color:transparent` on everything except real text inputs.
  Cards/covers must be `<button>`/`<div>` with CSS backgrounds, never `<a>`/`<img>` (long-press shows the
  link/image callout). `contextmenu` preventDefault on canvas and cards. `app.js` adds document-level
  `gesturestart/gesturechange` preventDefault for non-engine screens. The body never scrolls; the Library
  scrolls inside its own inner container.

## 2. File layout & ownership
| Path | Owner |
|---|---|
| `SPEC.md`, `ROADMAP.md`, `css/tokens.css`, `icons/*` | Opus |
| `js/canvas/**`, `css/canvas.css`, `tests/playground.html` | **Builder A (engine)** |
| `index.html`, `manifest.webmanifest`, `sw.js`, `css/app.css`, `js/app.js`, `js/store.js`, `js/ui/**`, `README.md`, `.nojekyll`, `404.html` | **Builder B (app)** |

Builders must only create/edit files they own. If you need something from the other side, code against
this contract.

`index.html` must load, in this order: `css/tokens.css`, `css/canvas.css`, `css/app.css`, then
`<script type="module" src="./js/app.js">`.

## 3. Data model (IndexedDB database `flash-notes`, version 1)

Object stores:
- `docs` — keyPath `id`. Index `kind`, index `updatedAt`.
- `pages` — keyPath `id`. Index `docId`.
- `thumbs` — keyPath `id` (= pageId), index `docId`. `{id, docId, data:'data:image/jpeg;base64,...'}`.
  Kept out of `pages` so the Library/drawer never load full pages (with images) just to show previews.
- `meta` — keyPath `key` (settings, e.g. `{key:'settings', theme:'system', pencilOnly:undefined|bool,
  twoFingerUndo:true}`; per-page last viewport as `{key:'view:<pageId>', x, y, zoom}`).

IDs: `crypto.randomUUID()` with fallback (`Date.now().toString(36)+Math.random().toString(36).slice(2)`),
implemented once as `newId()` exported from `js/canvas/constants.js`; store.js and the engine both import
it (engine mints item ids, store mints doc/page ids).
Times: `Date.now()` numbers.

```js
// Notebook
{ id, kind:'notebook', title:'Economics', createdAt, updatedAt,
  cover:{ color:'#3B5BDB', pattern:'plain'|'stripes'|'dots'|'grid'|'waves'|'checks',
          emoji:'📘'|null, image:null|'data:image/jpeg;base64,...' /* downscaled ≤ 800px */ },
  paper:{ style:'lined', color:'white' },    // default for NEW pages in this notebook
  pageIds:[ 'p1','p2', ... ] }               // order of pages = this array

// Whiteboard
{ id, kind:'whiteboard', title:'Revision map', createdAt, updatedAt,
  background:'dots'|'grid'|'blank', pageIds:['p1'] }   // always exactly one page

// Page (both kinds)
{ id, docId, createdAt, updatedAt,
  paper:{ style:'blank'|'lined'|'narrow'|'grid'|'dotted'|'cornell', color:'white'|'cream'|'dark' },
  items:[ /* Item, see below; array order = z-order within each render pass (§4) */ ] }
  // For a whiteboard page only `paper.color` is used (canvas fill); `paper.style` is ignored.
  // Thumbnail → `thumbs` store; last viewport → `meta` store (see above). Neither lives in the page record.
```

### Items (world coordinates; for notebook pages origin = page top-left, page is 800 × 1131 units = A4)
```js
{ id, type:'stroke', tool:'pen'|'highlighter', color:'#1C1C1E', size:3,
  points:[[x,y,pressure], ...],  // pressure 0..1; numbers rounded to 2 dp before saving
  sim:true,                      // present when made by finger/mouse: pressure ignored (simulatePressure) on every render
  bbox:[minX,minY,maxX,maxY] }   // includes half the stroke width

{ id, type:'text', x, y, w, text:'plain text with \n', color:'#1C1C1E',
  fontSize:20 /* ≥16 */, font:'sans'|'serif'|'mono'|'round', h, bbox:[...] }   // h/bbox computed by the engine's layoutText

{ id, type:'image', x, y, w, h, src:'data:image/...', bbox:[...] } // src downscaled ≤ 1600px
// bbox (and text h) are engine-owned: the engine recomputes them on load()/commit and never trusts stored
// values; the app never computes or edits them.
```
Constants exported from `js/canvas/constants.js` (Builder A owns, Builder B imports):
```js
export const PAGE_W = 800, PAGE_H = 1131;
export const PAPER_STYLES = ['blank','lined','narrow','grid','dotted','cornell'];
export const PAPER_COLORS = { white:'#FFFFFF', cream:'#FBF6E9', dark:'#1E1F24' };
export const BOARD_BACKGROUNDS = ['dots','grid','blank'];
export const ZOOM = { page:{min:0.25, max:6}, board:{min:0.1, max:10} }; // zoom = screen px per world unit
export const INK_COLORS = ['#1C1C1E','#3B5BDB','#E03131','#2F9E44','#F08C00','#9C36B5','#0C8599','#FFFFFF'];
export const HIGHLIGHT_COLORS = ['#FFE066','#8CE99A','#74C0FC','#FFA8A8','#E599F7'];
export const SIZES = { pen:[1.5,3,6], highlighter:[12,20,32], eraser:[10,24,48], text:[16,22,32] };
// Units: pen/highlighter/text = WORLD units; eraser = SCREEN px diameter (radius_world = size/2/zoom);
// text fontSize is never < 16 (iOS input-zoom floor). Selection handles/hit slop are SCREEN px (≥44).
export function newId() { /* randomUUID with fallback, see §3 */ }
```

## 4. Engine contract (Builder A) — `js/canvas/engine.js`

```js
export class CanvasView {
  constructor(container: HTMLElement, opts: {
    mode: 'page' | 'board',
    page?: Page,                 // the Page record (items, paper). Engine must NOT mutate the caller's
                                 // object; it keeps its own working copy (structuredClone).
    background?: 'dots'|'grid'|'blank',    // board mode only
    onChange?(meta: {reason:string, pageId:string}),  // after every committed change (stroke end,
                                 // erase end, move, text commit, undo/redo, insert). NO items payload (a deep
                                 // copy per stroke is too slow): the app debounces, then calls getItems().
                                 // pageId = id of the page currently loaded (guards against late saves).
                                 // Not fired by load(), setPaper(), setBackground() (app owns those fields).
    onViewChange?(view: {x, y, zoom}),     // after pan/zoom (throttled ≤ 10/s)
    onHistory?(state: {canUndo:boolean, canRedo:boolean}),
    onPencilDetected?(),         // first time a pointerType==='pen' event is seen
    onToolRequest?(tool:string), // e.g. engine asks app to switch tool (optional use)
  })

  setTool(tool: 'pen'|'highlighter'|'eraser'|'lasso'|'text'|'hand'): void
  getTool(): string
  setToolOptions(tool, opts: { color?:string, size?:number, eraseMode?:'stroke'|'area', font?:string }): void
  setPencilOnly(on: boolean): void   // true → finger never draws, one finger pans
  setTwoFingerUndo(on: boolean): void // default true; also suppressed while a pen is down / <1 s after it lifts
  setInsets({top,right,bottom,left}): void // CSS px of the container covered by the app's glass bars/dock.
                                     // Used for fitWidth/resetView/clamping/centring inserts; ink still shows under them.
  setPaper(paper): void              // page mode, and board mode (only paper.color matters there)
  setBackground(bg): void            // board mode
  load(page: Page): void             // swap page. Order: commit open text edit & cancel any in-progress
                                     // stroke (firing onChange for the OLD page), then swap; clears
                                     // history/selection; then page mode → fitWidth, board → resetView (the
                                     // app may call setView() right after to restore a saved view).
                                     // Keeps tool settings. Does not fire onChange.
  getItems(): Item[]                 // deep copy (structuredClone; fine on iPadOS 17+). Call at save time only.
  isBusy(): boolean                  // true while a pointer is down / gesture / text edit (app defers thumbnails)

  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean
  insertImage(src: string, naturalW: number, naturalH: number): void  // centred in the visible area (inside insets),
                                     // ≤60% of its width, selected. (Engine owns decode, bbox, id.)
  insertText(): void                 // new empty text box centred in view, focused for typing
  deleteSelection(): void
  clearSelection(): void

  getZoom(): number
  setZoom(z: number, opts?: {animate?:boolean}): void  // keeps view centre fixed
  zoomBy(factor: number): void
  fitWidth(): void                   // page mode: page width fills container minus 24px margins
  resetView(): void                  // page: fitWidth + scroll to top; board: zoom 1 centred on content/origin
  getView(): {x, y, zoom}; setView(v): void

  resize(): void                     // engine also observes its container with ResizeObserver
  destroy(): void                    // remove listeners, DOM, observers
}

// Pure render helpers (no DOM in the page needed) — used for thumbnails, PNG export, PDF:
// Async because image items must be decoded first (the sync version would export blank images). Callers
// should `canvas.width = canvas.height = 0` after use (Safari leaks canvas memory). Output ≤16M px, ≤4096 px/side.
export async function renderPageToCanvas(page: Page, opts:{ scale?:number, width?:number, background?:boolean })
  : Promise<HTMLCanvasElement>   // page mode: full A4 page incl. paper. width overrides scale.
export async function renderBoardToCanvas(page: Page, opts:{ maxSize?:number, background?:'dots'|'grid'|'blank', padding?:number })
  : Promise<HTMLCanvasElement>   // board: bbox of all items (or a blank 800×600 if empty); fill from page.paper.color
// Safari cannot encode WebP (toDataURL('image/webp') silently returns PNG) → thumbnails are JPEG (opaque
// anyway): quality 0.78, 480px wide (retina-sharp for ~200pt cards), ≈20–30 KB.
export async function makeThumbnail(page: Page, kind:'notebook'|'whiteboard'): Promise<string> // 'data:image/jpeg;...' ≤480px wide
```

### Engine behaviour requirements
**DOM structure** inside `container` (engine sets `container.classList.add('cv-root')`):
canvas for background+committed items, canvas for live stroke/lasso, absolutely positioned overlay
`<div class="cv-overlay">` for text editing, selection box & handles and the selection context menu.
The container is full-bleed (the app's glass bars float over it; see `setInsets`).
**Backing store**: iOS Safari returns a blank canvas above 16,777,216 px per canvas and kills the tab when
total canvas memory is high, so `dpr = min(devicePixelRatio, 2)` and the **sum of both canvases' backing
pixels ≤ 12M** (lower dpr, not below 1, until it fits). Pointer → world uses
`container.getBoundingClientRect()` (never raw clientX/Y): `world = view.xy + (client - rect.topLeft)/zoom`.

**Input (Pointer Events only)**: `touch-action:none` on root; `preventDefault` on `pointerdown` and
`touchstart` (passive:false) **only when the target is a canvas** — never for `.cv-overlay` controls, the
textarea or context-menu buttons (it would kill their taps, caret and focus); plus Safari
`gesturestart/gesturechange` (on iPad they fire next to pointer events: ignore them for zoom while touch
pointers are active; on desktop Safari they are the trackpad-pinch source: use `e.scale` + `clientX/Y`).
Also `contextmenu`/`selectstart` preventDefault and `-webkit-touch-callout:none; user-select:none` on the
root (stops the long-press magnifier/callout). `preventDefault` on pointerdown suppresses focus changes, so
**do not rely on `blur`**: the engine's own pointerdown commits any open text edit.
Use `getCoalescedEvents()` when available (feature-detect), `setPointerCapture` on draw start.
- Draw only between `pointerdown` and `pointerup`. Apple Pencil **hover** (M2+/Pro iPads) sends `pointermove`
  with pointerType 'pen' and `buttons===0`: ignore it for drawing (may only move the eraser cursor).
- `pointerType==='pen'`: always uses the active tool. First pen `pointerdown` → `onPencilDetected()`. A pen
  `pointerdown` cancels any in-progress touch stroke/gesture (palm landed first). Pressure: `e.pressure`
  clamped to [0.05,1], trusted for pen only (Safari gives 0/constant for fingers, 0.5 for mouse).
- `pointercancel`: touch → discard that stroke, no history entry; pen → commit what exists (iPadOS cancels
  on system interruptions; never lose handwriting).
- `touch`: 1 finger = active tool (unless pencilOnly or tool==='hand', then pan). 2 fingers = pinch-zoom +
  pan (focal point stays under fingers). If a 2nd finger lands within 150 ms of the 1st and the 1st has
  moved < 10px, cancel the in-progress stroke (no ink left behind). Pinch maths: zoom = initialZoom ×
  (current finger distance / initial distance), and the world point under the initial midpoint stays under the
  current midpoint (never incremental deltas — they drift). Two-finger tap (both up within 250 ms, little
  movement) = undo, only if `twoFingerUndo` is on and no pen was down in the last 1 s (a resting palm must not
  undo work). Three-finger tap = redo, best-effort only (iPadOS claims 3-finger gestures for its own
  copy/paste/undo bar); the redo button is the primary path.
- `mouse`: left = tool; middle or space+drag = pan; wheel = pan (normalise `deltaMode`); ctrl/⌘+wheel
  (Chrome/Firefox trackpad pinch) = zoom at cursor.
- Keyboard (ignore events whose target is inside input/textarea/select/[contenteditable]/[role=dialog]): ⌘/Ctrl+Z undo, ⇧⌘Z / Ctrl+Y redo, Delete/Backspace deletes
  selection, Escape clears selection. P/H/E/L/T = pen/highlighter/eraser/lasso/text (call onToolRequest).
- Palm rejection: while a pen is down, ignore touch pointers. Once a pen is seen and pencilOnly is on,
  touches never ink.

**Pen**: perfect-freehand `getStroke` with `{size, thinning:0.6, smoothing:0.5, streamline:0.45,
simulatePressure: !!stroke.sim, last: false while live / true on commit}`; real pressure for pen; finger/mouse
strokes get `sim:true` (pressure stored as 0.5) so a reload renders identically. Drop samples closer than
0.75 screen px (0.75/zoom world units) to the previous one (at 1000% raw samples are far denser than useful).
Cache a `Path2D` per stroke (keyed by id) in world coordinates; invalidate when points change. When
`size*zoom < 1`, also `stroke()` the outline with `lineWidth = 1/zoom` so thin pen never vanishes at low zoom.
Live stroke drawn on the live canvas each animation frame. On pointerup the stroke is committed and the **main
canvas is fully redrawn** (pass order must hold: pens stay under text, highlighters under pens, so drawing
over incrementally is wrong); clear the live canvas in the same frame *after* the main redraw (no flicker).

**Highlighter**: constant width, `lineCap:'round'`, `lineJoin:'round'`, a single path stroked with
`globalAlpha 0.35` (so it does not darken where it overlaps itself); always rendered *beneath* pen strokes
and text (render pass order: paper → images → highlighter strokes → pen strokes → text; `items` array order
is the z-order *within* a pass). Straight-line assist: if the pointer stays within 2 screen px for ≥ 500 ms
**while still down**, preview a straight line from the start point; it is committed on pointerup.

**Eraser**: mode `'stroke'` (default) deletes any stroke whose outline is within the eraser radius of the
pointer path. Mode `'area'` splits strokes, removing only points within the radius (creates new strokes).
Eraser never deletes text or images. Radius is `SIZES.eraser/2/zoom` world units (constant on screen);
pre-filter by bbox. Show a circular eraser cursor while erasing. One history entry per
gesture.

**Lasso**: freeform dashed path; on release select items whose bbox centre is inside the polygon, or ≥ 50%
of stroke points inside. Show a selection rectangle with a squircle-cornered dashed outline, a resize
handle at bottom-right (uniform scale), drag inside to move. Handles/menu are positioned in screen space with
≥44×44 px hit areas at every zoom. While dragging/resizing, render the selection under a temporary canvas
transform and mutate points/rebuild Path2D only on release. Context menu (floating pill above the
selection): **Delete · Duplicate · Colour ▸ (INK_COLORS swatches) · Copy**. Paste via ⌘V or a
"Paste" item when the menu is opened by tapping empty space after Copy (in-memory clipboard is enough).
Tapping an image or text box with the lasso tool selects it directly.

**Text**: tap with text tool → creates a text box at that point (w = 320 world units) and focuses an
`<textarea>` (plain text only, auto-growing, `autocapitalize=off autocorrect=off spellcheck=false`; no
contenteditable) placed in the overlay. **Never set textarea font-size = fontSize × zoom**: iOS zooms the
whole page when focusing an input with computed font-size < 16px. Lay the textarea out at world scale
(`font-size:{fontSize}px; width:{w}px; transform-origin:0 0; transform:translate(sx,sy) scale(zoom)`) so the
computed size stays ≥ 16. **Create and `focus({preventScroll:true})` it synchronously inside the
pointerup/click handler (or inside `insertText()`, which the app calls from a tap)** — iOS only raises the
keyboard for focus() in the same user-gesture task, never from rAF/setTimeout/await.
The iOS keyboard does not shrink the layout viewport (`100dvh` ignores it); it overlays the bottom and pans the
*visual* viewport. While editing: listen to `visualViewport` resize/scroll, treat the region below
`visualViewport.height + offsetTop` as an extra bottom inset, pan the engine view so the caret line stays
≥ 24px above it, and `window.scrollTo(0,0)` if the window scrolled (root is `position:fixed`).
Tap an existing text item with the text tool → edit it. Tap outside (engine pointerdown) / Escape /
page hidden commits; empty text → removed. Text box has a drag handle (move) and a right-edge width handle
(44px hit areas). Committed text is rendered on the canvas so thumbnails/exports match; the item being edited
is not drawn on the canvas while its textarea is open. **One engine-internal `layoutText(item, ctx) → {lines,
h}`** (canvas `measureText`; `pre-wrap` semantics: break at spaces, hard-break words longer than `w`,
line-height 1.35 × fontSize, same font string) is the only source of text `h` and `bbox`; the textarea uses
`white-space:pre-wrap; overflow-wrap:break-word; line-height:1.35; padding:0; border:0` so editing and
committed wrapping agree.
Fonts: sans = `-apple-system, "SF Pro Text", system-ui, sans-serif`; serif = `ui-serif, "New York", Georgia, serif`;
mono = `ui-monospace, "SF Mono", Menlo, monospace`; round = `ui-rounded, "SF Pro Rounded", system-ui`.

**Images**: rendered with `drawImage`; decoded `HTMLImageElement` cache by item id, LRU ≤ 12 decoded
(1600px² ≈ 10 MB each; evict off-screen ones). Render helpers `await` decode before drawing. Selectable/movable/
resizable via lasso.

**Hand**: one-pointer pan.

**Viewport**: `screen = (world - {x,y}) * zoom` where `{x,y}` is the world point at the container's
top-left (container-relative CSS px). `setInsets` shrinks the *usable* rect: fitWidth/resetView/centring/
clamping use the rect inside the insets (page top is not hidden under the glass bar). Page mode: page
centred horizontally when narrower than the rect; clamp so the page cannot be pushed fully off-screen
(keep ≥ 80px visible); grey desk background around the page with a soft page shadow; `resetView()` is
exposed for the app's "fit" button. UI zoom % = `round(zoom*100)` in both modes. Board mode fills with
`PAPER_COLORS[page.paper.color]` (+ same ink swap); unlimited pan, but clamp world coords to ±50,000 units
(float precision at 1000%); background
pattern (dots/grid) drawn in screen space with spacing that adapts to zoom (fade between levels) so it
never becomes a dense mess at 10% nor huge at 1000%.
Rendering: re-render only on change via `requestAnimationFrame` (dirty flag). Cull items whose bbox is
off-screen. Zoom feel: the settled image must always be a fresh vector render at the current zoom (never a
scaled bitmap — 1000% must be crisp). During pinch/animated zoom: if the last full redraw took > 10 ms,
CSS-transform the existing canvas bitmaps for the gesture and do one crisp redraw ~100 ms after the last
change; otherwise redraw every frame. Zoom limits are soft while pinching (≤10% overshoot, spring back on
release). Image smoothing off above 400% zoom is optional.

**History**: command stack (max 200): add items / remove items / replace items (before→after). Undo/redo
emit `onChange` and `onHistory`.

**Paper rendering** (page mode, world units): `lined` = rules every 32 units starting y=120, left margin
line at x=88 (red, 0.6 alpha); `narrow` = rules every 24, starting y=96; `grid` = 25-unit squares;
`dotted` = dots every 25; `cornell` = header line y=110, cue column line x=220, summary line y=931, rules
every 32 between; `blank` = nothing. Rule colour: light blue `rgba(80,130,200,0.28)` on white/cream,
`rgba(255,255,255,0.12)` on dark. Paper colours from PAPER_COLORS. On dark paper, ink colour `#1C1C1E`
is displayed as `#F2F2F7` (display-only swap; stored value unchanged) and vice versa for white ink on
light paper.

**Styling** (`css/canvas.css`, classes prefixed `cv-`): use variables from `css/tokens.css`.

**Playground**: `tests/playground.html` — a bare page that mounts a CanvasView in page and board mode with
a minimal tool bar, for the engine's own testing.

## 5. App (Builder B)

### `js/store.js`
```js
export async function openDB()
export async function listDocs(kind?: 'notebook'|'whiteboard'): Promise<Doc[]>   // sorted updatedAt desc
export async function getDoc(id), putDoc(doc), deleteDoc(id)          // deleteDoc also deletes its pages
export async function getPage(id), putPage(page), deletePage(id)
export async function getPages(docId): Promise<Page[]>               // ordered by doc.pageIds (export: iterate
                                                                      // one page at a time, don't hold all in memory)
export async function getThumb(pageId), getThumbs(docId): Promise<{[pageId]:dataUrl}>, putThumb(pageId, docId, dataUrl)
export async function getViewState(pageId), putViewState(pageId, {x,y,zoom})   // meta rows 'view:<pageId>'
export async function createNotebook(partial): Promise<Doc>          // also creates first page
export async function createWhiteboard(partial): Promise<Doc>        // creates its single page
export async function addPage(docId, afterPageId?, paper?): Promise<Page>
export async function duplicatePage(pageId), duplicateDoc(docId)
export async function movePage(docId, fromIndex, toIndex)
export async function getSettings(), saveSettings(partial)
export async function exportAll(): Promise<Blob>   // JSON {app:'flash-notes', version:1, exportedAt, docs, pages}
                                                    // built as Blob parts per doc/page (no single giant JSON.stringify)
export async function importAll(fileOrBlob, {mode:'merge'|'replace'})  // merge: skip/rename id clashes
export async function requestPersistence(): Promise<boolean>         // navigator.storage.persist()
export async function storageEstimate(): Promise<{usage, quota}>
```
All writes in transactions (resolve on `tx.oncomplete`, not request success); every `putPage` also bumps the
parent doc's `updatedAt`. `deletePage/deleteDoc` also delete thumbs and view rows. `putThumb/putViewState`
never touch `updatedAt`. `listDocs` returns docs only (no pages); the Library gets whiteboard previews via
`getThumb(doc.pageIds[0])`.

### Views (single page app, hash router)
- `#/` → **Library**. `#/nb/<docId>/<pageIndex>` → notebook editor. `#/wb/<docId>` → whiteboard editor.
- Back button / swipe-back in standalone mode must work (hash changes).

**Library**: large iOS-style title "Flash Notes" with a subtitle like "12 notebooks · 3 whiteboards"; a
segmented control (squircle) **Notebooks | Whiteboards**; search field (filters by title); settings gear.
Grid of cards (responsive: 2 cols iPhone, 4–5 iPad landscape):
- Notebook card = realistic notebook cover: squircle-ish rounded rect (right corners more rounded, left
  side a darker "spine" strip with subtle binding), cover colour + pattern (CSS gradients) + optional photo,
  emoji sticker, title label on a little white squircle label; small "12 pages · edited 2h ago" caption under it.
- Whiteboard card = squircle tile with the board thumbnail.
- First card is "+ New notebook" / "+ New whiteboard".
- Long-press (500 ms) or "⋯" button on a card → action sheet: Open, Rename, Edit cover (notebooks),
  Duplicate, Delete (with confirm).
- Opening animates (scale up from the card).
- Empty state with friendly illustration (CSS/SVG) and a big "Create your first notebook" button.

**Cover editor** (bottom sheet on iPhone, centred modal on iPad): live cover preview; title field; 12
colour swatches (+ custom `<input type=color>`); pattern chips; emoji chips (📘📗📕📙📓🧠🌍⚖️📈✏️🎓⭐ + none);
"Choose photo" (file input, downscale to ≤ 800px JPEG 0.85); default paper style & colour for new pages
(little paper previews). Used for create and edit.

**Editor** (notebook & whiteboard share one component):
- Top glass bar (backdrop blur, safe-area aware): ‹ Library · title (tap to rename) · for notebooks:
  "Page 3 of 12" + pages button (opens page drawer) + "+" add page · undo/redo · "⋯" menu.
- **Tool dock**: floating squircle glass pill centred under the top bar: Pen, Highlighter, Eraser, Lasso,
  Text, Image, Hand. Selected tool has a filled squircle backdrop with a spring animation. Tap the active
  tool again → popover with its options: colour swatches (pen: INK_COLORS + custom; highlighter:
  HIGHLIGHT_COLORS), 3 size dots (SIZES), eraser mode toggle (Stroke / Precise), text font + size.
  Next to the dock: 3 "quick colour" dots showing the pen's recent colours.
- Zoom pill (bottom-right): − · "125%" (tap → fit/reset) · +. Shows the % of zoom.
  Notebook pages: also a "magnifier" button that zooms to 300% around the centre for detail work.
  Whiteboard: 10%–1000%.
- Notebook page navigation: prev/next chevron buttons at bottom-centre ("‹ 3 / 12 ›"), keyboard ←/→
  (when not typing), and the **page drawer** (side sheet) with thumbnails: tap to go, drag to reorder,
  per-page menu: duplicate, change paper, delete. "+ Add page" at the end (uses notebook default paper).
- "⋯" menu: Paper (style & colour for this page — notebooks) / Background (whiteboard), Insert image,
  Pencil-only drawing toggle, Export page as PNG, Export notebook as PDF, Duplicate page, Delete page.
- Pencil detection → toast "Apple Pencil detected — fingers now scroll. Change in ⋯" and pencilOnly on
  (persist in settings) — only if `settings.pencilOnly` was never set; never re-enable after the user turned
  it off. The editor keeps ONE CanvasView and uses `load()` when changing page (not a new instance per page).
  Pass `setInsets` from the measured glass-bar/dock heights (ResizeObserver) so the page is not hidden under them.
- Autosave: `onChange(meta)` → debounce 400 ms → `putPage({...pageRecord, items: view.getItems()})`; ignore a
  change whose `meta.pageId` ≠ the loaded page. Thumbnail: `makeThumbnail` debounced 2500 ms, re-deferred while
  `view.isBusy()`, saved with `putThumb`. Viewport: `onViewChange` → `putViewState` debounced 1000 ms (never
  `putPage`: pan/zoom must not rewrite images or reorder the Library). Flush immediately (call `getItems()` +
  `putPage`, do not await — iOS may suspend the page, so the 400 ms debounce is what really protects data) on
  `visibilitychange`(hidden), `pagehide`, route change and page change (order: flush old → `load(new)`).
  Request persistence automatically after the first successful save. Small "Saved" indicator in the top bar.
  The app owns the Page record (paper etc.); the engine only owns `items`.
- Image insert: file input `accept="image/*"`, downscale ≤ 1600px, JPEG 0.85 (PNG if the source has
  transparency: png/webp/gif), `view.insertImage`.
- Export PNG: `await renderPageToCanvas(page,{scale:2})` / `renderBoardToCanvas` → `canvas.toBlob` → `File`.
  Sharing is **two-step**: Safari rejects `navigator.share` (NotAllowedError) if transient user activation
  expired while rendering. So: render, then show a "Share / Save" button whose tap calls
  `navigator.share({files})` (check `navigator.canShare({files})`); ignore `AbortError` (user cancelled — do not
  fall back); fallback chain: `<a download>` with a blob URL → `window.open(blobUrl)`; revoke after 60 s.
- Export PDF (notebooks): **do not use `window.print()`** — it is unreliable/no-op in iOS standalone PWAs and
  the print-sheet detour is poor UX. Generate a real PDF in pure JS: `js/ui/pdf.js`
  `buildPdf(jpegBlobs:{blob,w,h}[]): Promise<Blob>` writing a minimal PDF-1.4 (catalog, pages tree, one A4
  595.28×841.89 pt page per image, `/Filter /DCTDecode /ColorSpace /DeviceRGB /BitsPerComponent 8` image XObject
  drawn with `q W 0 0 H 0 0 cm /Im0 Do Q`, correct xref **byte** offsets — assemble `Uint8Array` parts, never
  string lengths). Per page: `await renderPageToCanvas(p,{width:1654,background:true})` →
  `toBlob('image/jpeg',0.9)` → free canvas; one page at a time (memory). Show progress ("Page 3 of 12"), then the
  same two-step share/save button as PNG (`application/pdf`, filename `<title>.pdf`).

**Settings sheet**: Appearance (System / Light / Dark), Pencil-only drawing, Storage ("Using 12 MB ·
saved on this device" + "Keep my notes safe" → requestPersistence; when not running standalone on iOS show
"Add to Home Screen to protect your notes": Safari deletes site data after 7 days without use for ordinary
tabs, installed home-screen apps are exempt — also show a one-time banner for this), "Two-finger tap to undo"
toggle (`twoFingerUndo`), Backup (Download backup .json) /
Restore (file input, merge or replace confirm), About (free forever, no account, made by students).

**Shared UI primitives** (`js/ui/`): `squircle.js` (see §6), `sheet.js` (modal/bottom sheet with drag-to-
dismiss, focus trap, Escape), `menu.js` (popover/action sheet anchored to a button), `toast.js`,
`dom.js` (tiny `h(tag, props, ...children)` helper). Spring animations via CSS
`transition-timing-function: var(--spring)`.

**PWA**: `manifest.webmanifest` (name "Flash Notes", short_name "Flash Notes", display standalone,
start_url "./", scope "./", theme/background colours, icons `icons/icon-192.png`, `icons/icon-512.png`,
`icons/icon-maskable-512.png`). `index.html` meta: viewport `width=device-width, initial-scale=1,
viewport-fit=cover` (add `user-scalable=no`, but iOS ignores it: the real protection is the engine's gesture
handling + `touch-action:manipulation`), `apple-mobile-web-app-capable`, `mobile-web-app-capable`,
`apple-mobile-web-app-title`, status bar style `black-translucent` (verify legibility in light mode on device;
fall back to `default` if the clock is unreadable over the light top bar), `apple-touch-icon` →
`icons/apple-touch-icon.png` (180×180, fully opaque — iOS fills transparency with black), theme-color for
light/dark. Manifest also has `"id":"./"`.
`sw.js`: `const VERSION='v1'`, `CACHE='fln-'+VERSION`. Install: fetch every precache URL with
`new Request(url,{cache:'reload'})` (GitHub Pages sends max-age=600; plain addAll can cache stale files) into
the new cache, atomically (all or nothing). Precache list = Builder B's files + every URL in
`js/canvas/files.json` (**Builder A must maintain this JSON array of repo-relative paths of all `js/canvas/**`,
`css/canvas.css` and `vendor/` files**; sw.js fetches it at install) + `./` and `./index.html` (navigations fall
back to cached `index.html`, ignoreSearch). Cache-first for same-origin GET only; ignore non-GET and
cross-origin. Delete old `fln-*` caches on activate; `clients.claim()`. **No automatic `skipWaiting`**
(it would mix new modules with an already-running old page): on `message {type:'SKIP_WAITING'}` only. The app
shows "Update available — tap to reload"; the tap posts SKIP_WAITING, and a one-shot `controllerchange`
listener reloads (guard against reload loops). Call `registration.update()` on every `visibilitychange`→visible
(standalone apps are rarely cold-started). Releases = bump `VERSION`. Register with
`navigator.serviceWorker.register('./sw.js')` (default scope = `/flash-notes/`, correct for the sub-path); skip
registration when not on https/localhost.
`404.html` = copy of a redirect to `./`. `.nojekyll` empty file.

Body must not scroll/bounce in the editor (`position:fixed; inset:0; overscroll-behavior:none`).
Size full-screen layers with `position:fixed; inset:0` (not `height:100dvh`: iOS standalone keeps stale
heights after rotation and dvh ignores the keyboard); `env(safe-area-inset-*)` for bars. The engine relies on
its ResizeObserver, so it keeps working after rotation/Split View.

## 6. Design language (all builders)
- Tokens in `css/tokens.css` (Opus). Use them; do not hard-code colours except data colours.
- **Squircles**: `js/ui/squircle.js` exports `squircle(el, {radius, smoothing=0.6})` which uses a
  `ResizeObserver` to set `clip-path: path('…')` with a Figma-style smoothed-corner path (superellipse-ish)
  and `squircleAll(root=document)` that applies to every `[data-squircle="<radius>"]` element (also new
  ones, via MutationObserver). CSS fallback: `border-radius: var(--r-*)` (and progressive
  `corner-shape: squircle` inside `@supports (corner-shape: squircle)`). Because clip-path cuts shadows,
  put shadows on a wrapper with `filter: drop-shadow(...)` — for OPAQUE surfaces only (covers, cards, sheets).
  **Never put a `backdrop-filter` element inside (or on) a wrapper with `filter`, `opacity<1`, `mask` or
  `will-change:filter/opacity`**: WebKit makes that wrapper the backdrop root and the blur samples nothing.
  Glass bars/dock/zoom pill use plain `border-radius` + `box-shadow` (no clip-path), always with both
  `-webkit-backdrop-filter` and `backdrop-filter`. `corner-shape` is Chromium-only: in Safari the JS path is
  the only real squircle. Keep blur ≤ 24px and glass areas small (blur over a live canvas costs GPU).
  The engine may use plain `border-radius` + `corner-shape` for its small overlay UI.
- Look: iPadOS 18-like. System font stack, frosted glass bars (`backdrop-filter: blur(24px) saturate(180%)`
  with `-webkit-` prefix), soft layered shadows, generous spacing, large titles, accent `--accent`.
  Light: warm off-white background. Dark: near-black with elevated greys.
- Motion: spring (`--spring`), 220–420 ms; buttons scale to 0.94 on press; tool selection morphs.
- Rewarding touches: a little confetti-free "pop" scale on creating a notebook, satisfying page-turn
  slide when changing pages, a progress-ish "N pages written" on the notebook card.

## Contract changes
- 2026-11-11 (Sonnet review): **Thumbnails are JPEG, 480px wide**, not WebP/≤240px — Safari cannot encode WebP (`toDataURL('image/webp')` silently returns PNG). `makeThumbnail` returns `data:image/jpeg`.
- 2026-11-11: **`onChange(meta)` no longer passes `items`**; meta gains `pageId`. App calls `getItems()` at save time. Not fired by `load/setPaper/setBackground`. Prevents per-stroke deep copies and saving page A's items into page B.
- 2026-11-11: `load()` semantics defined (commit/cancel old, then swap, reset view, no onChange). New engine API: `setInsets`, `setTwoFingerUndo`, `isBusy`. Engine is full-bleed under the glass bars.
- 2026-11-11: `renderPageToCanvas/renderBoardToCanvas` are now **async** (image decode); callers free canvases after use.
- 2026-11-11: Data model: `thumbs` store added; `Page.thumb` and `Page.view` removed (view → `meta` `view:<pageId>`); stroke `sim` flag added; text `h` added; bbox/h are engine-owned; image limit 1600px; `newId()` in constants.js; `settings.twoFingerUndo`.
- 2026-11-11: Units pinned: eraser size = screen px, text fontSize ≥ 16 world units, handles/hit areas in screen px; pointer→world uses container rect.
- 2026-11-11: Text editing: textarea at world font-size with `transform: scale(zoom)` (never fontSize×zoom — iOS focus-zoom), synchronous focus in the gesture, visualViewport keyboard handling, single `layoutText` for wrapping/height, no reliance on blur.
- 2026-11-11: Input: `touchstart` preventDefault only on canvases; Pencil hover ignored; pen cancels touch strokes; pointercancel rules; hardened 2-/3-finger tap rules; pinch maths from initial state.
- 2026-11-11: Canvas memory: dpr ≤ 2 and both canvases ≤ 12M px combined (Safari 16.7M limit/tab kills); commit = full redraw to keep pass order; adaptive bitmap-transform zoom, vector re-render on settle; soft zoom limits; min on-screen stroke width.
- 2026-11-11: PDF export: `window.print()` removed; pure-JS `js/ui/pdf.js` (JPEG-in-PDF) + two-step share (user activation expires while rendering). PNG export uses the same share flow.
- 2026-11-11: Service worker: atomic versioned precache with `cache:'reload'`, `js/canvas/files.json` supplies Builder A's file list, no auto-`skipWaiting` (update on tap), periodic `update()`.
- 2026-11-11: Autosave: view saved separately and debounced (not `putPage`); thumbnails deferred while busy; flush is fire-and-forget; persistence requested after first save; "Add to Home Screen" nudge (Safari 7-day eviction applies to browser tabs only).
- 2026-11-11: UI: iOS input ≥16px, `touch-action:manipulation`, callout/selection off, no `<a>/<img>` cards, `inset:0` not `100dvh`; no `backdrop-filter` inside `filter`/opacity wrappers (glass uses border-radius + box-shadow, not clip-path).
- 2026-11-11: Whiteboard pages use `paper.color` for fill (style ignored); `setPaper` valid in board mode.
- 2026-11-11 (review pass): **Commit fast path** — a finished pen/highlighter stroke is painted straight onto the committed bitmap when it cannot change pass order (pen: no text bbox overlaps; highlighter: no text or pen bbox overlaps), otherwise the full redraw still runs. New engine API `commitPending()` (commits an open text box / stroke so `getItems()` is complete; the app calls it before menus, exports and the page drawer). Zoom within 0.2% of a hard limit snaps onto it (UI reads exactly 1000% / 10%). Store: `putPage` never re-creates a page that is no longer in its doc's `pageIds`; new atomic `patchDoc(id, fields)` replaces read-modify-`putDoc` for title/paper/background/cover; `saveSettings` merges synchronously (no lost keys).

---

# v1.1 — Shape recognition, Tidy ink, Pencil-to-text (spec by Opus, 2026-11-11; reviewed 2026-11-11)

Goal: messy drawing becomes neat without the student thinking about it, and it never destroys work —
every conversion is **one undo step** and offers a one-tap "keep my original".
Everything runs **on-device, offline, no network, no new runtime deps** (except one bundled OFL font).

**Global rules (apply to A, B, C):**
- New engine state lives in one controller, `js/canvas/smartink.js` (`class SmartInk`, owned by `CanvasView` as `view.smart`),
  which holds ALL timers, the pending-ink list, the pill and the morph effect. It exposes `cancel()` (clear timers, pill,
  pending list, effects) and is called from: `load()` (before `textEdit.commit()`), `destroy()` (before `destroyed = true`),
  `_commitPending()` (pagehide/hidden: cancel, never tidy in the background), `undo/redo`, `requestTool()` away from pen.
  Every timer callback must first check `view.destroyed` and a `pageSeq` captured when it was armed (`_setPage` increments it).
- Stroke items are immutable and tracked **by object identity** (`view.items.includes(item)`); never by id. Any `commit()` whose
  reason is not `'stroke'`/`'shape'`/`'tidy'` (erase, delete, move, colour, text, undo/redo, insert) clears the pending list.
- **"Keep original" is in-memory only** (no `raw` field in stored data): the pill closure holds `{added:[newItems], removed:[originalItems]}`.
  Tapping it does `view.commit(items, items.map(replace added→original), 'keep-original')` (a new history entry; undo returns to the
  converted version). The pill hides (and the closure is dropped) on: 3 s, any canvas pointerdown (NOT a pointerdown on the pill
  itself), any commit with another reason, undo/redo, `load`, `destroy`, tool change. If any `added` item is no longer in `view.items`
  by identity, hide the pill instead of acting.
- Pill DOM sits in `.cv-overlay` as a real `<button>` (`pointer-events:auto`, `aria-live="polite"` label); `input._down` already
  ignores non-canvas, non-handle targets, so it must not call `preventDefault` for the pill. Reduced motion: no morph, no pop.
- Persistence: **`normalizeItems` in `js/canvas/items.js` whitelists stroke fields and would silently strip `shape`/`uniform` on
  every load** (uniform lines would turn into tapered strokes after a reload). Builder MUST extend it: keep `uniform===true` and
  `shape` as `{kind: <one of the known kinds>}` only (drop anything else). `transformItem` already spreads, so move/resize/colour keep
  them; store only `kind` (no geometry meta - it goes stale after resize). Also check `js/store.js` / backup import-export validators
  and add a round-trip test (save → reload → `uniform` still true; backup export → import).

## A. Shape recognition — `js/canvas/shapes.js` (new, pure, Node-testable)

```js
export function recognizeShape(points /* [[x,y,p],...] world */,
  opts: { mode:'auto'|'hold', zoom:number, scale?:number /* median pen-stroke bbox diagonal, world, or undefined */ })
  : null | { kind, confidence /*0..1*/, points /* new [[x,y,p]] */ }
```
`recognizeShape` itself applies **all** gates for its `mode` (size, confidence, corner count, curve rejection) and returns `null`
below them, so the Node tests exercise the real false-positive behaviour. `opts.zoom` is only for the screen-size gate.
Kinds and output geometry (world units, sampled ~every 2 units, constant pressure 0.5, de-duplicated points):
- `line` — start→end. Snap to exactly horizontal/vertical within 6°, to 45° within 4°.
- `arrow` — **only** this single-stroke pattern: shaft to the tip, then a barb (back along ~20–50° off the shaft), back to the tip, the
  second barb (corner sequence start, tip, b1, tip, b2); each barb 10–35% of the shaft. Two-stroke arrowheads are **out of scope**.
  Output: clean shaft + symmetric 30° head, head length = clamp(12% of shaft, 10, 40). (In `hold` mode the 3-point form
  start, tip, b1 is also accepted.)
- `axes` — an "L" (one stroke, corner at any of the four positions) with corner angle 70–110° and **both arms ≥ 80 units** and each
  ≥ 35% of the longer arm. Output: a 2-segment polyline with a true 90° corner; axis-aligned if the L is rotated < 12°.
- `polyline` — open, 2–4 straight segments joined by **localized** corners. Accept only if: every segment is straight
  (max deviation ≤ 3% of its length), every segment ≥ 50 units, each corner's turning (≥ 25°, ≤ 140°) happens within a window ≤ 15%
  of the stroke length, and the stroke is **not a zig-zag** (no two consecutive turns > 110° in alternating directions: "N", "Z",
  "W", "M", cross-out scribbles stay raw). Segments within 6° of horizontal/vertical snap.
- `circle` / `ellipse` — closed (end within 20% of perimeter of start), total turning 300–450° (a spiral/multi-loop scribble is
  rejected), ≤ 1 corner. Circle if axis ratio ≥ 0.85 (radius = mean distance), else ellipse, axis-aligned if within 10°.
- `rectangle` / `square` — closed, 4 corners 75–105°, axis-aligned within 10°, square if sides within 12%.
- `triangle` — closed, 3 corners.
- **Curves are never converted**: open strokes with smooth, spread-out curvature (supply/demand curves, S-curves, parabolas, sine
  waves, bell curves, arcs, loops) return `null`. There is no `arc` kind. `line` requires max perpendicular deviation ≤ **3% of
  chord** in `auto` (≤ 8% in `hold`, see below); an open stroke with total turning > 25° and no localized corner is a curve → `null`.

Pipeline (standard): resample to N equidistant points → closed/open test → corner detection (ShortStraw / curvature + Douglas–Peucker)
→ per-kind fit error normalised by size → best kind. Cap input at 4000 points (resample first); must run < 5 ms.

**Gates** (inside `recognizeShape`):
| | `auto` (on pointerup) | `hold` |
|---|---|---|
| size | bbox diag ≥ **90** world (line/arrow/axes/polyline) or ≥ **120** (closed shapes) **and** ≥ `max(…, 4 × opts.scale)` when `scale` is given **and** diag ≥ **100 screen px** (`diag·zoom`) | diag ≥ 40 world and ≥ 40 screen px |
| confidence | closed ≥ 0.85; line/axes/polyline/arrow ≥ 0.9 | ≥ 0.7 |
| corners | > 6 detected corners → `null` | same |

(The screen-px and `scale` gates matter: when the student is zoomed out, ordinary handwriting is > 90 *world* units tall.)

**Triggers** (pen tool only; the highlighter keeps ONLY its existing hold-for-straight-line behaviour, unchanged):
1. **Hold to snap** (always on, any size passing the hold gate): pointer within 2 screen px for ≥ **500 ms** (reuse the existing
   `HOLD_MS`/`HOLD_PX` constants - one value for pen and highlighter) while down → `recognizeShape(c.pts, {mode:'hold'})`.
   - Found → the live stroke becomes a live preview of the shape (scale "pop"), `c.snapped = {kind, points}`. **After a snap `_add`
     must stop appending raw points**: for `line`/`arrow` the end point follows the pointer (re-fit start→pointer with the angle snaps,
     arrow head re-derived); for every other kind further movement is ignored until pointerup. Lifting commits the shape.
   - Not found → **do nothing for the pen** (the stroke stays free-form). The existing straight-line fallback is highlighter-only;
     the old spec text implied pen had one - it does not, and adding one would flatten every curve the student pauses on.
2. **Auto shapes** (setting `autoShapes`, default **on**): on pointerup of a pen stroke only (one pointer-down→up; not highlighter,
   eraser, lasso) run `recognizeShape(c.pts, {mode:'auto', zoom, scale})`, where `scale` = median bbox diagonal of the last 30 pen
   strokes (non-shape) within 600 world units of the stroke, or `undefined`. **Letter-in-word guard:** skip auto conversion if the
   previous pen stroke ended < 1.5 s ago and its bbox is horizontally within 0.75 × this stroke's diag and 0.5–2× its height
   (a big "O"/"L" inside a heading stays handwriting). Underlines and cross-out lines are straight `line`s and may be straightened.
   Convert **before** committing: the raw stroke is never added to `items` - commit only the shape via `addStroke` (fast path is fine,
   a shape is an ordinary pen stroke).

**Result item**: `{id:newId(), type:'stroke', tool:'pen', color, size, points:<shape points>, shape:{kind}, uniform:true, bbox}`.
`uniform:true` strokes render with perfect-freehand `thinning:0, simulatePressure:false`: add the flag to the `strokePath` cache key
path in `strokes.js`/`penPath` (the live preview uses the same options so preview == committed). Area-eraser and lasso treat them as normal strokes.

**Feedback**: on conversion run a ~180 ms morph (raw stroke fading out on the live canvas over the committed shape; the fx layer is
owned by `SmartInk` and cancelled by `cancel()`, new pointerdown, load, destroy), plus the glass pill above the shape:
"◯ Circle · Keep original" (labels: Line, Arrow, Axes, Lines, Circle, Ellipse, Rectangle, Square, Triangle). Engine exposes
`setToolOptions('pen', { autoShapes:boolean, autoTidy:boolean })` (extend the existing function; ignore non-boolean values).

## B. Tidy ink — `js/canvas/tidy.js` (pure, Node-testable) + the auto trigger in `smartink.js`

```js
export function tidyStrokes(strokes /* pen strokes, plain items */, opts:{ paper?:{style}, mode:'manual'|'auto', bounds?:[x0,y0,x1,y1],
                            obstacles?:[bbox] /* text/image/shape bboxes: strokes overlapping them are left alone */ })
  : { strokes /* same length & order as input; new items with NEW ids; untouched strokes returned as the same object */, changed:boolean }
```
Makes handwriting neater **while keeping it the student's handwriting** (no recognition). Never changes `size`, `color`, `tool`, `sim`.
1. **Group** into lines of writing: cluster by vertical overlap of bboxes, then split each cluster wherever the horizontal gap between
   consecutive strokes > 4× median stroke height (a diagram label next to text is its own group). A group is tidied only if it has
   **≥ 4 strokes** and width ≥ 4× median height; single labels ("D₁", "Q", axis names, tally marks, hatching) are untouched. Drop
   strokes taller than 3× the median height, strokes with `shape`/`uniform`, strokes overlapping `obstacles`.
2. **Baseline**: robust linear fit through stroke bottoms/lower envelope → rotate the line about its left end to horizontal. Cap rotation
   at ±8°. On `lined`/`narrow`/`cornell` paper snap the baseline to the nearest rule if within 40% of rule spacing.
3. **Words**: split by gaps > 0.6× median letter height → even word spacing toward the median gap.
4. **Size**: scale each word about its baseline-left toward the line's median x-height (blend 60%, clamp 0.8–1.25).
5. **Slant**: estimate from near-vertical sub-segments, shear toward the median slant (blend 70%, clamp ±15°). Do not force upright.
6. **Smooth**: resample + light Chaikin/moving-average (preserve corners via angle threshold), smooth pressure too.
Limits: no point moves > 25 units (if exceeded, scale the whole line's transform down proportionally, don't clip); in page mode
clamp results to `bounds` (page rect), skipping a group that would leave it. **Idempotent**: a second pass over its own output must
return `changed:false` (changed = any point moved > 1.5 units or baseline > 0.5°). The engine builds the new item array by mapping
`items → replacement` **in place** (z-order and indices preserved), `finalizeItem` on each, ONE `view.commit(items, next, 'tidy')`.
Strength is **gentle**: it should look like a careful version of the same writing.

**Triggers**:
- **Manual**: lasso menu (selection.js) gains **"✨ Tidy"** (shown when the selection contains ≥ 1 pen stroke) → `tidyStrokes` on the
  selected pen strokes, one history entry, morph (not for > 300 strokes), selection re-set to the NEW ids, pill "✨ Tidied · Keep original".
  If nothing changed, button shows "Already neat" for 1 s and makes no history entry.
- **Auto-tidy** (setting `autoTidy`, default **on**). `SmartInk` records each committed pen stroke (not shape/highlighter, bbox height
  < 120 world) in `pending` (identity list). Tidy runs, over the pending strokes **except the line the pen is on**, when either:
  (a) a pen-down lands on a **new line** - `y > currentLine.baselineY + 1.2 × median stroke height` (on lined paper: in a different
  rule band) and not inside any pending stroke's bbox +16 units. The pen-down only *arms* the tidy: it runs in a 0-ms timeout after
  that new stroke's pointerup (never during the stroke, so the first stroke on the new line has no redraw hitch, and the new stroke is
  not in the snapshot taken at pen-down); or
  (b) the pen has been idle (up, **no Pencil hover `pointermove` and no pointerdown**) for **4 s** - this is the only path that
  tidies the last line; hover/any pen event restarts the timer. (1.2 s of the original spec was shorter than a normal pause to think
  and would shift ink under a student who resumes the same line.)
  At fire time, if `view.isBusy()` or `input.busy` or `selection.has()` or lasso/eraser active or `textEdit.active` or the tool is not
  pen: **re-arm 1 s** (don't drop), and cancel entirely if the pending list was cleared. Prune `pending` to items still in
  `view.items` first. One history entry per auto-tidy (⌘Z undoes only the tidy), no morph animation (just the redraw), small pill
  "✨ Tidied · Keep original". Auto-tidy never touches text/images or strokes overlapping them.
  The tidy `commit` uses the normal path → `onChange({reason:'tidy'})` → editor autosave: no new autosave code, but the editor's
  `onChange` must treat unknown reasons as dirty (it does).

## C. Pencil-to-text (Scribble) + neat handwriting font

### C1. What iPadOS Scribble needs, and the exact changes
Scribble is handled by the system text-input layer, not by pointer events: it works when the Pencil lands on a **visible,
focused-or-focusable editable element (`<textarea>`/`<input>`/`contenteditable`)** and nothing between Pencil and element swallows the
touch. The current code already gets several things right (keep them): `input._down` returns early for a `textarea` target (no
`preventDefault`, no `setPointerCapture`, no `penId`); `touchstart` is only `preventDefault`ed for canvas/handle targets;
`touchmove` and `selectstart` exempt `textarea`; the textarea has `user-select:text`. Required changes:
1. **Palm rejection must not close the box.** While the pen writes into the textarea, `penId` is null (the early return), so a resting
   palm/hand (touch pointerdown on the canvas, even in pencil-only mode, which goes through `_begin`) calls `textEdit.commit()` and
   kills the box mid-sentence. Fix in `input.js`: record `lastPen = now()` and `this.penNear` on **every** pen `pointerdown`/`pointermove`
   whose target is inside the root (incl. the textarea and Pencil hover); in `_touchDown`, `if (textEdit.active && now() - lastPen < 2000) { ignored.add(id); return; }`
   (touches are fully ignored, no commit, no pan). Finger taps still commit when the Pencil has been away > 2 s.
2. **Writing must be allowed to start slightly outside the text**: a pen-down on the bare canvas commits (and discards, if empty) the
   box. Make the editable area bigger than the text with real padding: for a **pen-created box** style the textarea
   `box-sizing:content-box; padding:P; margin:-P` with `P = 28 / zoom` world units (so 28 screen px), and set the minimum height
   `minH = max(2 × lineHeight, 96 / zoom)` as `c.minH` used for `ta.style.height` and the frame (`c.h = max(layoutH, minH)`), while
   the committed item's `h`/bbox still come from `layoutText` only. Text origin must not move (margin cancels padding) - add a test.
   The move/width handles must sit outside the padded rect (they `preventDefault` + capture on pen-down and would steal the Pencil).
   Place the new box so the tap point is inside the first line **and ≥ 28 screen px from the box's left/top edge**.
3. **Do not** add `inputmode="none"`, `readonly`, `-webkit-user-modify`, `pointer-events:none`, `user-select:none`, or `contenteditable`
   to the textarea or its wrapper (`.cv-text-edit` must stay `pointer-events:auto`). Keep `autocorrect/autocapitalize/spellcheck` off.
   No full-screen element (frame, glass, pill, toast) may overlap the textarea rect; `.cv-text-frame` stays `pointer-events:none`.
4. `root` `contextmenu` handler: add the `_isText` exemption (long-press/Scribble "select" menus) like `selectstart`.
5. **Do not rely on programmatic focus alone.** Keep the synchronous `ta.focus({preventScroll:true})` inside the pen `pointerup`
   (iOS raises the keyboard only from a gesture), but Scribble also works on an unfocused textarea, so the box must be hit-testable
   immediately. If the on-screen keyboard appears and covers the page when the Pencil is used, keep the existing `kbInset` logic;
   do not add a fallback UI. `touch-action:none` on `.cv-root` is inherited by intersection and cannot be loosened from the child; it
   does not affect Scribble (verify on device, below).
6. **In-flight Scribble text**: committing reads `ta.value` synchronously. In `commit()` call `ta.blur()` first, then read `value`
   (WebKit finishes marked/Scribble composition on blur). If device testing shows lost words when the Pencil taps elsewhere
   immediately after writing, delay committing by 400 ms for pen-created boxes only (`ta` stays in the DOM).
7. **Not testable in Playwright**: Scribble needs a real iPad + Pencil. The builder adds `tests/scribble-checklist.md`-style steps to the
   README (a manual device checklist: tap with text tool + Pencil, write a sentence, pause, check text appears; write starting just
   left/above the text; rest the palm; scratch-out to delete; Scribble off → box still works with keyboard) and a Playwright test
   proving: pen `pointerdown` on the textarea is **not** `defaultPrevented`, no pointer capture, a touch pointerdown 300 ms after a pen
   move does NOT commit the box, and padding doesn't shift the text origin.

### C2. Behaviour
- **Pencil creates a writing box**: with the **text tool**, a tap with `pointerType==='pen'` (existing `_tap` path; tapping an existing
  text box still edits it) creates a text box `font:'hand'`, colour = **the pen tool's current colour**, `fontSize = max(24, text size)`,
  `w = min(420, space to page edge)`, `isNew` with placeholder "Write here with Apple Pencil…" (placeholder only for pen boxes).
  This does **not** change `toolOpts.text.font`; finger/mouse taps keep the text tool's font. Changing the font in the popover while a box is
  open applies to it as today (`setOptions`).
- Text tool options popover (`js/ui/toolbar.js`): font list gains **Handwriting** (key `hand`, rendered in that font).
- Add `hand` to `FONT_STACKS`: `'"FN Hand", "Patrick Hand", ui-rounded, "SF Pro Rounded", cursive'`. `normalizeItems` already keeps any
  string font; old app versions fall back to sans.
- One-time tip toast the first time a Pencil writing box opens (persist `settings.scribbleTipSeen`): "Write with Apple Pencil — iPad turns
  it into neat text. (Needs Settings › Apple Pencil › Scribble on.)"

### C3. Font loading (Safari/canvas)
- Bundle OFL **Patrick Hand**: `npm pack @fontsource/patrick-hand` in a scratch dir (not the project), copy the **latin** 400 `woff2`
  to `vendor/fonts/` plus the OFL text as `vendor/fonts/PatrickHand-OFL.txt`. `@font-face` in `css/canvas.css`:
  `src:url('../vendor/fonts/<file>.woff2') format('woff2'); font-display:swap; unicode-range` as in fontsource latin.
  (`../vendor` is correct relative to `css/canvas.css`; do NOT write `vendor/...` or an absolute `/vendor/...`, the app is served from a sub-path.)
  Characters outside the subset (accents, symbols Scribble may emit) fall back through the stack; layout and the textarea use the same
  fallback so they still agree.
- `files.json`/precache: add `vendor/fonts/<file>.woff2` (NOT the licence). The SW precaches by URL and the CSS font request is the same
  URL, so it is served offline (cache hit ignores request mode). `index.html`: `<link rel="preload" as="font" type="font/woff2" href="vendor/fonts/<file>.woff2" crossorigin>`
  (without `crossorigin` the preload is fetched twice).
- **Canvas never triggers a font download.** Add `js/canvas/fonts.js`: `ensureHandFont(): Promise<boolean>` = memoised
  `document.fonts.load('24px "FN Hand"', 'Aa Hello')` with a 2 s timeout (resolves false on failure/timeout) and a sync flag `handReady`.
  Kick it off at app boot (`app.js`) and again defensively from `CanvasView` constructor.
- **`layoutText` caches by item in a WeakMap, so a layout measured with the fallback font stays wrong forever.** Export
  `resetTextLayout()` from `text.js` (replace the WeakMap) and, when the font becomes ready: `resetTextLayout()`, re-`finalizeItem` every text
  item with `font==='hand'` (new bbox/h) **without** a history entry or `onChange` (display-only, stored data has no layout), re-run
  `textEdit._layout()/sync()` if a box is open, `invalidate()`. Also run this whenever a page with `hand` text is loaded while `!handReady`.
- Thumbnails (`makeThumbnail`), PDF/PNG export and the page drawer renderer must `await ensureHandFont()` before drawing a page containing
  `hand` text (check items first so other pages don't wait). Pages are never blocked on the font for normal drawing.
- The textarea picks the face up via CSS and swaps automatically; verify canvas text vs textarea baseline alignment for `hand` within 1 px
  (Playwright pixel check in Chromium).

## D. App wiring (Builder owns js/ui too this time)
- Settings sheet: new group **"Smart ink"**: toggles **Auto shapes** (`settings.autoShapes`) and **Auto-tidy handwriting**
  (`settings.autoTidy`), each with a one-line explanation. Defaults are **`s.autoShapes !== false`** / **`s.autoTidy !== false`** everywhere
  (existing users have neither key; same pattern as `twoFingerUndo`). Persist via `app.updateSettings`; apply to the live editor in
  `editor.js` next to the existing `setPencilOnly/setTwoFingerUndo` blocks (initial set at ~L256 AND the settings-changed handler at ~L279):
  `view.setToolOptions('pen', {autoShapes, autoTidy})`. Turning `autoTidy` off calls `view.smart.cancel()` pending tidy (no stray tidy later).
- Optional: pen options popover row "Shapes: Auto / Hold only".
- `js/canvas/files.json` lists new files (shapes.js, tidy.js, smartink.js, fonts.js, the woff2). `sw.js`: **`const VERSION = 'v2'`** (cache name
  becomes `fln-v2`; do not edit the `'fln-'` prefix logic). README + ROADMAP: document the features and the manual Scribble checklist.
- Data model additions are optional stroke fields (`shape:{kind}`, `uniform`); old pages load unchanged; backups round-trip them (see Global rules).

## E. Tests the builder must write and pass
- `tests/shapes.test.mjs` (Node, **seeded PRNG** e.g. mulberry32 so failures reproduce): noisy strokes (jitter 2–4% of size, varied speeds,
  non-uniform sample spacing) for every kind incl. L-axes in 4 orientations, kinked polyline, 4-segment arrows, plus **≥ 40 negatives**
  that `mode:'auto'` must NOT convert (0 false positives above the size gates; ≥ 90% recall on shapes): handwriting generated from
  glyph paths ("e","a","o","l","the", cursive loops, short underlines); **large (≥ 90 unit) letters "O","L","Z","N","W","M","7","V" as
  the last glyph of a word (letter-in-word guard)**; **smooth supply/demand curves (down- and up-sloping, 3 curvatures), S-curve,
  parabola, sine wave, bell curve, arcs, spirals**; zig-zag cross-outs; hatching; dashed lines. Also assert the zoom-out case
  (handwriting 100 world units tall at zoom 0.3 is not converted). Print a confusion table.
  `hold` mode: straight-ish line, circle, rectangle convert; a smooth curve returns null.
- `tests/tidy.test.mjs` (Node): slanted, wavy, uneven line of ≥ 6 words → baseline angle < 1° after tidy, word-height CV reduced,
  no point moved > 25 units, stroke count & order preserved, diagrams / `shape` strokes / < 4-stroke labels / strokes overlapping an
  obstacle returned as the **same object**, idempotent (second pass `changed:false`), page `bounds` respected.
- Browser checks (Playwright, harness in /home/claude/tools): draw a wobbly circle, square, L-axes, kinked demand curve, a smooth
  demand curve (stays raw), and a line of small "handwriting" on lined paper → screenshots; "Keep original" restores; undo/redo
  consistent (one entry per conversion; no raw stroke in history); autosave persists `shape`/`uniform` **across reload**; settings toggles
  disable both features immediately; `load(otherPage)` with a pending tidy → no tidy happens on either page and no timer fires after
  `destroy()` (spy on `setTimeout` leftovers / `view.smart` pending = 0); tidy while a lasso selection or text box is open is deferred;
  pen hold on a curve does not flatten it; highlighter hold-to-line unchanged.
- Scribble-related Playwright checks listed in C1.7; device checklist in the README.

## v1.1 review
- 2026-11-11 Global: added `SmartInk` controller owning all timers/pending list/pill/fx with a single `cancel()` called from load/destroy/_commitPending/undo/redo/tool change; page-sequence guard on timers (timers surviving destroy/page swap).
- 2026-11-11 Global: dropped stored `raw`; "Keep original" is an in-memory closure + new history entry with identity checks (simpler, no page bloat, undo/redo consistent).
- 2026-11-11 Global: found that `normalizeItems` (items.js) whitelists stroke fields and would strip `shape`/`uniform` on reload; mandated the fix, store only `shape.kind`, and a reload/backup round-trip test.
- 2026-11-11 A: pen had no straight-line assist (it is highlighter-only); the old "fall back to straight line" would flatten every curve the student pauses on -> pen does nothing if unrecognised; after a snap `_add` stops appending raw points; one `HOLD_MS` (500).
- 2026-11-11 A: false positives - moved gates into `recognizeShape` (modes auto/hold), added screen-px and local-scale gates (zoomed-out handwriting exceeds 90 world units), letter-in-word guard, curve rejection (<=3% chord deviation), zig-zag/cross-out rejection, min arm/segment lengths, arrow single-stroke pattern pinned down, spiral rejection; expanded negative corpus (smooth demand curves etc.) and seeded PRNG.
- 2026-11-11 B: auto-tidy trigger redefined (idle 4 s with no hover; new-line pen-down only arms tidy and runs after that stroke's pointerup); busy -> re-arm not drop; grouping gates (>=4 strokes, horizontal gap split, obstacles) so labels/diagrams/text-overlays are untouched; in-place item replacement (z-order), page-bounds clamp, rotation cap, idempotence, selection re-set on new ids.
- 2026-11-11 C1: Scribble section rewritten with exact changes: palm touches were committing the box (penId null for textarea pen events) -> touch ignored while Pencil active; real textarea padding for writing outside the text; no inputmode/user-modify/readonly; contextmenu exemption; blur-before-commit; manual device checklist since Playwright cannot test Scribble.
- 2026-11-11 C3: fonts - `ensureHandFont()` with explicit `document.fonts.load` (canvas never triggers a download), `resetTextLayout()` because layoutText's WeakMap caches fallback-font layouts, re-finalize text bboxes without history, await before thumbnails/exports, preload with `crossorigin`, `../vendor/fonts` URL, latin subset + fallback stack, licence not precached.
- 2026-11-11 D: defaults as `!== false` for existing users, exact editor.js wiring points, sw.js `VERSION='v2'` (cache `fln-v2`), pen text colour = pen tool colour, pen box does not change `toolOpts.text.font`.

## v1.1 builder notes (contract changes made while building)
- 2026-11-12 Engine opts: new optional callback `onPencilTextBox()` fired when a Pencil writing box opens (the app shows the one-time Scribble tip; the engine cannot toast).
- 2026-11-12 `recognizeShape` opts gained `prev?: {bbox, dt}` (previous raw pen stroke) so the letter-in-word guard is applied, and Node-tested, inside the recogniser; `inWordGuard`, `lineShape`, `arrowShape`, `SHAPE_KINDS`, `SHAPE_LABELS` are also exported. The guard only counts a previous stroke that stayed raw (a shape drawn just before does not block the next shape). Result may carry `start` (anchor for the hold-follow of a line/arrow).
- 2026-11-12 Shapes: zig-zag rejection uses 95° (spec 110°, stricter); slim ellipses (axis ratio down to 0.25) are accepted on fit quality even though their tips look like corners; closed shapes are validated by the tangent winding of the closed loop (one turn) instead of the raw stroke's total turning; the local `scale` only samples handwriting-sized strokes (bbox height < 120) and needs ≥ 5 of them, so a page of big raw curves does not switch auto shapes off.
- 2026-11-12 Tidy: corrections are projections with hysteresis (outer trigger band → inner target band) instead of fixed 60/70% blends, so tidy writing is left alone; the baseline pivot slides from the left end towards the middle when a left pivot would swing the far end more than 11 units; the 25-unit limit trims size/slant/spacing first and only then the straightening; `tidy.js` remembers its own results by object identity (WeakSet, `markTidied`) so a second pass over its output is exactly a no-op without storing any marker in the page. Auto mode skips a line sloping more than 8°; lines whose bottoms do not hug one baseline are skipped.
- 2026-11-12 Auto-tidy: each stroke gets one automatic chance (the snapshot leaves the pending list whether or not its group was tidied). `HOLD_MS`/`HOLD_PX` moved to `constants.js`. `addStroke(item, reason = 'stroke')`.
- 2026-11-12 `sw.js` VERSION is `'v3'` (v2 was taken by the home-screen redesign).


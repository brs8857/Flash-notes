# Flash Notes — Roadmap

A free, unlimited, offline-first handwriting notes app for students. It runs in the browser and installs on an iPad home screen like a native app.

## Principles
1. **Free and unlimited.** No accounts, no servers, no paywalls. Notes are saved on the device (IndexedDB), so the only limit is the device's own storage.
2. **Feels native on iPad.** Squircle shapes, frosted-glass bars, spring animations, Apple Pencil pressure, palm rejection, pinch to zoom.
3. **Nothing too fancy.** We do the core tools very well: pen, highlighter, eraser, lasso, text, images, undo/redo.
4. **Never lose work.** Autosave on every change, persistent storage request, and one-tap backup/restore.

## Team (AI models)
| Role | Model | Responsibility |
|---|---|---|
| Architect / lead | Claude Opus 5.5 | Roadmap, spec, API contracts, integration, browser testing, release |
| Spec + code reviewer | Claude Sonnet 5.5 | Reviews the spec for iPad/Safari pitfalls, then bug-hunts the finished code *before* testing |
| Builders (heavy lifting) | Claude Fable 5.2 ×2 | One builds the drawing engine, one builds the app (library, notebooks, covers, whiteboards, storage, PWA) |

## Milestones

### v1.0 — MVP (released)
- [x] Library home: Notebooks / Whiteboards tabs, search, recents
- [x] Notebooks with customisable covers (colour, pattern, emoji, title, photo)
- [x] Unlimited pages per notebook; paper templates (blank, lined, narrow-lined, grid, dotted, Cornell)
- [x] Add / duplicate / delete / reorder pages, page thumbnails drawer
- [x] Whiteboards: infinite canvas, 10% → 1000% zoom
- [x] Tools: pen (pressure-sensitive), highlighter, eraser (whole stroke or precise), lasso (move/recolour/duplicate/delete), text boxes, image insert
- [x] Colour palette + custom colours, 3 quick sizes per tool
- [x] Undo/redo (buttons, two-finger tap undo, keyboard shortcuts)
- [x] Apple Pencil: pressure, palm rejection, optional "Pencil only" drawing mode
- [x] Light and dark mode
- [x] Export page as PNG, export notebook as a real PDF (built in-app, shared to Files/AirDrop)
- [x] Backup and restore everything as one file
- [x] Installable PWA (works offline, home-screen icon, full screen)
- [x] Hosted free on GitHub Pages

### v1.1 — Smart ink (released)
- [x] Shape recognition: lines, arrows, axes, kinked lines, circles, ellipses, rectangles, squares, triangles
- [x] Hold to snap (with a live preview; a line or arrow follows the pen), and auto shapes when the pen lifts
- [x] Curves are never converted (supply and demand curves stay as drawn)
- [x] Tidy ink: straightens each line of handwriting, sits it on the rule, evens word size, slant and spacing
- [x] Auto-tidy when you move to the next line or pause, plus ✨ Tidy in the lasso menu
- [x] "Keep original" on every conversion, and each one is a single undo step
- [x] Pencil to text: Apple Pencil + text tool opens a Scribble-ready writing box
- [x] Bundled handwriting font for text boxes (Patrick Hand, works offline)
- [x] Settings → Smart ink switches for auto shapes and auto-tidy

### v1.2 — Pens & colour (released)
- [x] Brush library: Pen, Fineliner, Ballpoint, Fountain pen, Brush pen, Marker, Pencil HB, Mechanical pencil, Charcoal
- [x] Highlighters: Chisel (flat angled tip), Round, Pastel; still drawn beneath ink, still snap straight when held
- [x] Graphite and charcoal grain made in the app (no image files), fixed to the page, sharp at 1000%
- [x] Each brush remembers its own colour and size; live brush previews; size slider with a preview dot
- [x] Bigger palettes (ink, pastel, deep, highlighter), My colours (up to 24), recent colours (last 8)
- [x] Custom colour picker (saturation/brightness square, hue bar, hex code) that works with finger and Pencil
- [x] Lasso → Colour → More… recolours a selection with the same picker
- [x] Faster ink for fingers and Pencil (see below)

#### What changed to make drawing feel instant
Measured with a benchmark (3,000-point stroke on a page that already holds 2,000 strokes) before and after:
- The line ends **under the finger**. Before, smoothing left the tip about 8 px behind a fast finger (3.5 px behind
  the Pencil). Now the tip is drawn to the pointer's true position, plus the browser's predicted next position
  where it offers one. Predicted points are never saved.
- The first dot is drawn **inside the touch event**, not one frame later.
- A stroke is drawn **incrementally**: finished parts are painted once and only a small rectangle around the tip is
  repainted. Engine time per frame fell from 0.36 ms to 0.19 ms and no longer grows with the stroke's length.
- Fingers get lighter smoothing than the Pencil (new strokes only; old notes look exactly as before).
- The page is measured once per touch, not on every movement.
- Pinch on a busy page moves the picture you already have and redraws sharply when you stop (frame gaps fell from
  35 ms to 21 ms in the software-rendered test browser).
- Autosave waits for the finger or Pencil to lift.
- Menus, page turns and opening a notebook animate in 170 to 240 ms instead of 280 to 620 ms.

### v1.3 — Polish
- Page templates: music staves, graph paper with axes, isometric dots
- Folders / subjects for notebooks (e.g. Economics, Geography, Politics)
- Favourite pens bar
- Two-stroke arrowheads, dashed lines

### v1.4 — Study features
- Search handwriting titles / text boxes
- Flashcard pages
- PDF import (annotate past papers and mark schemes)

### v2 — Optional sync
- Optional free sync via the user's own cloud (e.g. export to Files/iCloud Drive automatically)

## Quality process
1. Spec written by Opus, reviewed by Sonnet *before* any code.
2. Fable builds against the written API contract (`SPEC.md`).
3. Sonnet performs a full static bug-hunt and fixes issues *before* testing.
4. Opus runs automated browser tests on an iPad-sized touch viewport, with touch and pen events, and fixes what fails.
5. Release to GitHub Pages.

## How v1.0 was built
1. Opus wrote `SPEC.md` (data model + engine/app contract) and the design tokens.
2. Sonnet reviewed the spec first and fixed 14 iPad/Safari pitfalls before any code existed (e.g. Safari can't save WebP, `window.print()` is unreliable in home-screen apps, iOS zooms on small text inputs).
3. Two Fable builders wrote the drawing engine and the app in parallel against the spec.
4. Sonnet bug-hunted the finished code and fixed 18 bugs before testing (incl. 3 data-loss races).
5. Opus ran iPad-sized browser tests with synthetic Apple Pencil input, fixed visual issues, and released.

## Not yet verified on a real iPad
Keyboard raising for text boxes, Pencil pressure/hover, safe areas, and the share sheet were tested in an emulated iPad only. Pencil-to-text relies on iPadOS Scribble, which no emulator provides: follow the checklist in the README on a real iPad. Hold-to-snap timing and auto-tidy pauses were tuned with synthetic pen input. Drawing latency in v1.2 was measured in a desktop browser with synthetic touches; how it feels under a real finger and Pencil (and whether Safari's predicted touches help) needs the README's drawing-feel checklist on an iPad. Please report anything odd via GitHub Issues.

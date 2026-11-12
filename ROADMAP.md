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
- [x] Apple Pencil: pressure, palm rejection ("Pencil only" drawing mode, auto-enabled when a Pencil is detected)
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

### v1.2 — Polish
- Page templates: music staves, graph paper with axes, isometric dots
- Folders / subjects for notebooks (e.g. Economics, Geography, Politics)
- Favourite pens bar
- Two-stroke arrowheads, dashed lines

### v1.3 — Study features
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
Keyboard raising for text boxes, Pencil pressure/hover, safe areas, and the share sheet were tested in an emulated iPad only. Pencil-to-text relies on iPadOS Scribble, which no emulator provides: follow the checklist in the README on a real iPad. Hold-to-snap timing and auto-tidy pauses were tuned with synthetic pen input. Please report anything odd via GitHub Issues.

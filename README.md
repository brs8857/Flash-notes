# Flash Notes

A free handwriting notes app for students. It runs in the browser, installs on an iPad home screen like a
real app, works offline, and has no limits or ads. From v2.0 it can also keep your notes in a private account
so they are the same on every device (once the site owner has switched accounts on, see `SETUP.md`).

**Open it:** https://brs8857.github.io/Flash-notes/

## What it does

- **Notebooks** with covers you design: colour, pattern, sticker, title or your own photo
- **Unlimited pages** on blank, lined, narrow, grid, dotted or Cornell paper (white, cream or dark)
- **Whiteboards**: endless canvases you can zoom from 10% to 1000%
- **Tools**: pens, pencils and highlighters, eraser (whole stroke or precise), lasso, text boxes, images
- **Pens & colour** (v1.2):
  - **Nine pens and pencils**: Pen, Fineliner, Ballpoint, Fountain pen, Brush pen, Marker, Pencil HB, Mechanical
    pencil and Charcoal. **Three highlighters**: Chisel (a flat angled tip), Round and Pastel. Tap the pen or
    highlighter again to choose one. Each remembers its own colour and size.
  - **Any size**: three quick sizes plus a slider, with a dot that shows how wide the line will be.
  - **Any colour**: ink, pastel and deep palettes, a highlighter palette, **My colours** (tap + to save the
    current colour, hold a saved colour to remove it), your recent colours, and a full custom picker with a hex
    code. The lasso menu's Colour → **More…** opens the same picker for ink you have already written.
  - **Ink that keeps up**: the line starts the moment you touch, ends exactly under your finger or Pencil, and a
    long stroke on a full page costs no more to draw than a short one on an empty page.
- **Apple Pencil**: pressure, palm rejection and an optional Pencil-only mode
- **Smart ink** (v1.1, all on your device):
  - **Shapes**: draw a line, arrow, pair of axes, kinked line, circle, ellipse, rectangle, square or triangle and
    it straightens when you lift the pen. Or hold the pen still at the end of a stroke to snap it (a line or
    arrow then follows the pen until you lift). Curves such as supply and demand curves are never changed.
  - **Tidy handwriting**: each line of writing is gently straightened, sat on the rule and evened out once you
    move to the next line or pause. It stays your handwriting. Lasso → **✨ Tidy** does it on demand.
  - **Pencil to text**: with the text tool, tap the page with Apple Pencil and write: iPadOS Scribble turns it
    into text, shown in a neat handwriting font.
  - Every change is one undo step and offers **Keep original**. Switch either feature off in Settings → Smart ink.
- Undo and redo (buttons, two-finger tap, keyboard shortcuts)
- Page drawer with thumbnails: reorder, duplicate, delete, change paper
- Export a page as PNG or a whole notebook as a PDF
- Light and dark mode
- Backup and restore everything as one file
- **Accounts and sync** (v2.0, when switched on by the site owner):
  - **Sign in with Google**, nothing else to remember. Only your name and email are used.
  - Your notes are **private to your account** and appear on all your devices. They are still saved on the
    device first, so writing never waits for the internet and everything works offline.
  - Notes already on a device are added to your account the first time you sign in; a copy stays on the device.
  - **Settings → Account**: sign out, download everything (JSON), export text as Markdown (handwriting can't be
    Markdown), delete your account and all its notes.

## Install on iPad or iPhone

1. Open the link above in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Open Flash Notes from the home screen. It now runs full screen and works offline.

Installing matters: Safari can clear the data of ordinary website tabs after 7 days without use.
Home-screen apps are not affected.

## Privacy

No ads, no analytics, no trackers, in either mode. The full policy is on the [privacy page](privacy.html).

- **Without accounts** (the default until the owner sets up a backend): your notes never leave your device.
  Everything is saved in the browser's storage (IndexedDB).
- **With accounts**: notes are also stored in the owner's Supabase project, in rows only your account can read
  (row-level security, tested in `tests/rls.test.mjs`). The app receives your Google name and email and nothing
  else. Notes are not end-to-end encrypted; `docs/E2EE.md` explains the trade-offs.

## Back up your notes

**Settings → Download backup** (or **Download my notes**) saves every notebook and whiteboard as one `.json`
file. Put it in Files or iCloud Drive. **Settings → Restore from backup** brings it all back. Without an account
this is the only copy besides your device, so do it before clearing Safari data or changing iPad.

## Run it locally

No build step. Any static file server works:

```
python3 -m http.server 8000
```

Then open http://localhost:8000/. Releases bump `VERSION` in `sw.js` so installed copies offer the update.

Tests run with plain Node. No install needed: `node tests/shapes.test.mjs`, `tests/tidy.test.mjs`,
`tests/color.test.mjs`, `tests/auth.test.mjs`, `tests/export-md.test.mjs`. The account tests need three dev-only
packages (`cd tests && npm install`): `rls.test.mjs` (the real database rules on Postgres/PGlite),
`sync.test.mjs`, `migrate.test.mjs`, and the browser run `node e2e/auth.e2e.mjs`.

## Accounts and sync (for the site owner)

`SETUP.md` is the step-by-step guide: Supabase project, Google sign-in, the delete-account function, and the
three places to fill in. Until `js/config.js` is filled in, the app stays local-only. Design and contracts are in
`SPEC.md` ("Auth & sync v2.0"); the database is in `supabase/`; the vendored client is described in
`vendor/README.md`.

## Checking Pencil-to-text on a real iPad

Scribble is part of iPadOS, so it cannot be tested automatically. After a change to text boxes, check on an
iPad with an Apple Pencil (Settings → Apple Pencil → Scribble on):

1. Choose the text tool and tap the page with the Pencil. A dashed writing box opens with "Write here with
   Apple Pencil…" (and, the first time, a tip at the top).
2. Write a sentence in the box and pause. It turns into text in the handwriting font.
3. Start a word a little to the left of or above the text, still inside the dashed box. It is still recognised.
4. Rest your palm on the screen while writing. The box stays open and nothing is drawn or scrolled.
5. Scratch out a word to delete it; circle a word to select it.
6. Write a few words and immediately tap elsewhere with the Pencil. No words are lost.
7. Lift the Pencil away for two seconds, then tap outside with a finger. The box closes and the text stays.
8. Turn Scribble off in iPadOS Settings. A Pencil tap still opens the box and the keyboard types into it.
9. Zoom the page in and out with the box open: the text does not jump, and the page never zooms by itself.

## Checking drawing feel on a real iPad

Latency can only be judged on the device. After a change to `js/canvas/draw.js`, `input.js` or `engine.js`:

1. Write a few lines quickly with a finger, then with Apple Pencil. The ink should start with the touch and stay
   under the tip; no gap should open up behind a fast stroke.
2. Try every brush. Pencil HB and Charcoal should look grainy and stay put when you scroll; the grain should not
   shimmer. The brush pen should taper; the chisel highlighter should have slanted ends.
3. Fill a page, then draw one very long stroke without lifting. It should stay smooth to the end.
4. Pinch to zoom on the full page: it should follow both fingers at once and turn sharp when you stop.
5. Drag in the custom colour square and along the hue bar with a finger and with the Pencil.

## Credits

- Stroke shapes by [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT)
- Handwriting font: [Patrick Hand](https://fonts.google.com/specimen/Patrick+Hand) by Patrick Wagesreiter (SIL Open Font License 1.1, see `vendor/fonts/PatrickHand-OFL.txt`)
- Built by an A-level student with Claude

MIT licensed. See [LICENSE](LICENSE).

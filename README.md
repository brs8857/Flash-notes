# Flash Notes

A free handwriting notes app for students. It runs in the browser, installs on an iPad home screen like a
real app, works offline, and has no limits, accounts or ads.

**Open it:** https://brs8857.github.io/flash-notes/

## What it does

- **Notebooks** with covers you design: colour, pattern, sticker, title or your own photo
- **Unlimited pages** on blank, lined, narrow, grid, dotted or Cornell paper (white, cream or dark)
- **Whiteboards**: endless canvases you can zoom from 10% to 1000%
- **Tools**: pressure-sensitive pen, highlighter, eraser (whole stroke or precise), lasso, text boxes, images
- **Apple Pencil**: pressure, palm rejection and a Pencil-only mode that turns on by itself
- Undo and redo (buttons, two-finger tap, keyboard shortcuts)
- Page drawer with thumbnails: reorder, duplicate, delete, change paper
- Export a page as PNG or a whole notebook as a PDF
- Light and dark mode
- Backup and restore everything as one file

## Install on iPad or iPhone

1. Open the link above in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Open Flash Notes from the home screen. It now runs full screen and works offline.

Installing matters: Safari can clear the data of ordinary website tabs after 7 days without use.
Home-screen apps are not affected.

## Privacy

Your notes never leave your device. There is no server, no account and no tracking. Everything is saved in
the browser's storage (IndexedDB) on the device you write on.

## Back up your notes

Because notes only live on your device, keep a backup: **Settings → Download backup** saves every notebook
and whiteboard as one `.json` file. Put it in Files or iCloud Drive. Do this before clearing Safari data,
resetting or changing iPad. **Settings → Restore from backup** brings it all back.

## Run it locally

No build step. Any static file server works:

```
python3 -m http.server 8000
```

Then open http://localhost:8000/. Releases bump `VERSION` in `sw.js` so installed copies offer the update.

## Credits

- Stroke shapes by [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT)
- Built by an A-level student with Claude

MIT licensed. See [LICENSE](LICENSE).

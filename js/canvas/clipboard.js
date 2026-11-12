// System clipboard bridge: paste text / images from other apps, copy selected text out.
// Strokes can't leave the app, so they travel through the in-memory clipboard (selection.js). A zero-width
// marker is written to the system clipboard for those copies so a later ⌘V knows to paste the strokes.
import { PAGE_W, PAGE_H, newId } from './constants.js';
import { finalizeItem } from './items.js';
import { round2 } from './geom.js';

export const COPY_MARKER = '​';
const MAX_CHARS = 20000;
const MAX_IMAGE_PX = 1600;

/** Text of the selected text boxes, in reading order (top to bottom, then left to right). */
export function selectedText(view) {
  return view.selection.selected()
    .filter((it) => it.type === 'text' && it.text)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .map((it) => it.text)
    .join('\n\n');
}

/** Drop a block of plain text onto the page as a text box in the current text style, and select it. */
export function pasteText(view, raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!text) return false;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  view.input.finishAction();
  view.textEdit.commit();
  const o = view.toolOpts.text;
  const u = view.usable(), z = view.view.zoom;
  const fontSize = Math.max(16, o.size || 22);
  const page = view.mode === 'page';
  const w = page ? PAGE_W - 96 : Math.min(640, Math.max(240, (u.w * 0.6) / z));
  let [cx, cy] = view.centerWorld();
  let x = cx - w / 2, y = cy - fontSize * 2;
  if (page) { x = Math.min(Math.max(x, 48), PAGE_W - w - 8); y = Math.min(Math.max(y, 24), PAGE_H - 80); }
  let item = finalizeItem({ id: newId(), type: 'text', x: round2(x), y: round2(y), w: round2(w), text, color: o.color, fontSize, font: o.font });
  if (page && item.y + (item.h || 0) > PAGE_H - 16) {       // keep long text on the page when it fits
    item = finalizeItem({ ...item, y: round2(Math.max(16, PAGE_H - 16 - (item.h || 0))) });
  }
  view.requestTool('lasso');
  view.addItems([item], 'paste');
  view.selection.set([item.id]);
  return true;
}

/** Paste an image file (screenshot, photo) from the clipboard: downscale to ≤1600px and insert it. */
export function pasteImageFile(view, file) {
  return new Promise((resolve) => {
    const rd = new FileReader();
    rd.onerror = () => resolve(false);
    rd.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(false);
      img.onload = () => {
        try {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return resolve(false);
          const s = Math.min(1, MAX_IMAGE_PX / Math.max(w, h));
          let src = rd.result;
          if (s < 1) {
            w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            src = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
          }
          view.insertImage(src, w, h);
          resolve(true);
        } catch (err) { console.error(err); resolve(false); }
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}

// Export & share. Rendering can take a while, and Safari only allows navigator.share() straight after a tap,
// so sharing is two-step: 1) render with progress, 2) the user taps "Share" / "Save".
import { h, clear, safeFileName } from './dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { buildPdf } from './pdf.js';
import * as store from '../store.js';
import { renderPageToCanvas, renderBoardToCanvas } from '../canvas/engine.js';

const canvasBlob = (canvas, type, q) => new Promise((res, rej) => {
  try { canvas.toBlob(b => (b ? res(b) : rej(new Error('Could not create the image'))), type, q); } catch (err) { rej(err); }
});
const freeCanvas = c => { try { c.width = c.height = 0; } catch { /* ignore */ } };

export function canShareFile(file) {
  try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch { return false; }
}

/** Download via <a download>, falling back to opening the blob. The URL is revoked after 60 s. */
export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  if ('download' in a) {
    a.href = url; a.download = file.name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
  } else {
    window.open(url, '_blank');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Must be called directly from a tap. Returns 'shared' | 'cancelled' | 'downloaded'. */
export async function shareFile(file) {
  if (canShareFile(file)) {
    try { await navigator.share({ files: [file], title: file.name }); return 'shared'; }
    catch (err) { if (err && err.name === 'AbortError') return 'cancelled'; /* otherwise fall through to download */ }
  }
  downloadFile(file);
  return 'downloaded';
}

/**
 * Two-step export sheet. make(progress) → Promise<File>; progress(text) updates the status line.
 */
export function openExportSheet({ title, make, doneText = 'Ready to share' }) {
  const status = h('div', { class: 'export-status' }, 'Preparing…');
  const spinner = h('div', { class: 'spinner', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'export-stage' }, spinner, status);
  const actions = h('div', { class: 'export-actions' });
  const body = h('div', { class: 'export' }, stage, actions);
  let cancelled = false;
  const sheet = openSheet({ title, body, size: 'sm', onClose: () => { cancelled = true; } });

  (async () => {
    let file;
    try {
      file = await make(text => { if (!cancelled) status.textContent = text; }, () => cancelled);
    } catch (err) {
      if (cancelled) return;
      clear(stage).append(h('div', { class: 'export-badge export-badge--error' }, icon('info', 28)), h('div', { class: 'export-status' }, err && err.message ? err.message : 'Export failed'));
      actions.append(h('button', { class: 'btn btn--tinted btn--block', type: 'button', onClick: () => sheet.close() }, 'Close'));
      return;
    }
    if (cancelled || !file) return;
    clear(stage).append(
      h('div', { class: 'export-badge' }, icon('check', 30, 2.6)),
      h('div', { class: 'export-status' }, doneText),
      h('div', { class: 'export-file' }, file.name));
    const share = canShareFile(file);
    if (share) {
      actions.append(h('button', {
        class: 'btn btn--primary btn--lg btn--block', type: 'button', 'data-squircle': '16',
        onClick: async () => {
          const r = await shareFile(file);
          if (r === 'shared') { sheet.close(); toast('Shared', { icon: 'check' }); }
          else if (r === 'downloaded') { sheet.close(); toast('Saved to Downloads', { icon: 'download' }); }
        },
      }, icon('share', 20, 2.1), h('span', null, 'Share / Save')));
    }
    actions.append(h('button', {
      class: `btn ${share ? 'btn--tinted' : 'btn--primary btn--lg'} btn--block`, type: 'button', 'data-squircle': share ? null : '16',
      onClick: () => { downloadFile(file); sheet.close(); toast('Saved to Downloads', { icon: 'download' }); },
    }, icon('download', 20, 2.1), h('span', null, share ? 'Download instead' : 'Save file')));
  })();
  return sheet;
}

/** Export one page (notebook page or whole whiteboard) as a PNG. page must carry the current items. */
export function exportPagePng({ doc, page, pageNumber }) {
  const isBoard = doc.kind === 'whiteboard';
  return openExportSheet({
    title: 'Export as PNG',
    doneText: 'Your image is ready',
    make: async progress => {
      progress('Drawing your page…');
      const canvas = isBoard
        ? await renderBoardToCanvas(page, { maxSize: 4096, background: doc.background, padding: 48 })
        : await renderPageToCanvas(page, { scale: 2, background: true });
      try {
        const blob = await canvasBlob(canvas, 'image/png');
        const name = isBoard ? safeFileName(doc.title) : `${safeFileName(doc.title)} - page ${pageNumber}`;
        return new File([blob], `${name}.png`, { type: 'image/png' });
      } finally { freeCanvas(canvas); }
    },
  });
}

/** Export a whole notebook as a real PDF, one page at a time to keep memory low. */
export function exportNotebookPdf({ doc }) {
  return openExportSheet({
    title: 'Export as PDF',
    doneText: 'Your PDF is ready',
    make: async (progress, isCancelled) => {
      const fresh = (await store.getDoc(doc.id)) || doc;
      const ids = fresh.pageIds || [];
      const images = [];
      for (let i = 0; i < ids.length; i++) {
        if (isCancelled()) return null;
        progress(`Page ${i + 1} of ${ids.length}`);
        const page = await store.getPage(ids[i]);
        if (!page) continue;
        const canvas = await renderPageToCanvas(page, { width: 1654, background: true });
        try {
          const blob = await canvasBlob(canvas, 'image/jpeg', 0.9);
          images.push({ blob, w: canvas.width, h: canvas.height });
        } finally { freeCanvas(canvas); }
        await new Promise(r => setTimeout(r, 0));   // let the UI breathe between pages
      }
      progress('Putting the PDF together…');
      const pdf = await buildPdf(images);
      return new File([pdf], `${safeFileName(fresh.title)}.pdf`, { type: 'application/pdf' });
    },
  });
}

/** Backup download (Settings). */
export function exportBackup() {
  return openExportSheet({
    title: 'Back up notes',
    doneText: 'Your backup is ready',
    make: async progress => {
      progress('Collecting your notes…');
      const blob = await store.exportAll();
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return new File([blob], `flash-notes-backup-${stamp}.json`, { type: 'application/json' });
    },
  });
}

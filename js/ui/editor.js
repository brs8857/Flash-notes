// Editor: one component for notebook pages and whiteboards. Keeps ONE CanvasView and load()s pages into it.
import { h, on, clamp, debounce, animate, EASE_OUT, downscaleImage, filePicker, plural, idle } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { openSheet, confirmDialog, promptDialog } from './sheet.js';
import { toast } from './toast.js';
import { createToolbar } from './toolbar.js';
import { colorMemory, openColorPicker } from './color-picker.js';
import { openPageDrawer } from './page-drawer.js';
import { paperPicker, boardPicker } from './paper.js';
import { exportPagePng, exportNotebookPdf } from './export.js';
import { openSettings } from './settings.js';
import * as store from '../store.js';
import { CanvasView, makeThumbnail } from '../canvas/engine.js';

const SAVE_DEBOUNCE = 400;
const THUMB_DEBOUNCE = 2500;
const VIEW_DEBOUNCE = 1000;

export async function mountEditor(root, app, { docId, pageIndex = 0, hidden = false }) {
  let doc = await store.getDoc(docId);
  if (!doc || !Array.isArray(doc.pageIds) || !doc.pageIds.length) return null;
  const isBoard = doc.kind === 'whiteboard';
  const kind = doc.kind;
  let index = isBoard ? 0 : clamp(pageIndex | 0, 0, doc.pageIds.length - 1);
  // The page and where the user left off in it load together (one round trip, one first draw at the right place).
  let [page, savedView] = await Promise.all([loadPage(doc.pageIds[index]), store.getViewState(doc.pageIds[index]).catch(() => null)]);
  let view = null;
  let destroyed = false;
  let loading = false;          // true while view.load() runs (engine may commit pending edits of the OLD page)
  let suppressSave = false;     // true while swapping away from a page that was just deleted
  let dirty = false;
  let saveTimer = null;
  let saveDeferred = 0;
  let lastSave = Promise.resolve();
  let persistAsked = false;
  let saveFailed = false;       // a failed save has already been reported (don't toast on every retry)
  let adding = false;           // an "add page" is in flight (double taps must not add two pages)
  let thumbTimer = null;
  let thumbDirty = false;
  let cancelIdleThumb = null;
  let drawer = null;
  let queue = Promise.resolve();
  const offs = [];

  async function loadPage(id) {
    let p = await store.getPage(id);
    if (!p) {
      // Self-heal a dangling page id so the notebook stays usable.
      const t = Date.now();
      p = { id, docId: doc.id, createdAt: t, updatedAt: t, paper: { ...(doc.paper || { style: 'blank', color: 'white' }) }, items: [] };
      await store.putPage(p);
    }
    if (!p.paper) p.paper = { style: 'blank', color: 'white' };
    if (!Array.isArray(p.items)) p.items = [];
    return p;
  }

  /** Serialise structural operations (page turns, add/delete…) so they never interleave. */
  function enqueue(fn) {
    const next = queue.then(() => (destroyed ? undefined : fn()));
    queue = next.catch(err => { console.error(err); toast('Something went wrong. Your notes are safe.', { icon: 'info' }); });
    return queue;
  }

  // ---------------------------------------------------------------- chrome

  const canvasEl = h('div', { class: 'ed-canvas' });
  const stage = h('div', { class: 'ed-stage' }, canvasEl);

  const titleText = h('span', { class: 'ed-title-text' }, doc.title);
  const statusText = h('span', { class: 'ed-status' });
  const titleBtn = h('button', { class: 'ed-title', type: 'button', 'aria-label': 'Rename', onClick: rename }, titleText, statusText);

  const backBtn = h('button', { class: 'bar-btn bar-btn--back', type: 'button', 'aria-label': 'Back to library', onClick: () => app.back() },
    icon('chevronLeft', 22, 2.3), h('span', { class: 'bar-btn-label' }, 'Library'));
  const pagesBtn = isBoard ? null : h('button', { class: 'bar-btn', type: 'button', 'aria-label': 'Pages', title: 'Pages', onFast: openDrawer }, icon('pages', 22, 1.8));
  const addBtn = isBoard ? null : h('button', { class: 'bar-btn', type: 'button', 'aria-label': 'Add page', title: 'Add page', onFast: () => addPage() }, icon('plus', 23, 2));
  const undoBtn = h('button', { class: 'bar-btn', type: 'button', 'aria-label': 'Undo', title: 'Undo', disabled: true, onFast: () => view.undo() }, icon('undo', 22));
  const redoBtn = h('button', { class: 'bar-btn', type: 'button', 'aria-label': 'Redo', title: 'Redo', disabled: true, onFast: () => view.redo() }, icon('redo', 22));
  const moreBtn = h('button', { class: 'bar-btn', type: 'button', 'aria-label': 'More', title: 'More', onFast: openMore }, icon('more', 23));

  const topBar = h('header', { class: 'ed-top glass' },
    h('div', { class: 'ed-top-row' },
      h('div', { class: 'ed-top-side' }, backBtn),
      titleBtn,
      h('div', { class: 'ed-top-side ed-top-side--end' },
        pagesBtn, addBtn, isBoard ? null : h('span', { class: 'bar-sep', 'aria-hidden': 'true' }), undoBtn, redoBtn, moreBtn)));

  const imagePicker = filePicker('image/*');
  const colors = colorMemory(app);   // saved + recent colours, shared by the tool options and the lasso's colour picker
  const toolbar = createToolbar({
    saved: app.settings.tools, colors,
    getView: () => view,
    onInsertImage: insertImage,
    onPersist: partial => app.updateSettings(partial),
  });

  // Zoom pill
  const zoomLabel = h('span', { class: 'zoom-label-text' }, '100%');
  const zoomOut = h('button', { class: 'pill-btn', type: 'button', 'aria-label': 'Zoom out', onFast: () => { view.zoomBy(1 / 1.25); syncZoom(); } }, icon('minus', 20, 2.2));
  const zoomIn = h('button', { class: 'pill-btn', type: 'button', 'aria-label': 'Zoom in', onFast: () => { view.zoomBy(1.25); syncZoom(); } }, icon('plus', 20, 2.2));
  const zoomReset = h('button', { class: 'pill-btn zoom-label', type: 'button', 'aria-label': isBoard ? 'Reset zoom' : 'Fit page to width', title: isBoard ? 'Reset view' : 'Fit to width', onFast: () => { view.resetView(); syncZoom(); } }, zoomLabel);
  const magnifyBtn = isBoard ? null : h('button', {
    class: 'pill-btn pill-btn--magnify', type: 'button', 'aria-label': 'Magnify to 300% for detail', title: 'Magnify for detail', 'aria-pressed': 'false',
    onFast: () => {
      if (view.getZoom() >= 2.9) view.fitWidth(); else view.setZoom(3, { animate: true });
      syncZoom();
    },
  }, icon('magnify', 21, 2));
  const zoomPill = h('div', { class: 'ed-pill ed-zoom glass', role: 'group', 'aria-label': 'Zoom' },
    zoomOut, zoomReset, zoomIn, magnifyBtn ? h('span', { class: 'pill-sep', 'aria-hidden': 'true' }) : null, magnifyBtn);

  // Pager (notebooks)
  const pagerLabel = h('span', { class: 'pager-label' });
  const prevBtn = isBoard ? null : h('button', { class: 'pill-btn', type: 'button', 'aria-label': 'Previous page', onFast: () => goTo(index - 1) }, icon('chevronLeft', 21, 2.3));
  const nextBtn = isBoard ? null : h('button', { class: 'pill-btn', type: 'button', 'aria-label': 'Next page', onFast: () => (index >= doc.pageIds.length - 1 ? addPage() : goTo(index + 1)) });
  const pager = isBoard ? null : h('div', { class: 'ed-pill ed-pager glass', role: 'group', 'aria-label': 'Page navigation' },
    prevBtn, h('button', { class: 'pill-btn pager-mid', type: 'button', 'aria-label': 'Show all pages', onFast: openDrawer }, pagerLabel), nextBtn);

  const bottom = h('div', { class: 'ed-bottom' }, h('div', { class: 'ed-bottom-slot' }), pager, h('div', { class: 'ed-bottom-slot ed-bottom-slot--end' }, zoomPill));

  const el = h('main', { class: `editor view editor--${isBoard ? 'board' : 'page'}` }, stage, topBar, toolbar.el, bottom);
  if (hidden) el.style.visibility = 'hidden';   // revealed by the router once the open animation covers the screen
  root.append(el);

  let saveState = '';
  function syncChrome() {
    titleText.textContent = doc.title;
    const n = doc.pageIds.length;
    const where = isBoard ? 'Whiteboard' : `Page ${index + 1} of ${n}`;
    statusText.textContent = saveState ? `${where} · ${saveState}` : where;
    statusText.classList.toggle('is-saving', saveState === 'Saving…');
    if (!isBoard) {
      pagerLabel.textContent = `${index + 1} / ${n}`;
      prevBtn.disabled = index === 0;
      const last = index >= n - 1;
      nextBtn.replaceChildren(icon(last ? 'plus' : 'chevronRight', 21, 2.3));
      nextBtn.setAttribute('aria-label', last ? 'Add page' : 'Next page');
      nextBtn.classList.toggle('pill-btn--accent', last);
    }
    document.title = `${doc.title} · Flash Notes`;
  }
  function setSaveState(s) { saveState = s; syncChrome(); }

  function syncZoom() {
    if (!view) return;
    const z = view.getZoom();
    zoomLabel.textContent = `${Math.round(z * 100 + 1e-6)}%`;
    if (magnifyBtn) magnifyBtn.setAttribute('aria-pressed', String(z >= 2.9));
  }

  function measureInsets() {
    const c = canvasEl.getBoundingClientRect();
    if (!c.width) return null;
    const top = Math.max(0, Math.round(toolbar.el.getBoundingClientRect().bottom - c.top + 8));
    const bottomInset = Math.max(0, Math.round(c.bottom - zoomPill.getBoundingClientRect().top + 8));
    return { top, right: 0, bottom: bottomInset, left: 0 };
  }
  function updateInsets() {
    if (!view) return;
    const i = measureInsets();
    if (i) view.setInsets(i);
  }

  // ---------------------------------------------------------------- saving

  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!view || suppressSave) return lastSave;
    dirty = false;
    const record = { ...page, items: view.getItems(), updatedAt: Date.now() };
    page = record;
    doc.updatedAt = record.updatedAt;
    const p = store.putPage(record).then(() => {
      saveFailed = false;
      if (destroyed) return;
      if (!dirty) setSaveState('Saved');
      if (!persistAsked) { persistAsked = true; store.requestPersistence(); }
    }, err => {
      console.error(err);
      dirty = true;
      if (!destroyed) {
        setSaveState('Not saved');
        if (!saveFailed) toast('Couldn’t save. Your device may be out of space.', { icon: 'info', duration: 5000 });
      }
      saveFailed = true;
    });
    lastSave = lastSave.then(() => p);
    return lastSave;
  }

  function flush() { if (dirty) saveNow(); }

  function scheduleThumb(delay = THUMB_DEBOUNCE) {
    thumbDirty = true;
    clearTimeout(thumbTimer);
    if (cancelIdleThumb) { cancelIdleThumb(); cancelIdleThumb = null; }
    thumbTimer = setTimeout(() => {
      if (destroyed) return;
      if (view.isBusy() || dirty) { scheduleThumb(1000); return; }
      // Rendering a thumbnail takes ~100 ms on a full page: wait for an idle moment, and look again before starting.
      cancelIdleThumb = idle(() => {
        cancelIdleThumb = null;
        if (destroyed || !thumbDirty) return;
        if (view.isBusy() || dirty) { scheduleThumb(1000); return; }
        thumbNow();
      });
    }, delay);
  }

  /** Render + store the thumbnail of a page record (defaults to the current page as last saved). */
  async function thumbNow(record = page) {
    if (record === page) { clearTimeout(thumbTimer); thumbDirty = false; }
    try {
      const data = await makeThumbnail(record, kind);
      await store.putThumb(record.id, record.docId, data);
    } catch (err) { console.warn('thumbnail failed', err); }
  }

  const saveView = debounce((pageId, v) => {
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && v.zoom > 0) store.putViewState(pageId, v).catch(() => {});
  }, VIEW_DEBOUNCE);

  function onChange(meta) {
    if (destroyed || suppressSave) return;
    if (meta && meta.pageId && meta.pageId !== page.id) return;   // late change from a page that is no longer loaded
    dirty = true;
    scheduleThumb();
    // Engine committed a pending edit while we swap pages, or the app is going to the background: save right now.
    if (loading || document.visibilityState === 'hidden') { saveNow(); return; }
    if (saveState !== 'Saving…') setSaveState('Saving…');
    clearTimeout(saveTimer);
    saveDeferred = 0;
    saveTimer = setTimeout(saveSoon, SAVE_DEBOUNCE);
  }

  /** Saving copies every item on the page (a few ms on a full page): never do that under a moving pen or finger.
   *  Waits for the pointer to lift, but at most ~2.5 s (hide / page turn / leave still save immediately). */
  function saveSoon() {
    if (view && view.isBusy() && saveDeferred < 10) { saveDeferred++; saveTimer = setTimeout(saveSoon, 220); return; }
    saveNow();
  }

  /** Swap the engine to `next`. The engine first commits any open text edit of the old page (→ onChange → saveNow). */
  function loadIntoView(next) {
    flush();
    saveView.flush();
    loading = true;
    try { view.load(next); } finally { loading = false; }
  }

  // ---------------------------------------------------------------- engine

  try {
    view = new CanvasView(canvasEl, {
      mode: isBoard ? 'board' : 'page',
      page,
      insets: measureInsets(),
      background: isBoard ? (doc.background || 'dots') : undefined,
      onChange,
      onViewChange: v => {
        syncZoom();
        if (!loading && !destroyed && v) saveView(page.id, { x: v.x, y: v.y, zoom: v.zoom });
      },
      onHistory: s => { undoBtn.disabled = !s.canUndo; redoBtn.disabled = !s.canRedo; },
      onPencilDetected: () => {
        // Never switch fingers off on our own: palm rejection already works while the Pencil is down.
        if (!app.settings.pencilTipSeen) {
          app.updateSettings({ pencilTipSeen: true });
          toast('Apple Pencil detected — palm rejection is on. Want fingers to scroll only? Turn on Pencil-only in ⋯', { icon: 'pencilOnly', duration: 6000 });
        }
      },
      onToolRequest: tool => toolbar.setActive(tool),
      // Lasso → Colour → More…: the same picker as the pen's, anchored to the selection menu.
      onPickColor: ({ color, rect, apply }) => openColorPicker(rect, { color, memory: colors, title: 'Selection colour', onPick: apply }),
      onPencilTextBox: () => {
        // One-time tip the first time a Pencil writing box opens.
        if (app.settings.scribbleTipSeen) return;
        app.updateSettings({ scribbleTipSeen: true });
        toast('Write with Apple Pencil — iPad turns it into neat text. (Needs Settings › Apple Pencil › Scribble on.)', { icon: 'sparkle', duration: 7000 });
      },
    });
  } catch (err) {
    console.error(err);
    el.remove(); toolbar.destroy(); imagePicker.destroy();
    throw err;
  }

  view.setPencilOnly(!!app.settings.pencilOnlyUser);
  view.setTwoFingerUndo(app.settings.twoFingerUndo !== false);
  view.setToolOptions('pen', { autoShapes: app.settings.autoShapes !== false, autoTidy: app.settings.autoTidy !== false });
  toolbar.applyTo(view);
  updateInsets();

  // Restore where the user left off: whiteboards fully; notebook pages keep fit-width but restore the scroll.
  loading = true;
  try {
    view.resetView();
    const saved = savedView;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.zoom > 0) {
      if (isBoard) view.setView(saved);
      else { const fit = view.getView(); if (saved.y > fit.y) view.setView({ x: fit.x, y: saved.y, zoom: fit.zoom }); }
    }
  } catch { /* default view */ } finally { loading = false; }
  syncZoom();
  syncChrome();
  undoBtn.disabled = !view.canUndo(); redoBtn.disabled = !view.canRedo();

  const ro = new ResizeObserver(() => { updateInsets(); toolbar.layout(); });
  ro.observe(topBar); ro.observe(toolbar.el); ro.observe(bottom); ro.observe(el);

  offs.push(app.onSettings(s => {
    view.setPencilOnly(!!s.pencilOnlyUser);
    view.setTwoFingerUndo(s.twoFingerUndo !== false);
    view.setToolOptions('pen', { autoShapes: s.autoShapes !== false, autoTidy: s.autoTidy !== false });   // turning auto-tidy off also drops any pending tidy
  }));
  const hide = () => { flush(); saveView.flush(); };
  offs.push(on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') hide(); }));
  offs.push(on(window, 'pagehide', hide));
  offs.push(on(document, 'keydown', e => {
    if (isBoard || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable], [role=dialog], [role=alertdialog]')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(index - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(index + 1); }
  }));
  offs.push(on(canvasEl, 'contextmenu', e => e.preventDefault()));

  // ---------------------------------------------------------------- page navigation

  function snapshot() {
    try {
      const canvases = [...canvasEl.querySelectorAll('canvas')].filter(c => c.width && c.height);
      if (!canvases.length) return null;
      const snap = document.createElement('canvas');
      snap.width = canvases[0].width; snap.height = canvases[0].height;
      const ctx = snap.getContext('2d');
      for (const c of canvases) ctx.drawImage(c, 0, 0, snap.width, snap.height);
      snap.className = 'ed-snap';
      return snap;
    } catch { return null; }
  }

  function slide(snap, dir) {
    if (!snap) return;
    stage.append(snap);
    const opts = { duration: 220, easing: EASE_OUT };   // input is paused while the page slides: keep it short
    // The engine maps pointers through the container's bounding rect, which moves with the slide: ignore input
    // until the page has settled rather than putting ink in the wrong place.
    canvasEl.style.pointerEvents = 'none';
    animate(canvasEl, [{ transform: `translateX(${dir * 100}%)` }, { transform: 'translateX(0)' }], opts)
      .then(() => { canvasEl.style.pointerEvents = ''; });
    animate(snap, [{ transform: 'translateX(0)' }, { transform: `translateX(${-dir * 100}%)` }], { ...opts, fill: 'forwards' })
      .then(() => { snap.remove(); snap.width = snap.height = 0; });
  }

  /** Show page i. Order: flush old → load(new). `dir` forces the slide direction. */
  async function showPage(i, { dir, animateTurn = true, skipOldSave = false } = {}) {
    i = clamp(i, 0, doc.pageIds.length - 1);
    const next = await loadPage(doc.pageIds[i]);
    if (destroyed) return;
    const old = page;
    const d = dir || (i >= index ? 1 : -1);
    const snap = animateTurn ? snapshot() : null;
    if (skipOldSave) {
      clearTimeout(saveTimer); saveTimer = null; dirty = false;
      saveView.cancel();
      suppressSave = true; loading = true;
      try { view.load(next); } finally { suppressSave = false; loading = false; }
    } else {
      loadIntoView(next);
    }
    const oldSaved = page;            // `page` now holds the old page as it was last saved
    const oldThumbDirty = thumbDirty;
    page = next;
    index = i;
    clearTimeout(thumbTimer); thumbDirty = false;
    // The old page's thumbnail is not needed for what happens next: render it when the browser is idle, not during the page turn.
    if (!skipOldSave && oldThumbDirty && oldSaved.id === old.id) lastSave.then(() => new Promise(r => idle(r, 3000))).then(() => thumbNow(oldSaved)).then(() => { if (drawer) drawer.refresh(); });
    slide(snap, d);
    setSaveState('');
    syncZoom();
    app.replaceHash(`#/nb/${doc.id}/${index}`);
  }

  function goTo(i) {
    if (isBoard) return Promise.resolve();
    return enqueue(async () => {
      i = clamp(i, 0, doc.pageIds.length - 1);
      if (i === index) return;
      await showPage(i);
    });
  }

  function addPage() {
    if (adding) return queue;
    adding = true;
    return enqueue(async () => {
      try {
        const p = await store.addPage(doc.id, page.id, doc.paper);
        doc = await store.getDoc(doc.id);
        await showPage(doc.pageIds.indexOf(p.id), { dir: 1 });
      } finally { adding = false; }
    });
  }

  function duplicatePage(pid = page.id) {
    return enqueue(async () => {
      if (pid === page.id) { flush(); await lastSave; }
      const p = await store.duplicatePage(pid);
      doc = await store.getDoc(doc.id);
      if (pid === page.id) await showPage(doc.pageIds.indexOf(p.id), { dir: 1 });
      else { index = doc.pageIds.indexOf(page.id); syncChrome(); app.replaceHash(`#/nb/${doc.id}/${index}`); }
      toast('Page duplicated', { icon: 'copy' });
    });
  }

  async function deletePage(pid = page.id) {
    const n = doc.pageIds.length;
    const num = doc.pageIds.indexOf(pid) + 1;
    const ok = await confirmDialog({
      title: `Delete page ${num}?`,
      message: n === 1 ? 'This is the only page, so it will be replaced with a fresh blank one.' : 'Everything on this page will be deleted. This can’t be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    return enqueue(async () => {
      const isCurrent = pid === page.id;
      if (isCurrent) { clearTimeout(saveTimer); saveTimer = null; dirty = false; clearTimeout(thumbTimer); thumbDirty = false; await lastSave; }
      const updated = await store.deletePage(pid);
      doc = updated || await store.getDoc(doc.id);
      if (isCurrent) await showPage(Math.min(index, doc.pageIds.length - 1), { dir: index >= doc.pageIds.length ? -1 : 1, skipOldSave: true });
      else { index = doc.pageIds.indexOf(page.id); syncChrome(); app.replaceHash(`#/nb/${doc.id}/${index}`); }
    });
  }

  function movePage(from, to) {
    return enqueue(async () => {
      doc = await store.movePage(doc.id, from, to);
      index = Math.max(0, doc.pageIds.indexOf(page.id));
      syncChrome();
      app.replaceHash(`#/nb/${doc.id}/${index}`);
    });
  }

  // ---------------------------------------------------------------- paper / background

  function applyPaper(paper) {
    page = { ...page, paper: { ...paper } };
    view.setPaper(page.paper);
    dirty = true;
    saveNow();
    scheduleThumb(600);
  }

  function openPaperSheet(pid = page.id) {
    if (pid === page.id) {
      const sheet = openSheet({
        title: 'Paper', size: 'sm', doneLabel: 'Done',
        body: h('div', { class: 'paper-sheet' },
          paperPicker({ paper: page.paper, onChange: applyPaper }),
          h('button', {
            class: 'btn btn--tinted btn--block', type: 'button',
            onClick: async () => {
              doc = (await store.patchDoc(doc.id, { paper: { ...page.paper } })) || doc;
              toast('New pages will use this paper', { icon: 'check' });
            },
          }, 'Use for new pages too')),
      });
      return sheet.closed;
    }
    // A page that is not loaded: edit its record directly.
    return (async () => {
      const other = await store.getPage(pid);
      if (!other) return;
      let chosen = other.paper;
      const sheet = openSheet({
        title: `Paper for page ${doc.pageIds.indexOf(pid) + 1}`, size: 'sm', doneLabel: 'Done',
        body: h('div', { class: 'paper-sheet' }, paperPicker({ paper: other.paper, onChange: p => { chosen = p; } })),
      });
      await sheet.closed;
      if (chosen === other.paper) return;
      const rec = { ...other, paper: { ...chosen }, updatedAt: Date.now() };
      await store.putPage(rec);
      await thumbNow(rec);
    })();
  }

  function openBackgroundSheet() {
    openSheet({
      title: 'Background', size: 'sm', doneLabel: 'Done',
      body: h('div', { class: 'paper-sheet' }, boardPicker({
        background: doc.background, color: page.paper?.color,
        onChange: async c => {
          if (c.background !== doc.background) {
            view.setBackground(c.background);
            doc = (await store.patchDoc(doc.id, { background: c.background })) || doc;
            scheduleThumb(600);
          }
          if (c.color !== page.paper?.color) applyPaper({ ...page.paper, color: c.color });
        },
      })),
    });
  }

  // ---------------------------------------------------------------- actions

  async function rename() {
    const name = await promptDialog({ title: `Rename ${isBoard ? 'whiteboard' : 'notebook'}`, value: doc.title, placeholder: 'Title', confirmLabel: 'Rename' });
    if (!name || name === doc.title || destroyed) return;
    doc = (await store.patchDoc(doc.id, { title: name })) || doc;
    syncChrome();
  }

  function insertImage() {
    imagePicker.pick(async file => {
      try {
        const { dataUrl, w, h: ih } = await downscaleImage(file, 1600, { keepAlpha: true, quality: 0.85 });
        if (destroyed) return;
        view.insertImage(dataUrl, w, ih);
      } catch (err) { toast(err.message || 'Could not add that image', { icon: 'info' }); }
    });
  }

  function currentRecord() {
    view.commitPending();   // an open text box is not part of the items until committed
    flush();
    return { ...page, items: view.getItems() };
  }

  function openMore() {
    view.commitPending();
    const pencilOnly = !!app.settings.pencilOnlyUser;
    openMenu(moreBtn, [
      isBoard
        ? { label: 'Background', icon: 'paper', onSelect: openBackgroundSheet }
        : { label: 'Paper', icon: 'paper', onSelect: () => openPaperSheet() },
      { label: 'Insert image', icon: 'image', onSelect: insertImage },
      { label: 'Pencil-only drawing', checked: pencilOnly, onSelect: () => {
        app.updateSettings({ pencilOnlyUser: !pencilOnly });
        toast(!pencilOnly ? 'Pencil-only on: fingers scroll and zoom' : 'Pencil-only off: fingers can draw', { icon: 'pencilOnly' });
      } },
      { separator: true },
      { label: isBoard ? 'Export as PNG' : 'Export page as PNG', icon: 'share', onSelect: () => exportPagePng({ doc, page: currentRecord(), pageNumber: index + 1 }) },
      isBoard ? null : { label: 'Export notebook as PDF', icon: 'pdf', onSelect: async () => { flush(); await lastSave; exportNotebookPdf({ doc }); } },
      isBoard ? null : { separator: true },
      isBoard ? null : { label: 'Duplicate page', icon: 'copy', onSelect: () => duplicatePage() },
      isBoard ? null : { label: 'Delete page', icon: 'trash', danger: true, onSelect: () => deletePage() },
      { separator: true },
      { label: 'Settings', icon: 'gear', onSelect: () => openSettings(app) },
    ], { title: isBoard ? null : `${plural(doc.pageIds.length, 'page')}` });
  }

  function openDrawer() {
    if (isBoard || drawer) return;
    view.commitPending();
    drawer = openPageDrawer({
      getState: () => ({ doc, currentId: page.id }),
      actions: {
        go: i => goTo(i),
        add: () => addPage(),
        duplicate: pid => duplicatePage(pid),
        remove: pid => deletePage(pid),
        move: (from, to) => movePage(from, to),
        paper: pid => openPaperSheet(pid),
      },
    });
    const d = drawer;
    d.closed.then(() => { if (drawer === d) drawer = null; });
    // The current page's preview may be a few seconds old: refresh it, then repaint the drawer.
    if (thumbDirty || dirty) { flush(); lastSave.then(() => thumbNow()).then(() => { if (drawer === d) d.refresh(); }); }
  }

  // ---------------------------------------------------------------- lifecycle

  return {
    name: isBoard ? 'wb' : 'nb',
    docId: doc.id,
    el,
    goTo,
    getIndex: () => index,
    async leave() {
      if (destroyed) return;
      try { await queue; } catch { /* handled */ }
      offs.forEach(off => off());
      ro.disconnect();
      if (drawer) drawer.close();
      try {
        // Commit anything still being edited (load() commits an open text box → onChange → saveNow), then save.
        flush();
        saveView.flush();
        loading = true;
        try { view.load(page); } finally { loading = false; }
        flush();
      } catch (err) { console.error(err); }
      const needThumb = thumbDirty;
      clearTimeout(thumbTimer);
      destroyed = true;
      try { await lastSave; } catch { /* reported */ }
      if (needThumb) await Promise.race([thumbNow(page), new Promise(r => setTimeout(r, 1500))]);
      toolbar.destroy();
      imagePicker.destroy();
      try { view.destroy(); } catch (err) { console.error(err); }
      el.remove();
      document.title = 'Flash Notes';
    },
  };
}

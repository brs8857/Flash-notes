// Library: the shelf of notebooks and whiteboards.
import { h, clear, relTime, plural, animate, SPRING, EASE_OUT, isIOS, isStandalone, debounce } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { alertDialog, confirmDialog, promptDialog } from './sheet.js';
import { toast } from './toast.js';
import { coverEl } from './cover.js';
import { openCoverEditor } from './cover-editor.js';
import { boardPicker } from './paper.js';
import { openSettings } from './settings.js';
import * as store from '../store.js';
import { PAPER_COLORS } from '../canvas/constants.js';
import { makeThumbnail } from '../canvas/engine.js';

const TAB_KEY = 'fln.tab';

function emptyArt(kind) {
  // Small friendly illustration drawn in SVG (no external assets).
  const nb = `
    <g transform="rotate(-9 92 86)"><rect x="50" y="34" width="84" height="108" rx="10" fill="#74C0FC"/><rect x="50" y="34" width="11" height="108" rx="4" fill="#4DABF7"/></g>
    <g transform="rotate(7 118 88)"><rect x="76" y="30" width="86" height="112" rx="10" fill="#FFD43B"/><rect x="76" y="30" width="11" height="112" rx="4" fill="#FAB005"/></g>
    <rect x="62" y="40" width="92" height="118" rx="11" fill="#4C6EF5"/>
    <rect x="62" y="40" width="12" height="118" rx="4" fill="#3B5BDB"/>
    <rect x="136" y="40" width="6" height="118" fill="#3B5BDB" opacity=".55"/>
    <rect x="84" y="62" width="44" height="26" rx="6" fill="#fff"/>
    <rect x="91" y="71" width="30" height="3.500" rx="1.750" fill="#CED4DA"/><rect x="91" y="78" width="20" height="3.500" rx="1.750" fill="#DEE2E6"/>
    <path d="M108 104l-11 19h10l-4 17 14-22h-10z" fill="#FFD43B" stroke="#F59F00" stroke-width="1.500" stroke-linejoin="round"/>
    <g transform="rotate(38 168 120)"><rect x="162" y="78" width="12" height="70" rx="3" fill="#FF8787"/><path d="M162 148h12l-6 13z" fill="#FFE8CC"/><path d="M165.500 155.500h5l-2.500 5.500z" fill="#343A40"/><rect x="162" y="78" width="12" height="9" rx="3" fill="#E9ECEF"/></g>`;
  const wb = `
    <rect x="34" y="40" width="152" height="104" rx="14" fill="#fff" stroke="#DEE2E6" stroke-width="2"/>
    <g fill="#CED4DA">${Array.from({ length: 5 }, (_, r) => Array.from({ length: 8 }, (_, c) => `<circle cx="${52 + c * 17}" cy="${58 + r * 17}" r="1.300"/>`).join('')).join('')}</g>
    <path d="M56 116c14-34 26-36 38-14s22 14 30-10 22-22 36-4" fill="none" stroke="#4C6EF5" stroke-width="4.500" stroke-linecap="round"/>
    <rect x="62" y="58" width="42" height="22" rx="6" fill="#FFE066" opacity=".9"/>
    <circle cx="150" cy="118" r="11" fill="none" stroke="#E03131" stroke-width="3.500"/>
    <rect x="96" y="144" width="28" height="10" rx="3" fill="#DEE2E6"/><rect x="78" y="154" width="64" height="7" rx="3.500" fill="#CED4DA"/>`;
  return h('div', { class: 'empty-art', html: `<svg viewBox="0 0 220 180" width="220" height="180" aria-hidden="true">${kind === 'notebook' ? nb : wb}</svg>` });
}

export async function mountLibrary(root, app, opts = {}) {
  let tab = 'notebook';
  try { if (localStorage.getItem(TAB_KEY) === 'whiteboard') tab = 'whiteboard'; } catch { /* private mode */ }
  let query = '';
  let docs = [];
  let popId = opts.popId || null;
  let destroyed = false;

  const subtitle = h('div', { class: 'lib-subtitle' }, ' ');
  const gear = h('button', { class: 'icon-btn icon-btn--fill lib-gear', type: 'button', 'aria-label': 'Settings', onClick: () => openSettings(app, { onDataChanged: refresh }) }, icon('gear', 22, 1.7));

  // Segmented control with a sliding squircle thumb.
  const segThumb = h('span', { class: 'seg-thumb', 'aria-hidden': 'true' });
  const segBtns = {
    notebook: h('button', { class: 'seg-btn', type: 'button', role: 'tab', onClick: () => setTab('notebook') }, 'Notebooks'),
    whiteboard: h('button', { class: 'seg-btn', type: 'button', role: 'tab', onClick: () => setTab('whiteboard') }, 'Whiteboards'),
  };
  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Library section' }, segThumb, segBtns.notebook, segBtns.whiteboard);

  const searchInput = h('input', {
    class: 'search-input', type: 'search', placeholder: 'Search', 'aria-label': 'Search by title',
    autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search',
    onInput: debounce(() => { query = searchInput.value.trim().toLowerCase(); renderGrid(); }, 80),
    onKeydown: e => { if (e.key === 'Enter') searchInput.blur(); },
  });
  const search = h('label', { class: 'search' }, icon('search', 18, 2.1), searchInput);

  const banner = h('div', { class: 'lib-banner-slot' });
  const grid = h('div', { class: 'lib-grid' });
  const scroll = h('div', { class: 'lib-scroll' },
    h('div', { class: 'lib-inner' },
      h('header', { class: 'lib-header' },
        h('div', { class: 'lib-titles' }, h('h1', { class: 'lib-title' }, 'Flash Notes'), subtitle),
        gear),
      h('div', { class: 'lib-controls' }, seg, search),
      banner,
      grid));
  const el = h('main', { class: 'lib view' }, scroll);
  root.append(el);

  function setTab(t) {
    if (t === tab) return;
    tab = t;
    try { localStorage.setItem(TAB_KEY, t); } catch { /* ignore */ }
    syncSeg();
    renderGrid(true);
  }
  function syncSeg() {
    seg.dataset.tab = tab;
    segBtns.notebook.setAttribute('aria-selected', String(tab === 'notebook'));
    segBtns.whiteboard.setAttribute('aria-selected', String(tab === 'whiteboard'));
  }

  async function refresh() {
    docs = await store.listDocs();
    if (destroyed) return;
    renderGrid();
  }

  function updateSubtitle() {
    const nb = docs.filter(d => d.kind === 'notebook').length;
    const wb = docs.length - nb;
    subtitle.textContent = docs.length ? `${plural(nb, 'notebook')} · ${plural(wb, 'whiteboard')}` : 'Your notes live here';
  }

  // ---------------------------------------------------------------- cards

  function attachPress(card, main, doc, moreBtn) {
    let timer = null, sx = 0, sy = 0, longPressed = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    main.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      longPressed = false; sx = e.clientX; sy = e.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null; longPressed = true;
        card.classList.add('is-lifted');
        showMenu(doc, card, main);
      }, 500);
    });
    main.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
    main.addEventListener('pointerup', cancel);
    main.addEventListener('pointercancel', cancel);
    main.addEventListener('pointerleave', cancel);
    main.addEventListener('click', e => {
      if (longPressed) { e.preventDefault(); longPressed = false; return; }
      open(doc, main);
    });
    card.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); if (!longPressed) showMenu(doc, card, main); });
    moreBtn.addEventListener('click', () => showMenu(doc, card, moreBtn));
  }

  function cardShell(doc, mainChild, sub, extraClass) {
    const main = h('button', { class: 'card-main', type: 'button', 'aria-label': `Open ${doc.title}` }, mainChild);
    const more = h('button', { class: 'icon-btn card-more', type: 'button', 'aria-label': `More actions for ${doc.title}` }, icon('more', 20));
    const card = h('div', { class: `card ${extraClass}`, 'data-id': doc.id },
      main,
      h('div', { class: 'card-meta' },
        h('div', { class: 'card-text' }, h('div', { class: 'card-title' }, doc.title), h('div', { class: 'card-sub' }, sub)),
        more));
    attachPress(card, main, doc, more);
    return card;
  }

  function notebookCard(doc) {
    const n = (doc.pageIds || []).length;
    return cardShell(doc, coverEl(doc), `${plural(n, 'page')} · ${relTime(doc.updatedAt)}`, 'card--nb');
  }

  function boardCard(doc) {
    const pid = doc.pageIds && doc.pageIds[0];
    const thumb = h('div', { class: 'board-thumb' });
    const tile = h('div', { class: 'board-tile' },
      h('div', { class: 'board-shadow', 'aria-hidden': 'true' }),
      h('div', { class: 'board-face', 'data-squircle': '20' }, thumb));
    if (pid) {
      store.getThumb(pid).then(async data => {
        if (!data) {
          // No preview yet (e.g. restored from a backup): make one now.
          const page = await store.getPage(pid);
          if (!page) return;
          thumb.style.backgroundColor = PAPER_COLORS[page.paper?.color] || '#fff';
          data = await makeThumbnail(page, 'whiteboard');
          store.putThumb(pid, doc.id, data).catch(() => {});
        }
        thumb.style.backgroundImage = `url("${data}")`;
      }).catch(() => {});
    }
    return cardShell(doc, tile, `Edited ${relTime(doc.updatedAt)}`, 'card--wb');
  }

  function newCard(kind) {
    const label = kind === 'notebook' ? 'New notebook' : 'New whiteboard';
    return h('div', { class: `card card--new ${kind === 'notebook' ? 'card--nb' : 'card--wb'}` },
      h('button', { class: 'card-main new-tile', type: 'button', 'aria-label': label, onClick: e => create(kind, e.currentTarget) },
        h('span', { class: 'new-shape', 'data-squircle': kind === 'notebook' ? '5 15 15 5' : '20' },
          h('span', { class: 'new-plus' }, icon('plus', 26, 2.2)))),
      h('div', { class: 'card-meta' },
        h('div', { class: 'card-text' }, h('div', { class: 'card-title card-title--accent' }, label), h('div', { class: 'card-sub' }, kind === 'notebook' ? 'Pick a cover' : 'Infinite canvas'))));
  }

  function renderGrid(animateIn = false) {
    updateSubtitle();
    syncSeg();
    const mine = docs.filter(d => d.kind === tab);
    const shown = query ? mine.filter(d => (d.title || '').toLowerCase().includes(query)) : mine;
    clear(grid);
    grid.className = `lib-grid lib-grid--${tab === 'notebook' ? 'nb' : 'wb'}`;

    if (!mine.length) {
      grid.classList.add('lib-grid--empty');
      const isNb = tab === 'notebook';
      grid.append(h('div', { class: 'empty' },
        emptyArt(tab),
        h('h2', { class: 'empty-title' }, isNb ? 'Your shelf is empty' : 'No whiteboards yet'),
        h('p', { class: 'empty-text' }, isNb
          ? 'Make a notebook for each subject, choose a cover, and start writing with your finger or Apple Pencil.'
          : 'Whiteboards are endless canvases for mind maps, essay plans and diagrams. Zoom from 10% to 1000%.'),
        h('button', { class: 'btn btn--primary btn--lg', type: 'button', 'data-squircle': '16', onClick: e => create(tab, e.currentTarget) },
          icon('plus', 20, 2.4), h('span', null, isNb ? 'Create your first notebook' : 'Create a whiteboard'))));
      return;
    }

    grid.append(newCard(tab));
    for (const d of shown) grid.append(d.kind === 'notebook' ? notebookCard(d) : boardCard(d));
    if (query && !shown.length) {
      grid.append(h('div', { class: 'no-match' }, `No ${tab === 'notebook' ? 'notebooks' : 'whiteboards'} match “${searchInput.value.trim()}”`));
    }

    if (animateIn) {
      [...grid.children].slice(0, 14).forEach((c, i) => {
        animate(c, [{ opacity: 0, transform: 'translateY(10px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, delay: i * 22, easing: EASE_OUT, fill: 'backwards' });
      });
    }
    if (popId) {
      const c = grid.querySelector(`[data-id="${popId}"]`);
      popId = null;
      if (c) animate(c, [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 480, easing: SPRING });
    }
  }

  // ---------------------------------------------------------------- actions

  function open(doc, fromEl) {
    const hash = doc.kind === 'notebook' ? `#/nb/${doc.id}/0` : `#/wb/${doc.id}`;
    let fx = null;
    const face = fromEl && (fromEl.querySelector?.('.cover-body, .board-face') || fromEl);
    if (face && face.getBoundingClientRect) {
      const r = face.getBoundingClientRect();
      const color = doc.kind === 'notebook' ? (doc.cover?.color || '#3B5BDB') : null;
      if (r.width > 0) fx = { rect: { left: r.left, top: r.top, width: r.width, height: r.height }, color, kind: doc.kind, node: face };
    }
    app.navigate(hash, { fx });
  }

  function showMenu(doc, card, anchor) {
    const isNb = doc.kind === 'notebook';
    const pop = openMenu(anchor, [
      { label: 'Open', icon: isNb ? 'book' : 'board', onSelect: () => open(doc, card.querySelector('.card-main')) },
      { label: 'Rename', icon: 'text', onSelect: () => rename(doc) },
      isNb ? { label: 'Edit cover', icon: 'sparkle', onSelect: () => editCover(doc) } : null,
      { label: 'Duplicate', icon: 'copy', onSelect: () => duplicate(doc) },
      { separator: true },
      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => remove(doc, card) },
    ], { title: doc.title, align: anchor.classList.contains('card-more') ? 'end' : 'center' });
    const mo = new MutationObserver(() => { if (!document.contains(pop.el)) { card.classList.remove('is-lifted'); mo.disconnect(); } });
    mo.observe(document.body, { childList: true });
  }

  async function rename(doc) {
    const name = await promptDialog({ title: `Rename ${doc.kind}`, value: doc.title, placeholder: 'Title', confirmLabel: 'Rename' });
    if (!name || name === doc.title) return;
    await store.patchDoc(doc.id, { title: name });
    refresh();
  }

  async function editCover(doc) {
    const res = await openCoverEditor({ doc });
    if (!res) return;
    await store.patchDoc(doc.id, { title: res.title, cover: res.cover, paper: res.paper });
    popId = doc.id;
    refresh();
  }

  async function duplicate(doc) {
    try {
      const copy = await store.duplicateDoc(doc.id);
      popId = copy.id;
      await refresh();
      toast(`Duplicated “${doc.title}”`, { icon: 'copy' });
    } catch (err) { toast(err.message || 'Could not duplicate', { icon: 'info' }); }
  }

  async function remove(doc, card) {
    const n = (doc.pageIds || []).length;
    const ok = await confirmDialog({
      title: `Delete “${doc.title}”?`,
      message: doc.kind === 'notebook'
        ? `This notebook and its ${plural(n, 'page')} will be deleted from this device. This can’t be undone.`
        : 'This whiteboard will be deleted from this device. This can’t be undone.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    await animate(card, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.8)', opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
    await store.deleteDoc(doc.id);
    refresh();
  }

  async function create(kind, fromEl) {
    if (kind === 'notebook') {
      const res = await openCoverEditor({});
      if (!res) return;
      let doc;
      try { doc = await store.createNotebook(res); } catch (err) { console.error(err); toast('Couldn’t create the notebook. Your device may be out of space.', { icon: 'info', duration: 5000 }); return; }
      popId = doc.id;
      await refresh();
      // Let the new notebook "pop" onto the shelf, then open it from its card.
      setTimeout(() => {
        if (destroyed) return;
        const card = grid.querySelector(`[data-id="${doc.id}"] .card-main`);
        open(doc, card || fromEl);
      }, 520);
    } else {
      let choice = { background: 'dots', color: 'white' };
      const picker = boardPicker({ ...choice, onChange: c => { choice = c; } });
      const res = await alertDialog({
        title: 'New whiteboard',
        input: { value: '', placeholder: 'Name, e.g. Revision map' },
        content: h('div', { class: 'alert-extra' }, picker),
        buttons: [{ label: 'Cancel', value: false, style: 'cancel' }, { label: 'Create', value: true, style: 'primary' }],
      });
      if (!res || res.value !== true) return;
      let doc;
      try { doc = await store.createWhiteboard({ title: res.text, background: choice.background, color: choice.color }); } catch (err) { console.error(err); toast('Couldn’t create the whiteboard. Your device may be out of space.', { icon: 'info', duration: 5000 }); return; }
      popId = doc.id;
      await refresh();
      setTimeout(() => {
        if (destroyed) return;
        const card = grid.querySelector(`[data-id="${doc.id}"] .card-main`);
        open(doc, card || fromEl);
      }, 420);
    }
  }

  // ---------------------------------------------------------------- "Add to Home Screen" nudge (iOS tabs only)

  function renderBanner() {
    clear(banner);
    const s = app.settings;
    if (!isIOS() || isStandalone() || s.a2hsDismissed) return;
    const b = h('div', { class: 'lib-banner', 'data-squircle': '18' },
      h('span', { class: 'lib-banner-icon' }, icon('addHome', 24)),
      h('div', { class: 'lib-banner-text' },
        h('strong', null, 'Add to Home Screen to protect your notes'),
        h('span', null, 'Tap Share, then “Add to Home Screen”. Safari can clear notes from ordinary tabs after 7 days without use.')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onClick: () => { app.updateSettings({ a2hsDismissed: true }); b.remove(); } }, icon('close', 18, 2.4)));
    banner.append(b);
  }

  syncSeg();
  renderBanner();
  await refresh();
  if (opts.animate !== false) {
    animate(scroll, [{ opacity: 0, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE_OUT });
  }

  return {
    name: 'library', el, refresh,
    async leave() { destroyed = true; el.remove(); },
  };
}

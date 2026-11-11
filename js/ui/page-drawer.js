// Page drawer: thumbnails of every page; tap to go, drag to reorder, per-page menu, add page.
import { h, clear, animate, EASE_OUT, clamp } from './dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { openMenu } from './menu.js';
import * as store from '../store.js';
import { PAPER_COLORS } from '../canvas/constants.js';
import { makeThumbnail } from '../canvas/engine.js';

/**
 * openPageDrawer({getState:()=>({doc, currentId}), actions:{go(i), add(), duplicate(id), remove(id), move(from,to), paper(id)}})
 * Every action returns a promise; the drawer re-renders afterwards. → {refresh(), close(), closed}
 */
export function openPageDrawer({ getState, actions }) {
  const list = h('div', { class: 'pg-grid' });
  const body = h('div', { class: 'pg' }, list);
  let closed = false;
  let renderToken = 0;
  let suppressClick = false;
  const sheet = openSheet({ title: 'Pages', body, side: true, size: 'side', className: 'sheet--pages', onClose: () => { closed = true; } });

  async function run(fn) {
    try { await fn(); } catch (err) { console.error(err); }
    if (!closed) refresh();
  }

  function pageMenu(pid, i, n, anchor) {
    openMenu(anchor, [
      { label: 'Duplicate', icon: 'copy', onSelect: () => run(() => actions.duplicate(pid)) },
      { label: 'Change paper', icon: 'paper', onSelect: () => run(() => actions.paper(pid)) },
      { label: 'Move earlier', icon: 'arrowUp', disabled: i === 0, onSelect: () => run(() => actions.move(i, i - 1)) },
      { label: 'Move later', icon: 'arrowDown', disabled: i === n - 1, onSelect: () => run(() => actions.move(i, i + 1)) },
      { separator: true },
      { label: 'Delete page', icon: 'trash', danger: true, onSelect: () => run(() => actions.remove(pid)) },
    ], { title: `Page ${i + 1}` });
  }

  // ---------------------------------------------------------------- drag to reorder

  function attachDrag(tile) {
    let timer = null, start = null, dragging = false, ghost = null, lastSwap = 0, fromIndex = -1, pointerId = null, raf = 0, lastY = 0;
    const scroller = sheet.body;

    const tiles = () => [...list.querySelectorAll('.pg-tile[data-id]')];

    function begin(e) {
      dragging = true;
      fromIndex = tiles().indexOf(tile);
      const r = tile.getBoundingClientRect();
      ghost = tile.cloneNode(true);
      ghost.classList.add('pg-ghost');
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      ghost.dataset.ox = String(e.clientX - r.left); ghost.dataset.oy = String(e.clientY - r.top);
      document.body.append(ghost);
      animate(ghost, [{ transform: 'scale(1)' }, { transform: 'scale(1.06) rotate(-1.5deg)' }], { duration: 180, easing: EASE_OUT, fill: 'forwards' });
      tile.classList.add('is-placeholder');
      list.classList.add('is-sorting');
      try { navigator.vibrate && navigator.vibrate(8); } catch { /* not supported */ }
      autoScroll();
    }

    function autoScroll() {
      cancelAnimationFrame(raf);
      const step = () => {
        if (!dragging) return;
        const r = scroller.getBoundingClientRect();
        const edge = 56;
        if (lastY < r.top + edge) scroller.scrollTop -= clamp((r.top + edge - lastY) / 4, 2, 14);
        else if (lastY > r.bottom - edge) scroller.scrollTop += clamp((lastY - (r.bottom - edge)) / 4, 2, 14);
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    function move(e) {
      if (e.pointerId !== pointerId) return;
      lastY = e.clientY;
      if (!dragging) {
        const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (e.pointerType === 'mouse') { if (dist > 6) begin(e); else return; }
        else { if (dist > 8) cancelPending(); return; }
      }
      ghost.style.left = `${e.clientX - Number(ghost.dataset.ox)}px`;
      ghost.style.top = `${e.clientY - Number(ghost.dataset.oy)}px`;
      if (performance.now() - lastSwap < 160) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under && under.closest && under.closest('.pg-tile[data-id]');
      if (!target || target === tile || target.parentNode !== list) return;
      const all = tiles();
      const before = new Map(all.map(t => [t, t.getBoundingClientRect()]));
      if (all.indexOf(target) > all.indexOf(tile)) target.after(tile); else target.before(tile);
      lastSwap = performance.now();
      for (const t of all) {
        if (t === tile) continue;
        const a = before.get(t), b = t.getBoundingClientRect();
        const dx = a.left - b.left, dy = a.top - b.top;
        if (dx || dy) animate(t, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: EASE_OUT });
      }
    }

    function cancelPending() { clearTimeout(timer); timer = null; if (!dragging) detach(); }

    function detach() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      pointerId = null;
    }

    function finish() {
      cancelAnimationFrame(raf);
      clearTimeout(timer); timer = null;
      detach();
      if (ghost) { ghost.remove(); ghost = null; }
      tile.classList.remove('is-placeholder');
      list.classList.remove('is-sorting');
    }

    function up() {
      const was = dragging;
      dragging = false;
      const to = tiles().indexOf(tile);
      finish();
      if (!was) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 80);
      if (to !== fromIndex && to >= 0) run(() => actions.move(fromIndex, to));
    }

    function cancel() {
      const was = dragging;
      dragging = false;
      finish();
      if (was) refresh();
    }

    tile.addEventListener('pointerdown', e => {
      if ((e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.pg-more') || pointerId !== null) return;
      start = { x: e.clientX, y: e.clientY }; lastY = e.clientY; pointerId = e.pointerId;
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', cancel);
      if (e.pointerType !== 'mouse') timer = setTimeout(() => { timer = null; begin(e); }, 350);
    });
    // Once a drag has started, stop the list from scrolling under the finger (must be non-passive).
    tile.addEventListener('touchmove', e => { if (dragging && e.cancelable) e.preventDefault(); }, { passive: false });
    tile.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ---------------------------------------------------------------- render

  async function refresh() {
    const token = ++renderToken;
    const { doc, currentId } = getState();
    const thumbs = await store.getThumbs(doc.id);
    if (closed || token !== renderToken) return;
    const keepScroll = sheet.body.scrollTop;
    clear(list);
    const n = doc.pageIds.length;
    sheet.setTitle(n === 1 ? '1 page' : `${n} pages`);
    const missing = [];
    doc.pageIds.forEach((pid, i) => {
      const thumb = h('button', {
        class: 'pg-thumb', type: 'button', 'aria-label': `Go to page ${i + 1}`, 'aria-current': pid === currentId ? 'page' : null,
        onClick: () => { if (suppressClick) return; actions.go(i); sheet.close(); },
      }, h('span', { class: 'pg-img' }));
      const img = thumb.firstChild;
      if (thumbs[pid]) img.style.backgroundImage = `url("${thumbs[pid]}")`; else missing.push([pid, img]);
      const more = h('button', { class: 'icon-btn pg-more', type: 'button', 'aria-label': `Page ${i + 1} actions`, onClick: e => pageMenu(pid, i, n, e.currentTarget) }, icon('more', 18));
      const tile = h('div', { class: `pg-tile ${pid === currentId ? 'is-current' : ''}`, 'data-id': pid },
        thumb, h('div', { class: 'pg-foot' }, h('span', { class: 'pg-num' }, String(i + 1)), more));
      attachDrag(tile);
      list.append(tile);
    });
    list.append(h('div', { class: 'pg-tile pg-tile--add' },
      h('button', { class: 'pg-thumb pg-add', type: 'button', 'aria-label': 'Add page', onClick: () => run(() => actions.add()) },
        h('span', { class: 'new-plus' }, icon('plus', 22, 2.2))),
      h('div', { class: 'pg-foot' }, h('span', { class: 'pg-num pg-num--accent' }, 'Add page'))));
    sheet.body.scrollTop = keepScroll;
    const cur = list.querySelector('.is-current');
    if (cur && token === 1) cur.scrollIntoView({ block: 'center' });

    // Pages without a preview yet (new, duplicated from a backup…): render them one at a time.
    for (const [pid, img] of missing) {
      if (closed || token !== renderToken) return;
      try {
        const page = await store.getPage(pid);
        if (!page) continue;
        img.style.backgroundColor = PAPER_COLORS[page.paper?.color] || '#fff';
        const data = await makeThumbnail(page, 'notebook');
        img.style.backgroundImage = `url("${data}")`;
        store.putThumb(pid, doc.id, data).catch(() => {});
      } catch { /* preview only */ }
    }
  }

  refresh();
  return { refresh, close: () => sheet.close(), closed: sheet.closed };
}

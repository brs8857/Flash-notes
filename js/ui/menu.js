// Popovers and menus anchored to a button (glass, spring scale-in from the anchor).
import { h, on, clamp, reducedMotion } from './dom.js';
import { icon } from './icons.js';

let openPops = 0;   // z-index = 500 + popovers currently open

/**
 * openPopover(anchor, content, {className, placement:'bottom'|'top', align:'center'|'start'|'end', onClose, label})
 * anchor: an element or a DOMRect-like {left, top, right, bottom, width, height}.
 * → {el, close(), reposition()}
 */
export function openPopover(anchor, content, opts = {}) {
  const { className = '', placement = 'bottom', align = 'center', onClose, label = 'Options', gap = 10 } = opts;
  const prevFocus = document.activeElement;
  const catcher = h('div', { class: 'pop-catcher', style: { zIndex: String(500 + 2 * ++openPops) } });
  const pop = h('div', { class: `popover ${className}`, role: 'dialog', 'aria-label': label, tabIndex: -1, style: { zIndex: String(501 + 2 * openPops) } },
    h('div', { class: 'popover-inner' }, content));
  let closed = false;

  function rectOf() {
    return anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  }

  function reposition() {
    const r = rectOf();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = pop.offsetWidth, ht = pop.offsetHeight;
    const m = 8;
    let x = align === 'start' ? r.left : align === 'end' ? r.right - w : r.left + r.width / 2 - w / 2;
    x = clamp(x, m, Math.max(m, vw - w - m));
    let below = placement === 'bottom';
    if (below && r.bottom + gap + ht > vh - m && r.top - gap - ht >= m) below = false;
    else if (!below && r.top - gap - ht < m && r.bottom + gap + ht <= vh - m) below = true;
    let y = below ? r.bottom + gap : r.top - gap - ht;
    y = clamp(y, m, Math.max(m, vh - ht - m));
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
    const ox = clamp(r.left + r.width / 2 - x, 12, w - 12);
    pop.style.transformOrigin = `${Math.round(ox)}px ${below ? '0px' : '100%'}`;
  }

  function close() {
    if (closed) return;
    closed = true;
    openPops = Math.max(0, openPops - 1);
    offKey(); offResize();
    if (ro) ro.disconnect();
    catcher.remove();
    pop.classList.remove('is-open');
    pop.classList.add('is-closing');
    setTimeout(() => pop.remove(), reducedMotion() ? 0 : 120);
    try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (onClose) onClose();
  }

  catcher.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); close(); });
  catcher.addEventListener('contextmenu', e => e.preventDefault());
  const offKey = on(document, 'keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
  }, true);
  const offResize = on(window, 'resize', () => close());

  document.body.append(catcher, pop);
  reposition();
  // Content that grows after opening (a colour picker, a longer list) must not slide under the screen edge.
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    let size = `${pop.offsetWidth}x${pop.offsetHeight}`;
    ro = new ResizeObserver(() => {
      const now = `${pop.offsetWidth}x${pop.offsetHeight}`;
      if (now !== size && !closed) { size = now; reposition(); }
    });
    ro.observe(pop);
  }
  void pop.offsetHeight;
  pop.classList.add('is-open');
  pop.focus({ preventScroll: true });
  return { el: pop, close, reposition };
}

/**
 * openMenu(anchor, items, {title, align})
 * items: {label, icon?, danger?, checked?, disabled?, hint?, onSelect} | {separator:true} | null
 * onSelect runs synchronously inside the tap (so file pickers / keyboards / share sheets may be opened).
 */
export function openMenu(anchor, items, opts = {}) {
  const list = h('div', { class: 'menu', role: 'menu' });
  if (opts.title) list.append(h('div', { class: 'menu-title' }, opts.title));
  let pop = null;
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { list.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    const hasCheck = 'checked' in it;
    const btn = h('button', {
      type: 'button', role: hasCheck ? 'menuitemcheckbox' : 'menuitem',
      class: `menu-item ${it.danger ? 'menu-item--danger' : ''}`,
      disabled: !!it.disabled,
      'aria-checked': hasCheck ? String(!!it.checked) : null,
      onClick: () => { pop.close(); it.onSelect && it.onSelect(); },
    },
      hasCheck ? h('span', { class: 'menu-check' }, it.checked ? icon('check', 17, 2.6) : null) : null,
      h('span', { class: 'menu-label' }, it.label, it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null),
      it.icon ? h('span', { class: 'menu-icon' }, icon(it.icon, 19)) : null);
    list.append(btn);
  }
  pop = openPopover(anchor, list, { className: 'popover--menu', align: opts.align || 'end', placement: opts.placement || 'bottom', label: opts.title || 'Menu', gap: 8 });
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...list.querySelectorAll('.menu-item:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    const n = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
    btns[n] && btns[n].focus();
  });
  return pop;
}

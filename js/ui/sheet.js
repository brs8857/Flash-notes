// Sheets (bottom sheet on iPhone, centred modal on iPad, optional side drawer) and iOS-style alerts.
import { h, on, isNarrow, wait, reducedMotion } from './dom.js';
import { icon } from './icons.js';

let openLayers = 0;   // z-index = 200 + number of sheets/alerts currently open (never grows without bound)
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';

function trapFocus(panel, e) {
  if (e.key !== 'Tab') return;
  const items = [...panel.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * openSheet({title, body, size:'sm'|'md'|'lg', side, cancelLabel, doneLabel, onDone, onClose, dismissible})
 * → {el, panel, body, close(result), closed: Promise<result>, setDoneEnabled(bool), setTitle(str)}
 * onDone may return false (or a promise of false) to keep the sheet open.
 */
export function openSheet(opts) {
  const {
    title = '', body, size = 'md', side = false, cancelLabel, doneLabel, onDone, onClose,
    dismissible = true, className = '',
  } = opts;
  const prevFocus = document.activeElement;
  let closedResolve;
  const closed = new Promise(r => { closedResolve = r; });
  let isClosed = false;

  const titleEl = h('div', { class: 'sheet-title' }, title);
  const cancelBtn = cancelLabel ? h('button', { class: 'sheet-btn', type: 'button', onClick: () => close(null) }, cancelLabel) : null;
  const doneBtn = doneLabel ? h('button', { class: 'sheet-btn sheet-btn--done', type: 'button', onClick: done }, doneLabel) : null;
  const closeBtn = (!cancelLabel && !doneLabel)
    ? h('button', { class: 'icon-btn icon-btn--fill sheet-x', type: 'button', 'aria-label': 'Close', onClick: () => close(null) }, icon('close', 18, 2.4))
    : null;
  const header = h('div', { class: 'sheet-header' },
    h('div', { class: 'sheet-grabber', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-bar' },
      h('div', { class: 'sheet-bar-side' }, cancelBtn),
      titleEl,
      h('div', { class: 'sheet-bar-side sheet-bar-side--end' }, doneBtn, closeBtn)));
  const bodyEl = h('div', { class: 'sheet-body' }, body);
  const panel = h('div', {
    class: `sheet sheet--${size} ${side ? 'sheet--side' : ''} ${className}`,
    role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog', tabIndex: -1,
  }, header, bodyEl);
  const scrim = h('div', { class: 'sheet-scrim' });
  const root = h('div', { class: `sheet-root ${side ? 'sheet-root--side' : ''}`, style: { zIndex: String(200 + ++openLayers) } }, scrim, panel);

  async function done() {
    if (!onDone) { close(true); return; }
    const r = await onDone();
    if (r !== false) close(r === undefined ? true : r);
  }

  function close(result = null) {
    if (isClosed) return;
    isClosed = true;
    openLayers = Math.max(0, openLayers - 1);
    offKey();
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    const finish = () => { root.remove(); };
    if (reducedMotion()) finish(); else setTimeout(finish, 320);
    try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (onClose) onClose(result);
    closedResolve(result);
  }

  if (dismissible) scrim.addEventListener('click', () => close(null));
  const offKey = on(root, 'keydown', e => {
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(null); }
    else trapFocus(panel, e);
  });

  // Drag-to-dismiss (bottom-sheet presentation only).
  if (dismissible) {
    let startY = 0, dy = 0, dragging = false, t0 = 0;
    header.addEventListener('pointerdown', e => {
      if (side || !isNarrow() || e.target.closest('button')) return;
      dragging = true; startY = e.clientY; dy = 0; t0 = performance.now();
      header.setPointerCapture?.(e.pointerId);
      panel.style.transition = 'none';
    });
    header.addEventListener('pointermove', e => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      panel.style.transform = `translateY(${dy}px)`;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = '';
      const v = dy / Math.max(1, performance.now() - t0);
      if (dy > 120 || (dy > 40 && v > 0.6)) { panel.style.transform = ''; close(null); }
      else panel.style.transform = '';
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  document.body.append(root);
  // Force a style flush so the entry transition runs, then open.
  void panel.offsetHeight;
  root.classList.add('is-open');
  panel.focus({ preventScroll: true });

  return {
    el: root, panel, body: bodyEl, close, closed,
    setDoneEnabled(v) { if (doneBtn) doneBtn.disabled = !v; },
    setTitle(t) { titleEl.textContent = t; panel.setAttribute('aria-label', t); },
  };
}

/**
 * iOS-style alert. buttons: [{label, value, style:'default'|'cancel'|'danger'|'primary'}].
 * input: {value, placeholder, maxLength} adds a text field; then resolves {value, text}.
 * Must be called synchronously from a tap so iOS raises the keyboard for the input.
 */
export function alertDialog({ title, message, buttons, input, content }) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    let field = null;
    if (input) {
      field = h('input', {
        class: 'alert-input', type: 'text', value: input.value || '', placeholder: input.placeholder || '',
        maxlength: String(input.maxLength || 80), autocomplete: 'off', autocapitalize: 'sentences',
        enterkeyhint: 'done', 'aria-label': input.placeholder || title,
      });
    }
    const cancelBtn = buttons.find(b => b.style === 'cancel');
    const primary = buttons.find(b => b.style === 'primary') || buttons.find(b => b.style !== 'cancel');
    const btnEls = buttons.map(b => h('button', {
      type: 'button', class: `alert-btn alert-btn--${b.style || 'default'}`, onClick: () => finish(b),
    }, b.label));
    const card = h('div', { class: 'alert', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
      h('div', { class: 'alert-content' },
        h('div', { class: 'alert-title' }, title),
        message ? h('div', { class: 'alert-message' }, message) : null,
        content || null,
        field),
      h('div', { class: `alert-actions ${buttons.length > 2 ? 'alert-actions--stack' : ''}` }, btnEls));
    const root = h('div', { class: 'alert-root', style: { zIndex: String(1000 + ++openLayers) } }, h('div', { class: 'sheet-scrim' }), card);
    let finished = false;

    function finish(b) {
      if (finished) return;
      finished = true;
      openLayers = Math.max(0, openLayers - 1);
      root.classList.remove('is-open');
      root.classList.add('is-closing');
      if (field) field.blur();
      setTimeout(() => root.remove(), reducedMotion() ? 0 : 240);
      try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      const value = b ? b.value : null;
      resolve(input ? { value, text: field.value.trim() } : value);
    }

    root.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(cancelBtn || { value: null }); }
      else if (e.key === 'Enter' && (e.target === field || e.target === card)) { e.preventDefault(); finish(primary); }
      else trapFocus(card, e);
    });

    document.body.append(root);
    void card.offsetHeight;
    root.classList.add('is-open');
    if (field) { field.focus({ preventScroll: true }); field.select(); }
    else card.focus({ preventScroll: true });
  });
}

export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return alertDialog({
    title, message,
    buttons: [
      { label: cancelLabel, value: false, style: 'cancel' },
      { label: confirmLabel, value: true, style: danger ? 'danger' : 'primary' },
    ],
  }).then(v => v === true);
}

/** Resolves the entered text, or null when cancelled / left empty. */
export function promptDialog({ title, message, value = '', placeholder = '', confirmLabel = 'Save' }) {
  return alertDialog({
    title, message, input: { value, placeholder },
    buttons: [
      { label: 'Cancel', value: false, style: 'cancel' },
      { label: confirmLabel, value: true, style: 'primary' },
    ],
  }).then(r => (r.value === true && r.text ? r.text : null));
}

export { wait };

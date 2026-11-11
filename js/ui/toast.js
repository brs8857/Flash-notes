// Toasts: small glass pills at the top of the screen.
import { h, reducedMotion } from './dom.js';
import { icon } from './icons.js';

let host = null;
function getHost() {
  if (!host || !document.contains(host)) {
    host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

/** toast('Saved', {icon:'check', actionLabel:'Undo', onAction(){}, duration:3200, sticky:false}) → {dismiss()} */
export function toast(message, opts = {}) {
  const { actionLabel, onAction, duration = 3200, sticky = false } = opts;
  let gone = false, timer = null;
  const el = h('div', { class: `toast ${opts.kind ? 'toast--' + opts.kind : ''}` },
    opts.icon ? h('span', { class: 'toast-icon' }, icon(opts.icon, 18, 2.2)) : null,
    h('span', { class: 'toast-msg' }, message),
    actionLabel ? h('button', { class: 'toast-action', type: 'button', onClick: () => { dismiss(); onAction && onAction(); } }, actionLabel) : null,
    sticky ? h('button', { class: 'toast-x', type: 'button', 'aria-label': 'Dismiss', onClick: () => dismiss() }, icon('close', 14, 2.6)) : null);

  function dismiss() {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.remove('is-open');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 260);
  }

  getHost().append(el);
  void el.offsetHeight;
  el.classList.add('is-open');
  if (!sticky) timer = setTimeout(dismiss, duration);
  return { dismiss, el };
}

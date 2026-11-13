// The sign-in screen: one official "Sign in with Google" button, its loading and error states, and a
// short privacy notice. Shown by the router whenever a configured site has no signed-in user.
import { h, clear } from './dom.js';
import { exportBackup } from './export.js';
import { signIn } from '../auth/auth.js';
import { authMessage } from '../auth/guard.js';
import * as local from '../sync/local.js';

/**
 * Google's sign-in button, following the "Sign in with Google" branding guidelines: the unmodified
 * four-colour "G" (icons/google-g.svg), the approved label, the light theme (white fill, #747775 border,
 * #1F1F1F text) or dark theme (#131314 fill, #8E918F border, #E3E3E3 text), pill shape, 40 px tall,
 * Roboto Medium 14/20 with a system-font fallback. Colours and spacing live in css/app.css (.gsi-btn).
 */
function googleButton(onClick) {
  const logo = h('img', { class: 'gsi-logo', src: './icons/google-g.svg', alt: '', width: '18', height: '18', draggable: 'false' });
  const label = h('span', { class: 'gsi-label' }, 'Sign in with Google');
  const spinner = h('span', { class: 'gsi-spinner', 'aria-hidden': 'true' });
  const btn = h('button', { class: 'gsi-btn', type: 'button', onClick }, logo, spinner, label);
  return { btn, label };
}

export async function mountLogin(root, app, { error } = {}) {
  let busy = false;
  let destroyed = false;

  const alertBox = h('div', { class: 'login-error', role: 'alert', hidden: true });
  const status = h('div', { class: 'login-status', role: 'status', 'aria-live': 'polite' });
  const offlineNote = h('div', { class: 'login-offline', hidden: true }, 'You’re offline. Connect to the internet to sign in.');
  const { btn, label } = googleButton(start);

  function showError(kind) {
    if (!kind) { alertBox.hidden = true; clear(alertBox); return; }
    alertBox.textContent = authMessage(kind);       // fixed, generic wording; never the server's text
    alertBox.dataset.kind = kind;
    alertBox.hidden = false;
  }
  function setBusy(on, text) {
    busy = on;
    btn.disabled = on;
    btn.classList.toggle('is-loading', on);
    btn.setAttribute('aria-busy', String(on));
    label.textContent = on ? 'Signing in…' : 'Sign in with Google';
    status.textContent = on ? (text || 'Opening Google…') : '';
  }
  async function start() {
    if (busy) return;
    showError(null);
    setBusy(true, 'Opening Google…');
    try {
      await signIn('google');                       // on success the browser leaves this page
      setTimeout(() => { if (!destroyed && busy) { setBusy(false); showError('provider'); } }, 20000);
    } catch (err) {
      setBusy(false);
      showError((err && err.code) || 'unknown');
    }
  }
  // Coming back with the browser's Back button restores this page as it was: undo the loading state.
  const onPageShow = e => { if (e.persisted && busy) { setBusy(false); showError('cancelled'); } };
  const onNet = () => { offlineNote.hidden = navigator.onLine !== false; };
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  onNet();

  // Notes made on this device before accounts existed: say what will happen, and offer a way out.
  const localNote = h('div', { class: 'login-local', hidden: true });
  (async () => {
    try {
      const [count, state] = await Promise.all([local.countDocs(), local.getState()]);
      if (destroyed || !count) return;
      for (const node of [
        h('p', null, state.userId
          ? 'Notes from your account are still saved on this device. Sign in again to open them.'
          : `This device already has ${count === 1 ? '1 notebook' : count + ' notebooks'}. When you sign in they are added to your account, and a copy stays on this device.`),
        // An account's notes are not handed out without signing in; notes that belong to nobody yet are.
        state.userId ? null : h('button', { class: 'btn btn--quiet login-backup', type: 'button', onClick: () => exportBackup() }, 'Download a backup first'),
      ]) if (node) localNote.append(node);
      localNote.hidden = false;
    } catch { /* storage trouble: the sign-in still works */ }
  })();

  const el = h('main', { class: 'login' },
    h('div', { class: 'login-card glass', 'data-squircle': '30' },
      h('div', { class: 'login-icon', 'data-squircle': '18', 'aria-hidden': 'true' }),
      h('h1', { class: 'login-title' }, 'Flash Notes'),
      h('p', { class: 'login-sub' }, 'Sign in to keep your notes private to you and the same on every device.'),
      alertBox,
      offlineNote,
      btn,
      status,
      localNote,
      h('p', { class: 'login-privacy' },
        'We only get your name and email address from Google, to make your account. Your notes are private: only you can open them. No ads, no tracking. ',
        h('a', { href: './privacy.html', class: 'login-link' }, 'Privacy policy'))));

  root.append(el);
  if (error) showError(error);

  return {
    name: 'login', el,
    async leave() {
      destroyed = true;
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
      el.remove();
    },
  };
}

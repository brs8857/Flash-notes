// Flash Notes — app shell: boot, hash router, theme, settings, service worker.
import { h, animate, EASE_OUT, wait, reducedMotion, idle, plural } from './ui/dom.js';
import { squircleAll } from './ui/squircle.js';
import { toast } from './ui/toast.js';
import { mountLibrary } from './ui/library.js';
import { mountEditor } from './ui/editor.js';
import * as store from './store.js';
import { ensureHandFont } from './canvas/fonts.js';
import { initAuth, watchSession, authConfigured, currentUser, onAuthChange, takeAuthError, signOut } from './auth/auth.js';
import { routeDecision } from './auth/guard.js';
import { mountLogin } from './ui/login.js';
import { alertDialog } from './ui/sheet.js';
import { onRemoteData } from './sync/sync.js';
import * as account from './account.js';

const VERSION = '2.0';
const root = document.getElementById('app');
const settingsListeners = new Set();
let current = null;           // the mounted view: {name, leave(), ...}
let routing = Promise.resolve();
let pendingFx = null;         // open animation requested by the library
let cameFromLibrary = false;  // true when the editor was opened by an in-app navigation (so Back can pop history)
let lastPop = null;

const app = {
  version: VERSION,
  settings: { theme: 'system', twoFingerUndo: true },

  /** Go to a hash route. opts.fx = {rect, color} plays the "open from card" animation. */
  navigate(hash, opts = {}) {
    pendingFx = opts.fx || null;
    if (location.hash === hash) { route(); return; }
    cameFromLibrary = current && current.name === 'library';
    location.hash = hash;
  },
  /** Change the URL without adding history (page turns inside a notebook). */
  replaceHash(hash) {
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  },
  /** Back to the library; uses real history when we came from there so swipe-back stays consistent. */
  back() {
    if (cameFromLibrary && history.length > 1) { cameFromLibrary = false; history.back(); }
    else { history.replaceState(null, '', '#/'); route(); }
  },
  updateSettings(partial) {
    app.settings = { ...app.settings, ...partial };
    if ('theme' in partial) applyTheme(app.settings.theme);
    settingsListeners.forEach(fn => { try { fn(app.settings); } catch (err) { console.error(err); } });
    return store.saveSettings(partial).catch(err => console.error(err));
  },
  onSettings(fn) { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
};

// ---------------------------------------------------------------- theme

function applyTheme(theme) {
  const el = document.documentElement;
  if (theme === 'light' || theme === 'dark') el.setAttribute('data-theme', theme); else el.removeAttribute('data-theme');
  try { if (theme === 'light' || theme === 'dark') localStorage.setItem('fln.theme', theme); else localStorage.removeItem('fln.theme'); } catch { /* private mode */ }
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  const light = '#F5F3EF', dark = '#0E0E10';
  metas.forEach((m, i) => {
    m.setAttribute('content', theme === 'light' ? light : theme === 'dark' ? dark : (i === 0 ? light : dark));
  });
}

// ---------------------------------------------------------------- router

function parse(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
  if (parts[0] === 'nb' && parts[1]) return { name: 'nb', docId: dec(parts[1]), pageIndex: Math.max(0, parseInt(parts[2], 10) || 0) };
  if (parts[0] === 'wb' && parts[1]) return { name: 'wb', docId: dec(parts[1]), pageIndex: 0 };
  return { name: 'library' };
}

function route() {
  routing = routing.then(doRoute).catch(err => {
    console.error(err);
    toast('Something went wrong opening that. Your notes are safe.', { icon: 'info' });
  });
  return routing;
}

function playOpenFx(fx) {
  if (!fx || !fx.rect || reducedMotion()) return null;
  const r = fx.rect;
  const el = h('div', { class: 'open-fx', style: {
    left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    background: fx.color ? `linear-gradient(140deg, ${fx.color}, ${fx.color})` : 'var(--surface)',
  } });
  document.body.append(el);
  const grown = animate(el, [
    { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: '14px', opacity: 0.4 },
    { opacity: 1, offset: 0.25 },
    { left: '0px', top: '0px', width: '100vw', height: '100vh', borderRadius: '0px', opacity: 1 },
  ], { duration: 240, easing: EASE_OUT, fill: 'forwards' });
  return { el, grown };
}

/**
 * Route guard (v2.0). On a site with accounts, nobody reaches a notes screen without a signed-in user:
 * every route passes through here. Returns true when the route may be shown.
 */
async function guard() {
  if (routeDecision({ configured: authConfigured(), user: currentUser() }) === 'login') {
    if (current && current.name === 'login') return false;
    const prev = current;
    current = null;
    account.left();                                           // stop background sync
    document.querySelectorAll('.sheet-root, .alert-root').forEach(el => el.remove());
    if (prev) await prev.leave();
    cameFromLibrary = false;
    current = await mountLogin(root, app, { error: takeAuthError() });
    return false;
  }
  if (current && current.name === 'login') { const p = current; current = null; await p.leave(); }
  if (!authConfigured()) return true;

  const user = currentUser();
  const entered = await account.enter(user);                  // first sign-in: adopt the notes on this device
  if (entered.decision === 'conflict') {
    // Notes of a different account are still on this device. They are never mixed into this account.
    const choice = await alertDialog({
      title: 'Notes from another account',
      message: `This device still holds notes from a different account${entered.hint ? ` (${entered.hint})` : ''}. They can’t be added to yours.\n\nErase them from this device to continue? Anything that account had not finished uploading will be lost.`,
      buttons: [
        { label: 'Erase and continue', value: 'erase', style: 'danger' },
        { label: 'Sign out', value: null, style: 'cancel' },
      ],
    });
    if (choice !== 'erase') { await signOut(); return false; }   // back to the login screen, nothing changed
    await account.eraseOtherAndEnter(user);
  } else if (entered.decision === 'adopt' && entered.backup) {
    toast(`Adding ${plural(entered.backup.docs, 'notebook')} from this device to your account. A copy stays here.`, { icon: 'shield', duration: 5000 });
  }
  return true;
}

async function doRoute() {
  if (!(await guard())) return;
  const r = parse(location.hash);
  const fx = pendingFx; pendingFx = null;

  if (r.name === 'library') {
    if (current && current.name === 'library') return;
    const prev = current;
    current = null;
    if (prev) await prev.leave();
    current = await mountLibrary(root, app, { popId: lastPop });
    lastPop = null;
    return;
  }

  // Same notebook already open: just turn the page.
  if (current && current.docId === r.docId && current.name === r.name) {
    if (r.name === 'nb') await current.goTo(r.pageIndex);
    return;
  }

  const prev = current;
  if (prev && prev.name !== 'library') { current = null; await prev.leave(); }
  const anim = prev && prev.name === 'library' ? playOpenFx(fx) : null;

  let ed = null;
  try {
    [ed] = await Promise.all([mountEditor(root, app, { docId: r.docId, pageIndex: r.pageIndex, hidden: !!anim }), anim ? anim.grown : null]);
  } catch (err) {
    console.error(err);
  }
  if (!ed || ed.name !== r.name) {
    if (ed) await ed.leave();
    if (anim) anim.el.remove();
    toast('That notebook isn’t on this device any more.', { icon: 'info' });
    history.replaceState(null, '', '#/');
    cameFromLibrary = false;
    if (!(prev && prev.name === 'library')) { current = await mountLibrary(root, app, {}); }
    else current = prev;
    return;
  }
  if (prev && prev.name === 'library') await prev.leave();
  ed.el.style.visibility = '';
  current = ed;
  if (anim) {
    await animate(anim.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
    anim.el.remove();
  }
}

// ---------------------------------------------------------------- service worker

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  let offered = false;

  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (!reg) return;
    const offer = () => {
      // Only when an OLD version is controlling this page and a NEW one is waiting.
      if (offered || !reg.waiting || !navigator.serviceWorker.controller) return;
      offered = true;
      toast('Update available — tap to reload', {
        icon: 'sparkle', sticky: true, actionLabel: 'Reload',
        onAction: async () => {
          let reloaded = false;
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloaded) return;
            reloaded = true;
            location.reload();
          }, { once: true });
          try { if (current && current.name !== 'library') { const c = current; current = null; await c.leave(); } } catch { /* keep going */ }
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          else { offered = false; route(); }   // nothing to activate any more: put the screen we just closed back
        },
      });
    };
    offer();
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (sw) sw.addEventListener('statechange', () => { if (sw.state === 'installed') offer(); });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(err => console.warn('Service worker registration failed', err));
}

// ---------------------------------------------------------------- boot

function globalGuards() {
  // iOS: stop page pinch-zoom on non-engine screens (the engine handles its own gestures).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, e => e.preventDefault(), { passive: false });
  }
  // No long-press / right-click browser menus on the app chrome (text fields keep theirs).
  document.addEventListener('contextmenu', e => {
    if (!(e.target.closest && e.target.closest('input, textarea'))) e.preventDefault();
  });
  // An (empty) touchstart listener makes :active states work on iOS.
  document.addEventListener('touchstart', () => {}, { passive: true });
  // Safari can scroll the fixed body when the keyboard opens; put it back afterwards.
  document.addEventListener('focusout', () => { setTimeout(() => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); }, 60); });
  document.addEventListener('dragstart', e => e.preventDefault());
}

async function boot() {
  globalGuards();
  ensureHandFont();   // handwriting font for text boxes: canvases never trigger the download themselves
  squircleAll();
  try {
    await store.openDB();
    app.settings = await store.getSettings();
  } catch (err) {
    console.error(err);
    root.append(h('div', { class: 'boot-error' },
      h('div', null,
        h('h2', null, 'Flash Notes can’t save on this browser'),
        h('p', { style: 'margin-top:8px' }, 'Storage is turned off (for example in Private Browsing). Open Flash Notes in a normal Safari tab or from your Home Screen.'))));
    return;
  }
  applyTheme(app.settings.theme);
  await initAuth();                                   // finishes a sign-in redirect, or restores the cached session (works offline)
  onAuthChange(() => { route(); });                   // signed out, session expired, signed in from another tab
  onRemoteData(() => { if (current && current.name === 'library') current.refresh(); });
  if (!location.hash || location.hash === '#' || !location.hash.startsWith('#/')) history.replaceState(null, '', location.pathname + location.search + '#/');
  window.addEventListener('hashchange', () => { route(); });
  await route();
  await wait(0);
  registerServiceWorker();
  if (authConfigured()) idle(() => { watchSession(); }, 3000);   // supabase-js loads after the app is on screen
}

boot();

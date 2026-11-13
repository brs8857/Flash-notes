// Background sync: decides WHEN the engine (core.js) runs. It never blocks drawing: saving a stroke only
// writes to IndexedDB; this file notices the change afterwards and uploads it when the device is idle.
import * as store from '../store.js';
import * as local from './local.js';
import { createSync } from './core.js';
import { createRemote } from './remote.js';
import { getClient, handleAuthFailure, signOut, currentUser } from '../auth/auth.js';
import { isAuthFailure } from '../auth/guard.js';
import { idle, wait } from '../ui/dom.js';
import { log } from '../log.js';

const AFTER_CHANGE_MS = 2500;        // wait for a pause in writing before uploading
const MIN_GAP_MS = 2000;             // never more than one round every 2 s
const POLL_MS = 60000;               // look for changes from other devices once a minute while visible
const QUIET_AFTER_TOUCH_MS = 1200;   // not while a finger or Pencil is on the screen, or just after
const MAX_ROWS_PER_MIN = 600;        // client-side throttle (the database refuses more than 1,200 a minute)
const BACKOFF_MAX_MS = 5 * 60000;

let active = null;                   // {userId, engine, remote, didFull, profileOk}
let running = false;
let timer = null;
let pollTimer = null;
let lastRun = 0;
let backoff = 0;
let pointerDown = false;
let lastPointer = 0;
let unsubscribe = null;
let status = { state: 'off', pending: 0, lastSyncedAt: null, blocked: 0 };
const statusListeners = new Set();
const dataListeners = new Set();
const sent = [];                     // [time, rows] in the last minute

const online = () => navigator.onLine !== false;

function setStatus(patch) {
  status = { ...status, ...patch };
  statusListeners.forEach(fn => { try { fn(status); } catch (err) { log.error('sync', 'status listener failed', err); } });
}
export const getSyncStatus = () => status;
export function onSyncStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
/** fn() runs after changes from another device were written to this device. */
export function onRemoteData(fn) { dataListeners.add(fn); return () => dataListeners.delete(fn); }

async function budget(rows) {
  for (;;) {
    const cut = Date.now() - 60000;
    while (sent.length && sent[0][0] < cut) sent.shift();
    const used = sent.reduce((n, s) => n + s[1], 0);
    if (used + rows <= MAX_ROWS_PER_MIN || !sent.length) break;
    await wait(1000);
    if (!active) throw new Error('stopped');
  }
  sent.push([Date.now(), rows]);
}

async function quiet() {
  await wait(60);
  while (active && (pointerDown || Date.now() - lastPointer < QUIET_AFTER_TOUCH_MS)) await wait(300);
}

const onDown = () => { pointerDown = true; lastPointer = Date.now(); };
const onUp = () => { pointerDown = false; lastPointer = Date.now(); };
const onOnline = () => { backoff = 0; setStatus({ state: 'idle' }); pokeSync(300); };
const onOffline = () => setStatus({ state: 'offline' });
const onVisible = () => { if (document.visibilityState === 'visible') pokeSync(500); };

/** Starts background sync for the signed-in user. Safe to call again for the same user. */
export function startSync(user) {
  if (active && active.userId === user.id) return;
  stopSync();
  const remote = createRemote({ getClient, userId: user.id, local });
  const throttled = { ...remote, push: async (kind, rows) => { await budget(rows.length); return remote.push(kind, rows); } };
  active = { userId: user.id, remote, engine: createSync({ local, remote: throttled, pause: quiet }), didFull: false, profileOk: false };
  store.setSyncTracking(true);
  unsubscribe = store.onLocalChange(() => { refreshPending(); pokeSync(AFTER_CHANGE_MS); });
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.addEventListener('pointerup', onUp, { capture: true, passive: true });
  document.addEventListener('pointercancel', onUp, { capture: true, passive: true });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pokeSync(0); }, POLL_MS);
  setStatus({ state: online() ? 'idle' : 'offline', pending: 0, blocked: 0 });
  refreshPending();
  local.getState().then(s => setStatus({ lastSyncedAt: s.lastSyncedAt || null })).catch(() => {});
  pokeSync(600);
}

export function stopSync() {
  if (!active) return;
  active = null;
  clearTimeout(timer); timer = null;
  clearInterval(pollTimer); pollTimer = null;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  store.setSyncTracking(false);
  document.removeEventListener('pointerdown', onDown, { capture: true });
  document.removeEventListener('pointerup', onUp, { capture: true });
  document.removeEventListener('pointercancel', onUp, { capture: true });
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
  document.removeEventListener('visibilitychange', onVisible);
  backoff = 0;
  setStatus({ state: 'off', pending: 0, blocked: 0 });
}

async function refreshPending() {
  try {
    const rows = await local.dirty();
    setStatus({ pending: rows.filter(r => !r.blocked).length, blocked: rows.filter(r => r.blocked).length });
  } catch { /* ignore */ }
}

/** Ask for a sync round soon. Cheap; call as often as you like. */
export function pokeSync(delay = AFTER_CHANGE_MS) {
  if (!active) return;
  clearTimeout(timer);
  const gap = Math.max(delay, backoff, MIN_GAP_MS - (Date.now() - lastRun));
  timer = setTimeout(() => idle(() => { round().catch(() => {}); }, 2000), Math.max(0, gap));
}

/** Runs one round now and waits for it (sign-out uses this to send the last changes). → true when nothing is left. */
export async function syncNow() {
  if (!active) return true;
  for (let i = 0; i < 40 && running; i++) await wait(250);
  const left = await round(true);
  return left === 0;
}

export function getRemote() { return active ? active.remote : null; }

async function round(force = false) {
  const me = active;
  if (!me || running) return -1;
  if (!online()) { setStatus({ state: 'offline' }); return -1; }
  if (!force && (pointerDown || Date.now() - lastPointer < QUIET_AFTER_TOUCH_MS)) { pokeSync(QUIET_AFTER_TOUCH_MS); return -1; }
  running = true;
  lastRun = Date.now();
  setStatus({ state: 'syncing' });
  let left = -1;
  try {
    if (!me.profileOk) {
      const profile = await me.remote.ensureProfile();
      if (profile.verified !== true) {            // the database does not trust this account: stop here
        log.warn('sync', 'account is not verified; signing out');
        running = false;
        await signOut();
        return -1;
      }
      me.profileOk = true;
    }
    const r = await me.engine.syncOnce({ full: !me.didFull });
    if (active !== me) return -1;
    me.didFull = true;
    left = r.left;
    const state = await local.getState();
    const patch = { lastSyncedAt: Date.now() };
    if (state.adoptedAt && !state.verifiedAt && r.left === 0 && await me.engine.verify()) patch.verifiedAt = Date.now();
    await local.patchState(patch);
    backoff = 0;
    setStatus({ state: 'idle', lastSyncedAt: patch.lastSyncedAt });
    if (r.applied) dataListeners.forEach(fn => { try { fn(); } catch (err) { log.error('sync', 'data listener failed', err); } });
    if (r.left) pokeSync(MIN_GAP_MS);
  } catch (err) {
    if (active !== me) return -1;
    if (isAuthFailure(err)) {
      const retry = await handleAuthFailure();     // 401: one token refresh, otherwise back to the login screen
      if (retry) pokeSync(MIN_GAP_MS);
      else if (currentUser()) {                    // the refresh failed for network reasons: the session is still good, try later
        backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : 5000);
        pokeSync(backoff);
      }
      setStatus({ state: retry ? 'idle' : currentUser() ? (online() ? 'error' : 'offline') : 'signin' });
    } else {
      log.warn('sync', 'round failed; will retry', err);
      backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : 5000);
      setStatus({ state: online() ? 'error' : 'offline' });
      pokeSync(backoff);
    }
  } finally {
    running = false;
    if (active === me) refreshPending();
  }
  return left;
}

// Account actions that touch several parts of the app: entering after sign-in, signing out, deleting the
// account, exporting. No UI in here (js/ui/account.js and js/ui/login.js call these).
import * as store from './store.js';
import * as local from './sync/local.js';
import { enterAccount, eraseAndEnter } from './sync/migrate.js';
import { startSync, stopSync, syncNow, getRemote } from './sync/sync.js';
import { signOut, currentUser } from './auth/auth.js';
import { notesToMarkdown } from './export-md.js';
import { maskEmail, log } from './log.js';

let entered = null;      // the user id sync is running for

/**
 * Called by the router once a signed-in user is about to see their notes.
 * → {decision:'resume'|'adopt'|'fresh'|'conflict', queued, hint}. On 'conflict' nothing has been started.
 */
export async function enter(user) {
  if (entered === user.id) return { decision: 'resume', queued: 0 };
  const r = await enterAccount(local, user.id);
  if (r.decision === 'conflict') {
    const state = await local.getState();
    return { ...r, hint: state.emailHint || '' };
  }
  await local.patchState({ emailHint: maskEmail(user.email) });
  entered = user.id;
  startSync(user);
  return r;
}

/** After a 'conflict': erase the other account's notes from this device and carry on as `user`. */
export async function eraseOtherAndEnter(user) {
  stopSync();
  await eraseAndEnter(local, user.id);
  await local.patchState({ emailHint: maskEmail(user.email) });
  entered = user.id;
  startSync(user);
}

export function left() { entered = null; stopSync(); }

/** How many changes have not reached the account yet. */
export const unsyncedCount = () => local.countDirty();

/**
 * Sign out of this device: send what is still waiting (when online), end the session, then remove the
 * notes cached on the device. They stay in the account.
 */
export async function signOutEverywhereHere({ trySync = true, force = false } = {}) {
  if (trySync && navigator.onLine !== false) { try { await syncNow(); } catch (err) { log.warn('account', 'last sync before sign-out failed', err); } }
  // Whatever is still queued (offline, server trouble, a page too large to upload) exists only on this
  // device and is deleted below. Never do that silently: the caller must confirm with force:true.
  if (!force) {
    const waiting = await local.countDirty().catch(() => 0);
    if (waiting > 0) { const e = new Error('unsynced'); e.code = 'unsynced'; e.count = waiting; throw e; }
  }
  left();
  await signOut();
  await local.wipeUserData();
}

async function wipeDevice() {
  // IndexedDB: the whole database (notes, thumbnails, queue, saved copy, settings).
  await store.closeDB();
  await new Promise(resolve => {
    let req;
    try { req = indexedDB.deleteDatabase('flash-notes'); } catch { resolve(); return; }
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  // Caches and the service worker (it installs itself again, clean, on the next load).
  try { if (self.caches) for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
  try {
    if (navigator.serviceWorker) for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
  } catch { /* ignore */ }
}

/**
 * Deletes the account and everything stored in it, then wipes this device. Needs a connection. Throws
 * (and changes nothing on the device) when the server did not confirm the deletion.
 */
export async function deleteAccount() {
  const remote = getRemote();
  if (!remote || !currentUser()) throw new Error('not-signed-in');
  await remote.deleteAccount();          // Edge Function: verifies the token, deletes with the service role
  left();
  await signOut();
  await wipeDevice();
}

/** Every notebook and whiteboard as one Markdown text (titles and text boxes only). */
export async function buildMarkdown() {
  const docs = await store.listDocs();
  const sections = [];
  for (const doc of docs) {
    const pages = [];
    for (const pid of doc.pageIds || []) { const p = await store.getPage(pid); if (p) pages.push(p); }
    sections.push({ doc, pages });
  }
  return notesToMarkdown(sections, { exportedAt: Date.now() });
}

// Test helper: several "devices", each with its own IndexedDB (fake-indexeddb), driving the REAL
// js/store.js and js/sync/local.js. Only one device is active at a time (the modules hold one connection).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import * as store from '../../js/store.js';
import * as local from '../../js/sync/local.js';
import { createSync } from '../../js/sync/core.js';

if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { onLine: true };

// A clock the tests control, so "which edit was later" is never a matter of luck.
let T = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => T;
export const tick = (ms = 1000) => { T += ms; return T; };
export const clock = () => T;
export const restoreClock = () => { Date.now = realNow; };

let current = null;
export function makeDevice(name) { return { name, idb: new IDBFactory(), tracking: false, known: new Set() }; }

/** Makes `dev` the active device: store.js and local.js now read and write its database. */
export async function use(dev) {
  if (current === dev) return dev;
  await store.closeDB();
  globalThis.indexedDB = dev.idb;
  current = dev;
  store.setSyncTracking(dev.tracking);
  await store.openDB();
  return dev;
}
export function track(dev, on = true) { dev.tracking = on; if (current === dev) store.setSyncTracking(on); }

/** One sync round for `dev` signed in as `uid` on `backend`. */
export async function sync(dev, backend, uid, opts = {}) {
  await use(dev);
  if (!dev.remotes) dev.remotes = new Map();
  if (!dev.remotes.has(uid)) dev.remotes.set(uid, backend.remoteFor(uid, dev.known));
  const engine = createSync({ local, remote: dev.remotes.get(uid) });
  const r = await engine.syncOnce({ full: !!opts.full });
  if (opts.verify) r.verified = await engine.verify();
  return r;
}

export { store, local };

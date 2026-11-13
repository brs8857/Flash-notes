// The device side of sync: reads the upload queue that js/store.js writes, and applies downloaded rows to
// IndexedDB. Everything that touches several stores happens in one transaction. IndexedDB stays the
// working copy; nothing in here talks to the network.
//
// Rows kept in the `meta` store:
//   sync:d:<kind>:<id>  "dirty": changed on this device and not uploaded yet  {kind, id, deleted, at, docKind?}
//   sync:v:<kind>:<id>  the version of the item this device last agreed with the account on  {u, d, r}
//   sync:state          {userId, cursors:{doc, page}, adoptedAt, verifiedAt, lastSyncedAt, backup:{at, docs, pages}}
//   backup:local        the notes that were on the device before the first sign-in (one JSON text)
import * as store from '../store.js';
import { newId } from '../canvas/constants.js';
import { rowToDoc, rowToPage, validId } from './map.js';

const { _run: run, _rq: rq, _mark: mark } = store;
const range = prefix => IDBKeyRange.bound(prefix, prefix + '￿');
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const dKey = (kind, id) => `sync:d:${kind}:${id}`;
const vKey = (kind, id) => `sync:v:${kind}:${id}`;

// ---------------------------------------------------------------- state

export async function getState() {
  const row = await run(['meta'], 'readonly', t => rq(t.objectStore('meta').get('sync:state')));
  return row || { key: 'sync:state', userId: null, cursors: { doc: 0, page: 0 } };
}

export function patchState(patch) {
  return run(['meta'], 'readwrite', async t => {
    const meta = t.objectStore('meta');
    const cur = (await rq(meta.get('sync:state'))) || { key: 'sync:state', userId: null, cursors: { doc: 0, page: 0 } };
    const next = { ...cur, ...patch, key: 'sync:state' };
    if (patch.cursors) next.cursors = { ...cur.cursors, ...patch.cursors };
    meta.put(next);
    return next;
  });
}

// ---------------------------------------------------------------- queue

/** Everything waiting to be uploaded. */
export function dirty() {
  return run(['meta'], 'readonly', t => rq(t.objectStore('meta').getAll(range('sync:d:'))));
}
export function countDirty() {
  return run(['meta'], 'readonly', t => rq(t.objectStore('meta').count(range('sync:d:'))));
}

/** Map "kind:id" → {u, d, r}. */
export async function versions() {
  const rows = await run(['meta'], 'readonly', t => rq(t.objectStore('meta').getAll(range('sync:v:'))));
  const out = new Map();
  for (const r of rows) out.set(`${r.kind}:${r.id}`, r);
  return out;
}

/** The account accepted our upload: remember its version; drop the queue row unless it changed meanwhile. */
export function setSynced(kind, id, at, v) {
  return run(['meta'], 'readwrite', async t => {
    const meta = t.objectStore('meta');
    meta.put({ key: vKey(kind, id), kind, id, u: v.u, d: !!v.d, r: v.r });
    const d = await rq(meta.get(dKey(kind, id)));
    if (d && d.at === at) meta.delete(dKey(kind, id));
  });
}

/** Gives up on a queue row that can never be uploaded (never synced and already deleted, or invalid). */
export function dropDirty(kind, id, at) {
  return run(['meta'], 'readwrite', async t => {
    const meta = t.objectStore('meta');
    const d = await rq(meta.get(dKey(kind, id)));
    if (d && d.at === at) meta.delete(dKey(kind, id));
  });
}

/** Marks a queue row as not uploadable for now (too large, invalid) so it is not retried in a loop. */
export function blockDirty(kind, id, at, reason) {
  return run(['meta'], 'readwrite', async t => {
    const meta = t.objectStore('meta');
    const d = await rq(meta.get(dKey(kind, id)));
    if (d && d.at === at) meta.put({ ...d, blocked: String(reason || 'invalid') });
  });
}

/** Images this device knows are already in the account's storage (so they are not uploaded twice). */
export async function imageKnown(name) {
  return !!(await run(['meta'], 'readonly', t => rq(t.objectStore('meta').get('sync:i:' + name))));
}
export function rememberImage(name) {
  return run(['meta'], 'readwrite', t => { t.objectStore('meta').put({ key: 'sync:i:' + name, at: Date.now() }); });
}

export function read(kind, id) {
  return kind === 'doc' ? store.getDoc(id) : store.getPage(id);
}

// ---------------------------------------------------------------- applying downloaded rows

function blankPage(docId, paper) {
  const t0 = Date.now();
  return { id: newId(), docId, createdAt: t0, updatedAt: t0, paper: { style: paper?.style || 'blank', color: paper?.color || 'white' }, items: [] };
}

const STORES = ['docs', 'pages', 'thumbs', 'meta'];

/**
 * Applies one downloaded row. `page` (for a live page row) is the already-built local page with its images
 * resolved. Returns 'applied' | 'kept-local' (a newer change on this device is waiting to upload) | 'invalid'.
 * Last write wins per item: the newer `updated_at` survives; on a tie the device's unsent change is kept
 * and uploaded.
 */
export function applyRow(kind, row, page) {
  if (!row || !validId(row.id)) return Promise.resolve('invalid');
  const version = { key: vKey(kind, row.id), kind, id: row.id, u: Number(row.updated_at) || 0, d: !!row.deleted, r: Number(row.rev) || 0 };
  return run(STORES, 'readwrite', async t => {
    const meta = t.objectStore('meta');
    const docs = t.objectStore('docs');
    const pages = t.objectStore('pages');
    const thumbs = t.objectStore('thumbs');
    const d = await rq(meta.get(dKey(kind, row.id)));
    if (d && d.at >= version.u) return 'kept-local';

    if (kind === 'page') {
      if (row.deleted) {
        const old = await rq(pages.get(row.id));
        pages.delete(row.id);
        thumbs.delete(row.id);
        meta.delete('view:' + row.id);
        if (old) {
          const doc = await rq(docs.get(old.docId));
          if (doc && (doc.pageIds || []).includes(row.id)) {
            doc.pageIds = doc.pageIds.filter(p => p !== row.id);
            if (!doc.pageIds.length) {            // a notebook never has zero pages
              const fresh = blankPage(doc.id, doc.paper || old.paper);
              pages.put(fresh);
              doc.pageIds = [fresh.id];
              mark(t, 'page', fresh.id);
              mark(t, 'doc', doc.id);
            }
            docs.put(doc);
          }
        }
      } else {
        const next = page || rowToPage(row);
        if (!next) return 'invalid';
        pages.put(next);
        thumbs.delete(row.id);                    // redrawn from the new content when next shown
        const doc = await rq(docs.get(next.docId));
        if (doc && (doc.updatedAt || 0) < next.updatedAt) { doc.updatedAt = next.updatedAt; docs.put(doc); }
      }
      meta.put(version);
      if (d) meta.delete(dKey(kind, row.id));
      return 'applied';
    }

    // ---- notebook / whiteboard
    if (row.deleted) {
      const keys = await rq(pages.index('docId').getAllKeys(row.id));
      for (const pid of keys) {
        pages.delete(pid);
        thumbs.delete(pid);
        meta.delete('view:' + pid);
        meta.delete(dKey('page', pid));           // deleting a notebook wins over unsent edits to its pages
      }
      docs.delete(row.id);
      meta.put(version);
      if (d) meta.delete(dKey(kind, row.id));
      return 'applied';
    }
    const next = rowToDoc(row);
    if (!next) return 'invalid';
    const old = await rq(docs.get(row.id));
    next.updatedAt = Math.max(next.updatedAt, (old && old.updatedAt) || 0);
    // Page list: start from the account's list, but never drop a page this device still has to upload,
    // and never list a page that is known to be deleted.
    let merged = false;
    const ids = [];
    for (const pid of next.pageIds) {
      const pd = await rq(meta.get(dKey('page', pid)));
      const pv = await rq(meta.get(vKey('page', pid)));
      if ((pd && pd.deleted) || (!pd && pv && pv.d)) { merged = true; continue; }
      if (!ids.includes(pid)) ids.push(pid);
    }
    const localKeys = await rq(pages.index('docId').getAllKeys(row.id));
    for (const pid of localKeys) {
      if (ids.includes(pid)) continue;
      const pd = await rq(meta.get(dKey('page', pid)));
      if (pd && !pd.deleted) { ids.push(pid); merged = true; }
    }
    if (next.kind === 'whiteboard' && ids.length > 1) { ids.length = 1; }
    if (!ids.length) {
      const fresh = blankPage(next.id, next.paper);
      pages.put(fresh);
      ids.push(fresh.id);
      mark(t, 'page', fresh.id);
      merged = true;
    }
    next.pageIds = ids;
    docs.put(next);
    meta.put(version);
    if (d) meta.delete(dKey(kind, row.id));
    if (merged) mark(t, 'doc', next.id);          // the merged page list goes back to the account
    return 'applied';
  });
}

// ---------------------------------------------------------------- first sign-in, sign-out, backup

export async function countDocs() {
  return run(['docs'], 'readonly', t => rq(t.objectStore('docs').count()));
}

/**
 * Queues every notebook, whiteboard and page for upload. Never overwrites an existing queue row, so it is
 * safe to run twice. `at` = the item's own last-changed time, so last-write-wins still holds if the
 * account already has a copy.
 */
export function markAllDirty() {
  return run(['docs', 'meta'], 'readwrite', async t => {
    const meta = t.objectStore('meta');
    const all = await rq(t.objectStore('docs').getAll());
    let n = 0;
    const put = async (kind, id, at) => {
      if (await rq(meta.get(dKey(kind, id)))) return;
      meta.put({ key: dKey(kind, id), kind, id, deleted: false, at });
      n++;
    };
    for (const doc of all) {
      const at = doc.updatedAt || Date.now();
      await put('doc', doc.id, at);
      for (const pid of doc.pageIds || []) await put('page', pid, at);
    }
    return n;
  });
}

/** Saves a copy of everything on the device (the same format as Settings → Download backup). */
export async function saveLocalBackup() {
  const docs = await store.listDocs();
  const blob = await store.exportAll();
  // The copy is a convenience, never a reason to stop someone using their notes: a very large library
  // (reading it back as one string could exhaust memory) or a full disk simply goes without one.
  if (blob.size > MAX_BACKUP_BYTES) return null;
  const text = await blob.text();
  const info = { at: Date.now(), docs: docs.length, pages: docs.reduce((n, d) => n + (d.pageIds || []).length, 0) };
  try {
    await run(['meta'], 'readwrite', t => { t.objectStore('meta').put({ key: 'backup:local', ...info, text }); });
  } catch { return null; }              // e.g. QuotaExceededError: nothing was written
  await patchState({ backup: info });
  return info;
}

export async function getLocalBackup() {
  return run(['meta'], 'readonly', t => rq(t.objectStore('meta').get('backup:local')));
}

/** Puts the saved copy back next to what is here now (merge: nothing is overwritten or lost). */
export async function restoreLocalBackup() {
  const row = await getLocalBackup();
  if (!row || typeof row.text !== 'string') throw new Error('There is no saved copy on this device.');
  return store.importAll(new Blob([row.text], { type: 'application/json' }), { mode: 'merge' });
}

export async function dropLocalBackup() {
  await run(['meta'], 'readwrite', t => { t.objectStore('meta').delete('backup:local'); });
  await patchState({ backup: null });
}

/** Sign-out: removes every note, thumbnail, queue row and saved copy from this device. Settings stay. */
export function wipeUserData() {
  return run(STORES, 'readwrite', async t => {
    t.objectStore('docs').clear();
    t.objectStore('pages').clear();
    t.objectStore('thumbs').clear();
    const meta = t.objectStore('meta');
    for (const k of await rq(meta.getAllKeys())) if (k !== 'settings') meta.delete(k);
  });
}

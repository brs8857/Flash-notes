// In-app snapshots and the auto-backup bookkeeping, kept in the existing `meta` store of the `flash-notes`
// database (no new object store, so no database upgrade: a v2.0 database opens unchanged). Rows:
//   autobk:i:<id>   {id, createdAt, size, counts, fingerprint, librarySha, reason, format}   (small: the list)
//   autobk:d:<id>   {blob: Blob} (or {bytes: ArrayBuffer} where a browser cannot store Blobs) (the .flashnotes file)
//   autobk:state    {lastRunAt, lastSnapshotAt, lastResult, error, lastFileAt, lastFileFingerprint, snoozeUntil,
//                    lastFolderAt, lastFolderFingerprint, folderError}
//   autobk:dir      {handle: FileSystemDirectoryHandle, name}   (Chrome/Edge only; structured-cloneable there)
// Because they live in `meta`, signing out (local.wipeUserData keeps only `settings`) and deleting the
// account (the whole database is deleted) remove snapshots, state and the folder handle as well.
import * as store from '../store.js';
import { newId } from '../canvas/constants.js';

const { _run: run, _rq: rq } = store;
const range = prefix => IDBKeyRange.bound(prefix, prefix + '￿');
const iKey = id => 'autobk:i:' + id;
const dKey = id => 'autobk:d:' + id;

/** Newest first. Only the small info rows are read. */
export async function listSnapshots() {
  const rows = await run(['meta'], 'readonly', t => rq(t.objectStore('meta').getAll(range('autobk:i:'))));
  return rows.map(({ key, ...r }) => r).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

export async function latestSnapshot() { return (await listSnapshots())[0] || null; }

/**
 * Saves one snapshot (`data`: the .flashnotes Blob) and, in the same transaction, deletes the oldest beyond
 * `keep`. Returns {info, pruned:[ids]}. A full disk rejects with the browser's QuotaExceededError and
 * writes nothing. The Blob is stored as a Blob (no copy through script); a browser that cannot store Blobs
 * in IndexedDB gets the bytes instead.
 */
export async function putSnapshot(info, data, keep) {
  try { return await writeSnapshot(info, { blob: data }, keep); } catch (err) {
    if (!err || (err.name !== 'DataCloneError' && err.name !== 'UnknownError' && err.name !== 'NotSupportedError')) throw err;
    return writeSnapshot(info, { bytes: await data.arrayBuffer() }, keep);
  }
}

function writeSnapshot(info, body, keep) {
  const id = info.id || newId();
  const row = { ...info, id, key: iKey(id) };
  return run(['meta'], 'readwrite', async t => {
    const meta = t.objectStore('meta');
    meta.put({ key: dKey(id), ...body });
    meta.put(row);
    const all = (await rq(meta.getAll(range('autobk:i:')))).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    const pruned = [];
    // The snapshot just written is never a candidate, even if the clock was set back and it looks "oldest".
    const others = all.filter(x => x.id !== id);
    for (const old of others.slice(Math.max(0, (keep || 1) - 1))) { meta.delete(iKey(old.id)); meta.delete(dKey(old.id)); pruned.push(old.id); }
    const { key, ...out } = row;
    return { info: out, pruned };
  });
}

/** Changes a snapshot's small info row only (e.g. a new fingerprint for unchanged contents). */
export function updateInfo(id, patch) {
  return run(['meta'], 'readwrite', async t => {
    const m = t.objectStore('meta');
    const row = await rq(m.get(iKey(id)));
    if (!row) return null;
    const next = { ...row, ...patch, id, key: iKey(id) };
    m.put(next);
    const { key, ...out } = next;
    return out;
  });
}

/** Deletes the oldest snapshots beyond `keep` (after the user lowers the number to keep). */
export function pruneSnapshots(keep) {
  return run(['meta'], 'readwrite', async t => {
    const meta = t.objectStore('meta');
    const all = (await rq(meta.getAll(range('autobk:i:')))).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    const pruned = [];
    for (const old of all.slice(Math.max(1, keep || 1))) { meta.delete(iKey(old.id)); meta.delete(dKey(old.id)); pruned.push(old.id); }
    return pruned;
  });
}

/** The snapshot's .flashnotes file as a Blob, or null. */
export async function getSnapshotBlob(id) {
  const row = await run(['meta'], 'readonly', t => rq(t.objectStore('meta').get(dKey(id))));
  if (!row) return null;
  if (row.blob instanceof Blob) return row.blob;
  return row.bytes ? new Blob([row.bytes]) : null;
}

export function deleteSnapshot(id) {
  return run(['meta'], 'readwrite', t => { const m = t.objectStore('meta'); m.delete(iKey(id)); m.delete(dKey(id)); });
}

/** Removes every snapshot, the state and the folder handle (used by tests and by an explicit wipe). */
export function clearAll() {
  return run(['meta'], 'readwrite', async t => {
    const m = t.objectStore('meta');
    for (const k of await rq(m.getAllKeys(range('autobk:')))) m.delete(k);
  });
}

// ---------------------------------------------------------------- state

export async function getState() {
  const row = await run(['meta'], 'readonly', t => rq(t.objectStore('meta').get('autobk:state')));
  if (!row) return {};
  const { key, ...s } = row;
  return s;
}

export function patchState(patch) {
  return run(['meta'], 'readwrite', async t => {
    const m = t.objectStore('meta');
    const cur = (await rq(m.get('autobk:state'))) || {};
    const next = { ...cur, ...patch, key: 'autobk:state' };
    m.put(next);
    const { key, ...s } = next;
    return s;
  });
}

// ---------------------------------------------------------------- folder handle (File System Access API)

export async function getFolder() {
  try { return (await run(['meta'], 'readonly', t => rq(t.objectStore('meta').get('autobk:dir')))) || null; } catch { return null; }
}
export function putFolder(handle) {
  return run(['meta'], 'readwrite', t => { t.objectStore('meta').put({ key: 'autobk:dir', handle, name: String(handle && handle.name || '') }); });
}
export function clearFolder() {
  return run(['meta'], 'readwrite', t => { t.objectStore('meta').delete('autobk:dir'); });
}

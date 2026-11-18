// Automatic backup: decides WHEN to make a backup and WHERE to put it. No UI in here (js/ui/backup.js shows
// the Settings section and the "Backup ready" banner); Node tests drive it directly.
//
// Honest limits: a web app cannot run in the background or write files on its own on iPad Safari. So a
// backup is only made while Flash Notes is open: a few seconds after launch, when it comes back to the
// screen, and on a one-minute timer while it stays open, whenever one is due. It is built in small slices
// that wait for the pen (never while a finger or Pencil is down, or within 1.2 s of one), so drawing never
// stutters. Every backup is kept as an in-app snapshot; the destination adds a copy outside the browser:
//   'app'    snapshots only
//   'folder' also written to a folder the user picked (File System Access API: Chrome/Edge on a computer)
//   'file'   also offered as a file to save (share sheet / download), one tap, never without a tap
import * as snaps from './snapshots.js';
import { buildBackup, libraryFingerprint, readBackup, importBackup, portableSettings, FORMAT } from './format.js';
import { isDue, shouldOfferFile, backupSettings, backupFileName, namesToPrune, INTERVALS, SNOOZE_MS } from './schedule.js';

const QUIET_AFTER_TOUCH_MS = 1200;
const STALE_DOWN_MS = 15000;
const SLICE_MS = 8;                  // work at most this long before giving the page back
const TIMER_MS = 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;     // after a failure, try again within the hour
export const FILE_TYPE = 'application/octet-stream';

let cfg = { getSettings: () => ({}), canRun: () => true, appVersion: '', applySettings: null };
let running = null;
let pending = null;                  // {kind:'file', file, fingerprint} | {kind:'folder-permission', name}
let started = false;
let timer = null;
let pointerDown = false;
let lastPointer = -1e9;
let sliceStart = 0;
let folderCache;                     // {handle, name} | null once read (undefined = not read yet)
let epoch = 0;                       // bumped by forget(): a run that started before must not write
const listeners = new Set();

/** fn({type:'status'|'banner'}) after anything changed. Returns an unsubscribe function. */
export function onBackupEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type) { listeners.forEach(fn => { try { fn({ type }); } catch { /* a listener's problem */ } }); }

export function configure(opts) { cfg = { ...cfg, ...opts }; }
export const isRunning = () => !!running;
export const pendingOffer = () => pending;

// ---------------------------------------------------------------- never in the way of the pen

const wait = ms => new Promise(r => setTimeout(r, ms));
const yieldMain = () => (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function' ? globalThis.scheduler.yield() : wait(0));
// performance.now() (monotonic): a device clock moved back must not make us wait for the clock to catch up.
// A pointer "down" with no event at all for STALE_DOWN_MS has lost its pointerup (iPad Safari can drop it).
async function quiet() {
  for (;;) {
    const idle = performance.now() - lastPointer;
    if ((pointerDown && idle < STALE_DOWN_MS) || idle < QUIET_AFTER_TOUCH_MS) { await wait(300); continue; }
    pointerDown = false;
    return;
  }
}
/** Awaited between slices of backup work. */
export async function pause() {
  if (performance.now() - sliceStart < SLICE_MS) return;
  await yieldMain();
  await quiet();
  sliceStart = performance.now();
}
const onDown = () => { pointerDown = true; lastPointer = performance.now(); };
const onUp = () => { pointerDown = false; lastPointer = performance.now(); };
const onMove = () => { if (pointerDown) lastPointer = performance.now(); };
const onVisible = () => { if (document.visibilityState === 'visible') setTimeout(() => { check().catch(() => {}); }, 1500); };

/** Starts the "while the app is open" schedule. opts: {getSettings, canRun, appVersion, applySettings}. */
export function startAutoBackup(opts = {}) {
  configure(opts);
  if (started) return;
  started = true;
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.addEventListener('pointerup', onUp, { capture: true, passive: true });
  document.addEventListener('pointercancel', onUp, { capture: true, passive: true });
  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => { if (document.visibilityState !== 'hidden') check().catch(() => {}); }, TIMER_MS);
  setTimeout(() => { check().catch(() => {}); }, 4000);   // after launch, once the first screen is up
}

export function stopAutoBackup() {
  if (!started) return;
  started = false;
  clearInterval(timer);
  document.removeEventListener('pointerdown', onDown, { capture: true });
  document.removeEventListener('pointerup', onUp, { capture: true });
  document.removeEventListener('pointercancel', onUp, { capture: true });
  document.removeEventListener('pointermove', onMove, { capture: true });
  document.removeEventListener('visibilitychange', onVisible);
}

/** Forgets what is held in memory (a file waiting to be saved). Called on sign-out and account deletion. */
export function forget() { epoch++; pending = null; folderCache = undefined; emit('banner'); emit('status'); }

// ---------------------------------------------------------------- the run

/** Makes a backup now if one is due; otherwise re-offers a file / folder write that is still owed. */
export async function check() {
  if (!cfg.canRun()) return { result: 'off' };
  if (running) return running;
  const s = backupSettings(cfg.getSettings());
  const st = await snaps.getState();
  const now = Date.now();
  const due = isDue({ enabled: s.autoBackup, interval: s.backupInterval, lastRunAt: st.lastRunAt, now })
    || (s.autoBackup && st.retryAt && (now >= st.retryAt || st.retryAt - now > RETRY_MS + 5 * 60000));
  if (due) return runBackup({ reason: 'auto' });
  if (s.autoBackup) {
    const latest = await snaps.latestSnapshot();
    if (latest) await destinations(s, st, latest, {});
  }
  return { result: 'not-due' };
}

/** reason: 'auto' | 'manual' (Back up now) | 'safety' (before a replace). Never two at once. */
export function runBackup({ reason = 'manual' } = {}) {
  if (running) return running;
  running = (async () => {
    try { return await withLock(() => doRun(reason)); } finally { running = null; emit('status'); }
  })();
  emit('status');
  return running;
}

async function withLock(fn) {
  // Two open tabs must not both make the backup: the Web Locks API where there is one.
  const locks = typeof navigator !== 'undefined' && navigator.locks;
  if (locks && typeof locks.request === 'function') {
    return locks.request('flash-notes-backup', { ifAvailable: true }, lock => (lock ? fn() : { result: 'busy' }));
  }
  return fn();
}

const isQuota = err => !!err && (err.name === 'QuotaExceededError' || err.code === 22 || /quota|space/i.test(String(err.message || '')));

async function doRun(reason) {
  const myEpoch = epoch;
  const stillWanted = () => myEpoch === epoch && cfg.canRun();
  const settings = cfg.getSettings();
  const s = backupSettings(settings);
  sliceStart = performance.now();
  try {
    await quiet();
    const fp = await libraryFingerprint(settings);
    let latest = await snaps.latestSnapshot();
    let info = latest, created = false, file = null;
    if (!latest || latest.fingerprint !== fp) {
      const built = await buildBackup({ pause, settings, appVersion: cfg.appVersion, fingerprint: fp, now: Date.now() });
      if (!stillWanted()) return { result: 'off' };    // signed out (and wiped) while it was being built
      if (latest && latest.librarySha === built.librarySha) {
        // Records were touched but nothing in them changed: remember the new fingerprint, keep the snapshot.
        info = (await snaps.updateInfo(latest.id, { fingerprint: fp })) || latest;
      } else {
        const createdAt = built.manifest.createdAt;
        ({ info } = await snaps.putSnapshot({ createdAt, size: built.blob.size, counts: built.counts, fingerprint: fp, librarySha: built.librarySha, reason, format: FORMAT }, built.blob, s.backupKeep));
        if (!stillWanted()) { await snaps.clearAll().catch(() => {}); return { result: 'off' }; }   // wiped while it was being saved
        created = true;
        file = new File([built.blob], backupFileName(createdAt), { type: FILE_TYPE });
      }
    }
    const st = await snaps.patchState({ lastRunAt: Date.now(), lastResult: created ? 'created' : 'unchanged', error: null, retryAt: null, ...(created ? { lastSnapshotAt: info.createdAt } : {}) });
    if (reason !== 'safety') await destinations(s, st, info, { manual: reason === 'manual', file });
    return { result: created ? 'created' : 'unchanged', info };
  } catch (err) {
    if (!stillWanted()) return { result: 'off' };
    const code = isQuota(err) ? 'storage-full' : 'failed';
    const now = Date.now();
    const ms = INTERVALS[s.backupInterval] || RETRY_MS;
    await snaps.patchState({ lastRunAt: now, lastResult: 'failed', error: { code, at: now }, retryAt: now + Math.min(ms, RETRY_MS) }).catch(() => {});
    return { result: 'failed', code };
  }
}

// ---------------------------------------------------------------- destinations

async function destinations(s, st, info, { manual = false, file = null }) {
  if (s.backupDest === 'folder') await writeToFolder(info, s, st, { manual, file });
  else if (s.backupDest === 'file') await offerFile(info, s, st, { manual, file });
}

async function snapshotFile(info, file) {
  if (file) return file;
  const blob = await snaps.getSnapshotBlob(info.id);
  return blob ? new File([blob], backupFileName(info.createdAt), { type: FILE_TYPE }) : null;
}

async function offerFile(info, s, st, { manual, file }) {
  if (pending && pending.kind === 'file' && pending.fingerprint === info.fingerprint) return;
  const ok = shouldOfferFile({
    dest: 'file', latestFingerprint: info.fingerprint, lastFileFingerprint: st.lastFileFingerprint, lastFileAt: st.lastFileAt,
    snoozeUntil: st.snoozeUntil, interval: s.backupInterval, now: Date.now(), manual,
  });
  if (!ok) return;
  const f = await snapshotFile(info, file);
  if (!f) return;
  pending = { kind: 'file', file: f, fingerprint: info.fingerprint, createdAt: info.createdAt };
  emit('banner');
}

/** The user saved (shared or downloaded) the offered file. */
export async function fileSaved() {
  if (!pending || pending.kind !== 'file') return;
  const p = pending;
  pending = null;
  await snaps.patchState({ lastFileAt: Date.now(), lastFileFingerprint: p.fingerprint, snoozeUntil: null });
  emit('banner'); emit('status');
}

/** "Later": hides the banner for a day. */
export async function snooze() {
  pending = null;
  await snaps.patchState({ snoozeUntil: Date.now() + SNOOZE_MS });
  emit('banner'); emit('status');
}

export function folderSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** The stored folder handle, read from IndexedDB once per session. */
async function getFolder() {
  if (folderCache === undefined) folderCache = await snaps.getFolder();
  return folderCache;
}

async function writeToFolder(info, s, st, { manual, file }) {
  const folder = await getFolder();
  if (!folder || !folder.handle) { if (st.folderError !== 'no-folder') { await snaps.patchState({ folderError: 'no-folder' }); emit('status'); } return; }
  if (!manual && st.lastFolderFingerprint === info.fingerprint && !st.folderError) return;
  // A failed write is retried within the hour, not every minute (a full disk would otherwise be rewritten forever).
  if (!manual && st.folderError && st.folderError !== 'permission' && st.folderErrorAt && Date.now() - st.folderErrorAt < RETRY_MS && st.folderErrorAt <= Date.now()) return;
  const h = folder.handle;
  try {
    const perm = typeof h.queryPermission === 'function' ? await h.queryPermission({ mode: 'readwrite' }) : 'granted';
    if (perm !== 'granted') {
      const was = pending && pending.kind === 'folder-permission';
      pending = { kind: 'folder-permission', name: folder.name, handle: h };
      if (st.folderError !== 'permission') await snaps.patchState({ folderError: 'permission' });
      if (!was) { emit('banner'); emit('status'); }
      return;
    }
    const f = await snapshotFile(info, file);
    if (!f) return;
    const fh = await h.getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    try { await w.write(f); await w.close(); } catch (err) { try { await w.abort(); } catch { /* ignore */ } throw err; }
    const names = [];
    for await (const [name, entry] of h.entries()) if (entry.kind === 'file') names.push(name);
    for (const name of namesToPrune(names, s.backupKeep, f.name)) { try { await h.removeEntry(name); } catch { /* in use: next time */ } }
    if (pending && pending.kind === 'folder-permission') pending = null;
    await snaps.patchState({ lastFolderAt: Date.now(), lastFolderFingerprint: info.fingerprint, folderError: null, folderErrorAt: null });
  } catch (err) {
    const code = err && err.name === 'NotAllowedError' ? 'permission' : err && err.name === 'NotFoundError' ? 'missing' : isQuota(err) ? 'disk-full' : 'failed';
    await snaps.patchState({ folderError: code, folderErrorAt: Date.now() }).catch(() => {});
  }
  emit('banner'); emit('status');
}

/** From a tap: asks for the folder once (Chrome/Edge). Returns the folder name, or null if cancelled. */
export async function chooseFolder() {
  let handle;
  try { handle = await window.showDirectoryPicker({ id: 'flash-notes-backups', mode: 'readwrite' }); }
  catch (err) { if (err && err.name === 'AbortError') return null; throw err; }
  await snaps.putFolder(handle);
  folderCache = { handle, name: handle.name };
  await snaps.patchState({ folderError: null, lastFolderFingerprint: null });
  return handle.name;
}

/** From a tap on the banner: asks again for permission to write to the folder, then writes. */
export async function allowFolder() {
  // requestPermission needs the tap's user activation: use the handle already in memory, no await first.
  const handle = pending && pending.kind === 'folder-permission' && pending.handle ? pending.handle : (await getFolder() || {}).handle;
  if (!handle) return false;
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return false;
  pending = null;
  await snaps.patchState({ folderError: null });
  const latest = await snaps.latestSnapshot();
  if (latest) await writeToFolder(latest, backupSettings(cfg.getSettings()), await snaps.getState(), { manual: true });
  else await runBackup({ reason: 'manual' });
  return true;
}

export async function forgetFolder() {
  await snaps.clearFolder();
  folderCache = null;
  await snaps.patchState({ folderError: null, lastFolderFingerprint: null, lastFolderAt: null });
  if (pending && pending.kind === 'folder-permission') pending = null;
  emit('banner'); emit('status');
}

// ---------------------------------------------------------------- status & restore

export async function getStatus() {
  const [state, list, folder] = await Promise.all([snaps.getState(), snaps.listSnapshots(), getFolder()]);
  return { settings: backupSettings(cfg.getSettings()), state, snapshots: list, folderName: folder ? folder.name : null, running: !!running, pending };
}

/** The .flashnotes file of a snapshot (for Download / Share). */
export async function snapshotAsFile(id) {
  const info = (await snaps.listSnapshots()).find(s => s.id === id);
  if (!info) return null;
  return snapshotFile(info, null);
}

export async function deleteSnapshot(id) { await snaps.deleteSnapshot(id); emit('status'); }
export async function applyKeep(keep) { await snaps.pruneSnapshots(keep); emit('status'); }

/**
 * Restores from a File/Blob (.flashnotes or legacy .json) or {snapshotId}. The file is read and checked in
 * full BEFORE anything changes. mode 'merge' adds alongside; 'replace' first saves a safety snapshot of
 * what is here now (and gives up, changing nothing, if that fails). Returns importData's {docs, pages, skipped}.
 */
/** Settings from a file: only small plain values (they come from a file anyone could have edited). */
function safeSettings(raw) {
  const out = {};
  for (const [k, v] of Object.entries(portableSettings(raw))) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'object') {
      let json;
      try { json = JSON.stringify(v); } catch { continue; }
      if (json && json.length <= 64 * 1024) out[k] = JSON.parse(json);
    }
  }
  return out;
}

export async function restore(source, { mode = 'merge' } = {}) {
  let blob = source;
  if (source && source.snapshotId) {
    blob = await snaps.getSnapshotBlob(source.snapshotId);
    if (!blob) throw new Error('That snapshot is no longer on this device.');
  }
  const { data } = await readBackup(blob, { pause });
  let safetyId = null;
  if (mode === 'replace') {
    if (running) await running.catch(() => {});
    const safety = await runBackup({ reason: 'safety' });
    if (!safety || (safety.result !== 'created' && safety.result !== 'unchanged')) {
      throw new Error(safety && safety.code === 'storage-full'
        ? 'There isn’t enough space to save a safety copy first, so nothing was replaced.'
        : 'Couldn’t save a safety copy first, so nothing was replaced.');
    }
    safetyId = safety.info && safety.info.id;
  }
  let result;
  try { result = await importBackup(data, { mode }); } catch (err) {
    // "Replace" empties the library before it fills it again. If that fails half way, put the safety copy back.
    if (mode === 'replace' && safetyId) {
      try {
        const back = await readBackup(await snaps.getSnapshotBlob(safetyId), { pause });
        await importBackup(back.data, { mode: 'replace' });
      } catch { throw new Error('The restore stopped half way and your previous notes could not be put back automatically. They are safe in the newest snapshot (Settings → Backup): restore it from there.'); }
      throw new Error('The restore failed, so your previous notes were put back as they were.');
    }
    throw err;
  }
  if (mode === 'replace' && data.settings && typeof data.settings === 'object' && cfg.applySettings) {
    try { await cfg.applySettings(safeSettings(data.settings)); } catch { /* notes are back; settings are a bonus */ }
  }
  emit('status');
  return result;
}

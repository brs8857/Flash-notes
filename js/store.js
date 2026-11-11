// Flash Notes storage: everything lives in IndexedDB on this device (SPEC §3, §5).
import { newId } from './canvas/constants.js';

const DB_NAME = 'flash-notes';
const DB_VERSION = 1;
const DEFAULT_SETTINGS = { theme: 'system', twoFingerUndo: true };

let dbPromise = null;
let settingsCache = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) {
        const s = db.createObjectStore('docs', { keyPath: 'id' });
        s.createIndex('kind', 'kind');
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('pages')) {
        db.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('thumbs')) {
        db.createObjectStore('thumbs', { keyPath: 'id' }).createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { /* another tab is upgrading; the open continues once it finishes */ };
  });
  return dbPromise;
}

const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Run fn inside one transaction; resolves with fn's result on tx.oncomplete (not request success). */
async function run(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(stores, mode); } catch (err) { reject(err); return; }
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('Storage error'));
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    Promise.resolve()
      .then(() => fn(t))
      .then(v => { out = v; })
      .catch(err => { try { t.abort(); } catch { /* already finished */ } reject(err); });
  });
}

const now = () => Date.now();
const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function blankPage(docId, paper) {
  const t = now();
  return {
    id: newId(), docId, createdAt: t, updatedAt: t,
    paper: { style: paper?.style || 'blank', color: paper?.color || 'white' },
    items: [],
  };
}

async function deleteByIndex(store, indexName, key) {
  const keys = await rq(store.index(indexName).getAllKeys(key));
  for (const k of keys) store.delete(k);
  return keys;
}

// ---------------------------------------------------------------- docs

export async function listDocs(kind) {
  const docs = await run(['docs'], 'readonly', t => {
    const s = t.objectStore('docs');
    return rq(kind ? s.index('kind').getAll(kind) : s.getAll());
  });
  return docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getDoc(id) {
  return run(['docs'], 'readonly', t => rq(t.objectStore('docs').get(id)));
}

export function putDoc(doc) {
  return run(['docs'], 'readwrite', t => { t.objectStore('docs').put(doc); return doc; });
}

export function deleteDoc(id) {
  return run(['docs', 'pages', 'thumbs', 'meta'], 'readwrite', async t => {
    const pageKeys = await deleteByIndex(t.objectStore('pages'), 'docId', id);
    await deleteByIndex(t.objectStore('thumbs'), 'docId', id);
    const meta = t.objectStore('meta');
    for (const pid of pageKeys) meta.delete('view:' + pid);
    t.objectStore('docs').delete(id);
  });
}

// ---------------------------------------------------------------- pages

export function getPage(id) {
  return run(['pages'], 'readonly', t => rq(t.objectStore('pages').get(id)));
}

/**
 * Saves the page and bumps the parent doc's updatedAt in the same transaction. A page that is no longer
 * part of its doc (deleted while a debounced save was pending) is never written back to life.
 */
export function putPage(page) {
  return run(['pages', 'docs'], 'readwrite', async t => {
    const docs = t.objectStore('docs');
    const doc = await rq(docs.get(page.docId));
    if (!doc || !(doc.pageIds || []).includes(page.id)) return page;
    t.objectStore('pages').put(page);
    doc.updatedAt = now();
    docs.put(doc);
    return page;
  });
}

/** Atomic read-modify-write of a doc's own fields (never pageIds), so concurrent page edits are not lost. */
export function patchDoc(id, patch) {
  return run(['docs'], 'readwrite', async t => {
    const docs = t.objectStore('docs');
    const doc = await rq(docs.get(id));
    if (!doc) return null;
    const { pageIds, id: _id, kind, ...safe } = patch || {};
    Object.assign(doc, safe, { updatedAt: now() });
    docs.put(doc);
    return doc;
  });
}

/** Deletes a page (+ thumb + view row). A notebook never ends up with zero pages. Returns the updated doc. */
export function deletePage(id) {
  return run(['docs', 'pages', 'thumbs', 'meta'], 'readwrite', async t => {
    const pages = t.objectStore('pages');
    const page = await rq(pages.get(id));
    pages.delete(id);
    t.objectStore('thumbs').delete(id);
    t.objectStore('meta').delete('view:' + id);
    if (!page) return null;
    const docs = t.objectStore('docs');
    const doc = await rq(docs.get(page.docId));
    if (!doc) return null;
    doc.pageIds = (doc.pageIds || []).filter(p => p !== id);
    if (!doc.pageIds.length) {
      const fresh = blankPage(doc.id, doc.kind === 'notebook' ? doc.paper : page.paper);
      pages.put(fresh);
      doc.pageIds = [fresh.id];
    }
    doc.updatedAt = now();
    docs.put(doc);
    return doc;
  });
}

/** Pages of a doc in doc.pageIds order. For exports prefer getPage() one at a time. */
export function getPages(docId) {
  return run(['docs', 'pages'], 'readonly', async t => {
    const doc = await rq(t.objectStore('docs').get(docId));
    if (!doc) return [];
    const s = t.objectStore('pages');
    const out = [];
    for (const pid of doc.pageIds || []) {
      const p = await rq(s.get(pid));
      if (p) out.push(p);
    }
    return out;
  });
}

// ---------------------------------------------------------------- thumbnails & view state

export async function getThumb(pageId) {
  const row = await run(['thumbs'], 'readonly', t => rq(t.objectStore('thumbs').get(pageId)));
  return row ? row.data : null;
}

export async function getThumbs(docId) {
  const rows = await run(['thumbs'], 'readonly', t => rq(t.objectStore('thumbs').index('docId').getAll(docId)));
  const out = {};
  for (const r of rows) out[r.id] = r.data;
  return out;
}

export function putThumb(pageId, docId, dataUrl) {
  return run(['thumbs', 'pages'], 'readwrite', async t => {
    // Never keep a thumbnail for a page that was deleted while it rendered.
    const exists = await rq(t.objectStore('pages').count(pageId));
    if (exists) t.objectStore('thumbs').put({ id: pageId, docId, data: dataUrl });
  });
}

export async function getViewState(pageId) {
  const row = await run(['meta'], 'readonly', t => rq(t.objectStore('meta').get('view:' + pageId)));
  return row ? { x: row.x, y: row.y, zoom: row.zoom } : null;
}

export function putViewState(pageId, v) {
  return run(['meta'], 'readwrite', t => {
    t.objectStore('meta').put({ key: 'view:' + pageId, x: v.x, y: v.y, zoom: v.zoom });
  });
}

// ---------------------------------------------------------------- creating things

export function createNotebook(partial = {}) {
  const t0 = now();
  const doc = {
    id: newId(), kind: 'notebook',
    title: (partial.title || '').trim() || 'Untitled notebook',
    createdAt: t0, updatedAt: t0,
    cover: { color: '#3B5BDB', pattern: 'plain', emoji: null, image: null, ...(partial.cover || {}) },
    paper: { style: 'lined', color: 'white', ...(partial.paper || {}) },
    pageIds: [],
  };
  const page = blankPage(doc.id, doc.paper);
  doc.pageIds.push(page.id);
  return run(['docs', 'pages'], 'readwrite', t => {
    t.objectStore('docs').put(doc);
    t.objectStore('pages').put(page);
    return doc;
  });
}

export function createWhiteboard(partial = {}) {
  const t0 = now();
  const doc = {
    id: newId(), kind: 'whiteboard',
    title: (partial.title || '').trim() || 'Untitled whiteboard',
    createdAt: t0, updatedAt: t0,
    background: partial.background || 'dots',
    pageIds: [],
  };
  const page = blankPage(doc.id, { style: 'blank', color: partial.color || 'white' });
  doc.pageIds.push(page.id);
  return run(['docs', 'pages'], 'readwrite', t => {
    t.objectStore('docs').put(doc);
    t.objectStore('pages').put(page);
    return doc;
  });
}

export function addPage(docId, afterPageId, paper) {
  return run(['docs', 'pages'], 'readwrite', async t => {
    const docs = t.objectStore('docs');
    const doc = await rq(docs.get(docId));
    if (!doc) throw new Error('Notebook not found');
    const page = blankPage(docId, paper || doc.paper);
    const i = afterPageId ? doc.pageIds.indexOf(afterPageId) : -1;
    if (i >= 0) doc.pageIds.splice(i + 1, 0, page.id); else doc.pageIds.push(page.id);
    doc.updatedAt = now();
    t.objectStore('pages').put(page);
    docs.put(doc);
    return page;
  });
}

function copyPage(src, docId) {
  const t0 = now();
  const page = clone(src);
  page.id = newId();
  page.docId = docId;
  page.createdAt = t0;
  page.updatedAt = t0;
  page.items = (page.items || []).map(it => ({ ...it, id: newId() }));
  return page;
}

/** Copies a page and inserts the copy right after the original. Returns the new page. */
export function duplicatePage(pageId) {
  return run(['docs', 'pages', 'thumbs'], 'readwrite', async t => {
    const pages = t.objectStore('pages');
    const src = await rq(pages.get(pageId));
    if (!src) throw new Error('Page not found');
    const docs = t.objectStore('docs');
    const doc = await rq(docs.get(src.docId));
    if (!doc) throw new Error('Notebook not found');
    const page = copyPage(src, doc.id);
    const i = doc.pageIds.indexOf(pageId);
    doc.pageIds.splice(i >= 0 ? i + 1 : doc.pageIds.length, 0, page.id);
    doc.updatedAt = now();
    pages.put(page);
    docs.put(doc);
    const thumbs = t.objectStore('thumbs');
    const th = await rq(thumbs.get(pageId));
    if (th) thumbs.put({ id: page.id, docId: doc.id, data: th.data });
    return page;
  });
}

/** Copies a whole notebook/whiteboard (pages copied one at a time). Returns the new doc. */
export async function duplicateDoc(docId) {
  const src = await getDoc(docId);
  if (!src) throw new Error('Not found');
  const t0 = now();
  const doc = clone(src);
  doc.id = newId();
  doc.title = `${src.title} copy`;
  doc.createdAt = t0;
  doc.updatedAt = t0;
  doc.pageIds = [];
  await putDoc(doc);
  for (const pid of src.pageIds || []) {
    await run(['docs', 'pages', 'thumbs'], 'readwrite', async t => {
      const pages = t.objectStore('pages');
      const p = await rq(pages.get(pid));
      if (!p) return;
      const copy = copyPage(p, doc.id);
      pages.put(copy);
      const thumbs = t.objectStore('thumbs');
      const th = await rq(thumbs.get(pid));
      if (th) thumbs.put({ id: copy.id, docId: doc.id, data: th.data });
      const docs = t.objectStore('docs');
      const d = await rq(docs.get(doc.id));
      d.pageIds.push(copy.id);
      docs.put(d);
    });
  }
  let out = await getDoc(doc.id);
  if (!out.pageIds.length) {
    const page = blankPage(out.id, out.paper);
    out.pageIds = [page.id];
    await run(['docs', 'pages'], 'readwrite', t => { t.objectStore('pages').put(page); t.objectStore('docs').put(out); });
  }
  return out;
}

export function movePage(docId, fromIndex, toIndex) {
  return run(['docs'], 'readwrite', async t => {
    const docs = t.objectStore('docs');
    const doc = await rq(docs.get(docId));
    if (!doc) throw new Error('Notebook not found');
    const n = doc.pageIds.length;
    if (fromIndex < 0 || fromIndex >= n) return doc;
    toIndex = Math.max(0, Math.min(n - 1, toIndex));
    const [id] = doc.pageIds.splice(fromIndex, 1);
    doc.pageIds.splice(toIndex, 0, id);
    doc.updatedAt = now();
    docs.put(doc);
    return doc;
  });
}

// ---------------------------------------------------------------- settings

export async function getSettings() {
  if (settingsCache) return { ...settingsCache };
  let row = null;
  try { row = await run(['meta'], 'readonly', t => rq(t.objectStore('meta').get('settings'))); } catch { /* defaults */ }
  settingsCache = { ...DEFAULT_SETTINGS, ...(row || {}) };
  delete settingsCache.key;
  return { ...settingsCache };
}

export async function saveSettings(partial) {
  if (!settingsCache) await getSettings();
  // Merge synchronously (no await between read and write) so concurrent calls never drop each other's keys.
  settingsCache = { ...settingsCache, ...partial };
  const row = { ...settingsCache, key: 'settings' };
  await run(['meta'], 'readwrite', t => { t.objectStore('meta').put(row); });
  return { ...settingsCache };
}

// ---------------------------------------------------------------- backup / restore

/** JSON backup built as many small Blob parts (never one giant JSON.stringify). */
export async function exportAll() {
  const docs = await listDocs();
  const parts = [];
  const push = s => parts.push(new Blob([s]));
  push(`{"app":"flash-notes","version":1,"exportedAt":${now()},"docs":[`);
  docs.forEach((d, i) => push((i ? ',' : '') + JSON.stringify(d)));
  push('],"pages":[');
  let first = true;
  for (const d of docs) {
    for (const pid of d.pageIds || []) {
      const p = await getPage(pid);
      if (!p) continue;
      push((first ? '' : ',') + JSON.stringify(p));
      first = false;
    }
  }
  push(']}');
  return new Blob(parts, { type: 'application/json' });
}

function validDoc(d) {
  return d && typeof d.id === 'string' && (d.kind === 'notebook' || d.kind === 'whiteboard') && Array.isArray(d.pageIds);
}

/**
 * Restore a backup. mode 'replace' wipes existing notes first. mode 'merge' keeps everything: a doc whose
 * id already exists is skipped when it is the same version, otherwise imported as a renamed copy.
 * Returns {docs, pages, skipped}.
 */
export async function importAll(fileOrBlob, { mode = 'merge' } = {}) {
  let data;
  try { data = JSON.parse(await fileOrBlob.text()); } catch { throw new Error('That file is not a Flash Notes backup.'); }
  if (!data || data.app !== 'flash-notes' || !Array.isArray(data.docs) || !Array.isArray(data.pages)) {
    throw new Error('That file is not a Flash Notes backup.');
  }
  if (data.version > 1) throw new Error('This backup was made by a newer version of Flash Notes.');

  const pagesById = new Map();
  for (const p of data.pages) if (p && typeof p.id === 'string') pagesById.set(p.id, p);

  if (mode === 'replace') {
    await run(['docs', 'pages', 'thumbs', 'meta'], 'readwrite', async t => {
      t.objectStore('docs').clear();
      t.objectStore('pages').clear();
      t.objectStore('thumbs').clear();
      const meta = t.objectStore('meta');
      const keys = await rq(meta.getAllKeys());
      for (const k of keys) if (String(k).startsWith('view:')) meta.delete(k);
    });
  }

  const existing = new Map((await listDocs()).map(d => [d.id, d]));
  const result = { docs: 0, pages: 0, skipped: 0 };

  for (const raw of data.docs) {
    if (!validDoc(raw)) { result.skipped++; continue; }
    const doc = clone(raw);
    let remap = false;
    const clash = existing.get(doc.id);
    if (clash) {
      if ((clash.updatedAt || 0) === (doc.updatedAt || 0)) { result.skipped++; continue; }
      remap = true;
      doc.id = newId();
      doc.title = `${doc.title || 'Untitled'} (restored)`;
    }
    doc.title = String(doc.title || 'Untitled');
    doc.createdAt = doc.createdAt || now();
    doc.updatedAt = doc.updatedAt || now();
    const srcIds = doc.pageIds.filter(id => pagesById.has(id));
    doc.pageIds = [];
    await putDoc(doc);
    for (const pid of srcIds) {
      const src = pagesById.get(pid);
      const page = remap ? copyPage(src, doc.id) : { ...src, docId: doc.id };
      if (remap) { page.createdAt = src.createdAt || page.createdAt; page.updatedAt = src.updatedAt || page.updatedAt; }
      if (!Array.isArray(page.items)) page.items = [];
      if (!page.paper) page.paper = { style: 'blank', color: 'white' };
      await run(['pages'], 'readwrite', t => { t.objectStore('pages').put(page); });
      doc.pageIds.push(page.id);
      result.pages++;
    }
    if (!doc.pageIds.length) {
      const page = blankPage(doc.id, doc.paper);
      await run(['pages'], 'readwrite', t => { t.objectStore('pages').put(page); });
      doc.pageIds.push(page.id);
    }
    if (doc.kind === 'whiteboard') doc.pageIds = doc.pageIds.slice(0, 1);
    await putDoc(doc);
    result.docs++;
  }
  return result;
}

// ---------------------------------------------------------------- storage

export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

export async function isPersisted() {
  try { return !!(navigator.storage && navigator.storage.persisted && await navigator.storage.persisted()); } catch { return false; }
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch { /* unsupported */ }
  return { usage: 0, quota: 0 };
}

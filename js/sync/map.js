// Pure mapping between the app's records (IndexedDB) and the rows stored in the account (Postgres), with
// validation in both directions. Nothing from the server is trusted more than a backup file would be.
// Tested in tests/sync.test.mjs.

export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_TITLE = 200;
export const MAX_DOC_BYTES = 1000000;      // the database allows 1,048,576
export const MAX_PAGE_BYTES = 8000000;     // the database allows 8,388,608
const ITEM_TYPES = new Set(['stroke', 'text', 'image']);
export const IMG_REF = /^fln-img:([0-9a-f]{64})\.(jpg|png)$/;
const DATA_IMG = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const word = (v, fallback) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(v) ? v : fallback);

export const validId = id => typeof id === 'string' && ID_RE.test(id);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanTitle = t => (typeof t === 'string' ? t : '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TITLE);
const ms = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };

/** UTF-8 size of a value once it is JSON. */
export function jsonBytes(v) {
  const s = JSON.stringify(v);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return unescape(encodeURIComponent(s)).length;
}

function cleanItems(items, { allowRefs }) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!isObj(it) || typeof it.id !== 'string' || !ITEM_TYPES.has(it.type)) continue;
    if (it.type === 'text') { out.push({ ...it, text: typeof it.text === 'string' ? it.text : '' }); continue; }
    if (it.type === 'image') {
      const src = it.src;
      if (typeof src !== 'string') continue;
      if (!(DATA_IMG.test(src) || (allowRefs && IMG_REF.test(src)))) continue;   // never http(s), javascript:, svg…
      out.push(it);
      continue;
    }
    if (!Array.isArray(it.points)) continue;
    out.push(it);
  }
  return out;
}

/** Local notebook / whiteboard → row. `at` = when it last changed on this device (ms). Throws on bad input. */
export function docToRow(doc, at) {
  if (!isObj(doc) || !validId(doc.id)) throw new Error('invalid-id');
  if (doc.kind !== 'notebook' && doc.kind !== 'whiteboard') throw new Error('invalid-kind');
  const { id, kind, title, updatedAt, ...data } = doc;
  data.pageIds = (Array.isArray(doc.pageIds) ? doc.pageIds : []).filter(validId);
  const row = { id, kind, title: cleanTitle(title), data, updated_at: ms(at), deleted: false };
  if (jsonBytes(row.data) > MAX_DOC_BYTES) throw new Error('too-large');
  return row;
}

/** Local page → row (image data must already have been swapped for references, see images.js). */
export function pageToRow(page, at) {
  if (!isObj(page) || !validId(page.id) || !validId(page.docId)) throw new Error('invalid-id');
  const { id, docId, updatedAt, ...data } = page;
  data.items = cleanItems(page.items, { allowRefs: true });
  const row = { id, doc_id: docId, data, updated_at: ms(at), deleted: false };
  if (jsonBytes(row.data) > MAX_PAGE_BYTES) throw new Error('too-large');
  return row;
}

export function tombstoneRow(kind, id, at, docKind) {
  if (!validId(id)) throw new Error('invalid-id');
  return kind === 'doc'
    ? { id, kind: docKind === 'whiteboard' ? 'whiteboard' : 'notebook', title: '', data: {}, updated_at: ms(at), deleted: true }
    : { id, doc_id: '00000000', data: {}, updated_at: ms(at), deleted: true };
}

/** Row → local notebook / whiteboard, or null when the row is not usable. */
export function rowToDoc(row) {
  if (!isObj(row) || !validId(row.id) || (row.kind !== 'notebook' && row.kind !== 'whiteboard')) return null;
  const data = isObj(row.data) ? row.data : {};
  const doc = { ...data, id: row.id, kind: row.kind, title: cleanTitle(row.title) || (row.kind === 'notebook' ? 'Untitled notebook' : 'Untitled whiteboard'), updatedAt: ms(row.updated_at) };
  doc.pageIds = (Array.isArray(data.pageIds) ? data.pageIds : []).filter(validId);
  doc.createdAt = ms(data.createdAt) || doc.updatedAt;
  if (doc.cover !== undefined) {
    const c = isObj(doc.cover) ? doc.cover : {};
    // These values end up in CSS (cover colour) and class names (pattern): only plain, expected shapes pass.
    doc.cover = {
      color: typeof c.color === 'string' && HEX.test(c.color) ? c.color : '#3B5BDB',
      pattern: word(c.pattern, 'plain'),
      emoji: typeof c.emoji === 'string' && c.emoji.length <= 16 ? c.emoji : null,
      image: typeof c.image === 'string' && DATA_IMG.test(c.image) ? c.image : null,
    };
  }
  if (doc.paper !== undefined) doc.paper = isObj(doc.paper) ? { style: word(doc.paper.style, 'lined'), color: word(doc.paper.color, 'white') } : { style: 'lined', color: 'white' };
  if (doc.background !== undefined) doc.background = word(doc.background, 'dots');
  return doc;
}

/** Row → local page (image references still in place), or null. */
export function rowToPage(row) {
  if (!isObj(row) || !validId(row.id) || !validId(row.doc_id)) return null;
  const data = isObj(row.data) ? row.data : {};
  const page = { ...data, id: row.id, docId: row.doc_id, updatedAt: ms(row.updated_at) };
  page.items = cleanItems(data.items, { allowRefs: true });
  page.createdAt = ms(data.createdAt) || page.updatedAt;
  page.paper = isObj(data.paper) ? { style: word(data.paper.style, 'blank'), color: word(data.paper.color, 'white') } : { style: 'blank', color: 'white' };
  return page;
}

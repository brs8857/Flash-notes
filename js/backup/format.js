// The .flashnotes backup file: one ZIP that holds the whole library, built so that a person (or a future
// version of Flash Notes) can always get their notes back out of it.
//
//   manifest.json                     {app, kind:'backup', format, minReader, createdAt, appVersion, counts,
//                                      fingerprint, entries:{<name>:{size, sha256}}}
//   library.json                      the same JSON as Settings → Download backup (store.exportAll), except
//                                      that pictures are references "fln-img:<sha256>.<ext>" into images/
//   images/<sha256>.<png|jpg|webp|gif> each picture once, as its real bytes (not base64)
//   markdown/<Notebook>/Page 001.md   readable copies of titles and text boxes (never read back)
//
// Note data only: notebooks, whiteboards, pages, pictures and pen/colour settings. Never the account, the
// sign-in session, tokens or the Supabase configuration (those are not in IndexedDB's notes at all).
// Reading is strict (js/backup/zip.js + the checks here); the legacy .json backup is still accepted.
import * as store from '../store.js';
import { writeZip, openZip, ZipError, LIMITS } from './zip.js';
import { notesToMarkdown } from '../export-md.js';
import { sha256 } from './sha256.js';

export const FORMAT = 1;                 // bump when the layout changes; readers refuse minReader > FORMAT
export const EXT = '.flashnotes';
const DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;
const REF = /^fln-img:([0-9a-f]{64})\.(png|jpg|webp|gif)$/;
const IMAGE_NAME = /^images\/([0-9a-f]{64})\.(png|jpg|webp|gif)$/;
const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_JSON_BYTES = 256 * 1024 * 1024;
/** Settings that describe this device's backups are never put in, or restored from, a backup. */
const DEVICE_ONLY = /^(autoBackup|backup)/;

const enc = new TextEncoder();
const decUtf8 = new TextDecoder('utf-8', { fatal: true });

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Settings worth keeping in a backup (pens, colours, smart ink…), without this device's backup setup. */
export function portableSettings(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) if (k !== 'key' && !DEVICE_ONLY.test(k)) out[k] = v;
  return out;
}

/**
 * A cheap "has anything changed?" value: SHA-256 of every notebook/whiteboard record (they carry the time
 * of the last change to any of their pages, the page list, titles and covers) plus the portable settings.
 */
export async function libraryFingerprint(settings) {
  const docs = (await store.listDocs()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const json = JSON.stringify({ docs, settings: portableSettings(settings) });
  return sha256(enc.encode(json));
}

/** One path part of a Markdown file name: readable, and always safe for zip.js. */
function part(name, fallback) {
  const s = String(name || '').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60).trim();
  return s || fallback;
}

/**
 * Builds a .flashnotes file from what is in IndexedDB now.
 * opts.pause: awaited between pages and slices of work (keeps drawing smooth). opts.settings: app settings.
 * Returns {blob, manifest, fingerprint, librarySha, counts}.
 */
export async function buildBackup({ pause, settings, appVersion = '', fingerprint, now = Date.now() } = {}) {
  const fp = fingerprint || await libraryFingerprint(settings);
  const images = new Map();              // name → bytes
  const refOf = new Map();               // data URL → reference (the same picture is stored once)
  const docsById = new Map();
  const markdown = [];
  const counts = { notebooks: 0, whiteboards: 0, pages: 0, images: 0 };

  async function ref(src) {
    if (typeof src !== 'string') return src;
    const hit = refOf.get(src);
    if (hit) return hit;
    const m = DATA_URL.exec(src);
    if (!m) return src;                  // anything else stays as it is (and is checked again on restore)
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    let bytes;
    try { bytes = b64ToBytes(m[2]); } catch { return src; }   // a damaged picture must not stop every backup
    const hex = await sha256(bytes, pause);
    const name = `images/${hex}.${ext}`;
    if (!images.has(name)) images.set(name, bytes);
    const r = `fln-img:${hex}.${ext}`;
    refOf.set(src, r);
    return r;
  }

  const library = await store.exportAll({
    pause,
    extra: { settings: portableSettings(settings) },
    mapDoc: async doc => {
      docsById.set(doc.id, doc);
      counts[doc.kind === 'whiteboard' ? 'whiteboards' : 'notebooks']++;
      if (!doc.cover || !doc.cover.image) return doc;
      return { ...doc, cover: { ...doc.cover, image: await ref(doc.cover.image) } };
    },
    mapPage: async page => {
      counts.pages++;
      const doc = docsById.get(page.docId);
      if (doc) {
        const i = (doc.pageIds || []).indexOf(page.id);
        markdown.push({ doc, page, n: i + 1 });
      }
      if (!(page.items || []).some(it => it && it.type === 'image')) return page;
      const items = [];
      for (const it of page.items) items.push(it && it.type === 'image' ? { ...it, src: await ref(it.src) } : it);
      return { ...page, items };
    },
  });
  counts.images = images.size;
  const libBytes = new Uint8Array(await library.arrayBuffer());
  if (pause) await pause();

  // Readable copies: one Markdown file per page, in a folder per notebook (names made unique).
  const entries = [];
  const used = new Set();
  const folders = new Map();
  for (const { doc, page, n } of markdown) {
    let folder = folders.get(doc.id);
    if (!folder) {
      const base = part(doc.title, doc.kind === 'whiteboard' ? 'Untitled whiteboard' : 'Untitled notebook');
      folder = base;
      for (let k = 2; used.has(folder.toLowerCase()); k++) folder = `${base} (${k})`;
      used.add(folder.toLowerCase());
      folders.set(doc.id, folder);
    }
    const file = doc.kind === 'whiteboard' ? 'Whiteboard.md' : `Page ${String(n).padStart(3, '0')}.md`;
    const md = notesToMarkdown([{ doc, pages: [page] }], { heading: false, firstPage: n });
    entries.push({ name: `markdown/${folder}/${file}`, data: enc.encode(md), compress: true });
  }

  const all = [{ name: 'library.json', data: libBytes, compress: true }, ...[...images].map(([name, data]) => ({ name, data, compress: false })), ...entries];
  const listed = {};
  for (const e of all) {
    listed[e.name] = { size: e.data.length, sha256: await sha256(e.data, pause) };
    if (pause) await pause();
  }
  const manifest = {
    app: 'flash-notes', kind: 'backup', format: FORMAT, minReader: 1,
    createdAt: now, createdAtISO: new Date(now).toISOString(), appVersion: String(appVersion || ''),
    libraryVersion: 1, counts, fingerprint: fp,
    contents: 'Notebooks, whiteboards, pages, pictures and pen settings only. No account, sign-in or session details.',
    entries: listed,
  };
  const blob = await writeZip([{ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 1)), compress: true }, ...all], { pause, date: new Date(now) });
  return { blob, manifest, fingerprint: fp, librarySha: listed['library.json'].sha256, counts };
}

// ---------------------------------------------------------------- reading

export class BackupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const bad = (code, msg) => new BackupError(code, msg || 'That file is damaged or is not a Flash Notes backup.');

function parseJson(bytes) {
  try { return JSON.parse(decUtf8.decode(bytes)); } catch { throw bad('json'); }
}

function checkLibrary(data) {
  if (!data || typeof data !== 'object' || data.app !== 'flash-notes' || !Array.isArray(data.docs) || !Array.isArray(data.pages)) throw bad('schema');
  if (data.version > 1) throw bad('newer', 'This backup was made by a newer version of Flash Notes. Update the app and try again.');
  return data;
}

const isZip = u8 => u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;

/**
 * Reads a .flashnotes file (or a legacy .json backup) and returns {kind, manifest, data}, where `data` is
 * the plain backup object store.importData() takes (pictures back as data URLs). Everything is checked:
 * the zip itself, the manifest, every size and SHA-256, picture names against their own hashes, and the
 * library's shape. Throws BackupError / ZipError with a message fit to show.
 */
export async function readBackup(fileOrBlob, { pause, limits = LIMITS } = {}) {
  if (!fileOrBlob || typeof fileOrBlob.size !== 'number') throw bad('input');
  if (fileOrBlob.size > limits.maxFileBytes) throw bad('too-large', 'That file is too large to be a Flash Notes backup.');
  const u8 = new Uint8Array(await fileOrBlob.arrayBuffer());
  if (!isZip(u8)) {
    // The v1.0–v2.0 backup: one JSON file.
    if (u8.length > MAX_JSON_BYTES) throw bad('too-large', 'That file is too large to be a Flash Notes backup.');
    let data;
    try { data = JSON.parse(decUtf8.decode(u8)); } catch { throw bad('not-backup', 'That file is not a Flash Notes backup.'); }
    if (!data || data.app !== 'flash-notes') throw bad('not-backup', 'That file is not a Flash Notes backup.');
    return { kind: 'json', manifest: null, data: checkLibrary(data) };
  }

  let zip;
  try { zip = openZip(u8, limits); } catch (err) { throw err instanceof ZipError ? err : bad('zip'); }
  if (!zip.has('manifest.json') || zip.size('manifest.json') > 4 * 1024 * 1024) throw bad('manifest', 'That file is not a Flash Notes backup (it has no manifest).');
  const manifest = parseJson(await zip.read('manifest.json'));
  if (!manifest || manifest.app !== 'flash-notes' || manifest.kind !== 'backup' || !Number.isInteger(manifest.format) || manifest.format < 1) throw bad('manifest', 'That file is not a Flash Notes backup.');
  if ((Number(manifest.minReader) || manifest.format) > FORMAT) throw bad('newer', 'This backup was made by a newer version of Flash Notes. Update the app and try again.');
  const listed = manifest.entries && typeof manifest.entries === 'object' ? manifest.entries : null;
  if (!listed || !listed['library.json']) throw bad('manifest');

  async function verified(name) {
    const want = listed[name];
    if (!want || typeof want.sha256 !== 'string') throw bad('manifest');
    if (!zip.has(name)) throw bad('missing', 'That backup is incomplete (part of it is missing).');
    if (zip.size(name) !== want.size) throw bad('size');
    const bytes = await zip.read(name, pause);
    if ((await sha256(bytes, pause)) !== want.sha256) throw bad('hash', 'That backup is damaged (its contents do not match its checksums).');
    return bytes;
  }

  const data = checkLibrary(parseJson(await verified('library.json')));
  // Pictures: only names the format allows, each checked against the manifest AND against its own name.
  const pictures = new Map();            // reference → data URL
  for (const name of Object.keys(listed)) {
    if (!name.startsWith('images/')) continue;
    const m = IMAGE_NAME.exec(name);
    if (!m) throw bad('path', 'That backup contains a file with an unsafe name.');
    const bytes = await verified(name);
    if (listed[name].sha256 !== m[1]) throw bad('hash', 'That backup is damaged (its contents do not match its checksums).');
    pictures.set(`fln-img:${m[1]}.${m[2]}`, `data:${MIME_OF[m[2]]};base64,${bytesToB64(bytes)}`);
    if (pause) await pause();
  }
  const resolve = src => {
    if (typeof src !== 'string' || !src.startsWith('fln-img:')) return src;
    if (!REF.test(src) || !pictures.has(src)) throw bad('missing', 'That backup is incomplete (a picture is missing).');
    return pictures.get(src);
  };
  for (const doc of data.docs) if (doc && doc.cover && typeof doc.cover === 'object' && doc.cover.image) doc.cover.image = resolve(doc.cover.image);
  for (const page of data.pages) {
    if (!page || !Array.isArray(page.items)) continue;
    for (const it of page.items) if (it && it.type === 'image') it.src = resolve(it.src);
  }
  return { kind: 'flashnotes', manifest, data };
}

/** Restores a backup object from readBackup(): mode 'merge' (add alongside) or 'replace'. */
export function importBackup(data, { mode = 'merge' } = {}) {
  return store.importData(data, { mode });
}

// A tiny ZIP writer and reader for .flashnotes backups (no dependency, no build step). Pure: works in the
// browser and in Node (tests/backup.test.mjs). Only what Flash Notes needs: STORE and DEFLATE (through the
// browser's own CompressionStream('deflate-raw') when it has one), UTF-8 names, no ZIP64, no encryption.
//
// The reader treats every file as hostile: it checks the end record, the central directory, every local
// header, names (no "..", no absolute paths, no backslashes, no control characters), duplicate names,
// overlapping entries, declared and actual sizes, compression ratios (zip bombs) and the CRC-32 of every
// entry it extracts. Nothing is decompressed until it is asked for, and never past its declared size.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;

export const LIMITS = {
  maxFileBytes: 512 * 1024 * 1024,     // the whole .flashnotes file
  maxEntries: 50000,
  maxEntryBytes: 256 * 1024 * 1024,    // one entry, uncompressed
  maxTotalBytes: 1024 * 1024 * 1024,   // all entries, uncompressed
  maxRatio: 200,                       // uncompressed / compressed, for entries over 1 MB
  maxNameBytes: 512,
};

export class ZipError extends Error {
  constructor(code, message) { super(message || 'That file is damaged or is not a Flash Notes backup.'); this.code = code; }
}

// ---------------------------------------------------------------- CRC-32

let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

/** CRC-32 of bytes. `crc` continues an earlier call (pass the previous result). */
export function crc32(bytes, crc = 0) {
  const t = table();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SLICE = 128 * 1024;
/** CRC-32 in slices, awaiting `pause()` between them so a big entry never blocks the page. */
export async function crc32Chunked(bytes, pause) {
  let c = 0;
  for (let i = 0; i < bytes.length; i += SLICE) {
    c = crc32(bytes.subarray(i, Math.min(bytes.length, i + SLICE)), c);
    if (pause && i + SLICE < bytes.length) await pause();
  }
  return c;
}

// ---------------------------------------------------------------- compression (feature-detected)

let deflateOk = null;
export function canDeflate() {
  if (deflateOk !== null) return deflateOk;
  try { new CompressionStream('deflate-raw'); deflateOk = true; } catch { deflateOk = false; }
  return deflateOk;
}
let inflateOk = null;
export function canInflate() {
  if (inflateOk !== null) return inflateOk;
  try { new DecompressionStream('deflate-raw'); inflateOk = true; } catch { inflateOk = false; }
  return inflateOk;
}

// The input is written by hand (not piped from a Blob stream) so that every error surfaces through the
// reader, where it is caught, and never as an unhandled rejection on the writable side.
// Big inputs go in slices, so the browser's (de)compressor never works on one huge chunk in one task.
// Awaiting a promise alone never lets the page draw (it is a microtask), so `pause` (a real yield) runs
// between slices too.
function feed(ts, bytes, pause) {
  const writer = ts.writable.getWriter();
  (async () => {
    for (let i = 0; i < bytes.length; i += SLICE) {
      if (pause && i) await pause();
      await writer.ready;
      await writer.write(bytes.subarray(i, Math.min(bytes.length, i + SLICE)));
    }
    await writer.close();
  })().catch(() => {});
  return ts.readable.getReader();
}

/** → {chunks, length}: the compressed bytes, left in the pieces the compressor produced. */
async function deflate(bytes, pause) {
  const reader = feed(new CompressionStream('deflate-raw'), bytes, pause);
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  return { chunks, length };
}

/** Inflates, refusing to produce more than `limit` bytes (stops reading at once when it would). */
async function inflate(bytes, limit, pause) {
  const reader = feed(new DecompressionStream('deflate-raw'), bytes, pause);
  let out;
  try { out = new Uint8Array(limit); } catch { throw new ZipError('memory', 'There is not enough memory to open that backup.'); }
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > limit) throw new ZipError('size', 'That backup is damaged (an entry is larger than it says).');
      out.set(value, n);
      n += value.length;
    }
  } catch (err) {
    try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
    if (err instanceof ZipError) throw err;
    throw new ZipError('inflate', 'That backup is damaged (it could not be unpacked).');
  }
  return n === limit ? out : out.subarray(0, n);
}

// ---------------------------------------------------------------- writer

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const enc = new TextEncoder();

/**
 * entries: [{name, data: Uint8Array, compress?: boolean}]. Returns a Blob (application/zip).
 * opts.pause: async () => void, awaited between slices of work. opts.date: modification time for entries.
 * Compression is used when asked for AND the browser can deflate AND it actually makes the entry smaller.
 */
export async function writeZip(entries, { pause, date = new Date(), deflate: allowDeflate = true } = {}) {
  const { time, date: dday } = dosTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  const names = new Set();
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    if (!safeName(e.name) || nameBytes.length > LIMITS.maxNameBytes || names.has(e.name)) throw new ZipError('name', `Bad zip entry name: ${e.name}`);
    names.add(e.name);
    const raw = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const crc = await crc32Chunked(raw, pause);
    let body = [raw], size = raw.length, method = 0;
    if (e.compress && allowDeflate && canDeflate() && raw.length > 64) {
      const z = await deflate(raw, pause);
      if (z.length < raw.length) { body = z.chunks; size = z.length; method = 8; }
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, dday, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Blob([local.buffer, nameBytes, ...body]));   // one entry at a time: no giant copy at the end

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, SIG_CENTRAL, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, FLAG_UTF8, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, dday, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, nameBytes.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, nameBytes);
    offset += 30 + nameBytes.length + size;
    if (offset > 0xfffffff0) throw new ZipError('size', 'The backup is too large.');
    if (pause) await pause();
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  if (entries.length > 0xffff) throw new ZipError('size', 'Too many entries.');
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------------------------------------------------------------- reader

/** A name we are willing to read or write: relative, forward slashes, no "." or ".." parts, printable. */
export function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > LIMITS.maxNameBytes) return false;
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  return name.split('/').every(p => p && p !== '.' && p !== '..' && p.trim() === p);
}

const dec = new TextDecoder('utf-8', { fatal: true });

/**
 * Opens a zip held in memory (ArrayBuffer | Uint8Array). Returns {names, has(name), size(name),
 * read(name, pause?) → Promise<Uint8Array>}. Throws ZipError for anything that is not a well-formed, safe zip.
 */
export function openZip(input, limits = LIMITS) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length > limits.maxFileBytes) throw new ZipError('too-large', 'That file is too large to be a Flash Notes backup.');
  if (u8.length < 22) throw new ZipError('not-zip');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // End of central directory: the last 22 bytes, or further back when there is a comment (≤ 65,535 bytes).
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_END && i + 22 + dv.getUint16(i + 20, true) === u8.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not-zip');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (dv.getUint16(eocd + 4, true) !== 0 || dv.getUint16(eocd + 6, true) !== 0 || dv.getUint16(eocd + 8, true) !== count) throw new ZipError('multi-disk');
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('zip64');
  if (count > limits.maxEntries) throw new ZipError('entries', 'That backup has too many files in it.');
  if (cdOff + cdSize > eocd) throw new ZipError('truncated');

  const entries = new Map();
  let p = cdOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOff + cdSize || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('truncated');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    if (p + 46 + nlen + elen + clen > cdOff + cdSize) throw new ZipError('truncated');
    let name;
    try { name = dec.decode(u8.subarray(p + 46, p + 46 + nlen)); } catch { throw new ZipError('name'); }
    p += 46 + nlen + elen + clen;
    if (flags & 0x0001) throw new ZipError('encrypted', 'That backup is password-protected, which Flash Notes never does.');
    if (method !== 0 && method !== 8) throw new ZipError('method');
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new ZipError('zip64');
    if (!safeName(name)) throw new ZipError('path', 'That backup contains a file with an unsafe name.');
    if (entries.has(name)) throw new ZipError('duplicate');
    if (usize > limits.maxEntryBytes) throw new ZipError('too-large', 'That backup contains a file that is too large.');
    if (method === 0 && csize !== usize) throw new ZipError('size');
    if (method === 8 && usize > 1024 * 1024 && usize > csize * limits.maxRatio) throw new ZipError('bomb', 'That file looks like a zip bomb, not a backup.');
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipError('bomb', 'That backup unpacks to more than Flash Notes can hold.');
    // Local header must agree with the central directory.
    if (lho + 30 > cdOff || dv.getUint32(lho, true) !== SIG_LOCAL) throw new ZipError('truncated');
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    if (lnlen !== nlen || dv.getUint16(lho + 8, true) !== method) throw new ZipError('header');
    const start = lho + 30 + lnlen + lelen;
    if (start + csize > cdOff) throw new ZipError('truncated');
    entries.set(name, { name, method, crc, csize, usize, lho, start, end: start + csize });
  }
  // No two entries may share bytes (the classic overlapping-entries zip bomb).
  const sorted = [...entries.values()].sort((a, b) => a.lho - b.lho);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].lho < sorted[i - 1].end) throw new ZipError('overlap', 'That file looks like a zip bomb, not a backup.');

  return {
    names: [...entries.keys()],
    has: name => entries.has(name),
    size: name => (entries.get(name) || {}).usize,
    async read(name, pause) {
      const e = entries.get(name);
      if (!e) throw new ZipError('missing', `That backup is incomplete (${name} is missing).`);
      const body = u8.subarray(e.start, e.end);
      let out;
      if (e.method === 0) out = body.slice();
      else {
        if (!canInflate()) throw new ZipError('inflate-unsupported', 'This browser is too old to open that backup. Update Safari (iOS 16.4 or later) and try again.');
        out = await inflate(body, e.usize, pause);
      }
      if (out.length !== e.usize) throw new ZipError('size', 'That backup is damaged (an entry is shorter than it says).');
      if ((await crc32Chunked(out, pause)) !== e.crc) throw new ZipError('crc', 'That backup is damaged (a checksum does not match).');
      return out;
    },
  };
}

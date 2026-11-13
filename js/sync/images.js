// Photos on a page are megabytes; strokes are kilobytes. If photos stayed inside the page's JSON, every
// pen stroke on a page with a photo would upload the photo again. So in the account a photo is one
// immutable file in the PRIVATE storage bucket, named by the SHA-256 of its bytes under the user's own
// folder, and the page row only holds "fln-img:<sha-256>.<ext>". On the device the page always holds the
// real image (data URL), so the drawing engine and offline use are unchanged.
import { IMG_REF } from './map.js';

export const BUCKET = 'note-images';
const DATA_URL = /^data:image\/(png|jpeg|jpg);base64,(.*)$/s;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function dataUrlToBytes(src) {
  const m = DATA_URL.exec(src);
  if (!m) return null;
  const bin = atob(m[2].replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, ext: m[1] === 'png' ? 'png' : 'jpg', type: m[1] === 'png' ? 'image/png' : 'image/jpeg' };
}

export function bytesToDataUrl(bytes, ext) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return `data:image/${ext === 'png' ? 'png' : 'jpeg'};base64,${btoa(bin)}`;
}

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns a copy of `items` with image data swapped for references, uploading what the account does not
 * have yet. io = {hasUploaded(name), upload(name, bytes, type), remember(name)}. Images in other formats, or
 * over the size limit, stay inside the page.
 */
export async function offloadImages(items, io) {
  const out = [];
  for (const it of items || []) {
    if (!it || it.type !== 'image' || typeof it.src !== 'string') { out.push(it); continue; }
    const parsed = dataUrlToBytes(it.src);
    if (!parsed || parsed.bytes.length > MAX_IMAGE_BYTES) { out.push(it); continue; }
    const name = `${await sha256Hex(parsed.bytes)}.${parsed.ext}`;
    if (!(await io.hasUploaded(name))) {
      await io.upload(name, parsed.bytes, parsed.type);
      await io.remember(name);
    }
    out.push({ ...it, src: 'fln-img:' + name });
  }
  return out;
}

/**
 * Returns a copy of `items` with references swapped back for image data. Looks first at the images the
 * device already has on that page (`localItems`), then downloads. io = {download(name) → Uint8Array}.
 * An image that cannot be fetched makes the whole page wait for the next sync (it throws).
 */
export async function inloadImages(items, localItems, io) {
  const refs = (items || []).filter(it => it && it.type === 'image' && IMG_REF.test(it.src || ''));
  if (!refs.length) return items || [];
  const have = new Map();
  for (const it of localItems || []) {
    if (!it || it.type !== 'image' || typeof it.src !== 'string') continue;
    const parsed = dataUrlToBytes(it.src);
    if (parsed) have.set(`${await sha256Hex(parsed.bytes)}.${parsed.ext}`, it.src);
  }
  const out = [];
  for (const it of items) {
    const m = it && it.type === 'image' ? IMG_REF.exec(it.src || '') : null;
    if (!m) { out.push(it); continue; }
    const name = `${m[1]}.${m[2]}`;
    let src = have.get(name);
    if (!src) {
      const bytes = await io.download(name);
      if ((await sha256Hex(bytes)) !== m[1]) throw new Error('image-mismatch');   // never show a file that is not the one referenced
      src = bytesToDataUrl(bytes, m[2]);
      have.set(name, src);
    }
    out.push({ ...it, src });
  }
  return out;
}

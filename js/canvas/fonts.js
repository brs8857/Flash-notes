// The bundled handwriting font ("FN Hand" = Patrick Hand, OFL). A canvas never triggers a font download
// by itself, so the engine asks for it explicitly and re-lays-out `hand` text once it has arrived.

const FACE = '24px "FN Hand"';
const SAMPLE = 'Aa Hello';
const TIMEOUT_MS = 2000;

let ready = false;
let pending = null;

/** True once the handwriting font can be used for canvas text (sync). */
export function handReady() {
  if (ready) return true;
  try { ready = !!(typeof document !== 'undefined' && document.fonts && document.fonts.check(FACE, SAMPLE) && hasFace()); } catch { ready = false; }
  return ready;
}

// fonts.check() is true for a family nobody declared, so make sure our @font-face really loaded.
function hasFace() {
  for (const f of document.fonts) if (/FN Hand/.test(f.family) && f.status === 'loaded') return true;
  return false;
}

/**
 * Load the handwriting font. Memoised; resolves false on failure or after 2 s (a later call tries again).
 * @returns {Promise<boolean>}
 */
export function ensureHandFont() {
  if (ready) return Promise.resolve(true);
  if (pending) return pending;
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return Promise.resolve(false);
  const load = document.fonts.load(FACE, SAMPLE).then((faces) => {
    ready = Array.isArray(faces) ? faces.length > 0 : handReady();
    return ready;
  }).catch(() => false);
  let tid = 0;
  const timeout = new Promise((resolve) => { tid = setTimeout(() => resolve(false), TIMEOUT_MS); });
  pending = Promise.race([load, timeout]).then((ok) => {
    clearTimeout(tid);
    pending = null;
    if (!ok) load.then((late) => { if (late) lateListeners.splice(0).forEach((fn) => { try { fn(); } catch (err) { console.error(err); } }); });
    return ok;
  });
  return pending;
}

const lateListeners = [];
/** Run `fn` once if the font arrives after ensureHandFont() already gave up waiting (slow network). */
export function onLateHandFont(fn) {
  if (!ready) lateListeners.push(fn);
  return () => { const i = lateListeners.indexOf(fn); if (i >= 0) lateListeners.splice(i, 1); };   // for views that are destroyed first
}

/** Does this item list contain text in the handwriting font? */
export function usesHandFont(items) {
  return Array.isArray(items) && items.some((it) => it && it.type === 'text' && it.font === 'hand');
}

// Tiny DOM + utility helpers shared by the whole app.

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'textContent', 'hidden', 'tabIndex', 'selected', 'id', 'type']);

/** h('button', {class:'x', onClick(){}, 'aria-label':'Hi'}, 'child', el, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else setStyles(el, v); }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'onFast' && typeof v === 'function') fastTap(el, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROP_KEYS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function setStyles(el, styles) {
  for (const [k, v] of Object.entries(styles)) {
    if (v == null) continue;
    if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v;
  }
}

// ---- fastTap ------------------------------------------------------------------------------------------
// Touch and Pencil taps normally wait for the finger to lift (and the browser's click) before anything
// happens; fastTap reacts on pointerdown. The click that follows is swallowed once (near the same spot,
// within FAST_GAP ms) so the handler never runs twice. Mouse and keyboard keep using plain click.
// Falls back to "run on lift" (pointerup, no movement) when the element sits in something that scrolls
// (a long brush row, a tall popover) or when asked for (`deferred`: long-press controls), so starting a
// scroll never presses a button. Do NOT use it for handlers that need a user activation Safari only grants
// on pointerup/click (file pickers, share sheet, clipboard): use a plain click there.
const FAST_GAP = 700, TAP_SLOP = 8, TAP_MAX_MS = 450;
let fastHit = null, fastReady = false;

function installFastTap() {
  if (fastReady) return;
  fastReady = true;
  document.addEventListener('pointerdown', () => { fastHit = null; }, true);
  document.addEventListener('click', e => {
    if (!fastHit) return;
    const f = fastHit;
    if (performance.now() - f.t > FAST_GAP) { fastHit = null; return; }
    if (e.detail !== 0 && Math.hypot(e.clientX - f.x, e.clientY - f.y) < 48) {
      fastHit = null;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);
}

function inScroller(el) {
  for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) return true;
    }
  }
  return false;
}

/** Run `handler` as soon as a finger / Pencil touches `el` (and on click for mouse / keyboard). → remove() */
export function fastTap(el, handler, { deferred = false } = {}) {
  installFastTap();
  let track = null;
  const run = e => { fastHit = { x: e.clientX, y: e.clientY, t: performance.now() }; handler(e); };
  const down = e => {
    track = null;
    if (e.pointerType === 'mouse' || !e.isPrimary || (e.button && e.button !== 0) || el.disabled) return;
    if (deferred || inScroller(el)) track = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    else run(e);
  };
  const move = e => { if (track && e.pointerId === track.id && Math.hypot(e.clientX - track.x, e.clientY - track.y) > TAP_SLOP) track = null; };
  const up = e => {
    const t = track;
    track = null;
    if (t && e.pointerId === t.id && performance.now() - t.t < TAP_MAX_MS && !el.disabled) run(e);
  };
  const cancel = () => { track = null; };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('click', handler);
  return () => {
    el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('click', handler);
  };
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Run `fn` when the browser has nothing better to do (requestIdleCallback; Safari has none: a short timeout). */
export function idle(fn, timeout = 1500) {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 120);
  return () => clearTimeout(id);
}

export const wait = ms => new Promise(r => setTimeout(r, ms));
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function debounce(fn, ms) {
  let t = null, lastArgs = null;
  const d = (...args) => { lastArgs = args; clearTimeout(t); t = setTimeout(() => { t = null; fn(...lastArgs); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.flush = () => { if (t != null) { clearTimeout(t); t = null; fn(...(lastArgs || [])); } };
  d.pending = () => t != null;
  return d;
}

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** WAAPI wrapper that resolves when finished and never throws. */
export function animate(el, keyframes, options) {
  if (!el.animate || reducedMotion()) return Promise.resolve();
  try {
    const a = el.animate(keyframes, options);
    return a.finished.catch(() => {});
  } catch { return Promise.resolve(); }
}

export const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
export const SPRING_SOFT = 'cubic-bezier(0.22, 1.2, 0.36, 1)';
export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
}
export const isNarrow = () => window.innerWidth < 640;

export function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || word + 's')}`;

export function formatBytes(n) {
  if (!n) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Relative luminance (0..1) of a #rrggbb colour. */
export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

/** Mix a hex colour towards black (amt<0) or white (amt>0). */
export function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  const c = v => Math.round(v + (t - v) * p);
  return '#' + [c(n >> 16), c((n >> 8) & 255), c(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function safeFileName(name, fallback = 'Flash Notes') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

/**
 * Decode an image file and downscale it so the longest side is ≤ max.
 * Returns {dataUrl, w, h}. Keeps transparency (PNG) for png/webp/gif sources when keepAlpha is set.
 */
export async function downscaleImage(file, max, { keepAlpha = false, quality = 0.85 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Could not read that image')); img.src = url; });
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) throw new Error('Could not read that image');
    const k = Math.min(1, max / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * k)), hgt = Math.max(1, Math.round(nh * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    const alpha = keepAlpha && /png|webp|gif/i.test(file.type || '');
    if (!alpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, hgt);
    const dataUrl = alpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
    canvas.width = canvas.height = 0; // Safari keeps canvas memory otherwise
    return { dataUrl, w, h: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A hidden <input type=file> that can be re-used; pick() must be called inside a user gesture. */
export function filePicker(accept) {
  const input = h('input', { type: 'file', accept, class: 'visually-hidden', tabIndex: -1, 'aria-hidden': 'true' });
  document.body.append(input);
  let cb = null;
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (f && cb) cb(f);
  });
  return {
    pick(fn) { cb = fn; input.click(); },
    destroy() { input.remove(); },
  };
}

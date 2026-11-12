// Flash Notes service worker: versioned, atomic precache; cache-first; update only when the user taps.
const VERSION = 'v4';
const CACHE = 'fln-' + VERSION;

// Builder B's files. The drawing engine's files come from js/canvas/files.json at install time.
const APP_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/canvas.css',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/ui/dom.js',
  './js/ui/icons.js',
  './js/ui/squircle.js',
  './js/ui/sheet.js',
  './js/ui/menu.js',
  './js/ui/toast.js',
  './js/ui/cover.js',
  './js/ui/cover-editor.js',
  './js/ui/paper.js',
  './js/ui/library.js',
  './js/ui/editor.js',
  './js/ui/toolbar.js',
  './js/ui/page-drawer.js',
  './js/ui/settings.js',
  './js/ui/export.js',
  './js/ui/pdf.js',
  './js/ui/color.js',
  './js/ui/color-picker.js',
  './js/canvas/files.json',
  './vendor/perfect-freehand.js',
  './icons/icon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const fresh = url => fetch(new Request(url, { cache: 'reload' })).then(res => {
  if (!res.ok) throw new Error(`Precache failed for ${url}: ${res.status}`);
  return res;
});

async function precache() {
  const listRes = await fresh('./js/canvas/files.json');
  const engineFiles = (await listRes.clone().json()).map(p => './' + String(p).replace(/^\.?\//, ''));
  const urls = [...new Set([...APP_FILES, ...engineFiles])];
  // All or nothing: fetch everything first (GitHub Pages sends max-age=600, so bypass the HTTP cache),
  // and only then write into the new cache.
  const responses = await Promise.all(urls.map(u => (u === './js/canvas/files.json' ? listRes : fresh(u))));
  const cache = await caches.open(CACHE);
  try {
    await Promise.all(urls.map((u, i) => cache.put(u, responses[i])));
  } catch (err) {
    await caches.delete(CACHE);
    throw err;
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precache());   // no skipWaiting here: new modules must never mix with a running old page
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('fln-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const scope = new URL('./', self.location.href).pathname;
      if (url.pathname === scope || url.pathname === scope + 'index.html') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
    }
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

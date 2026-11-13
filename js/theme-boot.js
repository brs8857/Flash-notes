// Applies a forced light/dark theme before first paint (the full settings live in IndexedDB).
// A separate file, not an inline script, so the Content-Security-Policy can forbid inline scripts.
try {
  var t = localStorage.getItem('fln.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* storage unavailable */ }

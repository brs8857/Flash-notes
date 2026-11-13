// Masking logger. The ONLY place in the account / sync code that writes to the console.
// It never prints tokens, note content or full email addresses: values are reduced to a short, masked
// description first. tests/auth.test.mjs checks the masking, and a grep in SETUP.md shows how to confirm
// no other console call exists in js/auth, js/sync or the account screens.

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-])[A-Za-z0-9.-]*(\.[A-Za-z]{2,})/g;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const KEYED = /\b(access_token|refresh_token|provider_token|id_token|code|code_verifier|apikey|authorization|token|secret|password)\b(["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"'&,;}]+/gi;
const LONG = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Masks emails (a…@e….com), JWTs, key=value secrets and any long opaque string. */
export function mask(value) {
  return String(value == null ? '' : value)
    .replace(JWT, '[token]')
    .replace(KEYED, '$1$2[hidden]')
    .replace(EMAIL, '$1…@$2…$3')
    .replace(LONG, '[hidden]')
    .slice(0, 300);
}

/** For the UI and logs: "a…@e….com". */
export function maskEmail(email) {
  const m = mask(email);
  return /@/.test(m) ? m : '';
}

/** A safe one-line description of an error: its kind, status and code, plus a masked short message. */
export function describe(err) {
  if (err == null) return '';
  if (typeof err === 'string') return mask(err).slice(0, 120);
  const bits = [];
  if (err.name && err.name !== 'Error') bits.push(mask(err.name).slice(0, 40));
  if (err.status != null) bits.push('status ' + String(Number(err.status) || 0));
  if (err.code != null) bits.push('code ' + mask(err.code).slice(0, 40));
  if (err.message) bits.push(mask(err.message).slice(0, 120));
  return bits.join(' · ');
}

function emit(level, tag, what, err) {
  try {
    const line = `[flash-notes:${mask(tag).slice(0, 24)}] ${mask(what).slice(0, 160)}${err ? ' — ' + describe(err) : ''}`;
    (console[level] || console.log).call(console, line);
  } catch { /* logging must never throw */ }
}

export const log = {
  info: (tag, what) => emit('info', tag, what),
  warn: (tag, what, err) => emit('warn', tag, what, err),
  error: (tag, what, err) => emit('error', tag, what, err),
};

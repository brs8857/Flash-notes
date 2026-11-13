// Pure rules for accounts (no DOM, no network): who may enter, which identities are trusted, and how
// errors are named. Tested in tests/auth.test.mjs.
import { getProvider } from './providers.js';

/**
 * The route guard. Returns 'app' (show the notes) or 'login'.
 *   configured: a Supabase project is filled in (js/config.js). When it is not, the app is the local-only
 *               v1.2 app and there is nothing to sign in to.
 *   user:       the signed-in user (from the cached session), or null.
 * There is no way to reach 'app' on a configured site without a user: every in-app route goes through here.
 */
export function routeDecision({ configured, user }) {
  if (!configured) return 'app';
  return user && typeof user.id === 'string' && user.id ? 'app' : 'login';
}

/**
 * Is this Supabase user one we trust? Only when it has EXACTLY ONE identity, from an enabled provider, and
 * that provider says the email is verified. An account with a second linked identity is refused, so a
 * future provider can never be merged silently into an existing account through an unverified email.
 * (Supabase's own automatic linking is also left off; the database repeats this check, migration 2.)
 * Returns {ok:true, provider} or {ok:false, reason}.
 */
export function verifyIdentity(user) {
  if (!user || typeof user.id !== 'string' || !user.id) return { ok: false, reason: 'no-user' };
  const identities = Array.isArray(user.identities) ? user.identities : null;
  if (!identities || identities.length === 0) return { ok: false, reason: 'no-identity' };
  if (identities.length !== 1) return { ok: false, reason: 'linked-identities' };
  const ident = identities[0] || {};
  const provider = getProvider(ident.provider);
  if (!provider) return { ok: false, reason: 'provider-not-allowed' };
  const meta = user.app_metadata || {};
  if (meta.provider && meta.provider !== provider.id) return { ok: false, reason: 'provider-mismatch' };
  if (!provider.emailVerified(ident.identity_data)) return { ok: false, reason: 'email-unverified' };
  return { ok: true, provider: provider.id };
}

/** The little the app keeps about the user in memory: id, email, name. No picture, nothing else. */
export function publicUser(user) {
  if (!user || typeof user.id !== 'string') return null;
  const md = user.user_metadata || {};
  const name = [md.full_name, md.name].find(v => typeof v === 'string' && v.trim());
  return {
    id: user.id,
    email: typeof user.email === 'string' ? user.email.slice(0, 320) : '',
    name: name ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '',
  };
}

/**
 * Names the reason a sign-in did not work. Input: what came back on the redirect URL ({error, error_code,
 * error_description}) or a thrown error, plus whether the device is online.
 * → 'offline' | 'cancelled' | 'denied' | 'provider' | 'unverified' | 'expired' | 'rate' | 'unknown'
 */
export function classifyAuthError(input, { online = true } = {}) {
  const e = input || {};
  const code = String(e.error || e.error_code || e.code || '').toLowerCase();
  const sub = String(e.error_code || '').toLowerCase();
  const text = String(e.error_description || e.message || '').toLowerCase();
  const status = Number(e.status) || 0;
  if (code === 'unverified' || /email[- _]unverified|not verified|unverified/.test(code + ' ' + sub)) return 'unverified';
  if (code === 'cancelled') return 'cancelled';
  if (code === 'offline' || !online) return 'offline';
  if (code === 'access_denied' || /access[_ ]denied|consent|user denied/.test(text)) return 'denied';
  if (status === 429 || /rate limit|too many/.test(text + ' ' + code + ' ' + sub)) return 'rate';
  if (/provider_email_needs_verification|email_not_confirmed/.test(sub + ' ' + code)) return 'unverified';
  if (/flow_state|bad_code_verifier|code verifier|invalid_grant|otp_expired|expired/.test(code + ' ' + sub + ' ' + text)) return 'expired';
  if (/failed to fetch|networkerror|network request failed|load failed/.test(text) || e.name === 'AuthRetryableFetchError') return online ? 'provider' : 'offline';
  if (code === 'server_error' || code === 'temporarily_unavailable' || status >= 500 || /unexpected_failure|provider|unavailable/.test(code + ' ' + sub)) return 'provider';
  return 'unknown';
}

// Generic on purpose: nothing from the server's error text is ever shown to the user.
const MESSAGES = Object.freeze({
  offline: 'You’re offline. Connect to the internet to sign in.',
  cancelled: 'Sign-in was cancelled. Try again when you’re ready.',
  denied: 'Google didn’t share your details, so you’re not signed in. Tap the button to try again.',
  provider: 'Google sign-in isn’t available right now. Please try again in a few minutes.',
  unverified: 'That Google account’s email address isn’t verified, so it can’t be used here. Verify it with Google, then try again.',
  expired: 'That sign-in took too long. Please try again.',
  rate: 'Too many tries. Please wait a minute and try again.',
  session: 'Please sign in again to keep your notes backed up.',
  unknown: 'Sign-in didn’t work. Please try again.',
});
export function authMessage(kind) { return MESSAGES[kind] || MESSAGES.unknown; }

/** True when the server refused a request because the session is no longer valid (HTTP 401 and friends). */
export function isAuthFailure(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode) || 0;
  const code = String(err.code || '');
  const text = String(err.message || '').toLowerCase();
  if (status === 401) return true;
  if (code === 'PGRST301' || code === 'PGRST302') return true;
  if (/jwt expired|invalid jwt|jwt.*(invalid|malformed)|invalid claim|session_not_found|refresh_token_not_found|invalid refresh token/.test(text + ' ' + code.toLowerCase())) return true;
  return false;
}

/** Reads the result of the OAuth redirect from a URL. → {code} | {error:{...}} | null. Never throws. */
export function readCallback(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  const q = url.searchParams;
  // The app's own routes live in the hash as "#/..."; an OAuth error may arrive there as "#error=...".
  const hash = url.hash.startsWith('#/') ? new URLSearchParams() : new URLSearchParams(url.hash.replace(/^#/, ''));
  const get = k => q.get(k) || hash.get(k);
  if (get('error') || get('error_code')) {
    return { error: { error: get('error') || '', error_code: get('error_code') || '', error_description: get('error_description') || '' } };
  }
  const code = q.get('code');
  if (code && /^[A-Za-z0-9._~-]{8,512}$/.test(code)) return { code };
  return null;
}

/** The same URL without anything the sign-in redirect added (code, state, error…). */
export function cleanCallbackUrl(href) {
  const url = new URL(href);
  for (const k of ['code', 'state', 'error', 'error_code', 'error_description', 'provider_token', 'provider_refresh_token']) url.searchParams.delete(k);
  const hash = url.hash.startsWith('#/') ? url.hash : '#/';
  const qs = url.searchParams.toString();
  return url.pathname + (qs ? '?' + qs : '') + hash;
}

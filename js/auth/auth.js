// Accounts: session state, sign-in, sign-out. All OAuth work (authorization-code flow with PKCE, state,
// nonce, ID-token checks, token refresh and rotation) is done by supabase-js and the Supabase Auth server;
// nothing here builds or parses tokens.
//
// supabase-js (≈230 kB) is imported lazily: the app starts from the cached session in localStorage, so a
// signed-in user who is offline still gets straight to their notes, and the library is only loaded when
// it is needed (sign-in, token refresh, sync).
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from '../config.js';
import { getProvider } from './providers.js';
import { verifyIdentity, publicUser, classifyAuthError, readCallback, cleanCallbackUrl, isAuthFailure } from './guard.js';
import { log } from '../log.js';

const STORAGE_KEY = 'fln.auth';            // supabase-js keeps the session (and the PKCE verifier) under this key
const PENDING_KEY = 'fln.auth.pending';    // sessionStorage: "the Google page was opened from this tab"

let clientPromise = null;
let user = null;                 // {id, email, name} | null
let lastError = null;            // kind from classifyAuthError, shown once on the login screen
let justSignedIn = false;
let watching = false;
let signingOut = false;
const listeners = new Set();

const online = () => (typeof navigator === 'undefined' || navigator.onLine !== false);
const emit = () => listeners.forEach(fn => { try { fn(user); } catch (err) { log.error('auth', 'listener failed', err); } });

export const authConfigured = () => isConfigured();
export const currentUser = () => user;
export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** The reason the last sign-in failed (or the session ended), once. */
export function takeAuthError() { const e = lastError; lastError = null; return e; }
export function takeJustSignedIn() { const j = justSignedIn; justSignedIn = false; return j; }

function coded(code) { const e = new Error(code); e.code = code; return e; }

/** The session supabase-js saved, read without loading supabase-js. Returns the trusted user or null. */
function peekUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.refresh_token !== 'string' || !s.refresh_token || !s.user) return null;
    return verifyIdentity(s.user).ok ? publicUser(s.user) : null;
  } catch { return null; }
}

function clearStoredSession() {
  try {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(STORAGE_KEY)) drop.push(k); }
    drop.forEach(k => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

/** The Supabase client (loaded on first use). Rejects when the library cannot be loaded. */
export function getClient() {
  if (!isConfigured()) return Promise.reject(coded('not-configured'));
  if (!clientPromise) {
    clientPromise = import('../../vendor/supabase-js.js').then(mod => mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        flowType: 'pkce',              // authorization code + PKCE; never the implicit flow
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,     // the redirect is handled explicitly in initAuth()
      },
    })).catch(err => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

function appUrl() { return location.origin + location.pathname; }

/**
 * Call once at boot, before routing. Finishes a sign-in redirect if there is one, otherwise restores the
 * cached session. Resolves to the user or null; never throws.
 */
export async function initAuth() {
  if (!isConfigured()) { user = null; return null; }
  let pending = false;
  try { pending = sessionStorage.getItem(PENDING_KEY) === '1'; sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  const cb = readCallback(location.href);
  // Take the one-time code (or the error) out of the address bar and history before anything else runs.
  if (cb) { try { history.replaceState(null, '', cleanCallbackUrl(location.href)); } catch { /* ignore */ } }

  if (cb && cb.error) {
    lastError = classifyAuthError(cb.error, { online: online() });
    user = peekUser();
  } else if (cb && cb.code) {
    try {
      const client = await getClient();
      const { data, error } = await client.auth.exchangeCodeForSession(cb.code);
      if (error) throw error;
      const u = (data && (data.user || (data.session && data.session.user))) || null;
      const v = verifyIdentity(u);
      if (!v.ok) {
        log.warn('auth', 'sign-in refused: ' + v.reason);
        await signOut();
        lastError = 'unverified';
      } else {
        user = publicUser(u);
        justSignedIn = true;
      }
    } catch (err) {
      log.warn('auth', 'sign-in could not be completed', err);
      lastError = classifyAuthError(err, { online: online() });
      user = peekUser();
    }
  } else {
    user = peekUser();
    if (!user && pending) lastError = 'cancelled';   // came back from Google without a result
  }
  return user;
}

/**
 * After the app is on screen: load supabase-js in the background, let it refresh the token, and follow
 * session changes (expiry, sign-out in another tab). Safe to call more than once. Never throws.
 */
export async function watchSession() {
  if (!isConfigured() || watching) return;
  watching = true;
  try {
    const client = await getClient();
    client.auth.onAuthStateChange((event, session) => {
      // Never call back into supabase-js from inside this callback (it holds a lock): defer.
      setTimeout(() => {
        if (event === 'SIGNED_OUT') { if (user && !signingOut) sessionEnded(); return; }
        const u = session && session.user;
        if (!u) return;
        if (!verifyIdentity(u).ok) { log.warn('auth', 'session no longer trusted'); signOut().then(() => { lastError = 'unverified'; emit(); }); return; }
        const next = publicUser(u);
        if (user && next.id !== user.id) { location.reload(); return; }   // another account signed in from another tab
        const changed = !user;
        user = next;
        if (changed) emit();
      }, 0);
    });
    const { data, error } = await client.auth.getSession();
    if (error) { if (isAuthFailure(error)) sessionEnded(); return; }
    if (!data || !data.session) { if (user) sessionEnded(); }
  } catch (err) {
    watching = false;
    log.warn('auth', 'could not start the session watcher (offline?)', err);
  }
}

/** The session is no longer valid (refresh token revoked or expired). Notes stay on the device. */
function sessionEnded() {
  if (!user) return;
  user = null;
  lastError = 'session';
  clearStoredSession();
  emit();
}

/**
 * Called when the server answered 401. Tries one token refresh. → true when the request can be retried,
 * false when the user has to sign in again (the login screen is shown; nothing local is deleted).
 */
export async function handleAuthFailure() {
  try {
    const client = await getClient();
    const { data, error } = await client.auth.refreshSession();
    if (!error && data && data.session) return true;
    if (error && !isAuthFailure(error) && classifyAuthError(error, { online: online() }) !== 'unknown') return false;   // network trouble: keep the session, try later
    sessionEnded();
    return false;
  } catch (err) {
    log.warn('auth', 'token refresh failed', err);
    return false;
  }
}

/** Starts the Google sign-in. On success the browser leaves the page; it throws a coded error otherwise. */
export async function signIn(providerId) {
  const provider = getProvider(providerId);
  if (!provider) throw coded('unknown');
  if (!online()) throw coded('offline');
  let client;
  try { client = await getClient(); } catch (err) { throw coded(online() ? 'provider' : 'offline'); }
  try { sessionStorage.setItem(PENDING_KEY, '1'); } catch { /* ignore */ }
  const { error } = await client.auth.signInWithOAuth({
    provider: provider.id,
    options: { redirectTo: appUrl(), scopes: provider.scopes, queryParams: { ...provider.queryParams } },
  });
  if (error) {
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
    log.warn('auth', 'could not start sign-in', error);
    throw coded(classifyAuthError(error, { online: online() }));
  }
}

/**
 * Ends the session on this device: revokes it with Supabase when online, and always removes the stored
 * tokens, even offline. (Deleting the notes cached on the device is done by js/account.js.)
 */
export async function signOut() {
  signingOut = true;
  try {
    if (clientPromise || online()) {
      const client = await getClient();
      await client.auth.signOut({ scope: 'local' });
    }
  } catch (err) {
    log.warn('auth', 'server sign-out failed; clearing the session on this device anyway', err);
  }
  clearStoredSession();
  const had = !!user;
  user = null;
  signingOut = false;
  if (had) emit();
}

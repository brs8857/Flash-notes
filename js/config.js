// Flash Notes — backend settings. THE OWNER FILLS IN THE TWO VALUES BELOW (see SETUP.md, step 6).
//
// Both values are PUBLIC BY DESIGN. Every visitor's browser has to know them to talk to Supabase, exactly
// like the address of the site itself. They give no access to anyone's notes: the database only hands
// rows to the signed-in user who owns them (row level security, supabase/migrations).
//
// NEVER put the `service_role` key (or any "secret" key) in this file or anywhere else in this repository.
// That key bypasses every protection. It belongs only in the Edge Function's secrets on Supabase.
//
// While the placeholders are still here the app runs exactly as before: no sign-in, notes stay on the device.

// ▼▼▼ FILL IN ▼▼▼
export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
// ▲▲▲ FILL IN ▲▲▲

function jwtRole(key) {
  try {
    const part = String(key).split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json).role || null;
  } catch { return null; }
}

/** Why a config is unusable, or null when it is fine. Pure, so tests can call it with any values. */
export function configProblem(url = SUPABASE_URL, key = SUPABASE_ANON_KEY) {
  if (typeof url !== 'string' || typeof key !== 'string') return 'missing';
  if (/YOUR-/i.test(url) || /YOUR-/i.test(key) || !url || !key) return 'placeholder';
  let u;
  try { u = new URL(url); } catch { return 'bad-url'; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) return 'bad-url';
  // A secret key in a public file would be a disaster: refuse to start with one.
  if (/^sb_secret_/i.test(key) || jwtRole(key) === 'service_role') return 'secret-key';
  return null;
}

/** True when a real Supabase project has been filled in. False = local-only mode (the v1.2 behaviour). */
export function isConfigured() {
  return configProblem() === null;
}

// Sign-in providers. Only Google is offered. The rest of the app talks to this table and never to a
// provider by name, so adding another provider later means: one entry here (with its own `verify`), its
// official button in js/ui/login.js, one value in the `profiles.provider` check (a new migration), and the
// provider switched on in the Supabase dashboard. See SPEC "Auth & sync v2.0".

/** True only when the provider itself says the email address has been verified. */
const flagTrue = v => v === true || v === 'true';

export const PROVIDERS = Object.freeze({
  google: Object.freeze({
    id: 'google',
    label: 'Sign in with Google',
    // The least Google offers for sign-in: who you are (openid), your email, your name. Nothing else: no
    // contacts, no Drive, no calendar, and no offline access to the Google account.
    scopes: 'openid email profile',
    queryParams: Object.freeze({ prompt: 'select_account' }),
    /** identityData = the claims Supabase stored from Google's verified ID token. */
    emailVerified: identityData => !!identityData && flagTrue(identityData.email_verified) && typeof identityData.email === 'string' && identityData.email.includes('@'),
  }),
});

export const ENABLED_PROVIDERS = Object.freeze(['google']);

export function getProvider(id) {
  return ENABLED_PROVIDERS.includes(id) ? PROVIDERS[id] : null;
}

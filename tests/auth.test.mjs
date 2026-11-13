// Accounts: the route guard, which identities are trusted (email verification), error naming, 401
// detection, the masking logger, config safety, and static checks on the shipped files. Pure Node.
//   node tests/auth.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, done } from './lib/check.mjs';
import { routeDecision, verifyIdentity, publicUser, classifyAuthError, authMessage, isAuthFailure, readCallback, cleanCallbackUrl } from '../js/auth/guard.js';
import { PROVIDERS, ENABLED_PROVIDERS, getProvider } from '../js/auth/providers.js';
import { configProblem, isConfigured } from '../js/config.js';
import { mask, maskEmail, describe } from '../js/log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name]));

// ---------------------------------------------------------------- route guard
const U = { id: '11111111-1111-4111-8111-111111111111', email: 'a@example.com' };
eq(routeDecision({ configured: true, user: null }), 'login', 'unauthenticated → login');
eq(routeDecision({ configured: true, user: undefined }), 'login', 'no user object → login');
eq(routeDecision({ configured: true, user: {} }), 'login', 'a user without an id → login');
eq(routeDecision({ configured: true, user: { id: '' } }), 'login', 'an empty id → login');
eq(routeDecision({ configured: true, user: { id: 42 } }), 'login', 'a non-string id → login');
eq(routeDecision({ configured: true, user: U }), 'app', 'signed in → the app');
eq(routeDecision({ configured: false, user: null }), 'app', 'no backend configured → the local-only app (nothing to sign in to)');
{
  const app = read('js/app.js');
  ok(/async function doRoute\(\) \{\s*if \(!\(await guard\(\)\)\) return;/.test(app), 'every route goes through the guard before anything is mounted');
  ok(/routeDecision\(\{ configured: authConfigured\(\), user: currentUser\(\) \}\) === 'login'/.test(app), 'the guard uses the tested decision');
  ok(!/mountLibrary|mountEditor/.test(app.slice(app.indexOf('async function guard()'), app.indexOf('async function doRoute()'))), 'the guard itself never mounts a notes screen');
}

// ---------------------------------------------------------------- email-verification guard
const gUser = (over = {}, ident = {}) => ({
  id: U.id, email: 'a@example.com', app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { full_name: 'Ada L', email_verified: true, avatar_url: 'https://example.invalid/a.png', picture: 'https://example.invalid/a.png' },
  identities: [{ provider: 'google', identity_data: { email: 'a@example.com', email_verified: true, sub: '1234567890', ...ident } }], ...over,
});
eq(verifyIdentity(gUser()), { ok: true, provider: 'google' }, 'Google account with a verified email is trusted');
eq(verifyIdentity(gUser({}, { email_verified: false })).reason, 'email-unverified', 'email_verified false → refused');
eq(verifyIdentity(gUser({}, { email_verified: undefined })).reason, 'email-unverified', 'email_verified missing → refused');
eq(verifyIdentity(gUser({}, { email_verified: 'yes' })).reason, 'email-unverified', 'email_verified must be exactly true');
eq(verifyIdentity(gUser({}, { email_verified: 1 })).reason, 'email-unverified', 'a truthy number is not enough');
eq(verifyIdentity(gUser({}, { email: '' })).reason, 'email-unverified', 'no email → refused');
eq(verifyIdentity(gUser({ user_metadata: { email_verified: true }, identities: [{ provider: 'google', identity_data: { email: 'a@example.com', email_verified: false } }] })).reason, 'email-unverified', 'user-editable metadata cannot override what Google said');
eq(verifyIdentity(gUser({ identities: [] })).reason, 'no-identity', 'no identity → refused');
eq(verifyIdentity(gUser({ identities: undefined })).reason, 'no-identity', 'identities missing → refused (fails closed)');
eq(verifyIdentity(gUser({ identities: [{ provider: 'google', identity_data: { email: 'a@example.com', email_verified: true } }, { provider: 'github', identity_data: { email: 'a@example.com', email_verified: false } }] })).reason, 'linked-identities', 'a second linked identity → refused, even next to a verified Google one');
eq(verifyIdentity(gUser({ identities: [{ provider: 'email', identity_data: { email: 'a@example.com', email_verified: true } }] })).reason, 'provider-not-allowed', 'an email/password identity → refused');
eq(verifyIdentity(gUser({ identities: [{ provider: 'github', identity_data: { email: 'a@example.com', email_verified: true } }] })).reason, 'provider-not-allowed', 'a provider that is not enabled → refused');
eq(verifyIdentity(gUser({ app_metadata: { provider: 'email' } })).reason, 'provider-mismatch', 'account created by another method → refused');
eq(verifyIdentity(null).reason, 'no-user', 'no user → refused');
eq(verifyIdentity({ identities: [] }).reason, 'no-user', 'no id → refused');
eq(ENABLED_PROVIDERS, ['google'], 'Google is the only enabled provider');
eq(Object.keys(PROVIDERS), ['google'], 'and the only one defined');
eq(PROVIDERS.google.scopes, 'openid email profile', 'scopes are exactly openid, email, profile');
eq([getProvider('google').id, getProvider('email'), getProvider('__proto__'), getProvider('constructor')], ['google', null, null, null], 'unknown providers cannot be looked up');
eq(publicUser(gUser()), { id: U.id, email: 'a@example.com', name: 'Ada L' }, 'the app keeps only id, email and name in memory (no picture)');
eq(publicUser(gUser({ user_metadata: { full_name: 'A\u0000B\n' + 'x'.repeat(200) } })).name.length, 80, 'names are cleaned and limited');

// ---------------------------------------------------------------- sign-in errors: named, generic wording
eq(classifyAuthError({ error: 'access_denied', error_description: 'User denied access' }), 'denied', 'denied consent');
eq(classifyAuthError({ error: 'server_error', error_code: 'unexpected_failure', error_description: 'Unable to exchange external code' }), 'provider', 'provider failure');
eq(classifyAuthError({ error: 'temporarily_unavailable' }), 'provider', 'provider temporarily unavailable');
eq(classifyAuthError({ status: 503, message: 'Service Unavailable' }), 'provider', 'HTTP 503');
eq(classifyAuthError({ message: 'Failed to fetch' }, { online: false }), 'offline', 'fetch failure while offline');
eq(classifyAuthError({ message: 'Failed to fetch' }, { online: true }), 'provider', 'fetch failure while online');
eq(classifyAuthError({ code: 'offline' }), 'offline', 'offline');
eq(classifyAuthError({ code: 'cancelled' }), 'cancelled', 'cancelled');
eq(classifyAuthError({ status: 429, message: 'rate limit exceeded' }), 'rate', 'rate limited');
eq(classifyAuthError({ error_code: 'flow_state_not_found', message: 'invalid flow state' }), 'expired', 'stale PKCE state');
eq(classifyAuthError({ error: 'access_denied', error_code: 'provider_email_needs_verification' }), 'denied', 'access_denied always reads as denied');
eq(classifyAuthError({ error_code: 'provider_email_needs_verification' }), 'unverified', 'unverified provider email');
eq(classifyAuthError({ message: 'weird' }), 'unknown', 'anything else');
eq(classifyAuthError(null), 'unknown', 'nothing');
for (const k of ['offline', 'cancelled', 'denied', 'provider', 'unverified', 'expired', 'rate', 'session', 'unknown']) ok(authMessage(k).length > 20 && !/supabase|postgres|jwt|token|sql|stack|undefined/i.test(authMessage(k)), `message for “${k}” is plain and reveals nothing technical`);
eq(authMessage('<script>'), authMessage('unknown'), 'an unexpected kind falls back to the generic message');

// ---------------------------------------------------------------- 401 handling
ok(isAuthFailure({ status: 401 }), 'HTTP 401 is an auth failure');
ok(isAuthFailure({ code: 'PGRST301', message: 'JWT expired' }), 'PostgREST “JWT expired” is an auth failure');
ok(isAuthFailure({ message: 'invalid JWT: unable to parse' }), 'invalid JWT is an auth failure');
ok(isAuthFailure({ status: 400, message: 'Invalid Refresh Token: Refresh Token Not Found', code: 'refresh_token_not_found' }), 'a rejected refresh token is an auth failure');
ok(!isAuthFailure({ status: 403, code: '42501', message: 'new row violates row-level security policy' }), 'an RLS refusal (403) is NOT treated as “signed out”');
ok(!isAuthFailure({ status: 500 }) && !isAuthFailure({ message: 'Failed to fetch' }) && !isAuthFailure(null), 'server and network errors are not auth failures');
{
  const sync = read('js/sync/sync.js'), auth = read('js/auth/auth.js');
  ok(/if \(isAuthFailure\(err\)\) \{\s*const retry = await handleAuthFailure\(\);/.test(sync), 'the sync loop hands a 401 to handleAuthFailure');
  ok(/refreshSession\(\)/.test(auth) && /sessionEnded\(\);\s*return false;/.test(auth), 'handleAuthFailure tries one refresh, then ends the session (→ login)');
  ok(!/wipeUserData/.test(auth), 'an expired session never deletes notes from the device');
}

// ---------------------------------------------------------------- redirect handling
eq(readCallback('https://x.test/Flash-notes/?code=abc12345-def'), { code: 'abc12345-def' }, 'reads the authorization code');
eq(readCallback('https://x.test/Flash-notes/?error=access_denied&error_description=nope#/'), { error: { error: 'access_denied', error_code: '', error_description: 'nope' } }, 'reads an error from the query');
eq(readCallback('https://x.test/Flash-notes/#error=server_error&error_code=unexpected_failure').error.error, 'server_error', 'reads an error from the hash');
eq(readCallback('https://x.test/Flash-notes/#/nb/abc/2'), null, 'an app route is not a callback');
eq(readCallback('https://x.test/Flash-notes/?code=<script>'), null, 'a malformed code is ignored');
eq(readCallback('nonsense'), null, 'garbage is ignored');
eq(cleanCallbackUrl('https://x.test/Flash-notes/?code=abc12345&state=zz&keep=1#/nb/a/1'), '/Flash-notes/?keep=1#/nb/a/1', 'the code and state are removed from the URL, the route is kept');
eq(cleanCallbackUrl('https://x.test/Flash-notes/?error=x&error_description=y#error=x'), '/Flash-notes/#/', 'errors are removed from the URL');

// ---------------------------------------------------------------- config safety
eq(configProblem(), 'placeholder', 'the shipped config has placeholders');
eq(isConfigured(), false, 'so the shipped app is in local-only mode until the owner fills it in');
eq(configProblem('https://abcdefghijkl.supabase.co', 'sb_publishable_abc123'), null, 'a project URL + publishable key is accepted');
const jwt = role => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url') + '.sig';
eq(configProblem('https://abcdefghijkl.supabase.co', jwt('anon')), null, 'a legacy anon key is accepted');
eq(configProblem('https://abcdefghijkl.supabase.co', jwt('service_role')), 'secret-key', 'a service_role key is REFUSED');
eq(configProblem('https://abcdefghijkl.supabase.co', 'sb_secret_abc123'), 'secret-key', 'a secret key is REFUSED');
eq(configProblem('http://abcdefghijkl.supabase.co', jwt('anon')), 'bad-url', 'plain http is refused');
eq(configProblem('not a url', jwt('anon')), 'bad-url', 'a bad URL is refused');

// ---------------------------------------------------------------- masking logger
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
ok(!mask(`Bearer ${TOKEN}`).includes('eyJ'), 'JWTs are masked');
eq(mask('contact alice.student@example.com now'), 'contact a…@e….com now', 'emails are masked');
eq(maskEmail('bob@school.org.uk'), 'b…@s….uk', 'maskEmail keeps one letter and the ending');
ok(!/s3cr3t|abc123XYZ/.test(mask('refresh_token=abc123XYZ&code=s3cr3t-code access_token: "zzz999"')), 'key=value secrets are masked');
ok(!mask('id 0123456789abcdef0123456789abcdef0123456789abcdef').includes('0123456789abcdef0123'), 'long opaque strings are masked');
ok(mask('x'.repeat(5000)).length <= 300, 'log lines are capped');
{
  const e = Object.assign(new Error(`JWT ${TOKEN} for alice.student@example.com rejected`), { status: 401, code: 'PGRST301' });
  const d = describe(e);
  ok(/status 401/.test(d) && /PGRST301/.test(d) && !d.includes('eyJ') && !d.includes('alice.student'), 'describe(err) keeps status and code, never the token or the email');
  ok(!describe({ message: 'note text: my secret diary', data: { items: ['x'] } }).includes('items'), 'describe never prints attached data');
}

// ---------------------------------------------------------------- static checks on what ships
{
  const accountFiles = [...walk('js/auth'), ...walk('js/sync'), 'js/account.js', 'js/config.js', 'js/export-md.js', 'js/ui/login.js', 'js/ui/account.js'];
  for (const f of accountFiles) ok(!/console\.(log|info|warn|error|debug|trace|dir|table)/.test(read(f)), `${f} never writes to the console directly (only through the masking logger)`);
  const logCalls = accountFiles.flatMap(f => [...read(f).matchAll(/log\.(?:info|warn|error)\(([^\n]*)/g)].map(m => `${f}: ${m[1]}`));
  ok(logCalls.length > 5 && !logCalls.some(c => /token|session\b|\.email|user\b[^.]|items|title|text|row\b|data\b/i.test(c.split(':').slice(1).join(':').replace(/'[^']*'/g, ''))), 'no log call is given a token, session, email, user or note content');
  const shipped = ['index.html', 'privacy.html', 'sw.js', ...walk('js'), ...walk('css')].filter(f => !/files\.json$/.test(f));
  for (const f of shipped) {
    const src = read(f);
    if (/tests\/harness|fake-supabase|fake-backend|__fake/.test(src)) ok(false, `${f} must not refer to the test harness`);
    if (/service_role\s*[:=]|sb_secret_[A-Za-z0-9]{6,}|SUPABASE_SERVICE_ROLE_KEY\s*=/.test(src) && f !== 'js/config.js') ok(false, `${f} must not contain a service-role key`);
  }
  ok(true, 'no shipped file refers to the test harness or holds a secret key');
  ok(!/harness|fake/.test(read('sw.js')) && !/tests\//.test(read('sw.js')), 'the service worker precaches nothing from tests/');
  ok(!new URL('http://x/?' + 'fake=1&test=1').searchParams.has('x') && !/searchParams\.get\(['"](?:test|fake|mock|debug|auth)['"]\)/.test(shipped.map(read).join('\n')), 'no URL parameter switches anything on');
  const authCode = ['js/auth/auth.js', 'js/auth/guard.js', 'js/auth/providers.js', 'js/ui/login.js', 'js/config.js'].map(read).join('\n');
  ok(!/apple/i.test(authCode) && !/signInWithPassword|signUp\(|signInWithOtp|password/i.test(authCode.replace(/password\)\\b/g, '')), 'no Apple and no password sign-in code exists');
  ok(/flowType: 'pkce'/.test(read('js/auth/auth.js')) && !/implicit'/.test(read('js/auth/auth.js')), 'supabase-js is set to the PKCE flow');
  ok(/import\('\.\.\/\.\.\/vendor\/supabase-js\.js'\)/.test(read('js/auth/auth.js')) && !shipped.some(f => /from ['"][^'"]*supabase-js\.js['"]/.test(read(f))), 'supabase-js is only ever loaded lazily (dynamic import)');

  // CSP + no inline code
  const html = read('index.html');
  const csp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html) || [])[1] || '';
  const dir = name => (csp.split(';').map(s => s.trim()).find(s => s.startsWith(name + ' ')) || '').split(/\s+/).slice(1);
  eq(dir('default-src'), ["'none'"], 'CSP: default-src none');
  eq(dir('script-src'), ["'self'"], 'CSP: scripts only from this site (no inline, no eval, no CDN)');
  eq(dir('style-src'), ["'self'"], 'CSP: styles only from this site (no inline)');
  ok(dir('connect-src').length === 2 && dir('connect-src')[0] === "'self'" && /^https:\/\/[A-Za-z0-9-]+\.supabase\.co$/.test(dir('connect-src')[1]), 'CSP: the app may only talk to itself and the Supabase project');
  eq([dir('object-src'), dir('base-uri'), dir('form-action')], [["'none'"], ["'none'"], ["'none'"]], 'CSP: no plugins, no <base>, no form posts');
  ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), 'CSP has no unsafe-inline, unsafe-eval or wildcard');
  ok(/<meta name="referrer" content="no-referrer">/.test(html), 'a referrer policy is set');
  ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\son[a-z]+\s*=/.test(html) && !/style="/.test(html), 'index.html has no inline script, event handler or style');
  ok(!/<script/.test(read('privacy.html')) && /Content-Security-Policy/.test(read('privacy.html')), 'the privacy page runs no script at all and has its own CSP');
  ok(!/google-analytics|googletagmanager|gtag\(|plausible\.io|segment\.com|mixpanel|hotjar|sentry|doubleclick|facebook\.net|fonts\.googleapis/i.test(shipped.filter(f => f !== 'vendor/supabase-js.js').map(read).join('\n')), 'no analytics, trackers or third-party hosts in the app');
  const headers = read('_headers');
  ok(/frame-ancestors 'none'/.test(headers) && /Strict-Transport-Security: max-age=\d{8}/.test(headers) && /X-Content-Type-Options: nosniff/.test(headers) && /Referrer-Policy: no-referrer/.test(headers), '_headers has CSP with frame-ancestors, HSTS, nosniff and a referrer policy');
  const hcsp = (/Content-Security-Policy: (.+)/.exec(headers) || [])[1] || '';
  ok(csp.split(';').every(d => hcsp.includes(d.trim())), '_headers carries the same policy as index.html (plus frame-ancestors)');
  ok(/^\.env$/m.test(read('.gitignore')) && /node_modules/.test(read('.gitignore')) && !/eyJ|sb_secret_[A-Za-z0-9]/.test(read('.env.example')), '.gitignore covers .env and node_modules; .env.example holds no real key');
  // every precached file exists, and every new app file is precached
  const sw = read('sw.js');
  const pre = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  ok(pre.every(f => fs.existsSync(path.join(root, f))), 'every file the service worker precaches exists');
  const need = [...walk('js/auth'), ...walk('js/sync'), 'js/account.js', 'js/config.js', 'js/log.js', 'js/export-md.js', 'js/theme-boot.js', 'js/ui/login.js', 'js/ui/account.js', 'vendor/supabase-js.js', 'privacy.html', 'css/legal.css', 'icons/google-g.svg'];
  eq(need.filter(f => !pre.includes(f)), [], 'every new file is precached (the app still starts offline)');
  ok(/const VERSION = 'v6'/.test(sw), 'the service worker version was bumped');
}

done('auth');

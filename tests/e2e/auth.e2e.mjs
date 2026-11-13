// Browser tests for accounts, with a fake Supabase (tests/harness). Chrome via Playwright.
//   cd tests && npm install && node e2e/auth.e2e.mjs [port]
// Covers: route guard, the login screen and its error states, sign in → create → sign out → sign in again,
// account isolation, first-sign-in upload, offline start, expired session (401), account conflict,
// account deletion, XSS, and that the page's Content-Security-Policy is never violated.
// NOT covered (cannot be, here): real Google OAuth, a real Supabase project, the deployed Edge Function, Safari.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { startServer } from '../harness/serve.mjs';

const PORT = Number(process.argv[2]) || 8790;
const SHOTS = process.env.FLN_SHOTS || '';
const srv = await startServer(PORT);
const { backend, state } = srv;
const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const browser = await chromium.launch({ executablePath: exe });

let passed = 0; const failures = [];
const ok = (cond, name) => { if (cond) { passed++; console.log('ok  ', name); } else { failures.push(name); console.log('FAIL', name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`}`);
const step = async (name, fn) => { try { await fn(); } catch (e) { failures.push(name); console.log('FAIL', name, '\n    ', String(e.message).split('\n').slice(0, 3).join('\n     ')); } };

async function device({ dark = false, sw = false, width = 1024, height = 768 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: true, colorScheme: dark ? 'dark' : 'light', serviceWorkers: sw ? 'allow' : 'block', acceptDownloads: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  return { ctx, page, logs };
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
const loginAs = async (page, who) => {
  state.nextLogin = who;
  await page.waitForSelector('.gsi-btn:not([disabled])');
  await page.click('.gsi-btn');
};
const signIn = async (page, who) => { await loginAs(page, who); await page.waitForSelector('.lib', { timeout: 8000 }); };
const errorText = page => page.textContent('.login-error');
const idbCounts = page => page.evaluate(async () => {
  // never create the database by looking at it
  if (!(await indexedDB.databases()).some(d => d.name === 'flash-notes')) return { docs: 0, pages: 0, thumbs: 0, queue: 0, sync: 0 };
  const db = await new Promise((res, rej) => { const r = indexedDB.open('flash-notes'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const count = s => new Promise(res => { if (!db.objectStoreNames.contains(s)) return res(0); const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); });
  const keys = await new Promise(res => { if (!db.objectStoreNames.contains('meta')) return res([]); const r = db.transaction('meta').objectStore('meta').getAllKeys(); r.onsuccess = () => res(r.result); });
  const out = { docs: await count('docs'), pages: await count('pages'), thumbs: await count('thumbs'), queue: keys.filter(k => String(k).startsWith('sync:d:')).length, sync: keys.filter(k => /^(sync:|backup:)/.test(String(k))).length };
  db.close();
  return out;
});
const waitSynced = async (page, uid, pred, what) => {
  for (let i = 0; i < 80; i++) { if (pred(backend.count(uid))) return true; await page.waitForTimeout(250); }
  throw new Error('sync did not finish: ' + what + ' ' + JSON.stringify(backend.count(uid)));
};
const makeNotebook = async (page, title) => {
  await page.click(await page.$('.empty .btn--primary') ? '.empty .btn--primary' : '.lib-add');
  await page.waitForSelector('.sheet--cover');
  await page.fill('.sheet--cover .field', title);
  await page.click('.sheet-btn--done');
  await page.waitForSelector('.editor', { timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector('.open-fx') && !document.querySelector('.lib'));
};
const drawStroke = async (page, y = 300) => {
  await page.mouse.move(300, y); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(300 + i * 22, y + Math.sin(i / 2) * 30);
  await page.mouse.up();
  await page.waitForFunction(() => /Saved/.test((document.querySelector('.ed-status') || {}).textContent || ''), null, { timeout: 5000 });
};
const backToLibrary = async page => { await page.evaluate(() => { location.hash = '#/'; }); await page.waitForSelector('.lib'); };
const openSettings = async page => { await page.click('.lib-gear'); await page.waitForSelector('.settings'); };
const signOutViaUi = async page => {
  await openSettings(page);
  await page.click('.row--button:has-text("Sign out")');
  await page.waitForSelector('.alert');
  await page.click('.alert-btn--danger');
  await page.waitForSelector('.login', { timeout: 8000 });
};

const ALICE = { email: 'alice.student@example.com', name: 'Alice <img src=x onerror="window.__xss=1">' };
const BOB = { email: 'bob.student@example.com', name: 'Bob' };

// ================================================================= 1. guard + login screen
const d1 = await device();
const p = d1.page;
await step('guard + login screen', async () => {
  await p.goto(srv.url);
  await p.waitForSelector('.login');
  ok(!(await p.$('.lib')) && !(await p.$('.editor')), 'unauthenticated: the login screen is shown instead of the notes');
  await p.goto(srv.url + '#/nb/11111111-2222-3333-4444-555555555555/0');
  await p.waitForSelector('.login');
  ok(!(await p.$('.editor')), 'unauthenticated deep link to a notebook → login');
  eq(await p.$$eval('.login button.gsi-btn', els => els.length), 1, 'exactly one sign-in button');
  eq((await p.textContent('.gsi-btn')).trim(), 'Sign in with Google', 'the button says “Sign in with Google”');
  const look = await p.$eval('.gsi-btn', el => { const c = getComputedStyle(el); const img = el.querySelector('img'); return { bg: c.backgroundColor, border: c.borderTopColor, color: c.color, h: el.offsetHeight, logo: img.naturalWidth, src: img.getAttribute('src') }; });
  eq([look.bg, look.border, look.color], ['rgb(255, 255, 255)', 'rgb(116, 119, 117)', 'rgb(31, 31, 31)'], 'light theme: Google’s white / #747775 / #1F1F1F');
  ok(look.logo > 0 && look.src === './icons/google-g.svg' && look.h >= 40, 'the Google “G” logo is shown and the button is at least 40 px tall');
  ok(/Privacy policy/.test(await p.textContent('.login-privacy')) && (await p.getAttribute('.login-privacy a', 'href')) === './privacy.html', 'a privacy notice links to the privacy page');
  ok(!/apple|password/i.test(await p.textContent('.login')), 'no other sign-in method is offered');
  await shot(p, 'login-light');
  await p.click('.login-privacy a');
  await p.waitForSelector('.legal h1');
  ok(/privacy/i.test(await p.textContent('h1')) && (await p.$$('.fill')).length >= 8, 'the privacy page is public (no sign-in) and shows its [FILL IN] markers');
  await shot(p, 'privacy');
  await p.goBack(); await p.waitForSelector('.login');
});

await step('login error states', async () => {
  await loginAs(p, { error: 'access_denied' }); await p.waitForSelector('.login-error:not([hidden])');
  ok(/Google didn’t share/.test(await errorText(p)), 'denied consent → a clear message');
  ok(!/secret-host|<b>|odd/.test(await p.textContent('.login')), 'the server’s own error text is never shown');
  ok(!/error=|code=/.test(p.url()), 'the error is removed from the address bar');
  await shot(p, 'login-error-denied');
  await loginAs(p, { error: 'server_error' }); await p.waitForSelector('.login-error:not([hidden])');
  ok(/isn’t available right now/.test(await errorText(p)), 'provider error → “not available right now”');
  await loginAs(p, { down: true }); await p.waitForSelector('.login-error:not([hidden])');
  ok(/isn’t available right now/.test(await errorText(p)) && !(await p.isDisabled('.gsi-btn')), 'provider down (503) → message, and the button works again');
  await loginAs(p, { cancel: true }); await p.waitForSelector('.login-error:not([hidden])');
  ok(/cancelled/.test(await errorText(p)), 'coming back without signing in → “cancelled”');
  await d1.ctx.setOffline(true);
  await p.click('.gsi-btn'); await p.waitForSelector('.login-error[data-kind="offline"]');
  ok(/offline/i.test(await errorText(p)) && (await p.isVisible('.login-offline')), 'offline → an offline message');
  await d1.ctx.setOffline(false);
  await loginAs(p, { email: 'unverified@example.com', name: 'U', verified: false }); await p.waitForSelector('.login-error[data-kind="unverified"]');
  ok(/isn’t verified/.test(await errorText(p)) && !(await p.$('.lib')), 'a Google account with an unverified email is refused');
  eq(await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('fln.auth')).length), 0, 'and no session is kept for it');
  await loginAs(p, { email: 'linked@example.com', name: 'L', linked: true }); await p.waitForSelector('.login-error[data-kind="unverified"]');
  ok(!(await p.$('.lib')), 'an account with a second linked identity is refused');
  // loading state
  state.nextLogin = ALICE;
  await p.route('**/__fake/authorize', async r => { await new Promise(res => setTimeout(res, 600)); r.continue(); });
  await p.click('.gsi-btn');
  await p.waitForSelector('.gsi-btn.is-loading[disabled]');
  ok(/Signing in/.test(await p.textContent('.gsi-btn')) && /Opening Google/.test(await p.textContent('.login-status')), 'loading state: button disabled, spinner, “Opening Google…”');
  await shot(p, 'login-loading');
  await p.waitForSelector('.lib', { timeout: 8000 });
  await p.unroute('**/__fake/authorize');
});

// ================================================================= 2. sign in → create → sign out → sign in
let aliceId, nbTitle = 'Economics <script>window.__xss=2</script>';
await step('sign in as A, create a note, it reaches the account', async () => {
  const call = state.authorizeCalls.at(-1);
  eq([call.provider, call.scopes], ['google', 'openid email profile'], 'sign-in asks Google for openid, email and profile only');
  ok(/^c:v-/.test(call.code_challenge) && /\/flash-notes\/$/.test(call.redirect_to), 'the PKCE flow is used and the redirect returns to the app');
  ok(!/code=/.test(p.url()) && /#\/$/.test(p.url()), 'the one-time code is removed from the address bar');
  aliceId = [...backend.users.values()].find(u => u.email === ALICE.email).id;
  await p.waitForSelector('.empty');
  await makeNotebook(p, nbTitle);
  await drawStroke(p);
  await backToLibrary(p);
  await waitSynced(p, aliceId, c => c.liveDocs === 1 && c.livePages === 1, 'notebook + page');
  ok(true, 'the notebook and its page are saved to A’s account in the background');
  const row = [...backend.tables.page.values()].find(r => r.owner === aliceId);
  ok(row.data.items.length === 1 && row.data.items[0].type === 'stroke', 'the stroke is in the account');
  ok((await p.textContent('.lib')).includes('Economics <script>'), 'a title with markup is shown as plain text');
  await openSettings(p);
  const acct = await p.textContent('.settings');
  ok(acct.includes(ALICE.email) && acct.includes('Alice <img src=x'), 'Settings shows the signed-in account (name as plain text)');
  ok(/Sign out/.test(acct) && /Download my notes/.test(acct) && /Export as Markdown/.test(acct) && /Delete my account/.test(acct), 'Settings offers sign out, export (JSON + Markdown) and delete account');
  ok(/can’t be written as Markdown/.test(acct), 'the UI says handwriting cannot be exported as Markdown');
  await shot(p, 'settings-account');
  eq(await p.evaluate(() => [window.__xss === undefined, document.querySelectorAll('.settings img[src="x"], .lib script').length]), [true, 0], 'no injected markup ran or was created');
  // Markdown export produces a file
  await p.click('.row--button:has-text("Export as Markdown")');
  await p.waitForSelector('.export-actions button', { timeout: 6000 });
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.export-actions button')]);
  const md = fs.readFileSync(await dl.path(), 'utf8');
  ok(/\.md$/.test(dl.suggestedFilename()) && md.includes('## Economics &lt;script&gt;') && md.includes('1 handwriting stroke'), 'Markdown export downloads, with the title escaped and strokes counted');
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  if (await p.$('.export')) await p.click('.sheet-x').catch(() => {});
  await p.waitForTimeout(300);
  if (await p.$('.settings')) await p.click('.sheet-btn--done');
  await p.waitForTimeout(400);
});

await step('sign out clears the device; signing in again brings the note back', async () => {
  await signOutViaUi(p);
  eq(await idbCounts(p), { docs: 0, pages: 0, thumbs: 0, queue: 0, sync: 0 }, 'after sign-out no notes, thumbnails or sync data are left in IndexedDB');
  eq(await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('fln.auth')).length), 0, 'after sign-out no session is left in localStorage');
  eq(backend.sessions.size, 0, 'the session was revoked on the server');
  await p.reload(); await p.waitForSelector('.login');
  ok(!(await p.$('.lib')), 'after sign-out a reload stays on the login screen');
  eq(backend.count(aliceId).liveDocs, 1, 'the notes are still in the account');
  await signIn(p, ALICE);
  await p.waitForFunction(() => document.querySelector('.lib') && document.querySelector('.lib').textContent.includes('Economics'), null, { timeout: 10000 });
  ok(true, 'sign in again → the notebook is back');
  eq((await idbCounts(p)).docs, 1, 'it was downloaded to this device');
  eq(backend.count(aliceId), { docs: 1, pages: 1, liveDocs: 1, livePages: 1, images: 0 }, 'no duplicates were created');
});

await step('sign out with changes that are not saved yet asks again and keeps them', async () => {
  // Alice is signed in with her one synced notebook. Go offline, add a notebook, try to sign out.
  await p.waitForSelector('.lib');
  await p.context().setOffline(true);
  await p.evaluate(() => window.dispatchEvent(new Event('offline')));
  await makeNotebook(p, 'Unsaved work');
  await backToLibrary(p);
  await signOutViaUi(p).catch(() => {});                     // first confirmation → second, plainer warning
  ok(await p.$('.alert'), 'a second warning appears when changes are not in the account yet');
  ok(/aren’t saved yet/.test(await p.textContent('.alert')) && /lost from this device/.test(await p.textContent('.alert')), 'it says the changes will be lost');
  await p.click('.alert-btn--cancel');
  await p.waitForTimeout(500);
  ok(!(await p.$('.login')) && (await idbCounts(p)).docs === 2, 'cancelling keeps the user signed in with every note still on the device');
  await p.context().setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  for (let i = 0; i < 60 && (await idbCounts(p)).queue > 0; i++) await p.waitForTimeout(250);
  eq((await idbCounts(p)).queue, 0, 'back online the changes are uploaded');
  eq(backend.count(aliceId).liveDocs, 2, 'the new notebook is in the account');
  await p.evaluate(async () => { const st = await import('./js/store.js'); const d = (await st.listDocs()).find(x => x.title === 'Unsaved work'); await st.deleteDoc(d.id); });
  for (let i = 0; i < 60 && ((await idbCounts(p)).queue > 0 || backend.count(aliceId).liveDocs > 1); i++) await p.waitForTimeout(250);
  await signOutViaUi(p);                                      // nothing waiting: one confirmation is enough
  ok(true, 'with nothing waiting, signing out needs only the one confirmation');
  await signIn(p, ALICE);
  await p.waitForSelector('.lib');
});

// ================================================================= 3. account isolation
let bobId;
await step('B sees nothing of A', async () => {
  await signOutViaUi(p);
  await signIn(p, BOB);
  bobId = [...backend.users.values()].find(u => u.email === BOB.email).id;
  await p.waitForSelector('.empty');
  await p.waitForTimeout(1500);
  ok(!(await p.textContent('.lib')).includes('Economics'), 'B’s library is empty: none of A’s notebooks');
  eq((await idbCounts(p)).docs, 0, 'nothing of A’s was downloaded for B');
  // B guesses A's ids through the API with B's own valid token
  const docId = [...backend.tables.doc.values()].find(r => r.owner === aliceId).id;
  const leaked = await p.evaluate(async id => {
    const s = JSON.parse(localStorage.getItem('fln.auth'));
    const r = await fetch('/__fake/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token }, body: JSON.stringify({ table: 'docs', op: 'select', filters: { in: ['id', [id]] } }) });
    return r.json();
  }, docId);
  eq(leaked, [], 'B asking for A’s notebook by its id gets nothing');
  await makeNotebook(p, 'Bob’s notes');
  await backToLibrary(p);
  await waitSynced(p, bobId, c => c.liveDocs === 1, 'bob notebook');
  eq(backend.count(aliceId).liveDocs, 1, 'A’s account is unchanged by B');
});

// ================================================================= 4. expired session (401) + account conflict
await step('401 → login, notes stay; another account never merges', async () => {
  backend.revokeAllFor(bobId);                                   // the session is revoked on the server
  await p.click('.lib-gear'); await p.waitForSelector('.settings'); await p.click('.sheet-btn--done');
  await p.evaluate(async () => { const store = await import('./js/store.js'); const [d] = await store.listDocs(); await store.patchDoc(d.id, { title: 'Bob’s notes (edited while expired)' }); });
  await p.waitForSelector('.login', { timeout: 15000 });
  ok(/sign in again/i.test(await errorText(p)), 'a 401 from the server → back to the login screen with “sign in again”');
  const c = await idbCounts(p);
  ok(c.docs === 1 && c.queue >= 1, 'the notes and the unsent change stay on the device');
  ok(/still saved on this device/.test(await p.textContent('.login-local')) && !(await p.$('.login-backup')), 'the login screen says so, without handing the notes out');
  // a different account signs in on this device
  await loginAs(p, ALICE);
  await p.waitForSelector('.alert');
  ok(/another account/i.test(await p.textContent('.alert')) && /b…@e…\.com/.test(await p.textContent('.alert')), 'a different account is told about the other account’s notes (email masked)');
  await p.click('.alert-btn--cancel');
  await p.waitForSelector('.login');
  eq([(await idbCounts(p)).docs, backend.count(aliceId).liveDocs], [1, 1], '“Sign out” leaves B’s notes on the device and A’s account untouched');
  // the right account signs back in: the waiting change is uploaded
  await signIn(p, BOB);
  await waitSynced(p, bobId, () => [...backend.tables.doc.values()].some(r => r.owner === bobId && /edited while expired/.test(r.title)), 'queued rename');
  ok(true, 'signing in again as the same account uploads the change that was waiting');
  // now really switch accounts: erase and continue
  backend.revokeAllFor(bobId);
  await p.evaluate(async () => { const store = await import('./js/store.js'); const [d] = await store.listDocs(); await store.patchDoc(d.id, { title: 'x' }); });
  await p.waitForSelector('.login', { timeout: 15000 });
  await loginAs(p, ALICE);
  await p.waitForSelector('.alert');
  await p.click('.alert-btn--danger');
  await p.waitForFunction(() => document.querySelector('.lib') && document.querySelector('.lib').textContent.includes('Economics'), null, { timeout: 10000 });
  ok(!(await p.textContent('.lib')).includes('Bob'), '“Erase and continue” shows only A’s notes');
  await p.waitForTimeout(1500);
  ok(![...backend.tables.doc.values()].some(r => r.owner === aliceId && /Bob|^x$/.test(r.title)), 'nothing of B’s was uploaded into A’s account');
});

// ================================================================= 5. delete account
await step('delete my account', async () => {
  await openSettings(p);
  await p.click('.row--button:has-text("Delete my account")');
  await p.waitForSelector('.alert-input');
  ok(/can’t be undone/.test(await p.textContent('.alert')), 'the confirmation explains that deletion is permanent');
  await p.fill('.alert-input', 'delete');
  await p.click('.alert-btn--danger');
  await p.waitForTimeout(600);
  eq([state.functionCalls, backend.users.has(aliceId)], [0, true], 'typing anything but DELETE deletes nothing');
  await p.click('.row--button:has-text("Delete my account")');
  await p.waitForSelector('.alert-input');
  await p.fill('.alert-input', 'DELETE');
  await p.click('.alert-btn--danger');
  await p.waitForSelector('.login', { timeout: 10000 });
  eq([backend.users.has(aliceId), backend.count(aliceId)], [false, { docs: 0, pages: 0, liveDocs: 0, livePages: 0, images: 0 }], 'the account and every row of it are gone from the server');
  ok(backend.users.has(bobId) && backend.count(bobId).liveDocs === 1, 'the other user’s account is untouched');
  await p.waitForTimeout(800); await p.waitForSelector('.login');
  eq(await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('fln.auth')).length), 0, 'the session is gone from the device');
  eq(await p.evaluate(async () => (await caches.keys()).length), 0, 'no caches are left');
  eq(await idbCounts(p), { docs: 0, pages: 0, thumbs: 0, queue: 0, sync: 0 }, 'no notes are left on the device');
  await signIn(p, ALICE);
  await p.waitForSelector('.empty');
  ok(true, 'signing in with the same Google account afterwards starts empty');
});
ok(d1.logs.filter(l => /Content Security Policy|Refused to/.test(l)).length === 0, 'no Content-Security-Policy violation in the whole session');
const noise = d1.logs.filter(l => !/\[flash-notes:|Failed to load resource|net::ERR_INTERNET_DISCONNECTED|Service Worker registration blocked by Playwright/.test(l));
ok(noise.length === 0, 'no unexpected console errors' + (noise.length ? ': ' + noise.slice(0, 3).join(' | ').slice(0, 300) : ''));
ok(!d1.logs.some(l => /fake-access|fake-refresh|@example\.com|code-[0-9a-f]{8}/.test(l)), 'no token, code or full email address was written to the console');
await d1.ctx.close();

// ================================================================= 6. first sign-in uploads the notes already on the device
await step('first sign-in: local notes are uploaded once, a copy is kept', async () => {
  const d = await device({ dark: true });
  const q = d.page;
  await q.goto(srv.url); await q.waitForSelector('.login');
  // notes made before accounts existed (v1.2): written straight into IndexedDB, no account, no queue
  await q.evaluate(async () => {
    const store = await import('./js/store.js');
    const nb = await store.createNotebook({ title: 'Made before accounts' });
    const pg = await store.getPage(nb.pageIds[0]);
    pg.items.push({ id: 'old-text-1', type: 'text', x: 60, y: 80, w: 300, text: 'I was here first', color: '#1C1C1E', fontSize: 20, font: 'sans' });
    await store.putPage(pg);
    await store.createWhiteboard({ title: 'Old board' });
  });
  await q.reload(); await q.waitForSelector('.login-local:not([hidden])');
  ok(/already has 2 notebooks/.test(await q.textContent('.login-local')) && (await q.isVisible('.login-backup')), 'the login screen says the notes on the device will be added, and offers a backup first');
  const dark = await q.$eval('.gsi-btn', el => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderTopColor, c.color]; });
  eq(dark, ['rgb(19, 19, 20)', 'rgb(142, 145, 143)', 'rgb(227, 227, 227)'], 'dark theme: Google’s #131314 / #8E918F / #E3E3E3');
  await shot(q, 'login-dark-local-notes');
  const CARA = { email: 'cara@example.com', name: 'Cara' };
  await signIn(q, CARA);
  const caraId = [...backend.users.values()].find(u => u.email === CARA.email).id;
  ok((await q.textContent('.lib')).includes('Made before accounts'), 'the notes are still on the device after signing in');
  await waitSynced(q, caraId, c => c.liveDocs === 2 && c.livePages === 2, 'adopted notes');
  ok([...backend.tables.page.values()].some(r => r.owner === caraId && r.data.items.some(i => i.text === 'I was here first')), 'they were uploaded to the account, content intact');
  await q.reload(); await q.waitForSelector('.lib'); await q.waitForTimeout(2500);
  eq(backend.count(caraId), { docs: 2, pages: 2, liveDocs: 2, livePages: 2, images: 0 }, 'reloading does not upload them again (no duplicates)');
  await q.click('.lib-gear'); await q.waitForSelector('.settings');
  await q.waitForSelector('.row--button:has-text("Restore local backup")');
  ok(/2 notebooks from before you signed in/.test(await q.textContent('.account-backup')), 'Settings offers “Restore local backup” with the saved copy');
  await shot(q, 'settings-dark-backup');
  ok(d.logs.filter(l => /Content Security Policy|Refused to/.test(l)).length === 0, 'no CSP violation (dark, first sign-in)');
  await d.ctx.close();
});

// ================================================================= 7. offline start with a cached session (service worker)
await step('signed in + offline: the app opens with the notes', async () => {
  const d = await device({ sw: true });
  const q = d.page;
  await q.goto(srv.url); await q.waitForSelector('.login');
  await signIn(q, BOB);
  await q.waitForFunction(() => document.querySelector('.lib').textContent.includes('Bob’s notes'), null, { timeout: 10000 });
  await q.evaluate(() => navigator.serviceWorker.ready);
  await q.waitForFunction(() => caches.keys().then(k => k.includes('fln-v6')), null, { timeout: 15000 });
  await q.reload(); await q.waitForSelector('.lib');
  await q.waitForFunction(() => !!navigator.serviceWorker.controller);
  const reqs = [];
  q.on('request', r => reqs.push(r.url()));
  await d.ctx.setOffline(true);
  await q.reload();
  await q.waitForSelector('.lib', { timeout: 8000 });
  ok((await q.textContent('.lib')).includes('Bob’s notes'), 'offline with a cached session: the library opens with the notes (no login screen)');
  ok(!reqs.some(u => /__fake\/(token|refresh|authorize)/.test(u)), 'starting offline does not wait for any sign-in request');
  // write offline
  await q.click('.card-main');
  await q.waitForSelector('.editor', { timeout: 6000 });
  await q.waitForFunction(() => !document.querySelector('.open-fx'));
  await drawStroke(q, 360);
  ok(true, 'drawing and saving work offline');
  const before = backend.count(bobId).pages;
  const c = await idbCounts(q);
  ok(c.queue >= 1, 'the offline change is queued on the device');
  await d.ctx.setOffline(false);
  await q.evaluate(() => window.dispatchEvent(new Event('online')));
  for (let i = 0; i < 60 && (await idbCounts(q)).queue > 0; i++) await q.waitForTimeout(250);
  eq((await idbCounts(q)).queue, 0, 'back online: the queued change is uploaded by itself');
  ok([...backend.tables.page.values()].some(r => r.owner === bobId && r.data.items && r.data.items.some(i => i.type === 'stroke')) && backend.count(bobId).pages === before, 'the offline stroke is in the account');
  ok(d.logs.filter(l => /Content Security Policy|Refused to/.test(l)).length === 0, 'no CSP violation (service worker, offline)');
  await d.ctx.close();
});

// ================================================================= 8. two devices, one account
await step('a second device gets the changes', async () => {
  const d = await device();
  const q = d.page;
  await q.goto(srv.url); await q.waitForSelector('.login');
  await signIn(q, BOB);
  await q.waitForFunction(() => document.querySelector('.lib').textContent.includes('Bob’s notes'), null, { timeout: 10000 });
  const strokes = await q.evaluate(async () => { const s = await import('./js/store.js'); const [doc] = await s.listDocs(); return (await s.getPage(doc.pageIds[0])).items.filter(i => i.type === 'stroke').length; });
  ok(strokes >= 1, 'the second device has the stroke that was drawn offline on the first');
  await d.ctx.close();
});

await browser.close();
await srv.close();
if (failures.length) { console.log(`auth e2e: ${failures.length} FAILED, ${passed} passed`); process.exit(1); }
console.log(`auth e2e: all ${passed} checks passed`);
process.exit(0);

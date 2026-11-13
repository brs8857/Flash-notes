// Ownership enforcement against REAL Postgres (PGlite = Postgres compiled to WebAssembly) running the
// actual files in supabase/migrations with their RLS policies, triggers and grants.
//   cd tests && npm install && node rls.test.mjs
// What is simulated: the `auth` and `storage` schemas of a Supabase project (tests/db/supabase-shim.sql) and
// the API's per-request identity (role + request.jwt.claims, exactly what PostgREST sets). What is NOT
// covered: a real Supabase project, its Auth server, Storage server or the Edge Function runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, rejects, done } from './lib/check.mjs';

let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); }
catch { console.log('rls: PGlite is not installed. Run `npm install` inside tests/ first.'); process.exit(1); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const db = new PGlite();
process.on('unhandledRejection', err => { console.log('rls: FAILED with an unexpected error:', String((err && err.message) || err).slice(0, 400)); process.exit(1); });
process.on('uncaughtException', err => { console.log('rls: FAILED with an unexpected error:', String((err && err.message) || err).slice(0, 400)); process.exit(1); });

await db.exec(read('tests/db/supabase-shim.sql'));
// Run the migrations as a NON-superuser owner without BYPASSRLS (the strictest case), twice (re-runnable).
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
ok(migrations.length >= 3, 'found the migrations');
for (let pass = 0; pass < 2; pass++) {
  await db.exec('set role fln_owner');
  for (const f of migrations) await db.exec(read('supabase/migrations/' + f));
  await db.exec('reset role');
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';   // Google account, email NOT verified
const D = '44444444-4444-4444-8444-444444444444';   // verified Google identity + a second linked identity
const E = '55555555-5555-4555-8555-555555555555';   // verified, never calls ensure_profile

async function mkUser(id, email, identities) {
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)',
    [id, email, JSON.stringify({ full_name: 'N ' + email, avatar_url: 'https://example.invalid/p.png', picture: 'https://example.invalid/p.png' })]);
  for (const [provider, verified] of identities) {
    await db.query('insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, $2, $3, $4)',
      [id, provider, provider + '-sub-' + id.slice(0, 4), JSON.stringify({ email, email_verified: verified, full_name: 'Name ' + id.slice(0, 2), avatar_url: 'https://example.invalid/p.png' })]);
  }
}
await mkUser(A, 'a@example.com', [['google', true]]);
await mkUser(B, 'b@example.com', [['google', true]]);
await mkUser(C, 'c@example.com', [['google', false]]);
await mkUser(D, 'd@example.com', [['google', true], ['other', false]]);
await mkUser(E, 'e@example.com', [['google', true]]);

/** Run fn as an API request: role + JWT claims, like PostgREST. uid null = signed-out (anon). */
async function as(uid, fn, role) {
  role = role || (uid ? 'authenticated' : 'anon');
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : JSON.stringify({ role })]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;
const n = async (sql, params) => (await db.query(sql, params)).affectedRows;
const DENIED = /permission denied|row-level security|cannot be changed/i;

// ---------------------------------------------------------------- structure
{
  const tables = await q(`select n.nspname s, c.relname t, c.relrowsecurity r, c.relforcerowsecurity f
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public', 'private') order by 1, 2`);
  eq(tables.map(t => `${t.s}.${t.t}`), ['private.write_rate', 'public.docs', 'public.pages', 'public.profiles'], 'exactly the expected tables exist');
  for (const t of tables) ok(t.r && t.f, `RLS is ENABLED and FORCED on ${t.s}.${t.t}`);
  const fks = await q(`select conrelid::regclass::text t, confdeltype::text d from pg_constraint
    where contype = 'f' and confrelid = 'auth.users'::regclass and connamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`);
  eq(fks, [{ t: 'docs', d: 'c' }, { t: 'pages', d: 'c' }, { t: 'private.write_rate', d: 'c' }, { t: 'profiles', d: 'c' }], 'every table references auth.users ON DELETE CASCADE');
  const defaults = await q(`select table_name t, column_default d from information_schema.columns
    where table_schema = 'public' and ((table_name in ('docs', 'pages') and column_name = 'owner_id') or (table_name = 'profiles' and column_name = 'id'))`);
  ok(defaults.length === 3 && defaults.every(d => /auth\.uid\(\)/.test(d.d || '')), 'owner columns default to auth.uid()');
  const pols = await q(`select tablename t, cmd, roles::text roles, qual, with_check from pg_policies where schemaname = 'public' and policyname like '%_own'`);
  for (const t of ['docs', 'pages']) for (const cmd of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    const p = pols.find(x => x.t === t && x.cmd === cmd);
    ok(p && /authenticated/.test(p.roles) && /auth\.uid\(\)/.test((p.qual || '') + (p.with_check || '')) && /owner_id/.test((p.qual || '') + (p.with_check || '')), `${t} has an owner policy for ${cmd}`);
  }
  const anonPol = await q(`select count(*)::int n from pg_policies where schemaname in ('public', 'private', 'storage') and (roles::text like '%anon%' or roles::text like '%public%')`);
  eq(anonPol[0].n, 0, 'no policy is granted to anon or public');
  const bucket = await q(`select public from storage.buckets where id = 'note-images'`);
  eq(bucket, [{ public: false }], 'the image bucket is private');
}

// ---------------------------------------------------------------- profiles + email verification guard
{
  const pa = await as(A, () => q('select public.ensure_profile() p'));
  ok(pa[0].p.verified === true && pa[0].p.email === 'a@example.com' && pa[0].p.provider === 'google', 'verified Google account gets a verified profile');
  await as(B, () => q('select public.ensure_profile()'));
  const pc = await as(C, () => q('select public.ensure_profile() p'));
  eq(pc[0].p.verified, false, 'unverified Google email → profile is NOT verified');
  const pd = await as(D, () => q('select public.ensure_profile() p'));
  eq(pd[0].p.verified, false, 'a second linked identity → profile is NOT verified');
  await rejects(() => as(null, () => q('select public.ensure_profile()')), DENIED, 'anon cannot call ensure_profile');
  await rejects(() => as(A, () => q(`select private.sync_profile('${B}')`)), DENIED, 'clients cannot call the internal profile function');
  const cols = await q(`select column_name c from information_schema.columns where table_schema = 'public' and table_name = 'profiles' order by 1`);
  eq(cols.map(c => c.c), ['created_at', 'display_name', 'email', 'email_verified', 'id', 'provider', 'provider_sub', 'updated_at'], 'profiles stores only id, provider, subject id, email, verified flag, display name');
  const meta = await q(`select raw_user_meta_data m from auth.users where id = $1`, [A]);
  ok(!('avatar_url' in meta[0].m) && !('picture' in meta[0].m), 'the Google picture link is stripped from auth.users');
  const idm = await q(`select identity_data m from auth.identities where user_id = $1`, [A]);
  ok(!('avatar_url' in idm[0].m), 'the Google picture link is stripped from auth.identities');

  eq((await as(A, () => q('select id from public.profiles'))).map(r => r.id), [A], 'a user sees only their own profile');
  eq(await as(B, () => q('select id from public.profiles where id = $1', [A])), [], 'B cannot read A’s profile by id');
  eq(await as(A, () => n(`update public.profiles set display_name = 'Ada'`)), 1, 'a user can rename themselves (1 row: their own)');
  eq(await as(B, () => n(`update public.profiles set display_name = 'Hacked' where id = $1`, [A])), 0, 'B cannot rename A');
  await rejects(() => as(C, () => n(`update public.profiles set email_verified = true`)), DENIED, 'a user cannot mark their own email verified');
  await rejects(() => as(A, () => n(`update public.profiles set provider_sub = 'x'`)), DENIED, 'a user cannot change their provider id');
  await rejects(() => as(A, () => n(`update public.profiles set id = $1`, [B])), DENIED, 'a user cannot change their profile id');
  await rejects(() => as(E, () => n(`insert into public.profiles (id, provider, provider_sub, email_verified) values ($1, 'google', 'x', true)`, [E])), DENIED, 'a user cannot insert a profile directly');
  await rejects(() => as(A, () => n('delete from public.profiles')), DENIED, 'a user cannot delete profile rows directly');
  await rejects(() => as(A, () => n(`update public.profiles set display_name = $1`, ['x'.repeat(81)])), /check constraint/i, 'display name length is limited');
}

// ---------------------------------------------------------------- ownership: docs + pages
const doc = (id, extra = {}) => ({ id, kind: 'notebook', title: 'T ' + id, data: JSON.stringify({ pageIds: [] }), updated_at: 1000, ...extra });
const insDoc = d => n('insert into public.docs (id, kind, title, data, updated_at) values ($1, $2, $3, $4, $5)', [d.id, d.kind, d.title, d.data, d.updated_at]);
const insPage = (id, docId, at = 1000) => n('insert into public.pages (id, doc_id, data, updated_at) values ($1, $2, $3, $4)', [id, docId, JSON.stringify({ items: [{ id: 'i1', kind: 'text', text: 'secret of ' + id }] }), at]);
{
  eq(await as(A, () => insDoc(doc('docA0001'))), 1, 'A inserts a notebook without sending any user id');
  eq(await as(A, () => insPage('pageA001', 'docA0001')), 1, 'A inserts a page');
  eq(await as(B, () => insDoc(doc('docB0001'))), 1, 'B inserts a notebook');
  eq(await as(B, () => insPage('pageB001', 'docB0001')), 1, 'B inserts a page');
  eq((await q(`select owner_id from public.docs where id = 'docA0001'`))[0].owner_id, A, 'owner_id was filled in from the JWT');

  // read
  eq((await as(A, () => q('select id from public.docs'))).map(r => r.id), ['docA0001'], 'A lists only A’s notebooks');
  eq((await as(B, () => q('select id from public.pages'))).map(r => r.id), ['pageB001'], 'B lists only B’s pages');
  eq(await as(B, () => q(`select * from public.docs where id = 'docA0001'`)), [], 'B cannot read A’s notebook by guessing its id');
  eq(await as(B, () => q(`select * from public.pages where id = 'pageA001'`)), [], 'B cannot read A’s page by guessing its id');
  eq(await as(B, () => q(`select * from public.pages where owner_id = $1`, [A])), [], 'B cannot read A’s pages by naming A’s user id');
  eq((await as(B, () => q('select count(*)::int c from public.pages')))[0].c, 1, 'counts do not leak other users’ rows');

  // update / delete
  eq(await as(B, () => n(`update public.docs set title = 'hacked' where id = 'docA0001'`)), 0, 'B cannot update A’s notebook (0 rows)');
  eq(await as(B, () => n(`update public.pages set data = '{}'::jsonb, updated_at = 9999 where owner_id = $1`, [A])), 0, 'B cannot update A’s pages (0 rows)');
  eq(await as(B, () => n(`delete from public.docs where id = 'docA0001'`)), 0, 'B cannot delete A’s notebook (0 rows)');
  eq(await as(B, () => n(`delete from public.pages where owner_id = $1`, [A])), 0, 'B cannot delete A’s pages (0 rows)');
  const still = await q(`select title from public.docs where owner_id = $1 and id = 'docA0001'`, [A]);
  eq(still, [{ title: 'T docA0001' }], 'A’s notebook is untouched after B’s attempts');

  // owner spoofing
  await rejects(() => as(B, () => n(`insert into public.docs (owner_id, id, kind, updated_at) values ($1, 'docSpoof1', 'notebook', 1)`, [A])), DENIED, 'B cannot insert a row owned by A');
  await rejects(() => as(B, () => n(`insert into public.pages (owner_id, id, doc_id, updated_at) values ($1, 'pageSpoof', 'docA0001', 1)`, [A])), DENIED, 'B cannot insert a page owned by A');
  await rejects(() => as(B, () => n(`insert into public.docs (owner_id, id, kind, title, updated_at) values ($1, 'docA0001', 'notebook', 'hacked', 99999)
    on conflict (owner_id, id) do update set title = excluded.title, updated_at = excluded.updated_at`, [A])), DENIED, 'B cannot upsert over A’s row');
  await rejects(() => as(A, () => n(`update public.docs set owner_id = $1 where id = 'docA0001'`, [B])), DENIED, 'A cannot give a row to B (owner_id is immutable)');
  await rejects(() => as(B, () => n(`update public.docs set owner_id = $1 where id = 'docB0001'`, [A])), DENIED, 'B cannot plant a row in A’s account');
  await rejects(() => as(A, () => n(`update public.docs set id = 'docA0002' where id = 'docA0001'`)), DENIED, 'row ids are immutable');
  eq((await q(`select count(*)::int c from public.docs where owner_id = $1`, [A]))[0].c, 1, 'A still has exactly one notebook');

  // the same id in two accounts never collides
  eq(await as(B, () => insDoc(doc('docA0001', { title: 'B’s own' }))), 1, 'B may use the same item id in B’s own account');
  eq((await as(A, () => q(`select title from public.docs where id = 'docA0001'`)))[0].title, 'T docA0001', 'A still sees A’s row for that id');
  eq((await as(B, () => q(`select title from public.docs where id = 'docA0001'`)))[0].title, 'B’s own', 'B sees B’s row for that id');

  // upsert of own row (what the app does)
  eq(await as(A, () => n(`insert into public.docs (id, kind, title, data, updated_at) values ('docA0001', 'notebook', 'Renamed', '{"pageIds":["pageA001"]}', 2000)
    on conflict (owner_id, id) do update set title = excluded.title, data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted`)), 1, 'A can upsert A’s own row');
}

// ---------------------------------------------------------------- signed-out and unverified callers
{
  await rejects(() => as(null, () => q('select * from public.docs')), DENIED, 'anon cannot read notebooks');
  await rejects(() => as(null, () => q('select * from public.pages')), DENIED, 'anon cannot read pages');
  await rejects(() => as(null, () => q('select * from public.profiles')), DENIED, 'anon cannot read profiles');
  await rejects(() => as(null, () => n(`insert into public.docs (id, kind, updated_at) values ('docAnon01', 'notebook', 1)`)), DENIED, 'anon cannot insert');
  await rejects(() => as(null, () => n(`insert into public.docs (owner_id, id, kind, updated_at) values ($1, 'docAnon02', 'notebook', 1)`, [A])), DENIED, 'anon cannot insert naming a user');
  await rejects(() => as(null, () => n(`update public.docs set title = 'x'`)), DENIED, 'anon cannot update');
  await rejects(() => as(null, () => n('delete from public.pages')), DENIED, 'anon cannot delete');
  await rejects(() => as(null, () => q('select * from private.write_rate')), DENIED, 'anon cannot read internal tables');
  await rejects(() => as(A, () => q('select * from private.write_rate')), DENIED, 'users cannot read internal tables');
  // a token with the authenticated role but no subject
  eq(await as(null, () => q('select * from public.docs'), 'authenticated'), [], 'authenticated role without a user id sees nothing');
  await rejects(() => as(null, () => n(`insert into public.docs (id, kind, updated_at) values ('docNoSub1', 'notebook', 1)`), 'authenticated'), /null value|row-level security/i, 'authenticated role without a user id cannot insert');

  await rejects(() => as(C, () => insDoc(doc('docC0001'))), DENIED, 'UNVERIFIED account cannot store notes');
  await rejects(() => as(D, () => insDoc(doc('docD0001'))), DENIED, 'account with a second linked identity cannot store notes');
  await rejects(() => as(E, () => insDoc(doc('docE0001'))), DENIED, 'account without a profile cannot store notes');
  await db.query(`insert into public.docs (owner_id, id, kind, updated_at) values ($1, 'docC0009', 'notebook', 1)`, [C]);   // planted by an admin
  eq(await as(C, () => q('select id from public.docs')), [], 'UNVERIFIED account cannot read even its own rows');
  // becoming verified later (Google confirms the email) unlocks the account at the next sign-in
  await db.query(`update auth.identities set identity_data = identity_data || '{"email_verified": true}' where user_id = $1`, [C]);
  eq((await as(C, () => q('select public.ensure_profile() p')))[0].p.verified, true, 'profile becomes verified once Google verifies the email');
  eq((await as(C, () => q('select id from public.docs'))).length, 1, 'verified account reads its rows');
  // ... and losing it locks it again
  await db.query(`insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'other', 'zzz', '{"email":"c@example.com"}')`, [C]);
  await as(C, () => q('select public.ensure_profile()'));
  eq(await as(C, () => q('select id from public.docs')), [], 'a later linked identity locks the notes again');
}

// ---------------------------------------------------------------- constraints, last-write-wins, tombstones
{
  await rejects(() => as(A, () => insDoc(doc('bad id!'))), /check constraint/i, 'ids are validated');
  await rejects(() => as(A, () => insDoc(doc('docA0003', { kind: 'virus' }))), /check constraint/i, 'kind is validated');
  await rejects(() => as(A, () => insDoc(doc('docA0003', { title: 'x'.repeat(201) }))), /check constraint/i, 'title length is limited');
  await rejects(() => as(A, () => insDoc(doc('docA0003', { data: '[1,2]' }))), /check constraint/i, 'data must be a JSON object');
  await rejects(() => as(A, () => insDoc(doc('docA0003', { data: JSON.stringify({ big: 'x'.repeat(1048600) }) }))), /check constraint/i, 'notebook data size is limited');
  await rejects(() => as(A, () => insDoc(doc('docA0003', { updated_at: -5 }))), /check constraint/i, 'updated_at must be positive');

  const before = (await q(`select rev, updated_at from public.docs where owner_id = $1 and id = 'docA0001'`, [A]))[0];
  eq(await as(A, () => n(`update public.docs set title = 'stale', updated_at = 1500 where id = 'docA0001'`)), 0, 'an older write is skipped (last write wins)');
  eq(await as(A, () => n(`update public.docs set title = 'newer', updated_at = 3000 where id = 'docA0001'`)), 1, 'a newer write is applied');
  const after = (await q(`select rev, title, updated_at from public.docs where owner_id = $1 and id = 'docA0001'`, [A]))[0];
  ok(after.title === 'newer' && Number(after.rev) > Number(before.rev), 'rev grows with every accepted write');
  const far = Date.now() + 3600e3 * 24 * 365;
  await as(A, () => n(`update public.docs set updated_at = $1 where id = 'docA0001'`, [far]));
  const clamped = Number((await q(`select updated_at from public.docs where owner_id = $1 and id = 'docA0001'`, [A]))[0].updated_at);
  ok(Math.abs(clamped - Date.now()) < 60000, 'a clock far in the future is clamped to the server clock');
  await as(A, () => n(`update public.pages set deleted = true, updated_at = 5000 where id = 'pageA001'`));
  eq((await q(`select data, deleted from public.pages where owner_id = $1 and id = 'pageA001'`, [A]))[0], { data: {}, deleted: true }, 'a tombstone drops the page content');
  await db.query(`update public.pages set server_updated_at = now() - interval '91 days' where owner_id = $1 and id = 'pageA001'`, [A]).catch(() => {});
}

// ---------------------------------------------------------------- write-rate guard
{
  await db.exec('delete from private.write_rate');
  eq(await as(B, () => n(`insert into public.pages (id, doc_id, updated_at) select 'ratepg' || lpad(g::text, 6, '0'), 'docB0001', 1 from generate_series(1, 1000) g`)), 1000, '1,000 writes in a minute are fine');
  await rejects(() => as(B, () => n(`insert into public.pages (id, doc_id, updated_at) select 'rateqq' || lpad(g::text, 6, '0'), 'docB0001', 1 from generate_series(1, 300) g`)), /too many writes/i, 'more than 1,200 writes a minute are refused');
  eq((await q(`select count(*)::int c from public.pages where owner_id = $1`, [B]))[0].c, 1001, 'the refused batch stored nothing');
  eq(await as(A, () => insPage('pageA002', 'docA0001')), 1, 'another user is not affected by B’s rate limit');
  await db.exec('delete from private.write_rate');
}

// ---------------------------------------------------------------- private image storage
{
  const sha = 'a'.repeat(64);
  const put = name => n(`insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [name]);
  eq(await as(A, () => put(`${A}/${sha}.jpg`)), 1, 'A uploads an image into A’s own folder');
  await rejects(() => as(B, () => put(`${A}/${'b'.repeat(64)}.jpg`)), DENIED, 'B cannot upload into A’s folder');
  await rejects(() => as(A, () => put(`${A}/../../evil.html`)), DENIED, 'object names must be <uid>/<sha-256>.<jpg|png>');
  await rejects(() => as(A, () => put(`${A}/${sha}.svg`)), DENIED, 'only jpg and png names are accepted');
  eq(await as(B, () => q(`select name from storage.objects`)), [], 'B cannot list or read A’s images');
  eq((await as(A, () => q(`select name from storage.objects`))).length, 1, 'A reads A’s images');
  eq(await as(B, () => n(`delete from storage.objects`)), 0, 'B cannot delete A’s images');
  eq(await as(A, () => n(`update storage.objects set name = $1`, [`${B}/${sha}.jpg`])), 0, 'images cannot be moved or overwritten (no update policy)');
  eq(await as(null, () => q(`select name from storage.objects`)), [], 'anon reads no images');
  await rejects(() => as(null, () => put(`${A}/${'c'.repeat(64)}.png`)), DENIED, 'anon cannot upload');
  await rejects(() => as(D, () => put(`${D}/${sha}.png`)), DENIED, 'an unverified account cannot upload');
}

// ---------------------------------------------------------------- account deletion
{
  // What the delete-account Edge Function does with the service role: remove the user's storage folder,
  // then delete the auth user; every table cascades from auth.users.
  const counts = async uid => (await q(`select
    (select count(*) from public.docs where owner_id = $1)::int docs,
    (select count(*) from public.pages where owner_id = $1)::int pages,
    (select count(*) from public.profiles where id = $1)::int profiles,
    (select count(*) from private.write_rate where owner_id = $1)::int rate,
    (select count(*) from auth.identities where user_id = $1)::int identities,
    (select count(*) from storage.objects where name like $1::text || '/%')::int images`, [uid]))[0];
  await as(A, () => insPage('pageA003', 'docA0001'));
  await as(B, () => n(`insert into storage.objects (bucket_id, name) values ('note-images', $1)`, [`${B}/${'d'.repeat(64)}.png`]));
  const a0 = await counts(A), b0 = await counts(B);
  ok(a0.docs > 0 && a0.pages > 0 && a0.profiles === 1 && a0.rate > 0 && a0.images === 1, 'A has data in every table before deletion');
  await db.query(`delete from storage.objects where bucket_id = 'note-images' and name like $1`, [A + '/%']);
  await db.query('delete from auth.users where id = $1', [A]);
  eq(await counts(A), { docs: 0, pages: 0, profiles: 0, rate: 0, identities: 0, images: 0 }, 'deleting the account removes every row and image of that user');
  eq(await counts(B), b0, 'the other user’s data is untouched');
  eq(await as(A, () => q('select * from public.docs')), [], 'a still-valid token of the deleted user reads nothing');
  await rejects(() => as(A, () => insDoc(doc('docA0009'))), /row-level security|foreign key/i, 'a still-valid token of the deleted user cannot write');
}

await db.close();
done('rls');

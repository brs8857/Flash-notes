// First sign-in: notes already on the device are uploaded to the account exactly once, reversibly, and
// never into a different account. Real js/store.js + js/sync/local.js + js/sync/migrate.js on fake-indexeddb.
//   cd tests && npm install && node migrate.test.mjs
import { ok, eq, done } from './lib/check.mjs';
import { FakeBackend } from './harness/fake-backend.mjs';
import { makeDevice, use, track, sync, tick, clock, store, local } from './lib/device.mjs';
import { decideAdoption, enterAccount, eraseAndEnter, BACKUP_KEEP_MS } from '../js/sync/migrate.js';

const backend = new FakeBackend();
const alice = backend.addUser({ email: 'alice@example.com', name: 'Alice' });
const bob = backend.addUser({ email: 'bob@example.com', name: 'Bob' });
const text = (id, t) => ({ id, type: 'text', x: 20, y: 40, w: 200, text: t, color: '#1C1C1E', fontSize: 20, font: 'sans' });
const titles = async () => (await store.listDocs()).map(d => d.title).sort();

// ---------------------------------------------------------------- the decision table
eq(decideAdoption({ ownerId: null, userId: 'u1', localDocs: 0 }), 'fresh', 'no notes, no owner → fresh');
eq(decideAdoption({ ownerId: null, userId: 'u1', localDocs: 3 }), 'adopt', 'unowned notes → upload to the account');
eq(decideAdoption({ ownerId: 'u1', userId: 'u1', localDocs: 3 }), 'resume', 'same account → nothing to do');
eq(decideAdoption({ ownerId: 'u1', userId: 'u2', localDocs: 3 }), 'conflict', 'another account’s notes → never merged silently');
eq(decideAdoption({ ownerId: 'u1', userId: 'u2', localDocs: 0 }), 'conflict', 'another account’s device state → still a conflict');
eq(decideAdoption({ ownerId: 'u1', userId: null, localDocs: 1 }), 'conflict', 'no user → nothing is adopted');

// ---------------------------------------------------------------- a v1.2 device signs in for the first time
const dev = makeDevice('ipad');
await use(dev);                                             // tracking off: the app before accounts
const nb1 = await store.createNotebook({ title: 'Biology' });
const nb2 = await store.createNotebook({ title: 'History' });
const wb = await store.createWhiteboard({ title: 'Revision map' });
await store.addPage(nb1.id);
{
  const p = await store.getPage(nb1.pageIds[0]); p.items.push(text('t-1', 'Mitochondria')); await store.putPage(p);
}
eq(await local.countDirty(), 0, 'before sign-in nothing is queued');
eq((await local.getState()).userId, null, 'before sign-in the notes belong to no account');

track(dev);
tick();
const first = await enterAccount(local, alice.id);
eq(first.decision, 'adopt', 'first sign-in adopts the notes on the device');
eq(first.queued, 3 + 4, 'every notebook, whiteboard and page is queued (3 + 4 pages)');
eq([first.backup.docs, first.backup.pages], [3, 4], 'a full copy was saved on the device first');
const st1 = await local.getState();
ok(st1.userId === alice.id && st1.adoptedAt === clock() && !st1.verifiedAt, 'the device now remembers the account (migration marker)');
eq(await titles(), ['Biology', 'History', 'Revision map'], 'the notes are still on the device (local copy kept)');

// never twice
tick();
const second = await enterAccount(local, alice.id);
eq([second.decision, second.queued], ['resume', 0], 'running it again does nothing (the marker stops it)');
eq(await local.countDirty(), 7, 'the queue was not duplicated');
eq((await local.getState()).adoptedAt, st1.adoptedAt, 'the marker was not rewritten');

// upload
const r1 = await sync(dev, backend, alice.id, { full: true, verify: true });
eq([r1.pushed, r1.left, r1.verified], [7, 0, true], 'everything is uploaded and verified');
eq(backend.count(alice.id), { docs: 3, pages: 4, liveDocs: 3, livePages: 4, images: 0 }, 'the account holds exactly the device’s notes');
const r2 = await sync(dev, backend, alice.id, { full: true });
eq([r2.pushed, r2.applied], [0, 0], 'a second sync uploads nothing');
await enterAccount(local, alice.id); await local.markAllDirty();   // even a forced re-queue…
await sync(dev, backend, alice.id, { full: true });
eq(backend.count(alice.id), { docs: 3, pages: 4, liveDocs: 3, livePages: 4, images: 0 }, '…cannot create duplicates (uploads are upserts by id)');
eq(backend.count(bob.id).docs, 0, 'nothing went to any other account');

// ---------------------------------------------------------------- reversible
{
  const info = (await local.getState()).backup;
  ok(info && info.docs === 3, 'the saved copy is still there after the upload');
  await store.deleteDoc(nb2.id);                            // pretend something went wrong with "History"
  eq(await titles(), ['Biology', 'Revision map'], 'a notebook is lost…');
  const res = await local.restoreLocalBackup();
  eq(res.docs, 1, '…“Restore local backup” brings back exactly what is missing');
  eq(await titles(), ['Biology', 'History', 'Revision map'], 'all notes are back');
  const again = await local.restoreLocalBackup();
  eq(again.docs, 0, 'restoring twice adds nothing (no duplicates)');
  await sync(dev, backend, alice.id);
  eq(backend.count(alice.id).liveDocs, 3, 'the restored notebook is back in the account too');

  // kept until verified + 30 days
  await local.patchState({ verifiedAt: clock() });
  tick(BACKUP_KEEP_MS - 1000);
  await enterAccount(local, alice.id);
  ok(!!(await local.getLocalBackup()), 'the saved copy is kept for 30 days after verification');
  tick(2000);
  await enterAccount(local, alice.id);
  ok(!(await local.getLocalBackup()) && !(await local.getState()).backup, 'and removed after that');
}
{
  // never dropped while the upload has not been verified
  const d2 = makeDevice('unverified'); await use(d2);
  await store.createNotebook({ title: 'Kept' });
  track(d2);
  await enterAccount(local, alice.id);
  tick(BACKUP_KEEP_MS * 3);
  await enterAccount(local, alice.id);
  ok(!!(await local.getLocalBackup()), 'the saved copy is never removed before the account is verified to hold everything');
}

// ---------------------------------------------------------------- interrupted first run
{
  const d3 = makeDevice('crashy'); await use(d3);
  await store.createNotebook({ title: 'Chemistry' });
  track(d3);
  await local.saveLocalBackup();                            // steps 1 and 2 ran…
  const n = await local.markAllDirty();
  eq(n, 2, 'queued once');                                  // …then the tab was closed before the marker
  eq((await local.getState()).userId, null, 'no marker yet');
  const again = await enterAccount(local, bob.id);
  eq([again.decision, again.queued], ['adopt', 0], 'the run starts over and queues nothing twice');
  eq(await local.countDirty(), 2, 'still exactly one queue row per item');
  await sync(d3, backend, bob.id, { full: true });
  eq(backend.count(bob.id), { docs: 1, pages: 1, liveDocs: 1, livePages: 1, images: 0 }, 'Bob’s account has the notebook once');
}

// ---------------------------------------------------------------- a different account on the same device
{
  await use(dev);
  const beforeAlice = backend.count(alice.id), beforeBob = backend.count(bob.id);
  const q0 = await local.countDirty();
  const r = await enterAccount(local, bob.id);
  eq(r.decision, 'conflict', 'Bob signing in on Alice’s device is a conflict');
  eq((await local.getState()).userId, alice.id, 'the device still belongs to Alice’s account');
  eq(await local.countDirty(), q0, 'nothing was queued for Bob');
  eq(await titles(), ['Biology', 'History', 'Revision map'], 'Alice’s notes are untouched');
  eq([backend.count(alice.id), backend.count(bob.id)], [beforeAlice, beforeBob], 'neither account changed');

  await eraseAndEnter(local, bob.id);                       // Bob chose "erase and continue"
  eq(await titles(), [], 'the device no longer holds Alice’s notes');
  eq(await local.countDirty(), 0, 'and nothing of hers is queued');
  ok(!(await local.getLocalBackup()), 'her saved copy is gone from the device too');
  eq((await local.getState()).userId, bob.id, 'the device now belongs to Bob’s account');
  await sync(dev, backend, bob.id, { full: true });
  eq(await titles(), ['Chemistry'], 'Bob sees only Bob’s notes');
  eq(backend.count(alice.id), beforeAlice, 'Alice’s account still has everything');
}

// ---------------------------------------------------------------- nothing on the device
{
  const d4 = makeDevice('new'); await use(d4); track(d4);
  const r = await enterAccount(local, alice.id);
  eq([r.decision, r.queued, r.backup], ['fresh', 0, null], 'an empty device just joins the account');
  await sync(d4, backend, alice.id, { full: true });
  eq(await titles(), ['Biology', 'History', 'Revision map'], 'and downloads the account’s notes');
  // sign-out wipes the device but not the account
  await local.wipeUserData();
  eq([await titles(), await local.countDirty(), (await local.getState()).userId], [[], 0, null], 'sign-out leaves no notes, queue or owner on the device');
  eq(backend.count(alice.id).liveDocs, 3, 'the account is untouched by sign-out');
  const settings = await store.getSettings();
  ok(settings && settings.theme, 'device settings survive sign-out');
}

done('migrate');
process.exit(0);

// Sync: the real js/store.js + js/sync/local.js (on fake-indexeddb) + js/sync/core.js against an in-memory
// backend that follows the database's rules. Several devices, one or two accounts.
//   cd tests && npm install && node sync.test.mjs
import { ok, eq, rejects, done } from './lib/check.mjs';
import { FakeBackend } from './harness/fake-backend.mjs';
import { makeDevice, use, track, sync, tick, store, local } from './lib/device.mjs';
import { isAuthFailure } from '../js/auth/guard.js';
import { rowToDoc, rowToPage, docToRow, pageToRow } from '../js/sync/map.js';
import { createSync } from '../js/sync/core.js';

const backend = new FakeBackend();
const alice = backend.addUser({ email: 'alice@example.com', name: 'Alice' });
const bob = backend.addUser({ email: 'bob@example.com', name: 'Bob' });
const stroke = (id, x = 10) => ({ id, type: 'stroke', tool: 'pen', color: '#1C1C1E', size: 3, points: [[x, 10, 0.5], [x + 40, 30, 0.5]], bbox: [x, 10, x + 40, 30] });
const text = (id, t, y = 50) => ({ id, type: 'text', x: 20, y, w: 200, text: t, color: '#1C1C1E', fontSize: 20, font: 'sans' });
const draw = async (pageId, ...items) => { const p = await store.getPage(pageId); p.items.push(...items); p.updatedAt = Date.now(); await store.putPage(p); return p; };
const ids = async () => (await store.listDocs()).map(d => d.id).sort();

const A = makeDevice('A'), B = makeDevice('B'), C = makeDevice('C');
track(A); track(B); track(C);

// ---------------------------------------------------------------- the change hook
{
  const plain = makeDevice('plain');                       // no account: exactly v1.2
  await use(plain);
  const nb = await store.createNotebook({ title: 'Local only' });
  await draw(nb.pageIds[0], stroke('s-local-1'));
  eq(await local.countDirty(), 0, 'without an account nothing is queued (v1.2 behaviour)');

  await use(A);
  let fired = 0;
  const off = store.onLocalChange(() => { fired++; });
  const nbA = await store.createNotebook({ title: 'Economics' });
  await draw(nbA.pageIds[0], stroke('s-a-1'), text('t-a-1', 'Supply & demand'));
  await new Promise(r => setTimeout(r, 5));
  off();
  ok(fired >= 1, 'a saved change notifies the sync scheduler');
  const q = await local.dirty();
  eq(q.map(d => d.kind).sort(), ['doc', 'page'], 'creating a notebook and drawing queues the notebook and the page');
  ok(q.every(d => d.deleted === false && typeof d.at === 'number'), 'queue rows carry the time of the change');
}

// ---------------------------------------------------------------- upload, download, idempotency
let nbId, pg1;
{
  await use(A);
  [nbId] = await ids();
  pg1 = (await store.getDoc(nbId)).pageIds[0];
  const r1 = await sync(A, backend, alice.id, { full: true, verify: true });
  ok(r1.pushed === 2 && r1.left === 0 && r1.verified === true, 'first sync uploads the notebook and its page, and the account is verified to hold them');
  eq(backend.count(alice.id), { docs: 1, pages: 1, liveDocs: 1, livePages: 1, images: 0 }, 'the account holds exactly one notebook and one page');
  eq(await local.countDirty(), 0, 'the queue is empty after a successful upload');
  const r2 = await sync(A, backend, alice.id, { full: true });
  eq([r2.pushed, r2.applied, r2.stale], [0, 0, 0], 'syncing again changes nothing (idempotent)');
  eq(backend.count(alice.id).docs + backend.count(alice.id).pages, 2, 'no duplicates after a second sync');

  const rb = await sync(B, backend, alice.id, { full: true });
  eq(rb.applied, 2, 'a second device downloads the notebook and the page');
  const docB = await store.getDoc(nbId), pageB = await store.getPage(pg1);
  ok(docB && docB.title === 'Economics' && docB.kind === 'notebook' && docB.pageIds[0] === pg1, 'the notebook arrives intact');
  eq(pageB.items.map(i => i.id), ['s-a-1', 't-a-1'], 'the page arrives with its strokes and text');
  eq(pageB.items[1].text, 'Supply & demand', 'text content is unchanged');
  eq(await local.countDirty(), 0, 'downloading does not queue anything for upload (no echo)');

  eq(await ids.call(null, await use(C)), [], 'device C starts empty');
  const rc = await sync(C, backend, bob.id, { full: true });
  eq([rc.applied, (await store.listDocs()).length], [0, 0], 'another account downloads nothing of Alice’s');
  eq(backend.count(bob.id), { docs: 0, pages: 0, liveDocs: 0, livePages: 0, images: 0 }, 'the other account stays empty');
}

// ---------------------------------------------------------------- edits travel both ways
{
  await use(B); tick();
  await draw(pg1, stroke('s-b-1', 100));
  await store.patchDoc(nbId, { title: 'Economics Y12' });
  const rb = await sync(B, backend, alice.id);
  eq(rb.pushed, 2, 'B uploads its edit and the rename');
  const ra = await sync(A, backend, alice.id);
  eq(ra.applied, 2, 'A downloads them');
  await use(A);
  eq((await store.getPage(pg1)).items.map(i => i.id), ['s-a-1', 't-a-1', 's-b-1'], 'A now has B’s stroke');
  eq((await store.getDoc(nbId)).title, 'Economics Y12', 'A now has the new title');
}

// ---------------------------------------------------------------- conflict: same page edited on two devices
{
  await use(A); tick();
  await draw(pg1, stroke('s-a-offline'));                  // A edits first (and stays offline)
  await use(B); tick();
  await draw(pg1, stroke('s-b-later'));                    // B edits later…
  await sync(B, backend, alice.id);                        // …and syncs first
  const ra = await sync(A, backend, alice.id);
  await use(A);
  const items = (await store.getPage(pg1)).items.map(i => i.id);
  ok(items.includes('s-b-later') && !items.includes('s-a-offline'), 'same page, two devices: the LATER edit wins on both (A’s older edit is replaced)');
  eq(await local.countDirty(), 0, 'the losing edit is not left in the queue');
  eq(ra.pushed, 0, 'the older edit was never written over the newer one');

  await use(B); tick();
  await draw(pg1, stroke('s-b-early'));                    // B edits first and does not sync yet
  await use(A); tick();
  await draw(pg1, stroke('s-a-latest'));                   // A edits later and syncs first
  await sync(A, backend, alice.id);
  const rb = await sync(B, backend, alice.id);             // B's push is refused as stale, then B pulls
  ok(rb.stale === 1 || rb.applied >= 1, 'the older upload is refused by the account');
  await use(B);
  const itemsB = (await store.getPage(pg1)).items.map(i => i.id);
  ok(itemsB.includes('s-a-latest') && !itemsB.includes('s-b-early'), 'the device with the older edit ends up with the newer version');
  eq(await local.countDirty(), 0, 'and its queue is empty');
  eq((await sync(A, backend, alice.id)).applied, 0, 'the winner keeps its version');
}

// ---------------------------------------------------------------- conflict: different pages never collide
let pg2;
{
  await use(A); tick();
  pg2 = (await store.addPage(nbId)).id;
  await draw(pg2, text('t-a-p2', 'page two from A'));
  await sync(A, backend, alice.id); await sync(B, backend, alice.id);
  await use(A); tick(); await draw(pg1, stroke('s-a-p1'));
  await use(B); tick(); await draw(pg2, stroke('s-b-p2'));
  await sync(A, backend, alice.id); await sync(B, backend, alice.id); await sync(A, backend, alice.id);
  for (const dev of [A, B]) {
    await use(dev);
    ok((await store.getPage(pg1)).items.some(i => i.id === 's-a-p1') && (await store.getPage(pg2)).items.some(i => i.id === 's-b-p2'), `edits to different pages both survive on ${dev.name}`);
  }
}

// ---------------------------------------------------------------- conflict: a page added offline + a later rename
{
  await use(B); tick();
  const pg3 = (await store.addPage(nbId)).id;              // B adds a page (changes the page list) offline
  await draw(pg3, text('t-b-p3', 'added offline on B'));
  await use(A); tick();
  await store.patchDoc(nbId, { title: 'Econ (renamed later on A)' });
  await sync(A, backend, alice.id);
  await sync(B, backend, alice.id);                        // A's notebook record is newer than B's
  await use(B);
  let d = await store.getDoc(nbId);
  ok(d.title === 'Econ (renamed later on A)' && d.pageIds.includes(pg3), 'B takes the newer title AND keeps the page it added');
  await sync(B, backend, alice.id); await sync(A, backend, alice.id);
  await use(A);
  d = await store.getDoc(nbId);
  ok(d.pageIds.includes(pg3) && (await store.getPage(pg3)).items[0].text === 'added offline on B', 'A receives the page that was added offline');
  eq(d.pageIds.length, 3, 'the notebook has three pages on A');
}

// ---------------------------------------------------------------- conflict: delete vs edit
{
  // edit LATER than the delete → the edit wins, the page comes back
  await use(A); tick();
  await store.deletePage(pg2);
  await use(B); tick();
  await draw(pg2, stroke('s-b-after-delete'));
  await sync(A, backend, alice.id); await sync(B, backend, alice.id); await sync(B, backend, alice.id); await sync(A, backend, alice.id);
  for (const dev of [A, B]) {
    await use(dev);
    const d = await store.getDoc(nbId), p = await store.getPage(pg2);
    ok(d.pageIds.includes(pg2) && p && p.items.some(i => i.id === 's-b-after-delete'), `a page edited AFTER it was deleted elsewhere is kept (${dev.name})`);
  }
  // delete LATER than the edit → the delete wins
  await use(B); tick();
  await draw(pg2, stroke('s-b-before-delete'));
  await use(A); tick();
  await store.deletePage(pg2);
  await sync(A, backend, alice.id); await sync(B, backend, alice.id); await sync(A, backend, alice.id);
  for (const dev of [A, B]) {
    await use(dev);
    const d = await store.getDoc(nbId);
    ok(!d.pageIds.includes(pg2) && !(await store.getPage(pg2)), `a page deleted AFTER the other device’s edit is gone (${dev.name})`);
    eq(await local.countDirty(), 0, `nothing left to upload on ${dev.name}`);
  }
  ok(backend.tables.page.get(alice.id + '/' + pg2).deleted === true, 'the account keeps a tombstone for the deleted page');
  eq(backend.tables.page.get(alice.id + '/' + pg2).data, {}, 'the tombstone holds no content');
}

// ---------------------------------------------------------------- deleting a whole notebook
{
  await use(A); tick();
  const wb = await store.createWhiteboard({ title: 'Mind map' });
  await sync(A, backend, alice.id); await sync(B, backend, alice.id);
  await use(B);
  ok(!!(await store.getDoc(wb.id)), 'B has the whiteboard');
  tick(); await draw(wb.pageIds[0], stroke('s-b-wb'));     // unsent edit on B
  await use(A); tick();
  await store.deleteDoc(wb.id);
  await sync(A, backend, alice.id);
  const rb = await sync(B, backend, alice.id);
  await use(B);
  ok(!(await store.getDoc(wb.id)) && !(await store.getPage(wb.pageIds[0])), 'deleting a notebook removes it and its pages on the other device');
  eq(await local.countDirty(), 0, 'B’s unsent edit to the deleted whiteboard is dropped, not uploaded as an orphan');
  eq(rb.pushed, 0, 'nothing was resurrected');

  // created and deleted before ever syncing → nothing is sent at all
  await use(A); tick();
  const before = backend.count(alice.id);
  const tmp = await store.createNotebook({ title: 'Oops' });
  await store.deleteDoc(tmp.id);
  const r = await sync(A, backend, alice.id);
  eq([r.pushed, backend.count(alice.id).docs], [0, before.docs], 'something created and deleted before a sync never reaches the account');
  eq(await local.countDirty(), 0, 'and leaves no queue rows');
}

// ---------------------------------------------------------------- images go to private storage, once
{
  const png = 'data:image/png;base64,' + Buffer.from('fake png bytes ' + 'x'.repeat(5000)).toString('base64');
  await use(A); tick();
  await draw(pg1, { id: 'img-1', type: 'image', x: 0, y: 0, w: 100, h: 100, src: png });
  await sync(A, backend, alice.id);
  const remotePage = backend.tables.page.get(alice.id + '/' + pg1);
  const remoteImg = remotePage.data.items.find(i => i.id === 'img-1');
  ok(/^fln-img:[0-9a-f]{64}\.png$/.test(remoteImg.src), 'the page row holds a reference, not the image');
  ok(JSON.stringify(remotePage.data).length < 3000, 'the page row stays small');
  eq(backend.count(alice.id).images, 1, 'the image is stored once in the user’s own folder');
  ok((await store.getPage(pg1)).items.find(i => i.id === 'img-1').src === png, 'the device still has the real image (works offline)');
  tick(); await draw(pg1, stroke('s-a-after-img'));
  await sync(A, backend, alice.id);
  eq(backend.uploads, 1, 'drawing on a page with a photo does not upload the photo again');
  await sync(B, backend, alice.id);
  await use(B);
  ok((await store.getPage(pg1)).items.find(i => i.id === 'img-1').src === png, 'the other device gets the identical image back');
  tick(); await draw(pg1, stroke('s-b-after-img'));
  await sync(B, backend, alice.id);
  eq(backend.uploads, 1, 'the second device does not upload it again either');
  eq(backend.count(bob.id).images, 0, 'no image in anyone else’s folder');
}

// ---------------------------------------------------------------- validation on the way in and out
{
  const evil = rowToPage({ id: 'page-evil-1', doc_id: 'doc-evil-01', updated_at: 5, data: { paper: 'x', items: [
    { id: 'a', type: 'image', src: 'javascript:alert(1)' }, { id: 'b', type: 'image', src: 'https://tracker.example/x.png' },
    { id: 'c', type: 'image', src: 'data:image/svg+xml;base64,PHN2Zz4=' }, { id: 'd', type: 'script', text: 'x' },
    { id: 'e', type: 'text', text: { toString: 1 } }, 'junk', null, { id: 'f', type: 'stroke' },
    { id: 'g', type: 'text', text: '<img src=x onerror=alert(1)>' }, { id: 'h', type: 'image', src: 'data:image/png;base64,AAAA' }] } });
  eq(evil.items.map(i => i.id), ['e', 'g', 'h'], 'a downloaded page keeps only well-formed items (no remote, script or SVG images)');
  eq(typeof evil.items[0].text, 'string', 'text is always a string');
  eq(evil.paper, { style: 'blank', color: 'white' }, 'bad paper settings fall back to defaults');
  const d = rowToDoc({ id: 'doc-evil-01', kind: 'notebook', title: 'a\u0000b\nc' + 'x'.repeat(500), updated_at: 5, data: { pageIds: ['ok-page-01', 7, '../x'], cover: { image: 'https://tracker.example/c.png', color: '#fff' } } });
  ok(d.title.length === 200 && !/[\u0000-\u001f]/.test(d.title), 'titles are cleaned and limited');
  eq(d.pageIds, ['ok-page-01'], 'page lists keep only valid ids');
  eq(d.cover.image, null, 'a cover can only be an embedded image, never a link');
  const css = rowToDoc({ id: 'doc-evil-02', kind: 'notebook', title: 't', updated_at: 5, data: { pageIds: [], cover: { color: 'red;background:url(https://tracker.example/x)', pattern: 'dots" onload="x', emoji: 'x'.repeat(99) }, paper: { style: '../x', color: 'white' } } });
  eq([css.cover.color, css.cover.pattern, css.cover.emoji, css.paper.style], ['#3B5BDB', 'plain', null, 'lined'], 'cover colour, pattern and paper values that are not plain are replaced by defaults (no CSS injection)');
  eq(rowToDoc({ id: 'doc-evil-01', kind: 'virus', data: {} }), null, 'unknown kinds are refused');
  eq(rowToPage({ id: 'x', doc_id: 'doc-evil-01' }), null, 'bad ids are refused');
  await rejects(async () => docToRow({ id: 'bad id', kind: 'notebook', pageIds: [] }, 1), /invalid-id/, 'a bad id is never uploaded');
  await rejects(async () => pageToRow({ id: 'page-big-01', docId: 'doc-evil-01', items: [{ id: 'z', type: 'text', text: 'x'.repeat(8100000) }] }, 1), /too-large/, 'an oversized page is refused before upload');
  const row = docToRow({ id: 'doc-fine-01', kind: 'notebook', title: 't', pageIds: [], updatedAt: 9, cover: { color: '#fff' } }, 1234);
  eq(Object.keys(row).sort(), ['data', 'deleted', 'id', 'kind', 'title', 'updated_at'], 'an uploaded row has no owner or user field at all');

  // an item that cannot be uploaded is set aside instead of retried forever
  await use(A); tick();
  await store.putDoc({ id: 'bad id!', kind: 'notebook', title: 'From a strange backup', pageIds: [], createdAt: 1, updatedAt: 1 });
  const r = await sync(A, backend, alice.id);
  eq(r.blocked, 1, 'an item with an invalid id is set aside');
  const r2 = await sync(A, backend, alice.id);
  eq([r2.blocked, r2.pushed, r2.left], [0, 0, 0], 'and is not retried in a loop');
  await store.deleteDoc('bad id!');
  await local.dropDirty('doc', 'bad id!', (await local.dirty()).find(x => x.id === 'bad id!').at);
}

// ---------------------------------------------------------------- failures never lose the queue; 401 is recognised
{
  await use(A); tick();
  await draw(pg1, stroke('s-a-during-outage'));
  const queued = await local.countDirty();
  backend.failNext = { status: 503, message: 'upstream unavailable' };
  await rejects(() => sync(A, backend, alice.id), /unavailable/, 'a server error surfaces to the scheduler');
  eq(await local.countDirty(), queued, 'the queue is intact after a failed round');

  // session revoked: every request now answers 401
  const remote = A.remotes.get(alice.id);
  backend.revoke(remote.session.access_token);
  let caught = null;
  try { await sync(A, backend, alice.id); } catch (e) { caught = e; }
  ok(caught && isAuthFailure(caught), 'an expired or revoked session is recognised as an auth failure (401)');
  eq(await local.countDirty(), queued, 'nothing is lost while signed out');
  ok((await store.getPage(pg1)).items.some(i => i.id === 's-a-during-outage'), 'the notes stay on the device');
  A.remotes.delete(alice.id);                              // "sign in again"
  const r = await sync(A, backend, alice.id);
  ok(r.pushed >= 1 && r.left === 0, 'after signing in again the waiting changes are uploaded');

  // an account the database does not trust gets nothing
  const mallory = backend.addUser({ email: 'mallory@example.com', name: 'M', verified: false });
  const M = makeDevice('M'); track(M);
  await use(M); await store.createNotebook({ title: 'x' });
  await rejects(() => sync(M, backend, mallory.id), /row-level security/, 'an unverified account cannot sync');
  eq(backend.count(mallory.id).docs, 0, 'and stores nothing');
}

// ---------------------------------------------------------------- final convergence
{
  await sync(B, backend, alice.id, { full: true }); await sync(A, backend, alice.id, { full: true }); await sync(B, backend, alice.id, { full: true });
  const snap = async dev => {
    await use(dev);
    const docs = await store.listDocs();
    const out = [];
    for (const d of docs.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const pages = [];
      for (const pid of d.pageIds) { const p = await store.getPage(pid); pages.push([pid, p.items.map(i => i.id)]); }
      out.push([d.id, d.title, pages]);
    }
    return out;
  };
  eq(await snap(A), await snap(B), 'after everything, both devices hold exactly the same notes');
  const engine = createSync({ local, remote: B.remotes.get(alice.id) });
  eq(await engine.verify(), true, 'and the account is verified to match');
}

done('sync');
process.exit(0);

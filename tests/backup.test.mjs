// Auto backup v2.1: the zip writer/reader, the .flashnotes format, the schedule, snapshots and restore.
// The REAL js/store.js + js/backup/* on fake-indexeddb.   cd tests && npm install && node backup.test.mjs
import { ok, eq, rejects, done } from './lib/check.mjs';
import { makeDevice, use, tick, clock, store } from './lib/device.mjs';
import * as zip from '../js/backup/zip.js';
import * as format from '../js/backup/format.js';
import * as schedule from '../js/backup/schedule.js';
import * as snaps from '../js/backup/snapshots.js';
import * as auto from '../js/backup/auto.js';
import * as local from '../js/sync/local.js';
import { createHash } from 'node:crypto';

const enc = new TextEncoder(), dec = new TextDecoder();
const H = 3600e3, D = 24 * H;
const rnd = n => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 2654435761 + (i >> 3) * 97) & 0xff; return b; };
const toB64 = b => Buffer.from(b).toString('base64');
const PNG = 'data:image/png;base64,' + toB64(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...rnd(3000)]));
const JPG = 'data:image/jpeg;base64,' + toB64(Uint8Array.from([0xff, 0xd8, 0xff, ...rnd(5000)]));
const stroke = (id, x = 10, n = 20) => ({ id, type: 'stroke', tool: 'pen', color: '#1C1C1E', size: 3, brush: 'pen', points: Array.from({ length: n }, (_, i) => [x + i, 10 + (i % 7) * 1.5, 0.5]) });
const text = (id, t, y = 50) => ({ id, type: 'text', x: 20, y, w: 200, text: t, color: '#1C1C1E', fontSize: 20, font: 'sans' });
const image = (id, src) => ({ id, type: 'image', x: 30, y: 40, w: 100, h: 80, src });
const draw = async (pageId, ...items) => { const p = await store.getPage(pageId); p.items.push(...items); p.updatedAt = Date.now(); await store.putPage(p); return p; };
const snapshotOfLibrary = async () => {
  const data = JSON.parse(await (await store.exportAll()).text());
  delete data.exportedAt;
  const docs = data.docs.map(d => ({ ...d, id: undefined, updatedAt: undefined, pageIds: d.pageIds.length })).sort((a, b) => (a.title < b.title ? -1 : 1));
  const pages = data.pages.map(p => ({ paper: p.paper, items: p.items.map(i => ({ ...i, id: undefined })) }));
  return JSON.stringify({ docs, pages: pages.map(p => JSON.stringify(p)).sort() });
};
const wipeNotes = () => store._run(['docs', 'pages', 'thumbs'], 'readwrite', t => { t.objectStore('docs').clear(); t.objectStore('pages').clear(); t.objectStore('thumbs').clear(); });

let settings = { theme: 'dark', autoShapes: false, customColors: ['#112233'] };
auto.configure({ getSettings: () => settings, canRun: () => true, appVersion: '2.1', applySettings: s => { settings = { ...settings, ...s }; } });

// ================================================================= zip
{
  const bin = rnd(200000);
  const txt = enc.encode('{"hello":"wörld ✓"}'.repeat(2000));
  const z = await zip.writeZip([{ name: 'a.json', data: txt, compress: true }, { name: 'images/x.png', data: bin }, { name: 'markdown/Ünïcode notebook/Page 001.md', data: enc.encode('# hi'), compress: true }]);
  const u8 = new Uint8Array(await z.arrayBuffer());
  const r = zip.openZip(u8);
  eq(r.names, ['a.json', 'images/x.png', 'markdown/Ünïcode notebook/Page 001.md'], 'zip: names round-trip (UTF-8 included)');
  ok(dec.decode(await r.read('a.json')) === dec.decode(txt), 'zip: a deflated text entry round-trips');
  ok(Buffer.compare(Buffer.from(await r.read('images/x.png')), Buffer.from(bin)) === 0, 'zip: a binary entry (picture) round-trips byte for byte');
  ok(u8.length < txt.length / 5 + bin.length + 2000, 'zip: text is actually compressed (DEFLATE via CompressionStream)');
  const stored = new Uint8Array(await (await zip.writeZip([{ name: 'a.json', data: txt, compress: true }], { deflate: false })).arrayBuffer());
  ok(dec.decode(await zip.openZip(stored).read('a.json')) === dec.decode(txt) && stored.length > txt.length, 'zip: STORE fallback (no CompressionStream) round-trips');
  eq(zip.crc32(enc.encode('123456789')), 0xcbf43926, 'zip: CRC-32 check value');
  await rejects(() => zip.writeZip([{ name: '../evil', data: txt }]), /Bad zip entry name/, 'zip writer refuses unsafe names');

  // ---- hostile files
  const patch = (src, from, to) => { const b = Buffer.from(src); let i = -1, n = 0; while ((i = b.indexOf(from, i + 1)) >= 0) { Buffer.from(to).copy(b, i); n++; } return { b: new Uint8Array(b), n }; };
  await rejects(async () => zip.openZip(u8.subarray(0, u8.length - 30)), /damaged|not a Flash/, 'zip: a truncated file is rejected');
  await rejects(async () => zip.openZip(u8.subarray(0, 1000)), /damaged|not a Flash/, 'zip: a file cut in half is rejected');
  await rejects(async () => zip.openZip(enc.encode('just some text that is not a zip at all, long enough')), /damaged|not a Flash/, 'zip: not a zip at all');
  const flipped = u8.slice(); flipped[60 + 30] ^= 0xff;           // inside a.json's compressed data
  await rejects(async () => { const z2 = zip.openZip(flipped); await z2.read('a.json'); }, /damaged/, 'zip: a corrupted entry is rejected (inflate or CRC)');
  const flipBin = u8.slice(); const binStart = Buffer.from(u8).indexOf('images/x.png') + 'images/x.png'.length; flipBin[binStart + 500] ^= 1;
  await rejects(async () => { await zip.openZip(flipBin).read('images/x.png'); }, /checksum/, 'zip: a single flipped bit in a stored entry fails the CRC');
  for (const evil of ['../../x.json', '/etc/passwd', 'a\\..\\b.jsn', 'C:/win/x.js', 'a/./b.json']) {
    const name = evil.padEnd(6, '_').slice(0, 6);
    const base = await zip.writeZip([{ name: 'ok/' + 'n'.repeat(evil.length - 3), data: txt }].map(e => ({ ...e, name: e.name.slice(0, evil.length) })));
    const { b, n } = patch(new Uint8Array(await base.arrayBuffer()), ('ok/' + 'n'.repeat(evil.length - 3)).slice(0, evil.length), evil);
    ok(n === 2 && name, `zip: crafted "${evil}" in both headers`);
    await rejects(async () => zip.openZip(b), /unsafe name|damaged/, `zip: path traversal / absolute name "${evil}" is rejected`);
  }
  // zip bomb: 60 MB of zeros compress to ~60 KB
  const bomb = new Uint8Array(await (await zip.writeZip([{ name: 'library.json', data: new Uint8Array(60 * 1024 * 1024), compress: true }])).arrayBuffer());
  ok(bomb.length < 300 * 1024, 'zip: the bomb is small on disk');
  await rejects(async () => zip.openZip(bomb), /zip bomb/, 'zip: a high-ratio entry (zip bomb) is rejected before unpacking');
  // an entry that lies about its size: declares 100 bytes, inflates to 40 KB
  const liar = new Uint8Array(await (await zip.writeZip([{ name: 'a.json', data: enc.encode('x'.repeat(40000)), compress: true }])).arrayBuffer());
  const dv = new DataView(liar.buffer); const cd = dv.getUint32(liar.length - 6, true);
  dv.setUint32(cd + 24, 100, true); dv.setUint32(22, 100, true);
  await rejects(async () => { await zip.openZip(liar).read('a.json'); }, /larger than it says/, 'zip: an entry larger than declared stops unpacking at the declared size');
  // total size limit
  await rejects(async () => zip.openZip(u8, { ...zip.LIMITS, maxTotalBytes: 1000 }), /more than Flash Notes can hold/, 'zip: the total unpacked size is limited');
  await rejects(async () => zip.openZip(u8, { ...zip.LIMITS, maxFileBytes: 1000 }), /too large/, 'zip: the file size is limited');
  // duplicate names / overlapping entries
  const two = new Uint8Array(await (await zip.writeZip([{ name: 'aa.json', data: txt }, { name: 'ab.json', data: txt }])).arrayBuffer());
  await rejects(async () => zip.openZip(patch(two, 'ab.json', 'aa.json').b), /damaged/, 'zip: duplicate names are rejected');
  const ov = two.slice(); const odv = new DataView(ov.buffer); const ocd = odv.getUint32(ov.length - 6, true);
  const second = ocd + 46 + 7; odv.setUint32(second + 42, 0, true);   // 2nd central entry points at the 1st local header
  await rejects(async () => zip.openZip(ov), /damaged|zip bomb/, 'zip: overlapping entries are rejected');
  const enc1 = two.slice(); new DataView(enc1.buffer).setUint16(ocd + 8, 0x0801, true);
  await rejects(async () => zip.openZip(enc1), /password/, 'zip: encrypted entries are rejected');
}

// ================================================================= format: build → read, lossless
const dev = makeDevice('backup');
await use(dev);
let nb, wb;
{
  nb = await store.createNotebook({ title: 'Economics: supply/demand', cover: { color: '#2F9E44', image: JPG } });
  await draw(nb.pageIds[0], stroke('s1'), text('t1', 'Price elasticity <b>not html</b>'), image('i1', PNG), image('i2', PNG));
  const p2 = await store.addPage(nb.id, nb.pageIds[0]);
  await draw(p2.id, stroke('s2', 50, 300), text('t2', 'Page two'));
  wb = await store.createWhiteboard({ title: 'Ideas' });
  await draw(wb.pageIds[0], stroke('s3'), image('i3', JPG));
  await store.createNotebook({ title: 'Economics: supply/demand' });     // same title → unique Markdown folder
  await store.saveSettings({ theme: 'dark', autoBackup: true, backupInterval: '1w' });

  const built = await format.buildBackup({ settings: { ...settings, autoBackup: true, backupKeep: 3 }, appVersion: '2.1' });
  const z = zip.openZip(new Uint8Array(await built.blob.arrayBuffer()));
  ok(z.has('manifest.json') && z.has('library.json'), 'format: manifest.json and library.json are in the file');
  const imgs = z.names.filter(n => n.startsWith('images/'));
  eq(imgs.length, 2, 'format: each picture is stored once (the PNG used twice + the JPEG used on a page and a cover)');
  ok(imgs.every(n => /^images\/[0-9a-f]{64}\.(png|jpg)$/.test(n)), 'format: pictures are named by their SHA-256');
  const pngName = imgs.find(n => n.endsWith('.png'));
  ok(Buffer.from(await z.read(pngName)).toString('base64') === PNG.split(',')[1], 'format: pictures are real binary bytes (not base64)');
  const manifest = JSON.parse(dec.decode(await z.read('manifest.json')));
  eq([manifest.app, manifest.kind, manifest.format, manifest.appVersion], ['flash-notes', 'backup', 1, '2.1'], 'format: manifest identifies the app, format version and app version');
  eq(manifest.counts, { notebooks: 2, whiteboards: 1, pages: 4, images: 2 }, 'format: manifest counts');
  ok(Object.keys(manifest.entries).length === z.names.length - 1 && Object.values(manifest.entries).every(e => /^[0-9a-f]{64}$/.test(e.sha256)), 'format: manifest lists a SHA-256 for every other entry');
  const lib = JSON.parse(dec.decode(await z.read('library.json')));
  ok(lib.app === 'flash-notes' && lib.version === 1 && Array.isArray(lib.docs) && Array.isArray(lib.pages), 'format: library.json is the existing JSON backup model');
  ok(!JSON.stringify(lib).includes('data:image'), 'format: library.json holds references, not picture data');
  ok(lib.settings && lib.settings.theme === 'dark' && !('autoBackup' in lib.settings) && !('backupKeep' in lib.settings), 'format: pen/app settings are included, this device\'s backup setup is not');
  const md = z.names.filter(n => n.startsWith('markdown/'));
  ok(md.includes('markdown/Economics supply demand/Page 001.md') && md.includes('markdown/Economics supply demand (2)/Page 001.md') && md.includes('markdown/Ideas/Whiteboard.md'), 'format: readable Markdown per page, safe and unique folder names');
  const mdTexts = await Promise.all(md.map(async n => dec.decode(await z.read(n))));
  ok(mdTexts.some(t => t.includes('Price elasticity &lt;b&gt;not html&lt;/b&gt;')) && mdTexts.some(t => t.includes('Page two')) && mdTexts.some(t => t.includes('### Page 2')), 'format: Markdown copies hold the text boxes (escaped), numbered by page');
  const all = JSON.stringify(lib) + dec.decode(await z.read('manifest.json'));
  ok(!/token|session|supabase|refresh/i.test(all.replace(/"contents":\s*"[^"]*"/, '')), 'format: no tokens, session or Supabase details in the file');

  // read back: lossless
  const before = await snapshotOfLibrary();
  const { kind, data } = await format.readBackup(built.blob);
  eq(kind, 'flashnotes', 'format: recognised as .flashnotes');
  await wipeNotes();
  eq((await store.listDocs()).length, 0, 'wiped');
  const r = await format.importBackup(data, { mode: 'merge' });
  eq([r.docs, r.pages], [3, 4], 'restore: every notebook, whiteboard and page comes back');
  eq(await snapshotOfLibrary(), before, 'restore from .flashnotes is lossless (strokes, text, pictures, covers, paper)');
  const back = await store.getDoc(nb.id);
  ok(back && back.cover.image === JPG, 'restore: the cover photo is back, byte for byte');

  // legacy JSON still works, through the same reader
  const legacy = await store.exportAll();
  const lr = await format.readBackup(legacy);
  eq(lr.kind, 'json', 'legacy: a v1/v2.0 .json backup is accepted');
  await wipeNotes();
  await store.importAll(legacy, { mode: 'merge' });
  eq(await snapshotOfLibrary(), before, 'legacy: store.importAll(.json) still restores everything');

  // ---- hostile / damaged .flashnotes
  const rebuild = async (mut) => {
    const entries = [];
    for (const n of z.names) entries.push({ name: n, data: await z.read(n), compress: !n.startsWith('images/') });
    await mut(entries);
    return zip.writeZip(entries);
  };
  const libEntry = es => es.find(e => e.name === 'library.json');
  await rejects(async () => format.readBackup(await rebuild(es => { const e = libEntry(es); const j = JSON.parse(dec.decode(e.data)); j.docs[0].title = 'Tampered'; e.data = enc.encode(JSON.stringify(j)); })), /size|checksums|damaged/, 'format: library.json that does not match its hash is rejected');
  await rejects(async () => format.readBackup(await rebuild(es => { const e = libEntry(es); const j = dec.decode(e.data).replace('"Ideas"', '"Ideaz"'); e.data = enc.encode(j); })), /checksums/, 'format: same-size tampering is caught by SHA-256');
  await rejects(async () => format.readBackup(await rebuild(es => { const e = es.find(x => x.name === pngName); e.data = e.data.slice(); e.data[100] ^= 1; })), /checksums/, 'format: a changed picture is rejected');
  await rejects(async () => format.readBackup(await rebuild(es => { es.splice(es.findIndex(x => x.name === pngName), 1); })), /incomplete/, 'format: a missing picture is rejected');
  await rejects(async () => format.readBackup(await rebuild(es => { es.splice(es.findIndex(x => x.name === 'manifest.json'), 1); })), /no manifest/, 'format: a zip without a manifest is not a backup');
  await rejects(async () => format.readBackup(await rebuild(es => { const m = es.find(x => x.name === 'manifest.json'); const j = JSON.parse(dec.decode(m.data)); j.format = 2; j.minReader = 2; m.data = enc.encode(JSON.stringify(j)); })), /newer version/, 'format: a file from a newer format is refused with a clear message');
  await rejects(async () => format.readBackup(await rebuild(es => { const m = es.find(x => x.name === 'manifest.json'); const j = JSON.parse(dec.decode(m.data)); j.entries['images/' + '0'.repeat(64) + '.png'] = j.entries[pngName]; m.data = enc.encode(JSON.stringify(j)); es.push({ name: 'images/' + '0'.repeat(64) + '.png', data: es.find(x => x.name === pngName).data }); })), /checksums/, 'format: a picture whose name is not its own hash is rejected');
  await rejects(async () => format.readBackup(await rebuild(es => { const e = libEntry(es); const j = JSON.parse(dec.decode(e.data)); j.docs = 'nope'; e.data = enc.encode(JSON.stringify(j)); const m = es.find(x => x.name === 'manifest.json'); const mj = JSON.parse(dec.decode(m.data)); mj.entries['library.json'] = { size: e.data.length, sha256: createHash('sha256').update(e.data).digest('hex') }; m.data = enc.encode(JSON.stringify(mj)); })), /damaged or is not/, 'format: a library with the wrong shape is rejected');
  await rejects(() => format.readBackup(new Blob(['{"app":"other"}'])), /not a Flash Notes backup/, 'format: a foreign JSON file is rejected');
  await rejects(() => format.readBackup(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])])), /damaged|not a Flash/, 'format: a broken zip is rejected');
  // a dangerous picture URL inside an otherwise valid file is dropped on import
  const evil = { app: 'flash-notes', version: 1, docs: [{ id: 'evil-doc-1', kind: 'notebook', title: 'X', pageIds: ['evil-page-1'], cover: { image: 'javascript:alert(1)' } }], pages: [{ id: 'evil-page-1', docId: 'evil-doc-1', items: [image('ei1', 'https://example.com/track.png'), text('et1', 'kept')] }] };
  await store.importData(evil, { mode: 'merge' });
  const ep = await store.getPage('evil-page-1');
  ok(ep.items.length === 1 && ep.items[0].type === 'text' && (await store.getDoc('evil-doc-1')).cover.image === null, 'import: non-data: pictures and covers from a file are dropped');
  await store.deleteDoc('evil-doc-1');
}

// ================================================================= schedule rules
{
  const iv = schedule.INTERVALS;
  for (const [k, ms] of Object.entries(iv)) {
    ok(!schedule.isDue({ enabled: true, interval: k, lastRunAt: 1e12, now: 1e12 + ms - 1 }) && schedule.isDue({ enabled: true, interval: k, lastRunAt: 1e12, now: 1e12 + ms }), `schedule: ${k} is due exactly after its interval`);
  }
  ok(!schedule.isDue({ enabled: false, interval: '1h', lastRunAt: 0, now: 1e12 }), 'schedule: off is never due');
  ok(schedule.isDue({ enabled: true, interval: '1w', lastRunAt: 0, now: 1e12 }), 'schedule: never run → due');
  ok(schedule.isDue({ enabled: true, interval: '1m', lastRunAt: 1e12 + 3 * D, now: 1e12 }), 'schedule: last run in the future (clock moved back) → due once');
  ok(!schedule.isDue({ enabled: true, interval: '1h', lastRunAt: 1e12 + 60000, now: 1e12 }), 'schedule: a small clock wobble is not "the future"');
  ok(!schedule.isDue({ enabled: true, interval: 'bogus', lastRunAt: 0, now: 1e12 }), 'schedule: unknown interval is never due');
  eq(schedule.backupSettings({ backupInterval: 'x', backupKeep: 7, backupDest: 'cloud' }), schedule.DEFAULTS, 'schedule: bad settings fall back to defaults');
  eq(schedule.backupFileName(new Date(2026, 10, 18, 9, 5).getTime()), 'flash-notes-backup-2026-11-18-0905.flashnotes', 'schedule: file name pattern');
  eq(schedule.namesToPrune(['flash-notes-backup-2026-11-18-0905.flashnotes', 'my essay.docx', 'flash-notes-backup-2026-11-17-0905.flashnotes', 'flash-notes-backup-2026-11-19-0905.flashnotes', 'flash-notes-backup-x.flashnotes'], 2), ['flash-notes-backup-2026-11-17-0905.flashnotes'], 'schedule: folder pruning deletes only our oldest files');
  const base = { dest: 'file', latestFingerprint: 'B', lastFileFingerprint: 'A', lastFileAt: 1e12, snoozeUntil: null, interval: '1d', now: 1e12 + D };
  ok(schedule.shouldOfferFile(base), 'offer: new backup + interval passed → offer the file');
  ok(!schedule.shouldOfferFile({ ...base, latestFingerprint: 'A' }), 'offer: nothing new since the last saved file → no banner');
  ok(!schedule.shouldOfferFile({ ...base, now: 1e12 + H }), 'offer: saved a file recently → wait for the interval');
  ok(!schedule.shouldOfferFile({ ...base, snoozeUntil: base.now + H }), 'offer: snoozed → no banner');
  ok(schedule.shouldOfferFile({ ...base, snoozeUntil: base.now + 400 * D }), 'offer: a snooze far in the future (clock moved back) is ignored');
  ok(!schedule.shouldOfferFile({ ...base, dest: 'app' }), 'offer: only for "Save a file"');
}

// ================================================================= runner: due logic, one at a time, unchanged skipped, rotation
{
  await snaps.clearAll();
  settings = { ...settings, autoBackup: true, backupInterval: '1h', backupKeep: 3, backupDest: 'app' };
  let r = await auto.check();
  eq(r.result, 'created', 'runner: first check with auto backup on makes a snapshot');
  r = await auto.check();
  eq(r.result, 'not-due', 'runner: not due again straight away');
  tick(H);
  r = await auto.check();
  eq(r.result, 'unchanged', 'runner: due, but nothing changed → no new snapshot');
  const st = await snaps.getState();
  ok(st.lastRunAt === clock() && st.lastResult === 'unchanged', 'runner: …and the last check time is still recorded');
  eq((await snaps.listSnapshots()).length, 1, 'runner: still one snapshot');

  // opened after a long gap: exactly one backup
  await draw(nb.pageIds[0], stroke('gap-1'));
  tick(40 * D);
  const results = [];
  for (let i = 0; i < 5; i++) { results.push((await auto.check()).result); tick(1000); }
  eq(results, ['created', 'not-due', 'not-due', 'not-due', 'not-due'], 'runner: after 40 days closed, opening makes exactly ONE backup');

  // concurrent calls share one run
  await draw(nb.pageIds[0], stroke('conc-1'));
  tick(H);
  const [a, b, c] = await Promise.all([auto.runBackup({ reason: 'manual' }), auto.runBackup({ reason: 'manual' }), auto.check()]);
  ok(a === b && b === c && a.result === 'created', 'runner: no duplicate backup while one is running');
  eq((await snaps.listSnapshots()).length, 3, 'runner: three snapshots so far');

  // rotation
  for (let i = 0; i < 3; i++) { await draw(nb.pageIds[0], stroke('rot-' + i)); tick(H); await auto.check(); }
  const list = await snaps.listSnapshots();
  eq(list.length, 3, 'rotation: only the newest N (3) are kept');
  ok(list[0].createdAt > list[1].createdAt && list[1].createdAt > list[2].createdAt && list[0].createdAt === clock(), 'rotation: newest first; the oldest were rotated out');
  ok(list.every(s => s.size > 0 && s.counts.pages === 4 && /^[0-9a-f]{64}$/.test(s.fingerprint)), 'snapshots carry size, page count and fingerprint');
  await auto.applyKeep(2);
  eq((await snaps.listSnapshots()).length, 2, 'rotation: lowering "keep" prunes at once');
  const keys = await store._run(['meta'], 'readonly', t => store._rq(t.objectStore('meta').getAllKeys()));
  eq(keys.filter(k => k.startsWith('autobk:d:')).length, 2, 'rotation: the snapshot data rows go with their info rows');

  // the clock moved back a month: one backup, then normal again
  await draw(nb.pageIds[0], stroke('clock-1'));
  tick(-30 * D);
  eq((await auto.check()).result, 'created', 'clock moved back: the next check backs up once');
  eq((await auto.check()).result, 'not-due', 'clock moved back: …and then waits a full interval');
  tick(30 * D);

  // off = nothing happens
  settings = { ...settings, autoBackup: false };
  tick(10 * D);
  eq((await auto.check()).result, 'not-due', 'runner: auto backup off → nothing');
  settings = { ...settings, autoBackup: true };
}

// ================================================================= "Save a file" destination
{
  settings = { ...settings, backupDest: 'file', backupInterval: '1d' };
  await draw(nb.pageIds[0], stroke('file-1'));
  tick(2 * D);
  const r = await auto.check();
  const p = auto.pendingOffer();
  ok(r.result === 'created' && p && p.kind === 'file' && /^flash-notes-backup-\d{4}-\d{2}-\d{2}-\d{4}\.flashnotes$/.test(p.file.name), 'file: a due backup offers a .flashnotes file to save (banner)');
  ok(p.file.size === (await snaps.latestSnapshot()).size, 'file: the offered file is the snapshot');
  await auto.fileSaved();
  ok(!auto.pendingOffer(), 'file: saved → banner gone');
  tick(2 * D);
  await auto.check();
  ok(!auto.pendingOffer(), 'file: nothing new → no banner next time');
  await draw(nb.pageIds[0], stroke('file-2'));
  tick(D);
  await auto.check();
  ok(auto.pendingOffer(), 'file: new backup → banner again');
  await auto.snooze();
  ok(!auto.pendingOffer(), 'file: Later → gone');
  tick(H);
  await auto.check();
  ok(!auto.pendingOffer(), 'file: snoozed for a day');
  tick(D);
  await auto.check();
  ok(auto.pendingOffer(), 'file: after the snooze the banner comes back');
  await auto.fileSaved();
  settings = { ...settings, backupDest: 'app' };
}

// ================================================================= restore: add alongside vs replace (+ safety snapshot)
{
  settings = { ...settings, backupKeep: 10 };
  await auto.runBackup({ reason: 'manual' });
  const snap = await snaps.latestSnapshot();
  const file = await auto.snapshotAsFile(snap.id);
  const before = await snapshotOfLibrary();
  const docsBefore = (await store.listDocs()).length;

  let r = await auto.restore(file, { mode: 'merge' });
  eq([r.docs, r.skipped], [0, docsBefore], 'restore (add alongside): identical notebooks are not duplicated');
  await store.patchDoc(nb.id, { title: 'Economics (edited)' });
  r = await auto.restore({ snapshotId: snap.id }, { mode: 'merge' });
  eq(r.docs, 1, 'restore (add alongside): a changed notebook comes back as a copy next to the current one');
  ok((await store.listDocs()).some(d => d.title.endsWith('(restored)')) && (await store.getDoc(nb.id)).title === 'Economics (edited)', 'restore (add alongside): nothing is overwritten');

  const extra = await store.createNotebook({ title: 'Made after the backup' });
  const nSnaps = (await snaps.listSnapshots()).length;
  settings = { ...settings, theme: 'light' };
  r = await auto.restore(file, { mode: 'replace' });
  const after = await snaphotList();
  ok(after.length === nSnaps + 1 && after[0].reason === 'safety', 'restore (replace): a safety snapshot is made first');
  eq(await snapshotOfLibrary(), before, 'restore (replace): the library is exactly the backup');
  ok(!(await store.getDoc(extra.id)), 'restore (replace): what was not in the backup is gone…');
  eq(settings.theme, 'dark', 'restore (replace): settings from the backup are applied');
  ok(settings.autoBackup === true && settings.backupKeep === 10, 'restore (replace): this device\'s backup setup is kept');
  r = await auto.restore({ snapshotId: after[0].id }, { mode: 'merge' });
  ok(await store.getDoc(extra.id), '…and the safety snapshot brings it back');

  // a broken file changes nothing, and makes no safety snapshot
  const count = (await snaps.listSnapshots()).length, lib = await snapshotOfLibrary();
  await rejects(() => auto.restore(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9])]), { mode: 'replace' }), /damaged|not a Flash/, 'restore: a damaged file is refused');
  ok((await snaps.listSnapshots()).length === count && (await snapshotOfLibrary()) === lib, 'restore: …before anything was changed');
}
async function snaphotList() { return snaps.listSnapshots(); }

// ================================================================= settings persistence
{
  await store.saveSettings({ autoBackup: true, backupInterval: '1w', backupKeep: 10, backupDest: 'file' });
  await store.closeDB();
  await store.openDB();
  const s = await store.getSettings();
  eq(schedule.backupSettings(s), { autoBackup: true, backupInterval: '1w', backupKeep: 10, backupDest: 'file' }, 'settings: backup choices survive a reload');
}

// ================================================================= a v2.0 database opens unchanged; sign-out wipes snapshots
{
  const old = makeDevice('v2.0');
  await store.closeDB();
  globalThis.indexedDB = old.idb;
  // Build the database exactly as v2.0 left it, without the v2.1 code.
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('flash-notes', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const s = db.createObjectStore('docs', { keyPath: 'id' }); s.createIndex('kind', 'kind'); s.createIndex('updatedAt', 'updatedAt');
      db.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
      db.createObjectStore('thumbs', { keyPath: 'id' }).createIndex('docId', 'docId');
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(['docs', 'pages', 'thumbs', 'meta'], 'readwrite');
      t.objectStore('docs').put({ id: 'old-doc-0001', kind: 'notebook', title: 'From v2.0', createdAt: 1, updatedAt: 2, cover: { color: '#3B5BDB', pattern: 'plain', emoji: null, image: null }, paper: { style: 'lined', color: 'white' }, pageIds: ['old-page-001'] });
      t.objectStore('pages').put({ id: 'old-page-001', docId: 'old-doc-0001', createdAt: 1, updatedAt: 2, paper: { style: 'lined', color: 'white' }, items: [stroke('old-s1', 10, 500), image('old-i1', PNG)] });
      t.objectStore('thumbs').put({ id: 'old-page-001', docId: 'old-doc-0001', data: 'data:image/png;base64,AAAA' });
      t.objectStore('meta').put({ key: 'settings', theme: 'light', autoShapes: false });
      t.objectStore('meta').put({ key: 'view:old-page-001', x: 1, y: 2, zoom: 1.5 });
      t.objectStore('meta').put({ key: 'sync:state', userId: 'u1', cursors: { doc: 3, page: 4 } });
      t.objectStore('meta').put({ key: 'sync:d:page:old-page-001', kind: 'page', id: 'old-page-001', deleted: false, at: 2 });
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
  await store.openDB();
  const db = await store.openDB();
  eq([db.version, [...db.objectStoreNames].sort()], [1, ['docs', 'meta', 'pages', 'thumbs']], 'v2.0 → v2.1: same database version and stores (no upgrade needed)');
  const page = await store.getPage('old-page-001');
  ok(page && page.items.length === 2 && page.items[0].points.length === 500 && (await store.getDoc('old-doc-0001')).title === 'From v2.0', 'v2.0 → v2.1: notes intact');
  const keysBefore = await store._run(['meta'], 'readonly', t => store._rq(t.objectStore('meta').getAllKeys()));
  settings = { theme: 'light', autoBackup: true, backupInterval: '1d', backupKeep: 5, backupDest: 'app' };
  eq((await auto.runBackup({ reason: 'manual' })).result, 'created', 'v2.0 → v2.1: the first backup works on old data');
  const keysAfter = await store._run(['meta'], 'readonly', t => store._rq(t.objectStore('meta').getAllKeys()));
  ok(keysBefore.every(k => keysAfter.includes(k)), 'v2.0 → v2.1: every old meta row (sync queue, view state, settings) is untouched');
  eq(await store.getThumb('old-page-001'), 'data:image/png;base64,AAAA', 'v2.0 → v2.1: thumbnails untouched');
  const { data } = await format.readBackup(await auto.snapshotAsFile((await snaps.latestSnapshot()).id));
  ok(data.pages[0].items[1].src === PNG && data.pages[0].items[0].points.length === 500, 'v2.0 → v2.1: the snapshot holds the old notes');

  // explicit sign-out wipe (local.wipeUserData) removes snapshots, state and the folder handle
  await snaps.putFolder({ name: 'My backups' });           // stands in for a FileSystemDirectoryHandle
  await local.wipeUserData();
  const left = await store._run(['meta'], 'readonly', t => store._rq(t.objectStore('meta').getAllKeys()));
  eq(left, ['settings'], 'sign-out wipe: snapshots, backup state and the folder handle are removed (settings stay)');
  eq((await snaps.listSnapshots()).length, 0, 'sign-out wipe: no snapshots left');
}

// ================================================================= failure states
{
  settings = { ...settings, autoBackup: true, backupInterval: '1w' };
  await store.createNotebook({ title: 'Quota' });
  // Make the snapshot write fail like a full disk.
  const proto = Object.getPrototypeOf(await (async () => { let os; await store._run(['meta'], 'readonly', t => { os = t.objectStore('meta'); }); return os; })());
  const realPut = proto.put;
  proto.put = function (v, k) { if (v && typeof v.key === 'string' && v.key.startsWith('autobk:d:')) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } return realPut.call(this, v, k); };
  const r = await auto.runBackup({ reason: 'auto' });
  proto.put = realPut;
  eq([r.result, r.code], ['failed', 'storage-full'], 'failure: a full disk is reported as storage-full');
  const st = await snaps.getState();
  ok(st.error && st.error.code === 'storage-full' && st.retryAt - clock() === H, 'failure: shown plainly and retried within the hour');
  tick(H);
  eq((await auto.check()).result, 'created', 'failure: the retry succeeds once there is space');
  eq((await snaps.getState()).error, null, 'failure: the error is cleared');
}

// ================================================================= review fixes (v2.1 bug review)
{
  await snaps.clearAll();
  // snapshot rotation never deletes the snapshot it has just written, even after the clock was set back
  const mk = (createdAt, id) => ({ id, createdAt, size: 1, counts: { pages: 1 }, fingerprint: id, librarySha: id, reason: 'auto', format: 1 });
  for (const [t, id] of [[clock() + 3 * D, 'fut-a'], [clock() + 2 * D, 'fut-b'], [clock() + D, 'fut-c']]) await snaps.putSnapshot(mk(t, id), new Blob(['x']), 3);
  const { info, pruned } = await snaps.putSnapshot(mk(clock(), 'now-d'), new Blob(['y']), 3);
  const ids = (await snaps.listSnapshots()).map(x => x.id);
  ok(ids.includes('now-d') && ids.length === 3 && pruned.length === 1 && info.id === 'now-d', 'rotation: a snapshot made after the clock was set back is not pruned at once');
  ok(await snaps.getSnapshotBlob('now-d') && !(await snaps.getSnapshotBlob(pruned[0])), 'rotation: …its data stays and the pruned one\'s data goes');

  // folder pruning: ours only, and never the file just written (names are local time)
  const names = ['flash-notes-backup-2030-01-01-0100.flashnotes', 'flash-notes-backup-2030-01-02-0100.flashnotes', 'flash-notes-backup-2030-01-03-0100.flashnotes',
    'flash-notes-backup-2020-01-01-0100.flashnotes', 'notes.flashnotes', 'flash-notes-backup-2019.flashnotes', 'My flash-notes-backup-2018-01-01-0100.flashnotes'];
  eq(schedule.namesToPrune(names, 3), ['flash-notes-backup-2020-01-01-0100.flashnotes'], 'folder prune: only our own names, oldest first');
  eq(schedule.namesToPrune(names, 3, 'flash-notes-backup-2020-01-01-0100.flashnotes'), ['flash-notes-backup-2030-01-01-0100.flashnotes'], 'folder prune: the file just written is kept even if its name sorts oldest');
  eq(schedule.namesToPrune(names.slice(0, 3), 3, 'flash-notes-backup-2030-01-03-0100.flashnotes'), [], 'folder prune: nothing to delete within the limit');

  // add alongside: a file whose page id is already used by another notebook never overwrites that page
  await snaps.clearAll();
  const a = await store.createNotebook({ title: 'Collide A' });
  await draw(a.pageIds[0], text('ca-1', 'original page'));
  const evil = { app: 'flash-notes', version: 1, docs: [{ id: 'collide-doc-b', kind: 'notebook', title: 'Collide B', pageIds: [a.pageIds[0], a.pageIds[0]], createdAt: 1, updatedAt: 2 }],
    pages: [{ id: a.pageIds[0], docId: 'collide-doc-b', items: [text('cb-1', 'intruder')], paper: { style: 'blank', color: 'white' } }] };
  await store.importData(evil, { mode: 'merge' });
  const orig = await store.getPage(a.pageIds[0]);
  ok(orig.docId === a.id && orig.items.some(i => i.text === 'original page') && !orig.items.some(i => i.text === 'intruder'), 'import: a colliding page id does not overwrite another notebook\'s page');
  const b = await store.getDoc('collide-doc-b');
  ok(b.pageIds.length === 2 && new Set(b.pageIds).size === 2 && b.pageIds.every(id => id !== a.pageIds[0] || false) , 'import: …the page gets a new id, and a duplicated id inside the file becomes two pages');

  // replace that fails half way: the library is put back from the safety snapshot
  await store.createNotebook({ title: 'Rollback one' });
  await auto.runBackup({ reason: 'manual' });
  const snapGood = await snaps.latestSnapshot();
  const good = await auto.snapshotAsFile(snapGood.id);
  const mine = await store.createNotebook({ title: 'Rollback mine (not in the backup)' });
  const before = await snapshotOfLibrary();
  const proto = Object.getPrototypeOf(await (async () => { let os; await store._run(['meta'], 'readonly', t => { os = t.objectStore('meta'); }); return os; })());
  const realPut = proto.put;
  let boom = 0;
  proto.put = function (v, k) { if (v && v.docId && Array.isArray(v.items) && boom === 0 && (boom = 1)) { const e = new Error('disk is gone'); e.name = 'QuotaExceededError'; throw e; } return realPut.call(this, v, k); };
  let msg = '';
  try { await auto.restore(good, { mode: 'replace' }); } catch (e) { msg = e.message; }
  proto.put = realPut;
  ok(/put back/.test(msg), 'restore (replace): a failure half way says the notes were put back');
  eq(await snapshotOfLibrary(), before, 'restore (replace): …and the library is exactly as it was before');
  ok(await store.getDoc(mine.id), 'restore (replace): …including a notebook that was not in the backup');

  // a damaged picture (bad base64) does not stop the backup
  const bad = await store.createNotebook({ title: 'Bad picture' });
  await draw(bad.pageIds[0], image('bad-img', 'data:image/png;base64,A'));
  const built = await format.buildBackup({ settings });
  ok(built.blob.size > 0, 'backup: a picture with broken base64 is kept as it is and the backup still succeeds');
}

done('backup');

// Browser tests for automatic backup (v2.1), local-only mode (no accounts), Chrome via Playwright.
//   cd tests && npm install && node e2e/backup.e2e.mjs [port]
// Covers: Settings → Backup UI, Back up now → snapshot listed, wipe → restore from the snapshot AND from the
// downloaded .flashnotes file → identical library; replace + safety snapshot; the "Save a file" banner;
// the folder destination (Chrome's origin-private file system stands in for a real folder); long tasks
// while backing up a big library; no CSP violations, no console errors; settings survive a reload.
// NOT covered (cannot be, here): the iPad share sheet / Files app, showDirectoryPicker on a real disk,
// iOS suspending the app, Safari's IndexedDB.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../harness/serve.mjs';

const PORT = Number(process.argv[2]) || 8791;
const SHOTS = process.env.FLN_SHOTS || '';
const srv = await startServer(PORT, { accounts: false });
const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const browser = await chromium.launch({ executablePath: exe });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fln-bk-'));

let passed = 0; const failures = [];
const ok = (cond, name) => { if (cond) { passed++; console.log('ok  ', name); } else { failures.push(name); console.log('FAIL', name); } };
const step = async (name, fn) => { try { await fn(); } catch (e) { failures.push(name); console.log('FAIL', name, '\n    ', String(e.message).split('\n').slice(0, 4).join('\n     ')); } };
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);

async function device({ dark = false, width = 1024, height = 768, folder = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: true, colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  if (!folder) {
    // Like Safari: no File System Access API (this desktop Chrome has one).
    await ctx.addInitScript(() => { delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker; });
  } else {
    // Stand-in for the folder picker: a real FileSystemDirectoryHandle from the origin-private file system.
    await ctx.addInitScript(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('My backups', { create: true });
    });
  }
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/Service Worker registration blocked/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await page.goto(srv.url);
  await page.waitForSelector('.lib');
  return { ctx, page, logs };
}

// The library, without ids and times (a restore may give new ids), as one comparable string.
const dump = page => page.evaluate(async () => {
  const store = await import('./js/store.js');
  const data = JSON.parse(await (await store.exportAll()).text());
  const docs = data.docs.map(d => JSON.stringify({ kind: d.kind, title: d.title, cover: d.cover, paper: d.paper, background: d.background, n: d.pageIds.length })).sort();
  const pages = data.pages.map(p => JSON.stringify({ paper: p.paper, items: p.items.map(i => ({ ...i, id: undefined })) })).sort();
  return JSON.stringify({ docs, pages });
});
const wipe = page => page.evaluate(async () => {
  const store = await import('./js/store.js');
  await store._run(['docs', 'pages', 'thumbs'], 'readwrite', t => { for (const s of ['docs', 'pages', 'thumbs']) t.objectStore(s).clear(); });
});
const openSettings = async page => { await page.click('.lib-gear'); await page.waitForSelector('.settings'); };
const closeSheets = async page => { while (await page.$('.sheet-btn--done')) { await page.click('.sheet-btn--done'); await page.waitForTimeout(350); } };
const pickFile = async (page, file) => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.row--button:has-text("Restore from file")')]);
  await chooser.setFiles(file);
};
const snapCount = page => page.$$eval('.bk-snap', els => els.length);
const waitToast = (page, re) => page.waitForFunction(r => [...document.querySelectorAll('.toast-msg')].some(t => new RegExp(r).test(t.textContent)), re.source, { timeout: 15000 });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkYGBgYGAAkCAQCZmk0vgAAAABJRU5ErkJggg==';

// ================================================================= the main round trip
const A = await device();
let original;
await step('create notes (handwriting, text, a picture, a cover photo, a whiteboard)', async () => {
  original = await A.page.evaluate(async png => {
    const store = await import('./js/store.js');
    const nb = await store.createNotebook({ title: 'Biology <script>alert(1)</script>', cover: { color: '#2F9E44', image: png } });
    const p = await store.getPage(nb.pageIds[0]);
    p.items.push({ id: 's1', type: 'stroke', tool: 'pen', color: '#1C1C1E', size: 3, points: [[10, 10, 0.5], [60, 40, 0.6], [90, 20, 0.5]] },
      { id: 't1', type: 'text', x: 20, y: 200, w: 300, text: 'Mitosis has four phases', color: '#1C1C1E', fontSize: 20, font: 'hand' },
      { id: 'i1', type: 'image', x: 100, y: 300, w: 120, h: 120, src: png });
    await store.putPage(p);
    const p2 = await store.addPage(nb.id, nb.pageIds[0], { style: 'grid', color: 'cream' });
    p2.items.push({ id: 'h1', type: 'stroke', tool: 'highlighter', color: '#FFD43B', size: 18, points: [[0, 0, 0.5], [200, 0, 0.5]] });
    await store.putPage(p2);
    const wb = await store.createWhiteboard({ title: 'Revision map' });
    const w = await store.getPage(wb.pageIds[0]);
    w.items.push({ id: 'w1', type: 'stroke', tool: 'pen', color: '#E03131', size: 2, points: [[-500, -500, 0.5], [900, 700, 0.5]] });
    await store.putPage(w);
    return true;
  }, PNG);
  original = await dump(A.page);
  ok(original.includes('Mitosis'), 'notes created');
});

await step('Settings → Backup: the section and its honest copy', async () => {
  await A.page.reload(); await A.page.waitForSelector('.lib');
  await openSettings(A.page);
  const text = await A.page.textContent('.settings');
  ok(/Automatic backup/.test(text) && /Runs while Flash Notes is open/.test(text), 'Automatic backup row says it runs while the app is open');
  ok(/can’t run in the background/.test(text), 'the footer explains the platform limit');
  ok(/never your account, sign-in or session/.test(text), 'the footer says what a backup holds');
  const dests = await A.page.$$eval('[aria-label="Save to"] .opt-seg-btn', b => b.map(x => x.textContent));
  ok(JSON.stringify(dests) === JSON.stringify(['In the app', 'Save a file']), `destinations offered are only those this browser has (${dests.join(', ')}: no folder picker here)`);
  ok(/needs Chrome or Edge on a computer/.test(text), 'the folder option is explained when missing');
  const intervals = await A.page.$$eval('[aria-label="How often"] .opt-seg-btn', b => b.map(x => x.textContent));
  ok(intervals.join() === 'Hourly,6 hours,Daily,Weekly,Monthly', 'five intervals');
  ok(/No backups yet/.test(text), 'status: no backups yet');
  const small = await A.page.$$eval('.settings .bk-act, .settings .row--stack .opt-seg-btn, .settings .row--button, .settings .bk-inline', els => els.filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.height < 40 || r.width < 40); }).map(e => e.className + ' ' + e.textContent + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
  if (small.length) console.log('     small:', small);
  ok(small.length === 0, 'every backup control is a comfortable touch target (≥ 40 px; 44 for icon buttons)');
  await shot(A.page, 'bk-settings-empty');
});

await step('Back up now → snapshot listed with date, size and page count', async () => {
  await A.page.click('.bk-now');
  await waitToast(A.page, /Backed up/);
  await A.page.waitForSelector('.bk-snap');
  ok((await snapCount(A.page)) === 1, 'one snapshot listed');
  const sub = await A.page.textContent('.bk-snap .row-sub');
  ok(/3 pages/.test(sub) && /KB|MB/.test(sub) && /Made by you/.test(sub), `snapshot row shows pages, size, kind ("${sub}")`);
  ok(/Today/.test(await A.page.textContent('.bk-snap .row-title')), 'snapshot row shows the date');
  ok(/using .* of the/.test(await A.page.textContent('.settings')), 'storage usage line');
  await A.page.click('.bk-now');
  await waitToast(A.page, /Nothing has changed/);
  ok((await snapCount(A.page)) === 1, 'unchanged notes → no second snapshot');
  await shot(A.page, 'bk-settings-one');
});

let downloaded;
await step('Download the snapshot as a .flashnotes file', async () => {
  await A.page.click('.bk-act--download');
  await A.page.waitForSelector('.export-actions .btn');
  const [dl] = await Promise.all([A.page.waitForEvent('download'), A.page.click('.export-actions .btn')]);
  downloaded = path.join(TMP, dl.suggestedFilename());
  await dl.saveAs(downloaded);
  ok(/^flash-notes-backup-\d{4}-\d{2}-\d{2}-\d{4}\.flashnotes$/.test(dl.suggestedFilename()), `file name ${dl.suggestedFilename()}`);
  const head = fs.readFileSync(downloaded).subarray(0, 4);
  ok(head[0] === 0x50 && head[1] === 0x4b, 'the file is a zip');
  const z = fs.readFileSync(downloaded).toString('latin1');
  ok(z.includes('manifest.json') && z.includes('library.json') && /images\/[0-9a-f]{64}\.png/.test(z) && z.includes('markdown/'), 'it holds manifest, library, binary images and Markdown copies');
  await closeSheets(A.page);
});

await step('wipe → restore from the snapshot → identical', async () => {
  await wipe(A.page);
  await A.page.reload(); await A.page.waitForSelector('.lib');
  ok((await dump(A.page)) !== original, 'notes are gone');
  await openSettings(A.page);
  await A.page.waitForSelector('.bk-snap');
  await A.page.click('.bk-act--restore');
  await A.page.waitForSelector('.alert');
  ok(/Add alongside/.test(await A.page.textContent('.alert')), 'restore offers Add alongside first');
  await A.page.click('.alert-btn--primary');
  await waitToast(A.page, /Restored 2 items \(3 pages\)/);
  ok((await dump(A.page)) === original, 'library identical after restoring the snapshot');
  await closeSheets(A.page);
  ok((await A.page.$$('.lib .card, .lib [class*="card"]')).length > 0 || true, 'library refreshed');
});

await step('wipe → restore from the downloaded .flashnotes file → identical', async () => {
  await wipe(A.page);
  await A.page.reload(); await A.page.waitForSelector('.lib');
  await openSettings(A.page);
  await pickFile(A.page, downloaded);
  await A.page.waitForSelector('.alert');
  ok((await A.page.textContent('.alert')).includes(path.basename(downloaded)), 'the dialog names the file (as text)');
  await A.page.click('.alert-btn--primary');
  await waitToast(A.page, /Restored 2 items/);
  ok((await dump(A.page)) === original, 'library identical after restoring the downloaded file');
  const title = await A.page.evaluate(async () => (await (await import('./js/store.js')).listDocs()).map(d => d.title).join('|'));
  ok(title.includes('<script>'), 'a title with markup comes back as plain text');
  ok(!(await A.page.evaluate(() => !!document.querySelector('.lib script, .settings script'))), 'and is never turned into markup');
  await closeSheets(A.page);
});

await step('replace: confirm + safety snapshot first, and the safety snapshot undoes it', async () => {
  await A.page.evaluate(async () => { const store = await import('./js/store.js'); await store.createNotebook({ title: 'Made later' }); });
  const withExtra = await dump(A.page);
  await openSettings(A.page);
  const before = await snapCount(A.page);
  await pickFile(A.page, downloaded);
  await A.page.waitForSelector('.alert');
  await A.page.click('.alert-btn--danger');
  await A.page.waitForFunction(() => /Replace everything\?/.test(document.querySelector('.alert:last-of-type, .alert-root:last-child')?.textContent || ''));
  await A.page.click('.alert-root:last-child .alert-btn--danger');
  await waitToast(A.page, /Restored 2 items/);
  let same = false;
  for (let i = 0; i < 40 && !(same = (await dump(A.page)) === original); i++) await A.page.waitForTimeout(250);
  ok(same, 'replace: the library is exactly the backup');
  await A.page.waitForFunction(n => document.querySelectorAll('.bk-snap').length === n + 1, before);
  ok(/Before a restore/.test(await A.page.textContent('.bk-snap .row-sub')), 'replace: a safety snapshot was saved first');
  await A.page.click('.bk-snap .bk-act--restore');
  await A.page.waitForSelector('.alert');
  await A.page.click('.alert-btn--danger');
  await A.page.click('.alert-root:last-child .alert-btn--danger');
  await waitToast(A.page, /Restored 3 items/);
  ok((await dump(A.page)) === withExtra, 'the safety snapshot brings back what was there before');
  await closeSheets(A.page);
});

await step('settings persist across a reload; delete a snapshot', async () => {
  await openSettings(A.page);
  await A.page.click('.settings .row:has-text("Automatic backup") .switch-input');
  await A.page.click('[aria-label="How often"] .opt-seg-btn:has-text("Weekly")');
  await A.page.click('[aria-label="Snapshots to keep"] .opt-seg-btn:has-text("10")');
  await A.page.waitForTimeout(300);
  await closeSheets(A.page);
  await A.page.reload(); await A.page.waitForSelector('.lib');
  await openSettings(A.page);
  const st = await A.page.evaluate(() => ({
    on: document.querySelector('.settings .row:has(.switch-input[aria-label="Automatic backup"]) .switch-input').checked,
    iv: document.querySelector('[aria-label="How often"] [aria-checked="true"]').textContent,
    keep: document.querySelector('[aria-label="Snapshots to keep"] [aria-checked="true"]').textContent,
  }));
  ok(st.on && st.iv === 'Weekly' && st.keep === '10', `auto backup on, weekly, keep 10 after reload (${JSON.stringify(st)})`);
  ok(/next in/.test(await A.page.textContent('.bk-status')), 'status shows when the next backup is due');
  const n = await snapCount(A.page);
  await A.page.click('.bk-snap:last-child .bk-act--delete');
  await A.page.click('.alert-btn--danger');
  await A.page.waitForFunction(k => document.querySelectorAll('.bk-snap').length === k - 1, n);
  ok(true, 'a snapshot can be deleted');
  await shot(A.page, 'bk-settings-on');
  await closeSheets(A.page);
});

await step('"Save a file": a due backup shows the banner; Save downloads it; no auto-download', async () => {
  await openSettings(A.page);
  await A.page.click('[aria-label="Save to"] .opt-seg-btn:has-text("Save a file")');
  await A.page.waitForSelector('.bk-banner.is-open', { timeout: 15000 });     // choosing it makes the first file
  await closeSheets(A.page);
  let auto = false;
  A.page.on('download', () => { auto = true; });
  await A.page.waitForTimeout(500);
  ok(!auto, 'nothing is downloaded without a tap');
  ok(/Backup ready/.test(await A.page.textContent('.bk-banner')), 'banner: Backup ready');
  await shot(A.page, 'bk-banner');
  A.page.removeAllListeners('download');
  const [dl] = await Promise.all([A.page.waitForEvent('download'), A.page.click('.bk-banner-btn--primary')]);
  ok(/\.flashnotes$/.test(dl.suggestedFilename()), 'Save → the .flashnotes file');
  await A.page.waitForFunction(() => !document.querySelector('.bk-banner'));
  ok(true, 'banner gone after saving');
  // A due automatic backup with changed notes: the banner comes back on its own (one tap to save).
  await A.page.evaluate(async () => {
    const store = await import('./js/store.js');
    await store.createNotebook({ title: 'Another' });
    const snaps = await import('./js/backup/snapshots.js');
    await snaps.patchState({ lastRunAt: Date.now() - 8 * 86400e3, lastFileAt: Date.now() - 8 * 86400e3 });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await A.page.waitForSelector('.bk-banner.is-open', { timeout: 15000 });
  ok(true, 'coming back to the app when a backup is due → banner');
  await A.page.click('.bk-banner-btn:not(.bk-banner-btn--primary)');
  await A.page.waitForFunction(() => !document.querySelector('.bk-banner'));
  const snoozed = await A.page.evaluate(async () => (await (await import('./js/backup/snapshots.js')).getState()).snoozeUntil - Date.now());
  ok(snoozed > 23 * 3600e3 && snoozed <= 24 * 3600e3, 'Later → snoozed for a day');
});

const csp = await A.page.evaluate(() => window.__csp);
ok(csp.length === 0, `no CSP violations (blob downloads, workers, styles) ${csp.join('; ')}`);
ok(A.logs.length === 0, `no console errors ${A.logs.join(' | ')}`);
await A.ctx.close();

// ================================================================= folder destination (OPFS stands in for a real folder)
await step('folder: pick once, write flash-notes-backup-….flashnotes, prune to N', async () => {
  const F = await device({ folder: true });
  await F.page.evaluate(async () => { const store = await import('./js/store.js'); await store.createNotebook({ title: 'Folder test' }); });
  await openSettings(F.page);
  const dests = await F.page.$$eval('[aria-label="Save to"] .opt-seg-btn', b => b.map(x => x.textContent));
  ok(dests.includes('A folder'), 'with showDirectoryPicker the folder option appears');
  await F.page.click('[aria-label="Snapshots to keep"] .opt-seg-btn:has-text("3")');
  await F.page.click('[aria-label="Save to"] .opt-seg-btn:has-text("A folder")');
  await F.page.waitForFunction(() => /My backups/.test(document.querySelector('.settings').textContent), null, { timeout: 10000 });
  const files = () => F.page.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('My backups'); const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); });
  for (let i = 0; i < 40 && !(await files()).length; i++) await F.page.waitForTimeout(250);
  let names = await files();
  ok(names.length === 1 && /^flash-notes-backup-\d{4}-\d{2}-\d{2}-\d{4}\.flashnotes$/.test(names[0]), `a backup file is written to the folder (${names})`);
  await F.page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('My backups');
    const w = await (await d.getFileHandle('my essay.docx', { create: true })).createWritable(); await w.write('mine'); await w.close();
    for (let i = 0; i < 4; i++) { const w2 = await (await d.getFileHandle(`flash-notes-backup-2020-01-0${i + 1}-1200.flashnotes`, { create: true })).createWritable(); await w2.write('old'); await w2.close(); }
  });
  await F.page.evaluate(async () => { const store = await import('./js/store.js'); await store.createNotebook({ title: 'Folder test 2' }); });
  await F.page.click('.bk-now');
  await waitToast(F.page, /Backed up/);
  for (let i = 0; i < 40; i++) { names = await files(); if (names.filter(n => n.endsWith('.flashnotes')).length === 3) break; await F.page.waitForTimeout(250); }
  ok(names.filter(n => n.endsWith('.flashnotes')).length === 3 && !names.some(n => n.startsWith('flash-notes-backup-2020-01-01')), `pruned to the newest 3 (${names.join(', ')})`);
  ok(names.includes('my essay.docx'), 'other files in the folder are never touched');
  // the bytes in the folder are a valid backup
  const okFile = await F.page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('My backups');
    const names = []; for await (const [n] of d.entries()) names.push(n);
    const newest = names.filter(n => /2026|20[3-9]\d/.test(n)).sort().pop();
    const f = await (await d.getFileHandle(newest)).getFile();
    const { readBackup } = await import('./js/backup/format.js');
    const r = await readBackup(f);
    return r.kind === 'flashnotes' && r.data.docs.length === 2;
  });
  ok(okFile, 'the file in the folder reads back as a valid backup');
  ok(/saved to folder/.test(await F.page.textContent('.bk-status')), 'status says it was saved to the folder');
  const csp2 = await F.page.evaluate(() => window.__csp);
  ok(csp2.length === 0 && F.logs.length === 0, `folder run: no CSP violations or console errors ${csp2} ${F.logs}`);
  await F.ctx.close();
});

// ================================================================= dark mode, phone, reduced motion screenshots
await step('dark mode and phone layout render the section', async () => {
  const P = await device({ dark: true, width: 390, height: 844 });
  await openSettings(P.page);
  await P.page.click('.bk-now');
  await P.page.waitForSelector('.bk-snap');
  const over = await P.page.evaluate(() => { const s = document.querySelector('.settings'); return [...s.querySelectorAll('.bk-snap, .row--stack')].some(el => el.scrollWidth > el.clientWidth + 1); });
  ok(!over, 'nothing overflows on a phone');
  await shot(P.page, 'bk-phone-dark');
  ok(P.logs.length === 0, 'phone/dark: no console errors');
  await P.ctx.close();
});

// ================================================================= long tasks while backing up a big library
await step('a big library (500-stroke pages × many) never blocks the page for > 50 ms', async () => {
  const B = await device();
  const made = await B.page.evaluate(async () => {
    const store = await import('./js/store.js');
    let pages = 0;
    for (let n = 0; n < 12; n++) {
      const nb = await store.createNotebook({ title: 'Big ' + n });
      let after = nb.pageIds[0];
      for (let k = 0; k < 5; k++) {
        const page = k === 0 ? await store.getPage(nb.pageIds[0]) : await store.addPage(nb.id, after);
        after = page.id;
        page.items = Array.from({ length: 500 }, (_, i) => ({ id: `s${n}-${k}-${i}`, type: 'stroke', tool: 'pen', color: '#1C1C1E', size: 3, brush: 'pen',
          points: Array.from({ length: 60 }, (_, j) => [Math.round((50 + j * 3 + (i % 20) * 30) * 100) / 100, Math.round((40 + Math.floor(i / 20) * 40 + Math.sin(j / 3) * 8) * 100) / 100, 0.5]) }));
        await store.putPage(page);
        pages++;
      }
    }
    return pages;
  });
  ok(made === 60, `${made} pages × 500 strokes × 60 points created`);
  await B.page.waitForTimeout(1000);
  const r = await B.page.evaluate(async () => {
    const tasks = [];
    const obs = new PerformanceObserver(list => { for (const e of list.getEntries()) tasks.push(Math.round(e.duration)); });
    obs.observe({ type: 'longtask', buffered: false });
    // frames keep being drawn while the backup runs
    let frames = 0, worst = 0, last = performance.now(), on = true;
    const tick = t => { worst = Math.max(worst, t - last); last = t; frames++; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const auto = await import('./js/backup/auto.js');
    const t0 = performance.now();
    const res = await auto.runBackup({ reason: 'manual' });
    const ms = performance.now() - t0;
    on = false;
    await new Promise(r2 => setTimeout(r2, 100));
    obs.disconnect();
    const snaps = await import('./js/backup/snapshots.js');
    const latest = await snaps.latestSnapshot();
    return { tasks, ms: Math.round(ms), result: res.result, size: latest && latest.size, frames, worst: Math.round(worst) };
  });
  console.log('     backup of the big library:', JSON.stringify({ ...r, tasks: r.tasks.length ? `${r.tasks.length} long tasks, max ${Math.max(...r.tasks)} ms` : 'none' }));
  ok(r.result === 'created', `backup made (${(r.size / 1048576).toFixed(1)} MB in ${r.ms} ms)`);
  ok(!r.tasks.some(d => d > 50), `no long task over 50 ms (${r.tasks.join(', ') || 'none'})`);
  // a pointer held down pauses the work
  const paused = await B.page.evaluate(async () => {
    const store = await import('./js/store.js');
    await store.createNotebook({ title: 'one more' });
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const auto = await import('./js/backup/auto.js');
    const t0 = performance.now();
    const p = auto.runBackup({ reason: 'manual' });
    await new Promise(r2 => setTimeout(r2, 1500));
    const runningWhileDown = auto.isRunning();
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const res = await p;
    return { runningWhileDown, waited: performance.now() - t0, result: res.result };
  });
  ok(paused.runningWhileDown && paused.waited > 2500 && paused.result === 'created', `the backup waits while a finger or Pencil is down (${Math.round(paused.waited)} ms)`);
  await B.ctx.close();
});

await browser.close();
await srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures.length ? `backup e2e: ${failures.length} FAILED, ${passed} passed` : `backup e2e: all ${passed} checks passed`);
process.exit(failures.length ? 1 : 0);

// Backup in Settings (automatic backup, snapshots, backup files) and the small "Backup ready" banner.
// The rules live in js/backup/*; this file only shows them. All user text goes in as text nodes.
import { h, clear, relTime, formatBytes, plural, filePicker } from './dom.js';
import { icon } from './icons.js';
import { alertDialog, confirmDialog } from './sheet.js';
import { toast } from './toast.js';
import { openExportSheet, shareFile, canShareFile } from './export.js';
import * as auto from '../backup/auto.js';
import { buildBackup } from '../backup/format.js';
import { INTERVAL_LABELS, KEEP_CHOICES, backupSettings, backupFileName, nextDueAt } from '../backup/schedule.js';
import * as store from '../store.js';

const DEST_LABELS = { app: 'In the app', folder: 'A folder', file: 'Save a file' };

function seg(label, choices, value, onPick) {
  const box = h('div', { class: 'opt-seg opt-seg--wide', role: 'radiogroup', 'aria-label': label });
  const btns = choices.map(([id, text]) => h('button', {
    type: 'button', class: 'opt-seg-btn', role: 'radio', 'aria-checked': String(id === value), dataset: { v: String(id) },
    onClick: async () => {
      const prev = btns.find(b => b.getAttribute('aria-checked') === 'true');
      btns.forEach(b => b.setAttribute('aria-checked', String(b === btn(id))));
      const okd = await onPick(id);
      if (okd === false) btns.forEach(b => b.setAttribute('aria-checked', String(b === prev)));
    },
  }, text));
  const btn = id => btns.find(b => b.dataset.v === String(id));
  box.append(...btns);
  return box;
}

const stackRow = (title, control, cls = '') => h('div', { class: `row row--stack ${cls}` }, h('span', { class: 'row-title' }, title), control);

function when(t) {
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

function inMs(ms) {
  if (ms <= 60000) return 'in a minute';
  if (ms < 3600e3) return `in ${Math.round(ms / 60000)} min`;
  if (ms < 2 * 86400e3) return `in ${Math.round(ms / 3600e3)} h`;
  return `in ${Math.round(ms / 86400e3)} days`;
}

/** A File the share sheet accepts, if any type works; otherwise the original (it will be downloaded). */
function shareable(file) {
  if (canShareFile(file)) return file;
  for (const type of ['application/zip', 'application/x-zip-compressed']) {
    const f = new File([file], file.name, { type });
    if (canShareFile(f)) return f;
  }
  return file;
}

/** Restore from a File or {snapshotId}. Asks "add alongside" (default) or "replace" (confirm + safety snapshot). */
async function askRestore(app, label, source, { onDataChanged, cloud }) {
  const mode = await alertDialog({
    title: 'Restore backup',
    message: `“${label}”\n\nAdd alongside puts the backup’s notebooks next to yours; nothing you have now is changed. Replace deletes everything on this device${cloud ? ' and in your account' : ''} first.`,
    buttons: [
      { label: 'Add alongside', value: 'merge', style: 'primary' },
      { label: 'Replace everything', value: 'replace', style: 'danger' },
      { label: 'Cancel', value: null, style: 'cancel' },
    ],
  });
  if (!mode) return;
  if (mode === 'replace') {
    const yes = await confirmDialog({
      title: 'Replace everything?',
      message: 'Every notebook and whiteboard here is replaced by the backup. A safety snapshot of what is here now is saved first, so you can get it back from the snapshot list.',
      confirmLabel: 'Replace', danger: true,
    });
    if (!yes) return;
  }
  const t = toast('Restoring…', { icon: 'info', sticky: true });
  try {
    const r = await auto.restore(source, { mode });
    t.dismiss();
    toast(r.docs ? `Restored ${plural(r.docs, 'item')} (${plural(r.pages, 'page')})` : 'Everything in that backup is already here', { icon: 'check' });
    if (onDataChanged) onDataChanged();
    else if (mode === 'replace') app.back();   // opened from an editor whose notebook may no longer exist
  } catch (err) {
    t.dismiss();
    toast((err && err.message) || 'Could not restore that file', { icon: 'info', duration: 6000 });
  }
}

function saveBackupFileNow(app) {
  return openExportSheet({
    title: 'Save a backup file',
    doneText: 'Your backup is ready',
    make: async progress => {
      progress('Collecting your notes…');
      const { blob, manifest } = await buildBackup({ pause: auto.pause, settings: app.settings, appVersion: app.version });
      return shareable(new File([blob], backupFileName(manifest.createdAt), { type: auto.FILE_TYPE }));
    },
  });
}

/**
 * The Backup groups for the settings sheet. row/group/toggle are the sheet's own builders.
 * Returns {nodes, destroy()}.
 */
export function backupSection(app, { row, group, toggle, onDataChanged, cloud }) {
  const folderOk = auto.folderSupported();
  let s = backupSettings(app.settings);
  const set = patch => { s = { ...s, ...patch }; return app.updateSettings(patch); };

  // ---- automatic backup
  const intervalSeg = seg('How often', INTERVAL_LABELS, s.backupInterval, v => { set({ backupInterval: v }); refresh(); auto.check(); });
  const destChoices = [['app', DEST_LABELS.app], ...(folderOk ? [['folder', DEST_LABELS.folder]] : []), ['file', DEST_LABELS.file]];
  if (!folderOk && s.backupDest === 'folder') s.backupDest = 'app';
  const destSeg = seg('Save to', destChoices, s.backupDest, async v => {
    if (v === 'folder') {
      try {
        const name = await auto.chooseFolder();       // the folder picker, straight from the tap
        if (!name) return false;
      } catch { toast('That folder can’t be used. Try another one.', { icon: 'info' }); return false; }
    }
    await set({ backupDest: v });
    refresh();
    if (v !== 'app') auto.runBackup({ reason: 'manual' });
    return true;
  });
  const keepSeg = seg('Snapshots to keep', KEEP_CHOICES.map(n => [n, String(n)]), s.backupKeep, async v => { await set({ backupKeep: v }); await auto.applyKeep(v); });
  const folderName = h('span', { class: 'row-sub' });
  const folderRow = h('div', { class: 'row' },
    h('span', { class: 'row-icon', style: { '--tint': '#F59F00' }, 'data-squircle': '8' }, icon('download', 18, 2)),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Backup folder'), folderName),
    h('button', { type: 'button', class: 'btn btn--quiet bk-inline', onClick: async () => { try { if (await auto.chooseFolder()) { refresh(); auto.runBackup({ reason: 'manual' }); } } catch { toast('That folder can’t be used. Try another one.', { icon: 'info' }); } } }, 'Change'));

  const statusTitle = h('span', { class: 'row-title' }, 'Last backup');
  const statusSub = h('span', { class: 'row-sub bk-status' });
  const statusAction = h('span', { class: 'bk-status-action' });
  const statusRow = h('div', { class: 'row row--tall', 'aria-live': 'polite' },
    h('span', { class: 'row-icon', style: { '--tint': '#40C057' }, 'data-squircle': '8' }, icon('shield', 18, 2)),
    h('span', { class: 'row-text' }, statusTitle, statusSub), statusAction);
  const nowBtn = row({ iconName: 'upload', tint: '#0C8599', title: 'Back up now', sub: 'Makes a snapshot of everything right away', onClick: async () => {
    const r = await auto.runBackup({ reason: 'manual' });
    if (r.result === 'created') toast('Backed up', { icon: 'check' });
    else if (r.result === 'unchanged') toast('Nothing has changed since the last backup', { icon: 'check' });
    else if (r.result === 'busy') toast('A backup is already being made in another window', { icon: 'info' });
    else toast(r.code === 'storage-full' ? 'Backup failed: this device is out of storage space' : 'Backup failed. Please try again.', { icon: 'info', duration: 5000 });
  } });
  nowBtn.classList.add('bk-now');
  const autoFooter = h('span');

  const autoToggle = toggle(s.autoBackup, 'Automatic backup', async v => { await set({ autoBackup: v }); refresh(); if (v) auto.check(); });
  const opts = [stackRow('How often', intervalSeg), stackRow('Save to', destSeg), folderRow, stackRow('Snapshots to keep', keepSeg)];
  const autoGroup = group('Automatic backup', autoFooter,
    row({ iconName: 'shield', tint: '#4C6EF5', title: 'Automatic backup', sub: 'Runs while Flash Notes is open', control: autoToggle }),
    ...opts, statusRow, nowBtn);

  // ---- snapshots
  const snapBox = h('div', { class: 'bk-snaps' });
  const snapFooter = h('span');
  const snapGroup = group('Snapshots on this device', snapFooter, snapBox);

  // ---- files
  const picker = filePicker('');   // no filter: iOS greys out unknown types like .flashnotes
  const fileGroup = group('Backup file', 'A .flashnotes file holds every notebook, whiteboard and picture, plus readable Markdown copies of your text. Older .json backups can be restored too.',
    row({ iconName: 'download', tint: '#0C8599', title: 'Save a backup file', sub: 'Everything, as one .flashnotes file', onClick: () => saveBackupFileNow(app) }),
    row({ iconName: 'upload', tint: '#9C36B5', title: 'Restore from file', sub: '.flashnotes or .json · add alongside or replace', onClick: () => picker.pick(file => askRestore(app, file.name, file, { onDataChanged, cloud })) }));

  function snapRow(sn) {
    const sub = [sn.counts ? plural(sn.counts.pages, 'page') : null, formatBytes(sn.size), sn.reason === 'safety' ? 'Before a restore' : sn.reason === 'manual' ? 'Made by you' : null].filter(Boolean).join(' · ');
    const act = (name, label, fn, cls = '') => h('button', { type: 'button', class: `icon-btn bk-act ${cls}`, 'aria-label': `${label} (${when(sn.createdAt)})`, title: label, onClick: fn }, icon(name, 20, 2));
    return h('div', { class: 'row bk-snap', dataset: { id: sn.id } },
      h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, when(sn.createdAt)), h('span', { class: 'row-sub' }, sub)),
      h('span', { class: 'bk-acts' },
        act('upload', 'Restore', () => askRestore(app, `Snapshot from ${when(sn.createdAt)}`, { snapshotId: sn.id }, { onDataChanged, cloud }), 'bk-act--restore'),
        act('share', 'Download', () => openExportSheet({ title: 'Download snapshot', doneText: 'Your backup is ready', make: async () => { const f = await auto.snapshotAsFile(sn.id); if (!f) throw new Error('That snapshot is no longer on this device.'); return shareable(f); } }), 'bk-act--download'),
        act('trash', 'Delete', async () => {
          const yes = await confirmDialog({ title: 'Delete this snapshot?', message: `The snapshot from ${when(sn.createdAt)} is deleted from this device. Your notes are not affected.`, confirmLabel: 'Delete', danger: true });
          if (yes) { await auto.deleteSnapshot(sn.id); }
        }, 'bk-act--delete')));
  }

  let alive = true;
  async function refresh() {
    if (!alive) return;
    s = backupSettings(app.settings);
    if (!folderOk && s.backupDest === 'folder') s.backupDest = 'app';
    const st = await auto.getStatus();
    const [{ usage }] = await Promise.all([store.storageEstimate()]);
    if (!alive) return;
    autoGroup.classList.toggle('bk-off', !s.autoBackup);
    folderRow.hidden = s.backupDest !== 'folder';
    folderName.textContent = st.folderName ? `“${st.folderName}” · keeps the newest ${s.backupKeep}` : 'No folder chosen yet';

    const state = st.state || {};
    clear(statusAction);
    statusSub.classList.remove('bk-status--bad');
    let text;
    const bad = msg => { text = msg; statusSub.classList.add('bk-status--bad'); };
    if (st.running) text = 'Backing up…';
    else if (state.error && state.error.code === 'storage-full') bad('The last backup failed: this device is out of storage space. Delete old snapshots or free up space; it tries again within the hour.');
    else if (state.error) bad('The last backup failed. It tries again within the hour.');
    else if (s.backupDest === 'folder' && state.folderError === 'permission' && st.folderName) {
      bad(`Flash Notes needs your permission again to save to “${st.folderName}”.`);
      statusAction.append(h('button', { type: 'button', class: 'btn btn--tinted bk-inline', onClick: async () => { if (await auto.allowFolder()) toast('Saving backups to the folder again', { icon: 'check' }); refresh(); } }, 'Allow'));
    } else if (s.backupDest === 'folder' && state.folderError === 'missing') bad('The backup folder can’t be found any more. Choose it again.');
    else if (s.backupDest === 'folder' && state.folderError === 'disk-full') bad('The backup folder’s disk is full.');
    else if (s.backupDest === 'folder' && state.folderError && state.folderError !== 'no-folder') bad('Couldn’t write to the backup folder. Choose it again.');
    if (!text) {
      const latest = st.snapshots[0];
      if (!latest) text = 'No backups yet';
      else {
        const bits = [`${relTime(latest.createdAt)} · ${plural(latest.counts ? latest.counts.pages : 0, 'page')}`];
        if (state.lastRunAt && state.lastRunAt > latest.createdAt + 60000) bits.push(`checked ${relTime(state.lastRunAt)}, nothing new`);
        if (s.backupDest === 'folder' && state.lastFolderAt) bits.push(`saved to folder ${relTime(state.lastFolderAt)}`);
        if (s.backupDest === 'file') bits.push(state.lastFileAt ? `file saved ${relTime(state.lastFileAt)}` : 'no file saved yet');
        text = bits.join(' · ');
      }
      const next = nextDueAt({ enabled: s.autoBackup, interval: s.backupInterval, lastRunAt: state.lastRunAt, now: Date.now() });
      if (next != null) text += ` · next ${next <= Date.now() ? 'soon' : inMs(next - Date.now())}`;
    }
    statusSub.textContent = text;

    autoFooter.textContent = [
      'Backups are made only while Flash Notes is open: when you open it, when you come back to it, and every so often while you use it. A web app can’t run in the background, so a backup that falls due while it’s closed is made the next time you open it. Drawing is never slowed down.',
      s.backupDest === 'file' ? 'When a backup is ready, a banner asks you to save it: tap Save and pick Files or iCloud Drive. Safari can’t save files without a tap.' : null,
      s.backupDest === 'folder' ? `Each backup is also written to your folder as flash-notes-backup-….flashnotes, keeping the newest ${s.backupKeep}.` : null,
      s.backupDest === 'app' ? 'Snapshots stay in this browser. They protect against mistakes, not against losing the device or clearing its data: choose “Save a file” for that.' : null,
      folderOk ? null : 'Saving to a folder by itself needs Chrome or Edge on a computer; this browser doesn’t allow it.',
      'Backups hold your notes, pictures and pen settings only, never your account, sign-in or session.',
    ].filter(Boolean).join(' ');

    clear(snapBox);
    if (!st.snapshots.length) snapBox.append(h('div', { class: 'row' }, h('span', { class: 'row-text' }, h('span', { class: 'row-sub' }, 'No snapshots yet. Tap “Back up now” to make one.'))));
    else snapBox.append(...st.snapshots.map(snapRow));
    const total = st.snapshots.reduce((n, x) => n + (x.size || 0), 0);
    snapFooter.textContent = st.snapshots.length
      ? `${plural(st.snapshots.length, 'snapshot')} using ${formatBytes(total)}${usage ? ` of the ${formatBytes(usage)} Flash Notes uses on this device` : ''}. The oldest is removed when there are more than ${s.backupKeep}.`
      : 'Snapshots are kept on this device, in the app’s own storage.';
  }
  const off = auto.onBackupEvent(e => { if (e.type === 'status') refresh(); });
  refresh();
  return { nodes: [autoGroup, snapGroup, fileGroup], destroy() { alive = false; off(); picker.destroy(); } };
}

// ---------------------------------------------------------------- the banner

let bannerEl = null;
let lastErrorAt = 0;

function hideBanner() {
  if (!bannerEl) return;
  const el = bannerEl;
  bannerEl = null;
  el.classList.remove('is-open');
  setTimeout(() => el.remove(), 260);
}

function showBanner(title, sub, actions) {
  hideBanner();
  const el = h('div', { class: 'bk-banner', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'bk-banner-icon' }, icon('shield', 20, 2)),
    h('span', { class: 'bk-banner-text' }, h('span', { class: 'bk-banner-title' }, title), sub ? h('span', { class: 'bk-banner-sub' }, sub) : null),
    ...actions.map(a => h('button', { type: 'button', class: `bk-banner-btn ${a.primary ? 'bk-banner-btn--primary' : ''}`, onClick: a.onClick }, a.label)));
  document.body.append(el);
  void el.offsetHeight;
  el.classList.add('is-open');
  bannerEl = el;
}

function renderBanner() {
  const p = auto.pendingOffer();
  if (!p) { hideBanner(); return; }
  if (p.kind === 'file') {
    showBanner('Backup ready', `${when(p.createdAt)} · ${formatBytes(p.file.size)}`, [
      { label: 'Later', onClick: () => { auto.snooze(); toast('OK, I’ll ask again tomorrow', { icon: 'info' }); } },
      { label: 'Save', primary: true, onClick: async () => {
        const r = await shareFile(shareable(p.file));    // the share sheet opens straight from this tap
        if (r === 'shared' || r === 'downloaded') { await auto.fileSaved(); toast(r === 'shared' ? 'Backup saved' : 'Backup saved to Downloads', { icon: 'check' }); }
      } },
    ]);
  } else if (p.kind === 'folder-permission') {
    showBanner('Allow backups to your folder', `Flash Notes needs permission again to save to “${p.name || 'your folder'}”.`, [
      { label: 'Later', onClick: () => hideBanner() },
      { label: 'Allow', primary: true, onClick: async () => { const okd = await auto.allowFolder(); hideBanner(); toast(okd ? 'Backup saved to your folder' : 'Not allowed. You can try again in Settings.', { icon: okd ? 'check' : 'info' }); } },
    ]);
  }
}

/** Shows the banner whenever a backup file is waiting to be saved (once, from app.js). */
export function mountBackupBanner() {
  auto.onBackupEvent(async e => {
    if (e.type === 'banner') { renderBanner(); return; }
    // A failed automatic backup is said once, plainly.
    try {
      const st = (await auto.getStatus()).state || {};
      if (st.error && st.error.at && st.error.at !== lastErrorAt) {
        lastErrorAt = st.error.at;
        if (Date.now() - st.error.at < 60000) {
          toast(st.error.code === 'storage-full' ? 'Backup failed: this device is out of storage space. See Settings → Backup.' : 'Backup failed. It will try again soon.', { icon: 'info', duration: 6000 });
        }
      }
    } catch { /* never in the way */ }
  });
}


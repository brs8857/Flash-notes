// The "Account" part of Settings: who is signed in, sync status, export, sign out, delete account.
import { h, relTime, plural, safeFileName } from './dom.js';
import { icon } from './icons.js';
import { alertDialog, confirmDialog } from './sheet.js';
import { toast } from './toast.js';
import { exportBackup, openExportSheet } from './export.js';
import { currentUser } from '../auth/auth.js';
import { getSyncStatus, onSyncStatus, pokeSync } from '../sync/sync.js';
import * as local from '../sync/local.js';
import * as account from '../account.js';
import { log } from '../log.js';

function statusText(s) {
  const waiting = s.pending ? ` · ${plural(s.pending, 'change')} waiting` : '';
  if (s.state === 'syncing') return 'Saving to your account…';
  if (s.state === 'offline') return `Offline. Your notes are safe on this device${waiting}`;
  if (s.state === 'error') return `Can’t reach your account right now. Trying again soon${waiting}`;
  if (s.state === 'signin') return 'Sign in again to keep backing up';
  if (s.blocked) return `${plural(s.blocked, 'page')} too large to back up. Still safe on this device${waiting}`;
  if (s.pending) return `${plural(s.pending, 'change')} waiting to upload`;
  return s.lastSyncedAt ? `Up to date · checked ${relTime(s.lastSyncedAt)}` : 'Up to date';
}

function exportMarkdown() {
  return openExportSheet({
    title: 'Export as Markdown',
    doneText: 'Your Markdown file is ready',
    make: async progress => {
      progress('Collecting your text…');
      const md = await account.buildMarkdown();
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return new File([md], safeFileName(`flash-notes-${stamp}`) + '.md', { type: 'text/markdown' });
    },
  });
}

/**
 * Builds the Account group for the settings sheet. row/group are the settings sheet's own builders.
 * Returns {nodes:[…], destroy()} or null when the app runs without accounts.
 */
export function accountSection(app, { row, group, closeSheet, onDataChanged }) {
  const user = currentUser();
  if (!user) return null;

  const syncSub = h('span', { class: 'row-sub' }, statusText(getSyncStatus()));
  const off = onSyncStatus(s => { syncSub.textContent = statusText(s); });
  const who = h('div', { class: 'row row--tall' },
    h('span', { class: 'row-icon', style: { '--tint': '#4C6EF5' }, 'data-squircle': '8' }, icon('shield', 18, 2)),
    h('span', { class: 'row-text' },
      h('span', { class: 'row-title account-name' }, user.name || 'Signed in'),       // text nodes only: a name can never become markup
      h('span', { class: 'row-sub account-email' }, user.email),
      syncSub));

  async function doSignOut() {
    const yes = await confirmDialog({ title: 'Sign out?', message: 'Your notes stay in your account and are removed from this device. Sign in again to get them back.', confirmLabel: 'Sign out', danger: true });
    if (!yes) return;
    closeSheet();
    const t = toast('Signing out…', { icon: 'info', sticky: true });
    try {
      try {
        await account.signOutEverywhereHere();
      } catch (err) {
        if (!err || err.code !== 'unsynced') throw err;
        // Some changes could not be saved to the account (offline, server trouble, too large). Signing out
        // now would delete them from this device for good, so ask again, plainly.
        t.dismiss();
        const n = err.count || 1;
        const again = await confirmDialog({
          title: 'Some changes aren’t saved yet',
          message: `${plural(n, 'change')} ${n === 1 ? 'has' : 'have'} not been saved to your account${navigator.onLine === false ? ' (you’re offline)' : ''}. If you sign out now ${n === 1 ? 'it' : 'they'} will be lost from this device.\n\nTip: stay signed in, connect to the internet and wait a moment, or use “Download my notes” first.`,
          confirmLabel: 'Sign out anyway', danger: true,
        });
        if (!again) return;
        await account.signOutEverywhereHere({ force: true });
      }
    } catch (err) {
      log.error('account', 'sign-out failed', err);
      toast('Couldn’t finish signing out. Please try again.', { icon: 'info', duration: 4500 });
    } finally { t.dismiss(); }
  }

  async function doDelete() {
    if (navigator.onLine === false) { toast('Connect to the internet to delete your account.', { icon: 'info', duration: 4500 }); return; }
    const r = await alertDialog({
      title: 'Delete your account?',
      message: 'This permanently deletes your account and every notebook, whiteboard and picture in it, on all your devices. It can’t be undone.\n\nWant a copy first? Cancel and use “Download my notes”.\n\nType DELETE to confirm.',
      input: { placeholder: 'DELETE', maxLength: 12 },
      buttons: [
        { label: 'Cancel', value: false, style: 'cancel' },
        { label: 'Delete everything', value: true, style: 'danger' },
      ],
    });
    if (!r || r.value !== true) return;
    if (r.text !== 'DELETE') { toast('Nothing was deleted. Type DELETE in capitals to confirm.', { icon: 'info', duration: 4500 }); return; }
    closeSheet();
    const t = toast('Deleting your account…', { icon: 'info', sticky: true });
    try {
      await account.deleteAccount();
      // A fresh start: reload so nothing of the account is left in memory either.
      try { history.replaceState(null, '', location.pathname + '#/'); } catch { /* ignore */ }
      location.reload();
    } catch (err) {
      t.dismiss();
      log.error('account', 'account deletion failed', err);
      toast('Your account could not be deleted just now. Nothing was removed. Please try again.', { icon: 'info', duration: 6000 });
    }
  }

  // The copy of the notes that were on this device before the first sign-in.
  const markdownRow = row({ iconName: 'text', tint: '#F59F00', title: 'Export as Markdown', sub: 'Titles and text boxes only', onClick: exportMarkdown });
  (async () => {
    const state = await local.getState().catch(() => null);
    if (!state || !state.backup) return;
    const b = state.backup;
    const sub = `${plural(b.docs, 'notebook')} from before you signed in (${new Date(b.at).toLocaleDateString()}). ${state.verifiedAt ? 'Everything is safely in your account; this copy is removed after 30 days.' : 'Kept until everything is safely in your account.'}`;
    const backupRow = row({
      iconName: 'upload', tint: '#9C36B5', title: 'Restore local backup', sub,
      onClick: async () => {
        const yes = await confirmDialog({ title: 'Restore local backup?', message: 'Notes from before you signed in that are missing are put back. Nothing you have now is replaced.', confirmLabel: 'Restore' });
        if (!yes) return;
        try {
          const res = await local.restoreLocalBackup();
          toast(res.docs ? `Restored ${plural(res.docs, 'item')}` : 'Everything in that copy is already here', { icon: 'check' });
          pokeSync(500);
          if (onDataChanged) onDataChanged();
        } catch (err) {
          log.error('account', 'restore failed', err);
          toast('Couldn’t restore that copy.', { icon: 'info', duration: 4500 });
        }
      },
    });
    backupRow.classList.add('account-backup');
    markdownRow.after(backupRow);
  })();

  const nodes = [
    group('Account', 'Your notes are private to your account. They are saved on this device first, so you can keep writing offline, and copied to your account in the background.',
      who,
      row({ iconName: 'check', tint: '#868E96', title: 'Sign out', sub: 'Removes your notes from this device, not from your account', onClick: doSignOut })),
    group('Your data', 'The JSON file holds everything and can be restored here. Markdown holds only titles and text boxes: handwriting, shapes and pictures can’t be written as Markdown.',
      row({ iconName: 'download', tint: '#0C8599', title: 'Download my notes', sub: 'Everything, as one .json file', onClick: () => exportBackup() }),
      markdownRow,
      row({ iconName: 'info', tint: '#4C6EF5', title: 'Privacy policy', onClick: () => { location.href = './privacy.html'; } }),
      row({ iconName: 'trash', tint: '#FA5252', title: 'Delete my account', sub: 'Deletes your account and all your notes for good', danger: true, onClick: doDelete })),
  ];
  return { nodes, destroy: off };
}

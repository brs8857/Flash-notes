// Settings sheet.
import { h, formatBytes, isIOS, isStandalone, filePicker, plural } from './dom.js';
import { icon } from './icons.js';
import { openSheet, alertDialog } from './sheet.js';
import { toast } from './toast.js';
import { exportBackup } from './export.js';
import * as store from '../store.js';

function toggle(checked, label, onChange) {
  const input = h('input', { type: 'checkbox', class: 'switch-input', checked, role: 'switch', 'aria-label': label, onChange: e => onChange(e.target.checked) });
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' })));
}

function row({ iconName, tint, title, sub, control, onClick, danger }) {
  const kids = [
    iconName ? h('span', { class: 'row-icon', style: tint ? { '--tint': tint } : null, 'data-squircle': '8' }, icon(iconName, 18, 2)) : null,
    h('span', { class: 'row-text' }, h('span', { class: `row-title ${danger ? 'row-title--danger' : ''}` }, title), sub ? h('span', { class: 'row-sub' }, sub) : null),
    control || (onClick ? h('span', { class: 'row-chevron' }, icon('chevronRight', 16, 2.4)) : null),
  ];
  return onClick
    ? h('button', { class: 'row row--button', type: 'button', onClick }, ...kids)
    : h('div', { class: 'row' }, ...kids);
}

const group = (label, footer, ...rows) => h('section', { class: 'group' },
  label ? h('div', { class: 'group-label' }, label) : null,
  h('div', { class: 'group-box', 'data-squircle': '16' }, ...rows),
  footer ? h('div', { class: 'group-footer' }, footer) : null);

/** openSettings(app, {onDataChanged, view}) — view is the live CanvasView when opened from the editor. */
export function openSettings(app, { onDataChanged } = {}) {
  const s = app.settings;

  // Appearance
  const themes = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
  const themeSeg = h('div', { class: 'opt-seg opt-seg--wide', role: 'radiogroup', 'aria-label': 'Appearance' });
  const themeBtns = themes.map(([id, label]) => h('button', {
    type: 'button', class: 'opt-seg-btn', role: 'radio', 'aria-checked': String((s.theme || 'system') === id),
    onClick: () => {
      themeBtns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === id)));
      app.updateSettings({ theme: id });
    },
    dataset: { theme: id },
  }, label));
  themeSeg.append(...themeBtns);

  // Storage
  const usageSub = h('span', { class: 'row-sub' }, 'Saved on this device');
  const usageRow = h('div', { class: 'row' },
    h('span', { class: 'row-icon', style: { '--tint': '#40C057' }, 'data-squircle': '8' }, icon('download', 18, 2)),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Storage'), usageSub));
  const persistSub = h('span', { class: 'row-sub' }, 'Ask the browser never to clear your notes');
  const persistState = h('span', { class: 'row-state' });
  const persistRow = h('button', { class: 'row row--button', type: 'button', onClick: askPersist },
    h('span', { class: 'row-icon', style: { '--tint': '#4C6EF5' }, 'data-squircle': '8' }, icon('shield', 18, 2)),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, 'Keep my notes safe'), persistSub),
    persistState);

  async function refreshStorage() {
    const [{ usage }, persisted] = await Promise.all([store.storageEstimate(), store.isPersisted()]);
    usageSub.textContent = usage ? `Using ${formatBytes(usage)} · saved on this device` : 'Saved on this device';
    setPersisted(persisted);
  }
  function setPersisted(ok) {
    persistState.textContent = ok ? 'On' : '';
    persistState.classList.toggle('row-state--on', ok);
    if (ok) persistSub.textContent = 'Protected: the browser will not clear your notes to free up space';
  }
  async function askPersist() {
    const ok = await store.requestPersistence();
    setPersisted(ok);
    if (ok) toast('Your notes are protected on this device', { icon: 'shield' });
    else toast(isIOS() && !isStandalone() ? 'Add Flash Notes to your Home Screen to protect your notes' : 'The browser didn’t allow it yet. Keep using the app and try again, and keep a backup.', { icon: 'info', duration: 4500 });
  }

  // Backup / restore
  const picker = filePicker('.json,application/json');
  function restore() {
    picker.pick(async file => {
      const mode = await alertDialog({
        title: 'Restore backup',
        message: `“${file.name}”\n\nMerge adds the backup to what’s already here. Replace deletes everything on this device first.`,
        buttons: [
          { label: 'Merge with my notes', value: 'merge', style: 'primary' },
          { label: 'Replace everything', value: 'replace', style: 'danger' },
          { label: 'Cancel', value: null, style: 'cancel' },
        ],
      });
      if (!mode) return;
      try {
        const r = await store.importAll(file, { mode });
        toast(r.docs ? `Restored ${plural(r.docs, 'item')} (${plural(r.pages, 'page')})` : 'Everything in that backup is already here', { icon: 'check' });
        refreshStorage();
        if (onDataChanged) onDataChanged();
        else if (mode === 'replace') app.back();   // opened from an editor whose notebook may no longer exist
      } catch (err) {
        toast(err.message || 'Could not restore that file', { icon: 'info', duration: 4500 });
      }
    });
  }

  const showA2hs = isIOS() && !isStandalone();
  const a2hs = showA2hs ? group('Install', 'Safari can delete website data from ordinary tabs after 7 days without use. Apps added to the Home Screen are exempt, work offline and open full screen.',
    h('div', { class: 'row row--tall' },
      h('span', { class: 'row-icon', style: { '--tint': '#F59F00' }, 'data-squircle': '8' }, icon('addHome', 18, 2)),
      h('span', { class: 'row-text' },
        h('span', { class: 'row-title' }, 'Add to Home Screen to protect your notes'),
        h('span', { class: 'row-sub' }, 'In Safari tap ', h('span', { class: 'inline-icon' }, icon('share', 15, 2.2)), ' Share, then “Add to Home Screen”.')))) : null;

  const body = h('div', { class: 'settings' },
    group('Appearance', null, h('div', { class: 'row row--seg' }, themeSeg)),
    group('Drawing', 'With Pencil-only on, your fingers scroll and zoom and only Apple Pencil draws. It switches on by itself the first time a Pencil touches the page.',
      row({ iconName: 'pencilOnly', tint: '#4C6EF5', title: 'Pencil-only drawing', control: toggle(!!s.pencilOnlyUser, 'Pencil-only drawing', v => app.updateSettings({ pencilOnlyUser: v })) }),
      row({ iconName: 'undo', tint: '#868E96', title: 'Two-finger tap to undo', control: toggle(s.twoFingerUndo !== false, 'Two-finger tap to undo', v => app.updateSettings({ twoFingerUndo: v })) })),
    group('Smart ink', 'Hold the pen still at the end of a stroke to snap a shape at any time. Every change is one undo step, and “Keep original” puts your own ink back.',
      row({ iconName: 'sparkle', tint: '#9C36B5', title: 'Auto shapes', sub: 'Lines, arrows, axes, circles and boxes straighten when you lift the pen',
        control: toggle(s.autoShapes !== false, 'Auto shapes', v => app.updateSettings({ autoShapes: v })) }),
      row({ iconName: 'pen', tint: '#0C8599', title: 'Auto-tidy handwriting', sub: 'Gently straightens and evens each line once you move on',
        control: toggle(s.autoTidy !== false, 'Auto-tidy handwriting', v => app.updateSettings({ autoTidy: v })) })),
    a2hs,
    group('Storage', 'Notes never leave this device. There are no accounts and no servers, so the only limit is your device’s free space.',
      usageRow, persistRow),
    group('Backup', 'A backup is one file with every notebook and whiteboard. Save it to Files or iCloud Drive now and then, especially before clearing Safari data or changing iPad.',
      row({ iconName: 'download', tint: '#0C8599', title: 'Download backup', sub: 'Save all notes as one .json file', onClick: () => exportBackup() }),
      row({ iconName: 'upload', tint: '#9C36B5', title: 'Restore from backup', sub: 'Merge or replace with a backup file', onClick: restore })),
    h('section', { class: 'about' },
      h('div', { class: 'about-icon', 'data-squircle': '15' }),
      h('div', { class: 'about-name' }, 'Flash Notes'),
      h('div', { class: 'about-text' }, 'Free forever. No account, no ads, no limits. Made by students, for students.'),
      h('div', { class: 'about-meta' }, `Version ${app.version} · handwriting powered by perfect-freehand (MIT) · Patrick Hand font (OFL)`)));

  const sheet = openSheet({ title: 'Settings', body, size: 'md', doneLabel: 'Done', className: 'sheet--grouped', onClose: () => picker.destroy() });
  refreshStorage();
  return sheet;
}

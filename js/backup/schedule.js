// When is an automatic backup due? Pure rules (no clock, no storage), tested in tests/backup.test.mjs.
//
// A web app cannot wake itself up, so these rules are only asked while Flash Notes is open: at launch, when
// it comes back to the screen, and once a minute while it stays open. Opening the app after a long gap
// therefore makes exactly ONE backup (the last run is simply "long enough ago"), never one per missed slot.

export const INTERVALS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
};
export const INTERVAL_LABELS = [['1h', 'Hourly'], ['6h', '6 hours'], ['1d', 'Daily'], ['1w', 'Weekly'], ['1m', 'Monthly']];
export const KEEP_CHOICES = [3, 5, 10, 20];
export const DEFAULTS = { autoBackup: false, backupInterval: '1d', backupKeep: 5, backupDest: 'app' };
export const SNOOZE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SLACK = 5 * 60 * 1000;

/** The backup settings, with anything missing or unknown replaced by the default. */
export function backupSettings(s = {}) {
  return {
    autoBackup: s.autoBackup === true,
    backupInterval: INTERVALS[s.backupInterval] ? s.backupInterval : DEFAULTS.backupInterval,
    backupKeep: KEEP_CHOICES.includes(s.backupKeep) ? s.backupKeep : DEFAULTS.backupKeep,
    backupDest: ['app', 'folder', 'file'].includes(s.backupDest) ? s.backupDest : DEFAULTS.backupDest,
  };
}

/**
 * True when "now − the last run ≥ the interval". A last run in the future (the device clock was moved back)
 * counts as due, once: the run then records the new "now".
 */
export function isDue({ enabled, interval, lastRunAt, now }) {
  if (!enabled) return false;
  const ms = INTERVALS[interval];
  if (!ms) return false;
  if (!lastRunAt) return true;
  if (lastRunAt > now + CLOCK_SLACK) return true;
  return now - lastRunAt >= ms;
}

/** When the next automatic run falls due (ms), or null when auto backup is off. */
export function nextDueAt({ enabled, interval, lastRunAt, now }) {
  if (!enabled || !INTERVALS[interval]) return null;
  if (!lastRunAt || lastRunAt > now + CLOCK_SLACK) return now;
  return lastRunAt + INTERVALS[interval];
}

/**
 * Should the "Backup ready – Save" banner be shown (destination "Save a file")? Only when there is a
 * backup newer than the last file the user saved, the interval has passed since that save, and the user
 * has not snoozed it.
 */
export function shouldOfferFile({ dest, latestFingerprint, lastFileFingerprint, lastFileAt, snoozeUntil, interval, now, manual = false }) {
  if (dest !== 'file' || !latestFingerprint) return false;
  if (manual) return true;
  if (latestFingerprint === lastFileFingerprint) return false;
  if (snoozeUntil && now < snoozeUntil && snoozeUntil - now <= SNOOZE_MS + CLOCK_SLACK) return false;
  const ms = INTERVALS[interval] || INTERVALS['1d'];
  if (lastFileAt && lastFileAt <= now + CLOCK_SLACK && now - lastFileAt < ms) return false;
  return true;
}

/** File name for a backup made at `t`: flash-notes-backup-YYYY-MM-DD-HHmm.flashnotes (local time). */
export function backupFileName(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `flash-notes-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.flashnotes`;
}
export const BACKUP_FILE_RE = /^flash-notes-backup-\d{4}-\d{2}-\d{2}-\d{4}(?: \(\d+\))?\.flashnotes$/;

/** Which of these folder file names to delete so that only the newest `keep` remain (ours only). */
export function namesToPrune(names, keep, protect = null) {
  // `protect` (the file just written) is never returned: names are local time, so after a time-zone or
  // clock change the newest file can sort as the oldest.
  const ours = names.filter(n => BACKUP_FILE_RE.test(n) && n !== protect).sort();
  const room = Math.max(0, keep - (protect && names.includes(protect) && BACKUP_FILE_RE.test(protect) ? 1 : 0));
  return ours.slice(0, Math.max(0, ours.length - room));
}

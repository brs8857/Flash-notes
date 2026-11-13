// First sign-in on a device: what happens to notes that are already there. Pure decisions + a small
// runner over js/sync/local.js. Tested in tests/migrate.test.mjs.
//
// Rules (owner's decision: local notes are uploaded to the account at the first sign-in):
//   * The device remembers which account its notes belong to (sync:state.userId). That marker is written
//     LAST, so an interrupted first run simply runs again, and once it exists the upload is never repeated.
//   * Before anything is queued, a full copy of the device's notes is saved on the device ("local backup").
//     It is kept until the account has been checked to hold everything, and for 30 days after that. It can
//     be put back from Settings at any time (merge: nothing is overwritten).
//   * Items are queued with their own ids and times. Uploading is an upsert by id, so running twice, or
//     signing in on a second device that holds the same notes, never creates duplicates.
//   * Notes that belong to one account are never mixed into another: if a different account signs in while
//     notes of the first are still on the device, nothing is uploaded until the user has chosen.

export const BACKUP_KEEP_MS = 30 * 24 * 3600 * 1000;

/** → 'resume' (same account) | 'adopt' (unowned notes → upload) | 'fresh' (nothing here) | 'conflict'. */
export function decideAdoption({ ownerId, userId, localDocs }) {
  if (!userId) return 'conflict';
  if (ownerId) return ownerId === userId ? 'resume' : 'conflict';
  return localDocs > 0 ? 'adopt' : 'fresh';
}

/**
 * Runs the decision. Returns {decision, queued, backup}. Safe to call on every start.
 * `local` is js/sync/local.js (or a test double with the same functions).
 */
export async function enterAccount(local, userId, { now = Date.now } = {}) {
  const state = await local.getState();
  const decision = decideAdoption({ ownerId: state.userId, userId, localDocs: await local.countDocs() });
  if (decision === 'conflict') return { decision, queued: 0, backup: null };
  if (decision === 'resume') {
    // Housekeeping: the first-sign-in copy expires 30 days after the account was verified to hold everything.
    if (state.backup && state.verifiedAt && now() - state.verifiedAt > BACKUP_KEEP_MS) await local.dropLocalBackup();
    return { decision, queued: 0, backup: state.backup || null };
  }
  let backup = null;
  let queued = 0;
  if (decision === 'adopt') {
    backup = await local.saveLocalBackup();        // 1. keep a copy
    queued = await local.markAllDirty();           // 2. queue everything (idempotent)
  }
  // 3. the marker, last: from now on these notes belong to this account
  await local.patchState({ userId, adoptedAt: decision === 'adopt' ? now() : null, verifiedAt: null });
  return { decision, queued, backup };
}

/** A different account's notes are on the device and the user chose to erase them and carry on. */
export async function eraseAndEnter(local, userId) {
  await local.wipeUserData();
  await local.patchState({ userId, adoptedAt: null, verifiedAt: null });
}

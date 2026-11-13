// The sync engine, free of browser and Supabase specifics so it can be tested in Node (tests/sync.test.mjs).
//
//   local  = js/sync/local.js   (IndexedDB: upload queue, versions, applying rows)
//   remote = js/sync/remote.js  (the account: Postgres rows through Supabase, images in private storage)
//
// Conflict rule: LAST WRITE WINS PER ITEM. An item is one notebook/whiteboard record (title, cover, page
// order) or one page (all its strokes, text and images). Each change carries the time it was made on the
// device (`updated_at`, ms). Deletions are kept as tombstones so they travel like any other change.
//   * pull: a row from the account replaces the device's copy unless the device has an unsent change that
//           is the same age or newer (that change is then uploaded and wins).
//   * push: the database skips a write that is older than what it already has (trigger `sync_guard`);
//           the skipped item is then downloaded on the next pull.
// See SPEC "Auth & sync v2.0" for the cases where this loses an edit (two devices editing the SAME page
// while one is offline) and why that was accepted.
import { docToRow, pageToRow, tombstoneRow, rowToPage, validId, jsonBytes } from './map.js';
import { offloadImages, inloadImages } from './images.js';

const HEAD_PAGE = 500;
const DOC_BATCH = 20;
const PAGE_BATCH_BYTES = 600000;
const BODY_CHUNK = { doc: 40, page: 8 };

export function createSync({ local, remote, onProgress, pause }) {
  const progress = onProgress || (() => {});
  const breathe = pause || (() => Promise.resolve());
  // Building or applying one big page (hundreds of strokes) takes tens of milliseconds on the main thread.
  // Give the pen a chance between items so a sync that is already running never makes drawing stutter.
  let sliceAt = Date.now();
  const slice = async () => { if (Date.now() - sliceAt > 12) await breathe(); sliceAt = Date.now(); };

  async function allHeads(kind, since) {
    const out = [];
    let cursor = since;
    for (;;) {
      const heads = await remote.heads(kind, cursor, HEAD_PAGE);
      for (const h of heads) { if (validId(h.id)) out.push(h); cursor = Math.max(cursor, Number(h.rev) || 0); }
      if (heads.length < HEAD_PAGE) break;
    }
    return { heads: out, cursor };
  }

  /** Downloads what changed in the account. full = compare everything (used once per app start). */
  async function pull({ full = false } = {}) {
    const state = await local.getState();
    const since = full ? { doc: 0, page: 0 } : { doc: state.cursors?.doc || 0, page: state.cursors?.page || 0 };
    const [vers, dirtyRows] = await Promise.all([local.versions(), local.dirty()]);
    const dirtyAt = new Map(dirtyRows.map(d => [`${d.kind}:${d.id}`, d.at]));
    const wanted = {};
    const cursors = {};
    for (const kind of ['page', 'doc']) {
      const { heads, cursor } = await allHeads(kind, since[kind]);
      cursors[kind] = cursor;
      wanted[kind] = heads.filter(h => {
        const key = `${kind}:${h.id}`;
        const v = vers.get(key);
        if (v && v.r === Number(h.rev)) return false;                 // this device already has exactly this version
        if (!v && h.deleted && !dirtyAt.has(key)) return false;       // deleted before this device ever saw it
        const at = dirtyAt.get(key);
        if (at != null && at >= Number(h.updated_at)) return false;   // the device's unsent change is newer: it will be pushed
        return true;
      });
    }
    let applied = 0;
    const apply = async (kind, row, page) => { if ((await local.applyRow(kind, row, page)) === 'applied') applied++; };
    const bodies = async (kind, heads, each) => {
      const live = heads.filter(h => !h.deleted);
      for (let i = 0; i < live.length; i += BODY_CHUNK[kind]) {
        const rows = await remote.bodies(kind, live.slice(i, i + BODY_CHUNK[kind]).map(h => h.id));
        for (const row of rows) { await slice(); await each(row); }
        await breathe();
      }
    };
    // Order matters: pages before the notebooks that list them, deletions last.
    await bodies('page', wanted.page, async row => {
      const page = rowToPage(row);
      if (!page) return;
      const mine = await local.read('page', row.id);
      page.items = await inloadImages(page.items, mine ? mine.items : null, remote.images);
      await apply('page', row, page);
    });
    await bodies('doc', wanted.doc, row => apply('doc', row));
    for (const h of wanted.doc) if (h.deleted) await apply('doc', h);
    for (const h of wanted.page) if (h.deleted) await apply('page', h);
    await local.patchState({ cursors: { doc: Math.max(cursors.doc, state.cursors?.doc || 0), page: Math.max(cursors.page, state.cursors?.page || 0) } });
    return { applied };
  }

  /** Uploads the queue. Returns {pushed, stale, blocked, left}. */
  async function push() {
    const queue = (await local.dirty()).filter(d => !d.blocked);
    const vers = await local.versions();
    const result = { pushed: 0, stale: 0, blocked: 0, left: 0 };
    // Pages first (so a notebook never lists a page the account has not got), deletions last.
    const order = d => (d.deleted ? 2 : d.kind === 'page' ? 0 : 1);
    queue.sort((a, b) => order(a) - order(b) || a.at - b.at);

    let batch = [];
    let batchKind = null;
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const sending = batch; const kind = batchKind;
      batch = []; batchKind = null; batchBytes = 0;
      const accepted = new Map((await remote.push(kind, sending.map(b => b.row))).map(r => [r.id, r]));
      for (const b of sending) {
        const got = accepted.get(b.row.id);
        if (got) {
          await local.setSynced(kind, b.row.id, b.at, { u: Number(got.updated_at), d: b.row.deleted, r: Number(got.rev) });
          result.pushed++;
        } else {
          result.stale++;          // the account has something newer; the next pull brings it down
        }
      }
      progress(result);
      await breathe();
    };

    for (const d of queue) {
      await slice();
      let row;
      try {
        if (!validId(d.id)) throw new Error('invalid-id');
        const rec = d.deleted ? null : await local.read(d.kind, d.id);
        if (!rec) {
          const v = vers.get(`${d.kind}:${d.id}`);
          if (!v) { await local.dropDirty(d.kind, d.id, d.at); continue; }   // the account never had it
          row = tombstoneRow(d.kind, d.id, d.at, d.docKind);
        } else if (d.kind === 'doc') {
          row = docToRow(rec, d.at);
        } else {
          const items = await offloadImages(rec.items, remote.images);
          row = pageToRow({ ...rec, items }, d.at);
        }
      } catch (err) {
        if (err && /^(invalid-id|invalid-kind|too-large)$/.test(err.message)) {
          await local.blockDirty(d.kind, d.id, d.at, err.message);
          result.blocked++;
          continue;
        }
        throw err;
      }
      const size = jsonBytes(row.data);
      const limit = d.kind === 'doc' ? DOC_BATCH : 50;
      if (batch.length && (batchKind !== d.kind || batch.length >= limit || batchBytes + size > PAGE_BATCH_BYTES)) await flush();
      batchKind = d.kind;
      batch.push({ row, at: d.at });
      batchBytes += size;
    }
    await flush();
    result.left = (await local.dirty()).filter(d => !d.blocked).length;
    return result;
  }

  /** One full round: pull, push, and pull again if the account refused something as stale. */
  async function syncOnce({ full = false } = {}) {
    const pulled = await pull({ full });
    const pushed = await push();
    let again = { applied: 0 };
    if (pushed.stale) again = await pull({ full: false });
    const left = (await local.dirty()).filter(d => !d.blocked).length;
    return { applied: pulled.applied + again.applied, pushed: pushed.pushed, stale: pushed.stale, blocked: pushed.blocked, left };
  }

  /**
   * After the first upload: checks that the account really holds every item this device has, at the same
   * version. Only then is the first-sign-in copy of the notes allowed to expire.
   */
  async function verify() {
    if ((await local.dirty()).some(d => !d.blocked)) return false;
    const vers = await local.versions();
    const seen = new Map();
    for (const kind of ['doc', 'page']) {
      const { heads } = await allHeads(kind, 0);
      for (const h of heads) seen.set(`${kind}:${h.id}`, h);
    }
    for (const [key, v] of vers) {
      const h = seen.get(key);
      if (!h) { if (v.d) continue; return false; }      // an old tombstone the account has already forgotten
      if (Number(h.rev) !== v.r || !!h.deleted !== !!v.d) return false;
    }
    return true;
  }

  return { pull, push, syncOnce, verify };
}

// TEST ONLY. An in-memory stand-in for the Supabase project, used by the Node sync tests and by the e2e
// test server (tests/harness/serve.mjs). It mirrors the rules of supabase/migrations that the client
// relies on: rows are keyed by (owner, id), the owner always comes from the session token, a write older
// than the stored row is skipped, every accepted write gets a new `rev`, tombstones lose their content.
// The REAL rules are tested against Postgres in tests/rls.test.mjs; this file only has to behave the same.
import { randomUUID, createHash } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class FakeBackend {
  constructor() {
    this.users = new Map();      // uid → {id, email, name, verified, identities}
    this.sessions = new Map();   // access token → {uid, refresh}
    this.tables = { doc: new Map(), page: new Map() };   // "uid/id" → row
    this.images = new Map();     // "uid/name" → Buffer
    this.rev = 0;
    this.uploads = 0;
    this.requests = 0;
    this.failNext = null;        // {status, message}: the next data request fails like this (tests)
  }

  // ---- auth
  addUser({ email, name, verified = true, linked = false }) {
    for (const u of this.users.values()) if (u.email === email) return u;
    const u = { id: randomUUID(), email, name, verified, linked };
    this.users.set(u.id, u);
    return u;
  }
  userJson(u) {
    const identities = [{ provider: 'google', identity_data: { email: u.email, email_verified: u.verified, full_name: u.name, sub: 'g-' + u.id.slice(0, 8) } }];
    if (u.linked) identities.push({ provider: 'other', identity_data: { email: u.email } });
    return { id: u.id, email: u.email, app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: u.name, email_verified: u.verified }, identities };
  }
  createSession(uid) {
    const access = 'fake-access-' + randomUUID(), refresh = 'fake-refresh-' + randomUUID();
    this.sessions.set(access, { uid, refresh });
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: this.userJson(this.users.get(uid)) };
  }
  refresh(refreshToken) {
    for (const [access, s] of this.sessions) {
      if (s.refresh === refreshToken) { this.sessions.delete(access); return this.users.has(s.uid) ? this.createSession(s.uid) : null; }
    }
    return null;
  }
  revoke(access) { this.sessions.delete(access); }
  revokeAllFor(uid) { for (const [a, s] of this.sessions) if (s.uid === uid) this.sessions.delete(a); }
  /** → uid, or throws a 401-shaped error, exactly where the real API would. */
  auth(access) {
    const s = this.sessions.get(access);
    if (!s || !this.users.has(s.uid)) { const e = new Error('JWT expired'); e.status = 401; e.code = 'PGRST301'; throw e; }
    return s.uid;
  }
  gate(uid) {
    this.requests++;
    if (this.failNext) { const f = this.failNext; this.failNext = null; const e = new Error(f.message || 'boom'); e.status = f.status || 500; e.code = f.code || ''; throw e; }
    const u = this.users.get(uid);
    if (!u.profile || !u.verified || u.linked) { const e = new Error('new row violates row-level security policy'); e.status = 403; e.code = '42501'; throw e; }
  }

  // ---- data (uid always comes from auth(), never from the request)
  ensureProfile(uid) {
    const u = this.users.get(uid);
    u.profile = true;
    return { id: u.id, provider: 'google', email: u.email, display_name: u.name, verified: !!u.verified && !u.linked };
  }
  heads(uid, kind, since, limit) {
    this.gate(uid);
    return [...this.tables[kind].values()].filter(r => r.owner === uid && r.rev > since).sort((a, b) => a.rev - b.rev).slice(0, limit)
      .map(r => ({ id: r.id, updated_at: r.updated_at, deleted: r.deleted, rev: r.rev }));
  }
  bodies(uid, kind, ids) {
    this.gate(uid);
    return ids.map(id => this.tables[kind].get(uid + '/' + id)).filter(Boolean).map(({ owner, ...r }) => structuredClone(r));
  }
  push(uid, kind, rows) {
    this.gate(uid);
    const out = [];
    for (const row of rows) {
      if ('owner_id' in row) { const e = new Error('row-level security'); e.status = 403; throw e; }
      if (!ID_RE.test(row.id) || (kind === 'doc' && !['notebook', 'whiteboard'].includes(row.kind)) || String(row.title || '').length > 200) {
        const e = new Error('violates check constraint'); e.status = 400; e.code = '23514'; throw e;
      }
      const key = uid + '/' + row.id;
      const old = this.tables[kind].get(key);
      if (old && row.updated_at < old.updated_at) continue;                     // last write wins
      const next = { ...structuredClone(row), owner: uid, rev: ++this.rev, updated_at: Math.min(row.updated_at, Date.now() + 300000) };
      if (next.deleted) { next.data = {}; if (kind === 'doc') next.title = ''; }
      this.tables[kind].set(key, next);
      out.push({ id: next.id, updated_at: next.updated_at, rev: next.rev });
    }
    return out;
  }
  upload(uid, name, bytes) {
    this.gate(uid);
    if (!/^[0-9a-f]{64}\.(jpg|png)$/.test(name)) { const e = new Error('policy'); e.status = 403; throw e; }
    const key = uid + '/' + name;
    if (this.images.has(key)) { const e = new Error('The resource already exists'); e.status = 409; throw e; }
    if (createHash('sha256').update(bytes).digest('hex') !== name.slice(0, 64)) throw new Error('test bug: name is not the hash');
    this.images.set(key, Buffer.from(bytes));
    this.uploads++;
  }
  download(uid, name) {
    this.gate(uid);
    const b = this.images.get(uid + '/' + name);
    if (!b) { const e = new Error('Object not found'); e.status = 404; throw e; }
    return b;
  }
  deleteUser(uid) {
    for (const kind of ['doc', 'page']) for (const [k, r] of this.tables[kind]) if (r.owner === uid) this.tables[kind].delete(k);
    for (const k of [...this.images.keys()]) if (k.startsWith(uid + '/')) this.images.delete(k);
    this.revokeAllFor(uid);
    this.users.delete(uid);
  }
  count(uid) {
    const n = kind => [...this.tables[kind].values()].filter(r => r.owner === uid).length;
    const live = kind => [...this.tables[kind].values()].filter(r => r.owner === uid && !r.deleted).length;
    return { docs: n('doc'), pages: n('page'), liveDocs: live('doc'), livePages: live('page'), images: [...this.images.keys()].filter(k => k.startsWith(uid + '/')).length };
  }

  /** The `remote` object js/sync/core.js expects, bound to one signed-in user. */
  remoteFor(uid, known = new Set()) {
    const session = this.createSession(uid);
    const me = () => this.auth(session.access_token);
    this.ensureProfile(uid);
    return {
      session,
      heads: async (kind, since, limit) => this.heads(me(), kind, since, limit),
      bodies: async (kind, ids) => this.bodies(me(), kind, ids),
      push: async (kind, rows) => this.push(me(), kind, rows),
      images: {
        hasUploaded: async name => known.has(name),
        remember: async name => { known.add(name); },
        upload: async (name, bytes) => { try { this.upload(me(), name, bytes); } catch (e) { if (e.status !== 409) throw e; } },
        download: async name => new Uint8Array(this.download(me(), name)),
      },
    };
  }
}

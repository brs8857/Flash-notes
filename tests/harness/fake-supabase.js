// TEST ONLY — a stand-in for vendor/supabase-js.js.
//
// It is never loaded by the app: no file in js/, index.html or sw.js refers to it. The only way it runs is
// when tests/harness/serve.mjs (a Node test server on localhost) answers the request for
// "vendor/supabase-js.js" with this file instead. There is no URL parameter, setting or config value that
// switches it on, and it refuses to work anywhere but localhost.
if (!['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('fake-supabase is a test double and only runs on localhost');

export function createClient(url, key, opts = {}) {
  const a = opts.auth || {};
  const storageKey = a.storageKey || 'sb-test';
  const listeners = new Set();
  const emit = (event, session) => listeners.forEach(fn => { try { fn(event, session); } catch { /* ignore */ } });
  const read = () => { try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; } };
  const save = s => { if (s) localStorage.setItem(storageKey, JSON.stringify(s)); else localStorage.removeItem(storageKey); };
  const fail = (status, message, code) => ({ data: null, error: { message, status, code: code || '', name: status === 0 ? 'AuthRetryableFetchError' : 'ApiError' }, status });

  async function call(path, { body, raw, auth = true } = {}) {
    const headers = { apikey: key };
    const s = read();
    if (auth && s) headers.Authorization = 'Bearer ' + s.access_token;
    let res;
    try {
      res = await fetch(url + '/__fake/' + path, { method: 'POST', headers: raw ? headers : { ...headers, 'Content-Type': 'application/json' }, body: raw || JSON.stringify(body || {}) });
    } catch (err) { return fail(0, 'Failed to fetch'); }
    if (!res.ok) { let j = {}; try { j = await res.json(); } catch { /* ignore */ } return fail(res.status, j.message || 'error', j.code); }
    return { data: res, error: null, status: res.status };
  }
  const callJson = async (path, o) => { const r = await call(path, o); return r.error ? r : { data: await r.data.json(), error: null, status: 200 }; };

  const auth = {
    async signInWithOAuth({ provider, options = {} }) {
      if (a.flowType !== 'pkce') return fail(400, 'test expects the PKCE flow');
      const verifier = 'v-' + crypto.randomUUID();
      localStorage.setItem(storageKey + '-code-verifier', verifier);
      const r = await callJson('authorize', { auth: false, body: { provider, redirect_to: options.redirectTo, scopes: options.scopes, query: options.queryParams, code_challenge: 'c:' + verifier } });
      if (r.error) return r;
      location.assign(r.data.url);
      return { data: { provider, url: r.data.url }, error: null };
    },
    async exchangeCodeForSession(code) {
      const verifier = localStorage.getItem(storageKey + '-code-verifier');
      localStorage.removeItem(storageKey + '-code-verifier');
      if (!verifier) return fail(400, 'both auth code and code verifier should be non-empty', 'bad_code_verifier');
      const r = await callJson('token', { auth: false, body: { code, code_verifier: verifier } });
      if (r.error) return r;
      save(r.data);
      emit('SIGNED_IN', r.data);
      return { data: { session: r.data, user: r.data.user }, error: null };
    },
    async getSession() { return { data: { session: read() }, error: null }; },
    async refreshSession() {
      const s = read();
      if (!s) return fail(400, 'Auth session missing!', 'session_not_found');
      const r = await callJson('refresh', { auth: false, body: { refresh_token: s.refresh_token } });
      if (r.error) {
        if (r.error.status !== 0) { save(null); emit('SIGNED_OUT', null); }
        return r;
      }
      save(r.data);
      emit('TOKEN_REFRESHED', r.data);
      return { data: { session: r.data, user: r.data.user }, error: null };
    },
    onAuthStateChange(fn) { listeners.add(fn); return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } }; },
    async signOut() {
      const had = read();
      save(null);                                   // like supabase-js: the device is signed out first
      if (had) await fetch(url + '/__fake/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + had.access_token } }).catch(() => {});
      emit('SIGNED_OUT', null);
      return { error: null };
    },
  };

  function from(table) {
    const q = { table, op: 'select', filters: {} };
    const b = {
      select(cols) { if (q.op === 'select') q.cols = cols; else q.returning = cols; return b; },
      gt(col, v) { q.filters.gt = [col, v]; return b; },
      in(col, v) { q.filters.in = [col, v]; return b; },
      order(col) { q.order = col; return b; },
      limit(n) { q.limit = n; return b; },
      upsert(rows, o) { q.op = 'upsert'; q.rows = rows; q.onConflict = o && o.onConflict; return b; },
      then(resolve, reject) { return callJson('db', { body: q }).then(resolve, reject); },
    };
    return b;
  }

  return {
    auth,
    from,
    rpc: name => callJson('rpc/' + name, { body: {} }),
    storage: {
      from: bucket => ({
        async upload(path, blob) {
          const r = await call(`storage/upload?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`, { raw: blob });
          return r.error ? { data: null, error: { ...r.error, statusCode: String(r.error.status) } } : { data: { path }, error: null };
        },
        async download(path) {
          const r = await call(`storage/download?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`, { body: {} });
          return r.error ? { data: null, error: r.error } : { data: await r.data.blob(), error: null };
        },
      }),
    },
    functions: {
      async invoke(name, { body } = {}) {
        const r = await callJson('functions/' + name, { body });
        return r.error ? { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status: r.error.status } } } : r;
      },
    },
  };
}

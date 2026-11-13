// TEST ONLY. Serves the app from the repository for the browser tests, with two substitutions made HERE,
// in the test server, and nowhere in the app:
//   /vendor/supabase-js.js → tests/harness/fake-supabase.js   (a fake Supabase client)
//   /js/config.js          → a config pointing at this server  (so the app runs "with accounts")
// plus the fake backend's endpoints under /__fake/. The app's own files are served unmodified, including
// index.html with its real Content-Security-Policy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { FakeBackend } from './fake-backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.woff2': 'font/woff2' };
const BASE = '/flash-notes';     // a sub-path, like GitHub Pages

export function startServer(port, { accounts = true } = {}) {
  const backend = new FakeBackend();
  const state = {
    backend,
    nextLogin: null,       // what "Google" does next: {email, name, verified?, linked?} | {error:'access_denied'} | {cancel:true} | {down:true}
    authorizeCalls: [],    // what the app asked for (provider, scopes, PKCE challenge…)
    codes: new Map(),
    functionCalls: 0,
  };
  const origin = `http://localhost:${port}`;
  const config = `export const SUPABASE_URL = '${origin}';\nexport const SUPABASE_ANON_KEY = 'test-anon-key';\nexport function configProblem() { return null; }\nexport function isConfigured() { return true; }\n`;

  const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  const readBody = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
  const bearer = req => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  async function fake(req, res, url) {
    const name = url.pathname.slice('/__fake/'.length);
    const raw = await readBody(req);
    const json = () => { try { return JSON.parse(raw.toString() || '{}'); } catch { return {}; } };
    try {
      if (name === 'authorize') {
        const body = json();
        state.authorizeCalls.push(body);
        const next = state.nextLogin || { error: 'server_error' };
        if (next.down) return send(res, 503, { message: 'Service Unavailable' });
        const back = new URL(body.redirect_to);
        if (next.cancel) return send(res, 200, { url: back.toString() });
        if (next.error) { back.searchParams.set('error', next.error); back.searchParams.set('error_code', next.error_code || 'unexpected_failure'); back.searchParams.set('error_description', next.description || 'Something <b>odd</b> happened at secret-host.internal'); return send(res, 200, { url: back.toString() }); }
        const user = backend.addUser(next);
        const code = 'code-' + randomUUID();
        state.codes.set(code, { uid: user.id, challenge: body.code_challenge });
        back.searchParams.set('code', code);
        return send(res, 200, { url: back.toString() });
      }
      if (name === 'token') {
        const body = json();
        const c = state.codes.get(body.code);
        state.codes.delete(body.code);                                   // one use only
        if (!c || c.challenge !== 'c:' + body.code_verifier) return send(res, 400, { message: 'invalid flow state', code: 'flow_state_not_found' });
        return send(res, 200, backend.createSession(c.uid));
      }
      if (name === 'refresh') {
        const s = backend.refresh(json().refresh_token);
        return s ? send(res, 200, s) : send(res, 400, { message: 'Invalid Refresh Token: Refresh Token Not Found', code: 'refresh_token_not_found' });
      }
      if (name === 'logout') { backend.revoke(bearer(req)); return send(res, 200, {}); }

      // everything below needs a valid session; the user id comes from the token only
      const uid = backend.auth(bearer(req));
      if (name === 'rpc/ensure_profile') return send(res, 200, backend.ensureProfile(uid));
      if (name === 'db') {
        const q = json();
        const kind = { docs: 'doc', pages: 'page' }[q.table];
        if (!kind) return send(res, 404, { message: 'no such table' });
        if (q.op === 'upsert') return send(res, 200, backend.push(uid, kind, q.rows));
        if (q.filters && q.filters.in) return send(res, 200, backend.bodies(uid, kind, q.filters.in[1]));
        return send(res, 200, backend.heads(uid, kind, (q.filters && q.filters.gt && q.filters.gt[1]) || 0, q.limit || 1000));
      }
      if (name === 'storage/upload' || name === 'storage/download') {
        const p = url.searchParams.get('path') || '';
        const [folder, file] = p.split('/');
        if (folder !== uid || !file) return send(res, 403, { message: 'new row violates row-level security policy' });   // per-user folder policy
        if (name === 'storage/upload') { backend.upload(uid, file, raw); return send(res, 200, {}); }
        return send(res, 200, backend.download(uid, file), 'application/octet-stream');
      }
      if (name === 'functions/delete-account') {
        state.functionCalls++;
        if (json().confirm !== 'DELETE') return send(res, 400, { error: 'confirmation_required' });
        backend.deleteUser(uid);
        return send(res, 200, { deleted: true });
      }
      return send(res, 404, { message: 'not found' });
    } catch (err) {
      return send(res, err.status || 500, { message: err.message, code: err.code || '' });
    }
  }

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/__fake/')) { if (!accounts) return send(res, 404, {}); fake(req, res, url); return; }
    let u = decodeURIComponent(url.pathname);
    if (!u.startsWith(BASE + '/')) { res.writeHead(404); return res.end('nf'); }
    u = u.slice(BASE.length);
    if (u.endsWith('/')) u += 'index.html';
    if (accounts && u === '/js/config.js') return send(res, 200, config, 'text/javascript');
    if (accounts && u === '/vendor/supabase-js.js') u = '/tests/harness/fake-supabase.js';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(resolve => srv.listen(port, () => resolve({ ...state, state, url: `${origin}${BASE}/`, origin, close: () => new Promise(r => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) })));
}

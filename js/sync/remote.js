// The account side of sync: a thin adapter over supabase-js. Every request carries the user's bearer token
// (added by supabase-js); no request ever contains a user id that the server trusts: rows get their
// owner from the token (`owner_id default auth.uid()` + row level security).
import { BUCKET } from './images.js';

const TABLE = { doc: 'docs', page: 'pages' };
const COLS = { doc: 'id,kind,title,data,updated_at,deleted,rev', page: 'id,doc_id,data,updated_at,deleted,rev' };

async function unwrap(request) {
  const { data, error, status } = await request;
  if (error) {
    const e = new Error(error.message || 'request failed');
    e.status = error.status || status || 0;
    e.code = error.code || '';
    e.name = error.name || 'RemoteError';
    throw e;
  }
  return data;
}

/** getClient() → supabase client; userId = the signed-in user's id (only used to build the storage folder). */
export function createRemote({ getClient, userId, local }) {
  return {
    async ensureProfile() {
      const client = await getClient();
      return (await unwrap(client.rpc('ensure_profile'))) || {};
    },
    async heads(kind, since, limit) {
      const client = await getClient();
      return (await unwrap(client.from(TABLE[kind]).select('id,updated_at,deleted,rev').gt('rev', since).order('rev', { ascending: true }).limit(limit))) || [];
    },
    async bodies(kind, ids) {
      if (!ids.length) return [];
      const client = await getClient();
      return (await unwrap(client.from(TABLE[kind]).select(COLS[kind]).in('id', ids))) || [];
    },
    async push(kind, rows) {
      if (!rows.length) return [];
      const client = await getClient();
      // owner_id is not sent: the database fills it in from the token.
      return (await unwrap(client.from(TABLE[kind]).upsert(rows, { onConflict: 'owner_id,id' }).select('id,updated_at,rev'))) || [];
    },
    images: {
      hasUploaded: name => local.imageKnown(name),
      remember: name => local.rememberImage(name),
      async upload(name, bytes, type) {
        const client = await getClient();
        const { error } = await client.storage.from(BUCKET).upload(`${userId}/${name}`, new Blob([bytes], { type }), { contentType: type, upsert: false });
        if (error) {
          const status = Number(error.status || error.statusCode) || 0;
          if (status === 409 || /exist|duplicate/i.test(error.message || '')) return;   // already there: same bytes, same name
          const e = new Error(error.message || 'upload failed'); e.status = status; throw e;
        }
      },
      async download(name) {
        const client = await getClient();
        const { data, error } = await client.storage.from(BUCKET).download(`${userId}/${name}`);
        if (error || !data) { const e = new Error((error && error.message) || 'download failed'); e.status = Number(error && (error.status || error.statusCode)) || 0; throw e; }
        return new Uint8Array(await data.arrayBuffer());
      },
    },
    async deleteAccount() {
      const client = await getClient();
      const { data, error } = await client.functions.invoke('delete-account', { body: { confirm: 'DELETE' } });
      if (error) { const e = new Error('delete failed'); e.status = Number(error.status || (error.context && error.context.status)) || 0; throw e; }
      if (!data || data.deleted !== true) throw new Error('delete failed');
      return true;
    },
  };
}

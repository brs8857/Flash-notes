// Flash Notes — "Delete my account" (Supabase Edge Function, Deno).
//
// Why an Edge Function: deleting a user from Supabase Auth needs the service-role key, and that key must
// never be in the browser. Here it lives only in the function's environment (Supabase provides
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY to every function automatically).
//
// What it does, in order:
//   1. Reads the caller's bearer token and asks Supabase Auth who it belongs to. The user id comes ONLY
//      from that verified token; nothing in the request body can name another user.
//   2. Requires the body {"confirm":"DELETE"} (the app asks the user to type it).
//   3. Removes every file in the user's own folder of the private `note-images` bucket.
//   4. Deletes the auth user. Every table row (profiles, docs, pages, rate counters) references
//      auth.users ON DELETE CASCADE, so the database removes them in the same transaction.
// It never logs tokens, emails or note content.
//
// Deploy:  supabase functions deploy delete-account        (JWT verification stays ON, the default)
// Secret:  supabase secrets set ALLOWED_ORIGINS="https://brs8857.github.io"   (comma-separated list)
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const BUCKET = 'note-images';
const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-region',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // Only the app's own origin may call this from a browser. (Authentication is the bearer token, never a
  // cookie, so another site could not act for a user anyway; this is defence in depth.)
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'method_not_allowed' });
  const origin = req.headers.get('origin');
  if (origin && !allowed.includes(origin)) return json(req, 403, { error: 'origin_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json(req, 500, { error: 'not_configured' });

  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+$/i.test(auth)) return json(req, 401, { error: 'not_signed_in' });

  // 1. Who is calling? Verified by Supabase Auth from the token itself.
  const asUser = createClient(url, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: who, error: whoError } = await asUser.auth.getUser();
  const userId = who?.user?.id;
  if (whoError || !userId) return json(req, 401, { error: 'not_signed_in' });

  // 2. Explicit confirmation.
  let body: { confirm?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  if (body?.confirm !== 'DELETE') return json(req, 400, { error: 'confirmation_required' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // 3. The user's images (their own folder only: the path starts with the verified user id).
  try {
    for (let guard = 0; guard < 500; guard++) {
      const { data: files, error } = await admin.storage.from(BUCKET).list(userId, { limit: 100 });
      if (error) throw error;
      if (!files || files.length === 0) break;
      const { error: removeError } = await admin.storage.from(BUCKET).remove(files.map(f => `${userId}/${f.name}`));
      if (removeError) throw removeError;
    }
  } catch (_err) {
    console.error('delete-account: could not remove stored images');
    return json(req, 500, { error: 'delete_failed' });
  }

  // 4. The account. Table rows go with it (ON DELETE CASCADE).
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    console.error('delete-account: could not delete the user');
    return json(req, 500, { error: 'delete_failed' });
  }
  return json(req, 200, { deleted: true });
});

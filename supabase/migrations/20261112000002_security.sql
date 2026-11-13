-- Flash Notes v2.0 — row level security, grants, profile functions.
-- Rule: a signed-in user can reach only rows whose owner_id is their own auth.uid(). Signed-out (anon)
-- requests can reach nothing. The service-role key is never used by the app (only by the delete-account
-- Edge Function).

-- ------------------------------------------------------------------ RLS on, and forced, on every table
alter table public.profiles    enable row level security;
alter table public.profiles    force  row level security;
alter table public.docs        enable row level security;
alter table public.docs        force  row level security;
alter table public.pages       enable row level security;
alter table public.pages       force  row level security;
alter table private.write_rate enable row level security;
alter table private.write_rate force  row level security;

-- ------------------------------------------------------------------ grants (least privilege)
-- Supabase's default privileges hand new public tables to anon and authenticated; take that back first.
revoke all on table public.profiles, public.docs, public.pages from public, anon, authenticated;
revoke all on table private.write_rate from public, anon, authenticated;
revoke all on sequence private.sync_rev from public, anon, authenticated;

grant select, insert, update, delete on table public.docs, public.pages to authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;   -- nothing else is client-editable

-- ------------------------------------------------------------------ verified accounts only
-- True when the caller has a profile built from exactly one Google identity whose email Google has
-- verified (private.sync_profile below). Used as a RESTRICTIVE policy: it is ANDed with the ownership
-- policies, so an account that is unverified, or that ever gains a second linked identity, can reach no
-- notes at all until that is resolved. It runs once per statement (the `select` wrapper), not per row.
create or replace function private.account_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.email_verified)
$$;
grant usage on schema private to authenticated;      -- nothing in it is executable unless granted below

drop policy if exists docs_verified_only on public.docs;
create policy docs_verified_only on public.docs as restrictive for all to authenticated
  using ((select private.account_ok())) with check ((select private.account_ok()));
drop policy if exists pages_verified_only on public.pages;
create policy pages_verified_only on public.pages as restrictive for all to authenticated
  using ((select private.account_ok())) with check ((select private.account_ok()));

-- ------------------------------------------------------------------ policies: docs
drop policy if exists docs_select_own on public.docs;
create policy docs_select_own on public.docs for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists docs_insert_own on public.docs;
create policy docs_insert_own on public.docs for insert to authenticated
  with check ((select auth.uid()) = owner_id);
drop policy if exists docs_update_own on public.docs;
create policy docs_update_own on public.docs for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists docs_delete_own on public.docs;
create policy docs_delete_own on public.docs for delete to authenticated
  using ((select auth.uid()) = owner_id);

-- ------------------------------------------------------------------ policies: pages
drop policy if exists pages_select_own on public.pages;
create policy pages_select_own on public.pages for select to authenticated
  using ((select auth.uid()) = owner_id);
drop policy if exists pages_insert_own on public.pages;
create policy pages_insert_own on public.pages for insert to authenticated
  with check ((select auth.uid()) = owner_id);
drop policy if exists pages_update_own on public.pages;
create policy pages_update_own on public.pages for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists pages_delete_own on public.pages;
create policy pages_delete_own on public.pages for delete to authenticated
  using ((select auth.uid()) = owner_id);

-- ------------------------------------------------------------------ policies: profiles
-- Clients may read their own profile and change only display_name (column grant above). Rows are created
-- and kept up to date by the server-side functions below; they disappear when the account is deleted.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- ------------------------------------------------------------------ internal policies
-- FORCE ROW LEVEL SECURITY also binds the table owner. The SECURITY DEFINER functions in these migrations
-- run as that owner (the role running this migration: `postgres` on Supabase), so it gets an explicit
-- policy. This role cannot be reached through the API; anon and authenticated never match these policies.
drop policy if exists profiles_internal on public.profiles;
create policy profiles_internal on public.profiles for all to current_user using (true) with check (true);
drop policy if exists docs_internal on public.docs;
create policy docs_internal on public.docs for all to current_user using (true) with check (true);
drop policy if exists pages_internal on public.pages;
create policy pages_internal on public.pages for all to current_user using (true) with check (true);
drop policy if exists write_rate_internal on private.write_rate;
create policy write_rate_internal on private.write_rate for all to current_user using (true) with check (true);

-- ------------------------------------------------------------------ profile upkeep (server-derived only)
create or replace function private.clean_name(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', '', 'g')), 80), '')
$$;

-- Builds / refreshes the profile of one user from Supabase Auth's own tables. Nothing here comes from the
-- client: the provider, subject id, email and verified flag are read from auth.identities, which only
-- Supabase Auth writes after it has checked Google's ID token.
-- The account counts as verified only when it has EXACTLY ONE identity, that identity is Google, and
-- Google reports email_verified = true. Anything else (no identity, another provider, a second linked
-- identity, an unverified email) leaves email_verified = false, which locks the notes (account_ok above).
-- Returns true when the account is verified.
create or replace function private.sync_profile(p_uid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  u record;
  g record;
  n_ident integer;
  ok boolean;
begin
  select id, email, raw_user_meta_data into u from auth.users where id = p_uid;
  if not found then return false; end if;

  select count(*) into n_ident from auth.identities where user_id = p_uid;
  select provider_id, identity_data into g from auth.identities
    where user_id = p_uid and provider = 'google' order by provider_id limit 1;
  if not found then
    update public.profiles set email_verified = false where id = p_uid;
    return false;                        -- only Google accounts get a profile
  end if;

  ok := n_ident = 1
        and coalesce(g.identity_data ->> 'email_verified', 'false') = 'true'
        and coalesce(g.identity_data ->> 'email', '') <> '';

  insert into public.profiles as p (id, provider, provider_sub, email, email_verified, display_name)
  values (
    p_uid, 'google', left(g.provider_id, 255), left(coalesce(g.identity_data ->> 'email', u.email), 320), ok,
    coalesce(private.clean_name(g.identity_data ->> 'full_name'),
             private.clean_name(g.identity_data ->> 'name')))
  on conflict (id) do update set
    provider_sub   = excluded.provider_sub,
    email          = excluded.email,
    email_verified = excluded.email_verified,
    display_name   = coalesce(p.display_name, excluded.display_name);   -- a stored name is never overwritten

  -- Data minimisation: Supabase Auth copies the Google picture link into its own tables at each sign-in.
  -- The app never asks for, shows or uses it, so remove it again.
  begin
    update auth.users set raw_user_meta_data = raw_user_meta_data - 'avatar_url' - 'picture'
      where id = p_uid and raw_user_meta_data ?| array['avatar_url', 'picture'];
    update auth.identities set identity_data = identity_data - 'avatar_url' - 'picture'
      where user_id = p_uid and identity_data ?| array['avatar_url', 'picture'];
  exception when others then
    null;                                -- never block sign-in on housekeeping
  end;

  return ok;
end $$;

-- Called by the app after every sign-in. The caller is identified by the verified JWT only; there is no
-- user-id parameter to spoof.
create or replace function public.ensure_profile() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  ok boolean;
  out jsonb;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  ok := private.sync_profile(uid);
  -- housekeeping: forget tombstones after 90 days
  delete from public.pages where owner_id = uid and deleted and server_updated_at < now() - interval '90 days';
  delete from public.docs  where owner_id = uid and deleted and server_updated_at < now() - interval '90 days';
  select jsonb_build_object('id', p.id, 'provider', p.provider, 'email', p.email,
                            'display_name', p.display_name, 'created_at', p.created_at,
                            'verified', p.email_verified)
    into out from public.profiles p where p.id = uid;
  return coalesce(out, jsonb_build_object('id', uid, 'verified', false));
end $$;

-- Functions are not callable by anyone unless granted.
revoke all on function private.sync_guard(), private.quota_guard(), private.rate_guard(),
  private.touch_updated_at(), private.sync_profile(uuid), private.clean_name(text),
  private.account_ok() from public, anon, authenticated;
revoke all on function public.ensure_profile() from public, anon, authenticated;
grant execute on function private.account_ok() to authenticated;
grant execute on function public.ensure_profile() to authenticated;

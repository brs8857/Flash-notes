-- Flash Notes v2.0 — accounts + sync: tables, constraints, indexes, triggers.
-- Run in order (Supabase CLI: `supabase db push`, or paste each file into the SQL editor). Safe to re-run.
--
-- Model (mirrors the app's IndexedDB stores, SPEC "Auth & sync v2.0"):
--   profiles  one row per account (id = auth.uid())
--   docs      notebooks and whiteboards   (IndexedDB `docs`)
--   pages     pages with their strokes and text boxes as jsonb (IndexedDB `pages`)
--   images    photos placed on a page live in the private Storage bucket `note-images` (migration 3); the
--             page jsonb holds only a reference to them
-- Every row belongs to exactly one user: owner_id defaults to auth.uid(), can never change, and the primary
-- key is (owner_id, id), so two users can use the same item id without ever touching each other's rows.

create schema if not exists private;
revoke all on schema private from public;

-- ------------------------------------------------------------------ profiles
create table if not exists public.profiles (
  id             uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  provider       text not null check (provider in ('google')),                    -- sign-in provider (only Google is enabled)
  provider_sub   text not null check (char_length(provider_sub) between 1 and 255), -- the provider's stable subject id
  email          text check (email is null or char_length(email) <= 320),
  email_verified boolean not null default false,                                  -- true only when Google says so (see migration 2)
  display_name   text check (display_name is null or (char_length(display_name) between 1 and 80 and display_name !~ '[[:cntrl:]]')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Deliberately NOT stored: profile picture, locale, contacts, or anything else Google offers.

-- ------------------------------------------------------------------ docs (notebooks + whiteboards)
create table if not exists public.docs (
  owner_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id                text not null check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  kind              text not null check (kind in ('notebook', 'whiteboard')),
  title             text not null default '' check (char_length(title) <= 200 and title !~ '[[:cntrl:]]'),
  data              jsonb not null default '{}'::jsonb                            -- cover, paper, pageIds, background, createdAt
                    check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 1048576),
  updated_at        bigint not null check (updated_at >= 0),                      -- client clock, ms: last-write-wins key
  deleted           boolean not null default false,                               -- tombstone
  rev               bigint not null default 0,                                    -- server change counter (pull cursor)
  server_updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  check (not deleted or data = '{}'::jsonb)
);
create index if not exists docs_owner_rev_idx on public.docs (owner_id, rev);

-- ------------------------------------------------------------------ pages
create table if not exists public.pages (
  owner_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id                text not null check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  doc_id            text not null check (doc_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  data              jsonb not null default '{}'::jsonb                            -- paper, items (strokes, text, image refs), createdAt
                    check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 8388608),
  updated_at        bigint not null check (updated_at >= 0),
  deleted           boolean not null default false,
  rev               bigint not null default 0,
  server_updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  check (not deleted or data = '{}'::jsonb)
);
create index if not exists pages_owner_rev_idx on public.pages (owner_id, rev);
create index if not exists pages_owner_doc_idx on public.pages (owner_id, doc_id);
-- No foreign key pages → docs on purpose: items sync independently (last write wins per item, with
-- tombstones), so a page may arrive before its notebook. Orphans are harmless and are purged below.

-- ------------------------------------------------------------------ write-rate counters (internal)
create table if not exists private.write_rate (
  owner_id uuid not null references auth.users (id) on delete cascade,
  bucket   timestamptz not null,                                                  -- start of the minute
  n        integer not null default 0 check (n >= 0),
  primary key (owner_id, bucket)
);

create sequence if not exists private.sync_rev;

-- ------------------------------------------------------------------ triggers
-- One BEFORE ROW guard for docs and pages:
--   * owner_id and id are immutable
--   * last-write-wins: an UPDATE carrying an older updated_at than the stored row is skipped (not an error)
--   * a client clock more than 5 minutes ahead is clamped to the server clock
--   * tombstones drop their content; rev and server_updated_at are always set by the server
create or replace function private.sync_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if tg_op = 'UPDATE' then
    if new.owner_id is distinct from old.owner_id or new.id is distinct from old.id then
      raise exception 'owner_id and id cannot be changed' using errcode = '42501';
    end if;
    if new.updated_at < old.updated_at then
      return null;                       -- stale write: keep the newer stored row
    end if;
  end if;
  if new.updated_at > now_ms + 300000 then
    new.updated_at := now_ms;
  end if;
  if new.deleted then
    new.data := '{}'::jsonb;
    if tg_table_name = 'docs' then new.title := ''; end if;
  end if;
  new.rev := nextval('private.sync_rev');
  new.server_updated_at := now();
  return new;
end $$;

drop trigger if exists docs_sync_guard on public.docs;
create trigger docs_sync_guard before insert or update on public.docs
  for each row execute function private.sync_guard();
drop trigger if exists pages_sync_guard on public.pages;
create trigger pages_sync_guard before insert or update on public.pages
  for each row execute function private.sync_guard();

-- Per-user quotas (rows, including tombstones). Generous for a student, small enough to stop abuse.
create or replace function private.quota_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n bigint;
  lim bigint;
begin
  -- An upsert of a row that already exists fires this trigger too: it is an update, not a new row.
  if tg_table_name = 'docs' then
    if exists (select 1 from public.docs where owner_id = new.owner_id and id = new.id) then return new; end if;
    select count(*) into n from public.docs where owner_id = new.owner_id;
    lim := 2000;
  else
    if exists (select 1 from public.pages where owner_id = new.owner_id and id = new.id) then return new; end if;
    select count(*) into n from public.pages where owner_id = new.owner_id;
    lim := 20000;
  end if;
  if n >= lim then
    raise exception 'quota exceeded for %', tg_table_name using errcode = '53400';
  end if;
  return new;
end $$;

drop trigger if exists docs_quota_guard on public.docs;
create trigger docs_quota_guard before insert on public.docs
  for each row execute function private.quota_guard();
drop trigger if exists pages_quota_guard on public.pages;
create trigger pages_quota_guard before insert on public.pages
  for each row execute function private.quota_guard();

-- Write-rate guard: at most 1,200 row writes per user per minute (the app writes a handful).
create or replace function private.rate_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  rows_written integer;
  total integer;
begin
  if uid is null then return null; end if;          -- service role / SQL editor: not rate limited
  select count(*) into rows_written from changed;
  if rows_written = 0 then return null; end if;
  insert into private.write_rate as r (owner_id, bucket, n)
    values (uid, date_trunc('minute', now()), rows_written)
    on conflict (owner_id, bucket) do update set n = r.n + excluded.n
    returning n into total;
  if total > 1200 then
    raise exception 'too many writes, slow down' using errcode = '53400';
  end if;
  delete from private.write_rate where owner_id = uid and bucket < now() - interval '1 hour';
  return null;
end $$;

drop trigger if exists docs_rate_ins on public.docs;
create trigger docs_rate_ins after insert on public.docs
  referencing new table as changed for each statement execute function private.rate_guard();
drop trigger if exists docs_rate_upd on public.docs;
create trigger docs_rate_upd after update on public.docs
  referencing new table as changed for each statement execute function private.rate_guard();
drop trigger if exists pages_rate_ins on public.pages;
create trigger pages_rate_ins after insert on public.pages
  referencing new table as changed for each statement execute function private.rate_guard();
drop trigger if exists pages_rate_upd on public.pages;
create trigger pages_rate_upd after update on public.pages
  referencing new table as changed for each statement execute function private.rate_guard();

create or replace function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.id := old.id;                      -- a profile can never be moved to another user
  new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

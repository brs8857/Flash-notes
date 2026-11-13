-- TEST ONLY. A minimal stand-in for the parts of a Supabase project the migrations rely on, so the real
-- migrations and RLS policies can run on a plain Postgres (or PGlite). Never run this on Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role fln_owner nologin;                    -- plays `postgres`: owns everything, NOT superuser, NO bypassrls
grant anon, authenticated, service_role to fln_owner;
do $$ begin execute format('grant create on database %I to fln_owner', current_database()); end $$;

create schema auth authorization fln_owner;
create schema storage authorization fln_owner;
alter schema public owner to fln_owner;
grant usage on schema public, auth, storage to anon, authenticated, service_role;

set role fln_owner;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb not null default '{}',
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  provider_id text not null,
  identity_data jsonb not null default '{}',
  unique (provider, provider_id)
);
-- Same definitions as Supabase: the API sets request.jwt.claims per request.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))
$$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner_id text default (auth.uid())::text,
  metadata jsonb,
  created_at timestamptz default now(),
  unique (bucket_id, name)
);
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;
alter table storage.objects enable row level security;
alter table storage.objects force row level security;
alter table storage.buckets enable row level security;
-- Supabase grants the API roles everything on storage tables and relies on RLS alone.
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
-- Supabase's default privileges: new public objects are handed to the API roles (the migrations must undo it).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
reset role;

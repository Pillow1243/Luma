-- ============================================================================
-- Luma — local test platform shim (NOT applied to Supabase)
-- ============================================================================
-- Supabase projects provide auth.users, storage.objects/buckets and the anon /
-- authenticated / service_role roles, plus the `auth.uid()` helper. A plain
-- PostgreSQL cluster does not. This file recreates the *minimum* of that
-- platform surface so `supabase/baseline/01_production_schema.sql` plus every
-- migration in supabase/migrations can be replayed and tested locally.
--
-- It models real Supabase semantics that matter for authorization:
--   * auth.uid() reads the JWT `sub` claim from the request GUCs, exactly like
--     Supabase's auth.uid() (current_setting('request.jwt.claims')::json->>'sub').
--   * anon/authenticated/service_role are NOLOGIN roles; only service_role has
--     BYPASSRLS.
--   * storage.objects is owned by a `storage_admin` role and RLS-protected, so
--     policies written against it behave like the hosted equivalent.
--
-- Tests switch identity with:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
-- ============================================================================

do $$
begin
  begin
    create extension if not exists pgcrypto;
  exception when others then
    raise notice 'pgcrypto unavailable; relying on core gen_random_uuid()';
  end;
end $$;

-- The hosted project has citext. Local clusters without contrib get a text
-- domain with the same name so that `public.citext` type references still
-- resolve; Luma always lowercases identifiers before writing them.
do $$
begin
  begin
    create extension if not exists citext;
  exception when others then null;
  end;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'citext') then
    execute 'create domain public.citext as text';
  end if;
end $$;

-- pg_cron exists on the hosted project. Locally we provide just enough of the
-- cron API that migrations referencing cron.schedule/cron.job still apply and
-- the scheduled statements can be asserted in tests.
create schema if not exists cron;
create table if not exists cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  nodename text default 'localhost',
  nodeport integer default 5432,
  database text default current_database(),
  username text default current_user,
  active boolean default true,
  jobname text unique
);
create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $$
declare jid bigint;
begin
  insert into cron.job (schedule, command, jobname)
  values (schedule, command, job_name)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into jid;
  return jid;
end
$$;
create or replace function cron.schedule(schedule text, command text)
returns bigint
language sql
as $$
  select cron.schedule('luma-job-' || md5(schedule || command), schedule, command)
$$;
create or replace function cron.unschedule(job_name text)
returns boolean
language sql
as $$
  delete from cron.job where jobname = job_name returning true
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'storage_admin') then
    create role storage_admin nologin noinherit;
  end if;
end $$;

-- ------------------------------------------------------------------ schemas --
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create schema if not exists realtime;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, anon, service_role;
grant usage on schema storage to authenticated, anon, service_role;

-- -------------------------------------------------------------------- auth ---
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    current_user
  )
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

-- ----------------------------------------------------------------- storage ---
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean not null default false,
  avif_autodetection boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  metadata jsonb,
  user_metadata jsonb default '{}'::jsonb
);

alter table storage.objects enable row level security;

-- storage.foldername('a/b/c') -> {a,b} (Supabase semantics: all but the last)
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end
$$;

-- storage.filename restriction isn't needed by Luma; keep minimal.
-- Ownership mirrors hosted Supabase: objects/buckets are managed by a
-- privileged storage role, application roles never own them.
do $$
begin
  execute 'alter table storage.objects owner to storage_admin';
  execute 'alter table storage.buckets owner to storage_admin';
  execute 'alter function storage.foldername(text) owner to storage_admin';
end $$;

-- The storage owner role must be able to see the schema it owns tables in:
-- foreign-key checks on storage.objects.bucket_id run as the referencing
-- table's owner on hosted Supabase, where that role is a superuser-ish
-- internal role (supabase_storage_admin).
grant usage on schema storage to storage_admin;
grant select on storage.buckets to storage_admin;

grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;
grant select, insert, update, delete on storage.buckets to service_role;

-- ---------------------------------------------------------------- realtime ---
-- The hosted project publishes a subset of tables on this publication.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

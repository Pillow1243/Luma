-- ============================================================================
-- Luma — production baseline schema (structure, functions, policies, triggers)
-- ============================================================================
-- Snapshot of the *deployed* Supabase project `lnhmbjqjfrnqkpsjpszb` taken on
-- 2026-11-10 by introspecting pg_catalog (columns, constraints, indexes,
-- pg_get_functiondef, pg_policies, triggers, grants) — not by replaying the
-- historical migration files, which drifted from production.
--
-- WHY THIS FILE EXISTS
--   The hosted project's migration history starts with `luma_initial` and
--   `v2_features` migrations that were never committed to this repository, and
--   three early repo migrations all carry the timestamp 20261109000000. A fresh
--   database therefore could not be rebuilt from supabase/migrations alone, so
--   "fresh install" could never be tested. This baseline closes that gap:
--
--     empty database          -> 00_platform_shim -> 01_baseline -> 02_grants
--                                 -> every file in supabase/migrations (in order)
--     existing production     ->  only new supabase/migrations files
--
--   Both paths are replayed by `npm run test:db` (tests/db/migrate.mjs), which
--   asserts the two schemas are equivalent. Keep this file in sync whenever a
--   migration changes something it already defines (the migrations remain
--   forward-only and idempotent, so re-running them on the baseline is safe).
--
-- Do NOT apply this file to the hosted project: it is already there.
-- ============================================================================

-- ------------------------------------------------------------- extensions --
do $$
begin
  begin
    create extension if not exists citext;
  exception when others then
    -- Local PostgreSQL builds without contrib: a domain is close enough for
    -- tests because Luma always lowercases identifiers before comparison.
    if not exists (select 1 from pg_type where typname = 'citext') then
      execute 'create domain citext as text';
    end if;
  end;
  begin
    create extension if not exists pgcrypto;
  exception when others then null;
  end;
end $$;

-- ------------------------------------------------------------------ tables --

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_path text,
  created_at timestamptz not null default now(),
  public_key text,
  last_seen_at timestamptz,
  username citext,
  bio text not null default '',
  show_last_seen boolean not null default true,
  constraint profiles_display_name_check check (length(display_name) >= 1 and length(display_name) <= 60),
  constraint profiles_username_format check (
    username is null
    or (username::text ~ '^[a-z0-9_]{3,32}$' and username::text = lower(username::text))
  )
);
create unique index if not exists profiles_username_key on public.profiles (username) where username is not null;
create index if not exists profiles_name_trgm_idx
  on public.profiles using gin (display_name extensions.gin_trgm_ops);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  name text,
  is_group boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  avatar_path text,
  is_secret boolean not null default false,
  ttl_seconds integer,
  kind text not null default 'direct',
  description text not null default '',
  username citext,
  is_public boolean not null default false,
  constraint chats_kind_check check (kind in ('direct', 'group', 'saved', 'channel')),
  constraint chats_name_check check (length(name) <= 80),
  constraint chats_username_format check (
    username is null
    or (username::text ~ '^[a-z0-9_]{3,32}$' and username::text = lower(username::text))
  )
);
create unique index if not exists chats_username_key on public.chats (username) where username is not null;
create index if not exists chats_name_trgm_idx
  on public.chats using gin (name extensions.gin_trgm_ops)
  where name is not null;

create table if not exists public.chat_participants (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  last_seen_at timestamptz,
  typing_until timestamptz,
  is_admin boolean not null default false,
  muted_until timestamptz,
  archived_at timestamptz,
  primary key (chat_id, user_id)
);
create index if not exists chat_participants_user_idx on public.chat_participants (user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text,
  reply_to uuid references public.messages (id) on delete set null,
  media_path text,
  media_name text,
  media_type text,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_for uuid[] not null default '{}',
  forwarded_from uuid,
  pinned_at timestamptz,
  expires_at timestamptz,
  e2ee boolean not null default false,
  media_waveform jsonb,
  media_duration real,
  mentions uuid[] not null default '{}',
  constraint messages_check check (
    deleted_at is not null
    or coalesce(length(btrim(body)), 0) > 0
    or media_path is not null
  ),
  constraint messages_body_check check (body is null or length(body) <= 16000)
);
create index if not exists messages_chat_created_v2_idx on public.messages (chat_id, created_at desc);
create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists messages_expires_idx on public.messages (expires_at) where expires_at is not null;
create index if not exists messages_pinned_idx on public.messages (chat_id, pinned_at) where pinned_at is not null;
-- Trigram indexes for search. Captured from production, so the FRESH path
-- creates them here; the UPGRADE path gets them from
-- 20261110120000_luma_security_and_ratchet.sql.
create index if not exists messages_body_trgm_idx
  on public.messages using gin (body extensions.gin_trgm_ops)
  where body is not null and body not like 'luma:e2ee:%' and deleted_at is null;

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji),
  constraint message_reactions_emoji_check check (char_length(emoji) >= 1 and char_length(emoji) <= 8)
);

create table if not exists public.starred_messages (
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create table if not exists public.chat_invites (
  token uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses integer not null default 50,
  uses integer not null default 0,
  revoked_at timestamptz,
  constraint chat_invites_max_uses check (max_uses >= 1 and max_uses <= 10000),
  constraint chat_invites_uses check (uses >= 0)
);
create index if not exists chat_invites_chat_idx on public.chat_invites (chat_id);

create table if not exists public.join_requests (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists public.blocks (
  blocker uuid not null references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  constraint blocks_not_self check (blocker <> blocked)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked);

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,
  reporter uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  details text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists message_reports_chat_idx on public.message_reports (chat_id);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_id uuid references public.chats (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null,
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_kind_check check (kind in ('mention', 'join_approved', 'join_rejected', 'system'))
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.rate_limits (
  user_id uuid not null references public.profiles (id) on delete cascade,
  action text not null,
  window_start timestamptz not null default now(),
  hits integer not null default 1,
  primary key (user_id, action)
);

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  started_by uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'active', 'ended')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index if not exists calls_chat_created_idx on public.calls (chat_id, created_at desc);

create table if not exists public.call_participants (
  call_id uuid not null references public.calls (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null check (status in ('ringing', 'joined', 'declined', 'left', 'missed')),
  joined_at timestamptz,
  left_at timestamptz,
  primary key (call_id, user_id)
);
create index if not exists call_participants_user_status_idx on public.call_participants (user_id, status);

create table if not exists public.call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls (id) on delete cascade,
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('offer', 'answer', 'ice')),
  payload jsonb not null check (pg_column_size(payload) < 65536),
  created_at timestamptz not null default now(),
  constraint call_signals_check check (from_user <> to_user)
);
create index if not exists call_signals_recipient_idx on public.call_signals (to_user, call_id, created_at);

create table if not exists public.user_public_keys (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  public_key jsonb not null,
  created_at timestamptz not null default now(),
  constraint user_public_keys_public_key_check check (
    public_key ->> 'kty' = 'EC'
    and public_key ->> 'crv' = 'P-256'
    and pg_column_size(public_key) < 2048
  )
);

create table if not exists public.user_prekey_bundles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  identity_key text not null,
  signing_key text not null,
  signed_prekey_id integer not null,
  signed_prekey text not null,
  signed_prekey_sig text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_one_time_prekeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  key_id integer not null,
  public_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, key_id)
);
create index if not exists user_one_time_prekeys_user_idx on public.user_one_time_prekeys (user_id, created_at);

create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.messages (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 240),
  created_at timestamptz not null default now(),
  closes_at timestamptz,
  allow_multiple boolean not null default false,
  anonymous boolean not null default false
);

create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 100),
  "position" integer not null check ("position" >= 0 and "position" <= 9),
  unique (poll_id, "position"),
  unique (poll_id, id)
);

create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls (id) on delete cascade,
  option_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id, option_id),
  foreign key (poll_id, option_id) references public.poll_options (poll_id, id) on delete cascade
);

-- Identity-free aggregate table: lets anonymous polls update in realtime
-- without exposing voter identity.
create table if not exists public.poll_vote_counts (
  poll_id uuid not null references public.polls (id) on delete cascade,
  option_id uuid not null references public.poll_options (id) on delete cascade,
  votes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (poll_id, option_id)
);

-- --------------------------------------------------------------- functions --

create or replace function public.is_chat_member(cid uuid)
returns boolean language sql stable security definer set search_path to '' as $function$
  select exists(select 1 from public.chat_participants where chat_id=cid and user_id=auth.uid())
$function$;

create or replace function public.is_chat_admin(cid uuid)
returns boolean language sql stable security definer set search_path to '' as $function$
  select exists (
    select 1 from public.chats c
    where c.id = cid and c.created_by = auth.uid()
  ) or exists (
    select 1 from public.chat_participants p
    where p.chat_id = cid and p.user_id = auth.uid() and p.is_admin
  )
$function$;

create or replace function public.is_channel(cid uuid)
returns boolean language sql stable security definer set search_path to '' as $function$
  select exists (select 1 from public.chats where id = cid and kind = 'channel')
$function$;

create or replace function public.shares_chat_with(other uuid)
returns boolean language sql stable security definer set search_path to '' as $function$
  select exists (
    select 1 from public.chat_participants a
    join public.chat_participants b on b.chat_id = a.chat_id
    where a.user_id = auth.uid() and b.user_id = other
  )
$function$;

create or replace function public.channel_subscriber_count(cid uuid)
returns integer language sql stable security definer set search_path to '' as $function$
  select count(*)::integer from public.chat_participants where chat_id = cid
$function$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to '' as $function$ begin insert into public.profiles(id,display_name) values(new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),split_part(new.email,'@',1)),60)); return new; end $function$;

create or replace function public.handle_profile_delete()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  c record;
  successor uuid;
begin
  for c in select id from public.chats where created_by = old.id loop
    select cp.user_id into successor
    from public.chat_participants cp
    join public.profiles p on p.id = cp.user_id
    where cp.chat_id = c.id and cp.user_id <> old.id
    order by cp.is_admin desc, cp.last_read_at desc
    limit 1;

    if successor is not null then
      update public.chats set created_by = successor where id = c.id;
      update public.chat_participants set is_admin = true
      where chat_id = c.id and user_id = successor;
    else
      delete from public.chats where id = c.id;
    end if;
  end loop;
  return old;
end
$function$;

create or replace function public.profiles_privacy_guard()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if new.display_name is null or length(btrim(new.display_name)) = 0 then
    raise exception 'Display name cannot be empty';
  end if;
  new.display_name := left(btrim(new.display_name), 60);
  new.bio := left(coalesce(new.bio, ''), 280);
  if not coalesce(new.show_last_seen, true) then
    new.last_seen_at := null;
  end if;
  return new;
end
$function$;

create or replace function public.protect_participant_role()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if current_user = 'authenticated' and new.is_admin is distinct from old.is_admin then
    raise exception 'Group roles can only be changed by group admins';
  end if;
  return new;
end $function$;

create or replace function public.check_rate_limit(
  p_action text,
  p_window_seconds integer,
  p_max_hits integer
)
returns void language plpgsql security definer set search_path to '' as $function$
declare
  uid uuid := auth.uid();
  current_hits integer;
begin
  if uid is null then
    raise exception 'Authentication required';
  end if;

  insert into public.rate_limits (user_id, action, window_start, hits)
  values (uid, p_action, now(), 1)
  on conflict (user_id, action) do update
    set hits = case
          when public.rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
            then 1
          else public.rate_limits.hits + 1
        end,
        window_start = case
          when public.rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
            then now()
          else public.rate_limits.window_start
        end
  returning hits into current_hits;

  if current_hits > p_max_hits then
    raise exception 'Rate limit exceeded for %. Please wait a moment.', p_action;
  end if;
end
$function$;

create or replace function public.cleanup_expired_messages()
returns integer language plpgsql security definer set search_path to '' as $function$
declare n integer;
begin
  delete from public.messages
  where expires_at is not null and expires_at <= now();
  get diagnostics n = row_count;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return n;
end $function$;

create or replace function public.messages_guardian()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if new.sender_id <> auth.uid() then raise exception 'Cannot send as another user'; end if;

  perform public.check_rate_limit('send_message', 60, 60);

  if new.body is not null and length(new.body) > 16000 then
    raise exception 'Message exceeds 16000 characters';
  end if;

  if new.media_type is not null and lower(new.media_type) in (
    'image/svg+xml', 'text/html', 'application/xhtml+xml',
    'application/javascript', 'text/javascript'
  ) then
    raise exception 'Unsupported media type';
  end if;

  if new.media_path is not null and lower(new.media_path) ~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh)$' then
    raise exception 'Unsupported media file extension';
  end if;

  select * into c from public.chats where id = new.chat_id;
  if not found then raise exception 'Chat not found'; end if;

  if new.expires_at is null and c.ttl_seconds is not null then
    new.expires_at := now() + make_interval(secs => c.ttl_seconds);
  end if;

  new.pinned_at := null;
  new.deleted_at := null;
  new.edited_at := null;
  new.deleted_for := '{}';

  if c.kind = 'channel' and not public.is_chat_admin(new.chat_id) then
    raise exception 'Only channel admins can post';
  end if;

  if c.kind = 'direct' and exists (
    select 1 from public.blocks b
    join public.chat_participants p
      on p.chat_id = c.id and p.user_id = b.blocker and p.user_id <> new.sender_id
    where b.blocked = new.sender_id
  ) then
    raise exception 'Message cannot be delivered to this user';
  end if;

  if coalesce(array_length(new.mentions, 1), 0) > 10 then
    raise exception 'Too many mentions in one message';
  end if;

  return new;
end
$function$;

create or replace function public.message_reports_guardian()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if auth.uid() is null or new.reporter <> auth.uid() then
    raise exception 'Authentication required';
  end if;
  perform public.check_rate_limit('report_message', 3600, 15);
  new.reason := left(coalesce(nullif(btrim(new.reason), ''), 'abuse'), 80);
  new.details := left(coalesce(new.details, ''), 500);
  return new;
end
$function$;

create or replace function public.notify_mentions()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare uid uuid;
begin
  if new.mentions is null or array_length(new.mentions, 1) is null then return new; end if;
  foreach uid in array new.mentions loop
    if uid = new.sender_id then continue; end if;
    if not exists (select 1 from public.chat_participants p where p.chat_id = new.chat_id and p.user_id = uid) then
      continue;
    end if;
    insert into public.notifications (user_id, chat_id, message_id, actor_id, kind, body)
    values (uid, new.chat_id, new.id, new.sender_id, 'mention',
            coalesce(left(new.body, 140), 'mentioned you'));
  end loop;
  return new;
end $function$;

create or replace function public.create_chat(
  member_ids uuid[],
  chat_name text default null
)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare
  cid uuid;
  n integer;
  other_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select count(distinct x) into n
  from unnest(member_ids) x
  where x is not null and x <> auth.uid();

  if n < 1 or n > 30 then
    raise exception 'Choose between 1 and 30 other members';
  end if;

  if (
    select count(*) from public.profiles
    where id in (select unnest(member_ids)) and id <> auth.uid()
  ) <> n then
    raise exception 'Invalid participant';
  end if;

  if n > 1 and (chat_name is null or length(trim(chat_name)) = 0) then
    raise exception 'Group name required';
  end if;

  if n = 1 then
    select x into other_id from unnest(member_ids) x where x is not null and x <> auth.uid() limit 1;
    perform pg_advisory_xact_lock(
      hashtext(least(auth.uid()::text, other_id::text) || ':' || greatest(auth.uid()::text, other_id::text))
    );
    select c.id into cid
    from public.chats c
    where not c.is_group and c.kind = 'direct' and not c.is_secret
      and exists (select 1 from public.chat_participants p where p.chat_id = c.id and p.user_id = auth.uid())
      and exists (select 1 from public.chat_participants p where p.chat_id = c.id and p.user_id = other_id)
    limit 1;
    if cid is not null then
      return cid;
    end if;
  end if;

  insert into public.chats (name, is_group, kind, created_by)
  values (
    case when n > 1 then left(trim(chat_name), 80) else null end,
    n > 1,
    case when n > 1 then 'group' else 'direct' end,
    auth.uid()
  )
  returning id into cid;

  insert into public.chat_participants (chat_id, user_id, is_admin)
  select cid, id, (n > 1 and id = auth.uid())
  from public.profiles
  where id = auth.uid() or id = any(member_ids);

  return cid;
end
$function$;

create or replace function public.create_saved_chat()
returns uuid language plpgsql security definer set search_path to '' as $function$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select c.id into cid from public.chats c
    join public.chat_participants p on p.chat_id = c.id and p.user_id = auth.uid()
    where c.kind = 'saved'
    limit 1;
  if cid is not null then return cid; end if;
  insert into public.chats (name, is_group, kind, created_by)
    values ('Saved Messages', false, 'saved', auth.uid()) returning id into cid;
  insert into public.chat_participants (chat_id, user_id, is_admin) values (cid, auth.uid(), true);
  return cid;
end $function$;

create or replace function public.create_secret_chat(peer uuid, ttl_seconds integer)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare
  cid uuid;
  ttl integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if peer = auth.uid() then raise exception 'Cannot create a secret chat with yourself'; end if;
  if not exists (select 1 from public.profiles where id = peer) then
    raise exception 'User not found';
  end if;
  ttl := least(greatest(coalesce(ttl_seconds, 300), 5), 604800);

  select c.id into cid
  from public.chats c
  join public.chat_participants p1 on p1.chat_id = c.id and p1.user_id = auth.uid()
  join public.chat_participants p2 on p2.chat_id = c.id and p2.user_id = peer
  where c.is_secret and c.ttl_seconds = ttl
  limit 1;
  if cid is not null then return cid; end if;

  insert into public.chats (name, is_group, is_secret, ttl_seconds, created_by)
  values (null, false, true, ttl, auth.uid())
  returning id into cid;

  insert into public.chat_participants (chat_id, user_id, is_admin)
  values (cid, auth.uid(), true), (cid, peer, true);
  return cid;
end
$function$;

create or replace function public.create_channel(
  channel_name text,
  channel_username text,
  channel_description text default '',
  channel_public boolean default true,
  avatar_path text default null
)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare cid uuid; uname public.citext;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if channel_name is null or length(trim(channel_name)) = 0 then
    raise exception 'Channel name required';
  end if;
  uname := lower(trim(channel_username))::public.citext;
  if uname is null or uname::text !~ '^[a-z0-9_]{3,32}$' then
    raise exception 'Username must be 3-32 chars: lowercase letters, digits, underscores';
  end if;
  if exists (select 1 from public.chats where username = uname) then
    raise exception 'That channel username is taken';
  end if;
  insert into public.chats (name, description, username, is_public, is_group, kind, created_by, avatar_path)
    values (left(trim(channel_name), 80), left(coalesce(channel_description, ''), 280),
            uname, coalesce(channel_public, true), false, 'channel', auth.uid(), avatar_path)
    returning id into cid;
  insert into public.chat_participants (chat_id, user_id, is_admin) values (cid, auth.uid(), true);
  return cid;
end $function$;

create or replace function public.update_channel(
  cid uuid,
  new_name text default null,
  new_description text default null,
  new_username text default null,
  new_public boolean default null,
  new_avatar_path text default null
)
returns public.chats language plpgsql security definer set search_path to '' as $function$
declare
  c public.chats;
  uname public.citext := null;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid and kind = 'channel';
  if not found then raise exception 'Channel not found'; end if;
  if not public.is_chat_admin(cid) then raise exception 'Only channel admins can update the channel'; end if;

  if new_username is not null then
    uname := lower(trim(new_username))::public.citext;
    if uname::text !~ '^[a-z0-9_]{3,32}$' then
      raise exception 'Username must be 3–32 chars: lowercase letters, digits, underscores';
    end if;
    if exists (select 1 from public.chats where username = uname and id <> cid) then
      raise exception 'That channel username is taken';
    end if;
  end if;

  if new_name is not null and length(trim(new_name)) = 0 then
    raise exception 'Channel name cannot be empty';
  end if;

  if new_avatar_path is not null and new_avatar_path <> '' and split_part(new_avatar_path, '/', 1) <> cid::text then
    raise exception 'Invalid channel avatar path';
  end if;

  update public.chats set
    name = case when new_name is null then c.name else left(trim(new_name), 80) end,
    description = case when new_description is null then c.description else left(new_description, 280) end,
    username = coalesce(uname, c.username),
    is_public = coalesce(new_public, c.is_public),
    avatar_path = case
      when new_avatar_path is null then c.avatar_path
      when new_avatar_path = '' then null
      else new_avatar_path
    end
  where id = cid
  returning * into c;
  return c;
end
$function$;

create or replace function public.update_group(
  cid uuid,
  new_name text,
  new_avatar_path text
)
returns public.chats language plpgsql security definer set search_path to '' as $function$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found or not c.is_group then raise exception 'Group not found'; end if;
  if not public.is_chat_admin(cid) then raise exception 'Only group admins can update the group'; end if;
  if new_name is not null and length(trim(new_name)) = 0 then
    raise exception 'Group name cannot be empty';
  end if;
  if new_avatar_path is not null and new_avatar_path <> '' and split_part(new_avatar_path, '/', 1) <> cid::text then
    raise exception 'Invalid group avatar path';
  end if;

  update public.chats
    set name = case when new_name is null then c.name else left(trim(new_name), 80) end,
        avatar_path = case
          when new_avatar_path is null then c.avatar_path
          when new_avatar_path = '' then null
          else new_avatar_path
        end
    where id = cid
    returning * into c;
  return c;
end
$function$;

create or replace function public.leave_chat(cid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats; successor uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found then return; end if;
  if c.kind = 'saved' then raise exception 'Saved Messages cannot be left'; end if;
  if not exists (select 1 from public.chat_participants where chat_id = cid and user_id = auth.uid()) then
    raise exception 'Not a member';
  end if;
  delete from public.chat_participants where chat_id = cid and user_id = auth.uid();
  if (select count(*) from public.chat_participants where chat_id = cid) = 0 then
    delete from public.chats where id = cid;
    return;
  end if;
  if c.created_by = auth.uid() then
    select user_id into successor from public.chat_participants
      where chat_id = cid order by is_admin desc, last_read_at desc limit 1;
    update public.chats set created_by = successor where id = cid;
  end if;
end $function$;

create or replace function public.add_chat_member(cid uuid, new_member uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats; n integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found or c.kind not in ('group', 'channel') then raise exception 'Group not found'; end if;
  if not public.is_chat_admin(cid) then raise exception 'Only admins can add members'; end if;
  select count(*) into n from public.chat_participants where chat_id = cid;
  if n >= 100 then raise exception 'Chat is full (100 members)'; end if;
  if not exists (select 1 from public.profiles where id = new_member) then
    raise exception 'User not found';
  end if;
  insert into public.chat_participants (chat_id, user_id, is_admin)
    values (cid, new_member, false) on conflict do nothing;
end $function$;

create or replace function public.remove_chat_member(cid uuid, target uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found or c.kind not in ('group', 'channel') then raise exception 'Chat not found'; end if;
  if target <> auth.uid() and not public.is_chat_admin(cid) then
    raise exception 'Only admins can remove members';
  end if;
  if target = c.created_by then raise exception 'The creator cannot be removed'; end if;
  delete from public.chat_participants where chat_id = cid and user_id = target;
end $function$;

create or replace function public.set_group_admin(cid uuid, target uuid, make_admin boolean)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found or c.kind not in ('group', 'channel') then raise exception 'Chat not found'; end if;
  if not public.is_chat_admin(cid) then raise exception 'Only admins can change roles'; end if;
  if not make_admin and target = c.created_by then raise exception 'The creator is always an admin'; end if;
  update public.chat_participants
    set is_admin = make_admin
    where chat_id = cid and user_id = target;
  if not found then raise exception 'User is not a member'; end if;
end $function$;

create or replace function public.create_invite(
  cid uuid,
  ttl_seconds integer default 86400,
  max_uses integer default 50
)
returns public.chat_invites language plpgsql security definer set search_path to '' as $function$
declare c public.chats; inv public.chat_invites;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.check_rate_limit('create_invite', 3600, 20);
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind = 'saved' then raise exception 'Saved Messages cannot have invite links'; end if;
  if not public.is_chat_admin(cid) and c.created_by <> auth.uid() then
    raise exception 'Only admins can create invite links';
  end if;
  insert into public.chat_invites (chat_id, created_by, expires_at, max_uses)
  values (
    cid,
    auth.uid(),
    case when ttl_seconds is null or ttl_seconds <= 0 then null
         else now() + make_interval(secs => least(ttl_seconds, 2592000)) end,
    greatest(1, least(coalesce(max_uses, 50), 10000))
  )
  returning * into inv;
  return inv;
end
$function$;

create or replace function public.revoke_invite(invite_token uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare inv public.chat_invites;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into inv from public.chat_invites where token = invite_token;
  if not found then raise exception 'Invite not found'; end if;
  if not public.is_chat_admin(inv.chat_id) then raise exception 'Only admins can revoke invites'; end if;
  update public.chat_invites set revoked_at = now() where token = invite_token;
end $function$;

create or replace function public.redeem_invite(invite_token uuid)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare inv public.chat_invites; c public.chats; n int;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.chat_invites
    set uses = uses + 1
    where token = invite_token
      and revoked_at is null
      and (expires_at is null or expires_at > now())
      and uses < max_uses
    returning * into inv;
  if not found then
    if exists (select 1 from public.chat_invites where token = invite_token) then
      raise exception 'This invite link has expired or reached its limit';
    end if;
    raise exception 'Invite link not found';
  end if;
  select * into c from public.chats where id = inv.chat_id;
  if not found then raise exception 'Chat no longer exists'; end if;
  if c.kind in ('group','channel') then
    select count(*) into n from public.chat_participants where chat_id = c.id;
    if n >= 100 then raise exception 'This chat is full (100 members)'; end if;
  end if;
  insert into public.chat_participants (chat_id, user_id, is_admin)
    values (c.id, auth.uid(), false) on conflict do nothing;
  return c.id;
end $function$;

create or replace function public.request_join(cid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform public.check_rate_limit('request_join', 3600, 20);
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind not in ('group', 'channel') then raise exception 'Join requests are only for groups and channels'; end if;
  if c.kind = 'channel' and c.is_public then
    insert into public.chat_participants (chat_id, user_id, is_admin) values (cid, auth.uid(), false) on conflict do nothing;
    return;
  end if;
  if exists (select 1 from public.chat_participants where chat_id = cid and user_id = auth.uid()) then
    return;
  end if;
  insert into public.join_requests (chat_id, user_id) values (cid, auth.uid()) on conflict do nothing;
end $function$;

create or replace function public.approve_join(request_chat uuid, request_user uuid)
returns void language plpgsql security definer set search_path to '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(request_chat) then raise exception 'Only admins can approve requests'; end if;
  delete from public.join_requests where chat_id = request_chat and user_id = request_user returning chat_id into request_chat;
  insert into public.chat_participants (chat_id, user_id, is_admin) values (request_chat, request_user, false) on conflict do nothing;
  insert into public.notifications (user_id, chat_id, actor_id, kind, body)
    values (request_user, request_chat, auth.uid(), 'join_approved', 'Your join request was approved');
end $function$;

create or replace function public.reject_join(request_chat uuid, request_user uuid)
returns void language plpgsql security definer set search_path to '' as $function$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(request_chat) then raise exception 'Only admins can reject requests'; end if;
  delete from public.join_requests where chat_id = request_chat and user_id = request_user;
  insert into public.notifications (user_id, chat_id, actor_id, kind, body)
    values (request_user, request_chat, auth.uid(), 'join_rejected', 'Your join request was declined');
end $function$;

create or replace function public.subscribe_channel(cid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid and kind = 'channel';
  if not found then raise exception 'Channel not found'; end if;
  if not c.is_public then raise exception 'This channel is private - ask an admin for an invite link'; end if;
  insert into public.chat_participants (chat_id, user_id, is_admin)
    values (cid, auth.uid(), false) on conflict do nothing;
end $function$;

create or replace function public.search_users(term text)
returns table (
  id uuid,
  display_name text,
  username public.citext,
  avatar_path text,
  bio text
)
language plpgsql stable security definer set search_path to '' as $function$
declare
  uid uuid := auth.uid();
  q text := btrim(coalesce(term, ''));
begin
  if uid is null then raise exception 'Authentication required'; end if;

  return query
  select p.id, p.display_name, p.username, p.avatar_path, p.bio
  from public.profiles p
  where p.id <> uid
    and (
      q = ''
      or p.display_name ilike '%' || q || '%'
      or p.username::text ilike '%' || lower(q) || '%'
    )
    and not exists (
      select 1 from public.blocks b where b.blocker = p.id and b.blocked = uid
    )
  order by
    case when q <> '' and p.username::text = lower(q) then 0
         when q <> '' and p.display_name ilike q || '%' then 1
         else 2 end,
    p.display_name asc
  limit 24;
end
$function$;

create or replace function public.search_channels(term text)
returns table(id uuid, name text, username citext, description text, is_public boolean, avatar_path text, subscribers integer, is_member boolean)
language sql stable security definer set search_path to '' as $function$
  select c.id, c.name, c.username, c.description, c.is_public, c.avatar_path,
         public.channel_subscriber_count(c.id) as subscribers,
         public.is_chat_member(c.id) as is_member
  from public.chats c
  where c.kind = 'channel' and c.is_public
    and (term is null or btrim(term) = ''
         or c.name ilike '%' || term || '%'
         or c.username::text ilike '%' || lower(term) || '%')
  order by subscribers desc
  limit 20
$function$;

create or replace function public.get_chat_sidebar_meta(cids uuid[])
returns table (
  chat_id uuid,
  last_message jsonb,
  unread_count integer
)
language sql stable security definer set search_path to '' as $function$
  with member_chats as (
    select cp.chat_id, cp.last_read_at
    from public.chat_participants cp
    where cp.user_id = auth.uid()
      and cp.chat_id = any(cids)
  ),
  latest as (
    select distinct on (m.chat_id)
      m.chat_id,
      to_jsonb(m) as msg_json
    from public.messages m
    join member_chats mc on mc.chat_id = m.chat_id
    where not (auth.uid() = any(m.deleted_for))
      and (m.expires_at is null or m.expires_at > now())
    order by m.chat_id, m.created_at desc, m.id desc
  ),
  unreads as (
    select m.chat_id, count(*)::integer as cnt
    from public.messages m
    join member_chats mc on mc.chat_id = m.chat_id
    where m.sender_id <> auth.uid()
      and m.created_at > mc.last_read_at
      and m.deleted_at is null
      and not (auth.uid() = any(m.deleted_for))
      and (m.expires_at is null or m.expires_at > now())
    group by m.chat_id
  )
  select
    mc.chat_id,
    l.msg_json as last_message,
    coalesce(u.cnt, 0) as unread_count
  from member_chats mc
  left join latest l on l.chat_id = mc.chat_id
  left join unreads u on u.chat_id = mc.chat_id
$function$;

create or replace function public.edit_message(msg_id uuid, new_body text)
returns public.messages language plpgsql security definer set search_path to '' as $function$
declare m public.messages;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into m from public.messages where id = msg_id;
  if not found then raise exception 'Message not found'; end if;
  if m.sender_id <> auth.uid() then raise exception 'Only the sender can edit'; end if;
  if m.deleted_at is not null then raise exception 'Message was deleted'; end if;
  if new_body is null or length(trim(new_body)) = 0 then raise exception 'Message cannot be empty'; end if;
  if length(new_body) > 16000 then raise exception 'Message too long'; end if;
  update public.messages
    set body = trim(new_body), edited_at = now()
    where id = msg_id
    returning * into m;
  return m;
end
$function$;

create or replace function public.delete_message_for_everyone(msg_id uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare m public.messages; c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into m from public.messages where id = msg_id;
  if not found then return; end if;
  if not public.is_chat_member(m.chat_id) then raise exception 'Not a member'; end if;
  select * into c from public.chats where id = m.chat_id;
  if m.sender_id <> auth.uid()
     and not ((c.is_group or c.kind = 'channel') and public.is_chat_admin(m.chat_id)) then
    raise exception 'Only the sender or an admin can delete this';
  end if;
  update public.messages
    set body = null, media_path = null, media_name = null, media_type = null,
        media_waveform = null, media_duration = null, reply_to = null,
        deleted_at = now(), pinned_at = null
    where id = msg_id;
end $function$;

create or replace function public.delete_message_for_me(msg_id uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare m public.messages;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into m from public.messages where id = msg_id;
  if not found then return; end if;
  if not public.is_chat_member(m.chat_id) then raise exception 'Not a member'; end if;
  if not (auth.uid() = any(m.deleted_for)) then
    update public.messages
      set deleted_for = array_append(m.deleted_for, auth.uid())
      where id = msg_id;
  end if;
end
$function$;

create or replace function public.set_message_pinned(msg_id uuid, pin boolean)
returns void language plpgsql security definer set search_path to '' as $function$
declare m public.messages; c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into m from public.messages where id = msg_id;
  if not found then raise exception 'Message not found'; end if;
  if not public.is_chat_member(m.chat_id) then raise exception 'Not a member'; end if;
  select * into c from public.chats where id = m.chat_id;
  if c.is_secret then raise exception 'Secret chats cannot pin messages'; end if;
  if (c.is_group or c.kind = 'channel') and not public.is_chat_admin(m.chat_id) then
    raise exception 'Only admins can pin messages';
  end if;
  update public.messages
    set pinned_at = case when pin then now() else null end
    where id = msg_id;
end $function$;

create or replace function public.set_chat_ttl(cid uuid, ttl_seconds integer)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind in ('group', 'channel') then
    if not public.is_chat_admin(cid) then raise exception 'Only admins can change disappearing messages'; end if;
  else
    if not public.is_chat_member(cid) then raise exception 'Not a member'; end if;
  end if;
  if set_chat_ttl.ttl_seconds is null or set_chat_ttl.ttl_seconds <= 0 then
    update public.chats set ttl_seconds = null where id = cid;
  else
    update public.chats set ttl_seconds = least(set_chat_ttl.ttl_seconds, 604800) where id = cid;
  end if;
end $function$;

create or replace function public.mark_notifications_read()
returns void language sql security definer set search_path to '' as $function$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null
$function$;

create or replace function public.start_luma_call(cid uuid, call_kind text)
returns public.calls language plpgsql security definer set search_path to '' as $function$
declare
  c public.chats;
  existing public.calls;
  new_call public.calls;
  n integer;
begin
  if auth.uid() is null or not public.is_chat_member(cid) then
    raise exception 'Not a chat member';
  end if;
  perform public.check_rate_limit('start_call', 300, 8);
  if call_kind not in ('audio', 'video') then
    raise exception 'Unsupported call kind';
  end if;
  select * into c from public.chats where id = cid;
  if not found or c.kind not in ('direct', 'group') then
    raise exception 'Calls are only supported in direct and group chats';
  end if;
  select count(*) into n from public.chat_participants where chat_id = cid;
  if n < 2 or n > 6 then
    raise exception 'Calls support 2 to 6 chat members';
  end if;

  select * into existing from public.calls
  where chat_id = cid and status in ('ringing', 'active')
  order by created_at desc
  limit 1;
  if found then
    insert into public.call_participants(call_id, user_id, status, joined_at)
    values (existing.id, auth.uid(), 'joined', now())
    on conflict (call_id, user_id) do update
      set status = 'joined', joined_at = coalesce(public.call_participants.joined_at, now()), left_at = null;
    update public.calls set status = 'active', answered_at = coalesce(answered_at, now())
    where id = existing.id returning * into existing;
    return existing;
  end if;

  insert into public.calls(chat_id, started_by, kind, status)
  values (cid, auth.uid(), call_kind, 'ringing')
  returning * into new_call;

  insert into public.call_participants(call_id, user_id, status, joined_at)
  select new_call.id, p.user_id,
         case when p.user_id = auth.uid() then 'joined' else 'ringing' end,
         case when p.user_id = auth.uid() then now() else null end
  from public.chat_participants p
  where p.chat_id = cid;

  return new_call;
end
$function$;

create or replace function public.respond_luma_call(call_uuid uuid, accept_call boolean)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.calls; joined_count integer; ringing_count integer;
begin
 select * into c from public.calls where id = call_uuid for update;
 if not found or not public.is_chat_member(c.chat_id) then raise exception 'Call unavailable'; end if;
 if c.status = 'ended' or c.created_at < now() - interval '2 minutes' and c.answered_at is null then raise exception 'Call has ended'; end if;
 update public.call_participants set status = case when accept_call then 'joined' else 'declined' end, joined_at = case when accept_call then now() else null end, left_at = case when accept_call then null else now() end where call_id = call_uuid and user_id = auth.uid() and status = 'ringing';
 if not found then raise exception 'Call invitation is no longer available'; end if;
 if accept_call then update public.calls set status = 'active', answered_at = coalesce(answered_at, now()) where id = call_uuid;
 else
  select count(*) filter(where status = 'joined'), count(*) filter(where status = 'ringing') into joined_count, ringing_count from public.call_participants where call_id = call_uuid;
  if joined_count <= 1 and ringing_count = 0 then update public.calls set status = 'ended', ended_at = now() where id = call_uuid; end if;
 end if;
end $function$;

create or replace function public.leave_luma_call(call_uuid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.calls; joined_count integer; ringing_count integer;
begin
 select * into c from public.calls where id = call_uuid for update;
 if not found or not public.is_chat_member(c.chat_id) then raise exception 'Call unavailable'; end if;
 update public.call_participants set status = case when status = 'ringing' then 'declined' else 'left' end, left_at = now() where call_id = call_uuid and user_id = auth.uid() and status in ('joined', 'ringing');
 select count(*) filter(where status = 'joined'), count(*) filter(where status = 'ringing') into joined_count, ringing_count from public.call_participants where call_id = call_uuid;
 if joined_count = 0 or (joined_count <= 1 and (ringing_count = 0 or c.answered_at is not null)) then
  update public.calls set status = 'ended', ended_at = coalesce(ended_at, now()) where id = call_uuid;
  update public.call_participants set status = 'missed', left_at = now() where call_id = call_uuid and status = 'ringing';
  delete from public.call_signals where call_id = call_uuid;
 end if;
end $function$;

create or replace function public.cleanup_luma_calls()
returns void language plpgsql security definer set search_path to '' as $function$ begin update public.calls set status = 'ended', ended_at = now() where status <> 'ended' and ((answered_at is null and created_at < now() - interval '2 minutes') or created_at < now() - interval '6 hours'); update public.call_participants p set status = 'missed', left_at = now() from public.calls c where p.call_id = c.id and c.status = 'ended' and p.status = 'ringing'; delete from public.call_signals where created_at < now() - interval '1 hour' or call_id in (select id from public.calls where status = 'ended'); end $function$;

create or replace function public.publish_prekey_bundle(
  p_identity_key text,
  p_signing_key text,
  p_signed_prekey_id integer,
  p_signed_prekey text,
  p_signed_prekey_sig text,
  p_one_time_keys jsonb default '[]'::jsonb
)
returns integer language plpgsql security definer set search_path to '' as $function$
declare
  uid uuid := auth.uid();
  item jsonb;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_identity_key, '')) < 20
     or length(coalesce(p_signing_key, '')) < 20
     or length(coalesce(p_signed_prekey, '')) < 20
     or length(coalesce(p_signed_prekey_sig, '')) < 20 then
    raise exception 'Invalid key bundle';
  end if;

  if exists (
    select 1 from public.user_prekey_bundles
    where user_id = uid and identity_key <> p_identity_key
  ) then
    delete from public.user_one_time_prekeys where user_id = uid;
  end if;

  insert into public.user_prekey_bundles (
    user_id, identity_key, signing_key, signed_prekey_id, signed_prekey, signed_prekey_sig, updated_at
  )
  values (
    uid, p_identity_key, p_signing_key, p_signed_prekey_id, p_signed_prekey, p_signed_prekey_sig, now()
  )
  on conflict (user_id) do update
    set identity_key = excluded.identity_key,
        signing_key = excluded.signing_key,
        signed_prekey_id = excluded.signed_prekey_id,
        signed_prekey = excluded.signed_prekey,
        signed_prekey_sig = excluded.signed_prekey_sig,
        updated_at = now();

  if jsonb_typeof(p_one_time_keys) = 'array' then
    for item in select value from jsonb_array_elements(p_one_time_keys) limit 50 loop
      insert into public.user_one_time_prekeys (user_id, key_id, public_key)
      values (
        uid,
        (item ->> 'key_id')::integer,
        item ->> 'public_key'
      )
      on conflict (user_id, key_id) do nothing;
    end loop;
  end if;

  return (select count(*)::integer from public.user_one_time_prekeys where user_id = uid);
end
$function$;

create or replace function public.claim_prekey_bundle(target_user uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  uid uuid := auth.uid();
  b public.user_prekey_bundles;
  opk public.user_one_time_prekeys;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if target_user <> uid and not public.shares_chat_with(target_user) then
    raise exception 'Not authorized to access this user bundle';
  end if;

  select * into b from public.user_prekey_bundles where user_id = target_user;
  if not found then return null; end if;

  delete from public.user_one_time_prekeys
  where id = (
    select id from public.user_one_time_prekeys
    where user_id = target_user
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning * into opk;

  return jsonb_build_object(
    'user_id', b.user_id,
    'identity_key', b.identity_key,
    'signing_key', b.signing_key,
    'signed_prekey_id', b.signed_prekey_id,
    'signed_prekey', b.signed_prekey,
    'signed_prekey_sig', b.signed_prekey_sig,
    'one_time_key_id', opk.key_id,
    'one_time_key', opk.public_key
  );
end
$function$;

create or replace function public.count_one_time_prekeys()
returns integer language sql stable security definer set search_path to '' as $function$
  select count(*)::integer from public.user_one_time_prekeys where user_id = auth.uid()
$function$;

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void language plpgsql security definer set search_path to '' as $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_endpoint, '')) < 16 or p_endpoint !~ '^https://' then
    raise exception 'Invalid push endpoint';
  end if;
  if length(coalesce(p_p256dh, '')) < 16 or length(coalesce(p_auth, '')) < 8 then
    raise exception 'Invalid push keys';
  end if;

  -- SECURITY: never move an existing endpoint to a different account.
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh,
        auth = excluded.auth
    where public.push_subscriptions.user_id = excluded.user_id;

  if (select user_id from public.push_subscriptions where endpoint = p_endpoint)
     is distinct from uid then
    raise exception 'This push endpoint belongs to another account' using errcode = '42501';
  end if;
end
$function$;

create or replace function public.sync_poll_vote_counts()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  affected_poll_id uuid;
begin
  affected_poll_id := coalesce(new.poll_id, old.poll_id);

  insert into public.poll_vote_counts (poll_id, option_id, votes, updated_at)
  select
    po.poll_id,
    po.id,
    (select count(*) from public.poll_votes pv where pv.option_id = po.id),
    now()
  from public.poll_options po
  where po.poll_id = affected_poll_id
  on conflict (poll_id, option_id)
  do update set votes = excluded.votes, updated_at = excluded.updated_at;

  return coalesce(new, old);
end;
$function$;

-- Production keeps BOTH arities: the 6-argument version added in
-- 20261110121234 is a new overload, so the original 3-argument signature still
-- exists and is still the one granted in 20261110120000. Reproduce both.
create or replace function public.create_luma_poll(
  cid uuid,
  poll_question text,
  poll_options text[]
)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare
  c public.chats;
  mid uuid;
  pid uuid;
  opt text;
  i integer := 0;
begin
  if auth.uid() is null or not public.is_chat_member(cid) then
    raise exception 'Not a chat member';
  end if;
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind = 'channel' and not public.is_chat_admin(cid) then
    raise exception 'Only channel admins can create polls';
  end if;
  if length(trim(poll_question)) not between 1 and 240
     or coalesce(array_length(poll_options, 1), 0) not between 2 and 10 then
    raise exception 'A poll needs a question and 2–10 options';
  end if;
  foreach opt in array poll_options loop
    if length(trim(opt)) not between 1 and 100 then
      raise exception 'Poll options must be 1–100 characters';
    end if;
  end loop;
  insert into public.messages(chat_id, sender_id, body)
  values (cid, auth.uid(), '📊 Poll: ' || trim(poll_question))
  returning id into mid;
  insert into public.polls(message_id, chat_id, created_by, question)
  values (mid, cid, auth.uid(), trim(poll_question))
  returning id into pid;
  foreach opt in array poll_options loop
    insert into public.poll_options(poll_id, label, position)
    values (pid, trim(opt), i);
    i := i + 1;
  end loop;
  return mid;
end
$function$;

create or replace function public.get_poll_results(poll_uuid uuid)
returns table(option_id uuid, votes integer)
language sql stable security definer set search_path to '' as $function$
  select o.id as option_id, count(v.user_id)::integer as votes
  from public.poll_options o
  join public.polls p on p.id = o.poll_id
  left join public.poll_votes v on v.option_id = o.id
  where o.poll_id = poll_uuid
    and public.is_chat_member(p.chat_id)
  group by o.id
  order by o.position
$function$;

create or replace function public.vote_luma_poll(poll_uuid uuid, option_uuid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare
  p public.polls;
  already boolean;
begin
  select * into p from public.polls where id = poll_uuid;
  if p.id is null or auth.uid() is null or not public.is_chat_member(p.chat_id) then
    raise exception 'Poll unavailable';
  end if;
  if p.closes_at is not null and p.closes_at <= now() then
    raise exception 'This poll is closed';
  end if;
  if not exists (select 1 from public.poll_options where poll_id = poll_uuid and id = option_uuid) then
    raise exception 'Invalid option';
  end if;

  if p.allow_multiple then
    select exists (
      select 1 from public.poll_votes
      where poll_id = poll_uuid and user_id = auth.uid() and option_id = option_uuid
    ) into already;
    if already then
      delete from public.poll_votes
        where poll_id = poll_uuid and user_id = auth.uid() and option_id = option_uuid;
    else
      insert into public.poll_votes(poll_id, option_id, user_id) values (poll_uuid, option_uuid, auth.uid());
    end if;
  else
    delete from public.poll_votes
      where poll_id = poll_uuid and user_id = auth.uid() and option_id <> option_uuid;
    insert into public.poll_votes(poll_id, option_id, user_id)
    values (poll_uuid, option_uuid, auth.uid())
    on conflict (poll_id, user_id, option_id) do nothing;
  end if;
end
$function$;

-- ---------------------------------------------------------------- triggers --

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists on_profile_delete on public.profiles;
create trigger on_profile_delete
  before delete on public.profiles
  for each row execute function public.handle_profile_delete();

drop trigger if exists profiles_privacy_guard on public.profiles;
create trigger profiles_privacy_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_privacy_guard();

drop trigger if exists messages_guardian on public.messages;
create trigger messages_guardian before insert on public.messages
  for each row execute function public.messages_guardian();

drop trigger if exists notify_mentions on public.messages;
create trigger notify_mentions after insert on public.messages
  for each row execute function public.notify_mentions();

drop trigger if exists protect_participant_role on public.chat_participants;
create trigger protect_participant_role before update on public.chat_participants
  for each row execute function public.protect_participant_role();

drop trigger if exists message_reports_guardian on public.message_reports;
create trigger message_reports_guardian
  before insert on public.message_reports
  for each row execute function public.message_reports_guardian();

drop trigger if exists trg_sync_poll_vote_counts on public.poll_votes;
create trigger trg_sync_poll_vote_counts
  after insert or delete or update on public.poll_votes
  for each row execute function public.sync_poll_vote_counts();

-- --------------------------------------------------------------- row level --

alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.chat_participants enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.starred_messages enable row level security;
alter table public.chat_invites enable row level security;
alter table public.join_requests enable row level security;
alter table public.blocks enable row level security;
alter table public.message_reports enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.rate_limits enable row level security;
alter table public.calls enable row level security;
alter table public.call_participants enable row level security;
alter table public.call_signals enable row level security;
alter table public.user_public_keys enable row level security;
alter table public.user_prekey_bundles enable row level security;
alter table public.user_one_time_prekeys enable row level security;
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
alter table public.poll_vote_counts enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or public.shares_chat_with(id)
    or exists (
      select 1 from public.join_requests jr
      where jr.user_id = profiles.id and public.is_chat_admin(jr.chat_id)
    )
    or exists (
      select 1 from public.notifications n
      where n.user_id = auth.uid() and n.actor_id = profiles.id
    )
  );
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check (id = auth.uid());
-- Production has this policy; a fresh database without it silently made
-- "edit my profile" a no-op (the UPDATE grant exists but no policy allowed the
-- row through). Captured by tests/db/parity.mjs.
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists chats_read on public.chats;
create policy chats_read on public.chats for select to authenticated
  using (public.is_chat_member(id) or (kind = 'channel' and is_public));

drop policy if exists participants_read on public.chat_participants;
create policy participants_read on public.chat_participants for select to authenticated
  using (public.is_chat_member(chat_id));
drop policy if exists participants_update on public.chat_participants;
create policy participants_update on public.chat_participants for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_chat_member(chat_id));

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (public.is_chat_member(chat_id)
         and not (auth.uid() = any (deleted_for))
         and (expires_at is null or expires_at > now()));
drop policy if exists messages_send on public.messages;
create policy messages_send on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_chat_member(chat_id)
    and (not public.is_channel(chat_id) or public.is_chat_admin(chat_id))
    and (reply_to is null or exists (
      select 1 from public.messages m
      where m.id = messages.reply_to and m.chat_id = messages.chat_id))
    and (media_path is null or (
      split_part(media_path, '/', 1) = chat_id::text
      and split_part(media_path, '/', 2) = auth.uid()::text))
  );

drop policy if exists reactions_read on public.message_reactions;
create policy reactions_read on public.message_reactions for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_reactions.message_id and public.is_chat_member(m.chat_id)));
drop policy if exists reactions_add on public.message_reactions;
create policy reactions_add on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (
    select 1 from public.messages m where m.id = message_reactions.message_id and public.is_chat_member(m.chat_id)));
drop policy if exists reactions_remove on public.message_reactions;
create policy reactions_remove on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists starred_own on public.starred_messages;
create policy starred_own on public.starred_messages for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_chat_member(m.chat_id)));

drop policy if exists invites_admin_read on public.chat_invites;
create policy invites_admin_read on public.chat_invites for select to authenticated
  using (public.is_chat_admin(chat_id));
drop policy if exists invites_admin_revoke on public.chat_invites;
create policy invites_admin_revoke on public.chat_invites for update to authenticated
  using (public.is_chat_admin(chat_id)) with check (public.is_chat_admin(chat_id));

drop policy if exists join_requests_read on public.join_requests;
create policy join_requests_read on public.join_requests for select to authenticated
  using (user_id = auth.uid() or public.is_chat_admin(chat_id));

drop policy if exists blocks_own on public.blocks;
create policy blocks_own on public.blocks for all to authenticated
  using (blocker = auth.uid()) with check (blocker = auth.uid());

drop policy if exists reports_insert_own on public.message_reports;
create policy reports_insert_own on public.message_reports for insert to authenticated
  with check (reporter = auth.uid() and public.is_chat_member(chat_id));
drop policy if exists reports_read_own_or_admin on public.message_reports;
create policy reports_read_own_or_admin on public.message_reports for select to authenticated
  using (reporter = auth.uid() or public.is_chat_admin(chat_id));

drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications for select to authenticated
  using (user_id = auth.uid());
drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists push_select_own on public.push_subscriptions;
create policy push_select_own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists push_insert_own on public.push_subscriptions;
create policy push_insert_own on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists push_delete_own on public.push_subscriptions;
create policy push_delete_own on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
drop policy if exists push_update_own on public.push_subscriptions;
create policy push_update_own on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists calls_read on public.calls;
create policy calls_read on public.calls for select to authenticated using (public.is_chat_member(chat_id));
drop policy if exists call_participants_read on public.call_participants;
create policy call_participants_read on public.call_participants for select to authenticated using (
  exists (select 1 from public.calls c where c.id = call_participants.call_id and public.is_chat_member(c.chat_id))
);
drop policy if exists call_signals_receive on public.call_signals;
create policy call_signals_receive on public.call_signals for select to authenticated using (
  to_user = auth.uid() and exists (select 1 from public.calls c where c.id = call_signals.call_id and public.is_chat_member(c.chat_id))
);
drop policy if exists call_signals_send on public.call_signals;
create policy call_signals_send on public.call_signals for insert to authenticated with check (
  from_user = auth.uid() and exists (
    select 1 from public.calls c
    join public.call_participants sender on sender.call_id = c.id and sender.user_id = auth.uid() and sender.status = 'joined'
    join public.call_participants recipient on recipient.call_id = c.id and recipient.user_id = call_signals.to_user and recipient.status = 'joined'
    where c.id = call_signals.call_id and c.status <> 'ended' and public.is_chat_member(c.chat_id)
  )
);
drop policy if exists call_signals_delete_received on public.call_signals;
create policy call_signals_delete_received on public.call_signals for delete to authenticated using (to_user = auth.uid());

drop policy if exists public_keys_read on public.user_public_keys;
create policy public_keys_read on public.user_public_keys for select to authenticated
  using (user_id = auth.uid() or public.shares_chat_with(user_id));
drop policy if exists public_keys_insert_own on public.user_public_keys;
create policy public_keys_insert_own on public.user_public_keys for insert to authenticated with check (user_id = auth.uid());
drop policy if exists public_keys_update_own on public.user_public_keys;
create policy public_keys_update_own on public.user_public_keys for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists prekey_bundles_read on public.user_prekey_bundles;
create policy prekey_bundles_read on public.user_prekey_bundles for select to authenticated
  using (user_id = auth.uid() or public.shares_chat_with(user_id));

drop policy if exists one_time_prekeys_read_own on public.user_one_time_prekeys;
create policy one_time_prekeys_read_own on public.user_one_time_prekeys for select to authenticated
  using (user_id = auth.uid());

drop policy if exists polls_read on public.polls;
create policy polls_read on public.polls for select to authenticated using (public.is_chat_member(chat_id));
drop policy if exists poll_options_read on public.poll_options;
create policy poll_options_read on public.poll_options for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_options.poll_id and public.is_chat_member(p.chat_id))
);
drop policy if exists poll_votes_read on public.poll_votes;
create policy poll_votes_read on public.poll_votes for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_votes.poll_id and public.is_chat_member(p.chat_id))
  and (
    user_id = auth.uid()
    or not exists (select 1 from public.polls p2 where p2.id = poll_votes.poll_id and p2.anonymous)
  )
);
drop policy if exists poll_vote_counts_read on public.poll_vote_counts;
create policy poll_vote_counts_read on public.poll_vote_counts for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_vote_counts.poll_id and public.is_chat_member(p.chat_id))
);

-- ------------------------------------------------------------ storage RLS --

drop policy if exists avatar_read on storage.objects;
create policy avatar_read on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or case when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then public.shares_chat_with(((storage.foldername(name))[1])::uuid)
        else false end
    )
  );

drop policy if exists avatar_upload on storage.objects;
create policy avatar_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(name) !~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh)$'
  );

drop policy if exists avatar_update on storage.objects;
create policy avatar_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(name) !~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh)$'
  );

drop policy if exists avatar_delete on storage.objects;
create policy avatar_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects for select to authenticated
  using (
    bucket_id = 'chat_media'
    and exists (
      select 1 from public.chat_participants p
      where p.chat_id::text = (storage.foldername(objects.name))[1] and p.user_id = auth.uid()
    )
  );

drop policy if exists media_upload on storage.objects;
create policy media_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat_media'
    and lower(name) !~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh|php|jsp)$'
    and (
      -- ordinary chat media: <chat_id>/<sender_id>/<file>, sender is a member
      (
        (storage.foldername(name))[2] = auth.uid()::text
        and exists (
          select 1 from public.chat_participants p
          where p.chat_id::text = (storage.foldername(objects.name))[1] and p.user_id = auth.uid()
        )
      )
      or
      -- group / channel avatar: <chat_id>/<uploader_id>/avatar-*, uploader is admin
      (
        lower(split_part(name, '/', -1)) like 'avatar-%'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and public.is_chat_admin(((storage.foldername(name))[1])::uuid)
      )
    )
  );

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'chat_media'
    and (
      (
        (storage.foldername(objects.name))[2] = auth.uid()::text
        and exists (
          select 1 from public.chat_participants p
          where p.chat_id::text = (storage.foldername(objects.name))[1] and p.user_id = auth.uid()
        )
      )
      or (
        (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and public.is_chat_admin(((storage.foldername(objects.name))[1])::uuid)
      )
    )
  );

drop policy if exists channel_avatar_read on storage.objects;
create policy channel_avatar_read on storage.objects for select to authenticated
  using (
    bucket_id = 'chat_media'
    and case
      when (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then exists (
          select 1 from public.chats c
          where c.id = ((storage.foldername(objects.name))[1])::uuid
            and c.kind = 'channel' and c.is_public
        )
      else false
    end
  );

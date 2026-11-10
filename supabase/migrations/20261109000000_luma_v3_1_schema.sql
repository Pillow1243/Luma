-- ============================================================
-- Luma v3 — security hardening + feature set
-- Applied to project lnhmbjqjfrnqkpsjpszb on 2026-11-09.
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ============================================================
-- 1. SCHEMA EVOLUTION
-- ============================================================

-- profiles: usernames, bios, last-seen privacy
alter table public.profiles add column if not exists username citext;
alter table public.profiles add column if not exists bio text not null default '';
alter table public.profiles add column if not exists show_last_seen boolean not null default true;

do $$ begin
  alter table public.profiles add constraint profiles_username_format
    check (username is null or (username::text ~ '^[a-z0-9_]{3,32}$' and username::text = lower(username::text)));
exception when duplicate_object then null; end $$;
create unique index if not exists profiles_username_key on public.profiles (username) where username is not null;

-- chats: kind (direct/group/saved/channel), channel metadata, disappearing default TTL
alter table public.chats add column if not exists kind text not null default 'direct';
alter table public.chats add column if not exists description text not null default '';
alter table public.chats add column if not exists username citext;
alter table public.chats add column if not exists is_public boolean not null default false;

do $$ begin
  alter table public.chats add constraint chats_kind_check check (kind in ('direct','group','saved','channel'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.chats add constraint chats_username_format
    check (username is null or (username::text ~ '^[a-z0-9_]{3,32}$' and username::text = lower(username::text)));
exception when duplicate_object then null; end $$;
create unique index if not exists chats_username_key on public.chats (username) where username is not null;

update public.chats set kind = case when is_group then 'group' else 'direct' end where kind = 'direct';

-- chat_participants: per-user mute + archive
alter table public.chat_participants add column if not exists muted_until timestamptz;
alter table public.chat_participants add column if not exists archived_at timestamptz;

-- messages: mentions
alter table public.messages add column if not exists mentions uuid[] not null default '{}';

-- starred messages (per-user saved list)
create table if not exists public.starred_messages (
  user_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

-- chat invitation links
create table if not exists public.chat_invites (
  token uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses integer not null default 50,
  uses integer not null default 0,
  revoked_at timestamptz,
  constraint chat_invites_max_uses check (max_uses between 1 and 10000),
  constraint chat_invites_uses check (uses >= 0)
);
create index if not exists chat_invites_chat_idx on public.chat_invites (chat_id);

-- join requests (approval-based membership)
create table if not exists public.join_requests (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

-- blocked users
create table if not exists public.blocks (
  blocker uuid not null references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  constraint blocks_not_self check (blocker <> blocked)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked);

-- message reports / moderation
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

-- notifications (mentions, join decisions)
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_id uuid references public.chats (id) on delete cascade,
  message_id uuid references public.messages (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('mention','join_approved','join_rejected','system')),
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ============================================================
-- 2. HELPER FUNCTIONS
-- ============================================================

create or replace function public.is_channel(cid uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.chats where id = cid and kind = 'channel')
$$;

create or replace function public.shares_chat_with(other uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (
    select 1 from public.chat_participants a
    join public.chat_participants b on b.chat_id = a.chat_id
    where a.user_id = auth.uid() and b.user_id = other
  )
$$;

create or replace function public.channel_subscriber_count(cid uuid)
returns integer language sql stable security definer set search_path to '' as $$
  select count(*)::integer from public.chat_participants where chat_id = cid
$$;

-- ============================================================
-- 3. GRANTS — remove table-level UPDATE/DELETE/INSERT that bypass RPC authorization
-- ============================================================

revoke insert, update, delete on public.chat_participants from authenticated;
grant update (last_read_at, last_seen_at, typing_until, muted_until, archived_at)
  on public.chat_participants to authenticated;

revoke update, delete on public.messages from authenticated;
revoke insert, update, delete on public.chats from authenticated;
revoke update on public.message_reactions from authenticated;


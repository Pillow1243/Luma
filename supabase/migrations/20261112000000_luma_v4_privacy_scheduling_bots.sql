-- ============================================================================
-- Luma — v4: privacy controls, scheduled messages, draft sync, slow mode,
-- audit log, device sessions, bot platform, link-preview cache, global search
-- ============================================================================
-- Additive-only, forward-only, idempotent. Safe to replay on FRESH (baseline +
-- all migrations) and UPGRADE (production baseline + pending migrations).
-- No existing table is dropped or narrowed; new columns have defaults so
-- existing rows remain valid. Every new function is SECURITY DEFINER with
-- set search_path = '' and explicit revokes (see docs/DB.md §3).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Privacy columns on profiles
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists show_online_status boolean not null default true,
  add column if not exists show_read_receipts boolean not null default true,
  add column if not exists show_typing boolean not null default true,
  add column if not exists profile_visibility text not null default 'public'
    check (profile_visibility in ('public', 'contacts', 'private'));

-- Column grants: authenticated may read all, insert/update only own privacy
-- fields (RLS already restricts rows to own profile for writes).
grant select on public.profiles to authenticated;
grant insert (id, display_name, avatar_path, username, bio, show_last_seen, last_seen_at,
              show_online_status, show_read_receipts, show_typing, profile_visibility)
  on public.profiles to authenticated;
grant update (display_name, avatar_path, username, bio, show_last_seen, last_seen_at,
              show_online_status, show_read_receipts, show_typing, profile_visibility)
  on public.profiles to authenticated;

-- Extend privacy guard to new fields (trim + visibility validation).
create or replace function public.profiles_privacy_guard()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.display_name is null or length(btrim(new.display_name)) = 0 then
    raise exception 'Display name cannot be empty';
  end if;
  new.display_name := left(btrim(new.display_name), 60);
  new.bio := left(coalesce(new.bio, ''), 280);
  if not coalesce(new.show_last_seen, true) then
    new.last_seen_at := null;
  end if;
  if not coalesce(new.show_online_status, true) then
    new.last_seen_at := null;
  end if;
  if new.profile_visibility is null or new.profile_visibility not in ('public', 'contacts', 'private') then
    new.profile_visibility := 'public';
  end if;
  return new;
end
$$;

drop trigger if exists profiles_privacy_guard on public.profiles;
create trigger profiles_privacy_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_privacy_guard();

-- ---------------------------------------------------------------------------
-- 2. Group/channel controls on chats
-- ---------------------------------------------------------------------------
alter table public.chats
  add column if not exists slow_mode_seconds integer not null default 0
    check (slow_mode_seconds >= 0 and slow_mode_seconds <= 86400),
  add column if not exists member_limit integer not null default 100
    check (member_limit >= 2 and member_limit <= 100000);

-- ---------------------------------------------------------------------------
-- 3. Scheduled messages (separate table so RLS never leaks future messages)
-- ---------------------------------------------------------------------------
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text,
  reply_to uuid references public.messages (id) on delete set null,
  media_path text,
  media_name text,
  media_type text,
  mentions uuid[] not null default '{}',
  scheduled_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint scheduled_messages_body_check check (body is null or length(body) <= 16000),
  constraint scheduled_messages_future_check check (scheduled_at > now() - interval '5 minutes')
);
-- Index all scheduled rows; a volatile clock expression is not legal in a
-- partial-index predicate. The worker's due-time filter uses this btree.
create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages (scheduled_at);
create index if not exists scheduled_messages_sender_idx
  on public.scheduled_messages (sender_id, scheduled_at);
create index if not exists scheduled_messages_chat_idx
  on public.scheduled_messages (chat_id, scheduled_at);

alter table public.scheduled_messages enable row level security;

drop policy if exists scheduled_read_own on public.scheduled_messages;
create policy scheduled_read_own on public.scheduled_messages
  for select to authenticated
  using (sender_id = auth.uid());

drop policy if exists scheduled_insert_own on public.scheduled_messages;
create policy scheduled_insert_own on public.scheduled_messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_chat_member(chat_id));

drop policy if exists scheduled_update_own on public.scheduled_messages;
create policy scheduled_update_own on public.scheduled_messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

drop policy if exists scheduled_delete_own on public.scheduled_messages;
create policy scheduled_delete_own on public.scheduled_messages
  for delete to authenticated
  using (sender_id = auth.uid());

revoke all on public.scheduled_messages from anon, authenticated, public;
-- Writes go only through ownership-checking RPCs so direct inserts cannot
-- bypass the scheduling horizon, channel-admin check, or rate limit.
grant select on public.scheduled_messages to authenticated;
grant all on public.scheduled_messages to service_role;

-- ---------------------------------------------------------------------------
-- 4. Draft synchronization (per user+chat, server-backed)
-- ---------------------------------------------------------------------------
create table if not exists public.message_drafts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  body text not null default '',
  reply_to uuid references public.messages (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, chat_id),
  constraint message_drafts_body_check check (length(body) <= 16000)
);
create index if not exists message_drafts_user_idx on public.message_drafts (user_id);

alter table public.message_drafts enable row level security;

drop policy if exists drafts_own on public.message_drafts;
create policy drafts_own on public.message_drafts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_chat_member(chat_id));

revoke all on public.message_drafts from anon, public;
grant select, insert (user_id, chat_id, body, reply_to, updated_at),
      update (body, reply_to, updated_at), delete on public.message_drafts to authenticated;
grant all on public.message_drafts to service_role;

-- ---------------------------------------------------------------------------
-- 5. Chat audit log (admin/moderation trail, read by admins only)
-- ---------------------------------------------------------------------------
create table if not exists public.chat_audit_log (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null check (action in (
    'member_added', 'member_removed', 'admin_granted', 'admin_revoked',
    'invite_created', 'invite_revoked', 'slow_mode_changed', 'member_limit_changed',
    'chat_updated', 'join_approved', 'join_rejected', 'message_deleted', 'bot_message'
  )),
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists chat_audit_log_chat_idx
  on public.chat_audit_log (chat_id, created_at desc);

alter table public.chat_audit_log enable row level security;

drop policy if exists audit_admin_read on public.chat_audit_log;
create policy audit_admin_read on public.chat_audit_log
  for select to authenticated
  using (public.is_chat_admin(chat_id));

-- No direct client writes: only SECURITY DEFINER functions/triggers insert.
revoke all on public.chat_audit_log from anon, authenticated, public;
grant select on public.chat_audit_log to authenticated;
grant all on public.chat_audit_log to service_role;

create or replace function public.log_chat_audit(
  p_chat uuid, p_actor uuid, p_action text, p_target uuid default null, p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  if p_chat is null or p_action is null then return; end if;
  insert into public.chat_audit_log (chat_id, actor_id, action, target_id, details)
  values (p_chat, p_actor, p_action, p_target, coalesce(p_details, '{}'::jsonb));
end
$$;
revoke all on function public.log_chat_audit(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.log_chat_audit(uuid, uuid, text, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Device sessions (active-session management)
-- ---------------------------------------------------------------------------
create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_name text not null default 'Unknown device',
  user_agent text not null default '',
  ip_hash text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists user_sessions_user_idx
  on public.user_sessions (user_id, last_seen_at desc) where revoked_at is null;

alter table public.user_sessions enable row level security;

drop policy if exists sessions_own on public.user_sessions;
create policy sessions_own on public.user_sessions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.user_sessions from anon, public;
grant select, insert (id, user_id, device_name, user_agent, ip_hash, last_seen_at, created_at, revoked_at),
      update (device_name, user_agent, last_seen_at, revoked_at), delete
  on public.user_sessions to authenticated;
grant all on public.user_sessions to service_role;

-- ---------------------------------------------------------------------------
-- 7. Bot platform (accounts, tokens, API audit)
-- ---------------------------------------------------------------------------
create table if not exists public.bots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  username citext not null unique,
  description text not null default '' check (char_length(description) <= 500),
  webhook_url text,
  webhook_secret text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint bots_username_format check (username::text ~ '^[a-z0-9_]{3,32}$'),
  constraint bots_webhook_url_check check (webhook_url is null or webhook_url ~ '^https://')
);
create index if not exists bots_owner_idx on public.bots (owner_id);

alter table public.bots enable row level security;

drop policy if exists bots_owner_read on public.bots;
create policy bots_owner_read on public.bots
  for select to authenticated
  using (owner_id = auth.uid());

drop policy if exists bots_owner_insert on public.bots;
create policy bots_owner_insert on public.bots
  for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists bots_owner_update on public.bots;
create policy bots_owner_update on public.bots
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists bots_owner_delete on public.bots;
create policy bots_owner_delete on public.bots
  for delete to authenticated
  using (owner_id = auth.uid());

revoke all on public.bots from anon, public;
grant select, insert (id, owner_id, name, username, description, webhook_url, webhook_secret, is_active, created_at),
      update (name, description, webhook_url, webhook_secret, is_active), delete on public.bots to authenticated;
grant all on public.bots to service_role;

create table if not exists public.bot_tokens (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots (id) on delete cascade,
  token_hash text not null unique,
  scopes text[] not null default '{messages:send, messages:read, chats:read}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists bot_tokens_bot_idx on public.bot_tokens (bot_id) where revoked_at is null;

alter table public.bot_tokens enable row level security;

-- Owners may list their tokens (hash only, never the raw token) via RPC;
-- direct table access is denied to prevent hash harvesting.
revoke all on public.bot_tokens from anon, authenticated, public;
grant all on public.bot_tokens to service_role;

create table if not exists public.bot_api_logs (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots (id) on delete cascade,
  endpoint text not null,
  status_code integer not null,
  created_at timestamptz not null default now()
);
create index if not exists bot_api_logs_bot_idx on public.bot_api_logs (bot_id, created_at desc);

alter table public.bot_api_logs enable row level security;
revoke all on public.bot_api_logs from anon, authenticated, public;
grant all on public.bot_api_logs to service_role;

-- ---------------------------------------------------------------------------
-- 8. Link-preview cache (populated by the link-preview edge function)
-- ---------------------------------------------------------------------------
create table if not exists public.link_previews (
  url_hash text primary key,
  url text not null,
  title text not null default '',
  description text not null default '',
  image_url text,
  created_at timestamptz not null default now()
);
create index if not exists link_previews_created_idx on public.link_previews (created_at);

alter table public.link_previews enable row level security;

drop policy if exists link_previews_read on public.link_previews;
create policy link_previews_read on public.link_previews
  for select to authenticated
  using (true);

revoke all on public.link_previews from anon, public;
grant select on public.link_previews to authenticated;
grant all on public.link_previews to service_role;

-- ---------------------------------------------------------------------------
-- 9. Slow-mode enforcement in messages_guardian (replace, keep all prior checks)
-- ---------------------------------------------------------------------------
create or replace function public.messages_guardian()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  c public.chats;
  last_msg_at timestamptz;
  slow_secs integer;
begin
  -- The scheduled publisher is a narrowly granted SECURITY DEFINER worker.
  -- Every other insert still requires the authenticated sender identity.
  if auth.uid() is null and coalesce(current_setting('luma.scheduled_publisher', true), '') <> 'true' then
    raise exception 'Authentication required';
  end if;
  if auth.uid() is not null and new.sender_id <> auth.uid() then
    raise exception 'Cannot send as another user';
  end if;

  if auth.uid() is not null then
    perform public.check_rate_limit('send_message', 60, 60);
  end if;

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

  -- Slow mode: non-admins must wait between messages in groups/channels.
  slow_secs := coalesce(c.slow_mode_seconds, 0);
  if slow_secs > 0 and not public.is_chat_admin(new.chat_id) then
    -- Serialize per-chat/sender so concurrent inserts cannot both pass slow mode.
    perform pg_advisory_xact_lock(hashtextextended(new.chat_id::text || ':' || new.sender_id::text, 0));
    select max(created_at) into last_msg_at
      from public.messages
     where chat_id = new.chat_id and sender_id = new.sender_id and deleted_at is null;
    if last_msg_at is not null and last_msg_at > now() - make_interval(secs => slow_secs) then
      raise exception 'Slow mode is on — please wait before sending again';
    end if;
  end if;

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
$$;

drop trigger if exists messages_guardian on public.messages;
create trigger messages_guardian before insert on public.messages
  for each row execute function public.messages_guardian();

-- ---------------------------------------------------------------------------
-- 10. Audit triggers for membership/admin changes
-- ---------------------------------------------------------------------------
create or replace function public.audit_participant_changes()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_chat_audit(new.chat_id, auth.uid(), 'member_added', new.user_id,
      jsonb_build_object('is_admin', new.is_admin));
  elsif tg_op = 'DELETE' then
    perform public.log_chat_audit(old.chat_id, auth.uid(), 'member_removed', old.user_id, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.is_admin is distinct from new.is_admin then
    perform public.log_chat_audit(new.chat_id, auth.uid(),
      case when new.is_admin then 'admin_granted' else 'admin_revoked' end,
      new.user_id, '{}'::jsonb);
  end if;
  return coalesce(new, old);
end
$$;

drop trigger if exists audit_participant_changes on public.chat_participants;
create trigger audit_participant_changes
  after insert or update or delete on public.chat_participants
  for each row execute function public.audit_participant_changes();

revoke all on function public.audit_participant_changes() from public, anon, authenticated;
grant execute on function public.audit_participant_changes() to service_role;

-- ---------------------------------------------------------------------------
-- 11. Scheduled-message RPCs
-- ---------------------------------------------------------------------------
create or replace function public.schedule_message(
  p_chat uuid, p_body text, p_reply_to uuid default null,
  p_media_path text default null, p_media_name text default null, p_media_type text default null,
  p_mentions uuid[] default '{}', p_scheduled_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  uid uuid := auth.uid();
  mid uuid;
  c public.chats;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_member(p_chat) then raise exception 'Not a member of this chat'; end if;
  if p_scheduled_at is null or p_scheduled_at <= now() + interval '1 minute' then
    raise exception 'Scheduled time must be at least 1 minute in the future';
  end if;
  if p_scheduled_at > now() + interval '365 days' then
    raise exception 'Scheduled time is too far in the future';
  end if;
  if p_body is not null and length(p_body) > 16000 then
    raise exception 'Message exceeds 16000 characters';
  end if;
  if p_body is null and p_media_path is null then
    raise exception 'Message body or media required';
  end if;
  select * into c from public.chats where id = p_chat;
  if c.kind = 'channel' and not public.is_chat_admin(p_chat) then
    raise exception 'Only channel admins can post';
  end if;
  perform public.check_rate_limit('schedule_message', 60, 30);
  insert into public.scheduled_messages
    (chat_id, sender_id, body, reply_to, media_path, media_name, media_type, mentions, scheduled_at)
  values (p_chat, uid, p_body, p_reply_to, p_media_path, p_media_name, p_media_type,
          coalesce(p_mentions, '{}'), p_scheduled_at)
  returning id into mid;
  return mid;
end
$$;
revoke all on function public.schedule_message(uuid, text, uuid, text, text, text, uuid[], timestamptz) from public, anon;
grant execute on function public.schedule_message(uuid, text, uuid, text, text, text, uuid[], timestamptz) to authenticated;

create or replace function public.cancel_scheduled_message(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  delete from public.scheduled_messages where id = p_id and sender_id = uid;
  if not found then raise exception 'Scheduled message not found'; end if;
end
$$;
revoke all on function public.cancel_scheduled_message(uuid) from public, anon;
grant execute on function public.cancel_scheduled_message(uuid) to authenticated;

create or replace function public.list_scheduled_messages(p_chat uuid)
returns setof public.scheduled_messages
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_member(p_chat) then raise exception 'Not a member of this chat'; end if;
  return query select * from public.scheduled_messages
    where chat_id = p_chat and sender_id = uid
    order by scheduled_at asc;
end
$$;
revoke all on function public.list_scheduled_messages(uuid) from public, anon;
grant execute on function public.list_scheduled_messages(uuid) to authenticated;

create or replace function public.publish_scheduled_messages()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  r record;
  n integer := 0;
  new_id uuid;
begin
  for r in select * from public.scheduled_messages where scheduled_at <= now() order by scheduled_at limit 500 loop
    begin
      -- Do not publish after the sender has left the conversation.
      if not exists (select 1 from public.chat_participants p where p.chat_id = r.chat_id and p.user_id = r.sender_id) then
        delete from public.scheduled_messages where id = r.id;
        continue;
      end if;
      perform set_config('luma.scheduled_publisher', 'true', true);
      perform set_config('request.jwt.claim.sub', r.sender_id::text, true);
      insert into public.messages
        (chat_id, sender_id, body, reply_to, media_path, media_name, media_type, mentions)
      values (r.chat_id, r.sender_id, r.body, r.reply_to, r.media_path, r.media_name, r.media_type, r.mentions)
      returning id into new_id;
      delete from public.scheduled_messages where id = r.id;
      n := n + 1;
    exception when others then
      -- Skip rows that now violate guardian (e.g. blocked, slow mode, removed member).
      delete from public.scheduled_messages where id = r.id;
    end;
    perform set_config('luma.scheduled_publisher', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
  end loop;
  return n;
end
$$;
revoke all on function public.publish_scheduled_messages() from public, anon, authenticated;
grant execute on function public.publish_scheduled_messages() to service_role;

-- ---------------------------------------------------------------------------
-- 12. Draft RPCs
-- ---------------------------------------------------------------------------
create or replace function public.save_draft(p_chat uuid, p_body text, p_reply_to uuid default null)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_member(p_chat) then raise exception 'Not a member of this chat'; end if;
  if length(coalesce(p_body, '')) > 16000 then raise exception 'Draft too long'; end if;
  insert into public.message_drafts (user_id, chat_id, body, reply_to, updated_at)
  values (uid, p_chat, coalesce(p_body, ''), p_reply_to, now())
  on conflict (user_id, chat_id) do update
    set body = excluded.body, reply_to = excluded.reply_to, updated_at = now();
end
$$;
revoke all on function public.save_draft(uuid, text, uuid) from public, anon;
grant execute on function public.save_draft(uuid, text, uuid) to authenticated;

create or replace function public.get_draft(p_chat uuid)
returns table (body text, reply_to uuid, updated_at timestamptz)
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  return query select d.body, d.reply_to, d.updated_at from public.message_drafts d
    where d.user_id = uid and d.chat_id = p_chat;
end
$$;
revoke all on function public.get_draft(uuid) from public, anon;
grant execute on function public.get_draft(uuid) to authenticated;

create or replace function public.clear_draft(p_chat uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  delete from public.message_drafts where user_id = uid and chat_id = p_chat;
end
$$;
revoke all on function public.clear_draft(uuid) from public, anon;
grant execute on function public.clear_draft(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. Group controls RPCs
-- ---------------------------------------------------------------------------
create or replace function public.set_slow_mode(p_chat uuid, p_seconds integer)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(p_chat) then raise exception 'Only admins can change slow mode'; end if;
  if p_seconds < 0 or p_seconds > 86400 then raise exception 'Invalid slow mode'; end if;
  update public.chats set slow_mode_seconds = p_seconds where id = p_chat;
  perform public.log_chat_audit(p_chat, uid, 'slow_mode_changed', null,
    jsonb_build_object('seconds', p_seconds));
end
$$;
revoke all on function public.set_slow_mode(uuid, integer) from public, anon;
grant execute on function public.set_slow_mode(uuid, integer) to authenticated;

create or replace function public.set_member_limit(p_chat uuid, p_limit integer)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(p_chat) then raise exception 'Only admins can change member limit'; end if;
  if p_limit < 2 or p_limit > 100000 then raise exception 'Invalid member limit'; end if;
  update public.chats set member_limit = p_limit where id = p_chat;
  perform public.log_chat_audit(p_chat, uid, 'member_limit_changed', null,
    jsonb_build_object('limit', p_limit));
end
$$;
revoke all on function public.set_member_limit(uuid, integer) from public, anon;
grant execute on function public.set_member_limit(uuid, integer) to authenticated;

create or replace function public.list_chat_audit(p_chat uuid, p_limit integer default 50)
returns setof public.chat_audit_log
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(p_chat) then raise exception 'Only admins can view audit log'; end if;
  return query select * from public.chat_audit_log
    where chat_id = p_chat order by created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
end
$$;
revoke all on function public.list_chat_audit(uuid, integer) from public, anon;
grant execute on function public.list_chat_audit(uuid, integer) to authenticated;

create or replace function public.get_chat_analytics(p_chat uuid)
returns table (messages_total bigint, messages_7d bigint, members bigint, media_total bigint)
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(p_chat) then raise exception 'Only admins can view analytics'; end if;
  return query
    select
      (select count(*) from public.messages where chat_id = p_chat and deleted_at is null),
      (select count(*) from public.messages where chat_id = p_chat and deleted_at is null and created_at > now() - interval '7 days'),
      (select count(*) from public.chat_participants where chat_id = p_chat),
      (select count(*) from public.messages where chat_id = p_chat and deleted_at is null and media_path is not null);
end
$$;
revoke all on function public.get_chat_analytics(uuid) from public, anon;
grant execute on function public.get_chat_analytics(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 14. Session RPCs
-- ---------------------------------------------------------------------------
create or replace function public.register_session(p_device_name text, p_user_agent text default '')
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid(); sid uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_device_name, '')) = 0 or length(p_device_name) > 120 then
    raise exception 'Invalid device name';
  end if;
  insert into public.user_sessions (user_id, device_name, user_agent)
  values (uid, left(p_device_name, 120), left(coalesce(p_user_agent, ''), 500))
  returning id into sid;
  return sid;
end
$$;
revoke all on function public.register_session(text, text) from public, anon;
grant execute on function public.register_session(text, text) to authenticated;

create or replace function public.heartbeat_session(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  update public.user_sessions set last_seen_at = now()
    where id = p_id and user_id = uid and revoked_at is null;
end
$$;
revoke all on function public.heartbeat_session(uuid) from public, anon;
grant execute on function public.heartbeat_session(uuid) to authenticated;

create or replace function public.list_my_sessions()
returns setof public.user_sessions
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  return query select * from public.user_sessions
    where user_id = uid order by last_seen_at desc limit 20;
end
$$;
revoke all on function public.list_my_sessions() from public, anon;
grant execute on function public.list_my_sessions() to authenticated;

create or replace function public.revoke_session(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  update public.user_sessions set revoked_at = now()
    where id = p_id and user_id = uid and revoked_at is null;
  if not found then raise exception 'Session not found'; end if;
end
$$;
revoke all on function public.revoke_session(uuid) from public, anon;
grant execute on function public.revoke_session(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 15. Bot RPCs (token hashing with pgcrypto; raw token never stored)
-- ---------------------------------------------------------------------------
create or replace function public.create_bot(
  p_name text, p_username text, p_description text default '',
  p_webhook_url text default null, p_webhook_secret text default null
)
returns table (bot_id uuid, token text)
language plpgsql
security definer
set search_path to ''
as $$
declare
  uid uuid := auth.uid();
  bid uuid;
  raw_token text;
  token_hash text;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if p_name is null or length(trim(p_name)) = 0 or length(p_name) > 80 then
    raise exception 'Bot name required (1-80 chars)';
  end if;
  if p_username is null or lower(trim(p_username)) !~ '^[a-z0-9_]{3,32}$' then
    raise exception 'Username must be 3-32 chars: lowercase letters, digits, underscores';
  end if;
  if p_webhook_url is not null and p_webhook_url !~ '^https://' then
    raise exception 'Webhook URL must be https';
  end if;
  perform public.check_rate_limit('create_bot', 3600, 5);
  insert into public.bots (owner_id, name, username, description, webhook_url, webhook_secret)
  values (uid, trim(p_name), lower(trim(p_username)), left(coalesce(p_description, ''), 500),
          p_webhook_url, p_webhook_secret)
  returning id into bid;
  raw_token := 'luma_bot_' || encode(gen_random_bytes(24), 'hex');
  token_hash := encode(digest(raw_token, 'sha256'), 'hex');
  insert into public.bot_tokens (bot_id, token_hash) values (bid, token_hash);
  return query select bid, raw_token;
end
$$;
revoke all on function public.create_bot(text, text, text, text, text) from public, anon;
grant execute on function public.create_bot(text, text, text, text, text) to authenticated;

create or replace function public.create_bot_token(p_bot uuid, p_scopes text[] default '{messages:send, messages:read, chats:read}')
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  uid uuid := auth.uid();
  raw_token text;
  token_hash text;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.bots where id = p_bot and owner_id = uid) then
    raise exception 'Bot not found';
  end if;
  if coalesce(p_scopes, '{}') = '{}' or
     not (coalesce(p_scopes, '{}') <@ array['messages:send', 'messages:read', 'chats:read']::text[]) then
    raise exception 'Unsupported bot scopes';
  end if;
  raw_token := 'luma_bot_' || encode(gen_random_bytes(24), 'hex');
  token_hash := encode(digest(raw_token, 'sha256'), 'hex');
  insert into public.bot_tokens (bot_id, token_hash, scopes)
  values (p_bot, token_hash, coalesce(p_scopes, '{messages:send, messages:read, chats:read}'));
  return raw_token;
end
$$;
revoke all on function public.create_bot_token(uuid, text[]) from public, anon;
grant execute on function public.create_bot_token(uuid, text[]) to authenticated;

create or replace function public.revoke_bot_token(p_token_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  update public.bot_tokens t set revoked_at = now()
    from public.bots b
   where t.id = p_token_id and t.bot_id = b.id and b.owner_id = uid and t.revoked_at is null;
  if not found then raise exception 'Token not found'; end if;
end
$$;
revoke all on function public.revoke_bot_token(uuid) from public, anon;
grant execute on function public.revoke_bot_token(uuid) to authenticated;

create or replace function public.list_my_bot_tokens(p_bot uuid)
returns table (id uuid, scopes text[], created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.bots where id = p_bot and owner_id = uid) then
    raise exception 'Bot not found';
  end if;
  return query select t.id, t.scopes, t.created_at, t.last_used_at, t.revoked_at
    from public.bot_tokens t where t.bot_id = p_bot order by t.created_at desc;
end
$$;
revoke all on function public.list_my_bot_tokens(uuid) from public, anon;
grant execute on function public.list_my_bot_tokens(uuid) to authenticated;

-- Service-role only: verify a bot token for the bot-api edge function.
create or replace function public.verify_bot_token(p_token text)
returns table (bot_id uuid, owner_id uuid, scopes text[])
language plpgsql
security definer
set search_path to ''
as $$
declare v_token_hash text;
begin
  if p_token is null or p_token !~ '^luma_bot_[a-f0-9]{48}$' then
    return;
  end if;
  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');
  return query
    select t.bot_id, b.owner_id, t.scopes
      from public.bot_tokens t
      join public.bots b on b.id = t.bot_id
     where t.token_hash = v_token_hash and t.revoked_at is null and b.is_active;
  update public.bot_tokens t set last_used_at = now()
    where t.token_hash = v_token_hash and t.revoked_at is null;
end
$$;
revoke all on function public.verify_bot_token(text) from public, anon, authenticated;
grant execute on function public.verify_bot_token(text) to service_role;

-- ---------------------------------------------------------------------------
-- 16. Global message search (trigram, paginated, member-scoped)
-- ---------------------------------------------------------------------------
create or replace function public.search_messages_global(
  p_term text, p_limit integer default 40, p_offset integer default 0,
  p_chat uuid default null, p_media_only boolean default false, p_from_me boolean default false
)
returns setof public.messages
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_term, '')) < 2 then raise exception 'Search term too short'; end if;
  return query
    select m.* from public.messages m
    where m.deleted_at is null
      and m.body is not null and m.body not like 'luma:e2ee:%'
      and public.is_chat_member(m.chat_id)
      and (m.body % p_term or m.body ilike '%' || p_term || '%')
      and (p_chat is null or m.chat_id = p_chat)
      and (not coalesce(p_media_only, false) or m.media_path is not null)
      and (not coalesce(p_from_me, false) or m.sender_id = uid)
    order by m.created_at desc
    limit least(greatest(coalesce(p_limit, 40), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end
$$;
revoke all on function public.search_messages_global(text, integer, integer, uuid, boolean, boolean) from public, anon;
grant execute on function public.search_messages_global(text, integer, integer, uuid, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 17. Data export (own data only, JSON)
-- ---------------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  return jsonb_build_object(
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'chats', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from public.chats c
      where c.id in (select chat_id from public.chat_participants where user_id = uid)),
    'messages_sent', (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from public.messages m where m.sender_id = uid),
    'starred', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.starred_messages s where s.user_id = uid),
    'blocks', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from public.blocks b where b.blocker = uid),
    'bots', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from public.bots b where b.owner_id = uid),
    'exported_at', now()
  );
end
$$;
revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- ---------------------------------------------------------------------------
-- 18. Retention cleanups + cron
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_v4_retention()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare n integer := 0;
begin
  delete from public.message_drafts where updated_at < now() - interval '90 days';
  get diagnostics n = row_count;
  delete from public.user_sessions where revoked_at is not null and revoked_at < now() - interval '90 days';
  delete from public.bot_api_logs where created_at < now() - interval '30 days';
  delete from public.link_previews where created_at < now() - interval '30 days';
  return n;
end
$$;
revoke all on function public.cleanup_v4_retention() from public, anon, authenticated;
grant execute on function public.cleanup_v4_retention() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('publish-scheduled-messages')
      where exists (select 1 from cron.job where jobname = 'publish-scheduled-messages');
    perform cron.schedule('publish-scheduled-messages', '* * * * *',
      $cron$select public.publish_scheduled_messages()$cron$);
    perform cron.unschedule('cleanup-v4-retention')
      where exists (select 1 from cron.job where jobname = 'cleanup-v4-retention');
    perform cron.schedule('cleanup-v4-retention', '23 3 * * *',
      $cron$select public.cleanup_v4_retention()$cron$);
  end if;
exception when others then
  raise notice 'pg_cron unavailable, scheduled-message publishing must be scheduled manually';
end $$;

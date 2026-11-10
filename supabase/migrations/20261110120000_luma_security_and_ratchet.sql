-- ============================================================================
-- Luma — P0 Security, Privacy, Storage, Scaling & Ratcheted E2EE Hardening
-- ============================================================================

-- 1. Search trigram extension in extensions schema (keeps public clean)
create extension if not exists pg_trgm schema extensions;

-- 2. Fix Foreign Keys that currently block user / message deletion (confdeltype='a')
alter table public.chats alter column created_by drop not null;

alter table public.chats drop constraint if exists chats_created_by_fkey;
alter table public.chats
  add constraint chats_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.messages drop constraint if exists messages_sender_id_fkey;
alter table public.messages
  add constraint messages_sender_id_fkey
  foreign key (sender_id) references public.profiles(id) on delete cascade;

alter table public.messages drop constraint if exists messages_reply_to_fkey;
alter table public.messages
  add constraint messages_reply_to_fkey
  foreign key (reply_to) references public.messages(id) on delete set null;

alter table public.message_reactions drop constraint if exists message_reactions_user_id_fkey;
alter table public.message_reactions
  add constraint message_reactions_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;

-- Transfer chat ownership (or delete empty chats) cleanly before a profile deletes
create or replace function public.handle_profile_delete()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  c record;
  successor uuid;
begin
  for c in select id from public.chats where created_by = old.id loop
    select user_id into successor
    from public.chat_participants
    where chat_id = c.id and user_id <> old.id
    order by is_admin desc, last_read_at desc
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
$$;

drop trigger if exists on_profile_delete on public.profiles;
create trigger on_profile_delete
  before delete on public.profiles
  for each row execute function public.handle_profile_delete();

-- 3. Profile privacy guard (never expose/store last_seen_at when show_last_seen = false)
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
  return new;
end
$$;

drop trigger if exists profiles_privacy_guard on public.profiles;
create trigger profiles_privacy_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_privacy_guard();

update public.profiles
set last_seen_at = null
where show_last_seen = false and last_seen_at is not null;

-- 4. Server-side per-user window rate limiting
create table if not exists public.rate_limits (
  user_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  window_start timestamptz not null default now(),
  hits integer not null default 1,
  primary key (user_id, action)
);

alter table public.rate_limits enable row level security;

create or replace function public.check_rate_limit(
  p_action text,
  p_window_seconds integer,
  p_max_hits integer
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

-- The counters are maintained by SECURITY DEFINER functions only. Leaving this
-- executable by `authenticated` let any signed-in user reset their own
-- send_message / create_invite / request_join counters between calls, which
-- silently disabled every abuse limit in the schema.
revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;

create or replace function public.cleanup_expired_messages()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare n integer;
begin
  delete from public.messages
  where expires_at is not null and expires_at <= now();
  get diagnostics n = row_count;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return n;
end
$$;

create or replace function public.message_reports_guardian()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if auth.uid() is null or new.reporter <> auth.uid() then
    raise exception 'Authentication required';
  end if;
  perform public.check_rate_limit('report_message', 3600, 15);
  new.reason := left(coalesce(nullif(btrim(new.reason), ''), 'abuse'), 80);
  new.details := left(coalesce(new.details, ''), 500);
  return new;
end
$$;

drop trigger if exists message_reports_guardian on public.message_reports;
create trigger message_reports_guardian
  before insert on public.message_reports
  for each row execute function public.message_reports_guardian();

-- 5. Hardened messages_guardian (body length, dangerous MIME guard, rate limit)
create or replace function public.messages_guardian()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

-- 6. X3DH-style Signed Prekey & One-Time Prekey Infrastructure for Secret Chat v2
create table if not exists public.user_prekey_bundles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  identity_key text not null,
  signing_key text not null,
  signed_prekey_id integer not null,
  signed_prekey text not null,
  signed_prekey_sig text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_one_time_prekeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  key_id integer not null,
  public_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, key_id)
);

create index if not exists user_one_time_prekeys_user_idx
  on public.user_one_time_prekeys (user_id, created_at);

alter table public.user_prekey_bundles enable row level security;
alter table public.user_one_time_prekeys enable row level security;

drop policy if exists prekey_bundles_read on public.user_prekey_bundles;
create policy prekey_bundles_read on public.user_prekey_bundles
  for select to authenticated
  using (user_id = auth.uid() or public.shares_chat_with(user_id));

drop policy if exists one_time_prekeys_read_own on public.user_one_time_prekeys;
create policy one_time_prekeys_read_own on public.user_one_time_prekeys
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists public_keys_update_own on public.user_public_keys;
create policy public_keys_update_own on public.user_public_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.publish_prekey_bundle(
  p_identity_key text,
  p_signing_key text,
  p_signed_prekey_id integer,
  p_signed_prekey text,
  p_signed_prekey_sig text,
  p_one_time_keys jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
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

  insert into public.user_public_keys (user_id, public_key, created_at)
  values (uid, p_identity_key, now())
  on conflict (user_id) do update
    set public_key = excluded.public_key;

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
$$;

create or replace function public.claim_prekey_bundle(target_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

create or replace function public.count_one_time_prekeys()
returns integer
language sql
stable
security definer
set search_path to ''
as $$
  select count(*)::integer from public.user_one_time_prekeys where user_id = auth.uid()
$$;

-- 7. Fix RPC bugs (channels avatar/members/admin, polls, concurrent DM creation, search, sidebar summary)
drop function if exists public.update_channel(uuid, text, text, text, boolean);

create or replace function public.update_channel(
  cid uuid,
  new_name text default null,
  new_description text default null,
  new_username text default null,
  new_public boolean default null,
  new_avatar_path text default null
)
returns public.chats
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

create or replace function public.update_group(
  cid uuid,
  new_name text,
  new_avatar_path text
)
returns public.chats
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

create or replace function public.create_chat(
  member_ids uuid[],
  chat_name text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

create or replace function public.remove_chat_member(cid uuid, target uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
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
end
$$;

create or replace function public.set_group_admin(cid uuid, target uuid, make_admin boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $$
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
end
$$;

create or replace function public.create_luma_poll(
  cid uuid,
  poll_question text,
  poll_options text[]
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

create or replace function public.start_luma_call(cid uuid, call_kind text)
returns public.calls
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

create or replace function public.create_invite(
  cid uuid,
  ttl_seconds integer default 86400,
  max_uses integer default 50
)
returns public.chat_invites
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

create or replace function public.request_join(cid uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
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
end
$$;

-- Safe directory search RPC (hides presence metadata; prevents scraping full profiles)
create or replace function public.search_users(term text)
returns table (
  id uuid,
  display_name text,
  username public.citext,
  avatar_path text,
  bio text
)
language plpgsql
stable
security definer
set search_path to ''
as $$
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
$$;

-- Scalable single-query sidebar loader (latest visible message + exact unread count per chat)
create or replace function public.get_chat_sidebar_meta(cids uuid[])
returns table (
  chat_id uuid,
  last_message jsonb,
  unread_count integer
)
language sql
stable
security definer
set search_path to ''
as $$
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
$$;

-- 8. Tighten profiles RLS + fix channel_avatar_read storage policy + safe delete policies
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated
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
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

-- Storage: fix channel_avatar_read bug (c.name -> objects.name), block dangerous extensions, add delete policies
drop policy if exists channel_avatar_read on storage.objects;
create policy channel_avatar_read on storage.objects
  for select to authenticated
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

drop policy if exists avatar_upload on storage.objects;
create policy avatar_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(objects.name))[1] = auth.uid()::text
    and lower(objects.name) !~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh)$'
  );

drop policy if exists avatar_update on storage.objects;
create policy avatar_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(objects.name))[1] = auth.uid()::text)
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(objects.name))[1] = auth.uid()::text
    and lower(objects.name) !~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh)$'
  );

drop policy if exists avatar_delete on storage.objects;
create policy avatar_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(objects.name))[1] = auth.uid()::text);

drop policy if exists media_upload on storage.objects;
create policy media_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat_media'
    and (storage.foldername(objects.name))[2] = auth.uid()::text
    and lower(objects.name) !~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh)$'
    and exists (
      select 1 from public.chat_participants p
      where p.chat_id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  );

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat_media'
    and (
      (
        (storage.foldername(objects.name))[2] = auth.uid()::text
        and exists (
          select 1 from public.chat_participants p
          where p.chat_id::text = (storage.foldername(objects.name))[1]
            and p.user_id = auth.uid()
        )
      )
      or (
        (storage.foldername(objects.name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and public.is_chat_admin(((storage.foldername(objects.name))[1])::uuid)
      )
    )
  );

update storage.buckets
set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','image/avif']
where id = 'avatars';

-- 9. Deduplicate indexes + add GIN trigram search indexes
drop index if exists public.messages_chat_time;
drop index if exists public.messages_pinned_idx2;

create index if not exists messages_body_trgm_idx
  on public.messages using gin (body extensions.gin_trgm_ops)
  where body is not null and body not like 'luma:e2ee:%' and deleted_at is null;

create index if not exists profiles_name_trgm_idx
  on public.profiles using gin (display_name extensions.gin_trgm_ops);

create index if not exists chats_name_trgm_idx
  on public.chats using gin (name extensions.gin_trgm_ops)
  where name is not null;

-- 10. Least-Privilege Grants: strip anon/PUBLIC and minimize authenticated privileges
revoke all on all tables in schema public from anon, public;
revoke all on all sequences in schema public from anon, public;
revoke all on all tables in schema public from authenticated;

revoke all on function
  public.is_chat_member(uuid),
  public.is_chat_admin(uuid),
  public.is_channel(uuid),
  public.shares_chat_with(uuid),
  public.channel_subscriber_count(uuid),
  public.create_chat(uuid[], text),
  public.create_saved_chat(),
  public.create_secret_chat(uuid, integer),
  public.create_channel(text, text, text, boolean, text),
  public.update_channel(uuid, text, text, text, boolean, text),
  public.update_group(uuid, text, text),
  public.subscribe_channel(uuid),
  public.leave_chat(uuid),
  public.add_chat_member(uuid, uuid),
  public.remove_chat_member(uuid, uuid),
  public.set_group_admin(uuid, uuid, boolean),
  public.create_invite(uuid, integer, integer),
  public.revoke_invite(uuid),
  public.redeem_invite(uuid),
  public.request_join(uuid),
  public.approve_join(uuid, uuid),
  public.reject_join(uuid, uuid),
  public.search_channels(text),
  public.search_users(text),
  public.get_chat_sidebar_meta(uuid[]),
  public.set_chat_ttl(uuid, integer),
  public.mark_notifications_read(),
  public.edit_message(uuid, text),
  public.delete_message_for_everyone(uuid),
  public.delete_message_for_me(uuid),
  public.set_message_pinned(uuid, boolean),
  public.start_luma_call(uuid, text),
  public.respond_luma_call(uuid, boolean),
  public.leave_luma_call(uuid),
  public.create_luma_poll(uuid, text, text[]),
  public.vote_luma_poll(uuid, uuid),
  public.publish_prekey_bundle(text, text, integer, text, text, jsonb),
  public.claim_prekey_bundle(uuid),
  public.count_one_time_prekeys(),
  public.handle_new_user(),
  public.handle_profile_delete(),
  public.profiles_privacy_guard(),
  public.check_rate_limit(text, integer, integer),
  public.message_reports_guardian(),
  public.messages_guardian(),
  public.protect_participant_role(),
  public.notify_mentions(),
  public.cleanup_expired_messages(),
  public.cleanup_luma_calls()
from public, anon, authenticated;

grant usage on schema public to authenticated;

grant select, insert (id, display_name, avatar_path, username, bio, show_last_seen, last_seen_at),
  update (display_name, avatar_path, username, bio, show_last_seen, last_seen_at)
  on public.profiles to authenticated;

grant select on public.chats to authenticated;

grant select, update (last_read_at, last_seen_at, typing_until, muted_until, archived_at)
  on public.chat_participants to authenticated;

grant select, insert (id, chat_id, sender_id, body, reply_to, media_path, media_name, media_type, media_waveform, media_duration, expires_at, mentions)
  on public.messages to authenticated;

grant select, insert (message_id, user_id, emoji), delete
  on public.message_reactions to authenticated;

grant select, insert (user_id, message_id), delete
  on public.starred_messages to authenticated;

grant select, update (revoked_at)
  on public.chat_invites to authenticated;

grant select on public.join_requests to authenticated;

grant select, insert (blocker, blocked), delete
  on public.blocks to authenticated;

grant select, insert (chat_id, message_id, reporter, reason, details)
  on public.message_reports to authenticated;

grant select, update (read_at), delete
  on public.notifications to authenticated;

grant select, insert (user_id, endpoint, p256dh, auth), update (p256dh, auth), delete
  on public.push_subscriptions to authenticated;

grant select on public.calls, public.call_participants, public.polls, public.poll_options, public.poll_votes
  to authenticated;

grant select, insert (id, call_id, from_user, to_user, kind, payload), delete
  on public.call_signals to authenticated;

grant select, insert (user_id, public_key), update (public_key)
  on public.user_public_keys to authenticated;

grant select on public.user_prekey_bundles, public.user_one_time_prekeys
  to authenticated;

grant execute on function
  public.is_chat_member(uuid),
  public.is_chat_admin(uuid),
  public.is_channel(uuid),
  public.shares_chat_with(uuid),
  public.channel_subscriber_count(uuid),
  public.create_chat(uuid[], text),
  public.create_saved_chat(),
  public.create_secret_chat(uuid, integer),
  public.create_channel(text, text, text, boolean, text),
  public.update_channel(uuid, text, text, text, boolean, text),
  public.update_group(uuid, text, text),
  public.subscribe_channel(uuid),
  public.leave_chat(uuid),
  public.add_chat_member(uuid, uuid),
  public.remove_chat_member(uuid, uuid),
  public.set_group_admin(uuid, uuid, boolean),
  public.create_invite(uuid, integer, integer),
  public.revoke_invite(uuid),
  public.redeem_invite(uuid),
  public.request_join(uuid),
  public.approve_join(uuid, uuid),
  public.reject_join(uuid, uuid),
  public.search_channels(text),
  public.search_users(text),
  public.get_chat_sidebar_meta(uuid[]),
  public.set_chat_ttl(uuid, integer),
  public.mark_notifications_read(),
  public.edit_message(uuid, text),
  public.delete_message_for_everyone(uuid),
  public.delete_message_for_me(uuid),
  public.set_message_pinned(uuid, boolean),
  public.start_luma_call(uuid, text),
  public.respond_luma_call(uuid, boolean),
  public.leave_luma_call(uuid),
  public.create_luma_poll(uuid, text, text[]),
  public.vote_luma_poll(uuid, uuid),
  public.publish_prekey_bundle(text, text, integer, text, text, jsonb),
  public.claim_prekey_bundle(uuid),
  public.count_one_time_prekeys()
to authenticated;

alter default privileges in schema public revoke all on tables from anon, public;
alter default privileges in schema public revoke all on functions from anon, public;
alter default privileges in schema public revoke all on sequences from anon, public;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

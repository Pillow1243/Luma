-- ============================================================
-- 7. RPC FUNCTIONS — saved messages, channels, invites, joins, lifecycle
-- ============================================================

-- Saved Messages: a private chat with yourself
create or replace function public.create_saved_chat()
returns uuid language plpgsql security definer set search_path to '' as $$
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
end $$;

-- Channels
create or replace function public.create_channel(
  channel_name text,
  channel_username text,
  channel_description text default '',
  channel_public boolean default true,
  avatar_path text default null
)
returns uuid language plpgsql security definer set search_path to '' as $$
declare cid uuid; uname public.citext;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if channel_name is null or length(trim(channel_name)) = 0 then
    raise exception 'Channel name required';
  end if;
  uname := lower(trim(channel_username))::public.citext;
  if uname is null or uname::text !~ '^[a-z0-9_]{3,32}$' then
    raise exception 'Username must be 3–32 chars: lowercase letters, digits, underscores';
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
end $$;

create or replace function public.update_channel(
  cid uuid, new_name text default null, new_description text default null,
  new_username text default null, new_public boolean default null
)
returns public.chats language plpgsql security definer set search_path to '' as $$
declare c public.chats; uname public.citext := null;
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
  if new_name is not null and length(trim(new_name)) = 0 then raise exception 'Channel name cannot be empty'; end if;
  update public.chats set
    name = case when new_name is null then c.name else left(trim(new_name), 80) end,
    description = case when new_description is null then c.description else left(new_description, 280) end,
    username = coalesce(uname, c.username),
    is_public = coalesce(new_public, c.is_public)
  where id = cid returning * into c;
  return c;
end $$;

-- Subscribe to a public channel (or to a private one you were invited to via link)
create or replace function public.subscribe_channel(cid uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid and kind = 'channel';
  if not found then raise exception 'Channel not found'; end if;
  if not c.is_public then raise exception 'This channel is private — ask an admin for an invite link'; end if;
  insert into public.chat_participants (chat_id, user_id, is_admin)
    values (cid, auth.uid(), false) on conflict do nothing;
end $$;

-- Leave any chat; ownership auto-transfers to the longest-serving admin, else oldest member.
-- Leaving as the last member deletes the chat.
create or replace function public.leave_chat(cid uuid)
returns void language plpgsql security definer set search_path to '' as $$
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
    delete from public.chats where id = cid;  -- empty chat: remove it
    return;
  end if;
  if c.created_by = auth.uid() then
    select user_id into successor from public.chat_participants
      where chat_id = cid order by is_admin desc, last_read_at desc limit 1;
    update public.chats set created_by = successor where id = cid;
  end if;
end $$;

-- Invite links
create or replace function public.create_invite(cid uuid, ttl_seconds integer default 86400, max_uses integer default 50)
returns public.chat_invites language plpgsql security definer set search_path to '' as $$
declare c public.chats; inv public.chat_invites;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind = 'saved' then raise exception 'Saved Messages cannot have invite links'; end if;
  if not public.is_chat_admin(cid) and c.created_by <> auth.uid() then
    raise exception 'Only admins can create invite links';
  end if;
  insert into public.chat_invites (chat_id, created_by, expires_at, max_uses)
    values (cid, auth.uid(),
            case when ttl_seconds is null or ttl_seconds <= 0 then null else now() + make_interval(secs => least(ttl_seconds, 2592000)) end,
            greatest(1, least(coalesce(max_uses, 50), 10000)))
    returning * into inv;
  return inv;
end $$;

create or replace function public.revoke_invite(invite_token uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare inv public.chat_invites;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into inv from public.chat_invites where token = invite_token;
  if not found then raise exception 'Invite not found'; end if;
  if not public.is_chat_admin(inv.chat_id) then raise exception 'Only admins can revoke invites'; end if;
  update public.chat_invites set revoked_at = now() where token = invite_token;
end $$;

-- Redeem an invite (atomic: checks expiry/uses/revocation and races safely)
create or replace function public.redeem_invite(invite_token uuid)
returns uuid language plpgsql security definer set search_path to '' as $$
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
end $$;

-- Join requests (approval-based)
create or replace function public.request_join(cid uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind not in ('group','channel') then raise exception 'Join requests are only for groups and channels'; end if;
  if c.kind = 'channel' and c.is_public then
    insert into public.chat_participants (chat_id, user_id, is_admin) values (cid, auth.uid(), false) on conflict do nothing;
    return;
  end if;
  if exists (select 1 from public.chat_participants where chat_id = cid and user_id = auth.uid()) then
    return;  -- already a member
  end if;
  insert into public.join_requests (chat_id, user_id) values (cid, auth.uid()) on conflict do nothing;
end $$;

create or replace function public.approve_join(request_chat uuid, request_user uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(request_chat) then raise exception 'Only admins can approve requests'; end if;
  delete from public.join_requests where chat_id = request_chat and user_id = request_user returning chat_id into request_chat;
  insert into public.chat_participants (chat_id, user_id, is_admin) values (request_chat, request_user, false) on conflict do nothing;
  insert into public.notifications (user_id, chat_id, actor_id, kind, body)
    values (request_user, request_chat, auth.uid(), 'join_approved', 'Your join request was approved');
end $$;

create or replace function public.reject_join(request_chat uuid, request_user uuid)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.is_chat_admin(request_chat) then raise exception 'Only admins can reject requests'; end if;
  delete from public.join_requests where chat_id = request_chat and user_id = request_user;
  insert into public.notifications (user_id, chat_id, actor_id, kind, body)
    values (request_user, request_chat, auth.uid(), 'join_rejected', 'Your join request was declined');
end $$;

-- Channel discovery
create or replace function public.search_channels(term text)
returns table (id uuid, name text, username public.citext, description text, is_public boolean, avatar_path text, subscribers integer, is_member boolean)
language sql stable security definer set search_path to '' as $$
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
$$;

-- Add member: allow channels too (was groups-only), keep 100 cap + admin gate
create or replace function public.add_chat_member(cid uuid, new_member uuid)
returns void language plpgsql security definer set search_path to '' as $$
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
end $$;

-- Disappearing messages: set or clear a chat's default TTL (seconds; 0 clears)
create or replace function public.set_chat_ttl(cid uuid, ttl_seconds integer)
returns void language plpgsql security definer set search_path to '' as $$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind = 'group' or c.kind = 'channel' then
    if not public.is_chat_admin(cid) then raise exception 'Only admins can change disappearing messages'; end if;
  else
    if not public.is_chat_member(cid) then raise exception 'Not a member'; end if;
  end if;
  if ttl_seconds is null or ttl_seconds <= 0 then
    update public.chats set ttl_seconds = null where id = cid;
  else
    update public.chats set ttl_seconds = least(ttl_seconds, 604800) where id = cid;
  end if;
end $$;

-- Mark all notifications read
create or replace function public.mark_notifications_read()
returns void language sql security definer set search_path to '' as $$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null
$$;

-- ============================================================
-- 8. INDEXES + REALTIME
-- ============================================================
create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists messages_pinned_idx2 on public.messages (chat_id) where pinned_at is not null;
create index if not exists chat_participants_user_idx on public.chat_participants (user_id);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; end $$;

-- ============================================================
-- 4. MESSAGE GUARDIAN — server-side enforcement on every INSERT
-- ============================================================

create or replace function public.messages_guardian()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if new.sender_id <> auth.uid() then raise exception 'Cannot send as another user'; end if;

  select * into c from public.chats where id = new.chat_id;
  if not found then raise exception 'Chat not found'; end if;

  -- disappearing messages: inherit the chat default TTL
  if new.expires_at is null and c.ttl_seconds is not null then
    new.expires_at := now() + make_interval(secs => c.ttl_seconds);
  end if;

  -- server-controlled columns can never be set by the client on insert
  new.pinned_at := null;
  new.deleted_at := null;
  new.edited_at := null;
  new.deleted_for := '{}';

  -- channels: only admins/owner may post
  if c.kind = 'channel' and not public.is_chat_admin(new.chat_id) then
    raise exception 'Only channel admins can post';
  end if;

  -- blocks: a peer in a direct chat who blocked the sender must not receive anything
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
end $$;

drop trigger if exists messages_guardian on public.messages;
create trigger messages_guardian before insert on public.messages
  for each row execute function public.messages_guardian();

-- participant role protection: is_admin can only change through SECURITY DEFINER RPCs
create or replace function public.protect_participant_role()
returns trigger language plpgsql set search_path to '' as $$
begin
  if current_user = 'authenticated' and new.is_admin is distinct from old.is_admin then
    raise exception 'Group roles can only be changed by group admins';
  end if;
  return new;
end $$;

drop trigger if exists protect_participant_role on public.chat_participants;
create trigger protect_participant_role before update on public.chat_participants
  for each row execute function public.protect_participant_role();

-- ============================================================
-- 5. MENTION NOTIFICATIONS
-- ============================================================

create or replace function public.notify_mentions()
returns trigger language plpgsql security definer set search_path to '' as $$
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
end $$;

drop trigger if exists notify_mentions on public.messages;
create trigger notify_mentions after insert on public.messages
  for each row execute function public.notify_mentions();

-- ============================================================
-- 6. RLS POLICIES (new + fixed)
-- ============================================================

-- messages_read: anonymous role had access in the original policy — tighten to authenticated
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (is_chat_member(chat_id)
         and not (auth.uid() = any (deleted_for))
         and (expires_at is null or expires_at > now()));

-- messages_send: FIX the broken reply check (m.id = m.reply_to could never match)
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

-- public channels are discoverable by any signed-in user (metadata only)
drop policy if exists chats_read on public.chats;
create policy chats_read on public.chats for select to authenticated
  using (public.is_chat_member(id)
         or (kind = 'channel' and is_public));

-- avatars: only yourself and people you share a chat with
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

-- channel avatars live in the chat_media bucket under <chat_id>/... paths,
-- covered by the existing membership policy + public read for discovery of
-- public channels: allow public channel avatar reads
drop policy if exists channel_avatar_read on storage.objects;
create policy channel_avatar_read on storage.objects for select to authenticated
  using (
    bucket_id = 'chat_media'
    and case when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then exists (select 1 from public.chats c
        where c.id = ((storage.foldername(name))[1])::uuid
          and c.kind = 'channel' and c.is_public)
      else false end
  );

alter table public.starred_messages enable row level security;
alter table public.chat_invites enable row level security;
alter table public.join_requests enable row level security;
alter table public.blocks enable row level security;
alter table public.message_reports enable row level security;
alter table public.notifications enable row level security;

drop policy if exists starred_own on public.starred_messages;
create policy starred_own on public.starred_messages for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications for select to authenticated
  using (user_id = auth.uid());
drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists blocks_own on public.blocks;
create policy blocks_own on public.blocks for all to authenticated
  using (blocker = auth.uid()) with check (blocker = auth.uid());

drop policy if exists reports_insert_own on public.message_reports;
create policy reports_insert_own on public.message_reports for insert to authenticated
  with check (reporter = auth.uid() and public.is_chat_member(chat_id));
drop policy if exists reports_read_own_or_admin on public.message_reports;
create policy reports_read_own_or_admin on public.message_reports for select to authenticated
  using (reporter = auth.uid() or public.is_chat_admin(chat_id));

drop policy if exists invites_admin_read on public.chat_invites;
create policy invites_admin_read on public.chat_invites for select to authenticated
  using (public.is_chat_admin(chat_id));
drop policy if exists invites_admin_revoke on public.chat_invites;
create policy invites_admin_revoke on public.chat_invites for update to authenticated
  using (public.is_chat_admin(chat_id)) with check (public.is_chat_admin(chat_id));

drop policy if exists join_requests_read on public.join_requests;
create policy join_requests_read on public.join_requests for select to authenticated
  using (user_id = auth.uid() or public.is_chat_admin(chat_id));

-- push_subscriptions: authenticated only (was \`public\`)
drop policy if exists push_select_own on public.push_subscriptions;
drop policy if exists push_insert_own on public.push_subscriptions;
drop policy if exists push_delete_own on public.push_subscriptions;
drop policy if exists push_select_own on public.push_subscriptions;
create policy push_select_own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists push_insert_own on public.push_subscriptions;
create policy push_insert_own on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists push_delete_own on public.push_subscriptions;
create policy push_delete_own on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());


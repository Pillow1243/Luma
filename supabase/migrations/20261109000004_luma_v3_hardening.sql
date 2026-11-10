-- ============================================================
-- luma_v3_hardening — fixes found by the live RLS authorization suite
-- ============================================================

-- 1. cleanup_expired_messages ran with auth.uid() = NULL under cron, so
--    is_chat_member() was always false and nothing was ever deleted.
create or replace function public.cleanup_expired_messages()
returns integer
language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  delete from public.messages
  where expires_at is not null and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- 2. starred_messages: membership was never checked — a user who could not
--    read a message could still star its id (existence oracle).
drop policy if exists starred_own on public.starred_messages;
create policy starred_own on public.starred_messages for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_chat_member(m.chat_id)));

-- 3. delete_message_for_everyone allowed any group admin but no channel
--    admin — extend moderation to channels.
create or replace function public.delete_message_for_everyone(msg_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
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
end $$;

-- 4. set_message_pinned only restricted groups; channel subscribers could
--    pin arbitrary broadcast posts. Channels require admin, same as groups.
create or replace function public.set_message_pinned(msg_id uuid, pin boolean)
returns void language plpgsql security definer set search_path to '' as $$
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
end $$;

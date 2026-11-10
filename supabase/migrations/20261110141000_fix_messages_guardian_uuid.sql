-- forwarded_from is uuid, not text: restore clean messages_guardian without btrim(uuid)
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

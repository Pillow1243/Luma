-- 1. Allow authenticated senders to set forwarded_from when sending messages
grant insert (forwarded_from) on public.messages to authenticated;

-- 2. Add missing UPDATE RLS policy + column privileges on push_subscriptions
grant update (user_id, endpoint, p256dh, auth) on public.push_subscriptions to authenticated;

drop policy if exists push_update_own on public.push_subscriptions;
create policy push_update_own on public.push_subscriptions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 3. Atomic Web Push registration RPC (handles shared-browser endpoint handoff cleanly)
create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
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

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth;
end
$$;

revoke all on function public.register_push_subscription(text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text) to authenticated;

-- 4. Guard forwarded_from length in messages_guardian while preserving existing checks
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

  if new.forwarded_from is not null then
    new.forwarded_from := left(btrim(new.forwarded_from), 80);
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

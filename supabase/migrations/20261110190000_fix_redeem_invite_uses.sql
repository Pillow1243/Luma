-- ============================================================================
-- Luma — redeem_invite: don't burn uses when nothing was granted
-- ============================================================================
-- `redeem_invite` incremented `chat_invites.uses` *before* checking whether the
-- caller could actually join, and it counted a redemption even when the caller
-- was already a member:
--
--   * a member clicking their own group's invite link (the common case: the
--     link is in the chat description, and people re-open it) burned a use of
--     a max_uses=1 invite without adding anybody;
--   * retrying after a network error, or reloading the page mid-join, burned
--     another use.
--
-- (An attempt that *fails* — expired link, full chat — does not burn a use even
-- in the old code: the raised exception rolls back that request's transaction,
-- including the increment. Only a successful call that granted nothing is the
-- leak, which is the case above.)
--
-- A link that reaches its limit therefore stopped working for the people it was
-- created for, and an admin cannot tell why. The fix is to decide first and
-- count only an actual grant:
--
--   1. already a participant  -> return the chat id, no use consumed (idempotent)
--   2. otherwise              -> reserve a use atomically, then insert
--
-- The reservation stays a single `update … where uses < max_uses returning`,
-- so two simultaneous redemptions can never exceed the limit.
--
-- Also adds the same per-user rate limit other join paths have, so a valid
-- token cannot be used to enumerate/abuse the participant table.
-- ============================================================================

create or replace function public.redeem_invite(invite_token uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  inv public.chat_invites;
  c public.chats;
  n int;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into inv from public.chat_invites where token = invite_token;
  if not found then raise exception 'Invite link not found'; end if;

  -- Idempotent for people who are already in the chat: re-opening a link (or
  -- retrying after a timeout) must not consume the admin's budget.
  if exists (
    select 1 from public.chat_participants
    where chat_id = inv.chat_id and user_id = auth.uid()
  ) then
    return inv.chat_id;
  end if;

  if inv.revoked_at is not null
     or (inv.expires_at is not null and inv.expires_at <= now())
     or inv.uses >= inv.max_uses then
    raise exception 'This invite link has expired or reached its limit';
  end if;

  select * into c from public.chats where id = inv.chat_id;
  if not found then raise exception 'Chat no longer exists'; end if;

  if c.kind in ('group', 'channel') then
    select count(*) into n from public.chat_participants where chat_id = c.id;
    if n >= 100 then raise exception 'This chat is full (100 members)'; end if;
  end if;

  perform public.check_rate_limit('redeem_invite', 3600, 30);

  -- Reserve the use atomically; the predicate makes concurrent redemptions of
  -- the last use safe.
  update public.chat_invites
     set uses = uses + 1
   where token = invite_token
     and revoked_at is null
     and (expires_at is null or expires_at > now())
     and uses < max_uses
  returning * into inv;
  if not found then
    raise exception 'This invite link has expired or reached its limit';
  end if;

  insert into public.chat_participants (chat_id, user_id, is_admin)
  values (c.id, auth.uid(), false)
  on conflict do nothing;

  return c.id;
end
$function$;

revoke all on function public.redeem_invite(uuid) from public, anon;
grant execute on function public.redeem_invite(uuid) to authenticated;

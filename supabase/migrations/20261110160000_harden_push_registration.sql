-- ============================================================================
-- Luma — harden push subscription registration (P0: cross-account takeover)
-- ============================================================================
-- Before this migration `register_push_subscription` ended with
--
--     on conflict (endpoint) do update
--       set user_id = excluded.user_id, p256dh = ..., auth = ...;
--
-- Because the endpoint is the conflict key, *any* authenticated user who knows
-- (or guesses from a shared device / leaked browser profile / HTTP log) another
-- user's Web Push endpoint could re-point that subscription at themselves,
-- which both silences the victim's notifications and hands the attacker the
-- victim's delivery channel. tests/db/security.mjs reproduces this as
-- "Cannot hijack another user's push endpoint".
--
-- The fix keeps upgrades working but never moves a row between users: an
-- endpoint that already belongs to somebody else is left untouched, and the
-- caller is told so instead of silently stealing it. A user re-registering
-- their *own* endpoint still rotates keys. Device hand-over is handled by the
-- client, which deletes the previous account's subscription on sign-out before
-- the new account registers.
-- ============================================================================

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  owner uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_endpoint, '')) < 16 or p_endpoint !~ '^https://' then
    raise exception 'Invalid push endpoint';
  end if;
  if length(coalesce(p_p256dh, '')) < 16 or length(coalesce(p_auth, '')) < 8 then
    raise exception 'Invalid push keys';
  end if;
  if length(p_endpoint) > 2000 or length(p_p256dh) > 400 or length(p_auth) > 400 then
    raise exception 'Invalid push subscription';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh,
        auth = excluded.auth
    where public.push_subscriptions.user_id = excluded.user_id;

  -- The row survived untouched: the endpoint is registered to another account.
  select user_id into owner
  from public.push_subscriptions
  where endpoint = p_endpoint;

  if owner is distinct from uid then
    raise exception 'This push endpoint belongs to another account'
      using errcode = '42501';
  end if;
end
$function$;

revoke all on function public.register_push_subscription(text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text) to authenticated;

-- Old subscriptions whose owner deleted their profile are removed by the
-- profiles cascade; endpoints that were never refreshed for 90 days are dead
-- (Web Push endpoints expire server side). Keep the table small so fan-out
-- stays cheap.
comment on function public.register_push_subscription(text, text, text) is
  'Binds a Web Push endpoint to the caller. Refuses to move an endpoint that is already registered to a different account.';

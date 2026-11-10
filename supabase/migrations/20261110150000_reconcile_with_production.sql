-- ============================================================================
-- Luma — reconcile repository migrations with the deployed production schema
-- Applied to production: NO (it describes production, see note below)
-- ============================================================================
-- WHY THIS FILE EXISTS
--
-- Capturing supabase/baseline/01_production_schema.sql and replaying the whole
-- repository on an empty PostgreSQL (tests/db/migrate.mjs) exposed real drift:
--
--   1. `create_luma_poll(uuid,text,text[],boolean,boolean,integer)` only exists
--      in production. The migration that introduced it was never committed
--      (production history has `luma_poll_upgrades` at 20261110121234, the repo
--      file of that name recreates 4-arg-less versions of the *other* poll
--      functions instead). Running the repo's own migration set produced the
--      wrong poll API, which the client (src/components/Poll.tsx) calls with
--      6 arguments.
--   2. Several functions were edited on production outside any migration, so a
--      fresh install silently got older definitions, for example:
--        * user_public_keys was written as `text` from publish_prekey_bundle
--          although the column is `jsonb` (P0: secret-chat key publication
--          broke on a fresh database);
--        * set_group_admin / remove_chat_member / leave_chat /
--          handle_profile_delete ownership-transfer logic differed.
--   3. poll_vote_counts lost its `select` grant for `authenticated` after the
--      blanket `revoke all on all tables` in 20261110120000 and never got it
--      back, so a fresh install could not read the aggregate table the poll UI
--      subscribes to.
--   4. 20261109000000_* files shared one timestamp (three files) — harmless on
--      Supabase, which hashes version+name, but ambiguous when replaying
--      locally; they are now applied as a group in filename order.
--
-- This migration is *idempotent and forward-only*. On production every
-- statement is a semantic no-op (the objects already match); on a fresh or
-- partial database it converges to the same state. It must therefore stay in
-- sync with supabase/baseline/01_production_schema.sql — that equivalence is
-- asserted by `npm run test:db`.
-- ============================================================================

alter table public.poll_vote_counts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'poll_vote_counts'
      and policyname = 'poll_vote_counts_read'
  ) then
    create policy poll_vote_counts_read on public.poll_vote_counts
      for select to authenticated
      using (
        exists (
          select 1 from public.polls p
          where p.id = poll_vote_counts.poll_id and public.is_chat_member(p.chat_id)
        )
      );
  end if;
end $$;

revoke all on public.poll_vote_counts from anon, public;
grant select on public.poll_vote_counts to authenticated;

-- The 6-argument poll API the client uses. If an older 3-argument overload is
-- still present, migrate its grants and drop it so RPC resolution is
-- unambiguous (PostgREST picks by argument names, but leaving both invites
-- silent divergence for other clients).
-- NOTE: this file defines the rich signature last so that replaying it after
-- the historical migrations always wins.

create or replace function public.cleanup_expired_messages()
returns integer language plpgsql security definer set search_path to '' as $function$
declare n integer;
begin
  delete from public.messages
  where expires_at is not null and expires_at <= now();
  get diagnostics n = row_count;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return n;
end $function$;

create or replace function public.cleanup_luma_calls()
returns void language plpgsql security definer set search_path to '' as $function$ begin update public.calls set status = 'ended', ended_at = now() where status <> 'ended' and ((answered_at is null and created_at < now() - interval '2 minutes') or created_at < now() - interval '6 hours'); update public.call_participants p set status = 'missed', left_at = now() from public.calls c where p.call_id = c.id and c.status = 'ended' and p.status = 'ringing'; delete from public.call_signals where created_at < now() - interval '1 hour' or call_id in (select id from public.calls where status = 'ended'); end $function$;

create or replace function public.create_channel(
  channel_name text,
  channel_username text,
  channel_description text default '',
  channel_public boolean default true,
  avatar_path text default null
)
returns uuid language plpgsql security definer set search_path to '' as $function$
declare cid uuid; uname public.citext;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if channel_name is null or length(trim(channel_name)) = 0 then
    raise exception 'Channel name required';
  end if;
  uname := lower(trim(channel_username))::public.citext;
  if uname is null or uname::text !~ '^[a-z0-9_]{3,32}$' then
    raise exception 'Username must be 3-32 chars: lowercase letters, digits, underscores';
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
end $function$;

create or replace function public.create_luma_poll(
  cid uuid,
  poll_question text,
  poll_options text[]
)
returns uuid language plpgsql security definer set search_path to '' as $function$
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
$function$;

create or replace function public.handle_profile_delete()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  c record;
  successor uuid;
begin
  for c in select id from public.chats where created_by = old.id loop
    select cp.user_id into successor
    from public.chat_participants cp
    join public.profiles p on p.id = cp.user_id
    where cp.chat_id = c.id and cp.user_id <> old.id
    order by cp.is_admin desc, cp.last_read_at desc
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
$function$;

create or replace function public.leave_chat(cid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
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
    delete from public.chats where id = cid;
    return;
  end if;
  if c.created_by = auth.uid() then
    select user_id into successor from public.chat_participants
      where chat_id = cid order by is_admin desc, last_read_at desc limit 1;
    update public.chats set created_by = successor where id = cid;
  end if;
end $function$;

create or replace function public.leave_luma_call(call_uuid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.calls; joined_count integer; ringing_count integer;
begin
 select * into c from public.calls where id = call_uuid for update;
 if not found or not public.is_chat_member(c.chat_id) then raise exception 'Call unavailable'; end if;
 update public.call_participants set status = case when status = 'ringing' then 'declined' else 'left' end, left_at = now() where call_id = call_uuid and user_id = auth.uid() and status in ('joined', 'ringing');
 select count(*) filter(where status = 'joined'), count(*) filter(where status = 'ringing') into joined_count, ringing_count from public.call_participants where call_id = call_uuid;
 if joined_count = 0 or (joined_count <= 1 and (ringing_count = 0 or c.answered_at is not null)) then
  update public.calls set status = 'ended', ended_at = coalesce(ended_at, now()) where id = call_uuid;
  update public.call_participants set status = 'missed', left_at = now() where call_id = call_uuid and status = 'ringing';
  delete from public.call_signals where call_id = call_uuid;
 end if;
end $function$;

create or replace function public.publish_prekey_bundle(
  p_identity_key text,
  p_signing_key text,
  p_signed_prekey_id integer,
  p_signed_prekey text,
  p_signed_prekey_sig text,
  p_one_time_keys jsonb default '[]'::jsonb
)
returns integer language plpgsql security definer set search_path to '' as $function$
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
$function$;

create or replace function public.remove_chat_member(cid uuid, target uuid)
returns void language plpgsql security definer set search_path to '' as $function$
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
end $function$;

create or replace function public.request_join(cid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
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
end $function$;

create or replace function public.respond_luma_call(call_uuid uuid, accept_call boolean)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.calls; joined_count integer; ringing_count integer;
begin
 select * into c from public.calls where id = call_uuid for update;
 if not found or not public.is_chat_member(c.chat_id) then raise exception 'Call unavailable'; end if;
 if c.status = 'ended' or c.created_at < now() - interval '2 minutes' and c.answered_at is null then raise exception 'Call has ended'; end if;
 update public.call_participants set status = case when accept_call then 'joined' else 'declined' end, joined_at = case when accept_call then now() else null end, left_at = case when accept_call then null else now() end where call_id = call_uuid and user_id = auth.uid() and status = 'ringing';
 if not found then raise exception 'Call invitation is no longer available'; end if;
 if accept_call then update public.calls set status = 'active', answered_at = coalesce(answered_at, now()) where id = call_uuid;
 else
  select count(*) filter(where status = 'joined'), count(*) filter(where status = 'ringing') into joined_count, ringing_count from public.call_participants where call_id = call_uuid;
  if joined_count <= 1 and ringing_count = 0 then update public.calls set status = 'ended', ended_at = now() where id = call_uuid; end if;
 end if;
end $function$;

create or replace function public.set_group_admin(cid uuid, target uuid, make_admin boolean)
returns void language plpgsql security definer set search_path to '' as $function$
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
end $function$;

create or replace function public.subscribe_channel(cid uuid)
returns void language plpgsql security definer set search_path to '' as $function$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid and kind = 'channel';
  if not found then raise exception 'Channel not found'; end if;
  if not c.is_public then raise exception 'This channel is private - ask an admin for an invite link'; end if;
  insert into public.chat_participants (chat_id, user_id, is_admin)
    values (cid, auth.uid(), false) on conflict do nothing;
end $function$;


-- create_luma_poll is intentionally redefined here with the rich signature so
-- that replaying the historical migrations can never leave the older API in
-- place. Semantically identical to production's definition.
create or replace function public.create_luma_poll(
  cid uuid,
  poll_question text,
  poll_options text[],
  p_allow_multiple boolean default false,
  p_anonymous boolean default false,
  p_closes_in_seconds integer default null
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
  if p_closes_in_seconds is not null and p_closes_in_seconds <= 0 then
    raise exception 'Poll closing time must be in the future';
  end if;

  insert into public.messages(chat_id, sender_id, body)
  values (cid, auth.uid(), '📊 Poll: ' || trim(poll_question))
  returning id into mid;

  insert into public.polls(message_id, chat_id, created_by, question, allow_multiple, anonymous, closes_at)
  values (
    mid, cid, auth.uid(), trim(poll_question),
    coalesce(p_allow_multiple, false),
    coalesce(p_anonymous, false),
    case when p_closes_in_seconds is null then null
         else now() + make_interval(secs => least(p_closes_in_seconds, 2592000)) end
  )
  returning id into pid;

  foreach opt in array poll_options loop
    insert into public.poll_options(poll_id, label, position)
    values (pid, trim(opt), i);
    i := i + 1;
  end loop;

  -- Seed zero-count aggregate rows so the first vote on each option performs an
  -- UPDATE (not an INSERT) on poll_vote_counts. RLS on that table grants SELECT
  -- only, so any client-side read-modify-write of the aggregate would fail.
  insert into public.poll_vote_counts (poll_id, option_id, votes, updated_at)
  select po.poll_id, po.id, 0, now()
  from public.poll_options po
  where po.poll_id = pid;

  return mid;
end
$$;

-- Drop the legacy 3-argument overload if the historical migrations created it.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_luma_poll'
      and pg_get_function_identity_arguments(p.oid) = 'cid uuid, poll_question text, poll_options text[]'
  ) then
    grant execute on function public.create_luma_poll(uuid, text, text[]) to authenticated;
    drop function public.create_luma_poll(uuid, text, text[]);
  end if;
end $$;

-- Normalize EXECUTE privileges for every function this file (re)defines, so
-- that the end state does not depend on which historical migration created the
-- function first. `create or replace function` preserves an existing ACL but a
-- *newly created* function falls back to PostgreSQL's default of EXECUTE to
-- PUBLIC, which would leave a fresh install with anon-executable RPCs.
revoke all on function
  public.create_luma_poll(uuid, text, text[], boolean, boolean, integer),
  public.vote_luma_poll(uuid, uuid),
  public.get_poll_results(uuid),
  public.sync_poll_vote_counts(),
  public.subscribe_channel(uuid),
  public.request_join(uuid),
  public.respond_luma_call(uuid, boolean),
  public.leave_luma_call(uuid),
  public.set_group_admin(uuid, uuid, boolean),
  public.remove_chat_member(uuid, uuid),
  public.leave_chat(uuid),
  public.create_channel(text, text, text, boolean, text),
  public.publish_prekey_bundle(text, text, integer, text, text, jsonb),
  public.cleanup_luma_calls()
from public, anon;

-- The blanket revoke above also removed service_role's EXECUTE; restore it so
-- the service role keeps the footgun-free equivalent of "all functions".
grant execute on function
  public.create_luma_poll(uuid, text, text[], boolean, boolean, integer),
  public.vote_luma_poll(uuid, uuid),
  public.get_poll_results(uuid),
  public.sync_poll_vote_counts(),
  public.subscribe_channel(uuid),
  public.request_join(uuid),
  public.respond_luma_call(uuid, boolean),
  public.leave_luma_call(uuid),
  public.set_group_admin(uuid, uuid, boolean),
  public.remove_chat_member(uuid, uuid),
  public.leave_chat(uuid),
  public.create_channel(text, text, text, boolean, text),
  public.publish_prekey_bundle(text, text, integer, text, text, jsonb),
  public.cleanup_luma_calls()
to service_role;

grant execute on function
  public.create_luma_poll(uuid, text, text[], boolean, boolean, integer),
  public.vote_luma_poll(uuid, uuid),
  public.get_poll_results(uuid),
  public.subscribe_channel(uuid),
  public.request_join(uuid),
  public.respond_luma_call(uuid, boolean),
  public.leave_luma_call(uuid),
  public.set_group_admin(uuid, uuid, boolean),
  public.remove_chat_member(uuid, uuid),
  public.leave_chat(uuid),
  public.create_channel(text, text, text, boolean, text),
  public.publish_prekey_bundle(text, text, integer, text, text, jsonb)
to authenticated;

-- Trigger functions are never called through PostgREST; leaving them
-- executable by PUBLIC is unnecessary surface (an anon-callable
-- sync_poll_vote_counts() was still reachable on production).
revoke all on function public.sync_poll_vote_counts() from public, anon, authenticated;
revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

revoke all on function
  public.cleanup_expired_messages(),
  public.cleanup_luma_calls(),
  public.handle_profile_delete(),
  public.messages_guardian(),
  public.message_reports_guardian(),
  public.notify_mentions(),
  public.protect_participant_role(),
  public.profiles_privacy_guard(),
  public.check_rate_limit(text, integer, integer),
  public.sync_poll_vote_counts()
from public, anon, authenticated;

grant execute on function
  public.cleanup_expired_messages(),
  public.cleanup_luma_calls()
to service_role;

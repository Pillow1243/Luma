-- Additive upgrade: calls/signaling, opt-in device keys and chat polls.
-- All access is scoped to existing chat membership. Run after the v3 migrations.

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  started_by uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'active', 'ended')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index if not exists calls_chat_created_idx on public.calls(chat_id, created_at desc);

create table if not exists public.call_participants (
  call_id uuid not null references public.calls(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('ringing', 'joined', 'declined', 'left', 'missed')),
  joined_at timestamptz,
  left_at timestamptz,
  primary key (call_id, user_id)
);
create index if not exists call_participants_user_status_idx on public.call_participants(user_id, status);

create table if not exists public.call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('offer', 'answer', 'ice')),
  payload jsonb not null check (pg_column_size(payload) < 65536),
  created_at timestamptz not null default now(),
  check (from_user <> to_user)
);
create index if not exists call_signals_recipient_idx on public.call_signals(to_user, call_id, created_at);

alter table public.calls enable row level security;
alter table public.call_participants enable row level security;
alter table public.call_signals enable row level security;
revoke all on public.calls, public.call_participants, public.call_signals from anon, authenticated;
grant select on public.calls, public.call_participants to authenticated;
grant select, insert, delete on public.call_signals to authenticated;
create policy calls_read on public.calls for select to authenticated using (public.is_chat_member(chat_id));
create policy call_participants_read on public.call_participants for select to authenticated using (
  exists (select 1 from public.calls c where c.id = call_participants.call_id and public.is_chat_member(c.chat_id))
);
create policy call_signals_receive on public.call_signals for select to authenticated using (
  to_user = auth.uid() and exists (select 1 from public.calls c where c.id = call_signals.call_id and public.is_chat_member(c.chat_id))
);
create policy call_signals_send on public.call_signals for insert to authenticated with check (
  from_user = auth.uid() and exists (
    select 1 from public.calls c
    join public.call_participants sender on sender.call_id = c.id and sender.user_id = auth.uid() and sender.status = 'joined'
    join public.call_participants recipient on recipient.call_id = c.id and recipient.user_id = call_signals.to_user and recipient.status = 'joined'
    where c.id = call_signals.call_id and c.status <> 'ended' and public.is_chat_member(c.chat_id)
  )
);
create policy call_signals_delete_received on public.call_signals for delete to authenticated using (to_user = auth.uid());

create or replace function public.start_luma_call(cid uuid, call_kind text)
returns public.calls language plpgsql security definer set search_path = '' as $$
declare c public.chats; result public.calls; members integer;
begin
  if auth.uid() is null or not public.is_chat_member(cid) then raise exception 'Not a chat member'; end if;
  select * into c from public.chats where id = cid;
  if c.kind not in ('direct', 'group') then raise exception 'Calls are available in direct and group chats'; end if;
  if call_kind not in ('audio','video') then raise exception 'Invalid call type'; end if;
  select count(*) into members from public.chat_participants where chat_id = cid;
  if members < 2 or members > 6 then raise exception 'Calls support 2 to 6 chat members'; end if;
  if c.kind = 'direct' and exists (
    select 1 from public.blocks b join public.chat_participants p on p.chat_id = cid
    where (b.blocker = p.user_id and b.blocked = auth.uid()) or (b.blocker = auth.uid() and b.blocked = p.user_id)
  ) then raise exception 'This call cannot be placed'; end if;
  insert into public.calls(chat_id, started_by, kind) values(cid, auth.uid(), call_kind) returning * into result;
  insert into public.call_participants(call_id, user_id, status, joined_at)
    select result.id, user_id, case when user_id = auth.uid() then 'joined' else 'ringing' end,
      case when user_id = auth.uid() then now() else null end
    from public.chat_participants where chat_id = cid;
  return result;
end $$;

create or replace function public.respond_luma_call(call_uuid uuid, accept_call boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.calls; joined_count integer; ringing_count integer;
begin
  select * into c from public.calls where id = call_uuid for update;
  if not found or not public.is_chat_member(c.chat_id) then raise exception 'Call unavailable'; end if;
  if c.status = 'ended' or c.created_at < now() - interval '2 minutes' and c.answered_at is null then raise exception 'Call has ended'; end if;
  update public.call_participants set status = case when accept_call then 'joined' else 'declined' end,
    joined_at = case when accept_call then now() else null end,
    left_at = case when accept_call then null else now() end
    where call_id = call_uuid and user_id = auth.uid() and status = 'ringing';
  if not found then raise exception 'Call invitation is no longer available'; end if;
  if accept_call then
    update public.calls set status = 'active', answered_at = coalesce(answered_at, now()) where id = call_uuid;
  else
    select count(*) filter(where status = 'joined'), count(*) filter(where status = 'ringing') into joined_count, ringing_count
      from public.call_participants where call_id = call_uuid;
    if joined_count <= 1 and ringing_count = 0 then
      update public.calls set status = 'ended', ended_at = now() where id = call_uuid;
    end if;
  end if;
end $$;

create or replace function public.leave_luma_call(call_uuid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.calls; joined_count integer; ringing_count integer;
begin
  select * into c from public.calls where id = call_uuid for update;
  if not found or not public.is_chat_member(c.chat_id) then raise exception 'Call unavailable'; end if;
  update public.call_participants set status = case when status = 'ringing' then 'declined' else 'left' end, left_at = now()
    where call_id = call_uuid and user_id = auth.uid() and status in ('joined', 'ringing');
  select count(*) filter(where status = 'joined'), count(*) filter(where status = 'ringing') into joined_count, ringing_count
    from public.call_participants where call_id = call_uuid;
  if joined_count = 0 or (joined_count <= 1 and (ringing_count = 0 or c.answered_at is not null)) then
    update public.calls set status = 'ended', ended_at = coalesce(ended_at, now()) where id = call_uuid;
    update public.call_participants set status = 'missed', left_at = now() where call_id = call_uuid and status = 'ringing';
    delete from public.call_signals where call_id = call_uuid;
  end if;
end $$;
revoke all on function public.start_luma_call(uuid,text), public.respond_luma_call(uuid,boolean), public.leave_luma_call(uuid) from public, anon;
grant execute on function public.start_luma_call(uuid,text), public.respond_luma_call(uuid,boolean), public.leave_luma_call(uuid) to authenticated;

-- One long-term identity per user, generated and kept on one device. Only the
-- public key is published. Identity replacement is intentionally not automatic.
create table if not exists public.user_public_keys (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  public_key jsonb not null check (public_key->>'kty' = 'EC' and public_key->>'crv' = 'P-256' and pg_column_size(public_key) < 2048),
  created_at timestamptz not null default now()
);
alter table public.user_public_keys enable row level security;
revoke all on public.user_public_keys from anon, authenticated;
grant select, insert on public.user_public_keys to authenticated;
create policy public_keys_read on public.user_public_keys for select to authenticated
  using (user_id = auth.uid() or public.shares_chat_with(user_id));
create policy public_keys_insert_own on public.user_public_keys for insert to authenticated with check (user_id = auth.uid());

create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.messages(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 240),
  created_at timestamptz not null default now()
);
create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 100),
  position integer not null check (position between 0 and 9),
  unique (poll_id, position),
  unique (poll_id, id)
);
create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id),
  foreign key (poll_id, option_id) references public.poll_options(poll_id, id) on delete cascade
);
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
revoke all on public.polls, public.poll_options, public.poll_votes from anon, authenticated;
grant select on public.polls, public.poll_options, public.poll_votes to authenticated;
create policy polls_read on public.polls for select to authenticated using (public.is_chat_member(chat_id));
create policy poll_options_read on public.poll_options for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_options.poll_id and public.is_chat_member(p.chat_id))
);
create policy poll_votes_read on public.poll_votes for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_votes.poll_id and public.is_chat_member(p.chat_id))
);
create or replace function public.create_luma_poll(cid uuid, poll_question text, poll_options text[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare mid uuid; pid uuid; opt text; i integer := 0;
begin
  if auth.uid() is null or not public.is_chat_member(cid) then raise exception 'Not a chat member'; end if;
  if length(trim(poll_question)) not between 1 and 240 or coalesce(array_length(poll_options,1),0) not between 2 and 10 then raise exception 'A poll needs a question and 2–10 options'; end if;
  foreach opt in array poll_options loop
    if length(trim(opt)) not between 1 and 100 then raise exception 'Poll options must be 1–100 characters'; end if;
  end loop;
  insert into public.messages(chat_id, sender_id, body) values(cid, auth.uid(), '📊 Poll: ' || trim(poll_question)) returning id into mid;
  insert into public.polls(message_id, chat_id, created_by, question) values(mid, cid, auth.uid(), trim(poll_question)) returning id into pid;
  foreach opt in array poll_options loop
    insert into public.poll_options(poll_id, label, position) values(pid, trim(opt), i); i := i + 1;
  end loop;
  return mid;
end $$;
create or replace function public.vote_luma_poll(poll_uuid uuid, option_uuid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  select chat_id into cid from public.polls where id = poll_uuid;
  if cid is null or auth.uid() is null or not public.is_chat_member(cid) then raise exception 'Poll unavailable'; end if;
  if not exists(select 1 from public.poll_options where poll_id = poll_uuid and id = option_uuid) then raise exception 'Invalid option'; end if;
  insert into public.poll_votes(poll_id, option_id, user_id) values(poll_uuid, option_uuid, auth.uid())
    on conflict (poll_id, user_id) do update set option_id = excluded.option_id, created_at = now();
end $$;
revoke all on function public.create_luma_poll(uuid,text,text[]), public.vote_luma_poll(uuid,uuid) from public, anon;
grant execute on function public.create_luma_poll(uuid,text,text[]), public.vote_luma_poll(uuid,uuid) to authenticated;

do $$
declare tab text;
begin
  foreach tab in array array['calls','call_participants','call_signals','polls','poll_options','poll_votes'] loop
    if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = tab) then
      execute format('alter publication supabase_realtime add table public.%I', tab);
    end if;
  end loop;
end $$;

-- Crash/closed-tab safety and short-lived SDP/ICE retention. A live call is
-- capped at six hours in the absence of a server-side heartbeat.
create or replace function public.cleanup_luma_calls()
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.calls set status = 'ended', ended_at = now()
    where status <> 'ended' and ((answered_at is null and created_at < now() - interval '2 minutes')
      or created_at < now() - interval '6 hours');
  update public.call_participants p set status = 'missed', left_at = now()
    from public.calls c where p.call_id = c.id and c.status = 'ended' and p.status = 'ringing';
  delete from public.call_signals where created_at < now() - interval '1 hour'
    or call_id in (select id from public.calls where status = 'ended');
end $$;
revoke all on function public.cleanup_luma_calls() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('cleanup-luma-calls', '*/5 * * * *', 'select public.cleanup_luma_calls()');
  end if;
end $$;

-- Fix: anonymous poll realtime sync.
--
-- Root cause: the client subscribes to postgres_changes on `poll_votes`.
-- Supabase Realtime enforces each subscriber's own RLS before delivering a
-- change event. The `poll_votes_read` policy only lets a member see their
-- OWN vote row when the poll is anonymous, so other members never receive a
-- change event when someone else votes on an anonymous poll, and their UI
-- goes stale.
--
-- Fix: maintain an identity-free aggregate table `poll_vote_counts`
-- (poll_id, option_id, votes) via trigger, readable by ANY chat member
-- regardless of anonymity (it never exposes who voted for what), and have
-- the client subscribe to changes on that table instead. `get_poll_results()`
-- remains the single source of truth for the numbers actually rendered;
-- this table is purely a realtime "something changed, re-fetch" signal.

create table if not exists public.poll_vote_counts (
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  votes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (poll_id, option_id)
);

alter table public.poll_vote_counts enable row level security;

-- Any chat member can see aggregate counts, even for anonymous polls --
-- this table never carries voter identity.
drop policy if exists poll_vote_counts_read on public.poll_vote_counts;
create policy poll_vote_counts_read on public.poll_vote_counts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.polls p
      where p.id = poll_vote_counts.poll_id
        and public.is_chat_member(p.chat_id)
    )
  );

-- Only the trigger function (SECURITY DEFINER below) is allowed to write.
revoke insert, update, delete on public.poll_vote_counts from authenticated, anon, public;

create or replace function public.sync_poll_vote_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_poll_id uuid;
begin
  affected_poll_id := coalesce(new.poll_id, old.poll_id);

  insert into public.poll_vote_counts (poll_id, option_id, votes, updated_at)
  select
    po.poll_id,
    po.id,
    (select count(*) from public.poll_votes pv where pv.option_id = po.id),
    now()
  from public.poll_options po
  where po.poll_id = affected_poll_id
  on conflict (poll_id, option_id)
  do update set votes = excluded.votes, updated_at = excluded.updated_at;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_sync_poll_vote_counts on public.poll_votes;
create trigger trg_sync_poll_vote_counts
  after insert or update or delete on public.poll_votes
  for each row execute function public.sync_poll_vote_counts();

-- Backfill counts for existing polls/options from live poll_votes.
insert into public.poll_vote_counts (poll_id, option_id, votes, updated_at)
select
  po.poll_id,
  po.id,
  (select count(*) from public.poll_votes pv where pv.option_id = po.id),
  now()
from public.poll_options po
on conflict (poll_id, option_id)
do update set votes = excluded.votes, updated_at = excluded.updated_at;

-- Broadcast changes on the aggregate table via Realtime.
alter publication supabase_realtime add table public.poll_vote_counts;

-- Seed zero-count rows for newly created polls so the first real vote on an
-- option produces an UPDATE (not an INSERT) on poll_vote_counts, which keeps
-- client behavior predictable. This is the IDENTICAL signature and body as
-- public.create_luma_poll() from 20261110121234_luma_poll_upgrades.sql, with
-- only the final seeding insert added before the return.
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

  -- Seed zero-count aggregate rows so the first vote on each option causes
  -- an UPDATE (not an INSERT) on poll_vote_counts.
  insert into public.poll_vote_counts (poll_id, option_id, votes, updated_at)
  select po.poll_id, po.id, 0, now()
  from public.poll_options po
  where po.poll_id = pid;

  return mid;
end
$$;

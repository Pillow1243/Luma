-- ============================================================================
-- Luma — Poll upgrades: multiple-choice, anonymous results, closing deadlines
-- Additive and backward compatible: existing single-choice polls keep working
-- exactly as before (allow_multiple/anonymous default to false, closes_at null).
-- ============================================================================

alter table public.polls add column if not exists closes_at timestamptz;
alter table public.polls add column if not exists allow_multiple boolean not null default false;
alter table public.polls add column if not exists anonymous boolean not null default false;

-- Allow a user to hold more than one vote row per poll (needed for
-- multiple-choice polls). Single-choice polls enforce "one option" in the
-- vote_luma_poll function itself, not via the primary key anymore.
alter table public.poll_votes drop constraint if exists poll_votes_pkey;
alter table public.poll_votes
  add constraint poll_votes_pkey primary key (poll_id, user_id, option_id);

-- Anonymous polls: hide who voted for what (except your own vote) at the
-- row level. Aggregate counts remain available to everyone via
-- get_poll_results(), which never exposes voter identity.
drop policy if exists poll_votes_read on public.poll_votes;
create policy poll_votes_read on public.poll_votes
  for select to authenticated
  using (
    exists (select 1 from public.polls p where p.id = poll_votes.poll_id and public.is_chat_member(p.chat_id))
    and (
      user_id = auth.uid()
      or not exists (select 1 from public.polls p2 where p2.id = poll_votes.poll_id and p2.anonymous)
    )
  );

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
  return mid;
end
$$;

create or replace function public.vote_luma_poll(poll_uuid uuid, option_uuid uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  p public.polls;
  already boolean;
begin
  select * into p from public.polls where id = poll_uuid;
  if p.id is null or auth.uid() is null or not public.is_chat_member(p.chat_id) then
    raise exception 'Poll unavailable';
  end if;
  if p.closes_at is not null and p.closes_at <= now() then
    raise exception 'This poll is closed';
  end if;
  if not exists (select 1 from public.poll_options where poll_id = poll_uuid and id = option_uuid) then
    raise exception 'Invalid option';
  end if;

  if p.allow_multiple then
    select exists (
      select 1 from public.poll_votes
      where poll_id = poll_uuid and user_id = auth.uid() and option_id = option_uuid
    ) into already;
    if already then
      delete from public.poll_votes
        where poll_id = poll_uuid and user_id = auth.uid() and option_id = option_uuid;
    else
      insert into public.poll_votes(poll_id, option_id, user_id) values (poll_uuid, option_uuid, auth.uid());
    end if;
  else
    delete from public.poll_votes
      where poll_id = poll_uuid and user_id = auth.uid() and option_id <> option_uuid;
    insert into public.poll_votes(poll_id, option_id, user_id)
    values (poll_uuid, option_uuid, auth.uid())
    on conflict (poll_id, user_id, option_id) do nothing;
  end if;
end
$$;

-- Aggregate results without ever exposing who voted for what — safe for
-- anonymous polls, and simply faster for public ones.
create or replace function public.get_poll_results(poll_uuid uuid)
returns table (option_id uuid, votes integer)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id as option_id, count(v.user_id)::integer as votes
  from public.poll_options o
  join public.polls p on p.id = o.poll_id
  left join public.poll_votes v on v.option_id = o.id
  where o.poll_id = poll_uuid
    and public.is_chat_member(p.chat_id)
  group by o.id
  order by o.position
$$;

revoke all on function
  public.create_luma_poll(uuid, text, text[], boolean, boolean, integer),
  public.vote_luma_poll(uuid, uuid),
  public.get_poll_results(uuid)
from public, anon;

grant execute on function
  public.create_luma_poll(uuid, text, text[], boolean, boolean, integer),
  public.vote_luma_poll(uuid, uuid),
  public.get_poll_results(uuid)
to authenticated;

-- Drop the old 3-arg overload now that the richer signature exists, so
-- PostgREST/RPC callers always resolve to the new function unambiguously.
drop function if exists public.create_luma_poll(uuid, text, text[]);

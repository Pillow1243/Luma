-- ============================================================================
-- Luma — push notification log (deduplication + abuse control)
-- ============================================================================
-- The send-push edge function used to accept a chat id and fire a notification
-- for every device of every other participant, with no rate limit, no
-- deduplication of retries, and client-controlled text. Two things were needed
-- to fix that server-side:
--
--   * `push_log` gives the function a durable per-user counter for rate limiting
--     (a burst of 1000 calls must not become 1000 pushes) and a uniqueness
--     constraint on `message_id`, so an at-least-once client retry or a double
--     submit cannot notify twice.
--   * a cleanup routine drops rows older than a day, keeping the table tiny.
--
-- No message content, title, device token or endpoint is stored here — only
-- actor, message id, chat id and a timestamp.
-- ============================================================================

create table if not exists public.push_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (message_id)
);

create index if not exists push_log_user_created_idx
  on public.push_log (user_id, created_at desc);
create index if not exists push_log_created_idx
  on public.push_log (created_at);

alter table public.push_log enable row level security;

-- Clients never read or write this table: the edge function uses the service
-- role, which bypasses RLS. No policy is created on purpose, and no grant is
-- given to anon/authenticated, so both see "permission denied".
revoke all on public.push_log from anon, authenticated, public;
grant all on public.push_log to service_role;

-- Retention: one day is enough for the rate-limit window; the cron job below
-- keeps the table from growing without bound.
create or replace function public.cleanup_push_log()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare n integer;
begin
  delete from public.push_log where created_at < now() - interval '1 day';
  get diagnostics n = row_count;
  return n;
end
$function$;

revoke all on function public.cleanup_push_log() from public, anon, authenticated;
grant execute on function public.cleanup_push_log() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('cleanup-push-log')
      where exists (select 1 from cron.job where jobname = 'cleanup-push-log');
    perform cron.schedule('cleanup-push-log', '17 * * * *', $cron$select public.cleanup_push_log()$cron$);
  end if;
exception when others then
  raise notice 'pg_cron unavailable, push_log retention must be scheduled manually';
end $$;

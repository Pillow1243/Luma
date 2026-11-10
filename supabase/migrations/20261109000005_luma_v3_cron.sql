-- ============================================================
-- luma_v3_cron — disappearing-message expiry sweep (pg_cron)
-- Requires the pg_cron extension. RLS already hides expired messages
-- from reads; this job reclaims the storage rows every 5 minutes.
-- ============================================================
create extension if not exists pg_cron;
select cron.schedule(
  'cleanup-expired-messages',
  '*/5 * * * *',
  $$select public.cleanup_expired_messages()$$
);

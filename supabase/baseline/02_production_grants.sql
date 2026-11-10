-- ============================================================================
-- Luma — production grants baseline
-- ============================================================================
-- Table / column / function privileges exactly as they exist on the deployed
-- project after 20261110140000_fix_grants_and_push_upsert.sql. Kept separate
-- from 01_production_schema.sql so the privilege model can be reviewed and
-- diffed on its own.
--
-- Model: `anon` has *no* object privileges anywhere in public (verified on
-- production: has_table_privilege('anon', ...) is false for every table and
-- has_function_privilege('anon', ...) is false for every Luma RPC).
-- `authenticated` gets the minimum it needs: SELECT everywhere it must render
-- data, column-scoped INSERT/UPDATE only where RLS already constrains the row
-- to the caller, and no DDL-ish grants (TRUNCATE/REFERENCES/TRIGGER).
-- ============================================================================

revoke all on all tables in schema public from anon, public;
revoke all on all sequences in schema public from anon, public;
revoke all on all tables in schema public from authenticated;

revoke all on all functions in schema public from public, anon;

grant usage on schema public to authenticated;

grant select,
      insert (id, display_name, avatar_path, username, bio, show_last_seen, last_seen_at),
      update (display_name, avatar_path, username, bio, show_last_seen, last_seen_at)
  on public.profiles to authenticated;

grant select on public.chats to authenticated;

grant select,
      update (last_read_at, last_seen_at, typing_until, muted_until, archived_at)
  on public.chat_participants to authenticated;

grant select,
      insert (id, chat_id, sender_id, body, reply_to, media_path, media_name, media_type,
              media_waveform, media_duration, expires_at, mentions, forwarded_from)
  on public.messages to authenticated;

grant select, insert (message_id, user_id, emoji), delete on public.message_reactions to authenticated;
grant select, insert (user_id, message_id), delete on public.starred_messages to authenticated;
grant select, update (revoked_at) on public.chat_invites to authenticated;
grant select on public.join_requests to authenticated;
grant select, insert (blocker, blocked), delete on public.blocks to authenticated;
grant select, insert (chat_id, message_id, reporter, reason, details) on public.message_reports to authenticated;
grant select, update (read_at), delete on public.notifications to authenticated;
grant select,
      insert (user_id, endpoint, p256dh, auth),
      update (user_id, endpoint, p256dh, auth),
      delete
  on public.push_subscriptions to authenticated;

grant select on public.calls, public.call_participants, public.polls, public.poll_options, public.poll_votes,
  public.poll_vote_counts to authenticated;
grant select, insert (id, call_id, from_user, to_user, kind, payload), delete on public.call_signals to authenticated;
grant select, insert (user_id, public_key), update (public_key) on public.user_public_keys to authenticated;
grant select on public.user_prekey_bundles, public.user_one_time_prekeys to authenticated;

grant execute on function
  public.is_chat_member(uuid),
  public.is_chat_admin(uuid),
  public.is_channel(uuid),
  public.shares_chat_with(uuid),
  public.channel_subscriber_count(uuid),
  public.create_chat(uuid[], text),
  public.create_saved_chat(),
  public.create_secret_chat(uuid, integer),
  public.create_channel(text, text, text, boolean, text),
  public.update_channel(uuid, text, text, text, boolean, text),
  public.update_group(uuid, text, text),
  public.subscribe_channel(uuid),
  public.leave_chat(uuid),
  public.add_chat_member(uuid, uuid),
  public.remove_chat_member(uuid, uuid),
  public.set_group_admin(uuid, uuid, boolean),
  public.create_invite(uuid, integer, integer),
  public.revoke_invite(uuid),
  public.redeem_invite(uuid),
  public.request_join(uuid),
  public.approve_join(uuid, uuid),
  public.reject_join(uuid, uuid),
  public.search_channels(text),
  public.search_users(text),
  public.get_chat_sidebar_meta(uuid[]),
  public.set_chat_ttl(uuid, integer),
  public.mark_notifications_read(),
  public.edit_message(uuid, text),
  public.delete_message_for_everyone(uuid),
  public.delete_message_for_me(uuid),
  public.set_message_pinned(uuid, boolean),
  public.start_luma_call(uuid, text),
  public.respond_luma_call(uuid, boolean),
  public.leave_luma_call(uuid),
  public.create_luma_poll(uuid, text, text[]),
  public.vote_luma_poll(uuid, uuid),
  public.get_poll_results(uuid),
  public.publish_prekey_bundle(text, text, integer, text, text, jsonb),
  public.claim_prekey_bundle(uuid),
  public.count_one_time_prekeys(),
  public.register_push_subscription(text, text, text)
to authenticated;

-- Trigger-only helpers: not part of the client-facing API.
revoke all on function public.sync_poll_vote_counts() from public, anon, authenticated;
revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

alter default privileges in schema public revoke all on tables from anon, public;
alter default privileges in schema public revoke all on functions from anon, public;
alter default privileges in schema public revoke all on sequences from anon, public;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- storage: authenticated may manage objects only through the RLS policies above
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880,
        array['image/png','image/jpeg','image/webp','image/gif','image/avif'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880,
      allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','image/avif'];

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat_media', 'chat_media', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

-- realtime publication membership (mirrors production)
do $$
declare tab text;
begin
  foreach tab in array array['messages','chat_participants','message_reactions','notifications',
                           'chats','calls','call_participants','call_signals',
                           'polls','poll_options','poll_votes','poll_vote_counts'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = tab) then
      execute format('alter publication supabase_realtime add table public.%I', tab);
    end if;
  end loop;
end $$;

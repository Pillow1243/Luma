-- ============================================================================
-- Luma — let group/channel owners actually manage their own avatars
-- ============================================================================
-- Found by replaying storage RLS as real users (tests/db/security.mjs).
--
-- `media_upload` requires the second path segment to equal auth.uid():
--
--     (storage.foldername(name))[2] = auth.uid()::text
--
-- which is right for chat media (`<chat_id>/<sender_id>/<file>`) but wrong for
-- group and channel avatars, which live in the same bucket as
-- `<chat_id>/<owner_id>/avatar-<ts>.png`. As a result an owner could not upload
-- a new avatar for their own group, while `channel_avatar_read` happily serves
-- public-channel avatars from that path. The client (src/lib/data.ts →
-- uploadChatAvatar) has always used this layout.
--
-- The added branch only accepts objects whose last path segment starts with
-- `avatar-` and only for users who administer that chat, so it cannot be used to
-- write arbitrary media into somebody else's chat folder.
-- ============================================================================

drop policy if exists media_upload on storage.objects;
create policy media_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat_media'
    and lower(name) !~ '\.(svg|svgz|html?|xhtml|m?js|exe|bat|cmd|sh|php|jsp)$'
    and (
      -- ordinary chat media: <chat_id>/<sender_id>/<file>, sender is a member
      (
        (storage.foldername(name))[2] = auth.uid()::text
        and exists (
          select 1 from public.chat_participants p
          where p.chat_id::text = (storage.foldername(objects.name))[1]
            and p.user_id = auth.uid()
        )
      )
      or
      -- group / channel avatar: <chat_id>/<uploader_id>/avatar-*.png, uploader is admin
      (
        lower(split_part(name, '/', -1)) like 'avatar-%'
        and (storage.foldername(name))[2] = auth.uid()::text
        and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        and public.is_chat_admin(((storage.foldername(name))[1])::uuid)
      )
    )
  );

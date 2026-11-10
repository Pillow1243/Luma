-- Fix messages_check so soft-deleted rows (deleted_at is not null) pass constraint checks,
-- and align messages_body_check and edit_message limit (16000) with messages_guardian for E2EE v2 envelopes.
alter table public.messages drop constraint if exists messages_check;
alter table public.messages add constraint messages_check
  check (deleted_at is not null or coalesce(length(btrim(body)), 0) > 0 or media_path is not null);

alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages add constraint messages_body_check
  check (body is null or length(body) <= 16000);

create or replace function public.edit_message(msg_id uuid, new_body text)
returns public.messages
language plpgsql
security definer
set search_path to ''
as $$
declare m public.messages;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into m from public.messages where id = msg_id;
  if not found then raise exception 'Message not found'; end if;
  if m.sender_id <> auth.uid() then raise exception 'Only the sender can edit'; end if;
  if m.deleted_at is not null then raise exception 'Message was deleted'; end if;
  if new_body is null or length(trim(new_body)) = 0 then raise exception 'Message cannot be empty'; end if;
  if length(new_body) > 16000 then raise exception 'Message too long'; end if;
  update public.messages
    set body = trim(new_body), edited_at = now()
    where id = msg_id
    returning * into m;
  return m;
end
$$;

-- Ensure handle_profile_delete only transfers ownership to users still present in public.profiles
-- (guards bulk user deletions where RI cascade on chat_participants runs in AFTER triggers).
create or replace function public.handle_profile_delete()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

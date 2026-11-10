-- ============================================================
-- luma_v3_rpc_fixes — bugs surfaced by the live authorization suite
-- ============================================================

-- 1. Legacy create_chat never set kind — groups were created as
--    kind='direct', breaking group-only RPCs (add_chat_member etc.)
--    and sidebar folder filtering. Fix forward + backfill.
create or replace function public.create_chat(member_ids uuid[], chat_name text default null)
returns uuid language plpgsql security definer set search_path to '' as $$
declare cid uuid; n integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select count(distinct x) into n from unnest(member_ids) x
    where x is not null and x <> auth.uid();
  if n < 1 or n > 30 then raise exception 'Choose between 1 and 30 other members'; end if;
  if (select count(*) from public.profiles where id in (select unnest(member_ids)) and id <> auth.uid()) <> n then
    raise exception 'Invalid participant';
  end if;
  if n > 1 and (chat_name is null or length(trim(chat_name)) = 0) then
    raise exception 'Group name required';
  end if;
  if n = 1 then
    select c.id into cid from public.chats c
      where not c.is_group and c.kind = 'direct'
        and exists (select 1 from public.chat_participants p where p.chat_id = c.id and p.user_id = auth.uid())
        and exists (select 1 from public.chat_participants p where p.chat_id = c.id and p.user_id = any(member_ids))
      limit 1;
    if cid is not null then return cid; end if;
  end if;
  insert into public.chats (name, is_group, kind, created_by)
    values (case when n > 1 then left(trim(chat_name), 80) else null end,
            n > 1,
            case when n > 1 then 'group' else 'direct' end,
            auth.uid())
    returning id into cid;
  insert into public.chat_participants (chat_id, user_id)
    select cid, id from public.profiles where id = auth.uid() or id = any(member_ids);
  return cid;
end $$;

update public.chats set kind = 'group' where is_group and kind = 'direct';

-- 2. set_chat_ttl: parameter named ttl_seconds collided with chats.ttl_seconds
--    in the UPDATE expression — every non-null call raised
--    "column reference ttl_seconds is ambiguous". Qualify all references.
create or replace function public.set_chat_ttl(cid uuid, ttl_seconds integer)
returns void language plpgsql security definer set search_path to '' as $$
declare c public.chats;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into c from public.chats where id = cid;
  if not found then raise exception 'Chat not found'; end if;
  if c.kind in ('group', 'channel') then
    if not public.is_chat_admin(cid) then raise exception 'Only admins can change disappearing messages'; end if;
  else
    if not public.is_chat_member(cid) then raise exception 'Not a member'; end if;
  end if;
  if set_chat_ttl.ttl_seconds is null or set_chat_ttl.ttl_seconds <= 0 then
    update public.chats set ttl_seconds = null where id = cid;
  else
    update public.chats set ttl_seconds = least(set_chat_ttl.ttl_seconds, 604800) where id = cid;
  end if;
end $$;

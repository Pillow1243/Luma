-- ============================================================================
-- Luma — database schema, RLS policies, RPCs and storage policies
-- Applied to project lnhmbjqjfrnqkpsjpszb. Kept here for reproducibility.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles --
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_path text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- chats --
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  name text,
  is_group boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_participants (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  last_seen_at timestamptz,
  typing_until timestamptz,
  primary key (chat_id, user_id)
);

-- ---------------------------------------------------------------- messages --
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text,
  reply_to uuid references public.messages (id) on delete set null,
  media_path text,
  media_name text,
  media_type text,
  created_at timestamptz not null default now()
);

create index if not exists messages_chat_created_idx
  on public.messages (chat_id, created_at desc);

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

-- ---------------------------------------------------------------- functions --
create or replace function public.is_chat_member(cid uuid)
returns boolean
language sql stable security definer set search_path to ''
as $$
  select exists (
    select 1 from public.chat_participants
    where chat_id = cid and user_id = auth.uid()
  )
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
        split_part(new.email, '@', 1)
      ),
      60
    )
  );
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Creates (or reuses) a direct chat, or creates a group of 2..31 people.
create or replace function public.create_chat(
  member_ids uuid[],
  chat_name text default null
)
returns uuid
language plpgsql security definer set search_path to ''
as $$
declare
  cid uuid;
  n integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select count(distinct x) into n
  from unnest(member_ids) x
  where x is not null and x <> auth.uid();

  if n < 1 or n > 30 then
    raise exception 'Choose between 1 and 30 other members';
  end if;

  if (
    select count(*) from public.profiles
    where id in (select unnest(member_ids)) and id <> auth.uid()
  ) <> n then
    raise exception 'Invalid participant';
  end if;

  if n > 1 and (chat_name is null or length(trim(chat_name)) = 0) then
    raise exception 'Group name required';
  end if;

  if n = 1 then
    select c.id into cid
    from public.chats c
    where not c.is_group
      and exists (select 1 from public.chat_participants p
                  where p.chat_id = c.id and p.user_id = auth.uid())
      and exists (select 1 from public.chat_participants p
                  where p.chat_id = c.id and p.user_id = any(member_ids))
    limit 1;

    if cid is not null then
      return cid;
    end if;
  end if;

  insert into public.chats (name, is_group, created_by)
  values (
    case when n > 1 then left(trim(chat_name), 80) else null end,
    n > 1,
    auth.uid()
  )
  returning id into cid;

  insert into public.chat_participants (chat_id, user_id)
  select cid, id from public.profiles
  where id = auth.uid() or id = any(member_ids);

  return cid;
end
$$;

-- --------------------------------------------------------------------- RLS --
alter table public.profiles            enable row level security;
alter table public.chats               enable row level security;
alter table public.chat_participants   enable row level security;
alter table public.messages            enable row level security;
alter table public.message_reactions   enable row level security;

create policy profiles_read   on public.profiles for select using (true);
create policy profiles_update on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

create policy chats_read on public.chats for select using (public.is_chat_member(id));

create policy participants_read on public.chat_participants for select
  using (public.is_chat_member(chat_id));
create policy participants_update on public.chat_participants for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_chat_member(chat_id));

create policy messages_read on public.messages for select
  using (public.is_chat_member(chat_id));
create policy messages_send on public.messages for insert
  with check (
    sender_id = auth.uid()
    and public.is_chat_member(chat_id)
    and (reply_to is null or exists (
      select 1 from public.messages m
      where m.id = messages.reply_to and m.chat_id = messages.chat_id
    ))
    and (media_path is null or (
      split_part(media_path, '/', 1) = chat_id::text
      and split_part(media_path, '/', 2) = auth.uid()::text
    ))
  );

create policy reactions_read on public.message_reactions for select
  using (exists (
    select 1 from public.messages m
    where m.id = message_reactions.message_id and public.is_chat_member(m.chat_id)
  ));
create policy reactions_add on public.message_reactions for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id and public.is_chat_member(m.chat_id)
    )
  );
create policy reactions_remove on public.message_reactions for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------- realtime --
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.chat_participants;
alter publication supabase_realtime add table public.message_reactions;

-- ----------------------------------------------------------------- storage --
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', false, 5242880)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat_media', 'chat_media', false, 20971520)
on conflict (id) do nothing;

create policy avatar_read on storage.objects for select
  using (bucket_id = 'avatars');
create policy avatar_upload on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy avatar_update on storage.objects for update
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy media_read on storage.objects for select
  using (
    bucket_id = 'chat_media'
    and exists (
      select 1 from public.chat_participants p
      where p.chat_id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  );
create policy media_upload on storage.objects for insert
  with check (
    bucket_id = 'chat_media'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.chat_participants p
      where p.chat_id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  );

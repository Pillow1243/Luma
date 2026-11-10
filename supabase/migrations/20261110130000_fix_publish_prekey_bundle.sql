-- Fix publish_prekey_bundle: user_public_keys stores legacy P-256 JWK jsonb objects,
-- whereas v2 identity_key is SPKI base64 text stored on user_prekey_bundles.
create or replace function public.publish_prekey_bundle(
  p_identity_key text,
  p_signing_key text,
  p_signed_prekey_id integer,
  p_signed_prekey text,
  p_signed_prekey_sig text,
  p_one_time_keys jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  uid uuid := auth.uid();
  item jsonb;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if length(coalesce(p_identity_key, '')) < 20
     or length(coalesce(p_signing_key, '')) < 20
     or length(coalesce(p_signed_prekey, '')) < 20
     or length(coalesce(p_signed_prekey_sig, '')) < 20 then
    raise exception 'Invalid key bundle';
  end if;

  if exists (
    select 1 from public.user_prekey_bundles
    where user_id = uid and identity_key <> p_identity_key
  ) then
    delete from public.user_one_time_prekeys where user_id = uid;
  end if;

  insert into public.user_prekey_bundles (
    user_id, identity_key, signing_key, signed_prekey_id, signed_prekey, signed_prekey_sig, updated_at
  )
  values (
    uid, p_identity_key, p_signing_key, p_signed_prekey_id, p_signed_prekey, p_signed_prekey_sig, now()
  )
  on conflict (user_id) do update
    set identity_key = excluded.identity_key,
        signing_key = excluded.signing_key,
        signed_prekey_id = excluded.signed_prekey_id,
        signed_prekey = excluded.signed_prekey,
        signed_prekey_sig = excluded.signed_prekey_sig,
        updated_at = now();

  if jsonb_typeof(p_one_time_keys) = 'array' then
    for item in select value from jsonb_array_elements(p_one_time_keys) limit 50 loop
      insert into public.user_one_time_prekeys (user_id, key_id, public_key)
      values (
        uid,
        (item ->> 'key_id')::integer,
        item ->> 'public_key'
      )
      on conflict (user_id, key_id) do nothing;
    end loop;
  end if;

  return (select count(*)::integer from public.user_one_time_prekeys where user_id = uid);
end
$$;

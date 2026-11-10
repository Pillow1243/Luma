# Database: schema, migrations, and how to verify them

This document explains how Luma's database changes are made, reviewed and
verified — and, most importantly, how we keep **the repository** and **the live
Supabase project** from silently diverging.

A schema that differs between a fresh install and production is not a nuisance;
it is how security fixes quietly fail to reach new deployments. Three harnesses
exist so that this cannot happen unnoticed.

## 1. The three harnesses

| command | what it proves | runs in CI |
|---|---|---|
| `npm run test:db` | Replaying `supabase/baseline/` + every migration on an **empty** database and on a database that already has the production baseline ends in the **same** schema (tables, columns, RLS policies, function bodies, privileges). | yes |
| `npm run test:db:security` | 83 negative multi-user scenarios over RLS, RPC and Storage: IDOR, privilege escalation, invite redemption, prekey bundles, push endpoints, polls, `anon` access, `search_path` pinning, rate-limit tampering. | yes |
| `npm run test:db:parity` | The replayed schema matches the fingerprint captured from the **hosted project**. | yes |

They need a PostgreSQL server, not Supabase. See
[`scripts/dev-postgres.md`](../scripts/dev-postgres.md) for the one-liner that
starts a throwaway container.

All three run on every push and pull request in the `database` CI job.

## 2. Directory layout

```
supabase/
  baseline/
    00_platform_shim.sql            # auth/storage roles + auth.uid() etc., so a
                                    # plain PostgreSQL can host the schema
    01_production_schema.sql        # DDL/functions/policies as they exist on prod
    02_production_grants.sql        # privileges as they exist on prod
    03_production_fingerprints.json # captured production function/table/policy/ACL
    04_pending_production_changes.json # committed-but-not-deployed differences
  migrations/
    <timestamp>_<name>.sql          # forward-only history
```

`baseline/` is **not** an alternative migration path: it is a description of the
state production is in today. It is what lets us prove that replaying
`migrations/` reaches the same place.

## 3. Adding a migration

1. Add `supabase/migrations/<UTC timestamp>_<snake_case_name>.sql`. Timestamps
   must be unique and strictly increasing; `create or replace` for functions,
   `if not exists` / `drop ... if exists` for objects that may already exist, so
   the file is safe to replay.
2. **New functions must be locked down explicitly.** `create or replace function`
   on a brand-new function grants `EXECUTE` to `PUBLIC` — which, with Supabase's
   `anon` role, means the whole internet. End every file with:
   ```sql
   revoke all on function public.my_rpc(...) from public, anon;
   grant execute on function public.my_rpc(...) to authenticated;
   ```
   `tests/db/security.mjs` fails if anything in `public` is executable by `anon`.
3. Never edit a migration that has already been applied. If production drifted,
   update `baseline/` **and** add a new forward-only migration.
4. Run `npm run test:db:all`. If `test:db:parity` reports a difference that is
   intentional and not yet deployed, add it to
   `baseline/04_pending_production_changes.json` **with the file name that
   closes it**. Delete the entry once it is applied.
5. Apply to production deliberately (see §5) and re-run `test:db:parity` with a
   refreshed fingerprint.

## 4. What is actually compared

* **functions** — every `public` function's identity arguments and an md5 over
  its body with comments and whitespace stripped. Re-indenting or adding a
  comment does not fail the check; changing behaviour does.
* **tables** — the ordered column list of every table, so a dropped, renamed or
  reordered column is drift.
* **policies** — schema, table, policy name, command and role for every RLS
  policy including `storage.objects`. Policy *expressions* cannot be compared
  across PostgreSQL versions (the planner rewrites them), so their behaviour is
  asserted by the security suite instead. This is deliberate: a green parity
  run does not by itself prove an RLS policy is correct.
* **grants** — whole-table privileges per role plus function `EXECUTE`. Column-
  scoped `INSERT`/`UPDATE` grants (the core of Luma's write model) are enumerated
  in `02_production_grants.sql` and diffed by `test:db` between fresh and
  upgraded replays.
* **rlsOff** — any table in `public` with RLS disabled. Must always be empty.

`MAINTAIN` (a PostgreSQL 17 privilege production reports and PostgreSQL 16 CI
containers cannot) is normalised away; it conveys nothing beyond the DML grants
already compared.

## 5. Applying a migration to production

Production is a Supabase project (`lnhmbjqjfrnqkpsjpszb`, PostgreSQL 17,
`eu-central-1`). Apply with one of:

* the Supabase dashboard SQL editor, pasting the file verbatim;
* `supabase db push` from a checkout with the project linked (requires the
  Supabase CLI and a project access token);
* the MCP `create_migration` tool.

Before any of those: **take a backup and confirm it restores.** Supabase Free/
Pro projects have daily backups; verify a restore point exists in
*Database → Backups* and note the timestamp in the change description. The
migrations in this repository are written to be idempotent, but "idempotent"
is not "reversible": prefer a forward fix over a rollback.

Afterwards:

1. `supabase/migrations` history (`supabase migration list` or the dashboard)
   must show the new version.
2. Re-capture the fingerprint (§6) and remove matching entries from
   `04_pending_production_changes.json`.
3. `npm run test:db:all` must be green with **no** pending entries.

## 6. Re-capturing the production fingerprint

Only do this after an *approved* production change — otherwise you are just
recording drift instead of fixing it.

```sql
-- functions
select json_object_agg(
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g'))
         order by p.proname)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f';

-- tables
select c.relname, json_agg(a.attname order by a.attnum)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and c.relkind = 'r'
group by 1 order by 1;

-- policies
select schemaname, tablename, policyname, cmd, roles::text
from pg_policies where schemaname in ('public', 'storage') order by 1, 2, 3;

-- table grants
select c.relname, r.rolname,
       string_agg(distinct p.privilege_type, ',' order by p.privilege_type)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) p
join pg_roles r on r.oid = p.grantee
where n.nspname = 'public' and c.relkind = 'r'
  and r.rolname in ('anon', 'authenticated', 'service_role')
group by 1, 2 order by 1, 2;
```

Paste the results into `03_production_fingerprints.json` (same shapes as the
existing sections) and commit with a note saying what changed and why.

## 7. Production findings that are now fixed in the repository

These were found by comparing the repository against the live project. Each is
fixed by a migration in this repository; the "deployed" column is the honest
state at the time of writing.

| finding | severity | fixed by | deployed |
|---|---|---|---|
| `register_push_subscription` moved an existing Web Push endpoint to the calling account — anyone who learned an endpoint could silence the owner's notifications and receive their pushes | P0 | `20261110160000_harden_push_registration.sql` | **no** — pending |
| `profile_update` policy existed on production but not in the repository, so a fresh install could not edit profiles | P1 | `01_production_schema.sql` + `20261110150000` | **no** — pending |
| `register_push_subscription` wrote `text` into `jsonb` (`user_public_keys`) in the repository version, breaking secret-chat key publication on a fresh install | P1 | `20261110130000`, baseline | **no** — pending |
| `create_luma_poll` existed only with the 6-argument signature on production; a fresh install got the 3-argument one the client never calls | P1 | `20261110150000_reconcile_with_production.sql` | **no** — pending |
| `poll_vote_counts` lost `authenticated SELECT` and kept `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN` | P1 | `20261110150000` | **no** — pending |
| `check_rate_limit` was executable by `authenticated`, so any user could zero their own abuse counters | P2 | reconciled in `20261110120000` + `20261110150000` | **no** — pending |
| `sync_poll_vote_counts` was executable by `anon` | P3 | `20261110150000` | **no** — pending |
| group/channel owners could not upload their own avatar (`media_upload` demanded the uploader be a member under their own id) | P2 | `20261110170000_fix_chat_avatar_upload.sql` | **no** — pending |
| 8 functions differed between production and the repository (`handle_profile_delete` did not prefer live profiles when transferring chat ownership; `notify_mentions`, `request_join`, `set_group_admin`, `remove_chat_member`, `is_chat_member`, `cleanup_expired_messages` formatting) | P2 | `20261110150000` | **no** — pending |

"Deployed" is stated separately from "merged" on purpose: the migration files
are in this repository, but applying them requires a verified backup and a
maintenance window on the live project.

## 8. Known limitations

* The security suite runs as `authenticated`/`anon` with JWT claims, exactly like
  PostgREST. It does **not** exercise GoTrue itself (email delivery, token
  rotation, rate limits at the auth layer), Realtime authorization, or Storage's
  own signed-URL service — those are Supabase-managed and are tested against the
  hosted project by `tests/rls-tests.mjs`, which needs real accounts.
* Extension-dependent behaviour (trigram search, `pg_cron` jobs) is shimmed
  locally, so a local green run does not prove the cron schedule fires; check
  `cron.job_run_details` on production for that.
* Policy expressions are verified behaviourally, not by fingerprint (§4).
* Local runs on a PostgreSQL without `contrib` print `~` adaptation lines. Use
  `test:db --strict` where extensions are available to make those fatal.

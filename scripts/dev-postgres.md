# Local PostgreSQL for the database test suites

`tests/db/migrate.mjs`, `tests/db/security.mjs` and `tests/db/parity.mjs` need a
real PostgreSQL server with the Luma schema on it. They do **not** need
Supabase, Docker, or any hosted project: the suites replay
`supabase/baseline/` and every file in `supabase/migrations/` themselves.

Everything below runs against a throwaway cluster. Never point `DATABASE_URL`
at a database you care about: the harnesses create, drop and rebuild databases
(`luma_fresh`, `luma_upgrade`, `luma_security`, `luma_parity`).

## 1. Get a server

### Option A — Docker (same as CI)

```bash
docker run -d --name luma-pg -p 55432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:16
export DATABASE_URL="postgresql://postgres:postgres@localhost:55432/postgres"
```

### Option B — a local install

```bash
initdb -D /tmp/lumapg -U postgres --auth=trust
pg_ctl -D /tmp/lumapg -o "-p 55432 -k /tmp -c listen_addresses=127.0.0.1" -l /tmp/luma-pg.log start
export DATABASE_URL="postgresql://postgres@localhost:55432/postgres"
```

### Extensions

The production project uses `citext`, `pgcrypto`, `pg_trgm`, `pg_cron` and
`pg_net`. If they are missing locally the harnesses adapt:

| extension  | when missing                                                    |
|------------|-----------------------------------------------------------------|
| `citext`   | replaced by a lowercased `text`-backed domain                    |
| `pgcrypto` | skipped (`gen_random_uuid()` is core since PostgreSQL 13)        |
| `pg_trgm`  | trigram indexes omitted, `extensions` schema kept                 |
| `pg_cron`  | `cron.schedule()`/`cron.unschedule()` backed by a shim table      |

Every adaptation prints a `~` line. `tests/db/migrate.mjs --strict` turns those
warnings into failures — use `--strict` when you *do* have a fully extension-
capable server (the CI job installs `postgresql-contrib`).

A stock `postgres:16` image ships contrib binaries but not the extensions
pre-created; the shim handles that. A PostgreSQL built without contrib (some
sandboxes ship only the server) also works, with the same `~` warnings.

## 2. Run the suites

```bash
npm run test:db          # migration replay (fresh + upgrade must be identical)
npm run test:db:security # multi-user RLS / RPC / Storage authorization
npm run test:db:parity   # replayed schema vs the captured production fingerprint
```

`npm run test:db:all` runs all three in order, which is what `.github/workflows/ci.yml`
does. Useful flags:

```bash
node tests/db/migrate.mjs --strict        # fail on any local extension adaptation
node tests/db/migrate.mjs --keep          # keep luma_fresh/luma_upgrade for inspection
node tests/db/migrate.mjs --fresh-only    # skip the upgrade replay
node tests/db/security.mjs --keep         # keep luma_security for manual poking
node tests/db/parity.mjs --report         # print the full drift report
node tests/db/parity.mjs --snapshot       # print the current fingerprint as JSON
```

## 3. What each suite proves

| suite | proves |
|-------|--------|
| `migrate.mjs` | Replaying the repository on an empty database and on a database that already has the production baseline produce the **same** schema (tables, columns, RLS policies, function bodies, privileges). This is what catches "works on my machine, wrong on a fresh install". |
| `security.mjs` | 70+ negative cross-user scenarios: IDOR on messages/chats/storage, role escalation, invite redemption, prekey bundles, push endpoints, polls, anon access, `search_path` pinning. Identity switching uses `set local role authenticated` + `request.jwt.claims`, exactly like PostgREST, so `auth.uid()` resolves as on Supabase. No mocks on the authorization path. |
| `parity.mjs` | The replayed schema matches the fingerprint captured from the hosted project. Drift that a repository-only test cannot see (production edited by hand, migrations applied out of band) becomes a build failure. |

## 4. When production and the repository disagree

1. Capture the truth from production (functions, tables, policies, grants).
2. Update `supabase/baseline/` so a fresh replay matches production.
3. Add a forward-only migration that converges existing databases to the same
   state. Never edit an applied migration.
4. Re-run `npm run test:db:all`; `parity.mjs` must report zero untracked drift.
5. If the migration is committed but **not yet applied** to production, record
   it in `supabase/baseline/04_pending_production_changes.json` — with the file
   name that closes it. Delete those entries straight after deployment.

## 5. Teardown

```bash
docker rm -f luma-pg
# or
pg_ctl -D /tmp/lumapg stop
```

The harnesses drop their own databases; nothing else on the server is touched.

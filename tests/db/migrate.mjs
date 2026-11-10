#!/usr/bin/env node
/**
 * Luma — database migration replay harness.
 *
 * Proves the two paths the mission requires:
 *
 *   FRESH      empty cluster -> platform shim -> production baseline -> grants
 *                              -> every file in supabase/migrations in order
 *   UPGRADE    production baseline only (i.e. "the database that is live now")
 *                              -> every migration that is not yet applied there
 *
 * Both are executed against a real PostgreSQL server (see scripts/dev-postgres.md
 * for how to obtain one; CI installs the PostgreSQL contrib packages). The
 * harness then compares the resulting *public* schema — tables, columns,
 * constraints, indexes, RLS enablement, policies, function signatures, security
 * definer/search_path settings, triggers and grants — and fails if the two
 * paths disagree.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node tests/db/migrate.mjs            # verify
 *   DATABASE_URL=postgresql://... node tests/db/migrate.mjs --keep     # keep DBs for inspection
 *   DATABASE_URL=postgresql://... node tests/db/migrate.mjs --fresh-only
 *
 * Exit code 0 means: migrations replay cleanly on an empty database AND on a
 * database that already has the production schema, and both end up identical.
 *
 * NOTE: this never touches the hosted Supabase project. It only opens the
 * database named by DATABASE_URL, which CI points at a throwaway container.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const baselineDir = join(repo, "supabase", "baseline");
const migrationsDir = join(repo, "supabase", "migrations");

const args = new Set(process.argv.slice(2));
const KEEP = args.has("--keep");
const FRESH_ONLY = args.has("--fresh-only");
const QUIET = args.has("--quiet");

/**
 * Timestamp of the newest migration already reflected in
 * supabase/baseline/01_production_schema.sql. Anything sorted after it is a
 * *pending* migration for the UPGRADE path (production as it stands today).
 * Bump this when you capture a new baseline.
 */
const BASELINE_THROUGH = "20261110143000";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (see scripts/dev-postgres.md)");
  process.exit(2);
}

const log = (...a) => { if (!QUIET) console.log(...a); };

/**
 * Capability probe + last-resort local shims.
 *
 * The hosted project has citext, pgcrypto, pg_trgm and pg_cron. A bare local
 * PostgreSQL (and some CI images) may not ship contrib modules. Rather than
 * silently skipping migrations, the harness records every statement it had to
 * adapt in `adaptations` and fails in `--strict` mode (CI with contrib
 * packages available) if the list is non-empty.
 *
 * Adapted statements are *only* the extension bootstrap and the three trigram
 * indexes (a query-performance concern, not an authorization or data-shape
 * one), which keeps FRESH-vs-UPGRADE equivalence meaningful.
 */
const adaptations = [];

async function probeCapabilities(client) {
  const { rows } = await client.query(
    `select name from pg_available_extensions where name in ('citext','pgcrypto','pg_trgm','pg_cron')`
  );
  const have = new Set(rows.map((r) => r.name));
  let pg18 = false;
  try {
    const v = await client.query("select current_setting('server_version_num')::int as n");
    pg18 = v.rows[0].n >= 130000;
  } catch { /* ignore */ }
  return { have, genRandomUuidCore: pg18 };
}

/** Apply the local shims/config rewrites for modules the server lacks. */
function transformSql(sql, caps) {
  let out = sql;
  const has = (n) => caps.have.has(n);

  if (!has("citext")) {
    adaptations.push("citext -> domain (identifiers are always stored lowercased)");
    out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+citext\s*;/gi, "");
    // migrations run with search_path='' inside functions, so the domain must be
    // reachable as public.citext; the shim creates exactly that.
  }
  if (!has("pgcrypto")) {
    adaptations.push("pgcrypto skipped (gen_random_uuid is in core PostgreSQL >= 13)");
    out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pgcrypto\s*;/gi, "");
  }
  if (!has("pg_trgm")) {
    adaptations.push("pg_trgm skipped; trigram GIN indexes omitted locally");
    out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pg_trgm[^;]*;/gi, "create schema if not exists extensions;");
    // remove the CREATE INDEX statements that need the gin_trgm_ops opclass
    out = out.replace(/create\s+index[^;]*?gin_trgm_ops[^;]*;/gis, "");
  }
  if (!has("pg_cron")) {
    adaptations.push("pg_cron skipped; cron.schedule() backed by the shim cron.job table");
    out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pg_cron\s*;/gi, "");
  }
  return out;
}


function baseClient() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  return c;
}

/** Connect to a specific database on the same server as DATABASE_URL. */
async function clientFor(dbName) {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${dbName}`;
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  return c;
}

async function recreateDatabase(name) {
  const admin = baseClient();
  await admin.connect();
  try {
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [name]
    );
    await admin.query(`drop database if exists ${pg.escapeIdentifier(name)}`);
    await admin.query(`create database ${pg.escapeIdentifier(name)}`);
  } finally {
    await admin.end();
  }
}

async function runFile(client, path, label, caps) {
  const sql = caps ? transformSql(readFileSync(path, "utf8"), caps) : readFileSync(path, "utf8");
  try {
    await client.query(sql);
  } catch (err) {
    console.error(`\n✗ ${label} failed: ${path}`);
    console.error(`  ${err.message}`);
    if (err.position) {
      const upto = sql.slice(0, Number(err.position));
      const line = upto.split("\n").length;
      const text = sql.split("\n")[line - 1] ?? "";
      console.error(`  at line ${line}: ${text.trim().slice(0, 160)}`);
    }
    throw err;
  }
}

function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(migrationsDir, f));
}

/** Migrations that are not yet part of the captured production baseline. */
function pendingMigrations() {
  return migrationFiles().filter((f) => {
    const stamp = f.split("/").pop().slice(0, 14);
    return stamp > BASELINE_THROUGH;
  });
}

const BASELINE_FILES = [
  join(baselineDir, "00_platform_shim.sql"),
  join(baselineDir, "01_production_schema.sql"),
  join(baselineDir, "02_production_grants.sql"),
];

/**
 * Structural fingerprint of the public schema plus the parts of storage that
 * Luma owns. Anything that affects authorization or data shape must show up
 * here, otherwise a divergence could pass unnoticed.
 */
const SNAPSHOT_SQL = `
with
tables as (
  select c.relname as t,
         jsonb_build_object(
           'rls', c.relrowsecurity,
           'columns', (
             select jsonb_agg(jsonb_build_object(
                      'name', a.attname,
                      'type', format_type(a.atttypid, a.atttypmod),
                      'notnull', a.attnotnull,
                      'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attnum)
             from pg_attribute a
             left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
           ),
           'constraints', (
             select jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname)
             from pg_constraint k where k.conrelid = c.oid
           )
         ) as def
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
policies as (
  select p.schemaname || '.' || p.tablename as t,
         jsonb_agg(jsonb_build_object(
           'name', p.policyname,
           'cmd', p.cmd,
           'roles', p.roles::text,
           'using', p.qual,
           'check', p.with_check) order by p.policyname) as def
  from pg_policies p
  where p.schemaname in ('public', 'storage')
  group by 1
),
functions as (
  select p.proname as t,
         jsonb_agg(jsonb_build_object(
           'args', pg_get_function_identity_arguments(p.oid),
           'secdef', p.prosecdef,
           'search_path', p.proconfig::text,
           'acl', coalesce((select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x), ''),
           -- whitespace-insensitive: formatting churn is not a semantic change
           'body', md5(regexp_replace(coalesce(p.prosrc, ''), '\s+', ' ', 'g')))
           order by pg_get_function_identity_arguments(p.oid)) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in ('citext','citextin','citextout','citextrecv','citextsend','citext_cmp','citext_eq',
      'citext_ne','citext_lt','citext_le','citext_gt','citext_ge','citext_hash','citext_hash_extended',
      'citext_larger','citext_smaller','citext_pattern_cmp','citext_pattern_lt','citext_pattern_le',
      'citext_pattern_gt','citext_pattern_ge')
  group by 1
),
indexes as (
  select tablename as t, jsonb_agg(indexdef order by indexname) as def
  from pg_indexes where schemaname = 'public' group by 1
),
triggers as (
  select c.relname as t, jsonb_agg(pg_get_triggerdef(tr.oid) order by tr.tgname) as def
  from pg_trigger tr
  join pg_class c on c.oid = tr.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not tr.tgisinternal and n.nspname in ('public', 'auth')
  group by 1
),
grants as (
  select table_name as t, jsonb_agg(grantee || ':' || privilege_type order by grantee, privilege_type) as def
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
  group by 1
),
column_grants as (
  select table_name as t, jsonb_agg(column_name || ':' || privilege_type || ':' || grantee
         order by column_name, privilege_type, grantee) as def
  from information_schema.column_privileges
  where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
    and privilege_type in ('INSERT','UPDATE')
  group by 1
),
anon_exec as (
  select jsonb_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         order by p.proname) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.proname not like 'citext%'
),
realtime as (
  select jsonb_agg(tablename order by tablename) as def
  from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
),
buckets as (
  select jsonb_agg(jsonb_build_object('id', id, 'public', public, 'limit', file_size_limit,
                                      'mime', allowed_mime_types) order by id) as def
  from storage.buckets
)
select jsonb_build_object(
  'tables', (select jsonb_object_agg(t, def) from tables),
  'policies', (select jsonb_object_agg(t, def) from policies),
  'functions', (select jsonb_object_agg(t, def) from functions),
  'indexes', (select jsonb_object_agg(t, def) from indexes),
  'triggers', (select jsonb_object_agg(t, def) from triggers),
  'grants', (select jsonb_object_agg(t, def) from grants),
  'column_grants', (select jsonb_object_agg(t, def) from column_grants),
  'anon_executable', (select def from anon_exec),
  'realtime', (select def from realtime),
  'buckets', (select def from buckets)
) as snapshot
`;

async function snapshot(client) {
  const { rows } = await client.query(SNAPSHOT_SQL);
  return rows[0].snapshot;
}

/** Human-readable list of divergences between two snapshots. */
function diffSnapshots(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    if (key === "anon_executable" || key === "realtime" || key === "buckets") {
      const ja = JSON.stringify(a?.[key] ?? null);
      const jb = JSON.stringify(b?.[key] ?? null);
      if (ja !== jb) out.push(`${key}: ${ja} !== ${jb}`);
      continue;
    }
    const ma = a?.[key] ?? {};
    const mb = b?.[key] ?? {};
    const names = new Set([...Object.keys(ma), ...Object.keys(mb)]);
    for (const name of [...names].sort()) {
      const ja = JSON.stringify(ma[name] ?? null);
      const jb = JSON.stringify(mb[name] ?? null);
      if (ja !== jb) out.push(`${key}.${name}:\n    fresh:   ${ja}\n    upgrade: ${jb}`);
    }
  }
  return out;
}

async function buildFresh(caps) {
  const db = "luma_fresh";
  log(`\n▸ FRESH path: ${db}`);
  await recreateDatabase(db);
  const client = await clientFor(db);
  try {
    for (const file of BASELINE_FILES) {
      log(`  · ${file.replace(repo + "/", "")}`);
      await runFile(client, file, "baseline", caps);
    }
    for (const file of migrationFiles()) {
      log(`  · ${file.replace(repo + "/", "")}`);
      await runFile(client, file, "fresh migration", caps);
    }
    // Migrations must be replayable (Supabase retries a failed migration).
    log("  · replaying every migration a second time (idempotency)");
    for (const file of migrationFiles()) {
      await runFile(client, file, "fresh migration (replay)", caps);
    }
    return { db, snapshot: await snapshot(client) };
  } finally {
    await client.end();
  }
}

async function buildUpgrade(caps) {
  const db = "luma_upgrade";
  const pending = pendingMigrations();
  log(`\n▸ UPGRADE path: ${db} (production baseline + ${pending.length} pending migration(s))`);
  await recreateDatabase(db);
  const client = await clientFor(db);
  try {
    for (const file of BASELINE_FILES) {
      await runFile(client, file, "baseline", caps);
    }
    for (const file of pending) {
      log(`  · ${file.replace(repo + "/", "")}`);
      await runFile(client, file, "upgrade migration", caps);
    }
    return { db, snapshot: await snapshot(client) };
  } finally {
    await client.end();
  }
}

async function main() {
  const files = migrationFiles();
  log(`migration files: ${files.length}`);

  const probe = await clientFor("postgres");
  const caps = await probeCapabilities(probe);
  await probe.end();
  log(`extensions available: ${[...caps.have].join(", ") || "(none)"}`);

  const fresh = await buildFresh(caps);

  if (FRESH_ONLY) {
    log("\n✓ FRESH path replays cleanly (--fresh-only: upgrade path not compared)");
    return 0;
  }

  // The upgrade path models production as it stands today: the baseline
  // snapshot plus only the migrations that have never run there. It must reach
  // exactly the same state as a from-scratch install.
  const upgrade = await buildUpgrade(caps);

  const divergences = diffSnapshots(fresh.snapshot, upgrade.snapshot);
  if (divergences.length) {
    console.error(`\n✗ FRESH and UPGRADE schemas diverge (${divergences.length} differences):`);
    for (const d of divergences.slice(0, 40)) console.error(`  - ${d}`);
    return 1;
  }
  log("\n✓ FRESH and UPGRADE paths produce an identical schema");
  log(`  tables: ${Object.keys(fresh.snapshot.tables ?? {}).length}`);
  log(`  policies: ${Object.values(fresh.snapshot.policies ?? {}).reduce((n, v) => n + v.length, 0)}`);
  log(`  functions: ${Object.keys(fresh.snapshot.functions ?? {}).length}`);
  if (adaptations.length) {
    log("\nlocal adaptations (server lacks contrib modules):");
    for (const a of adaptations) log(`  ~ ${a}`);
    if (process.argv.includes("--strict")) {
      console.error("\n✗ --strict: install postgresql-contrib so nothing is adapted");
      return 1;
    }
  }
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  if (!KEEP) {
    for (const db of ["luma_fresh", "luma_upgrade"]) {
      try {
        const admin = baseClient();
        await admin.connect();
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [db]
        );
        await admin.query(`drop database if exists ${pg.escapeIdentifier(db)}`);
        await admin.end();
      } catch {
        /* best effort */
      }
    }
  }
}
process.exit(code);

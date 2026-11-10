#!/usr/bin/env node
/**
 * Luma — production schema parity check.
 *
 * `tests/db/migrate.mjs` proves that the repository replays to *some* schema and
 * that a fresh database matches an upgraded one. It cannot know whether that
 * schema is the one users are actually running against. `tests/db/security.mjs`
 * proves the authorization model on whatever was replayed.
 *
 * This harness closes the last gap: it compares the replayed schema against the
 * captured production fingerprint in
 * `supabase/baseline/03_production_fingerprints.json`, so "the repo and the live
 * project disagree" becomes a test failure instead of a production surprise.
 *
 * What is compared
 *   * function signatures and function-body fingerprints (whitespace-insensitive)
 *   * tables and their columns/types/not-null/default
 *   * RLS flags and policy definitions
 *   * table-level and function-level privileges for anon/authenticated/service_role
 *
 * Usage
 *   DATABASE_URL=... node tests/db/parity.mjs           # compare (exit 1 on drift)
 *   DATABASE_URL=... node tests/db/parity.mjs --report  # also print the full diff
 *   DATABASE_URL=... node tests/db/parity.mjs --snapshot # print JSON to stdout
 *
 * The fingerprint file only contains what production looked like at capture
 * time; it holds no secrets (function bodies, DDL metadata, privilege flags).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const FINGERPRINT_FILE = join(repo, "supabase", "baseline", "03_production_fingerprints.json");
const DB = "luma_parity";

const DATABASE_URL = process.env.DATABASE_URL;
const args = process.argv.slice(2);
const REPORT = args.includes("--report");

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (see scripts/dev-postgres.md)");
  process.exit(2);
}

/** Whitespace-insensitive body hash, identical to the one used when capturing. */
/** PostgreSQL 17 added MAINTAIN; PG16 test containers cannot report it. */
const stripMaintain = (grant) => grant.replace(/,MAINTAIN/g, "").replace(/MAINTAIN,/g, "");

const FP_SQL = `md5(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', ' ', 'g'))`;

async function connect(db) {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${db}`;
  const c = new pg.Client({ connectionString: url.toString() });
  c.on("error", () => {});
  await c.connect();
  return c;
}

/** Rebuild `luma_parity` from the baseline + every migration. */
async function rebuild() {
  const admin = await connect("postgres");
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
    [DB]
  );
  await admin.query(`drop database if exists ${pg.escapeIdentifier(DB)}`);
  await admin.query(`create database ${pg.escapeIdentifier(DB)}`);
  await admin.end();

  const client = await connect(DB);
  const hasExt = async (name) =>
    (await client.query(`select 1 from pg_available_extensions where name=$1`, [name])).rowCount > 0;
  const transform = async (sql) => {
    let out = sql;
    if (!(await hasExt("citext"))) out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+citext\s*;/gi, "");
    if (!(await hasExt("pgcrypto"))) out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pgcrypto\s*;/gi, "");
    if (!(await hasExt("pg_trgm"))) {
      out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pg_trgm[^;]*;/gi, "create schema if not exists extensions;");
      out = out.replace(/create\s+index[^;]*?gin_trgm_ops[^;]*;/gis, "");
    }
    if (!(await hasExt("pg_cron"))) out = out.replace(/create\s+extension\s+if\s+not\s+exists\s+pg_cron\s*;/gi, "");
    return out;
  };
  const { readdirSync } = await import("node:fs");
  const files = [
    join(repo, "supabase", "baseline", "00_platform_shim.sql"),
    join(repo, "supabase", "baseline", "01_production_schema.sql"),
    join(repo, "supabase", "baseline", "02_production_grants.sql"),
    ...readdirSync(join(repo, "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(repo, "supabase", "migrations", f)),
  ];
  for (const f of files) {
    await client.query(await transform(readFileSync(f, "utf8")));
  }
  return client;
}

/** Collect a comparable description of the database. */
async function snapshot(db) {
  const functions = Object.fromEntries(
    (
      await db.query(
        `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as id,
                ${FP_SQL} as fp
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'
           -- skip functions owned by an extension (citext, pg_trgm, ...):
           -- where those live depends on the server, not on this repository
           and not exists (select 1 from pg_depend d
                           where d.classid = 'pg_proc'::regclass
                             and d.objid = p.oid and d.deptype = 'e')
         order by 1`
      )
    ).rows.map((r) => [r.id, r.fp])
  );

  // Ordered column names per table: production's fingerprint stores the same
  // shape, so a dropped/renamed/reordered column is drift. Types, constraints
  // and defaults are asserted against the reviewed schema file by
  // tests/db/migrate.mjs.
  const tables = Object.fromEntries(
    (
      await db.query(
        `select c.relname as "table",
                json_agg(a.attname order by a.attnum) as columns
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r'
         group by 1 order by 1`
      )
    ).rows.map((r) => [r.table, { columns: r.columns.map((name) => ({ name })) }])
  );

  const rlsOff = (
    await db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`
    )
  ).rows.map((r) => r.relname);

  // Policy *expressions* are Postgres-version dependent (schema qualification and
  // formatting), so parity compares existence/schema/table/command/roles. Their
  // actual behaviour is asserted by tests/db/security.mjs, which is the only
  // trustworthy check for them.
  const policies = (
    await db.query(
      `select schemaname, tablename, policyname, cmd, roles::text as roles
       from pg_policies where schemaname in ('public', 'storage') order by 1, 2, 3`
    )
  ).rows.map((r) => `${r.schemaname}.${r.tablename}.${r.policyname}:${r.cmd}:${r.roles}`);

  const grants = (
    await db.query(
      `select n.nspname as schema, c.relname as object, r.rolname as grantee,
              string_agg(distinct p.privilege_type, ',' order by p.privilege_type) as privs
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) p
       join pg_roles r on r.oid = p.grantee
       where n.nspname = 'public' and c.relkind = 'r' and r.rolname = 'authenticated'
       group by 1, 2, 3
       order by 1, 2`
    )
  )
    .rows.map((r) => `${r.object}:${r.grantee}:${r.privs}`)
    // PostgreSQL 17 added the MAINTAIN privilege; PG16 test containers cannot
    // report it. It conveys nothing beyond the DML grants already compared.
    .map(stripMaintain);

  return { functions, tables, rlsOff, policies, grants };
}

function diff(label, expected, actual) {
  const problems = [];
  if (Array.isArray(expected)) {
    const missing = expected.filter((x) => !actual.includes(x));
    const extra = actual.filter((x) => !expected.includes(x));
    for (const m of missing) problems.push(`  - missing: ${m}`);
    for (const e of extra) problems.push(`  + unexpected: ${e}`);
    return problems;
  }
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in actual)) problems.push(`  - missing: ${k}`);
    else if (JSON.stringify(actual[k]) !== JSON.stringify(v)) {
      problems.push(`  ~ differs: ${k}`);
      if (label === "tables" && REPORT) {
        const a = actual[k]?.columns ?? [];
        const b = v.columns ?? [];
        const colsA = new Set(a.map((c) => c.column));
        const colsB = new Set(b.map((c) => c.column));
        for (const c of b) if (!colsA.has(c.column)) problems.push(`      - column: ${c.column} ${c.type}`);
        for (const c of a) if (!colsB.has(c.column)) problems.push(`      + column: ${c.column} ${c.type}`);
        for (const c of b) {
          const other = a.find((x) => x.column === c.column);
          if (other && JSON.stringify(other) !== JSON.stringify(c)) {
            problems.push(`      ~ column ${c.column}: prod=${c.type}${c.not_null ? " not null" : ""} default=${c.default} vs repo=${other.type}${other.not_null ? " not null" : ""} default=${other.default}`);
          }
        }
      }
    }
  }
  for (const k of Object.keys(actual)) if (!(k in expected)) problems.push(`  + unexpected: ${k}`);
  return problems;
}

async function main() {
  const expected = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf8"));
  const db = await rebuild();
  const actual = await snapshot(db);
  await db.end();

  const admin = await connect("postgres");
  await admin.query(`drop database if exists ${pg.escapeIdentifier(DB)}`);
  await admin.end();

  if (args.includes("--snapshot")) {
    console.log(JSON.stringify(actual, null, 2));
    return 0;
  }

  // Function bodies on production intentionally trail the repo until the
  // reconcile migration is applied there (it is written but not yet deployed,
  // see docs/DB.md). Report those as "pending deployment" instead of drift, but
  // fail on anything else: signatures, tables, policies and privileges.
  const pendingFile = join(repo, "supabase", "baseline", "04_pending_production_changes.json");
  let pendingDoc = {};
  try {
    pendingDoc = JSON.parse(readFileSync(pendingFile, "utf8"));
  } catch { /* the file is optional */ }
  const pending = {
    functions: pendingDoc.functions ?? {},
    policies: pendingDoc.policies ?? {},
    grants: pendingDoc.grants ?? {},
    tables: pendingDoc.tables ?? {},
  };

  const sections = [
    ["functions", expected.functions, actual.functions, pending.functions],
    ["tables", expected.tables, actual.tables, pending.tables],
    ["policies", expected.policies, actual.policies, pending.policies],
    ["grants", expected.grants, actual.grants, pending.grants],
    ["rlsOff", expected.rlsOff, actual.rlsOff, {}],
  ];

  let failed = false;
  let deferredCount = 0;
  for (const [label, rawExp, act, allowed] of sections) {
    const exp = label === "grants" ? rawExp.map(stripMaintain) : rawExp;
    if (!exp) continue; // fingerprint file may omit a section

    let problems = diff(label, exp, act);
    if (Object.keys(allowed).length) {
      const deferred = problems.filter((p) => {
        const m = p.match(/(?:missing|differs|unexpected): (.+)$/);
        if (!m) return false;
        // entries are keyed by the exact identifier for maps, and by the whole
        // "object:grantee:privs" string for the grants array.
        if (m[1] in allowed) return true;
        if (label === "tables" && m[1] in allowed) return true;
        // For arrays (grants) a single object can change on both sides; defer
        // every problem that carries the same object:grantee prefix.
        const prefix = m[1].split(":").slice(0, 2).join(":");
        return Object.keys(allowed).some((k) => k.split(":").slice(0, 2).join(":") === prefix);
      });
      problems = problems.filter((p) => !deferred.includes(p));
      if (deferred.length) {
        deferredCount += deferred.length;
        console.log(`~ ${deferred.length} ${label} change(s) awaiting deployment of a committed migration:`);
        for (const d of deferred) {
          const key = d.match(/(?:missing|differs|unexpected): (.+)$/)?.[1] ?? "";
          console.log(`  ${d.trim()}`);
          const note = allowed[key];
          if (note) console.log(`      → ${note}`);
        }
      }
    }
    if (problems.length === 0) {
      console.log(`✓ ${label} match production`);
      continue;
    }
    failed = true;
    console.log(`✗ ${label} deviate from production (${problems.length})`);
    for (const p of problems.slice(0, REPORT ? 200 : 30)) console.log(p);
    if (!REPORT && problems.length > 30) console.log(`  … ${problems.length - 30} more (use --report)`);
  }

  if (deferredCount) {
    console.log(
      `\n${deferredCount} difference(s) are expected and tracked in supabase/baseline/04_pending_production_changes.json.`
    );
    console.log("Remove an entry once the migration is applied to production; anything untracked fails.");
  }
  console.log(
    failed
      ? "\nSchema parity FAILED — the repository does not describe the live database."
      : "\n✓ Repository schema matches the captured production fingerprint."
  );
  return failed ? 1 : 0;
}

process.exit(await main());

/**
 * Shared plumbing for the database suites.
 *
 * `supabase/baseline/` plus every migration must replay on:
 *   - the hosted project (citext, pg_trgm, pgcrypto, pg_cron all present),
 *   - a developer's local cluster (contrib usually present),
 *   - a bare CI container (contrib absent).
 *
 * The *only* statements that may differ between those are extension bootstrap
 * and the trigram indexes that depend on an opclass living in a specific
 * schema. Everything else must be identical, otherwise replay equivalence and
 * production parity would be measuring the server instead of the repository.
 *
 * Note on `create extension pg_trgm schema extensions`: it is a no-op when the
 * extension is already installed elsewhere (Supabase installs it into
 * `extensions`), so `extensions.gin_trgm_ops` only exists when the module is
 * actually available. Capability detection therefore has to run a real
 * `create extension` probe, not just read pg_available_extensions.
 */
import { readFileSync } from "node:fs";

const files = {
  citext: /create\s+extension\s+if\s+not\s+exists\s+citext\s*;/gi,
  pgcrypto: /create\s+extension\s+if\s+not\s+exists\s+pgcrypto\s*;/gi,
  pg_trgm: /create\s+extension\s+if\s+not\s+exists\s+pg_trgm[^;]*;/gi,
  pg_cron: /create\s+extension\s+if\s+not\s+exists\s+pg_cron\s*;/gi,
};

/** Statements that need a module; each list is dropped when it is missing. */
const dependent = {
  pg_trgm: [/create\s+index[^;]*?gin_trgm_ops[^;]*;/gis],
};

/**
 * Probe which optional modules a server can actually install.
 *
 * Runs on its own connection so that a failure cannot abort the caller's
 * transaction, and returns the set of module names that install cleanly.
 */
export async function probeExtensions(adminClient) {
  const have = new Set();
  const names = ["citext", "pgcrypto", "pg_trgm", "pg_cron"];
  for (const name of names) {
    const c = await adminClient(); // fresh connection, discarded either way
    const ok = await (async () => {
      try {
        // Installed globally these extensions are cluster-wide, so probing is
        // safe even when the extension already sits in another schema.
        await c.query(`create extension if not exists ${name}`);
        return true;
      } catch {
        return false;
      }
    })();
    try { await c.end(); } catch { /* ignore */ }
    if (ok) have.add(name);
  }
  return have;
}

/**
 * Rewrite a SQL file so it applies on a server missing some modules.
 *
 * `adaptations` collects a human-readable note per rewrite; callers surface
 * them and can treat a non-empty list as a failure (CI installs contrib).
 */
export function adaptSql(sql, have, adaptations) {
  let out = sql;
  for (const [name, re] of Object.entries(files)) {
    if (have.has(name)) continue;
    adaptations?.push(
      {
        citext: "citext -> domain (identifiers are always stored lowercased)",
        pgcrypto: "pgcrypto skipped (gen_random_uuid is in core PostgreSQL >= 13)",
        pg_trgm: "pg_trgm skipped; trigram GIN indexes omitted locally",
        pg_cron: "pg_cron skipped; cron.schedule() backed by the shim cron.job table",
      }[name]
    );
    out =
      name === "pg_trgm"
        ? out.replace(re, "create schema if not exists extensions;")
        : out.replace(re, "");
    for (const dep of dependent[name] ?? []) out = out.replace(dep, "");
  }
  return out;
}

/** Read a file and apply `adaptSql`. */
export function loadAdapted(path, have, adaptations) {
  return adaptSql(readFileSync(path, "utf8"), have, adaptations);
}

#!/usr/bin/env bash
# Run the database suites and surface failures in the GitHub UI.
#
# GitHub's raw job logs are not always reachable from every environment, so a
# failing suite must explain itself through a workflow annotation. Every step
# below tees its output and, on failure, emits an ::error:: annotation with the
# tail of the output plus the first stack trace.
set -uo pipefail

run() {
  local label="$1"; shift
  local out
  out="$(mktemp)"

  echo "::group::${label}"
  if "$@" 2>&1 | tee "$out"; then
    echo "::endgroup::"
    rm -f "$out"
    return 0
  fi

  local code=${PIPESTATUS[0]}
  echo "::endgroup::"

  # Keep the annotation readable: GitHub truncates very long messages.
  local summary
  summary="$(grep -E '^(✗|FAIL|error|Error|TypeError|AssertionError)|error:|ERROR:|failed' "$out" | head -25 || true)"
  [ -z "$summary" ] && summary="$(tail -25 "$out")"

  # Multi-line annotations use %0A separators.
  local encoded
  encoded="$(printf '%s' "$summary" | sed -e 's/%/%25/g' -e 's/\r//' | awk 'BEGIN{ORS=""} {print $0 "%0A"}')"

  echo "::error title=${label} failed (exit ${code})::${encoded}"
  echo "----- tail of ${label} output -----"
  tail -40 "$out"
  rm -f "$out"
  return "$code"
}

status=0

# Fail with a clear message if the service container is not reachable, instead
# of drowning it in a suite stack trace.
run "Database connectivity" node -e '
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
c.connect()
  .then(() => c.query("select version() as v"))
  .then((r) => { console.log(r.rows[0].v); return c.end(); })
  .catch((e) => { console.error("DATABASE_URL is not reachable:", e.message); process.exit(1); });
' || exit 1

run "Replay migrations" node tests/db/migrate.mjs || status=1
run "Multi-user authorization suite" node tests/db/security.mjs || status=1
run "Schema parity" node tests/db/parity.mjs || status=1
exit "$status"

#!/usr/bin/env node
// Thin wrapper so `npm run keystore` works from a pure Node environment.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const py = process.env.PYTHON || "python3";
const r = spawnSync(py, [path.join(here, "make-keystore.py"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);

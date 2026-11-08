#!/usr/bin/env node
/**
 * Provision a JDK for the APK build via PyPI (jdk4py) — used by CI where
 * java is not preinstalled and Adoptium's CDN is unreachable.
 * Installs into <repo>/.jdk and prints the bin path.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, ".jdk");
const JAVA = path.join(DEST, "jdk4py", "java-runtime", "bin", "java");

if (fs.existsSync(JAVA)) {
  console.log(JAVA);
  process.exit(0);
}

fs.mkdirSync(DEST, { recursive: true });
console.log("Provisioning JDK via jdk4py…");
try {
  execFileSync("python3", ["-m", "pip", "install", "--quiet", "--target", DEST, "jdk4py"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
} catch {
  const r = spawnSync("python3", ["-m", "pip", "install", "--quiet", "--break-system-packages", "--target", DEST, "jdk4py"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}

if (!fs.existsSync(JAVA)) {
  console.error("jdk4py installed but java binary not found at " + JAVA);
  process.exit(1);
}
console.log(JAVA);

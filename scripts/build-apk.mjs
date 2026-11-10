#!/usr/bin/env node
/**
 * Luma — Gradle-free Release APK builder.
 *
 * Produces a signed, zipaligned APK from the native shell in `mobile/apk-shell`
 * using only the Android SDK build tools (aapt2, d8) + a JDK. No Gradle, no
 * Google Maven, no AndroidX — so it also runs on locked-down CI runners.
 *
 * Toolchain discovery (first match wins):
 *   AAPT2          $AAPT2, node_modules/aaptjs3, $ANDROID_HOME/build-tools/<ver>/aapt2
 *   android.jar    $ANDROID_JAR, node_modules/minapk, $ANDROID_HOME/platforms/<ver>/android.jar
 *   d8.jar         $D8_JAR, node_modules/minapk, $ANDROID_HOME/build-tools/<ver>/lib/d8.jar
 *   apksigner.jar  $APKSIGNER_JAR, node_modules/minapk, build-tools/<ver>/lib/apksigner.jar
 *   java           $JAVA_HOME/bin/java, jdk4py, PATH
 *
 * Usage:
 *   node scripts/build-apk.mjs                 # release, signed with the Luma key
 *   node scripts/build-apk.mjs --debug         # debug build, AOSP debug keystore
 *   node scripts/build-apk.mjs --url https://…  # point the shell at another host
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = path.join(ROOT, "mobile", "apk-shell");
const BUILD = path.join(ROOT, "build", "apk");
const OUT_DIR = path.join(ROOT, "release");
const DIST = path.join(ROOT, "dist");

const argv = process.argv.slice(2);
const DEBUG = argv.includes("--debug");
const urlFlag = argv.indexOf("--url");
const APP_URL =
  urlFlag >= 0 ? argv[urlFlag + 1] : process.env.LUMA_APP_URL || "https://luma-messenger.vercel.app";

const VERSION_NAME = "2.0.0";
const VERSION_CODE = 2;
const MIN_SDK = 23;
const TARGET_SDK = 34;

const log = (...a) => console.log("  " + a.join(" "));
const step = (msg) => console.log(`\n▸ ${msg}`);
const die = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ tools */

function findTool() {
  const exists = (p) => p && fs.existsSync(p);
  const globOne = (base) => {
    if (!exists(base)) return null;
    const dirs = fs
      .readdirSync(base)
      .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return dirs.length ? path.join(base, dirs[0]) : null;
  };

  // --- aapt2
  const aapt2Candidates = [
    process.env.AAPT2,
    path.join(ROOT, "node_modules/aaptjs3/bin/x64/linux/aapt2"),
    path.join(ROOT, "node_modules/aaptjs3/bin/x64/darwin/aapt2"),
    "/tmp/pk/package/bin/x64/linux/aapt2",
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "build-tools"),
  ];
  let aapt2 = null;
  for (const c of aapt2Candidates) {
    if (!c) continue;
    if (c.endsWith(path.sep + "build-tools")) {
      const bt = globOne(c);
      if (bt && exists(path.join(bt, "aapt2"))) {
        aapt2 = path.join(bt, "aapt2");
        break;
      }
    } else if (exists(c)) {
      aapt2 = c;
      fs.chmodSync(c, 0o755);
      break;
    }
  }

  // --- android.jar / d8 / apksigner
  const mp = path.join(ROOT, "mobile", "apk-shell", "libs");
  const mpNpm = path.join(ROOT, "node_modules/@drxiaozhi/minapk/tools");
  const buildTools = process.env.ANDROID_HOME
    ? globOne(path.join(process.env.ANDROID_HOME, "build-tools"))
    : null;
  const platforms = process.env.ANDROID_HOME
    ? globOne(path.join(process.env.ANDROID_HOME, "platforms"))
    : null;

  const androidJar =
    [
      process.env.ANDROID_JAR,
      path.join(mp, "android.jar"),
      path.join(mpNpm, "android.jar"),
      platforms && path.join(platforms, "android.jar"),
    ].find(exists) ?? null;

  const d8Jar =
    [
      process.env.D8_JAR,
      path.join(mp, "d8.jar"),
      path.join(mpNpm, "d8.jar"),
      buildTools && path.join(buildTools, "lib", "d8.jar"),
    ].find(exists) ?? null;

  const apksignerJar =
    [
      process.env.APKSIGNER_JAR,
      path.join(mp, "apksigner.jar"),
      path.join(mpNpm, "apksigner.jar"),
      buildTools && path.join(buildTools, "lib", "apksigner.jar"),
    ].find(exists) ?? null;

  const ecjJar =
    [process.env.ECJ_JAR, path.join(mp, "ecj-3.45.0.jar"), path.join(mpNpm, "ecj-3.45.0.jar")].find(
      exists
    ) ?? null;

  // --- java
  const javaCandidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", "java"),
    path.join(ROOT, ".jdk/jdk4py/java-runtime/bin/java"),
    path.join(ROOT, ".jdk/java-runtime/bin/java"),
    "/tmp/venv/lib/python3.11/site-packages/jdk4py/java-runtime/bin/java",
  ].filter(Boolean);
  let java = javaCandidates.find(exists) ?? null;
  if (!java) {
    try {
      execFileSync("java", ["-version"], { stdio: "ignore" });
      java = "java";
    } catch {
      /* not installed */
    }
  }

  return { aapt2, androidJar, d8Jar, apksignerJar, ecjJar, java };
}

const T = findTool();
const missing = Object.entries(T).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  die(
    `Missing build tools: ${missing.join(", ")}.\n` +
      "  Run `npm install` (installs aaptjs3 + minapk binaries) or set AAPT2 / ANDROID_JAR / D8_JAR / APKSIGNER_JAR / JAVA_HOME."
  );
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 64,
      ...opts,
    });
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).join("\n");
    die(`${path.basename(cmd)} failed:\n${out || err.message}`);
  }
}

/* --------------------------------------------------------------- clean up */

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`
╭──────────────────────────────────────────────╮
│  Luma — Android ${DEBUG ? "debug  " : "release"} APK build          │
╰──────────────────────────────────────────────╯
  url      ${APP_URL}
  java     ${T.java}
  aapt2    ${T.aapt2}
  d8       ${T.d8Jar}
  signer   ${T.apksignerJar}`);

/* ------------------------------------------- 1. patch the shell's target */

step("Preparing native shell");
const javaSrcDir = path.join(BUILD, "src/app/luma/messenger");
const assetsDir = path.join(BUILD, "assets/public");
fs.mkdirSync(javaSrcDir, { recursive: true });
fs.mkdirSync(path.join(BUILD, "src"), { recursive: true });

// Copy + retarget the activity's APP_URL constant.
const activitySrc = fs
  .readFileSync(path.join(SHELL, "java/app/luma/messenger/MainActivity.java"), "utf8")
  .replace(
    /private static final String APP_URL = "[^"]*";/,
    `private static final String APP_URL = "${APP_URL}";`
  );
fs.writeFileSync(path.join(javaSrcDir, "MainActivity.java"), activitySrc);
log(`MainActivity.java → APP_URL=${APP_URL}`);

// Bundle the compiled web app so the shell still boots something meaningful
// offline (the live URL is always preferred when online).
const assetsRoot = path.join(assetsDir);
fs.mkdirSync(assetsRoot, { recursive: true });
if (fs.existsSync(DIST)) {
  fs.cpSync(DIST, assetsRoot, { recursive: true });
  log(`embedded web build (${(dirSize(DIST) / 1024 / 1024).toFixed(1)} MB) from dist/`);
} else {
  log("dist/ not found — shell will rely on the live URL only");
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/* ---------------------------------------------- 2. compile resources (aapt2) */

step("Compiling resources (aapt2)");
const flatZip = path.join(BUILD, "resources.zip");
run(T.aapt2, ["compile", "--dir", path.join(SHELL, "res"), "-o", flatZip]);
log("resources compiled");

step("Linking resources + manifest");
const unsignedApk = path.join(BUILD, "luma-unsigned.apk");
const manifest = path.join(SHELL, "AndroidManifest.xml");
run(T.aapt2, [
  "link",
  "-o",
  unsignedApk,
  "-I",
  T.androidJar,
  "--manifest",
  manifest,
  "--min-sdk-version",
  String(MIN_SDK),
  "--target-sdk-version",
  String(TARGET_SDK),
  "--version-code",
  String(VERSION_CODE),
  "--version-name",
  VERSION_NAME,
  "-A",
  assetsDir,
  "--auto-add-overlay",
  "-R",
  flatZip,
]);
log(`linked ${path.basename(unsignedApk)} (${(fs.statSync(unsignedApk).size / 1024).toFixed(0)} KB)`);

/* --------------------------------------------------- 3. compile java (ecj) */

step("Compiling Java sources");
const classesDir = path.join(BUILD, "classes");
fs.mkdirSync(classesDir, { recursive: true });

const javaFiles = [path.join(javaSrcDir, "MainActivity.java")];

if (T.ecjJar) {
  run(T.java, [
    "-jar",
    T.ecjJar,
    "-source",
    "1.8",
    "-target",
    "1.8",
    "-nowarn",
    "-proc:none",
    "-cp",
    T.androidJar,
    "-d",
    classesDir,
    ...javaFiles,
  ]);
  log(`compiled with Eclipse compiler (ecj) → ${javaFiles.length} source file(s)`);
} else {
  die("No Java compiler found (need $ECJ_JAR or minapk). Install emcc/ecj or a full JDK.");
}

/* ------------------------------------------------------ 4. dex (d8) */

step("Dexing classes (d8)");
const dexDir = path.join(BUILD, "dex");
fs.mkdirSync(dexDir, { recursive: true });
run(T.java, [
  "-cp",
  T.d8Jar,
  "com.android.tools.r8.D8",
  "--release",
  "--min-api",
  String(MIN_SDK),
  "--lib",
  T.androidJar,
  "--output",
  dexDir,
  ...walk(classesDir).filter((f) => f.endsWith(".class")),
]);
const dexFile = path.join(dexDir, "classes.dex");
if (!fs.existsSync(dexFile)) die("d8 produced no classes.dex");
log(`classes.dex (${(fs.statSync(dexFile).size / 1024).toFixed(0)} KB)`);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/* ------------------------------- 5. package: add dex + zipalign + sign */

step("Packaging APK");
const packaged = path.join(BUILD, "luma-packaged.apk");
run("zip", ["-q", "-j", unsignedApk, dexFile, "-O", packaged]);

// zipalign 4-byte boundaries (required for >2 GB and for v2+ signature safety).
const aligned = path.join(BUILD, "luma-aligned.apk");
const zipalign = path.join(path.dirname(T.aapt2), "zipalign");
if (fs.existsSync(zipalign)) {
  run(zipalign, ["-p", "-f", "4", packaged, aligned]);
  log("zipaligned (4-byte)");
} else {
  fs.copyFileSync(packaged, aligned);
  log("zipalign not found — apksigner will still align v2 blocks");
}

/* ------------------------------------------------------------- 6. sign */

step("Signing APK");
const keystore = DEBUG
  ? path.join(BUILD, "debug.keystore")
  : path.join(ROOT, "mobile", "keystore", "luma-release.keystore");

if (!fs.existsSync(keystore)) {
  if (!DEBUG) {
    die(
      `Release keystore missing at ${keystore}\n` +
        "  Generate it with: node scripts/make-keystore.mjs"
    );
  }
  run(T.java, [
    "-jar",
    path.join(ROOT, "mobile", "apk-shell", "libs", "apksigner.jar"),
    "sign",
    "--help",
  ], { quiet: true });
  die("Debug keystore not found.");
}

const keystorePass = DEBUG ? "android" : process.env.LUMA_KEYSTORE_PASS;
if (!DEBUG && !keystorePass) {
  die(
    "LUMA_KEYSTORE_PASS is not set.\n" +
      "  The release keystore password must be supplied via the environment — never hardcode it or commit it.\n" +
      "  Generate a keystore with: LUMA_KEYSTORE_PASS=<secret> node scripts/make-keystore.mjs"
  );
}
const keyAlias = DEBUG ? "androiddebugkey" : process.env.LUMA_KEY_ALIAS || "luma";

const outName = DEBUG ? "luma-2.0.0-debug.apk" : "luma-2.0.0.apk";
const finalApk = path.join(OUT_DIR, outName);

run(T.java, [
  "-jar",
  T.apksignerJar,
  "sign",
  "--ks",
  keystore,
  "--ks-pass",
  `pass:${keystorePass}`,
  "--key-pass",
  `pass:${keystorePass}`,
  "--ks-key-alias",
  keyAlias,
  "--min-sdk-version",
  String(MIN_SDK),
  "--v1-signing-enabled",
  "true",
  "--v2-signing-enabled",
  "true",
  "--v3-signing-enabled",
  "true",
  "--out",
  finalApk,
  aligned,
]);
log(`signed → ${path.relative(ROOT, finalApk)}`);

// Verify
const verify = run(
  T.java,
  ["-jar", T.apksignerJar, "verify", "--print-certs", finalApk],
  { quiet: true }
);
const certLine = verify.split("\n").find((l) => l.includes("SHA-256")) ?? "";
log(`verified · ${certLine.replace(/^Signer #1 certificate /, "").slice(0, 90)}`);

// Copy a stable, alias-free name as well.
fs.copyFileSync(finalApk, path.join(OUT_DIR, DEBUG ? "luma-debug.apk" : "luma.apk"));

const size = (fs.statSync(finalApk).size / 1024 / 1024).toFixed(2);
console.log(`
╭──────────────────────────────────────────────╮
│  ✓ APK ready                                 │
╰──────────────────────────────────────────────╯
  file     release/${outName}
  size     ${size} MB
  package  app.luma.messenger
  version  ${VERSION_NAME} (${VERSION_CODE})
  target   ${APP_URL}
`);

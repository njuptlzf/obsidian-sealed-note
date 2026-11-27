#!/usr/bin/env node
/**
 * Obsidian plugin pre-release quality gate.
 *
 * Copy this file into the plugin repo as scripts/preflight.mjs, then run from
 * the repo root:  node scripts/preflight.mjs
 *
 * It reproduces the checks the Obsidian community scanner performs, so a
 * release is not rejected for issues that could have been caught locally.
 * Exit code 0 = all checks passed; 1 = at least one check failed.
 *
 * Options:
 *   --skip-git-clean   do not require a clean working tree (use when running
 *                      the gate before committing the version bump).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const skipGitClean = process.argv.includes("--skip-git-clean");
const failures = [];
const passes = [];

function pass(label, detail = "") {
  passes.push(`${label}${detail ? " — " + detail : ""}`);
  console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
}
function fail(label, detail = "") {
  failures.push(`${label}${detail ? " — " + detail : ""}`);
  console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
}
function section(title) {
  console.log(`\n[${title}]`);
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch (e) {
    return null;
  }
}

/* ---------- 1. Required root files ---------- */
section("Root files");
for (const f of ["README.md", "LICENSE", "manifest.json", "versions.json", "package.json"]) {
  existsSync(join(root, f)) ? pass(`${f} exists`) : fail(`${f} missing`);
}
const buildConfig = ["esbuild.config.mjs", "esbuild.config.js", "rollup.config.js", "vite.config.ts"]
  .find((f) => existsSync(join(root, f)));
buildConfig ? pass("build config exists", buildConfig) : fail("no build config found");

/* ---------- 2. manifest rules ---------- */
section("manifest.json");
const manifest = readJson("manifest.json");
if (!manifest) {
  fail("manifest.json is valid JSON");
} else {
  const id = String(manifest.id ?? "");
  const version = String(manifest.version ?? "");
  const description = String(manifest.description ?? "");
  id && !/\bobsidian\b/i.test(id)
    ? pass("id does not contain 'obsidian'", id)
    : fail("id must be unique and must not contain 'obsidian'", id || "(empty)");
  /^\d+\.\d+\.\d+$/.test(version)
    ? pass("version is pure x.y.z", version)
    : fail("version must be pure x.y.z (no v prefix)", version || "(empty)");
  !/\bobsidian\b/i.test(description)
    ? pass("description does not contain 'Obsidian'")
    : fail("description contains 'Obsidian' (scanner Error) — rephrase, e.g. 'native Markdown editor'");
  manifest.minAppVersion
    ? pass("minAppVersion declared", String(manifest.minAppVersion))
    : fail("minAppVersion missing");
  manifest.authorUrl
    ? pass("authorUrl filled")
    : fail("authorUrl missing (add before submission)");
}

/* ---------- 3. versions.json ---------- */
section("versions.json");
const versions = readJson("versions.json");
if (!versions) {
  fail("versions.json is valid JSON");
} else if (manifest) {
  versions[manifest.version]
    ? pass(`versions.json maps ${manifest.version}`, `-> ${versions[manifest.version]}`)
    : fail(`versions.json missing mapping for ${manifest.version}`);
}

/* ---------- 4. package.json dependency rules ---------- */
section("package.json dependencies");
const pkg = readJson("package.json");
if (!pkg) {
  fail("package.json is valid JSON");
} else {
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const banned of ["builtin-modules", "eslint-plugin-import"]) {
    banned in allDeps
      ? fail(`banned dependency '${banned}'`, "use node:module / transitive instead")
      : pass(`no banned dependency '${banned}'`);
  }
  for (const script of ["lint", "typecheck", "test", "build"]) {
    pkg.scripts?.[script]
      ? pass(`npm script '${script}' present`)
      : fail(`npm script '${script}' missing`);
  }
  const eslintCfg = ["eslint.config.mjs", "eslint.config.js"]
    .find((f) => existsSync(join(root, f)));
  if (eslintCfg) {
    const text = readFileSync(join(root, eslintCfg), "utf8");
    text.includes("obsidianmd.configs.recommended")
      ? pass("eslint config uses obsidianmd.configs.recommended", eslintCfg)
      : fail("eslint config does not spread obsidianmd.configs.recommended");
    /\beslint\s+src\b/.test(JSON.stringify(pkg.scripts ?? {}))
      ? fail("lint script scoped to src only — package.json/manifest checks are skipped; use 'eslint .'")
      : pass("lint script not scoped to src only");
  } else {
    fail("eslint.config.mjs missing — community scanner rules not replicated locally");
  }
}

/* ---------- 5. README screenshot links (zero dead links) ---------- */
section("README screenshot links");
let checkedImages = 0;
let deadImages = 0;
for (const readme of ["README.md", "README.zh-CN.md"]) {
  if (!existsSync(join(root, readme))) continue;
  const text = readFileSync(join(root, readme), "utf8");
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split(/\s+/)[0];
    if (/^https?:\/\//i.test(target)) continue;
    checkedImages++;
    if (!existsSync(resolve(root, target))) {
      deadImages++;
      fail(`${readme} dead image link`, target);
    }
  }
}
checkedImages && deadImages === 0
  ? pass("all README image links resolve", `${checkedImages} images`)
  : !checkedImages
    ? fail("README contains no screenshots", "see README spec — screenshots before Features")
    : null;

/* ---------- 6. CI release workflow with attestation ---------- */
section("Release workflow");
const wfDir = join(root, ".github", "workflows");
let attested = false;
if (existsSync(wfDir)) {
  for (const f of readdirSync(wfDir)) {
    const text = readFileSync(join(wfDir, f), "utf8");
    if (/attest-build-provenance/.test(text)) attested = true;
  }
}
attested
  ? pass("release workflow has artifact attestation")
  : fail("no workflow with actions/attest-build-provenance (scanner Recommendation)");

/* ---------- 7. Build/test pipeline ---------- */
section("Build & test pipeline");
function run(label, command) {
  try {
    // execSync uses a shell, which resolves npm/npm.cmd on both Windows and
    // POSIX; execFileSync("npm", ...) fails with ENOENT on Windows.
    execSync(command, { cwd: root, stdio: "pipe", encoding: "utf8", shell: true });
    pass(label);
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    fail(label, out || "command failed");
  }
}
if (pkg?.scripts?.lint) run("npm run lint", "npm run lint");
if (pkg?.scripts?.typecheck) run("npm run typecheck", "npm run typecheck");
if (pkg?.scripts?.test) run("npm test", "npm test");
if (pkg?.scripts?.build) run("npm run build", "npm run build");

/* ---------- 8. Clean working tree (before tagging) ---------- */
section("Git state");
if (skipGitClean) {
  console.log("  SKIP  git clean check (--skip-git-clean)");
} else {
  try {
    const status = execSync("git status --porcelain", {
      cwd: root, stdio: "pipe", encoding: "utf8", shell: true,
    }).trim();
    status === ""
      ? pass("working tree clean")
      : fail("working tree has uncommitted changes — commit before tagging", status.split("\n").slice(0, 8).join(", "));
  } catch (e) {
    fail("git status check", "not a git repository or git unavailable");
  }
}

/* ---------- Summary ---------- */
console.log(`\n===== Preflight result: ${passes.length} passed, ${failures.length} failed =====`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  - " + f);
  console.log("\nDo NOT tag or publish until every failure is fixed. No suppressions.");
  process.exit(1);
}
console.log("All checks passed. Safe to commit/tag/publish.");

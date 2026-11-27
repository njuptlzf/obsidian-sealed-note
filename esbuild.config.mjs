import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import { rmSync, mkdirSync } from "fs";

// Node's built-in list is the maintainer-backed replacement for the deprecated
// `builtin-modules` package; prefix both bare and node: specifiers.
const builtins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

const banner = `/*
Sealed Note for Obsidian - bundled build.
Source is TypeScript under src/. Do not edit main.js directly.
*/`;

const prod = process.argv[2] === "production";
const testMode = process.argv[2] === "test";

if (testMode) {
  rmSync("dist-tests", { recursive: true, force: true });
  mkdirSync("dist-tests", { recursive: true });
  // Each test file gets its own bundle so the obsidian alias can differ:
  // the smoke test runs the real plugin against a stub API.
  const shared = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outExtension: { ".js": ".mjs" },
    sourcemap: "inline",
    logLevel: "info",
  };
  await esbuild.build({
    ...shared,
    entryPoints: ["tests/index.test.ts", "tests/compat.test.ts"],
    outdir: "dist-tests",
    alias: { obsidian: "./tests/obsidian-stub.ts" },
    external: ["qrcode"],
  });
  await esbuild.build({
    ...shared,
    entryPoints: ["tests/smoke.test.ts"],
    outdir: "dist-tests",
    alias: { obsidian: "./tests/obsidian-stub.ts" },
    // qrcode pulls in Node built-ins through a dynamic require; the smoke test
    // never renders a QR, so externalize it for the test bundle only.
    external: ["qrcode"],
  });
  process.exit(0);
}

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
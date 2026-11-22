/**
 * Deploy the built plugin into an Obsidian vault's plugin directory.
 *
 *   npm run deploy
 *   npm run deploy -- "D:/work/obsidian"
 *
 * Refuses to overwrite an installed plugin unless it is this plugin, so a typo
 * in the vault path cannot clobber someone else's files.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "fs";
import { join, resolve } from "path";
import process from "process";

const pluginId = JSON.parse(readFileSync("manifest.json", "utf8")).id;
const vault = resolve(process.argv[2] || process.env.OBSIDIAN_VAULT || "D:/work/obsidian");

if (!existsSync(vault)) {
  console.error(`找不到保管库目录：${vault}`);
  process.exit(1);
}

const obsidianDir = join(vault, ".obsidian");
if (!existsSync(obsidianDir)) {
  console.error(`${vault} 看起来不是 Obsidian 保管库（缺少 .obsidian 目录）`);
  process.exit(1);
}

const target = join(obsidianDir, "plugins", pluginId);

if (existsSync(target)) {
  const existingManifest = join(target, "manifest.json");
  if (existsSync(existingManifest)) {
    const existing = JSON.parse(readFileSync(existingManifest, "utf8"));
    if (existing.id !== pluginId) {
      console.error(`目标目录已存在且属于其他插件（${existing.id}），拒绝覆盖：${target}`);
      process.exit(1);
    }
  }
}

mkdirSync(target, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  if (!existsSync(file)) {
    console.error(`缺少构建产物：${file}，请先运行 npm run build`);
    process.exit(1);
  }
  copyFileSync(file, join(target, file));
}

// Keep the offline tool alongside the plugin so it is easy to find and copy.
const toolsDir = join(target, "tools");
mkdirSync(toolsDir, { recursive: true });
cpSync("tools/decrypt.html", join(toolsDir, "decrypt.html"));

// Enable the plugin so the user does not have to hunt for the toggle.
const communityPath = join(obsidianDir, "community-plugins.json");
let enabled = [];
if (existsSync(communityPath)) {
  try {
    enabled = JSON.parse(readFileSync(communityPath, "utf8"));
    if (!Array.isArray(enabled)) enabled = [];
  } catch {
    enabled = [];
  }
}
if (!enabled.includes(pluginId)) {
  enabled.push(pluginId);
  writeFileSync(communityPath, JSON.stringify(enabled, null, 2) + "\n", "utf8");
}

console.log(`已部署到 ${target}`);
console.log(`启用状态：community-plugins.json 中已包含 ${pluginId}`);
console.log("在 Obsidian 中按 Ctrl+R（或关闭重开）重新加载，然后在 设置 → 第三方插件 中确认已开启。");
console.log(`离线解密工具：${join(target, "tools", "decrypt.html")}`);
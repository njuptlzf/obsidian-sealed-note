import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output, tests and Node build scripts are not plugin source.
  globalIgnores([
    "node_modules",
    "dist-tests",
    "main.js",
    "esbuild.config.mjs",
    "eslint.config.mjs",
    "debug",
    "docs",
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
]);

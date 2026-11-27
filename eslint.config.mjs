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
    // Test files are bundled by esbuild outside the tsconfig project; they are
    // exercised by `npm test` rather than the plugin-source lint rules.
    "tests",
    "scripts",
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

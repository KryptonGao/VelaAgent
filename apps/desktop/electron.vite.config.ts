import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const root = dirname(fileURLToPath(import.meta.url));
const shared = resolve(root, "../../packages/shared/src/index.ts");
const agent = resolve(root, "../../packages/agent/src/index.ts");
const tools = resolve(root, "../../packages/tools/src/index.ts");
const workspace = resolve(root, "../../packages/workspace/src/index.ts");

const workspaceAlias = {
  "@vela/shared": shared,
  "@vela/agent": agent,
  "@vela/tools": tools,
  "@vela/workspace": workspace,
};

export default defineConfig({
  main: {
    plugins: [{
      name: "vela-builtin-browser-skill",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "skills/browser-use/SKILL.md",
          source: readFileSync(resolve(root, "../../packages/agent/skills/browser-use/SKILL.md"), "utf8") });
      },
    }],
    resolve: { alias: workspaceAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(root, "src/main/index.ts"), "browser-repl-worker": resolve(root, "src/main/browser-repl-worker.ts") },
        output: { format: "es", entryFileNames: "[name].mjs" },
      },
      externalizeDeps: {
        exclude: ["@vela/shared", "@vela/agent", "@vela/tools", "@vela/workspace"],
        include: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
      },
    },
  },
  preload: {
    resolve: { alias: { "@vela/shared": shared } },
    build: {
      externalizeDeps: {
        exclude: ["@vela/shared"],
      },
    },
  },
  renderer: {
    resolve: { alias: { "@vela/shared": shared } },
    plugins: [react()],
  },
});

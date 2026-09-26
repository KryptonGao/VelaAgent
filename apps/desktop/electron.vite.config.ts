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
    resolve: { alias: workspaceAlias },
    build: {
      rollupOptions: {
        output: { format: "es" },
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

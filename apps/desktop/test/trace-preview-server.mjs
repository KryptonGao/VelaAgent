import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root: desktop,
  configFile: false,
  plugins: [react()],
  resolve: {
    alias: {
      "@vela/shared": resolve(desktop, "../../packages/shared/src/index.ts"),
    },
  },
  optimizeDeps: { entries: ["test/trace-preview.html", "test/changes-preview.html", "test/image-viewer-preview.html", "test/version-control-preview.html"] },
  server: { port: 5179, host: "127.0.0.1" },
});
await server.listen();
console.log(
  [
    "UI fixtures:",
    "  trace:   http://127.0.0.1:5179/test/trace-preview.html (append ?count=10000 for the large-event case)",
      "  changes: http://127.0.0.1:5179/test/changes-preview.html (append ?mode=preview to render Markdown)",
      "  review:  http://127.0.0.1:5179/test/turn-review-preview.html (append ?checks=1 for interaction checks)",
      "  images:  http://127.0.0.1:5179/test/image-viewer-preview.html (click a thumbnail for the full-screen viewer)",
      "  vcs:     http://127.0.0.1:5179/test/version-control-preview.html (append ?page=history|pr)",
      "  motion:  http://127.0.0.1:5179/test/motion-batch3-preview.html (append ?checks=1 for Batch 3 checks)",
  ].join("\n"),
);

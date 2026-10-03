import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { SandboxApprovalRequest } from "@vela/shared";

let server: ViteDevServer;
let banner: typeof import("../src/renderer/components/composer/ApprovalBanner.tsx");
let locale: typeof import("../src/renderer/locale.ts");

before(async () => {
  // Use the renderer's JSX transform without opening a browser or loading Electron.
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    esbuild: { jsx: "automatic" },
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  banner = await server.ssrLoadModule("/src/renderer/components/composer/ApprovalBanner.tsx");
  locale = await server.ssrLoadModule("/src/renderer/locale.ts");
});

after(async () => {
  await server?.close();
});

function render(approval: SandboxApprovalRequest, language: "en" | "zh-CN" = "en"): string {
  locale.setActiveLocale(language);
  return renderToStaticMarkup(createElement(banner.ApprovalBanner, { approval, onReply: () => {} }));
}

const approval: SandboxApprovalRequest = {
  id: "mcp-approval",
  kind: "mcp",
  command: "bash text must not be displayed",
  path: "/path-must-not-be-displayed",
  cwd: "/repo",
  createdAt: 0,
  mcp: {
    server: "issues-service",
    tool: "update_issue",
    description: "Server-supplied description",
    parameters: { issue: 42, token: "[REDACTED]", body: "<script>injected()</script>" },
  },
};

describe("MCP approval banner", () => {
  it("renders server, tool and redacted parameters, escapes content and retains approval controls", () => {
    const html = render(approval);
    assert.match(html, /Call MCP tool requires approval/);
    assert.match(html, /Server: issues-service/);
    assert.match(html, /Tool: update_issue/);
    assert.match(html, /Parameters:/);
    assert.match(html, /\[REDACTED\]/);
    assert.match(html, /&lt;script&gt;injected\(\)&lt;\/script&gt;/);
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes(approval.command!));
    assert.ok(!html.includes(approval.path!));
    assert.match(html, /role="alertdialog"/);
    assert.match(html, />Deny<\/button>/);
    assert.match(html, />Allow once<\/button>/);
  });

  it("renders localized MCP fields in Chinese", () => {
    const html = render(approval, "zh-CN");
    assert.match(html, /调用 MCP 工具需要批准/);
    assert.match(html, /服务器: issues-service/);
    assert.match(html, /工具: update_issue/);
    assert.match(html, /参数:/);
    assert.match(html, /允许一次/);
  });

  it("shows unavailable MCP fields without falling back to a bash command or file path", () => {
    const html = render({ ...approval, mcp: undefined });
    assert.match(html, /Server: \(Unknown\)/);
    assert.match(html, /Tool: \(Unknown\)/);
    assert.match(html, /Parameters: null/);
    assert.ok(!html.includes(approval.command!));
    assert.ok(!html.includes(approval.path!));
  });

  it("renders non-object JSON parameters", () => {
    const html = render({ ...approval, mcp: { ...approval.mcp!, parameters: ["[REDACTED]", 42] } });
    assert.match(html, /\[REDACTED\]/);
    assert.match(html, /42/);
  });

  it("preserves bash, browser REPL and file summaries", () => {
    for (const kind of ["bash", "browser_repl", "edit", "write", "mkdir"] as const) {
      const html = render({ ...approval, kind, mcp: undefined });
      assert.ok(html.includes(kind === "bash" || kind === "browser_repl" ? approval.command! : approval.path!));
      assert.ok(!html.includes("Server:"));
      assert.match(html, />Allow once<\/button>/);
    }
  });
});

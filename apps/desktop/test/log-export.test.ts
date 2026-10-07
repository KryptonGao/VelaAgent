import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { buildDiagnosticsBundle, diagnosticsFileName } from "../src/main/log-export.ts";

const roots: string[] = [];
const secrets = ["synthetic-mcp-token", "synthetic-git-pass", "synthetic-trace-key", "synthetic-log-bearer", "synthetic-sandbox-secret"];

function fixture(): { home: string; logs: string[] } {
  const home = mkdtempSync(join(tmpdir(), "vela-export-"));
  roots.push(home);
  mkdirSync(join(home, "logs"));
  mkdirSync(join(home, "traces"));
  const log = join(home, "logs", "vela-2026-10-07.log");
  writeFileSync(log, `${JSON.stringify({ msg: "request with Bearer synthetic-log-bearer", scope: "x", cwd: "/Users/someone/repo" })}\n`);
  writeFileSync(join(home, "git-operations.json"), JSON.stringify([{ type: "push", detail: "https://me:synthetic-git-pass@github.com/x.git" }]));
  writeFileSync(join(home, "vela-settings.json"), JSON.stringify({ mode: "ask", apiKey: "synthetic-sandbox-secret" }));
  writeFileSync(join(home, "integrations-auth.enc.json"), "never-exported");
  writeFileSync(join(home, "traces", "conv-1.jsonl"), `${JSON.stringify({ type: "node", value: { text: '{"api_key":"synthetic-trace-key"}' } })}\n`);
  return { home, logs: [log] };
}

function unzip(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, strFromU8(data)]));
}

describe("diagnostics bundle", () => {
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("packages logs, system info, git operations and a redacted settings summary without the trace by default", async () => {
    const { home, logs } = fixture();
    const files = unzip(await buildDiagnosticsBundle({
      home, agentDir: home, logFiles: logs, includeTrace: false, conversationId: "conv-1", homeDir: "/Users/someone",
      systemInfo: { app: { version: "1.0.1" }, path: "/Users/someone/Library" },
      mcpCatalog: async () => ({ servers: [{ name: "gh", headers: { Authorization: "Bearer synthetic-mcp-token" } }] }),
    }));
    assert.deepEqual(Object.keys(files).sort(), ["git-operations.json", "logs/vela-2026-10-07.log", "manifest.json", "settings-summary.json", "system-info.json"]);
    const all = Object.values(files).join("\n");
    for (const secret of [...secrets, "never-exported", "/Users/someone"]) assert.equal(all.includes(secret), false, secret);
    assert.match(files["logs/vela-2026-10-07.log"], /~\/repo/);
    const summary = JSON.parse(files["settings-summary.json"]);
    assert.equal(summary["vela-settings.json"].mode, "ask");
    assert.equal(summary.mcp.servers[0].name, "gh");
    const manifest = JSON.parse(files["manifest.json"]);
    assert.equal(manifest.includeTrace, false);
    assert.ok(manifest.items.every((item: { ok: boolean }) => item.ok));
  });

  it("adds the active conversation trace only when asked, redacted line by line", async () => {
    const { home, logs } = fixture();
    const files = unzip(await buildDiagnosticsBundle({ home, agentDir: home, logFiles: logs, includeTrace: true, conversationId: "conv-1", systemInfo: {} }));
    assert.ok(files["trace/conv-1.jsonl"]);
    assert.equal(files["trace/conv-1.jsonl"].includes("synthetic-trace-key"), false);
  });

  it("records missing pieces in the manifest instead of failing", async () => {
    const home = mkdtempSync(join(tmpdir(), "vela-export-empty-"));
    roots.push(home);
    const files = unzip(await buildDiagnosticsBundle({
      home, agentDir: home, logFiles: [join(home, "logs", "gone.log")], includeTrace: true, conversationId: null, systemInfo: {},
      mcpCatalog: async () => { throw new Error("MCP runtime has closed"); },
    }));
    const manifest = JSON.parse(files["manifest.json"]) as { items: { path: string; ok: boolean; error?: string }[] };
    const failed = Object.fromEntries(manifest.items.filter(item => !item.ok).map(item => [item.path, item.error]));
    assert.match(failed["logs/gone.log"] ?? "", /ENOENT/);
    assert.equal(failed["git-operations.json"], "not found");
    assert.equal(failed["trace/"], "no active conversation");
    assert.deepEqual(JSON.parse(files["settings-summary.json"]).mcp, { error: "MCP runtime has closed" });
  });

  it("names exports by local timestamp", () => {
    assert.equal(diagnosticsFileName(new Date(2026, 9, 7, 9, 5, 3)), "vela-diagnostics-20261007-090503.zip");
  });
});

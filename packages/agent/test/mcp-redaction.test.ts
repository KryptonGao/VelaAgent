import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpConfiguredSecrets, redactMcpDisplay } from "../src/mcp-redaction.ts";

test("MCP display scrub preserves usage numbers and tool schema while masking credentials", () => {
  const source = { usage: { inputTokens: 9, totalTokens: 11 },
    inputSchema: { type: "object", properties: { access_token: { type: "string" } } },
    arguments: { access_token: "synthetic-private", id: 7 },
    content: 'response {"refresh_token":"synthetic-rotated"} Bearer synthetic-bearer',
    error: "https://user:synthetic-pass@localhost/mcp?code=synthetic-code&ok=1",
    result: "echo synthetic-config-secret" };
  const display = redactMcpDisplay(source, ["synthetic-config-secret"]) as typeof source;
  assert.deepEqual(display.usage, source.usage);
  assert.deepEqual(display.inputSchema, source.inputSchema);
  assert.equal(display.arguments.id, 7);
  assert.equal(JSON.stringify(display).includes("synthetic-"), false);
  assert.match(display.error, /ok=1/);
  assert.equal(source.arguments.access_token, "synthetic-private", "display transformation must not alter execution arguments");
});

test("MCP secrets resolve Pi environment templates without running command providers", () => {
  process.env.VELA_MCP_REDACTION_FIXTURE = "synthetic-env-private";
  try {
    const secrets = mcpConfiguredSecrets([{ headers: {
      Authorization: "Bearer $VELA_MCP_REDACTION_FIXTURE",
      "X-Key": "${VELA_MCP_REDACTION_FIXTURE}",
      "X-Command": "!throw-if-executed",
    }, oauth: { clientSecret: "synthetic-client-private" } }]);
    assert.ok(secrets.includes("synthetic-env-private"));
    assert.ok(secrets.includes("synthetic-client-private"));
    assert.equal(secrets.includes("!throw-if-executed"), false);
    assert.equal(redactMcpDisplay("echo synthetic-env-private", secrets), "echo ••••••••");
  } finally { delete process.env.VELA_MCP_REDACTION_FIXTURE; }
});

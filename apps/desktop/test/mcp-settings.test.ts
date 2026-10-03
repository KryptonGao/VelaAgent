import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  credentialUpdate,
  McpFormError,
  parseMcpArgs,
  parseMcpImport,
  prepareMcpOverride,
  validateMcpConfig,
} from "../src/renderer/components/mcp-settings-model.ts";

function invalid(action: () => unknown, field: string, reason: string): void {
  assert.throws(
    action,
    (error) =>
      error instanceof McpFormError &&
      error.field === field &&
      error.reason === reason,
  );
}

describe("MCP settings JSON import", () => {
  it("previews mixed local and HTTP configurations without splitting arguments or expanding environment values", () => {
    const imported = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          local: {
            command: "node",
            args: ["path with spaces/server.js", "", "--token=$TOKEN"],
            env: { TOKEN: "${TOKEN}" },
            cwd: "/project",
          },
          remote: {
            type: "streamable-http",
            url: "https://tools.example/mcp",
            headers: { Authorization: "Bearer private" },
            oauth: { clientId: "public-client" },
            exposure: "direct",
            enabled: false,
          },
        },
      }),
    );
    assert.deepEqual(imported, [
      {
        name: "local",
        config: {
          type: "stdio",
          command: "node",
          args: ["path with spaces/server.js", "", "--token=$TOKEN"],
          env: { TOKEN: "${TOKEN}" },
          cwd: "/project",
          enabled: true,
          exposure: "deferred",
        },
      },
      {
        name: "remote",
        config: {
          type: "streamable-http",
          url: "https://tools.example/mcp",
          headers: { Authorization: "Bearer private" },
          oauth: { clientId: "public-client" },
          enabled: false,
          exposure: "direct",
        },
      },
    ]);
  });

  it("accepts a server map, but rejects empty imports and malformed roots", () => {
    assert.equal(parseMcpImport('{"one":{"command":"node"}}')[0]?.name, "one");
    invalid(() => parseMcpImport("{}"), "import", "empty");
    invalid(() => parseMcpImport("[]"), "import", "object");
    invalid(() => parseMcpImport("null"), "import", "object");
    invalid(() => parseMcpImport("{"), "import", "json");
  });

  it("rejects the whole preview when a server is invalid, so no partial import is silently submitted", () => {
    invalid(
      () => parseMcpImport('{"good":{"command":"node"},"bad":{"command":" "}}'),
      "command",
      "required",
    );
    invalid(
      () =>
        parseMcpImport(
          '{"bad":{"url":"https://example.com","headers":{"Authorization":42}}}',
        ),
      "headers",
      "strings",
    );
    invalid(
      () => parseMcpImport('{" spaced ":{"command":"node"}}'),
      "name",
      "required",
    );
  });

  it("does not treat strings as booleans or silently accept unsupported exposure and transport", () => {
    invalid(
      () => validateMcpConfig({ command: "node", enabled: "false" }),
      "enabled",
      "boolean",
    );
    invalid(
      () => validateMcpConfig({ url: "https://example.com", oauth: "true" }),
      "oauth",
      "object",
    );
    invalid(
      () => validateMcpConfig({ command: "node", exposure: "unknown" }),
      "exposure",
      "exposure",
    );
    invalid(
      () =>
        validateMcpConfig({
          url: "https://example.com",
          oauth: { callbackPort: 70000 },
        }),
      "oauth",
      "port",
    );
    invalid(
      () =>
        validateMcpConfig({
          transport: "websocket",
          url: "https://example.com",
        }),
      "transport",
      "transport",
    );
  });

  it("rejects executable URLs and embedded credentials while allowing local HTTP endpoints", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/server",
      "https://user:secret@example.com",
      "invalid",
    ]) {
      invalid(() => validateMcpConfig({ url }), "url", "url");
    }
    assert.equal(
      validateMcpConfig({ url: "http://127.0.0.1:3000/mcp" }).url,
      "http://127.0.0.1:3000/mcp",
    );
  });
});

describe("MCP form arguments and credential intent", () => {
  it("keeps argument boundaries intact and rejects shell-style or mixed-value input", () => {
    assert.deepEqual(parseMcpArgs('["--path", "two words", ""]'), [
      "--path",
      "two words",
      "",
    ]);
    invalid(() => parseMcpArgs('--path "two words"'), "args", "json");
    invalid(() => parseMcpArgs('["ok", 1]'), "args", "strings");
  });

  it("distinguishes unchanged credentials from explicit clearing or replacement", () => {
    assert.equal(credentialUpdate("  ", "headers"), undefined);
    assert.deepEqual(credentialUpdate("{}", "headers"), {});
    assert.deepEqual(
      credentialUpdate('{"Authorization":"Bearer new"}', "headers"),
      { Authorization: "Bearer new" },
    );
    invalid(() => credentialUpdate('{"TOKEN":null}', "env"), "env", "strings");
  });
});

describe("MCP source overrides", () => {
  it("does not copy masked credentials across scopes, preserves non-secret options, and keeps argument positions", () => {
    const config = {
      command: "node",
      args: ["--token", "••••••••", "server.js"],
      env: { TOKEN: "••••••••", PUBLIC: "yes" },
      vendor: { keep: true },
    };
    const next = prepareMcpOverride(config, ["/env/TOKEN", "/args/1"]);
    assert.deepEqual(next, {
      command: "node",
      args: ["--token", "", "server.js"],
      env: { PUBLIC: "yes" },
      vendor: { keep: true },
    });
    assert.equal(config.env.TOKEN, "••••••••");
  });

  it("decodes JSON pointer escapes and ignores paths that are not own config fields", () => {
    assert.deepEqual(
      prepareMcpOverride(
        { headers: { "X/Token": "••••••••", "~Token": "••••••••" } },
        ["/headers/X~1Token", "/headers/~0Token", "/__proto__/pollution"],
      ),
      { headers: {} },
    );
    assert.equal(Object.hasOwn(Object.prototype, "pollution"), false);
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createLogger, formatLogEntry, redactSensitive, setLogLevel, setLogSinks, toLoggable, type LogEntry } from "@vela/shared";

function capture(): LogEntry[] {
  const entries: LogEntry[] = [];
  setLogSinks([]);
  setLogSinks([{ write: entry => entries.push(entry) }]);
  return entries;
}

describe("logger facade", () => {
  afterEach(() => { setLogLevel("info"); setLogSinks([]); });

  it("filters below the configured level and scopes child loggers", () => {
    const entries = capture();
    const log = createLogger("test");
    log.debug("hidden");
    log.info("shown");
    setLogLevel("debug");
    log.child("sub").debug("now shown");
    setLogLevel("error");
    log.warn("hidden again");
    assert.deepEqual(entries.map(entry => [entry.scope, entry.level, entry.msg]), [["test", "info", "shown"], ["test:sub", "debug", "now shown"]]);
    assert.equal(entries[0].proc, "main");
    assert.match(entries[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("serializes errors with code and cause into err", () => {
    const entries = capture();
    const cause = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    createLogger("test").error("write failed", new Error("outer", { cause }));
    const [entry] = entries;
    assert.equal(entry.data, undefined);
    assert.equal(entry.err?.message, "outer");
    assert.match(entry.err?.stack ?? "", /outer/);
    assert.equal(entry.err?.cause?.code, "ENOSPC");
    assert.match(formatLogEntry(entry), /^\[test\] write failed\nError: outer/);
  });

  it("buffers entries until sinks are installed, then replays them", () => {
    setLogSinks(null);
    createLogger("early").info("before sinks");
    createLogger("early").debug("below level, never buffered");
    const entries: LogEntry[] = [];
    setLogSinks([{ write: entry => entries.push(entry) }]);
    assert.deepEqual(entries.map(entry => entry.msg), ["before sinks"]);
  });

  it("never lets a failing sink throw into the caller", () => {
    setLogSinks([{ write: () => { throw new Error("broken"); } }]);
    assert.doesNotThrow(() => createLogger("test").error("still fine"));
  });

  it("redacts credentials in messages and data", () => {
    const entries = capture();
    createLogger("test").info("calling https://user:hunter2@example.com/?token=abc123 with Bearer sk-live-xyz", {
      apiKey: "sk-secret",
      nested: { headers: { authorization: "Basic Zm9v" }, body: '{"password":"pw-1"}' },
      count: 3,
    });
    const text = JSON.stringify(entries);
    for (const secret of ["hunter2", "abc123", "sk-live-xyz", "sk-secret", "Zm9v", "pw-1"]) assert.equal(text.includes(secret), false, secret);
    assert.equal((entries[0].data as { count: number }).count, 3);
  });

  it("makes arbitrary values JSON-safe", () => {
    const cyclic: Record<string, unknown> = { name: "a", big: 10n, fn: () => 1 };
    cyclic.self = cyclic;
    assert.deepEqual(toLoggable(cyclic), { name: "a", big: "10", self: "[Circular]" });
    assert.equal((toLoggable("x".repeat(9000)) as string).length < 9000, true);
    assert.equal(redactSensitive("plain"), "plain");
  });
});

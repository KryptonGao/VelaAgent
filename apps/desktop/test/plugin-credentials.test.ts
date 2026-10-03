import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";

mock.module("electron", { namedExports: { safeStorage: {} } });
const { SecureCredentialStore } = await import("../src/main/plugin-credentials");

it("secure credentials persist only encrypted envelopes and survive reopening with the OS key", t => {
  const directory = mkdtempSync(join(tmpdir(), "vela-secure-plugins-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "auth.enc.json"); const key = randomBytes(32);
  let available = true;
  const cipher = {
    available: () => available,
    encrypt: (value: string) => {
      const iv = randomBytes(12); const aes = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, aes.update(value, "utf8"), aes.final(), aes.getAuthTag()]);
    },
    decrypt: (value: Buffer) => {
      const aes = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); aes.setAuthTag(value.subarray(-16));
      return Buffer.concat([aes.update(value.subarray(12, -16)), aes.final()]).toString("utf8");
    },
  };
  const store = new SecureCredentialStore(path, cipher);
  const secret = JSON.stringify({ tokens: { access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret" }, client_secret: "fixture-client-secret" });
  store.withLock(() => ({ result: undefined, next: secret }));
  const disk = readFileSync(path, "utf8");
  assert.equal(disk.includes("fixture"), false); assert.equal(disk.includes("access_token"), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(new SecureCredentialStore(path, cipher).withLock(current => ({ result: current })), secret);
  available = false;
  assert.throws(() => store.withLock(() => ({ result: undefined, next: secret })), /unavailable/);
  assert.equal(readFileSync(path, "utf8"), disk);
  available = true; writeFileSync(path, JSON.stringify({ version: 1, encrypted: "corrupted" }));
  assert.throws(() => store.withLock(() => ({ result: undefined, next: secret })), /unlock/);
  assert.equal(readFileSync(path, "utf8").includes("fixture"), false);
});

it("locked OS stores never fall back to plaintext", async t => {
  const directory = mkdtempSync(join(tmpdir(), "vela-locked-plugins-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "auth.enc.json");
  const store = new SecureCredentialStore(path, { available: () => false, encrypt: () => { throw new Error("unexpected"); }, decrypt: () => { throw new Error("unexpected"); } });
  await assert.rejects(store.withLockAsync(async () => ({ result: undefined, next: "secret" })), /unavailable/);
  assert.equal(readFileSync(path, "utf8").includes("secret"), false);
});

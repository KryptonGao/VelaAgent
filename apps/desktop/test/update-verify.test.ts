import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { compareVersions, decodeSignature, normalizeVersion, parseChecksums, publicKeyFromBase64, verifySignature } from "../src/main/update-verify.ts";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, raw: spki.subarray(spki.length - 32).toString("base64") };
}

test("compares versions numerically and ranks prereleases below the release", () => {
  assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
  assert.ok(compareVersions("v1.2.0", "1.1.9") > 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  assert.equal(compareVersions("1.0.5", "v1.0.5"), 0);
  assert.ok(compareVersions("1.0.6-beta.1", "1.0.6") < 0);
  assert.ok(compareVersions("1.0.6-beta.2", "1.0.6-beta.1") > 0);
  assert.ok(compareVersions("1.0.6-beta.10", "1.0.6-beta.9") > 0);
  assert.ok(compareVersions("1.0.6-rc", "1.0.6-beta") > 0);
  assert.ok(Number.isNaN(compareVersions("latest", "1.0.0")));
});

test("normalizes release tags and rejects non-versions", () => {
  assert.equal(normalizeVersion("v1.0.6"), "1.0.6");
  assert.equal(normalizeVersion(" 1.0.6-rc.1+build5 "), "1.0.6-rc.1");
  assert.equal(normalizeVersion("1.0"), null);
  assert.equal(normalizeVersion("nightly"), null);
  assert.equal(normalizeVersion("v1.0.6/../x"), null);
});

test("parses shasum output including binary markers and rejects duplicates", () => {
  const hashA = "a".repeat(64);
  const hashB = "B".repeat(64);
  const parsed = parseChecksums(`${hashA}  Vela-1.0.6-arm64.dmg\n${hashB} *Vela-1.0.6-arm64.zip\nnot a checksum line\n`);
  assert.equal(parsed.get("Vela-1.0.6-arm64.dmg"), hashA);
  assert.equal(parsed.get("Vela-1.0.6-arm64.zip"), "b".repeat(64));
  assert.equal(parsed.size, 2);
  assert.equal(parseChecksums(`${hashA}  x.zip\n${hashB}  x.zip\n`).size, 0);
});

test("accepts only signatures made by a trusted key over the exact bytes", () => {
  const trusted = keyPair();
  const other = keyPair();
  const data = Buffer.from(`${"c".repeat(64)}  Vela-1.0.6-arm64.zip\n`);
  const signature = sign(null, data, trusted.privateKey).toString("base64");

  assert.equal(verifySignature(data, signature, [trusted.raw]), true);
  assert.equal(verifySignature(data, `${signature}\n`, [other.raw, trusted.raw]), true, "any listed key may match, whitespace is tolerated");
  assert.equal(verifySignature(data, signature, [other.raw]), false, "untrusted key");
  assert.equal(verifySignature(Buffer.from(`${data}tampered`), signature, [trusted.raw]), false, "modified data");
  assert.equal(verifySignature(data, sign(null, data, other.privateKey).toString("base64"), [trusted.raw]), false, "signed by another key");
  assert.equal(verifySignature(data, "", [trusted.raw]), false);
  assert.equal(verifySignature(data, "AAAA", [trusted.raw]), false, "malformed signature");
  assert.equal(verifySignature(data, signature, ["not-a-key", ""]), false, "corrupt key entries are ignored");
});

test("decodes only 64-byte base64 signatures and validates key length", () => {
  assert.equal(decodeSignature(Buffer.alloc(64, 1).toString("base64"))?.length, 64);
  assert.equal(decodeSignature(Buffer.alloc(63, 1).toString("base64")), null);
  assert.throws(() => publicKeyFromBase64(Buffer.alloc(31).toString("base64")));
});

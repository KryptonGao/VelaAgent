import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { extractZip, readBundleInfo } from "../src/main/update-bundle.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vela-bundle-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mac = process.platform === "darwin";

test("unpacks a ditto-made app zip with symlinks and reads its identity", { skip: !mac }, async () => {
  const app = join(root, "src", "Vela.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "Vela"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync("MacOS/Vela", join(app, "Contents", "alias"));
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.vela.desktop</string>
<key>CFBundleShortVersionString</key><string>1.0.6</string>
</dict></plist>
`);
  const zip = join(root, "Vela-1.0.6-arm64.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);

  const out = join(root, "out");
  mkdirSync(out);
  await extractZip(zip, out);
  const extracted = join(out, "Vela.app");
  assert.equal(readFileSync(join(extracted, "Contents", "MacOS", "Vela"), "utf8"), "#!/bin/sh\n");
  assert.equal(readFileSync(join(extracted, "Contents", "alias"), "utf8"), "#!/bin/sh\n", "symlinks are preserved");
  assert.deepEqual(await readBundleInfo(extracted), { id: "com.vela.desktop", version: "1.0.6" });
  assert.equal(execFileSync("/usr/bin/xattr", [extracted]).toString().includes("com.apple.quarantine"), false, "files unpacked by the app are not quarantined");
});

test("fails clearly for a missing archive or an app without an Info.plist", { skip: !mac }, async () => {
  await assert.rejects(extractZip(join(root, "missing.zip"), root));
  mkdirSync(join(root, "Empty.app", "Contents"), { recursive: true });
  await assert.rejects(readBundleInfo(join(root, "Empty.app")));
  assert.equal(existsSync(join(root, "Empty.app", "Contents", "Info.plist")), false);
});

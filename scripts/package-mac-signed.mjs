import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Opt-in signed packaging. Never replace the existing fast, unsigned local build.
// electron-builder accepts a qualifier, and rejects Apple's certificate-type prefix.
const identity = process.env.VELA_MAC_SIGNING_IDENTITY?.replace(/^Developer ID Application:\s*/, "").trim();
const profile = process.env.VELA_MAC_PROVISIONING_PROFILE;
if (process.platform !== "darwin" || !profile || !identity?.trim() || identity === "-") {
  console.error("Signed macOS packaging requires macOS, VELA_MAC_PROVISIONING_PROFILE, and VELA_MAC_SIGNING_IDENTITY (Developer ID certificate name).");
  process.exit(1);
}
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const temporary = mkdtempSync(join(tmpdir(), "vela-webauthn-signing-"));
try {
  const plist = execFileSync("/usr/bin/security", ["cms", "-D", "-i", resolve(profile)], { encoding: "utf8", timeout: 5000 });
  const authorized = JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "Entitlements", "json", "-o", "-", "--", "-"],
    { input: plist, encoding: "utf8", timeout: 3000 }));
  const applicationId = authorized["com.apple.application-identifier"] ?? authorized["application-identifier"];
  const prefix = typeof applicationId === "string" ? applicationId.split(".")[0] : "";
  const group = `${prefix}.com.vela.desktop.webauthn`;
  const groups = authorized["keychain-access-groups"];
  const team = authorized["com.apple.developer.team-identifier"];
  if (!/^[A-Z0-9]{10}$/.test(prefix) || !/^[A-Z0-9]{10}$/.test(team ?? "") ||
      ![`${prefix}.com.vela.desktop`, `${prefix}.*`].includes(applicationId) || !Array.isArray(groups) ||
      !groups.some(value => value === group || value === `${prefix}.*`)) {
    throw new Error("Provisioning profile must authorize com.vela.desktop and its WebAuthn keychain access group.");
  }
  const entitlements = join(temporary, "entitlements.plist");
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>`;
  const runtime = `
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>`;
  const footer = "\n</dict></plist>\n";
  writeFileSync(entitlements, `${header}${runtime}
  <key>com.apple.application-identifier</key><string>${prefix}.com.vela.desktop</string>
  <key>com.apple.developer.team-identifier</key><string>${team}</string>
  <key>keychain-access-groups</key><array><string>${group}</string></array>${footer}`);
  const inherited = join(temporary, "entitlements-inherit.plist");
  writeFileSync(inherited, header + runtime + footer);
  const config = join(temporary, "electron-builder.json");
  writeFileSync(config, JSON.stringify({
    extends: join(desktop, "electron-builder.yml"), forceCodeSigning: true,
    mac: { identity, provisioningProfile: resolve(profile), hardenedRuntime: true, entitlements, entitlementsInherit: inherited },
  }));
  execFileSync(process.execPath, [require.resolve("electron-builder/cli.js"), "--mac", "--arm64", "--config", config,
    ...process.argv.slice(2)], { cwd: desktop, stdio: "inherit" });
} finally { rmSync(temporary, { recursive: true, force: true }); }

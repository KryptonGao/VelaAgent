import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { bundlePathFromExecutable, installerArguments, resolveInstallTarget, type InstallPlan } from "../src/main/update-installer.ts";

const mac = process.platform === "darwin";
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vela-installer-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeApp(path: string, version: string): void {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(path, "Contents", "MacOS", "Vela"), version);
  symlinkSync("MacOS/Vela", join(path, "Contents", "link"));
}

function plan(overrides: Partial<InstallPlan> = {}): InstallPlan {
  return {
    stagedApp: join(root, "work", "extracted", "Vela.app"),
    target: join(root, "Applications", "Vela.app"),
    workDir: join(root, "work"),
    logFile: join(root, "logs", "installer.log"),
    relaunch: false,
    ...overrides,
  };
}

/** 超出 macOS 的 pid 上限（99999），一定不存在，相当于应用已经退出。 */
const exitedPid = () => 4_194_297;

function runInstaller(value: InstallPlan, pid = exitedPid()) {
  return spawnSync("/bin/sh", installerArguments(value, pid), { encoding: "utf8", timeout: 20_000 });
}

test("finds the app bundle of a packaged executable and rejects unsafe locations", () => {
  assert.equal(bundlePathFromExecutable("/Applications/Vela.app/Contents/MacOS/Vela"), "/Applications/Vela.app");
  assert.equal(bundlePathFromExecutable("/Users/me/Apps/Vela.app/Contents/MacOS/Vela"), "/Users/me/Apps/Vela.app");
  assert.equal(bundlePathFromExecutable("/Volumes/Vela 1.0.5/Vela.app/Contents/MacOS/Vela"), null, "running from the DMG");
  assert.equal(bundlePathFromExecutable("/private/var/folders/x/AppTranslocation/ABC/d/Vela.app/Contents/MacOS/Vela"), null);
  assert.equal(bundlePathFromExecutable("/usr/local/bin/electron"), null);
});

test("never offers to replace a development or non-macOS installation", async () => {
  assert.equal(await resolveInstallTarget("/Applications/Vela.app/Contents/MacOS/Vela", false, "darwin"), null);
  assert.equal(await resolveInstallTarget("/Applications/Vela.app/Contents/MacOS/Vela", true, "linux"), null);
});

test("offers the real path of a writable bundle and nothing for a missing or read-only one", { skip: !mac }, async () => {
  const app = join(root, "Applications", "Vela.app");
  fakeApp(app, "1.0.5");
  assert.equal(await resolveInstallTarget(join(app, "Contents", "MacOS", "Vela"), true), realpathSync(app));
  assert.equal(await resolveInstallTarget(join(root, "Applications", "Gone.app", "Contents", "MacOS", "Vela"), true), null);
});

test("swaps in the staged app, keeps symlinks and cleans up", { skip: !mac }, () => {
  const value = plan();
  fakeApp(value.target, "old");
  fakeApp(value.stagedApp, "new");
  const result = runInstaller(value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(value.target, "Contents", "MacOS", "Vela"), "utf8"), "new");
  assert.equal(readFileSync(join(value.target, "Contents", "link"), "utf8"), "new", "symlink survives the copy");
  for (const leftover of [`${value.target}.vela-new`, `${value.target}.vela-old`, value.workDir]) assert.equal(existsSync(leftover), false, leftover);
  assert.match(readFileSync(value.logFile, "utf8"), /update: installed/);
});

test("keeps the current version when the staged app is missing", { skip: !mac }, () => {
  const value = plan();
  fakeApp(value.target, "old");
  const result = runInstaller(value);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(value.target, "Contents", "MacOS", "Vela"), "utf8"), "old");
  assert.equal(existsSync(`${value.target}.vela-new`), false);
  assert.match(readFileSync(value.logFile, "utf8"), /copy failed/);
});

test("clears leftovers from an interrupted earlier attempt", { skip: !mac }, () => {
  const value = plan();
  fakeApp(value.target, "old");
  fakeApp(value.stagedApp, "new");
  fakeApp(`${value.target}.vela-new`, "half-copied");
  fakeApp(`${value.target}.vela-old`, "stale");
  assert.equal(runInstaller(value).status, 0);
  assert.equal(readFileSync(join(value.target, "Contents", "MacOS", "Vela"), "utf8"), "new");
  assert.equal(existsSync(`${value.target}.vela-old`), false);
});

test("waits for the running app to exit before touching it", { skip: !mac }, async () => {
  const value = plan();
  fakeApp(value.target, "old");
  fakeApp(value.stagedApp, "new");
  const sleeper = spawn("/bin/sleep", ["1.2"], { stdio: "ignore" });
  const started = Date.now();
  const installer = spawn("/bin/sh", installerArguments(value, sleeper.pid!), { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(readFileSync(join(value.target, "Contents", "MacOS", "Vela"), "utf8"), "old", "still waiting");
  await new Promise<void>(resolve => installer.on("exit", () => resolve()));
  assert.ok(Date.now() - started >= 1000);
  assert.equal(readFileSync(join(value.target, "Contents", "MacOS", "Vela"), "utf8"), "new");
});

test("passes paths with spaces and quotes through untouched", { skip: !mac }, () => {
  const value = plan({ target: join(root, `My "Apps`, "Vela Beta.app") });
  fakeApp(value.target, "old");
  fakeApp(value.stagedApp, "new");
  assert.equal(runInstaller(value).status, 0);
  assert.equal(readFileSync(join(value.target, "Contents", "MacOS", "Vela"), "utf8"), "new");
});

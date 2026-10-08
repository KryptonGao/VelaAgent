import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readDevToolsInfo, restartMainProcess } from "../src/main/dev-tools.ts";

const base = {
  name: "Vela Dev", version: "1.2.3", home: "/home/dev",
  versions: { electron: "44.5.1", chrome: "150.0.0.0", node: "24.1.0", v8: "14.0.0" },
  platform: "darwin", arch: "arm64", osRelease: "27.0.0",
};

it("reads version, commit and runtime versions from the working tree", async () => {
  const info = await readDevToolsInfo({ ...base, appPath: import.meta.dirname });
  assert.match(info.commit ?? "", /^[0-9a-f]{40}$/);
  assert.ok(info.branch);
  assert.equal(typeof info.dirty, "boolean");
  assert.deepEqual([info.version, info.electron, info.node, info.chrome, info.v8], ["1.2.3", "44.5.1", "24.1.0", "150.0.0.0", "14.0.0"]);
});

it("still reports versions when the app is not inside a git checkout", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-dev-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const info = await readDevToolsInfo({ ...base, appPath: root, versions: {} });
  assert.deepEqual([info.commit, info.branch, info.dirty], [null, null, null]);
  assert.equal(info.electron, "unknown");
  assert.equal(info.version, "1.2.3");
});

it("relaunches directly when Electron is not managed by electron-vite", async () => {
  const calls: string[] = [];
  await restartMainProcess({ rendererUrl: undefined, appPath: "/missing", flush: () => calls.push("flush"), relaunch: () => calls.push("relaunch") });
  assert.deepEqual(calls, ["flush", "relaunch"]);
});

it("asks electron-vite's watcher to restart by touching the main entry", async t => {
  const root = await mkdtemp(join(tmpdir(), "vela-dev-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "src", "main", "index.ts");
  await mkdir(join(root, "src", "main"), { recursive: true });
  await writeFile(entry, "export {};\n");
  const before = (await stat(entry)).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  const calls: string[] = [];
  await assert.rejects(
    restartMainProcess({ rendererUrl: "http://localhost:5173", appPath: root, flush: () => calls.push("flush"), relaunch: () => calls.push("relaunch"), timeoutMs: 10 }),
    /--watch/,
  );
  assert.ok((await stat(entry)).mtimeMs > before);
  assert.deepEqual(calls, ["flush"], "relaunching would stop the dev server");
  await rm(entry);
  await assert.rejects(restartMainProcess({ rendererUrl: "http://localhost:5173", appPath: root, flush: () => undefined, relaunch: () => undefined }), /入口源码/);
});

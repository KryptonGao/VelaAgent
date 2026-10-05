import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { configureVelaProfile, prepareVelaHome, resolveVelaHome } from "../src/main/vela-home.ts";

describe("Vela startup profiles", () => {
  function fixture(t: { after(fn: () => void): void }, override?: string) {
    const root = mkdtempSync(join(tmpdir(), "vela-profile-"));
    const previous = process.env.VELA_USER_DATA;
    if (override === undefined) delete process.env.VELA_USER_DATA;
    else process.env.VELA_USER_DATA = override;
    t.after(() => {
      if (previous === undefined) delete process.env.VELA_USER_DATA;
      else process.env.VELA_USER_DATA = previous;
      rmSync(root, { recursive: true, force: true });
    });
    const app = (isPackaged: boolean) => {
      const paths = new Map<string, string>();
      return {
        isPackaged, name: "", paths,
        setName(name: string) { this.name = name; },
        getPath() { return root; },
        setPath(name: string, path: string) {
          assert.ok(existsSync(path), "Electron path must exist before setPath");
          paths.set(name, path);
        },
      };
    };
    return { root, app };
  }

  it("keeps installed data and isolates development locks, browser sessions and agent data", t => {
    const { root, app } = fixture(t);
    const installed = app(true), development = app(false);
    assert.equal(configureVelaProfile(installed), join(homedir(), ".vela"));
    assert.equal(installed.name, "Vela");
    assert.equal(installed.paths.size, 0, "installed Electron profile remains unchanged");
    assert.equal(configureVelaProfile(development), join(homedir(), ".vela-dev"));
    assert.equal(development.name, "Vela Dev");
    assert.equal(development.paths.get("userData"), join(root, "Vela Dev"));
    assert.equal(development.paths.get("sessionData"), join(root, "Vela Dev"));
    const secondDevelopment = app(false);
    configureVelaProfile(secondDevelopment);
    assert.deepEqual(secondDevelopment.paths, development.paths, "development restarts use the same lock profile");
  });

  it("honors explicit data roots and uses the same lock for the same root across modes", t => {
    const { root, app } = fixture(t);
    process.env.VELA_USER_DATA = `  ${join(root, "custom")}  `;
    const installed = app(true), development = app(false);
    assert.equal(configureVelaProfile(installed), join(root, "custom"));
    assert.equal(configureVelaProfile(development), join(root, "custom"));
    assert.deepEqual(installed.paths, development.paths);
    assert.equal(installed.paths.get("userData"), join(root, "custom", "electron-data"));
    process.env.VELA_USER_DATA = "./relative-vela-data";
    assert.equal(resolveVelaHome(false), resolve("./relative-vela-data"));
    process.env.VELA_USER_DATA = "  ";
    assert.equal(resolveVelaHome(false), join(homedir(), ".vela-dev"));
  });

  it("reuses default locks when VELA_USER_DATA explicitly selects either default home", t => {
    const { root, app } = fixture(t);
    for (const [home, name] of [[".vela", "Vela"], [".vela-dev", "Vela Dev"]]) {
      process.env.VELA_USER_DATA = join(homedir(), home!);
      for (const packaged of [true, false]) {
        const instance = app(packaged);
        configureVelaProfile(instance);
        assert.equal(instance.paths.get("userData"), join(root, name!));
      }
    }
  });

  it("preserves installed legacy migration and never imports it into the default development profile", async t => {
    const { root, app } = fixture(t);
    const legacy = join(root, "Vela");
    await mkdir(join(legacy, "agent", "sessions"), { recursive: true });
    const sessionFile = join(legacy, "agent", "sessions", "chat.jsonl");
    await writeFile(sessionFile, "session\n");
    await writeFile(join(legacy, "agent", "conversations.json"), JSON.stringify({ conversations: [{ sessionFile }] }));
    const installedHome = join(root, "installed-home");
    await prepareVelaHome(installedHome, legacy);
    const index = JSON.parse(await readFile(join(installedHome, "conversations.json"), "utf8"));
    assert.equal(index.conversations[0].sessionFile, join(installedHome, "sessions", "chat.jsonl"));
    assert.equal(await readFile(sessionFile, "utf8"), "session\n", "legacy data is retained");
    const development = app(false);
    configureVelaProfile(development);
    const devHome = join(root, "dev-home");
    await prepareVelaHome(devHome, development.paths.get("userData")!);
    assert.equal(existsSync(join(devHome, "conversations.json")), false);
    assert.ok(existsSync(join(devHome, "sessions")));
    assert.ok(existsSync(join(devHome, "skills")));
    assert.ok(existsSync(join(devHome, "worktrees")));
  });

  it("does not migrate legacy accounts or conversations into an explicit data root", async t => {
    const { root } = fixture(t);
    const home = join(root, "custom");
    process.env.VELA_USER_DATA = home;
    const legacy = join(root, "legacy");
    await mkdir(join(legacy, "agent"), { recursive: true });
    await writeFile(join(legacy, "agent", "conversations.json"), '{"conversations":[]}');
    await writeFile(join(legacy, "agent", "auth.json"), '{"secret":"legacy"}');
    await prepareVelaHome(home, legacy);
    assert.equal(existsSync(join(home, "conversations.json")), false);
    assert.equal(existsSync(join(home, "auth.json")), false);
  });
});

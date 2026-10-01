import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, lstat, symlink, readlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnCheckpoints } from "../src/turn-checkpoints.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(git = false) {
  const root = await mkdtemp(join(tmpdir(), "vela-rewind-")); dirs.push(root);
  const cwd = join(root, "workspace"), state = join(root, "state");
  await mkdir(cwd); await mkdir(state);
  if (git) execFileSync("git", ["init", "-q", cwd]);
  return { cwd, state, store: new TurnCheckpoints(join(state, "checkpoints"), cwd, state), path: (name: string) => join(cwd, name) };
}

describe("turn file checkpoints", () => {
  it("restores dirty and untracked files, additions, deletions, binary content and modes after restart", async () => {
    const { cwd, state, store, path } = await fixture(true);
    await writeFile(path("tracked.txt"), "committed version");
    execFileSync("git", ["-C", cwd, "add", "."]);
    await writeFile(path("tracked.txt"), "existing user edits");
    await writeFile(path("draft.txt"), "untracked draft");
    await writeFile(path("binary"), Buffer.from([0, 1, 255]));
    await chmod(path("binary"), 0o755);
    const point = await store.begin(null, { plans: ["before"] });
    await writeFile(path("tracked.txt"), "agent edits");
    await rm(path("draft.txt"));
    await writeFile(path("binary"), Buffer.from([9, 8])); await chmod(path("binary"), 0o644);
    await writeFile(path("new.txt"), "agent added");
    await store.finish(point, "user-1");
    await writeFile(path("unrelated.txt"), "later manual addition");
    const reopened = new TurnCheckpoints(join(state, "checkpoints"), cwd, state);
    await reopened.restore(await reopened.list());
    assert.equal(await readFile(path("tracked.txt"), "utf8"), "existing user edits");
    assert.equal(await readFile(path("draft.txt"), "utf8"), "untracked draft");
    assert.deepEqual(await readFile(path("binary")), Buffer.from([0, 1, 255]));
    assert.equal((await lstat(path("binary"))).mode & 0o777, 0o755);
    await assert.rejects(readFile(path("new.txt")), { code: "ENOENT" });
    assert.equal(await readFile(path("unrelated.txt"), "utf8"), "later manual addition");
    assert.equal(execFileSync("git", ["-C", cwd, "show", ":tracked.txt"], { encoding: "utf8" }), "committed version");
  });
  it("rewinds multiple turns in reverse order while preserving earlier work", async () => {
    const { store, path } = await fixture();
    await writeFile(path("a"), "earlier turn");
    const one = await store.begin("before-one", {});
    await writeFile(path("a"), "one"); await store.finish(one, "one");
    const two = await store.begin("before-two", {});
    await writeFile(path("a"), "two"); await writeFile(path("b"), "new"); await store.finish(two, "two");
    await store.restore([one, two]);
    assert.equal(await readFile(path("a"), "utf8"), "earlier turn");
    await assert.rejects(readFile(path("b")), { code: "ENOENT" });
  });
  it("rejects later manual changes before writing any file", async () => {
    const { store, path } = await fixture();
    await writeFile(path("a"), "before"); await writeFile(path("b"), "before");
    const point = await store.begin(null, {});
    await writeFile(path("a"), "agent"); await writeFile(path("b"), "agent"); await store.finish(point, "u");
    await writeFile(path("b"), "manual");
    await assert.rejects(store.restore([point]), /b/);
    assert.equal(await readFile(path("a"), "utf8"), "agent");
    assert.equal(await readFile(path("b"), "utf8"), "manual");
  });
  it("restores symlinks without following them outside the workspace", async () => {
    const { store, path, state } = await fixture();
    await writeFile(join(state, "outside"), "unchanged");
    await symlink(join(state, "outside"), path("link"));
    const point = await store.begin(null, {});
    await rm(path("link")); await writeFile(path("link"), "regular file"); await store.finish(point, "u");
    await store.restore([point]);
    assert.equal(await readlink(path("link")), join(state, "outside"));
    assert.equal(await readFile(join(state, "outside"), "utf8"), "unchanged");
  });
  it("rejects a changed parent symlink without touching its destination", async () => {
    const { store, path, state } = await fixture();
    await mkdir(path("dir")); await writeFile(path("dir/file"), "before");
    const point = await store.begin(null, {});
    await writeFile(path("dir/file"), "agent"); await store.finish(point, "u");
    await mkdir(join(state, "outside")); await writeFile(join(state, "outside/file"), "outside");
    await rm(path("dir"), { recursive: true }); await symlink(join(state, "outside"), path("dir"));
    await assert.rejects(store.restore([point]), /符号链接/);
    assert.equal(await readFile(join(state, "outside/file"), "utf8"), "outside");
  });
  it("rejects incomplete and corrupted checkpoints without partial writes", async () => {
    const { store, path, state } = await fixture();
    await writeFile(path("a"), "before");
    const point = await store.begin(null, {});
    await assert.rejects(store.restore([point]), /未完成/);
    await writeFile(path("a"), "after"); await store.finish(point, "u");
    await writeFile(join(state, "checkpoints", "blobs", point.before.a!.hash), "corrupt");
    await assert.rejects(store.restore([point]), /损坏/);
    assert.equal(await readFile(path("a"), "utf8"), "after");
  });
});

it("includes ignored configuration files but excludes generated dependency directories", async () => {
  const { store, path } = await fixture(true);
  await writeFile(path(".gitignore"), ".env\nnode_modules/\n");
  await writeFile(path(".env"), "before");
  await mkdir(path("node_modules")); await writeFile(path("node_modules/dependency"), "original");
  const point = await store.begin(null, {});
  await writeFile(path(".env"), "agent"); await writeFile(path("node_modules/dependency"), "installed");
  await store.finish(point, "u"); await store.restore([point]);
  assert.equal(await readFile(path(".env"), "utf8"), "before");
  assert.equal(await readFile(path("node_modules/dependency"), "utf8"), "installed");
});

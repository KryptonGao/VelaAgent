import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, chmod, lstat, symlink, readlink, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnCheckpoints, exclusiveAccess, sharedAccess, sharedDirectory } from "../src/turn-checkpoints.ts";
import { checkpointUsage, cleanCheckpoints } from "../src/checkpoint-storage.ts";

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

const blobs = async (directory: string) => (await readdir(directory).catch(() => [])).filter(name => /^[a-f0-9]{64}$/.test(name));

describe("checkpoint storage", () => {
  async function shared() {
    const root = await mkdtemp(join(tmpdir(), "vela-storage-")); dirs.push(root);
    const cwd = join(root, "workspace"), state = join(root, "state"), checkpoints = join(state, "checkpoints");
    await mkdir(cwd); await mkdir(checkpoints, { recursive: true });
    const open = (id: string) => new TurnCheckpoints<unknown>(join(checkpoints, id), cwd, state, sharedDirectory(checkpoints));
    return { cwd, checkpoints, open, path: (name: string) => join(cwd, name) };
  }
  it("stores a file version once for every conversation of the workspace", async () => {
    const { checkpoints, open, path } = await shared();
    await writeFile(path("a.txt"), "same content everywhere");
    const first = await open("one").begin(null, {}), second = await open("two").begin(null, {});
    const hash = first.before["a.txt"]!.hash;
    assert.equal(hash, second.before["a.txt"]!.hash);
    const one = await lstat(join(checkpoints, "one", "blobs", hash)), two = await lstat(join(checkpoints, "two", "blobs", hash));
    assert.equal(one.ino, two.ino);
    const points = (await lstat(join(checkpoints, "one", `${first.id}.json`))).size + (await lstat(join(checkpoints, "two", `${second.id}.json`))).size;
    assert.equal((await checkpointUsage(checkpoints)).bytes, "same content everywhere".length + points);
  });

  it("remembers the hash of unchanged files and rereads only what changed", async () => {
    const { open, path, checkpoints, cwd } = await shared();
    await writeFile(path("a.txt"), "first"); await writeFile(path("b.txt"), "second");
    const old = new Date(Date.now() - 60_000);
    await utimes(path("a.txt"), old, old); await utimes(path("b.txt"), old, old);
    const store = open("c");
    const point = await store.begin(null, {});
    const cache = JSON.parse(await readFile(join(checkpoints, ".shared", "stat", `${createHash("sha1").update(cwd).digest("hex")}.json`), "utf8"));
    assert.equal(cache.files["a.txt"][4], point.before["a.txt"]!.hash);
    assert.equal(cache.files["b.txt"][4], point.before["b.txt"]!.hash);
    // A cached file whose blob has gone is read again instead of trusting the cache.
    await rm(join(checkpoints, "c", "blobs", point.before["a.txt"]!.hash)); await rm(join(checkpoints, ".shared", "blobs", point.before["a.txt"]!.hash));
    await writeFile(path("b.txt"), "second!");
    await store.finish(point, "u");
    assert.equal(point.after!["a.txt"]!.hash, point.before["a.txt"]!.hash);
    assert.deepEqual(await readFile(join(checkpoints, "c", "blobs", point.after!["a.txt"]!.hash), "utf8"), "first");
    assert.notEqual(point.after!["b.txt"]!.hash, point.before["b.txt"]!.hash);
  });

  it("does not trust a cached hash for a file written within the racy window", async () => {
    const { open, path } = await shared();
    await writeFile(path("a.txt"), "aaaa");
    const store = open("c");
    const point = await store.begin(null, {});
    await writeFile(path("a.txt"), "bbbb"); // Same size, nearly the same mtime.
    await store.finish(point, "u");
    assert.notEqual(point.after!["a.txt"]!.hash, point.before["a.txt"]!.hash);
  });

  it("leaves out ignored logs and large ignored files, but keeps tracked and plain untracked ones", async () => {
    const { cwd, open, path } = await shared();
    execFileSync("git", ["init", "-q", cwd]);
    await writeFile(path(".gitignore"), "*.log\n.env\nbig.bin\n");
    await writeFile(path("debug.log"), "noise"); await writeFile(path(".env"), "SECRET=1");
    await writeFile(path("big.bin"), Buffer.alloc(6 * 1024 * 1024)); await writeFile(path("source.ts"), "code");
    const point = await open("c").begin(null, {});
    assert.deepEqual(Object.keys(point.before).sort(), [".env", ".gitignore", "source.ts"]);
  });

  it("hashes and stores files too large to read whole without keeping them in memory", async () => {
    const { checkpoints, open, path } = await shared();
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    await writeFile(path("data.bin"), big);
    const store = open("c");
    const point = await store.begin(null, {});
    await writeFile(path("data.bin"), "small"); await store.finish(point, "u");
    await store.restore([point]);
    assert.deepEqual(await readFile(path("data.bin")), big);
    assert.deepEqual(await readdir(join(checkpoints, ".shared", "blobs")).then(list => list.filter(name => name.endsWith(".tmp"))), []);
  });

  it("removing points frees the blobs nothing else uses and keeps shared ones", async () => {
    const { checkpoints, open, path } = await shared();
    await writeFile(path("a.txt"), "keep me"); await writeFile(path("b.txt"), "version one");
    const one = open("one"), two = open("two");
    const kept = await two.begin(null, {}); await two.finish(kept, "u");
    const point = await one.begin(null, {});
    await writeFile(path("b.txt"), "version two"); await one.finish(point, "u");
    await one.remove([point]);
    assert.deepEqual(await blobs(join(checkpoints, "one", "blobs")), []);
    const pooled = await blobs(join(checkpoints, ".shared", "blobs"));
    assert.ok(pooled.includes(kept.before["a.txt"]!.hash));
    assert.ok(pooled.includes(kept.before["b.txt"]!.hash));
    assert.ok(!pooled.includes(point.after!["b.txt"]!.hash));
  });

  it("prunes a conversation to its newest points and keeps the ones still needed", async () => {
    const { checkpoints, open, path } = await shared();
    const store = open("c");
    const made: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      await writeFile(path("a.txt"), `turn ${turn}`);
      const point = await store.begin(null, {}); await writeFile(path("a.txt"), `done ${turn}`); await store.finish(point, `u${turn}`);
      made.push(point.id);
      await utimes(join(checkpoints, "c", `${point.id}.json`), new Date(1000 * (turn + 1)), new Date(1000 * (turn + 1)));
    }
    assert.equal(await store.prune(2), 2);
    assert.deepEqual((await store.list()).map(point => point.id).sort(), made.slice(2).sort());
    assert.equal((await blobs(join(checkpoints, "c", "blobs"))).length, 4);
  });
});

describe("cleaning checkpoint storage", () => {
  async function layout() {
    const root = await mkdtemp(join(tmpdir(), "vela-clean-")); dirs.push(root);
    const state = join(root, "state"), checkpoints = join(state, "checkpoints"), cwd = join(root, "workspace");
    await mkdir(cwd); await mkdir(checkpoints, { recursive: true });
    return { root, checkpoints, cwd, path: (name: string) => join(cwd, name) };
  }
  const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
  /** A conversation written by an older version: private blobs, no pool. */
  async function legacy(checkpoints: string, id: string, files: Record<string, string>, time: number, after: Record<string, string> | null = files) {
    const folder = join(checkpoints, id, "blobs");
    await mkdir(folder, { recursive: true });
    const table = (contents: Record<string, string>) => Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, { hash: hashOf(text), mode: 0o644 }]));
    for (const text of new Set([...Object.values(files), ...Object.values(after ?? {})])) await writeFile(join(folder, hashOf(text)), text);
    const file = join(checkpoints, id, `${id}-point.json`);
    await writeFile(file, JSON.stringify({ id: `${id}-point`, leaf: null, userEntryId: "u", before: table(files), after: after ? table(after) : null, metadata: {} }));
    await utimes(file, new Date(time), new Date(time));
  }

  it("merges private copies from older versions into one file per version", async () => {
    const { checkpoints } = await layout();
    const body = "x".repeat(10_000);
    await legacy(checkpoints, "one", { "a.txt": body }, 1000);
    await legacy(checkpoints, "two", { "a.txt": body }, 2000);
    const before = await checkpointUsage(checkpoints);
    assert.equal(before.bytes, body.length * 2 + 0 + (await lstat(join(checkpoints, "one", "one-point.json"))).size + (await lstat(join(checkpoints, "two", "two-point.json"))).size);
    const result = await cleanCheckpoints(checkpoints, { maxPointsPerConversation: 50, maxBytes: 1e12 });
    assert.equal(result.usage.bytes, before.bytes - body.length);
    assert.equal(result.freedBytes, body.length);
    assert.equal((await lstat(join(checkpoints, "one", "blobs", hashOf(body)))).ino, (await lstat(join(checkpoints, "two", "blobs", hashOf(body)))).ino);
    assert.equal(result.usage.conversations, 2);
    assert.equal(result.usage.points, 2);
  });

  it("deletes blobs no point references, including stale temp files, and keeps referenced ones", async () => {
    const { checkpoints } = await layout();
    await legacy(checkpoints, "one", { "a.txt": "referenced" }, 1000);
    await writeFile(join(checkpoints, "one", "blobs", hashOf("orphan")), "orphan");
    await mkdir(join(checkpoints, ".shared", "blobs"), { recursive: true });
    await writeFile(join(checkpoints, ".shared", "blobs", hashOf("pool orphan")), "pool orphan");
    const stale = join(checkpoints, ".shared", "blobs", "old.tmp");
    await writeFile(stale, "partial"); await utimes(stale, new Date(1000), new Date(1000));
    await cleanCheckpoints(checkpoints);
    assert.deepEqual(await blobs(join(checkpoints, "one", "blobs")), [hashOf("referenced")]);
    assert.deepEqual(await blobs(join(checkpoints, ".shared", "blobs")), [hashOf("referenced")]);
    assert.deepEqual(await readdir(join(checkpoints, ".shared", "blobs")).then(list => list.filter(name => name.endsWith(".tmp"))), []);
  });

  it("keeps each conversation's newest points and an unfinished recent one", async () => {
    const { checkpoints } = await layout();
    await legacy(checkpoints, "one", { "a.txt": "old" }, 1000, { "a.txt": "old2" });
    await writeFile(join(checkpoints, "one", "second.json"), JSON.stringify({ id: "second", before: { "a.txt": { hash: hashOf("mid"), mode: 0 } }, after: { "a.txt": { hash: hashOf("mid2"), mode: 0 } } }));
    await utimes(join(checkpoints, "one", "second.json"), new Date(2000), new Date(2000));
    await writeFile(join(checkpoints, "one", "third.json"), JSON.stringify({ id: "third", before: { "a.txt": { hash: hashOf("run"), mode: 0 } }, after: null }));
    const result = await cleanCheckpoints(checkpoints, { maxPointsPerConversation: 1, maxBytes: 1e12 });
    assert.equal(result.removedPoints, 2);
    assert.deepEqual((await readdir(join(checkpoints, "one"))).filter(name => name.endsWith(".json")), ["third.json"]);
  });

  it("evicts the oldest points across conversations when over the size cap, never a conversation's last one", async () => {
    const { checkpoints } = await layout();
    const big = (label: string) => label.repeat(1000);
    await legacy(checkpoints, "old", { "a": big("a") }, 1000, { "a": big("b") });
    await writeFile(join(checkpoints, "old", "mid.json"), JSON.stringify({ id: "mid", before: { a: { hash: hashOf(big("c")), mode: 0 } }, after: { a: { hash: hashOf(big("d")), mode: 0 } } }));
    await writeFile(join(checkpoints, "old", "blobs", hashOf(big("c"))), big("c")); await writeFile(join(checkpoints, "old", "blobs", hashOf(big("d"))), big("d"));
    await utimes(join(checkpoints, "old", "mid.json"), new Date(3000), new Date(3000));
    await legacy(checkpoints, "new", { "a": big("e") }, 5000, { "a": big("f") });
    const result = await cleanCheckpoints(checkpoints, { maxPointsPerConversation: 50, maxBytes: 3000 });
    assert.equal(result.removedPoints, 1);
    assert.deepEqual((await readdir(join(checkpoints, "old"))).filter(name => name.endsWith(".json")), ["mid.json"]);
    assert.equal((await readdir(join(checkpoints, "new"))).filter(name => name.endsWith(".json")).length, 1);
  });

  it("waits for captures in flight before cleaning, and holds new ones until it is done", async () => {
    const events: string[] = [];
    let release!: () => void;
    const capture = sharedAccess(async () => { events.push("capture start"); await new Promise<void>(resolve => { release = resolve; }); events.push("capture end"); });
    await new Promise(resolve => setImmediate(resolve));
    const cleaning = exclusiveAccess(async () => { events.push("clean"); await new Promise(resolve => setTimeout(resolve, 10)); events.push("clean end"); });
    const later = sharedAccess(async () => { events.push("later capture"); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["capture start"]);
    release();
    await Promise.all([capture, cleaning, later]);
    assert.deepEqual(events, ["capture start", "capture end", "clean", "clean end", "later capture"]);
  });

  it("restores still work after a clean", async () => {
    const { checkpoints, cwd, path } = await layout();
    await writeFile(path("a.txt"), "before");
    const store = new TurnCheckpoints<unknown>(join(checkpoints, "c"), cwd, join(checkpoints, ".."), sharedDirectory(checkpoints));
    const point = await store.begin(null, {});
    await writeFile(path("a.txt"), "after"); await store.finish(point, "u");
    await cleanCheckpoints(checkpoints);
    await store.restore(await store.list());
    assert.equal(await readFile(path("a.txt"), "utf8"), "before");
  });
});

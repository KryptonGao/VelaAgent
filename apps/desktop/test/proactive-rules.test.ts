import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { defaultResidentSettings, type ProactiveRule, type ResidentSettings } from "@vela/shared";
import { ProactiveRuleService, debounceMs, retryBackoffMs, type ProactiveHost } from "../src/main/proactive-rules.ts";
import type { ResidentStartResult, ResidentTaskSpec } from "../src/main/resident-agent-supervisor.ts";

async function fixture(t: TestContext, options: { seed?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vela-rules-"));
  const file = join(dir, "proactive-rules.json");
  if (options.seed !== undefined) await writeFile(file, options.seed);
  let now = new Date(2026, 9, 10, 12, 0).getTime();
  let settings: ResidentSettings = { ...structuredClone(defaultResidentSettings), mode: "proactive" };
  const flags = { suspended: false, onBattery: false };
  const started: ResidentTaskSpec[] = [];
  const watches: Array<{ path: string; recursive: boolean; emit: (name: string | null) => void; closed: boolean }> = [];
  const timers: Array<{ work: () => void; ms: number; cancelled: boolean }> = [];
  let globalRuns = 0;
  let running = false;
  let startResult: ResidentStartResult = { ok: true, taskId: "t", status: "running" };
  const host: ProactiveHost = {
    settings: () => settings, flags: () => flags, globalRunsToday: () => globalRuns, ruleRunning: () => running,
    startTask: spec => { started.push(spec); return startResult; },
    workspaces: () => ["/w"], gitDir: workspace => workspace === "/w" ? "/w/.git" : null,
    watch: (path, opts, listener) => {
      const watch = { path, recursive: opts.recursive, emit: listener, closed: false };
      watches.push(watch);
      return { close: () => { watch.closed = true; } };
    },
  };
  const make = () => new ProactiveRuleService({
    file, host, now: () => now,
    schedule: (work, ms) => { const timer = { work, ms, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true; } }; },
  });
  const service = make();
  service.init();
  t.after(async () => { service.dispose(); await rm(dir, { recursive: true, force: true }); });
  const live = () => timers.filter(timer => !timer.cancelled);
  return {
    dir, file, service, started, watches, timers, live, make,
    setSettings: (patch: Partial<ResidentSettings>) => { settings = { ...settings, ...patch }; service.sync(); },
    flags, advance: (ms: number) => { now += ms; },
    setGlobalRuns: (n: number) => { globalRuns = n; },
    setRunning: (value: boolean) => { running = value; },
    setStartResult: (result: ResidentStartResult) => { startResult = result; },
    /** 触发最近一个待执行的定时器。 */
    flush: () => { const timer = live().at(-1); assert.ok(timer, "expected a pending timer"); timer.cancelled = true; timer.work(); },
    rule: (id: string) => service.list().rules.find(rule => rule.id === id) as ProactiveRule,
  };
}

const input = (kind: "file_change" | "git_change" | "inbox_error", extra: Record<string, unknown> = {}) => ({
  title: "盯着构建", workspace: "/w", prompt: "看看哪里出错了", trigger: { kind, filter: "" }, cooldownMinutes: 30, maxRunsPerDay: 5, ...extra,
});
const saved = (f: Awaited<ReturnType<typeof fixture>>, raw: unknown) => { const result = f.service.save(raw); assert.ok(result.ok, "save failed"); return result.rule; };

it("only watches the file system in proactive mode while not paused", async t => {
  const f = await fixture(t);
  saved(f, input("file_change"));
  assert.equal(f.watches.length, 1);
  f.setSettings({ mode: "standby" });
  assert.ok(f.watches.every(watch => watch.closed), "standby releases every watcher");
  const before = f.watches.length;
  f.setSettings({ mode: "proactive", paused: true });
  assert.equal(f.watches.length, before);
  f.setSettings({ paused: false });
  assert.equal(f.watches.length, before + 1);
  assert.equal(f.watches.at(-1)?.closed, false);
});

it("does not watch disabled rules or inbox-error rules", async t => {
  const f = await fixture(t);
  saved(f, input("file_change", { enabled: false }));
  saved(f, input("inbox_error"));
  assert.equal(f.watches.length, 0);
});

it("coalesces a burst of file events into one run with a readable reason", async t => {
  const f = await fixture(t);
  const rule = saved(f, input("file_change", { trigger: { kind: "file_change", filter: ".ts" } }));
  const watch = f.watches[0]!;
  for (let i = 0; i < 40; i += 1) watch.emit("src/a.ts");
  watch.emit("src/b.ts");
  watch.emit("README.md");
  assert.equal(f.live().length, 1);
  assert.equal(f.live()[0]!.ms, debounceMs.file_change);
  assert.equal(f.started.length, 0);
  f.flush();
  assert.equal(f.started.length, 1);
  const spec = f.started[0]!;
  assert.equal(spec.ruleId, rule.id);
  assert.equal(spec.source, "rule");
  assert.equal(spec.readOnly, true);
  assert.match(spec.reason ?? "", /src\/a\.ts/);
  assert.match(spec.reason ?? "", /共 41 次事件/);
  assert.ok(!(spec.reason ?? "").includes("README"));
});

it("ignores build output, dependencies and VCS internals", async t => {
  const f = await fixture(t);
  saved(f, input("file_change"));
  const watch = f.watches[0]!;
  for (const name of [null, ".git/index", "node_modules/x/index.js", "dist/app.js", "a/b.tmp", "notes.md~"]) watch.emit(name);
  assert.equal(f.live().length, 0);
});

it("git rules react to HEAD and ref logs but not to the index", async t => {
  const f = await fixture(t);
  saved(f, input("git_change"));
  assert.deepEqual(f.watches.map(watch => [watch.path, watch.recursive]), [["/w/.git", false], ["/w/.git/logs", true]]);
  f.watches[0]!.emit("index");
  f.watches[0]!.emit("COMMIT_EDITMSG");
  assert.equal(f.live().length, 0);
  f.watches[0]!.emit("HEAD");
  assert.equal(f.live().length, 1);
  assert.equal(f.live()[0]!.ms, debounceMs.git_change);
});

it("refuses to save a rule for an unregistered workspace", async t => {
  const f = await fixture(t);
  const bad = f.service.save({ ...input("git_change"), workspace: "/w2" });
  assert.equal(bad.ok, false, "unregistered workspaces are refused at save");
});

it("inbox error rules fire immediately, with filter and workspace matching", async t => {
  const f = await fixture(t);
  saved(f, input("inbox_error", { trigger: { kind: "inbox_error", filter: "build" } }));
  const base = { id: "i", type: "error", origin: "scheduled_task", workspaceId: "/w", title: "夜间任务", summary: "Build failed: exit 1" };
  f.service.onInboxItem({ ...base, workspaceId: "/other" });
  f.service.onInboxItem({ ...base, summary: "network down" });
  f.service.onInboxItem({ ...base, type: "result" });
  assert.equal(f.started.length, 0);
  f.service.onInboxItem(base);
  assert.equal(f.started.length, 1);
  assert.match(f.started[0]!.reason ?? "", /Build failed/);
});

it("never reacts to failures produced by the resident or by proactive runs", async t => {
  const f = await fixture(t);
  saved(f, input("inbox_error"));
  const base = { id: "i", type: "error", workspaceId: "/w", title: "x", summary: "boom" };
  f.service.onInboxItem({ ...base, origin: "proactive" });
  f.service.onInboxItem({ ...base, origin: "resident" });
  assert.equal(f.started.length, 0);
});

it("enforces cooldown, then the per-rule daily cap", async t => {
  const f = await fixture(t);
  const rule = saved(f, input("inbox_error", { cooldownMinutes: 10, maxRunsPerDay: 2 }));
  const fail = (id: string) => f.service.onInboxItem({ id, type: "error", origin: "turn", workspaceId: "/w", title: "t", summary: "s" });
  fail("1");
  fail("2");
  assert.equal(f.started.length, 1);
  assert.equal(f.rule(rule.id).lastSkip?.reason, "cooldown");
  f.advance(11 * 60_000);
  fail("3");
  assert.equal(f.started.length, 2);
  assert.equal(f.rule(rule.id).runsToday, 2);
  f.advance(11 * 60_000);
  fail("4");
  assert.equal(f.started.length, 2);
  assert.equal(f.rule(rule.id).lastSkip?.reason, "rule_limit");
  f.advance(24 * 60 * 60_000);
  fail("5");
  assert.equal(f.started.length, 3, "a new day resets the counter");
  assert.equal(f.rule(rule.id).runsToday, 1);
});

it("honours the global daily limit, battery, sleep and an already-running task", async t => {
  const f = await fixture(t);
  const rule = saved(f, input("inbox_error", { cooldownMinutes: 1 }));
  const fail = () => { f.advance(2 * 60_000); f.service.onInboxItem({ id: String(Math.random()), type: "error", origin: "turn", workspaceId: "/w", title: "t", summary: "s" }); };
  f.setGlobalRuns(10);
  fail();
  assert.equal(f.rule(rule.id).lastSkip?.reason, "daily_limit");
  f.setGlobalRuns(0);
  f.flags.onBattery = true;
  fail();
  assert.equal(f.rule(rule.id).lastSkip?.reason, "battery");
  f.flags.onBattery = false;
  f.flags.suspended = true;
  fail();
  assert.equal(f.rule(rule.id).lastSkip?.reason, "suspended");
  f.flags.suspended = false;
  f.setRunning(true);
  fail();
  assert.equal(f.rule(rule.id).lastSkip?.reason, "already_running");
  assert.equal(f.started.length, 0, "no model call was made for any skipped signal");
  f.setRunning(false);
  fail();
  assert.equal(f.started.length, 1);
  assert.equal(f.rule(rule.id).lastSkip, null, "a successful run clears the skip reason");
});

it("does not fire at all outside proactive mode even if a signal slips through", async t => {
  const f = await fixture(t);
  const rule = saved(f, input("inbox_error"));
  f.setSettings({ mode: "standby" });
  f.service.onInboxItem({ id: "i", type: "error", origin: "turn", workspaceId: "/w", title: "t", summary: "s" });
  assert.equal(f.started.length, 0);
  assert.equal(f.rule(rule.id).lastSkip?.reason, "disabled_mode");
});

it("retries a full queue with backoff and then gives up", async t => {
  const f = await fixture(t);
  const rule = saved(f, input("inbox_error"));
  f.setStartResult({ ok: false, reason: "queue_full" });
  f.service.onInboxItem({ id: "i", type: "error", origin: "turn", workspaceId: "/w", title: "t", summary: "s" });
  for (const delay of retryBackoffMs) {
    assert.equal(f.live().at(-1)?.ms, delay);
    f.flush();
  }
  assert.equal(f.started.length, retryBackoffMs.length + 1);
  assert.equal(f.live().length, 0, "no further retries after the schedule is exhausted");
  assert.equal(f.rule(rule.id).lastSkip?.reason, "busy");
  assert.equal(f.rule(rule.id).lastTriggeredAt, null, "a rejected start does not consume cooldown");
});

it("removing a rule cancels its pending signal and closes its watchers", async t => {
  const f = await fixture(t);
  const rule = saved(f, input("file_change"));
  f.watches[0]!.emit("a.ts");
  const timer = f.live()[0]!;
  f.service.remove(rule.id);
  assert.equal(timer.cancelled, true);
  assert.ok(f.watches.every(watch => watch.closed));
  assert.equal(f.service.list().rules.length, 0);
});

it("validates input and refuses unknown workspaces and unknown rules", async t => {
  const f = await fixture(t);
  assert.equal(f.service.save({ ...input("file_change"), title: " " }).ok, false);
  assert.equal(f.service.save({ ...input("file_change"), trigger: { kind: "nope" } }).ok, false);
  assert.equal(f.service.save({ ...input("file_change"), workspace: "/etc" }).ok, false);
  assert.equal(f.service.save(input("file_change"), "missing").ok, false);
  const rule = saved(f, input("file_change"));
  const edited = f.service.save({ ...input("file_change"), title: "新标题", cooldownMinutes: 99999 }, rule.id);
  assert.ok(edited.ok);
  assert.equal(edited.rule.id, rule.id);
  assert.equal(edited.rule.cooldownMinutes, 24 * 60, "out-of-range values are clamped");
  assert.equal(f.service.list().rules.length, 1);
});

it("tasks run read-only unless the rule explicitly allows tools", async t => {
  const f = await fixture(t);
  saved(f, input("inbox_error", { allowTools: true }));
  f.service.onInboxItem({ id: "i", type: "error", origin: "turn", workspaceId: "/w", title: "t", summary: "s" });
  assert.equal(f.started[0]?.readOnly, false);
  assert.match(f.started[0]?.prompt ?? "", /每一步都会请求用户批准/);
});

it("persists rules and counters, and quarantines a corrupt file", async t => {
  const f = await fixture(t);
  const rule = saved(f, input("inbox_error"));
  f.service.onInboxItem({ id: "i", type: "error", origin: "turn", workspaceId: "/w", title: "t", summary: "s" });
  const stored = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(stored.rules[0].runsToday, 1);
  const reopened = f.make();
  reopened.init();
  assert.equal(reopened.list().rules[0]?.id, rule.id);
  assert.equal(reopened.list().rules[0]?.runsToday, 1);
  assert.equal(reopened.list().rules[0]?.lastSkip, null, "skip reasons are not persisted");
  reopened.dispose();

  const bad = await fixture(t, { seed: "[1,2" });
  assert.match(bad.service.list().error ?? "", /已损坏/);
  assert.deepEqual(bad.service.list().rules, []);
  assert.ok((await readdir(bad.dir)).some(name => name.startsWith("proactive-rules.json.corrupt-")));
});

it("notifies subscribers when a rule changes, and stops after unsubscribe", async t => {
  const f = await fixture(t);
  const seen: number[] = [];
  const off = f.service.subscribe(state => seen.push(state.rules.length));
  saved(f, input("file_change"));
  off();
  saved(f, input("file_change"));
  assert.ok(seen.length >= 1);
  assert.ok(seen.every(count => count === 1));
});

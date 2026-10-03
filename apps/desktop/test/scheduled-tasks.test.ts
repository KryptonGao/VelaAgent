import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ScheduledTaskScheduler, type TaskExecutor } from "../src/main/scheduled-task-service.ts";
import { nextTaskTime, parseTaskInput } from "../src/main/task-schedule.ts";
import type { ScheduledTaskInput } from "@vela/shared";

async function fixture(t: TestContext, execute: TaskExecutor = async () => {}) {
  const cwd = await mkdtemp(join(tmpdir(), "vela-scheduled-"));
  const file = join(cwd, "tasks.json");
  let now = Date.parse("2026-10-03T12:00:00Z");
  const scheduler = new ScheduledTaskScheduler(file, execute, () => now);
  scheduler.init();
  t.after(async () => { scheduler.stop(); await scheduler.drain(); await rm(cwd, { recursive: true, force: true }); });
  const input = (extra: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput => ({ title: "English", prompt: "复习英语", workspace: cwd,
    schedule: { kind: "daily", time: "22:00", timezone: "Asia/Taipei" }, ...extra });
  return { cwd, file, scheduler, input, time: (value: string) => { now = Date.parse(value); }, now: () => now };
}

it("calculates once, daily, weekly and five-field cron in the saved timezone", () => {
  const after = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(nextTaskTime({ kind: "daily", time: "22:00", timezone: "Asia/Taipei" }, after), Date.parse("2026-10-03T14:00:00Z"));
  assert.equal(nextTaskTime({ kind: "weekly", time: "22:00", weekdays: [1, 3], timezone: "Asia/Taipei" }, after), Date.parse("2026-10-05T14:00:00Z"));
  assert.equal(nextTaskTime({ kind: "cron", expression: "*/15 * * * *", timezone: "UTC" }, after), after + 900_000);
  assert.equal(nextTaskTime({ kind: "once", at: "2026-10-03T14:00:00Z" }, after), after + 7200_000);
  assert.equal(nextTaskTime({ kind: "once", at: "2026-10-03T14:00:00Z" }, after + 7200_000), null);
});
it("handles DST boundaries without fixed 24-hour arithmetic", () => {
  const schedule = { kind: "daily" as const, time: "09:00", timezone: "America/New_York" };
  assert.equal(nextTaskTime(schedule, Date.parse("2026-03-07T14:00:00Z")), Date.parse("2026-03-08T13:00:00Z"));
  assert.equal(nextTaskTime(schedule, Date.parse("2026-10-31T13:00:00Z")), Date.parse("2026-11-01T14:00:00Z"));
});
it("rejects malformed schedules, workspace paths, policies and ambiguous once times", async t => {
  const f = await fixture(t);
  for (const schedule of [null, { kind: "daily", time: "25:00", timezone: "UTC" }, { kind: "daily", time: "22:00", timezone: "nowhere" },
    { kind: "weekly", time: "22:00", weekdays: [], timezone: "UTC" }, { kind: "weekly", time: "22:00", weekdays: [7], timezone: "UTC" },
    { kind: "once", at: "2026-10-03T22:00" }, { kind: "cron", expression: "0 0 0 * * *", timezone: "UTC" },
    { kind: "cron", expression: "65 0 * * *", timezone: "UTC" }]) {
    assert.throws(() => parseTaskInput({ ...f.input(), schedule }));
  }
  assert.throws(() => parseTaskInput({ ...f.input(), workspace: "relative" }));
  assert.throws(() => parseTaskInput({ ...f.input(), missedPolicy: "invalid" }));
  await assert.rejects(f.scheduler.create(f.input({ schedule: { kind: "once", at: "2026-10-01T22:00:00Z" } })));
  await assert.rejects(f.scheduler.create(f.input({ workspace: join(f.cwd, "missing") })));
});
it("persists claims before execution, links chats, completes once and rejects duplicate ticks", async t => {
  let calls = 0;
  const f = await fixture(t, async (_task, link) => {
    calls++; assert.equal(JSON.parse(readFileSync(f.file, "utf8")).runs[0].status, "running"); link("chat-1");
  });
  const task = await f.scheduler.create(f.input({ schedule: { kind: "once", at: "2026-10-03T12:01:00Z" } }));
  f.scheduler.start(); f.time("2026-10-03T12:01:00Z");
  f.scheduler.tick(); f.scheduler.tick(); f.scheduler.resume(); await f.scheduler.drain();
  assert.equal(calls, 1);
  assert.equal(f.scheduler.list().tasks[0].status, "completed");
  assert.equal(f.scheduler.list().tasks[0].nextRunAt, null);
  assert.equal(f.scheduler.list().runs[0].conversationId, "chat-1");
  assert.equal(f.scheduler.list().runs[0].status, "success");
  const restarted = new ScheduledTaskScheduler(f.file, async () => { calls++; }, f.now);
  restarted.init(); restarted.start(); await restarted.drain(); restarted.stop();
  assert.equal(calls, 1); assert.equal(restarted.list().tasks[0].id, task.id);
});
it("coalesces missed periods on wake and skips them when configured", async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; });
  await f.scheduler.create(f.input());
  await f.scheduler.create(f.input({ missedPolicy: "skip" }));
  f.scheduler.start(); f.scheduler.suspend(); f.time("2026-10-08T12:00:00Z"); f.scheduler.tick();
  assert.equal(f.scheduler.list().runs.length, 0);
  f.scheduler.resume(); f.scheduler.resume(); await f.scheduler.drain();
  assert.equal(calls, 1);
  assert.deepEqual(f.scheduler.list().runs.map(run => run.status), ["success", "skipped"]);
  assert.ok(f.scheduler.list().tasks.every(task => task.nextRunAt === Date.parse("2026-10-08T14:00:00Z")));
});
it("prevents overlap, rejects manual duplicates, and leaves scheduled time intact on run-now", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async () => gate);
  const task = await f.scheduler.create(f.input()); f.scheduler.start();
  await f.scheduler.runNow(task.id);
  assert.equal(f.scheduler.list().tasks[0].nextRunAt, task.nextRunAt);
  await assert.rejects(f.scheduler.runNow(task.id), /正在执行/);
  await assert.rejects(f.scheduler.delete(task.id), /正在执行/);
  f.time("2026-10-03T14:00:00Z"); f.scheduler.tick();
  assert.equal(f.scheduler.list().runs[1].status, "skipped");
  release(); await f.scheduler.drain();
  await f.scheduler.delete(task.id); assert.equal(f.scheduler.list().runs.length, 0);
});
it("pause/resume, editing and deletion survive restart; list snapshots cannot mutate storage", async t => {
  const f = await fixture(t); const task = await f.scheduler.create(f.input());
  await f.scheduler.update(task.id, { status: "paused", title: "Paused" });
  const restarted = new ScheduledTaskScheduler(f.file, async () => {}, f.now); restarted.init();
  assert.equal(restarted.list().tasks[0].status, "paused");
  const snapshot = restarted.list(); snapshot.tasks[0].title = "untrusted";
  assert.equal(restarted.list().tasks[0].title, "Paused");
  await restarted.update(task.id, { status: "active", schedule: { kind: "weekly", time: "09:00", weekdays: [1], timezone: "Asia/Taipei" } });
  assert.equal(restarted.list().tasks[0].nextRunAt, Date.parse("2026-10-05T01:00:00Z"));
  await restarted.delete(task.id); assert.equal(JSON.parse(readFileSync(f.file, "utf8")).tasks.length, 0);
});
it("recovers in-flight records as interrupted and never replays their original slot", async t => {
  const f = await fixture(t); await f.scheduler.create(f.input());
  const stored = JSON.parse(readFileSync(f.file, "utf8"));
  stored.tasks[0].nextRunAt = Date.parse("2026-10-04T14:00:00Z");
  stored.runs.push({ id: "claimed", taskId: stored.tasks[0].id, trigger: "scheduled", scheduledAt: Date.parse("2026-10-03T14:00:00Z"),
    startedAt: Date.parse("2026-10-03T14:00:00Z"), finishedAt: null, status: "running", conversationId: "persisted-chat", error: null });
  writeFileSync(f.file, JSON.stringify(stored)); f.time("2026-10-03T15:00:00Z");
  let calls = 0; const restarted = new ScheduledTaskScheduler(f.file, async () => { calls++; }, f.now);
  restarted.init(); restarted.start(); await restarted.drain(); restarted.stop();
  assert.equal(calls, 0); assert.equal(restarted.list().runs[0].status, "interrupted");
  assert.equal(restarted.list().runs[0].conversationId, "persisted-chat");
});
it("retains runtime failures and does not disable the recurring schedule", async t => {
  const f = await fixture(t, async (_task, link) => { link("failed-chat"); throw new Error("Model unavailable"); });
  const task = await f.scheduler.create(f.input()); f.scheduler.start();
  await f.scheduler.runNow(task.id); await f.scheduler.drain();
  assert.equal(f.scheduler.list().runs[0].status, "failed");
  assert.equal(f.scheduler.list().runs[0].error, "Model unavailable");
  assert.equal(f.scheduler.list().tasks[0].status, "active");
  f.scheduler.stop(); await assert.rejects(f.scheduler.runNow(task.id));
});
it("does not overwrite corrupted persisted task data", async t => {
  const f = await fixture(t); writeFileSync(f.file, "corrupted");
  assert.throws(() => f.scheduler.init()); assert.equal(readFileSync(f.file, "utf8"), "corrupted");
});
it("fails before external effects when the claim cannot be persisted", async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; });
  const task = await f.scheduler.create(f.input()); f.scheduler.start();
  await rm(f.cwd, { recursive: true, force: true }); writeFileSync(f.cwd, "blocked-directory");
  await assert.rejects(f.scheduler.runNow(task.id));
  assert.equal(calls, 0); assert.equal(f.scheduler.list().runs.length, 0);
});
it("shutdown marks active runs interrupted and later completion cannot overwrite that status", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (_task, link) => { link("closing-chat"); await gate; });
  const task = await f.scheduler.create(f.input()); f.scheduler.start(); await f.scheduler.runNow(task.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  f.scheduler.stop(); assert.equal(f.scheduler.list().runs[0].status, "interrupted");
  release(); await f.scheduler.drain();
  assert.equal(f.scheduler.list().runs[0].status, "interrupted");
  assert.equal(f.scheduler.list().runs[0].conversationId, "closing-chat");
});
it("runs an overdue once task once after restart and can explicitly skip it", async t => {
  const f = await fixture(t); const schedule = { kind: "once" as const, at: "2026-10-03T13:00:00Z" };
  await f.scheduler.create(f.input({ schedule })); await f.scheduler.create(f.input({ schedule, missedPolicy: "skip" }));
  f.time("2026-10-04T13:00:00Z"); let calls = 0;
  const restarted = new ScheduledTaskScheduler(f.file, async () => { calls++; }, f.now);
  restarted.init(); restarted.start(); restarted.resume(); await restarted.drain(); restarted.stop();
  assert.equal(calls, 1); assert.ok(restarted.list().tasks.every(task => task.status === "completed"));
  assert.deepEqual(restarted.list().runs.map(run => run.status), ["success", "skipped"]);
});
it("bounds terminal history and preserves new run identities", async t => {
  const f = await fixture(t); const task = await f.scheduler.create(f.input()); f.scheduler.start();
  for (let i=0; i<102; i++) { await f.scheduler.runNow(task.id); await f.scheduler.drain(); }
  assert.equal(f.scheduler.list().runs.length, 100);
  assert.equal(new Set(f.scheduler.list().runs.map(run => run.id)).size, 100);
});

it("validates execution options, persists edits and allows restoring app defaults", async t => {
  const seen: ScheduledTaskInput[] = [];
  const f = await fixture(t, async task => { seen.push(task); });
  for (const extra of [{ sandboxMode: "invalid" }, { thinkingLevel: "invalid" }, { model: "invalid" }, { model: { provider: "", id: "x" } }, { model: { provider: "x" } }]) {
    assert.throws(() => parseTaskInput({ ...f.input(), ...extra }));
  }
  const execution = { sandboxMode: "full" as const, model: { provider: "provider", id: "model" }, thinkingLevel: "high" as const };
  const task = await f.scheduler.create(f.input(execution));
  const restarted = new ScheduledTaskScheduler(f.file, async task => { seen.push(task); }, f.now);
  restarted.init(); restarted.start();
  t.after(async () => { restarted.stop(); await restarted.drain(); });
  await restarted.runNow(task.id); await restarted.drain();
  for (const key of ["sandboxMode", "model", "thinkingLevel"] as const) assert.deepEqual(seen[0][key], execution[key]);
  await restarted.update(task.id, { title: "Edited" });
  assert.deepEqual(restarted.list().tasks[0].model, execution.model);
  await restarted.update(task.id, { sandboxMode: "ask", thinkingLevel: "off" });
  assert.equal(restarted.list().tasks[0].sandboxMode, "ask");
  await restarted.update(task.id, { sandboxMode: null, model: null, thinkingLevel: null });
  await restarted.runNow(task.id); await restarted.drain();
  assert.equal(seen[1].sandboxMode, null); assert.equal(seen[1].model, null); assert.equal(seen[1].thinkingLevel, null);
});
it("loads legacy tasks without execution options", async t => {
  const f = await fixture(t); await f.scheduler.create(f.input());
  const stored = JSON.parse(readFileSync(f.file, "utf8"));
  delete stored.tasks[0].model; delete stored.tasks[0].thinkingLevel; delete stored.tasks[0].sandboxMode;
  writeFileSync(f.file, JSON.stringify(stored));
  const restarted = new ScheduledTaskScheduler(f.file, async () => {}, f.now); restarted.init();
  assert.equal(restarted.list().tasks.length, 1);
  assert.equal(restarted.list().tasks[0].model, undefined);
});

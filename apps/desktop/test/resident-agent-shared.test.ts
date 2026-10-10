import assert from "node:assert/strict";
import { it } from "node:test";
import {
  admitProactiveRun,
  defaultResidentSettings,
  deriveResidentState,
  isIgnoredWorkspacePath,
  isQuietNow,
  latestUiReply,
  localDay,
  mergeResidentSettings,
  normalizeResidentSettings,
  normalizeRuleInput,
  resolveUiContent,
  uiContentRef,
} from "@vela/shared";

const fence = (id: string) => `说明\n\`\`\`vela-ui\n{"op":"begin","id":"${id}","version":1}\n{"op":"commit"}\n\`\`\``;

it("normalizes arbitrary input into valid settings", () => {
  assert.deepEqual(normalizeResidentSettings(undefined), defaultResidentSettings);
  const settings = normalizeResidentSettings({
    mode: "weird", paused: "yes", limits: { maxConcurrentTasks: 99, maxTaskMinutes: -4, dailyProactiveRuns: 3.6 },
    notifications: { quietHours: { enabled: true, startMinute: 99999, endMinute: "x" } },
  });
  assert.equal(settings.mode, "standby");
  assert.equal(settings.paused, false);
  assert.equal(settings.limits.maxConcurrentTasks, 5);
  assert.equal(settings.limits.maxTaskMinutes, 5);
  assert.equal(settings.limits.dailyProactiveRuns, 4);
  assert.equal(settings.notifications.quietHours.startMinute, 24 * 60 - 1);
  assert.equal(settings.notifications.quietHours.endMinute, defaultResidentSettings.notifications.quietHours.endMinute);
});

it("merges patches without losing sibling fields and ignores unknown keys", () => {
  const next = mergeResidentSettings(defaultResidentSettings, { mode: "proactive", limits: { maxTaskMinutes: 30 }, notifications: { hidePreview: true }, evil: 1 });
  assert.equal(next.mode, "proactive");
  assert.equal(next.limits.maxTaskMinutes, 30);
  assert.equal(next.limits.maxConcurrentTasks, defaultResidentSettings.limits.maxConcurrentTasks);
  assert.equal(next.notifications.hidePreview, true);
  assert.equal(next.notifications.enabled, true);
  assert.equal("evil" in next, false);
  // 非法值保留当前设置，而不是回到默认。
  const kept = mergeResidentSettings(next, { mode: "nope", limits: { maxTaskMinutes: "x" } });
  assert.equal(kept.mode, "proactive");
  assert.equal(kept.limits.maxTaskMinutes, 30);
});

it("handles quiet hours across midnight", () => {
  const quiet = { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 };
  const at = (hour: number, minute = 0) => new Date(2026, 9, 10, hour, minute);
  assert.equal(isQuietNow(quiet, at(23)), true);
  assert.equal(isQuietNow(quiet, at(7, 59)), true);
  assert.equal(isQuietNow(quiet, at(8)), false);
  assert.equal(isQuietNow(quiet, at(12)), false);
  assert.equal(isQuietNow({ ...quiet, enabled: false }, at(23)), false);
  assert.equal(isQuietNow({ enabled: true, startMinute: 9 * 60, endMinute: 17 * 60 }, at(10)), true);
  assert.equal(isQuietNow({ enabled: true, startMinute: 60, endMinute: 60 }, at(1)), false);
});

it("derives the overall state without letting one waiting task hide running work", () => {
  const base = { mode: "standby" as const, paused: false, suspended: false, runtimeAvailable: true, error: null, runningTasks: 0, residentBusy: false, waitingItems: 0 };
  assert.equal(deriveResidentState(base), "ready");
  assert.equal(deriveResidentState({ ...base, waitingItems: 2 }), "waiting_user");
  assert.equal(deriveResidentState({ ...base, runningTasks: 1, waitingItems: 2 }), "working");
  assert.equal(deriveResidentState({ ...base, residentBusy: true }), "working");
  assert.equal(deriveResidentState({ ...base, error: "x" }), "error");
  assert.equal(deriveResidentState({ ...base, error: "x", runningTasks: 1 }), "error");
  assert.equal(deriveResidentState({ ...base, mode: "disabled" }), "offline");
  assert.equal(deriveResidentState({ ...base, runtimeAvailable: false }), "offline");
  assert.equal(deriveResidentState({ ...base, suspended: true, runningTasks: 1 }), "suspended");
  assert.equal(deriveResidentState({ ...base, paused: true, suspended: true, error: "x" }), "paused");
});

const rule = { enabled: true, lastTriggeredAt: null, cooldownMinutes: 30, maxRunsPerDay: 2, runDay: "", runsToday: 0 };
const settings = { mode: "proactive" as const, paused: false, limits: { ...defaultResidentSettings.limits, dailyProactiveRuns: 5 } };
const admit = (patch: object = {}, input: object = {}) => admitProactiveRun({
  rule: { ...rule, ...patch }, settings, now: Date.UTC(2026, 9, 10, 12), suspended: false, onBattery: false, ruleRunning: false, globalRunsToday: 0, ...input,
});

it("admits a proactive run only when every guard passes", () => {
  assert.deepEqual(admit(), { ok: true });
  assert.deepEqual(admit({ enabled: false }), { ok: false, reason: "disabled_mode" });
  assert.deepEqual(admit({}, { settings: { ...settings, mode: "standby" } }), { ok: false, reason: "disabled_mode" });
  assert.deepEqual(admit({}, { settings: { ...settings, paused: true } }), { ok: false, reason: "paused" });
  assert.deepEqual(admit({}, { suspended: true }), { ok: false, reason: "suspended" });
  assert.deepEqual(admit({}, { onBattery: true }), { ok: false, reason: "battery" });
  assert.deepEqual(admit({}, { onBattery: true, settings: { ...settings, limits: { ...settings.limits, pauseProactiveOnBattery: false } } }), { ok: true });
  assert.deepEqual(admit({}, { ruleRunning: true }), { ok: false, reason: "already_running" });
  const now = Date.UTC(2026, 9, 10, 12);
  assert.deepEqual(admit({ lastTriggeredAt: now - 10 * 60_000 }), { ok: false, reason: "cooldown" });
  assert.deepEqual(admit({ lastTriggeredAt: now - 31 * 60_000 }), { ok: true });
  assert.deepEqual(admit({ runDay: localDay(now), runsToday: 2 }), { ok: false, reason: "rule_limit" });
  // 昨天的计数不算数。
  assert.deepEqual(admit({ runDay: "2020-01-01", runsToday: 99 }), { ok: true });
  assert.deepEqual(admit({}, { globalRunsToday: 5 }), { ok: false, reason: "daily_limit" });
});

it("validates rule input", () => {
  const good = { title: " 每日检查 ", workspace: "/work/a", prompt: "整理错误", trigger: { kind: "inbox_error", filter: " test " }, cooldownMinutes: 0, maxRunsPerDay: 500 };
  const parsed = normalizeRuleInput(good);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.input.title, "每日检查");
    assert.equal(parsed.input.trigger.filter, "test");
    assert.equal(parsed.input.cooldownMinutes, 1);
    assert.equal(parsed.input.maxRunsPerDay, 50);
    assert.equal(parsed.input.allowTools, false);
    assert.equal(parsed.input.enabled, true);
  }
  for (const bad of [{ ...good, title: "" }, { ...good, workspace: "relative" }, { ...good, prompt: "  " }, { ...good, trigger: { kind: "exec" } }, null, "x"]) {
    assert.equal(normalizeRuleInput(bad).ok, false);
  }
});

it("ignores build output and VCS internals for file triggers", () => {
  for (const path of ["node_modules/a/index.js", ".git/index", "dist/app.js", "src/.DS_Store", "src/a.ts.tmp", "src/a.ts~"]) assert.equal(isIgnoredWorkspacePath(path), true, path);
  for (const path of ["src/app.ts", "README.md", "packages/a/src/dist-helper.ts"]) assert.equal(isIgnoredWorkspacePath(path), false, path);
});

it("locates and revalidates an Intelligent UI reply", () => {
  const messages = [
    { role: "user", text: "q" },
    { role: "assistant", text: "没有界面" },
    { role: "assistant", text: fence("a") },
    { role: "user", text: "again" },
    { role: "assistant", text: fence("b") },
  ];
  const reply = latestUiReply(messages);
  assert.ok(reply);
  assert.equal(reply.ordinal, 1);
  const ref = uiContentRef("c1", reply);
  assert.equal(resolveUiContent(messages, ref)?.text, messages[4]!.text);
  assert.equal(resolveUiContent(messages, ref)?.uiOrdinal, 1);
  // 回退后位置不再存在，或正文被改写，都不能套用旧定位。
  assert.equal(resolveUiContent(messages.slice(0, 3), ref), null);
  assert.equal(resolveUiContent([...messages.slice(0, 4), { role: "assistant", text: fence("changed") }], ref), null);
  // 最后一条有正文的回复不含界面时没有定位。
  assert.equal(latestUiReply([...messages, { role: "assistant", text: "后记" }]), null);
  assert.equal(latestUiReply([{ role: "assistant", text: "  " }, { role: "user", text: "x" }]), null);
});

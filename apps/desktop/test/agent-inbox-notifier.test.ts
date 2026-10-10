import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultResidentSettings, type AgentInboxItem, type ResidentSettings } from "@vela/shared";
import { AgentInboxNotifier, notificationBurst, type InboxNotification } from "../src/main/agent-inbox-notifier.ts";

function item(id: string, patch: Partial<AgentInboxItem> = {}): AgentInboxItem {
  return {
    id, schemaVersion: 1, type: "question", origin: "question", status: "pending", readState: "unread", priority: "high",
    title: "构建任务", summary: "要继续吗？", sourceEventId: id, revision: 1, createdAt: 0, updatedAt: 0, actions: [],
    detail: { kind: "question", toolCallId: "t", question: "要继续吗？", options: [], allowFreeText: true }, decisions: {},
    ...patch,
  };
}

function setup(patch: (settings: ResidentSettings) => ResidentSettings = settings => settings) {
  let now = new Date(2026, 9, 10, 12, 0).getTime();
  let focused = false;
  let settings = patch(structuredClone(defaultResidentSettings));
  const shown: InboxNotification[] = [];
  const timers: Array<{ work: () => void; ms: number; cancelled: boolean }> = [];
  const notifier = new AgentInboxNotifier({
    settings: () => settings, locale: () => "zh-CN", appFocused: () => focused, show: n => shown.push(n), now: () => now,
    schedule: (work, ms) => { const timer = { work, ms, cancelled: false }; timers.push(timer); return { cancel: () => { timer.cancelled = true; } }; },
  });
  return {
    notifier, shown, timers,
    setFocused: (value: boolean) => { focused = value; },
    setSettings: (next: ResidentSettings) => { settings = next; },
    advance: (ms: number) => { now += ms; },
    at: (hour: number, minute = 0) => { now = new Date(2026, 9, 10, hour, minute).getTime(); },
  };
}

it("notifies pending approvals and questions once per item", () => {
  const s = setup();
  s.notifier.onChange({ upserts: [item("a")] });
  s.notifier.onChange({ upserts: [item("a", { revision: 2 })] });
  assert.equal(s.shown.length, 1);
  assert.equal(s.shown[0]?.itemId, "a");
  assert.equal(s.shown[0]?.title, "Agent 在等你的回答");
});

it("seeded items from before startup are never announced again", () => {
  const s = setup();
  s.notifier.seed([{ id: "old" }]);
  s.notifier.onChange({ upserts: [item("old")] });
  assert.equal(s.shown.length, 0);
});

it("ignores read items, plain results and resolved items by default", () => {
  const s = setup();
  s.notifier.onChange({ upserts: [
    item("read", { readState: "read" }),
    item("done", { type: "result", status: "resolved", detail: { kind: "text", text: "ok" } }),
    item("answered", { status: "resolved" }),
  ] });
  assert.equal(s.shown.length, 0);
  s.setSettings({ ...defaultResidentSettings, notifications: { ...defaultResidentSettings.notifications, notifyResults: true } });
  s.notifier.onChange({ upserts: [item("done2", { type: "result", status: "resolved", detail: { kind: "text", text: "ok" } })] });
  assert.equal(s.shown.length, 1);
});

it("announces proactive suggestions even though they are not pending", () => {
  const s = setup();
  s.notifier.onChange({ upserts: [item("s", { type: "suggestion", origin: "proactive", status: "resolved", detail: { kind: "text", text: "建议" } })] });
  assert.equal(s.shown[0]?.title, "Agent 的建议");
});

it("respects the master switch, quiet hours and a focused window but still marks the item seen", () => {
  const off = setup(settings => ({ ...settings, notifications: { ...settings.notifications, enabled: false } }));
  off.notifier.onChange({ upserts: [item("a")] });
  assert.equal(off.shown.length, 0);

  const quiet = setup(settings => ({ ...settings, notifications: { ...settings.notifications, quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 } } }));
  quiet.at(23);
  quiet.notifier.onChange({ upserts: [item("a")] });
  quiet.at(9);
  quiet.notifier.onChange({ upserts: [item("a")] });
  assert.equal(quiet.shown.length, 0, "an item suppressed at night is not announced later in the morning");
  quiet.notifier.onChange({ upserts: [item("b")] });
  assert.equal(quiet.shown.length, 1);

  const focused = setup();
  focused.setFocused(true);
  focused.notifier.onChange({ upserts: [item("a")] });
  assert.equal(focused.shown.length, 0);
});

it("hides the preview but keeps the item reference", () => {
  const s = setup(settings => ({ ...settings, notifications: { ...settings.notifications, hidePreview: true } }));
  s.notifier.onChange({ upserts: [item("a", { detail: { kind: "question", toolCallId: "t", question: "密码是 hunter2 吗？", options: [], allowFreeText: true } })] });
  assert.equal(s.shown[0]?.title, "Vela");
  assert.ok(!JSON.stringify(s.shown[0]).includes("hunter2"));
  assert.equal(s.shown[0]?.itemId, "a");
});

it("shows the command or path of an approval, truncated", () => {
  const s = setup();
  const request = { id: "r", kind: "command", cwd: "/w", command: "x".repeat(400) } as never;
  s.notifier.onChange({ upserts: [item("a", { type: "approval", origin: "sandbox", detail: { kind: "approval", request } })] });
  assert.equal(s.shown[0]?.title, "需要你批准");
  assert.ok(s.shown[0]!.body.length < 200);
});

it("collapses a burst into three notifications and one summary", () => {
  const s = setup();
  for (let i = 0; i < 7; i += 1) s.notifier.onChange({ upserts: [item(`b${i}`)] });
  assert.equal(s.shown.length, notificationBurst.max);
  assert.equal(s.timers.length, 1, "one summary timer regardless of overflow size");
  s.advance(notificationBurst.windowMs);
  s.timers[0]!.work();
  assert.equal(s.shown.length, notificationBurst.max + 1);
  assert.match(s.shown.at(-1)!.body, /4 项/);
  assert.equal(s.shown.at(-1)?.itemId, undefined);
  s.notifier.onChange({ upserts: [item("later")] });
  assert.equal(s.shown.length, notificationBurst.max + 2, "the window reopens after it elapses");
});

it("dispose cancels the pending summary", () => {
  const s = setup();
  for (let i = 0; i < 5; i += 1) s.notifier.onChange({ upserts: [item(`b${i}`)] });
  s.notifier.dispose();
  assert.equal(s.timers[0]?.cancelled, true);
});

it("a failing sink never throws into the inbox pipeline", () => {
  const notifier = new AgentInboxNotifier({
    settings: () => structuredClone(defaultResidentSettings), locale: () => "en", appFocused: () => false,
    show: () => { throw new Error("no display"); },
  });
  assert.doesNotThrow(() => notifier.onChange({ upserts: [item("a")] }));
});

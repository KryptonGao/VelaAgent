import assert from "node:assert/strict";
import { it } from "node:test";
import type { ResidentStatus } from "@vela/shared";
import { ResidentTray, describeTray, type TrayAction, type TrayHandle } from "../src/main/resident-tray.ts";

function status(patch: Partial<ResidentStatus> = {}): ResidentStatus {
  return {
    state: "ready", mode: "standby", paused: false, conversationId: null, model: null, residentBusy: false, runningTasks: 0, queuedTasks: 0,
    waitingItems: 0, pendingItems: 0, lastActivityAt: null, suspended: false, onBattery: false, error: null, proactiveRunsToday: 0,
    tasks: [], workspaces: [], revision: 1, ...patch,
  };
}

it("describes an idle resident in both languages with no badge", () => {
  const zh = describeTray(status(), "zh-CN");
  assert.equal(zh.title, "");
  assert.deepEqual(zh.items.filter(item => item.kind === "label").map(item => item.label), ["Resident Agent：待命", "没有待处理事项"]);
  const en = describeTray(status(), "en");
  assert.ok(en.items.some(item => item.label === "All caught up"));
  assert.ok(en.items.some(item => item.id === "quit" && item.label === "Quit Vela"));
});

it("shows the pending count, capped, and running work", () => {
  const busy = describeTray(status({ state: "working", pendingItems: 3, runningTasks: 2, queuedTasks: 1 }), "en");
  assert.equal(busy.title, "3");
  assert.ok(busy.items.some(item => item.label === "2 running · 1 queued"));
  assert.ok(busy.items.some(item => item.label === "3 need your attention"));
  assert.equal(describeTray(status({ pendingItems: 250 }), "en").title, "99+");
});

it("offers pause or resume and disables it when the resident is off", () => {
  const find = (s: ResidentStatus) => describeTray(s, "en").items.find(item => item.id === "toggle-pause")!;
  assert.equal(find(status()).label, "Pause all background tasks");
  assert.equal(find(status({ paused: true, state: "paused" })).label, "Resume background tasks");
  assert.equal(find(status({ mode: "disabled", state: "offline" })).enabled, false);
});

function fakeHandle() {
  const calls = { destroyed: 0, menus: [] as Array<Parameters<TrayHandle["setMenu"]>[0]>, titles: [] as string[], click: () => {} };
  const handle: TrayHandle = {
    setToolTip: () => {}, setTitle: text => calls.titles.push(text), setMenu: items => calls.menus.push(items),
    onClick: listener => { calls.click = listener; }, destroy: () => { calls.destroyed += 1; },
  };
  return { handle, calls };
}

it("creates the icon on demand, refreshes it, and destroys it when hidden", () => {
  const { handle, calls } = fakeHandle();
  let created = 0;
  const actions: TrayAction[] = [];
  const tray = new ResidentTray({ create: () => { created += 1; return handle; }, locale: () => "en", onAction: action => actions.push(action) });
  tray.update(status(), false);
  assert.equal(created, 0);
  tray.update(status({ pendingItems: 2 }), true);
  tray.update(status({ pendingItems: 4 }), true);
  assert.equal(created, 1, "the same icon is reused");
  assert.deepEqual(calls.titles, ["2", "4"]);
  calls.click();
  const menu = calls.menus.at(-1)!;
  menu.find(item => item.label === "Quit Vela")?.click?.();
  menu.find(item => item.label === "Open Resident Agent")?.click?.();
  assert.deepEqual(actions, ["open-inbox", "quit", "open-resident"]);
  assert.ok(menu.filter(item => item.type !== "separator" && item.click === undefined).every(item => item.enabled === false), "labels are not clickable");
  tray.update(status(), false);
  assert.equal(calls.destroyed, 1);
  assert.equal(tray.isVisible(), false);
  tray.refresh(true);
  assert.equal(created, 2, "refresh with the latest status recreates a visible icon");
  tray.dispose();
  assert.equal(calls.destroyed, 2);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it, mock } from "node:test";
import { ResidentIpc } from "@vela/shared";

const handlers = new Map<string, (...args: any[]) => any>();
const sent: Array<{ channel: string; payload: unknown }> = [];
const windows = [
  { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
  { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: () => { throw new Error("destroyed window must be skipped"); } } },
];
mock.module("electron", { namedExports: {
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => windows },
} });
const { ResidentAgentHost } = await import("../src/main/resident-agent-host.ts");

/** 同步抛出和异步拒绝在 IPC 上效果相同：调用方都收到错误。 */
async function fails(work: () => unknown): Promise<unknown> {
  try { await work(); } catch (error) { return error; }
  return null;
}

function fixture() {
  const calls: Array<[string, unknown?]> = [];
  let statusListener: ((status: unknown) => void) | null = null;
  let rulesListener: ((state: unknown) => void) | null = null;
  const supervisor: any = {
    getStatus: () => ({ state: "ready" }), getSettings: () => ({ mode: "standby" }), getMessages: () => [],
    submit: async (input: unknown) => { calls.push(["submit", input]); return { ok: true, target: "resident" }; },
    pause: () => calls.push(["pause"]), resume: () => calls.push(["resume"]),
    updateSettings: (patch: unknown) => { calls.push(["updateSettings", patch]); return { mode: "standby" }; },
    cancelTask: async (id: string) => { calls.push(["cancelTask", id]); },
    subscribe: (listener: (status: unknown) => void) => { statusListener = listener; return () => { statusListener = null; }; },
  };
  const rules: any = {
    list: () => ({ rules: [], error: null }),
    save: (input: unknown, id?: string) => { calls.push(["saveRule", { input, id }]); return { ok: true }; },
    remove: (id: string) => { calls.push(["removeRule", id]); return { rules: [], error: null }; },
    subscribe: (listener: (state: unknown) => void) => { rulesListener = listener; return () => { rulesListener = null; }; },
  };
  const host = new ResidentAgentHost(supervisor, rules);
  host.register();
  const frame = {};
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame });
  return {
    host, calls, event: { sender, senderFrame: frame }, foreign: { sender, senderFrame: {} },
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
    pushStatus: (status: unknown) => statusListener?.(status),
    pushRules: (state: unknown) => rulesListener?.(state),
  };
}

it("only the app window's main frame may call, before anything is touched", async () => {
  const f = fixture();
  for (const channel of [ResidentIpc.status, ResidentIpc.submit, ResidentIpc.pause, ResidentIpc.resume, ResidentIpc.getSettings, ResidentIpc.updateSettings, ResidentIpc.cancelTask, ResidentIpc.messages, ResidentIpc.rulesList, ResidentIpc.rulesSave, ResidentIpc.rulesRemove]) {
    assert.match(String(await fails(() => f.invoke(channel, f.foreign, { text: "x" }))), /应用窗口/, channel);
  }
  assert.deepEqual(f.calls, []);
  f.host.dispose();
});

it("validates submit, settings and id arguments as unknown input", async () => {
  const f = fixture();
  for (const bad of [null, "x", [], { text: 5 }, { text: "x".repeat(9000) }, { text: "ok", workspace: 5 }, { text: "ok", workspace: "/".repeat(1001) }]) {
    assert.ok(await fails(() => f.invoke(ResidentIpc.submit, f.event, bad)), JSON.stringify(bad)?.slice(0, 40));
  }
  assert.ok(await fails(() => f.invoke(ResidentIpc.updateSettings, f.event, "mode")));
  assert.ok(await fails(() => f.invoke(ResidentIpc.updateSettings, f.event, [1])));
  assert.ok(await fails(() => f.invoke(ResidentIpc.cancelTask, f.event, "../x")));
  assert.ok(await fails(() => f.invoke(ResidentIpc.rulesRemove, f.event, { id: "x" })));
  assert.ok(await fails(() => f.invoke(ResidentIpc.rulesSave, f.event, {}, "bad id!")));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.invoke(ResidentIpc.submit, f.event, { text: "hi", workspace: "/w", extra: "dropped" }), { ok: true, target: "resident" });
  assert.deepEqual(f.calls, [["submit", { text: "hi", workspace: "/w" }]]);
  f.host.dispose();
});

it("passes valid requests through and returns the authoritative status", async () => {
  const f = fixture();
  assert.deepEqual(f.invoke(ResidentIpc.pause, f.event), { state: "ready" });
  assert.deepEqual(f.invoke(ResidentIpc.resume, f.event), { state: "ready" });
  assert.deepEqual(await f.invoke(ResidentIpc.cancelTask, f.event, "task-1"), { state: "ready" });
  f.invoke(ResidentIpc.updateSettings, f.event, { mode: "proactive" });
  f.invoke(ResidentIpc.rulesSave, f.event, { title: "t" });
  f.invoke(ResidentIpc.rulesSave, f.event, { title: "t" }, "rule-1");
  f.invoke(ResidentIpc.rulesRemove, f.event, "rule-1");
  assert.deepEqual(f.calls.map(call => call[0]), ["pause", "resume", "cancelTask", "updateSettings", "saveRule", "saveRule", "removeRule"]);
  assert.deepEqual(f.calls[4]![1], { input: { title: "t" }, id: undefined });
  assert.deepEqual(f.calls[5]![1], { input: { title: "t" }, id: "rule-1" });
  f.host.dispose();
});

it("broadcasts to live windows only and stops after dispose", () => {
  const f = fixture();
  sent.length = 0;
  f.pushStatus({ state: "working" });
  f.pushRules({ rules: [], error: null });
  assert.deepEqual(sent, [{ channel: ResidentIpc.statusChange, payload: { state: "working" } }, { channel: ResidentIpc.rulesChange, payload: { rules: [], error: null } }]);
  f.host.dispose();
  assert.equal(handlers.size, 0);
  f.pushStatus({ state: "ready" });
  assert.equal(sent.length, 2);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { SandboxApprovalEvent, SandboxRiskEvaluator, SandboxRiskInput } from "@vela/shared";
import { SandboxPermissionManager } from "../src/sandbox-permission-manager.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  manager: SandboxPermissionManager;
  events: SandboxApprovalEvent[];
}

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function createManager(mode: "ask" | "smart" | "full", evaluator?: SandboxRiskEvaluator): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "vela-sandbox-test-"));
  tempDirs.push(dir);
  const manager = new SandboxPermissionManager(join(dir, "vela-settings.json"));
  await manager.setMode(mode);
  if (evaluator) manager.setRiskEvaluator(evaluator);
  const events: SandboxApprovalEvent[] = [];
  manager.subscribe((event) => events.push(event));
  return { manager, events };
}

function pendingRequest(events: SandboxApprovalEvent[]): string | null {
  const event = events.find((entry) => entry.type === "request");
  return event?.type === "request" ? event.request.id : null;
}

describe("SandboxPermissionManager", () => {
  it("full 模式直接放行,不产生审批事件", async () => {
    const { manager, events } = await createManager("full");
    assert.equal(await manager.request({ kind: "bash", command: "rm -rf /tmp/x", cwd: "/tmp" }), true);
    assert.deepEqual(events, []);
  });

  it("ask 模式逐条审批 bash,拒绝时返回 false", async () => {
    const { manager, events } = await createManager("ask");
    const pending = manager.request({ kind: "bash", command: "ls", cwd: "/repo" });
    const id = pendingRequest(events);
    assert.ok(id);
    manager.reply(id, false);
    assert.equal(await pending, false);
  });

  it("ask 模式放行工作区内的文件改动,审批工作区外的", async () => {
    const { manager, events } = await createManager("ask");
    const inside = await manager.request({
      kind: "edit",
      path: "/repo/src/app.ts",
      workspace: "/repo",
      insideWorkspace: true,
    });
    assert.equal(inside, true);
    assert.deepEqual(events, []);

    const pending = manager.request({
      kind: "write",
      path: "/etc/hosts",
      workspace: "/repo",
      insideWorkspace: false,
    });
    await tick();
    const id = pendingRequest(events);
    assert.ok(id);
    manager.reply(id, true);
    assert.equal(await pending, true);
  });

  it("smart 模式判定安全时直接执行,不弹审批", async () => {
    const calls: SandboxRiskInput[] = [];
    const { manager, events } = await createManager("smart", async (input) => {
      calls.push(input);
      return "safe";
    });
    const allowed = await manager.request({
      kind: "write",
      path: "/repo/src/app.ts",
      workspace: "/repo",
      insideWorkspace: true,
    });
    assert.equal(allowed, true);
    assert.deepEqual(events, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "write");
    assert.equal(calls[0].insideWorkspace, true);
  });

  it("smart 模式判定风险时弹审批,允许后放行", async () => {
    const { manager, events } = await createManager("smart", async () => "risky");
    const pending = manager.request({ kind: "bash", command: "sudo rm -rf /", cwd: "/repo", workspace: "/repo" });
    await tick();
    const id = pendingRequest(events);
    assert.ok(id);
    manager.reply(id, true);
    assert.equal(await pending, true);
  });

  it("smart 模式判定失败时按风险处理", async () => {
    const { manager, events } = await createManager("smart", async () => {
      throw new Error("模型不可用");
    });
    const pending = manager.request({ kind: "bash", command: "git status", cwd: "/repo", workspace: "/repo" });
    await tick();
    const id = pendingRequest(events);
    assert.ok(id);
    manager.reply(id, false);
    assert.equal(await pending, false);
  });

  it("smart 模式没有评估器时退回逐条审批", async () => {
    const { manager, events } = await createManager("smart");
    const pending = manager.request({ kind: "bash", command: "ls", cwd: "/repo", workspace: "/repo" });
    await tick();
    const id = pendingRequest(events);
    assert.ok(id);
    manager.reply(id, true);
    assert.equal(await pending, true);
  });

  it("smart 模式缓存安全结论,同一条命令只判断一次", async () => {
    let calls = 0;
    const { manager } = await createManager("smart", async () => {
      calls += 1;
      return "safe";
    });
    const input = { kind: "bash", command: "git status", cwd: "/repo", workspace: "/repo" } as const;
    assert.equal(await manager.request(input), true);
    assert.equal(await manager.request(input), true);
    assert.equal(calls, 1);
  });

  it("smart 模式缓存风险结论,再次执行仍要审批", async () => {
    let calls = 0;
    const { manager, events } = await createManager("smart", async () => {
      calls += 1;
      return "risky";
    });
    const input = { kind: "bash", command: "git push --force", cwd: "/repo", workspace: "/repo" } as const;
    const first = manager.request(input);
    await tick();
    manager.reply(pendingRequest(events)!, true);
    assert.equal(await first, true);

    const second = manager.request(input);
    await tick();
    const id = pendingRequest(events.filter((event) => event.type === "request").slice(1));
    assert.ok(id);
    manager.reply(id, true);
    assert.equal(await second, true);
    assert.equal(calls, 1);
  });
});


describe("Browser REPL permissions", () => {
  const input = { kind: "browser_repl" as const, command: "await tab.goto('https://example.com')", cwd: "/repo", insideWorkspace: true };
  it("ask always asks for JavaScript, even within workspace; cancellation resolves denial", async () => {
    const { manager, events } = await createManager("ask");
    const controller = new AbortController();
    const pending = manager.request({ ...input, signal: controller.signal });
    assert.ok(pendingRequest(events));
    const event = events[0];
    assert.equal(event?.type === "request" ? event.request.command : null, input.command);
    controller.abort();
    assert.equal(await pending, false);
  });
  it("full bypasses approval, smart assesses JavaScript separately from bash", async () => {
    const full = await createManager("full");
    assert.equal(await full.manager.request(input), true);
    assert.deepEqual(full.events, []);
    const calls: SandboxRiskInput[] = [];
    const smart = await createManager("smart", async (action) => { calls.push(action); return "safe"; });
    await smart.manager.request(input);
    await smart.manager.request(input);
    await smart.manager.request({ ...input, command: "await tab.reload()" });
    await smart.manager.request({ ...input, kind: "bash" });
    assert.equal(calls.length, 4);
    assert.equal(calls[0]?.command, input.command);
    assert.equal(calls[0]?.kind, "browser_repl");
    assert.deepEqual(smart.events, []);
  });
  it("smart risky JavaScript requires approval", async () => {
    const { manager, events } = await createManager("smart", async () => "risky");
    const pending = manager.request(input);
    await tick();
    const id = pendingRequest(events); assert.ok(id);
    manager.reply(id, false);
    assert.equal(await pending, false);
  });
});


it("stop cancels a pending smart evaluation promptly without opening approval", async () => {
  let finish!: (verdict: "safe") => void;
  const { manager, events } = await createManager("smart", () => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = manager.request({ kind: "browser_repl", command: "1", signal: controller.signal });
  controller.abort();
  assert.equal(await pending, false);
  assert.deepEqual(events, []);
  finish("safe");
});

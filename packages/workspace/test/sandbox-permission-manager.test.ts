import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { SandboxApprovalEvent, SandboxMcpContext, SandboxRiskEvaluator, SandboxRiskInput, SandboxRiskVerdict } from "@vela/shared";
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

describe("MCP permissions", () => {
  const mcp: SandboxMcpContext = {
    server: "issues",
    tool: "update_issue",
    description: "Update an issue in the remote tracker",
    parameters: { id: 42, title: "Updated", token: "[REDACTED]" },
  };
  const input = { kind: "mcp", mcp, cwd: "/repo", workspace: "/repo", insideWorkspace: true } as const;

  it("ask requires approval for every MCP call, even inside the workspace", async () => {
    let evaluations = 0;
    const { manager, events } = await createManager("ask", async () => { evaluations++; return "safe"; });
    for (const allowed of [true, false]) {
      const pending = manager.request(input);
      const event = events.at(-1);
      assert.equal(event?.type, "request");
      if (event?.type !== "request") throw new Error("Missing approval request");
      assert.equal(event.request.kind, "mcp");
      assert.deepEqual(event.request.mcp, mcp);
      assert.equal(event.request.command, null);
      assert.equal(event.request.path, null);
      manager.reply(event.request.id, allowed);
      assert.equal(await pending, allowed);
    }
    assert.equal(evaluations, 0);
    assert.equal(events.filter(event => event.type === "request").length, 2);
  });

  it("missing optional MCP context still requires approval in ask", async () => {
    const { manager, events } = await createManager("ask");
    const pending = manager.request({ kind: "mcp", insideWorkspace: true });
    const id = pendingRequest(events);
    assert.ok(id);
    manager.reply(id, false);
    assert.equal(await pending, false);
  });

  it("full allows MCP without evaluation or approval", async () => {
    let evaluations = 0;
    const { manager, events } = await createManager("full", async () => { evaluations++; return "risky"; });
    assert.equal(await manager.request(input), true);
    assert.equal(evaluations, 0);
    assert.deepEqual(events, []);
  });

  it("smart passes the redacted structured context to the evaluator", async () => {
    const calls: SandboxRiskInput[] = [];
    const { manager, events } = await createManager("smart", async action => { calls.push(action); return "safe"; });
    assert.equal(await manager.request(input), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "mcp");
    assert.deepEqual(calls[0].mcp, mcp);
    assert.equal(calls[0].workspace, "/repo");
    assert.equal(calls[0].insideWorkspace, false);
    assert.deepEqual(events, []);
  });

  for (const verdict of ["risky", "unknown", "error", "no evaluator"] as const) {
    it(`smart requests approval when MCP evaluation returns ${verdict}`, async () => {
      const evaluator: SandboxRiskEvaluator | undefined = verdict === "no evaluator" ? undefined : async () => {
        if (verdict === "error") throw new Error("Risk evaluation failed");
        return verdict;
      };
      const { manager, events } = await createManager("smart", evaluator);
      const pending = manager.request(input);
      await tick();
      const event = events[0];
      assert.equal(event?.type, "request");
      if (event?.type !== "request") throw new Error("Missing approval request");
      assert.deepEqual(event.request.mcp, mcp);
      manager.reply(event.request.id, false);
      assert.equal(await pending, false);
    });
  }

  it("smart never reuses a safe MCP verdict or a prior approval", async () => {
    let calls = 0;
    const { manager, events } = await createManager("smart", async () => ++calls === 1 ? "safe" : "risky");
    assert.equal(await manager.request(input), true);
    for (const allowed of [true, false]) {
      const pending = manager.request(input);
      await tick();
      const event = events.at(-1);
      if (event?.type !== "request") throw new Error("Missing approval request");
      manager.reply(event.request.id, allowed);
      assert.equal(await pending, allowed);
    }
    assert.equal(calls, 3);
  });

  it("smart does not share concurrent MCP evaluations or cancellation", async () => {
    const calls: SandboxRiskInput[] = [];
    const finishes: ((verdict: SandboxRiskVerdict) => void)[] = [];
    const { manager, events } = await createManager("smart", action => {
      calls.push(action);
      return new Promise(resolve => finishes.push(resolve));
    });
    const controller = new AbortController();
    const first = manager.request({ ...input, signal: controller.signal });
    const second = manager.request(input);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal, controller.signal);
    assert.equal(calls[1].signal, undefined);
    controller.abort();
    assert.equal(await first, false);
    assert.equal(calls[0].signal?.aborted, true);
    finishes[0]("safe");
    finishes[1]("safe");
    assert.equal(await second, true);
    assert.deepEqual(events, []);
  });

  for (const mode of ["ask", "smart", "full"] as const) {
    it(`${mode} denies already-aborted MCP calls without evaluation or approval`, async () => {
      let calls = 0;
      const { manager, events } = await createManager(mode, async () => { calls++; return "safe"; });
      const controller = new AbortController();
      controller.abort();
      assert.equal(await manager.request({ ...input, signal: controller.signal }), false);
      assert.equal(calls, 0);
      assert.deepEqual(events, []);
    });
  }

  for (const mode of ["ask", "smart"] as const) {
    it(`${mode} aborts pending MCP approval and ignores a late approval reply`, async () => {
      const { manager, events } = await createManager(mode, async () => "risky");
      const controller = new AbortController();
      const pending = manager.request({ ...input, signal: controller.signal });
      await tick();
      const id = pendingRequest(events);
      assert.ok(id);
      controller.abort();
      assert.equal(await pending, false);
      assert.deepEqual(events.at(-1), { type: "resolved", id, allowed: false });
      manager.reply(id, true);
      assert.equal(events.length, 2);
    });
  }

  it("abort reaches the MCP risk evaluator and cancels without opening approval", async () => {
    let riskSignal: AbortSignal | undefined;
    const { manager, events } = await createManager("smart", action => {
      riskSignal = action.signal;
      return new Promise(resolve => action.signal?.addEventListener("abort", () => resolve("unknown"), { once: true }));
    });
    const controller = new AbortController();
    const pending = manager.request({ ...input, signal: controller.signal });
    assert.equal(riskSignal, controller.signal);
    controller.abort();
    assert.equal(await pending, false);
    assert.equal(riskSignal?.aborted, true);
    assert.deepEqual(events, []);
  });
});

it("scoped permissions coexist without mutating global settings or sharing risk verdicts", async () => {
  const calls: SandboxRiskInput[] = [];
  const { manager, events } = await createManager("full", async input => {
    calls.push(input); return input.conversationId === "safe-task" ? "safe" : "risky";
  });
  manager.subscribe(event => { if (event.type === "request") manager.reply(event.request.id, false); });
  const action = { kind: "bash" as const, command: "printf permissions", cwd: "/repo" };
  const decisions = await Promise.all([
    manager.request({ ...action, sandboxMode: "ask", conversationId: "ask-task" }),
    manager.request({ ...action, sandboxMode: "smart", conversationId: "safe-task" }),
    manager.request({ ...action, sandboxMode: "smart", conversationId: "risky-task" }),
    manager.request({ ...action, sandboxMode: "full", conversationId: "full-task" }),
    manager.request(action),
  ]);
  assert.deepEqual(decisions, [false, true, false, true, true]);
  assert.equal(manager.getMode(), "full");
  assert.deepEqual(calls.map(input => input.conversationId).sort(), ["risky-task", "safe-task"]);
  assert.equal(events.filter(event => event.type === "request").length, 2);
  for (const kind of ["browser_repl", "mcp"] as const) {
    assert.equal(await manager.request({ kind, sandboxMode: "ask", conversationId: "ask-task", cwd: "/repo" }), false);
    assert.equal(await manager.request({ kind, sandboxMode: "smart", conversationId: "safe-task", cwd: "/repo" }), true);
    assert.equal(calls.at(-1)?.conversationId, "safe-task");
  }
});

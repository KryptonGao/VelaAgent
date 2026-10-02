import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentStreamEvent, SessionSnapshot } from "@vela/shared";
import { AgentRuntime } from "../src/runtime.ts";

describe("Plan 消息收尾", () => {
  for (const variant of ["unclosed", "split-close", "stopped"] as const) {
    it(`${variant}: 收尾保存完整 revision，用户中止时丢弃草稿`, async t => {
      const root = await mkdtemp(join(tmpdir(), "vela-plan-stream-"));
      const cwd = join(root, "workspace");
      await mkdir(cwd);
      const runtime = new AgentRuntime({ cwd, agentDir: root });
      t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
      await runtime.createConversation(cwd);
      const id = runtime.activeConversationId!;
      const internals = runtime as unknown as {
        conversations: Map<string, { sessionManager: SessionManager; stopRequested: boolean }>;
        handlePiEvent(conversationId: string, event: unknown): void;
        patchEntry(entry: unknown, patch: Partial<SessionSnapshot>): void;
        emit(event: AgentStreamEvent): void;
      };
      const events: AgentStreamEvent[] = [];
      const originalEmit = internals.emit.bind(runtime);
      internals.emit = event => { events.push(event); originalEmit(event); };
      const entry = internals.conversations.get(id)!;
      internals.patchEntry(entry, { mode: "plan" });
      const markdown = "# 保存收尾计划\n\n## 概述\n\n展示计划并在右侧打开。";
      const text = `<proposed_plan>\n${markdown}${variant === "split-close" ? "\n</proposed_plan>" : ""}`;
      const message = { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), stopReason: "stop" };
      internals.handlePiEvent(id, { type: "message_start", message });
      const delta = (value: string) => internals.handlePiEvent(id, {
        type: "message_update", assistantMessageEvent: { type: "text_delta", delta: value },
      });
      if (variant === "split-close") {
        delta(text.slice(0, -1));
        delta(">");
      } else delta(text);
      const started = events.find(event => event.type === "proposed_plan_start");
      assert.ok(started?.type === "proposed_plan_start");
      entry.stopRequested = variant === "stopped";
      entry.sessionManager.appendMessage(message as never);
      internals.handlePiEvent(id, { type: "message_end", message });
      const ended = events.find(event => event.type === "proposed_plan_end");
      if (variant === "stopped") {
        assert.equal(ended, undefined);
        assert.equal(runtime.getSnapshot().proposedPlan, null);
      } else {
        assert.ok(ended?.type === "proposed_plan_end");
        assert.equal(ended.plan.id, started.planId);
        assert.equal(ended.plan.markdown, markdown);
        assert.equal(runtime.getSnapshot().proposedPlan?.id, started.planId);
        assert.deepEqual(runtime.getMessages(id).at(-1)?.planIds, [started.planId]);
      }
    });
  }
});

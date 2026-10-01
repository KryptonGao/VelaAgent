import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, type StoredConversation } from "../src/conversation-store.ts";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vela-plan-store-"));
  return join(dir, "conversations.json");
}

function stored(overrides: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id: "c1",
    cwd: "/tmp/workspace",
    title: "测试对话",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    toolCallCount: 0,
    sessionFile: "/tmp/session.jsonl",
    instructions: "",
    mode: "agent",
    plans: [],
    latestProposedPlanId: null,
    executionPlans: [],
    activeExecutionPlanId: null,
    goal: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("ConversationStore：Plan 持久化与迁移", () => {
  it("旧 version 1 的 plan 字段迁移成 revision 与执行进度", async () => {
    const file = await tempFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        conversations: [
          {
            id: "c1",
            cwd: "/tmp/workspace",
            title: "旧对话",
            mode: "agent",
            plan: {
              title: "旧计划",
              overview: "旧概述",
              steps: [
                { id: "s1", text: "第一步", done: true },
                { id: "s2", text: "第二步", done: false },
              ],
              updatedAt: 100,
            },
          },
        ],
      }),
      "utf8",
    );
    const store = new ConversationStore(file);
    await store.load();
    const entry = store.get("c1");
    assert.ok(entry);
    assert.equal(entry.plans.length, 1);
    assert.equal(entry.plans[0]?.revision, 1);
    assert.match(entry.plans[0]?.markdown ?? "", /旧概述/);
    assert.match(entry.plans[0]?.markdown ?? "", /第一步/);
    assert.equal(entry.latestProposedPlanId, entry.plans[0]?.id);
    assert.equal(entry.executionPlans.length, 1);
    assert.equal(entry.executionPlans[0]?.sourcePlanId, entry.plans[0]?.id);
    assert.deepEqual(
      entry.executionPlans[0]?.items.map((item) => item.status),
      ["completed", "pending"],
    );
  });

  it("重启后恢复 Plan revision 与 ExecutionPlan", async () => {
    const file = await tempFile();
    const first = new ConversationStore(file);
    first.put(
      stored({
        plans: [
          {
            id: "p1",
            markdown: "# Plan\n\nv1",
            revision: 1,
            supersedes: null,
            status: "superseded",
            objective: null,
            createdAt: 10,
            approvedAt: null,
          },
          {
            id: "p2",
            markdown: "# Plan\n\nv2",
            revision: 2,
            supersedes: "p1",
            status: "approved",
            objective: "原始目标",
            createdAt: 20,
            approvedAt: 30,
          },
        ],
        latestProposedPlanId: "p2",
        executionPlans: [
          {
            id: "e1",
            sourcePlanId: "p2",
            items: [{ id: "i1", text: "第一步", status: "completed" }],
            updatedAt: 40,
          },
        ],
        activeExecutionPlanId: "e1",
      }),
    );
    first.flushSync();

    const second = new ConversationStore(file);
    await second.load();
    const entry = second.get("c1");
    assert.ok(entry);
    assert.deepEqual(entry.plans.map((plan) => plan.revision), [1, 2]);
    assert.equal(entry.plans[0]?.status, "superseded");
    assert.equal(entry.latestProposedPlanId, "p2");
    assert.equal(entry.activeExecutionPlanId, "e1");
    assert.equal(entry.executionPlans[0]?.sourcePlanId, "p2");
    assert.equal(entry.executionPlans[0]?.items[0]?.status, "completed");
  });

  it("latestProposedPlanId 指向不存在的版本时回退到最新 revision", async () => {
    const file = await tempFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        conversations: [
          stored({
            plans: [
              {
                id: "p1",
                markdown: "# Plan",
                revision: 1,
                supersedes: null,
                status: "draft",
                objective: null,
                createdAt: 1,
                approvedAt: null,
              },
            ],
            latestProposedPlanId: "missing",
          }),
        ],
      }),
      "utf8",
    );
    const store = new ConversationStore(file);
    await store.load();
    assert.equal(store.get("c1")?.latestProposedPlanId, "p1");
  });
});

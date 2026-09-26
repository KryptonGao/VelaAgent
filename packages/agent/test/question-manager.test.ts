import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuestionManager } from "../src/question-manager.ts";

interface RequestRecord {
  id: string;
  conversationId: string;
  question: string;
}

/** 订阅并记录 request 事件,便于测试里拿到待答问题的 id。 */
function recordRequests(manager: QuestionManager): RequestRecord[] {
  const requests: RequestRecord[] = [];
  manager.subscribe((event) => {
    if (event.type === "request") {
      requests.push({
        id: event.request.id,
        conversationId: event.request.conversationId,
        question: event.request.question,
      });
    }
  });
  return requests;
}

function ask(manager: QuestionManager, conversationId: string, question: string): Promise<string | null> {
  return manager.ask(conversationId, {
    toolCallId: `call-${conversationId}-${question}`,
    question,
    options: [{ label: "是" }, { label: "否" }],
    allowFreeText: true,
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("QuestionManager", () => {
  it("ask 推送问题并等待 reply 兑现答案", async () => {
    const manager = new QuestionManager();
    const requests = recordRequests(manager);
    const pending = ask(manager, "c1", "用哪种格式?");
    await tick();
    assert.deepEqual(
      requests.map((request) => request.question),
      ["用哪种格式?"],
    );
    manager.reply(requests[0].id, "选项A");
    assert.equal(await pending, "选项A");
  });

  it("reply(null) 表示跳过,返回 null", async () => {
    const manager = new QuestionManager();
    const requests = recordRequests(manager);
    const pending = ask(manager, "c1", "还要改吗?");
    await tick();
    manager.reply(requests[0].id, null);
    assert.equal(await pending, null);
  });

  it("同一对话的问题串行排队,不同对话互不阻塞", async () => {
    const manager = new QuestionManager();
    const requests = recordRequests(manager);
    const first = ask(manager, "c1", "第一问");
    const second = ask(manager, "c1", "第二问");
    const other = ask(manager, "c2", "另一对话");
    await tick();
    // c1 的第二问要等第一问了结才推送;c2 不受影响。
    assert.deepEqual(
      requests.map((request) => `${request.conversationId}:${request.question}`),
      ["c1:第一问", "c2:另一对话"],
    );
    manager.reply(requests[0].id, "答一");
    assert.equal(await first, "答一");
    await tick();
    assert.deepEqual(requests[requests.length - 1].question, "第二问");
    manager.reply(requests[requests.length - 1].id, null);
    assert.equal(await second, null);
    manager.cancelConversation("c2");
    assert.equal(await other, null);
  });

  it("cancelConversation 与 cancelAll 把未答问题以 null 了结", async () => {
    const manager = new QuestionManager();
    const first = ask(manager, "c1", "会被取消");
    const second = ask(manager, "c2", "会被全部取消");
    await tick();
    manager.cancelConversation("c1");
    assert.equal(await first, null);
    manager.cancelAll();
    assert.equal(await second, null);
  });

  it("resolved 事件先发出再兑现 Promise", async () => {
    const manager = new QuestionManager();
    const requests = recordRequests(manager);
    const resolutions: Array<string | null> = [];
    manager.subscribe((event) => {
      if (event.type === "resolved") resolutions.push(event.answer);
    });
    const pending = ask(manager, "c1", "事件顺序");
    await tick();
    manager.reply(requests[0].id, "好");
    assert.equal(await pending, "好");
    assert.deepEqual(resolutions, ["好"]);
  });
});

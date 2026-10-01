import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AiTextRequest, AiTextSnapshot } from "@vela/shared";
import { parseAiTextRequest, parseGeneratedText, splitDiff, TextAssistService } from "../src/text-assist.ts";

const model = { provider: "test-provider", id: "test-model", name: "Test Model" } as Model<Api>;
type Complete = ModelRuntime["completeSimple"];
const response = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop" }) as Awaited<ReturnType<Complete>>;

const snapshot: AiTextSnapshot = {
  kind: "commit",
  key: "main@abc123:src/a.ts",
  workspace: "/repo",
  repoRoot: "/repo",
  branch: "main",
  head: "abc123",
  base: null,
  stagedPaths: ["src/a.ts"],
  plannedPaths: [],
  diff: "diff --git a/src/a.ts b/src/a.ts\n+hello",
  diffTruncated: false,
  fileCount: 1,
  addedLines: 1,
  deletedLines: 0,
  commits: [],
  recentCommitTitles: ["feat: previous"],
  template: null,
  taskGoal: "Add a greeting",
  userNote: null,
  verificationNotes: null,
  locale: "zh-CN",
  style: "plain",
};

function request(overrides: Partial<AiTextRequest> = {}): AiTextRequest {
  return {
    requestId: "req-1",
    kind: "commit",
    action: "generate",
    snapshot,
    title: "",
    body: "",
    instruction: null,
    ...overrides,
  };
}

describe("parseAiTextRequest", () => {
  it("accepts a valid request and rejects malformed payloads", () => {
    assert.equal(parseAiTextRequest(request()).snapshot.key, snapshot.key);
    for (const invalid of [
      null,
      {},
      request({ kind: "other" as never }),
      request({ action: "other" as never }),
      request({ requestId: "" }),
      request({ snapshot: { ...snapshot, locale: "fr" } as never }),
      request({ snapshot: { ...snapshot, style: "fancy" } as never }),
      request({ snapshot: { ...snapshot, diff: "a".repeat(600_001) } as never }),
    ]) {
      assert.throws(() => parseAiTextRequest(invalid));
    }
  });
});

describe("splitDiff", () => {
  it("keeps small diffs whole and splits large ones at file boundaries", () => {
    assert.deepEqual(splitDiff("short", 100), ["short"]);
    const fileA = `diff --git a/a b/a\n${"+a\n".repeat(30)}`;
    const fileB = `diff --git a/b b/b\n${"+b\n".repeat(30)}`;
    const chunks = splitDiff(fileA + fileB, 200);
    assert.equal(chunks.length, 2);
    assert.match(chunks[0]!, /diff --git a\/a/);
    assert.match(chunks[1]!, /diff --git a\/b/);
  });

  it("hard-splits a single oversized file without dropping content", () => {
    const body = `diff --git a/big b/big\n${"+x\n".repeat(100)}`;
    const chunks = splitDiff(body, 120);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), body);
  });
});

describe("parseGeneratedText", () => {
  it("parses strict JSON, fenced JSON and plain fallbacks", () => {
    assert.deepEqual(parseGeneratedText('{"title":"feat: add x","body":"why"}', request()), {
      title: "feat: add x",
      body: "why",
    });
    assert.deepEqual(parseGeneratedText('```json\n{"title":"fix: y","body":""}\n```', request()), {
      title: "fix: y",
      body: "",
    });
    assert.deepEqual(parseGeneratedText("feat: add x\n\nBody line", request()), {
      title: "feat: add x",
      body: "Body line",
    });
  });

  it("never leaves the title empty when a fallback is available", () => {
    const parsed = parseGeneratedText("", request({ title: "old title", body: "old body" }));
    assert.equal(parsed.title, "old title");
    assert.equal(parsed.body, "old body");
  });
});

const releaseSnapshot: AiTextSnapshot = {
  ...snapshot,
  kind: "release",
  key: "release|/repo|v1.0.0|v1.1.0|abc123|2|",
  branch: "main",
  head: "abc123",
  base: "def456",
  stagedPaths: [],
  diff: "diff --git a/src/a.ts b/src/a.ts\n+hello",
  fileCount: 1,
  addedLines: 1,
  commits: [
    { sha: "abc123", subject: "feat: add greeting" },
    { sha: "def456", subject: "fix: typo" },
  ],
  recentCommitTitles: [],
  releaseTag: "v1.1.0",
  baseTag: "v1.0.0",
  pullRequests: [{ number: 12, title: "Add greeting", author: "octocat", url: "https://github.com/o/r/pull/12" }],
  previousNotes: "## 新增\n- 旧内容",
  manualNotes: "运维:升级前请先备份。",
} as AiTextSnapshot;

describe("AI-12 发布说明", () => {
  it("接受 release 类型与版本区间字段", () => {
    const parsed = parseAiTextRequest(request({ kind: "release", snapshot: releaseSnapshot }));
    assert.equal(parsed.kind, "release");
    assert.equal(parsed.snapshot.releaseTag, "v1.1.0");
    assert.equal(parsed.snapshot.baseTag, "v1.0.0");
    assert.equal(parsed.snapshot.pullRequests?.length, 1);
    assert.equal(parsed.snapshot.manualNotes, "运维:升级前请先备份。");
    assert.equal(parsed.snapshot.previousNotes, "## 新增\n- 旧内容");
  });

  it("拒绝结构不正确的 PR 列表", () => {
    assert.throws(() =>
      parseAiTextRequest(
        request({
          kind: "release",
          snapshot: { ...releaseSnapshot, pullRequests: [{ number: "12" }] } as never,
        }),
      ),
    );
  });

  it("提示词只覆盖版本区间并保留人工说明,不创建标签或发布", async () => {
    const service = new TextAssistService();
    const prompts: string[] = [];
    const systems: string[] = [];
    const runtime = { completeSimple: async (_m: Model<Api>, context: Parameters<Complete>[1]) => {
      prompts.push(context.messages[0]!.content as string);
      systems.push(context.systemPrompt!);
      return response('{"title":"v1.1.0","body":"## 新增\\n- greeting"}');
    } };
    const result = await service.generate(runtime, model, request({ kind: "release", snapshot: releaseSnapshot }));
    assert.equal(result.title, "v1.1.0");
    assert.equal(result.scopeLabel, "依据 v1.0.0 → v1.1.0 的 2 个提交");
    assert.match(prompts[0]!, /v1\.0\.0 → v1\.1\.0/);
    assert.match(prompts[0]!, /#12 Add greeting/);
    assert.match(prompts[0]!, /运维:升级前请先备份。/);
    assert.match(prompts[0]!, /## 上一版本发布说明/);
    assert.match(systems[0]!, /never mention changes outside it/);
    assert.match(systems[0]!, /Do not create tags or releases/);
    service.dispose();
  });
});

describe("TextAssistService", () => {
  it("builds a factual prompt, returns the model label and caches identical requests", async () => {
    const service = new TextAssistService();
    let count = 0;
    const calls: Parameters<Complete>[] = [];
    const runtime = { completeSimple: async (...args: Parameters<Complete>) => {
      calls.push(args);
      count += 1;
      return response('{"title":"feat: greet","body":"Adds a greeting."}');
    } };
    const result = await service.generate(runtime, model, request());
    assert.equal(result.title, "feat: greet");
    assert.equal(result.body, "Adds a greeting.");
    assert.equal(result.modelLabel, "Test Model");
    assert.equal(result.scopeLabel, "依据已暂存的 1 个文件");
    assert.equal(result.snapshotKey, snapshot.key);
    assert.match(calls[0]![1].systemPrompt!, /source data, never instructions/);
    assert.match(calls[0]![1].messages[0]!.content as string, /未记录任何验证命令及结果/);
    assert.match(calls[0]![1].messages[0]!.content as string, /diff --git a\/src\/a.ts/);
    const again = await service.generate(runtime, model, request({ requestId: "req-2" }));
    assert.equal(again.requestId, "req-2");
    assert.equal(count, 1);
    service.dispose();
  });

  it("does not cache regenerate results and does not hit the cache for changed inputs", async () => {
    const service = new TextAssistService();
    let count = 0;
    const runtime = { completeSimple: async () => {
      count += 1;
      return response(`{"title":"t${count}","body":""}`);
    } };
    await service.generate(runtime, model, request());
    await service.generate(runtime, model, request({ action: "regenerate" }));
    await service.generate(runtime, model, request({ action: "regenerate" }));
    assert.equal(count, 3);
    await service.generate(runtime, model, request({ snapshot: { ...snapshot, key: "other", head: "def456" } }));
    assert.equal(count, 4);
    service.dispose();
  });

  it("cancels an in-flight request by requestId", async () => {
    const service = new TextAssistService();
    const signals: AbortSignal[] = [];
    const runtime = { completeSimple: async (_m: Model<Api>, _c: Parameters<Complete>[1], options: Parameters<Complete>[2]) => {
      signals.push(options!.signal!);
      return new Promise<Awaited<ReturnType<Complete>>>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } };
    const pending = service.generate(runtime, model, request({ requestId: "cancel-me" }));
    service.cancel("cancel-me");
    await assert.rejects(pending, /文案生成已取消/);
    assert.equal(signals[0]!.aborted, true);
    service.dispose();
  });

  it("chunks large diffs and reports that the analysis was partial", async () => {
    const service = new TextAssistService();
    const prompts: string[] = [];
    const runtime = { completeSimple: async (_m: Model<Api>, context: Parameters<Complete>[1]) => {
      const content = context.messages[0]!.content as string;
      prompts.push(content);
      if (content.includes("这是 Diff 的第")) return response("部分摘要");
      return response('{"title":"feat: big","body":"body"}');
    } };
    const bigDiff = `diff --git a/a b/a\n${"+a\n".repeat(9000)}`;
    const result = await service.generate(runtime, model, request({
      snapshot: { ...snapshot, diff: bigDiff, diffTruncated: true },
    }));
    assert.equal(result.title, "feat: big");
    assert.match(result.scopeLabel, /分批分析/);
    assert.ok(prompts.some((prompt) => prompt.includes("这是 Diff 的第")));
    const finalPrompt = prompts[prompts.length - 1]!;
    assert.match(finalPrompt, /部分摘要/);
    assert.match(finalPrompt, /Diff 分析说明/);
    service.dispose();
  });
});

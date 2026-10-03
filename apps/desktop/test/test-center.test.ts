import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { browserFixtures } from "../test-center/fixtures.mjs";
import {
  classifyTestFile,
  desktopDir,
  discoverTasks,
  nodeTestRoots,
  parseFeatureGroups,
  repoRoot,
} from "../test-center/discovery.mjs";
import {
  applyReporterEvent,
  createTaskResult,
  detectNodeFlags,
  finalizeNodeBatch,
  inferFixtureStatus,
  parseReporterLine,
  serializeError,
  summarize,
  truncateOutput,
} from "../test-center/protocol.mjs";

describe("测试中心 · 发现", () => {
  it("覆盖三个根目录下所有 *.test.ts,id 唯一且文件存在", () => {
    const { tasks } = discoverTasks();
    const seen = new Set<string>();
    for (const root of nodeTestRoots) {
      const directory = join(repoRoot, root);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".test.ts")) continue;
        const path = `${root}/${name}`;
        assert.ok(tasks.some((task) => task.id === `node:${path}`), `缺少任务 ${path}`);
      }
    }
    for (const task of tasks) {
      assert.ok(!seen.has(task.id), `任务 id 重复: ${task.id}`);
      seen.add(task.id);
      if (task.kind === "node") {
        assert.ok(["agent", "workspace", "renderer", "main", "cross", "other"].includes(task.layer), `未知分层 ${task.layer}`);
        assert.ok(existsSync(join(repoRoot, task.path)), `文件不存在 ${task.path}`);
      } else {
        assert.equal(task.layer, "ui");
        assert.ok(existsSync(join(desktopDir, task.path)), `预览页不存在 ${task.path}`);
      }
    }
  });

  it("浏览器 fixture 都有页面、结果选择器和超时", () => {
    assert.ok(browserFixtures.length >= 7);
    for (const fixture of browserFixtures) {
      assert.ok(fixture.id.startsWith("ui:"), fixture.id);
      assert.ok(existsSync(join(desktopDir, fixture.page.split("?")[0])), `预览页不存在 ${fixture.page}`);
      assert.ok(fixture.resultSelector.startsWith("#"), fixture.resultSelector);
      assert.ok(fixture.timeoutMs > 0);
      if (fixture.script) assert.ok(existsSync(join(desktopDir, fixture.script)), `检查脚本不存在 ${fixture.script}`);
    }
  });

  it("Agent 鼠标界面和真实 Electron 检查出现在 UI 与 browser 功能分组", () => {
    const {tasks,groups,features}=discoverTasks();
    for (const id of ["ui:browser-agent-cursor", "ui:browser-electron"]) {
      assert.equal(tasks.find(task=>task.id===id)?.kind,"ui");
      assert.ok(groups.find(group=>group.id==="ui")?.taskIds.includes(id));
      assert.ok(features.find(feature=>feature.id==="browser")?.taskIds.includes(id));
    }
    assert.equal(browserFixtures.find(fixture=>fixture.id==="ui:browser-electron")?.script,"test/browser-test-center-smoke.mjs");
  });

  it("按引用源码区分桌面测试分层", () => {
    assert.equal(classifyTestFile('import { UiStorage } from "../src/main/ui-storage.ts";'), "main");
    assert.equal(classifyTestFile('import { x } from "../src/renderer/ui-storage.ts";'), "renderer");
    assert.equal(
      classifyTestFile('import a from "../src/main/a.ts";\nimport b from "../src/renderer/b.ts";'),
      "cross",
    );
    assert.equal(classifyTestFile('import { IpcChannel } from "@vela/shared";'), "other");
  });

  it("只按 import 头部判断分层,忽略测试体内嵌的示例源码", () => {
    const source =
      'import assert from "node:assert/strict";\ndescribe("x", () => {\n  const sample = \'import a from "../src/main/a.ts";\';\n});';
    assert.equal(classifyTestFile(source), "other");
  });

  it("源码级扫描测试使用显式分层", () => {
    const { tasks } = discoverTasks();
    assert.equal(tasks.find((task) => task.id === "node:apps/desktop/test/version-control-p2.test.ts")?.layer, "cross");
    assert.equal(tasks.find((task) => task.id === "node:apps/desktop/test/test-center.test.ts")?.layer, "other");
  });

  it("从 test:* 脚本推导功能分组,包含跨包文件", () => {
    const { tasks, features } = discoverTasks();
    const trace = features.find((feature) => feature.id === "trace");
    assert.ok(trace, "缺少 trace 功能分组");
    assert.ok(trace.taskIds.includes("node:packages/agent/test/trace.test.ts"));
    assert.ok(trace.taskIds.includes("node:apps/desktop/test/trace-model.test.ts"));
    for (const feature of features) {
      for (const taskId of feature.taskIds) {
        assert.ok(tasks.some((task) => task.id === taskId), `功能 ${feature.id} 引用了不存在的任务 ${taskId}`);
      }
    }
  });

  it("解析合成脚本时跳过无测试文件的脚本", () => {
    const { tasks } = discoverTasks();
    const groups = parseFeatureGroups(
      JSON.stringify({
        scripts: {
          "test:demo": "node --test ../../packages/agent/test/plan.test.ts test/diff-rows.test.ts",
          "test:trace:preview": "node test/trace-preview-server.mjs",
          "test:center": "node test-center/server.mjs",
          "test:empty": "echo nothing",
        },
      }),
      tasks,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, "demo");
    assert.deepEqual(groups[0].taskIds.sort(), [
      "node:apps/desktop/test/diff-rows.test.ts",
      "node:packages/agent/test/plan.test.ts",
    ]);
  });
});

describe("测试中心 · reporter 归约", () => {
  it("解析合法行并忽略噪声", () => {
    assert.deepEqual(parseReporterLine('{"type":"test:pass","data":{}}'), { type: "test:pass", data: {} });
    assert.equal(parseReporterLine("(node:1) ExperimentalWarning: something"), null);
    assert.equal(parseReporterLine("{bad json"), null);
    assert.equal(parseReporterLine('{"noType":true}'), null);
    assert.equal(parseReporterLine(""), null);
  });

  it("文件级 summary 决定终态,失败事件先标记失败", () => {
    const result = createTaskResult();
    const started = applyReporterEvent(
      result,
      "node:a",
      { type: "test:dequeue", data: { file: "/a.test.ts", nesting: 0, type: "suite", name: "suite" } },
      1000,
    );
    assert.equal(result.status, "running");
    assert.deepEqual(started.map((message) => message.type), ["task:update"]);

    applyReporterEvent(
      result,
      "node:a",
      {
        type: "test:fail",
        data: {
          file: "/a.test.ts",
          nesting: 1,
          name: "case",
          testId: 2,
          details: { duration_ms: 12, type: "test", error: { message: "boom", stack: "stack" } },
        },
      },
      1100,
    );
    assert.equal(result.status, "failed");
    assert.equal(result.error?.message, "boom");
    assert.equal(result.subtests.length, 1, "pass/fail 的类型在 details.type 里也要识别");
    assert.equal(result.subtests[0].status, "failed");

    applyReporterEvent(
      result,
      "node:a",
      { type: "test:summary", data: { file: "/a.test.ts", success: false, counts: { failed: 1, passed: 0 }, duration_ms: 20 } },
      1200,
    );
    assert.equal(result.status, "failed");
    assert.equal(result.durationMs, 20);
    assert.equal(result.finishedAt, 1200);
  });

  it("通过的 summary 才把任务标记为通过", () => {
    const result = createTaskResult();
    applyReporterEvent(result, "node:a", { type: "test:dequeue", data: { file: "/a", nesting: 0, type: "test", name: "/a", testId: 1 } }, 1000);
    applyReporterEvent(result, "node:a", { type: "test:pass", data: { file: "/a", nesting: 1, type: "test", name: "case", testId: 2, details: { duration_ms: 3 } } }, 1100);
    assert.equal(result.status, "running");
    assert.equal(result.subtests.length, 1, "只有真实的子测试进入列表");
    assert.equal(result.subtests[0].name, "case");
    applyReporterEvent(result, "node:a", { type: "test:summary", data: { file: "/a", success: true, counts: { failed: 0, passed: 1 }, duration_ms: 15 } }, 1200);
    assert.equal(result.status, "passed");
    assert.equal(result.durationMs, 15);
    assert.equal(result.finishedAt, 1200);
  });

  it("顶层 it(nesting 0)也作为子测试记录", () => {
    const result = createTaskResult();
    applyReporterEvent(result, "node:a", { type: "test:dequeue", data: { file: "/a", nesting: 0, type: "test", name: "top-level", testId: 5 } });
    applyReporterEvent(result, "node:a", { type: "test:pass", data: { file: "/a", nesting: 0, type: "test", name: "top-level", testId: 5, details: { duration_ms: 1 } } });
    assert.equal(result.subtests.length, 1);
    assert.equal(result.subtests[0].status, "passed");
  });

  it("维护子测试生命周期与 stdout", () => {
    const result = createTaskResult();
    applyReporterEvent(result, "node:a", { type: "test:dequeue", data: { file: "/a", nesting: 1, type: "test", name: "case", testId: 7 } });
    applyReporterEvent(result, "node:a", { type: "test:stdout", data: { file: "/a", message: "hello" } });
    applyReporterEvent(result, "node:a", {
      type: "test:pass",
      data: { file: "/a", nesting: 1, type: "test", name: "case", testId: 7, details: { duration_ms: 3 } },
    });
    assert.equal(result.subtests.length, 1);
    assert.equal(result.subtests[0].status, "passed");
    assert.equal(result.subtests[0].durationMs, 3);
    assert.equal(result.output, "hello");
    assert.equal(result.status, "running");
  });

  it("跳过的子测试记 skipped", () => {
    const result = createTaskResult();
    applyReporterEvent(result, "node:a", {
      type: "test:pass",
      data: { file: "/a", nesting: 1, type: "test", name: "later", testId: 1, skip: "not now", details: { duration_ms: 0 } },
    });
    assert.equal(result.subtests[0].status, "skipped");
  });

  it("进程退出后补齐没有终态的任务", () => {
    const tasks = [{ id: "node:a" }, { id: "node:b" }];
    const results: Record<string, ReturnType<typeof createTaskResult>> = {
      "node:a": { ...createTaskResult(), status: "passed" },
      "node:b": createTaskResult(),
    };
    const messages = finalizeNodeBatch(tasks, results, { exitCode: 1, now: 2000 });
    assert.equal(messages.length, 1);
    assert.equal(results["node:b"].status, "failed");
    assert.match(results["node:b"].error?.message ?? "", /exit code 1/);
    assert.equal(results["node:a"].status, "passed");
  });
});

describe("测试中心 · fixture 判定与环境探测", () => {
  it("按 dataset.status 优先判定 fixture 结果", () => {
    assert.equal(inferFixtureStatus(null), "pending");
    assert.equal(inferFixtureStatus({ found: false }), "pending");
    assert.equal(inferFixtureStatus({ found: true, status: "passed", text: "" }), "passed");
    assert.equal(inferFixtureStatus({ found: true, status: "failed", text: "PASS a" }), "failed");
    assert.equal(inferFixtureStatus({ found: true, status: null, text: "" }), "pending");
    // 没有 data-status 时,只有明确的 FAIL 才算终态,避免刚出第一行 PASS 就提前收工。
    assert.equal(inferFixtureStatus({ found: true, status: null, text: "PASS a\nPASS b" }), "pending");
    assert.equal(inferFixtureStatus({ found: true, status: null, text: "PASS a\nFAIL boom" }), "failed");
  });

  it("探测 Node flag 支持情况", () => {
    assert.deepEqual(detectNodeFlags(() => true), { transformTypes: true, moduleMocks: true });
    assert.deepEqual(detectNodeFlags((flag: string) => flag === "--experimental-transform-types"), {
      transformTypes: true,
      moduleMocks: false,
    });
  });

  it("汇总与输出截断", () => {
    const results = {
      a: { ...createTaskResult(), status: "passed" },
      b: { ...createTaskResult(), status: "failed" },
      c: createTaskResult(),
    };
    const summary = summarize(["a", "b", "c", "d"], results, 100, 350);
    assert.deepEqual(summary, { total: 4, passed: 1, failed: 1, skipped: 0, cancelled: 0, pending: 2, durationMs: 250 });
    const long = "x".repeat(100);
    assert.equal(truncateOutput(long, 10).endsWith("x".repeat(10)), true);
    assert.equal(truncateOutput("short", 10), "short");
  });

  it("错误序列化保留嵌套 cause", () => {
    const serialized = serializeError(new Error("outer", { cause: new Error("inner") }));
    assert.equal(serialized?.message, "outer");
    assert.equal(serialized?.cause?.message, "inner");
    assert.ok(serialized?.stack);
    assert.deepEqual(serializeError("plain"), { message: "plain" });
    assert.equal(serializeError(null), null);
  });
});

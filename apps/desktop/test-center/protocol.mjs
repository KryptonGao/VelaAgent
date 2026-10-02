/**
 * 测试中心的纯逻辑层:reporter 事件解析/归约、fixture 结果判定、Node flag 探测。
 * 这里不碰进程、网络和文件系统,方便被测试中心的单元测试直接覆盖。
 */

export const reporterPrefix = "@@vela-test-center@@";
/** 单个任务在内存和 last-run 中保留的输出上限(字符数)。 */
export const maxTaskOutput = 1024 * 1024;
/** 单个任务保留的子测试条数上限。 */
export const maxSubtests = 500;

export function createTaskResult() {
  return {
    status: "pending",
    durationMs: null,
    error: null,
    output: "",
    subtests: [],
    startedAt: null,
    finishedAt: null,
  };
}

/** 解析 node:test 自定义 reporter 写出的一行 JSON;非 JSON 行返回 null。 */
export function parseReporterLine(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

/** 把 Error(含嵌套 cause)或任意值转成可 JSON 序列化的错误对象。 */
export function serializeError(error, depth = 0) {
  if (error == null) return null;
  if (typeof error !== "object") return { message: String(error) };
  const message = typeof error.message === "string" && error.message ? error.message : String(error);
  const stack = typeof error.stack === "string" ? error.stack : undefined;
  const result = { message, ...(stack ? { stack } : {}) };
  if (depth < 4 && error.cause != null) result.cause = serializeError(error.cause, depth + 1);
  return result;
}

function appendOutput(result, stream, chunk) {
  if (typeof chunk !== "string" || chunk.length === 0) return false;
  result.output = (result.output + chunk).slice(-maxTaskOutput);
  return true;
}

function upsertSubtest(result, patch) {
  const existing = result.subtests.find((subtest) => subtest.testId === patch.testId);
  if (existing) {
    Object.assign(existing, patch);
    return existing;
  }
  if (result.subtests.length >= maxSubtests) return null;
  const subtest = { status: "running", durationMs: null, error: null, ...patch };
  result.subtests.push(subtest);
  return subtest;
}

/**
 * 把一个 node:test reporter 事件归约进某个任务的结果,返回需要广播的增量消息。
 * 文件级状态由带 file 的 test:summary 决定(每个文件一条);任何 test:fail 都会
 * 把任务标为失败;子测试由 type === "test" 的事件维护,文件占位事件(name === file)除外。
 */
export function applyReporterEvent(result, taskId, event, now = Date.now()) {
  const messages = [];
  if (!event || typeof event.type !== "string") return messages;
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const nesting = typeof data.nesting === "number" ? data.nesting : 0;
  const file = typeof data.file === "string" ? data.file : null;
  // enqueue/dequeue 把类型放在 data.type,pass/fail 放在 details.type。
  const isTest = data.type === "test" || data.details?.type === "test";
  const isFilePlaceholder = file != null && data.name === file;
  const error = data.details && typeof data.details === "object" ? serializeError(data.details.error) : null;
  const duration =
    data.details && typeof data.details === "object" && typeof data.details.duration_ms === "number"
      ? data.details.duration_ms
      : undefined;

  const markRunning = () => {
    if (result.status !== "pending") return;
    result.status = "running";
    result.startedAt = result.startedAt ?? now;
    messages.push({ type: "task:update", taskId, patch: { status: "running", startedAt: result.startedAt } });
  };

  const markFailed = (failure) => {
    const firstFailure = result.status !== "failed";
    result.status = "failed";
    result.error = result.error ?? failure;
    if (firstFailure) {
      messages.push({ type: "task:update", taskId, patch: { status: "failed", error: result.error } });
    }
  };

  // dequeue 的 type 字段不可靠(套件有时标成 test),子测试只在 enqueue 时创建。
  const setSubtestRunning = () => {
    if (isFilePlaceholder || data.testId == null) return;
    const existing = result.subtests.find((subtest) => subtest.testId === data.testId);
    if (!existing || existing.status !== "pending") return;
    existing.status = "running";
    messages.push({ type: "subtest:update", taskId, subtest: { ...existing } });
  };

  switch (event.type) {
    case "test:enqueue": {
      if (isTest && !isFilePlaceholder && data.testId != null) {
        const subtest = upsertSubtest(result, {
          testId: data.testId,
          name: data.name,
          nesting,
          status: "pending",
          durationMs: null,
          error: null,
        });
        if (subtest) messages.push({ type: "subtest:update", taskId, subtest: { ...subtest } });
      }
      break;
    }
    case "test:dequeue":
    case "test:start": {
      markRunning();
      setSubtestRunning();
      break;
    }
    case "test:pass": {
      if (isTest && !isFilePlaceholder) {
        const skipped = Boolean(data.skip);
        const subtest = upsertSubtest(result, {
          testId: data.testId,
          name: data.name,
          nesting,
          status: skipped ? "skipped" : "passed",
          durationMs: duration ?? null,
          error: null,
        });
        if (subtest) messages.push({ type: "subtest:update", taskId, subtest: { ...subtest } });
      }
      break;
    }
    case "test:fail": {
      if (isTest && !isFilePlaceholder) {
        const subtest = upsertSubtest(result, {
          testId: data.testId,
          name: data.name,
          nesting,
          status: "failed",
          durationMs: duration ?? null,
          error: error ?? { message: "测试失败" },
        });
        if (subtest) messages.push({ type: "subtest:update", taskId, subtest: { ...subtest } });
      }
      markFailed(error ?? { message: "测试失败" });
      break;
    }
    case "test:stdout":
    case "test:stderr": {
      const stream = event.type === "test:stdout" ? "stdout" : "stderr";
      if (appendOutput(result, stream, data.message)) {
        messages.push({ type: "task:output", taskId, stream, chunk: data.message });
      }
      break;
    }
    case "test:summary": {
      if (file == null) break;
      const counts = data.counts && typeof data.counts === "object" ? data.counts : {};
      const failed = data.success === false || Number(counts.failed ?? 0) > 0;
      const skipped = Number(counts.tests ?? 0) === 0 && Number(counts.skipped ?? 0) > 0;
      if (failed) {
        markFailed(result.error ?? { message: "测试失败" });
      } else if (result.status !== "failed") {
        result.status = skipped ? "skipped" : "passed";
      }
      if (typeof data.duration_ms === "number") result.durationMs = data.duration_ms;
      result.finishedAt = now;
      messages.push({
        type: "task:update",
        taskId,
        patch: {
          status: result.status,
          durationMs: result.durationMs,
          finishedAt: now,
          error: result.error,
        },
      });
      break;
    }
    case "test:diagnostic": {
      if (data.level === "warn" || data.level === "error") {
        messages.push({ type: "run:log", line: String(data.message ?? "") });
      }
      break;
    }
    default:
      break;
  }
  return messages;
}

/** 子进程退出后,把选中但没有终态的任务补齐为失败或取消。 */
export function finalizeNodeBatch(nodeTasks, results, { exitCode, cancelled = false, timedOut = false, now = Date.now() } = {}) {
  const messages = [];
  for (const task of nodeTasks) {
    const result = results[task.id];
    if (!result || result.status === "passed" || result.status === "failed" || result.status === "skipped") continue;
    result.status = cancelled ? "cancelled" : "failed";
    result.finishedAt = now;
    result.error = result.error ?? {
      message: cancelled
        ? "运行已取消"
        : timedOut
          ? "测试运行超时,进程已被终止"
          : `测试进程退出(exit code ${exitCode ?? "unknown"}),未产生测试结果`,
    };
    messages.push({
      type: "task:update",
      taskId: task.id,
      patch: { status: result.status, finishedAt: now, error: result.error },
    });
  }
  return messages;
}

/**
 * 判断浏览器 fixture 的结果元素是否已给出终态。
 * 以 data-status 为准;没有 status 时只有出现 FAIL 行才算失败(成功必须显式标记,
 * 否则页面可能刚写出第一行 PASS、后面的检查还没跑完就被当成完成)。
 */
export function inferFixtureStatus(sample) {
  if (!sample || !sample.found) return "pending";
  if (sample.status === "passed" || sample.status === "failed") return sample.status;
  const text = typeof sample.text === "string" ? sample.text.trim() : "";
  if (!text) return "pending";
  return /(^|\n)\s*FAIL\b/.test(text) ? "failed" : "pending";
}

/** 用注入的探测函数检查 Node 是否支持某个 flag(便于单测)。 */
export function detectNodeFlags(probe) {
  return {
    transformTypes: Boolean(probe("--experimental-transform-types")),
    moduleMocks: Boolean(probe("--experimental-test-module-mocks")),
  };
}

export function summarize(selection, results, startedAt, finishedAt) {
  const summary = { total: selection.length, passed: 0, failed: 0, skipped: 0, cancelled: 0, pending: 0 };
  for (const taskId of selection) {
    const status = results[taskId]?.status ?? "pending";
    if (status in summary) summary[status] += 1;
  }
  summary.durationMs = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  return summary;
}

/** 持久化或展示前截断输出,保留尾部。 */
export function truncateOutput(text, max = 64 * 1024) {
  if (typeof text !== "string" || text.length <= max) return text ?? "";
  return `…(前 ${text.length - max} 字符已截断)\n${text.slice(-max)}`;
}

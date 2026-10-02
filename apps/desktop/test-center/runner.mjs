/**
 * 测试运行管理:串行执行 Node 批次(一个 node --test 进程)和浏览器检查批次
 * (一个 Electron 进程),把事件转成 SSE 消息,并负责超时、取消、输出截断与落盘。
 */
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserFixtures } from "./fixtures.mjs";
import { repoRoot } from "./discovery.mjs";
import {
  applyReporterEvent,
  createTaskResult,
  detectNodeFlags,
  finalizeNodeBatch,
  maxTaskOutput,
  parseReporterLine,
  reporterPrefix,
  serializeError,
  summarize,
  truncateOutput,
} from "./protocol.mjs";

const defaultTimeoutMs = 10 * 60 * 1000;
const killGraceMs = 3000;
const maxLogLines = 500;
const lastRunOutputLimit = 64 * 1024;

export class RunBusyError extends Error {
  constructor() {
    super("已有测试在运行");
    this.name = "RunBusyError";
  }
}

export async function resolveElectronPath() {
  try {
    const module = await import("electron");
    const path = module?.default;
    if (typeof path === "string" && existsSync(path)) return path;
  } catch {
    // 回退到 node_modules/.bin。
  }
  const fallback = join(repoRoot, "node_modules/.bin/electron");
  return existsSync(fallback) ? fallback : null;
}

export async function readLastRun(lastRunPath) {
  try {
    const raw = await readFile(lastRunPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.run) return parsed.run;
  } catch {
    // 没有历史或文件损坏时按没有处理。
  }
  return null;
}

export class RunManager extends EventEmitter {
  constructor(options) {
    super();
    this.tasks = new Map(options.tasks.map((task) => [task.id, task]));
    this.nodeTasks = options.tasks.filter((task) => task.kind === "node");
    this.taskByFile = new Map(this.nodeTasks.map((task) => [join(repoRoot, task.path), task]));
    this.repoRoot = options.repoRoot ?? repoRoot;
    this.registerTsPath = options.registerTsPath ?? join(repoRoot, "packages/agent/test/register-ts.mjs");
    this.reporterPath = options.reporterPath ?? fileURLToPath(new URL("./ndjson-reporter.mjs", import.meta.url));
    this.uiRunnerPath = options.uiRunnerPath ?? fileURLToPath(new URL("./ui-checks-runner.mjs", import.meta.url));
    this.lastRunPath = options.lastRunPath ?? join(repoRoot, "apps/desktop/test-center/.runs/last-run.json");
    this.timeoutMs = options.timeoutMs ?? (Number(process.env.VELA_TEST_TIMEOUT_MS) || defaultTimeoutMs);
    this.concurrency = options.concurrency ?? (Number(process.env.VELA_TEST_CONCURRENCY) || null);
    this.electronPath = options.electronPath ?? null;
    this.port = options.port ?? 5190;
    this.nodeFlags =
      options.nodeFlags ??
      detectNodeFlags((flag) => spawnSync(process.execPath, [flag, "-e", "0"], { stdio: "ignore" }).status === 0);
    this.run = null;
    this.child = null;
    this.phaseTimer = null;
    this.killTimer = null;
    this.cancelled = false;
    this.phaseTimedOut = false;
  }

  get running() {
    return this.run?.status === "running";
  }

  /** 发送给看板/SSE 的快照;调用方需立即序列化,不要缓存后再读。 */
  snapshot() {
    if (!this.run) return null;
    return { ...this.run };
  }

  start(taskIds) {
    if (this.running) throw new RunBusyError();
    const selection = [...new Set(taskIds)].filter((id) => this.tasks.has(id));
    if (selection.length === 0) throw new Error("没有可运行的任务");
    const run = {
      id: `run-${Date.now().toString(36)}`,
      status: "running",
      phase: null,
      startedAt: Date.now(),
      finishedAt: null,
      selection,
      results: {},
      log: [],
      summary: null,
    };
    for (const id of selection) run.results[id] = createTaskResult();
    this.run = run;
    this.cancelled = false;
    this.phaseTimedOut = false;
    this.emitMessage({ type: "run:start", run: this.snapshot() });
    void this.execute(run);
    return run.id;
  }

  stop() {
    if (!this.running) return false;
    this.cancelled = true;
    this.killChild();
    return true;
  }

  dispose() {
    this.cancelled = true;
    this.killChild();
    this.clearPhaseTimer();
  }

  emitMessage(message) {
    this.emit("message", message);
  }

  pushLog(run, line) {
    const trimmed = String(line ?? "").trimEnd();
    if (!trimmed) return;
    run.log.push(trimmed);
    if (run.log.length > maxLogLines) run.log.splice(0, run.log.length - maxLogLines);
    this.emitMessage({ type: "run:log", line: trimmed });
  }

  applyMessages(messages) {
    for (const message of messages) this.emitMessage(message);
  }

  async execute(run) {
    try {
      const nodeTasks = run.selection.map((id) => this.tasks.get(id)).filter((task) => task.kind === "node");
      const uiTasks = run.selection.map((id) => this.tasks.get(id)).filter((task) => task.kind === "ui");
      if (nodeTasks.length > 0) {
        run.phase = "node";
        this.phaseTimedOut = false;
        this.emitMessage({ type: "run:phase", phase: "node" });
        const outcome = await this.runNodeBatch(run, nodeTasks);
        this.applyMessages(
          finalizeNodeBatch(nodeTasks, run.results, {
            exitCode: outcome.exitCode,
            cancelled: this.cancelled,
            timedOut: outcome.timedOut,
            now: Date.now(),
          }),
        );
      }
      if (!this.cancelled && uiTasks.length > 0) {
        run.phase = "ui";
        this.phaseTimedOut = false;
        this.emitMessage({ type: "run:phase", phase: "ui" });
        await this.runUiBatch(run, uiTasks);
      }
      run.status = this.cancelled ? "cancelled" : "finished";
    } catch (error) {
      run.status = "error";
      this.pushLog(run, `运行失败: ${String(error?.stack ?? error)}`);
    } finally {
      run.finishedAt = Date.now();
      run.summary = summarize(run.selection, run.results, run.startedAt, run.finishedAt);
      this.clearPhaseTimer();
      this.child = null;
      await this.persistLastRun(run);
      this.emitMessage({ type: "run:end", run: this.snapshot() });
    }
  }

  runNodeBatch(run, nodeTasks) {
    return new Promise((resolve) => {
      const args = ["--import", this.registerTsPath];
      if (this.nodeFlags.transformTypes) args.push("--experimental-transform-types");
      if (this.nodeFlags.moduleMocks) args.push("--experimental-test-module-mocks");
      args.push("--test", `--test-reporter=${this.reporterPath}`, "--test-reporter-destination=stdout");
      if (this.concurrency) args.push(`--test-concurrency=${this.concurrency}`);
      args.push(...nodeTasks.map((task) => join(repoRoot, task.path)));

      const child = spawn(process.execPath, args, {
        cwd: repoRoot,
        env: { ...process.env, VELA_TEST_CENTER: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.startPhaseTimer(this.timeoutMs, () => {
        this.phaseTimedOut = true;
        this.pushLog(run, `Node 测试批次超过 ${Math.round(this.timeoutMs / 1000)}s,已终止`);
        this.killChild();
      });

      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.handleReporterLine(run, line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        for (const line of chunk.split("\n")) this.pushLog(run, line);
      });
      child.on("error", (error) => {
        this.pushLog(run, `无法启动 Node 测试进程: ${error.message}`);
      });
      child.on("close", (code) => {
        if (buffer.trim()) this.handleReporterLine(run, buffer);
        this.clearPhaseTimer();
        resolve({ exitCode: code, timedOut: this.phaseTimedOut });
      });
    });
  }

  handleReporterLine(run, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = parseReporterLine(trimmed);
    if (!event) {
      this.pushLog(run, trimmed);
      return;
    }
    const file = typeof event.data?.file === "string" ? event.data.file : null;
    const task = file ? this.taskByFile.get(file) : null;
    if (!task || !(task.id in run.results)) return;
    this.applyMessages(applyReporterEvent(run.results[task.id], task.id, event));
  }

  async runUiBatch(run, uiTasks) {
    const electronPath = this.electronPath ?? (await resolveElectronPath());
    const uiTaskIds = new Set(uiTasks.map((task) => task.id));
    const fixtures = uiTasks.map((task) => {
      const fixture = browserFixtures.find((entry) => entry.id === task.id);
      return {
        id: task.id,
        url: `http://127.0.0.1:${this.port}/${fixture.page}`,
        resultSelector: fixture.resultSelector,
        timeoutMs: fixture.timeoutMs,
      };
    });

    if (!electronPath) {
      const now = Date.now();
      for (const task of uiTasks) {
        const result = run.results[task.id];
        result.status = this.cancelled ? "cancelled" : "failed";
        result.finishedAt = now;
        result.error = { message: "找不到 Electron 可执行文件,无法运行浏览器检查" };
        this.emitMessage({
          type: "task:update",
          taskId: task.id,
          patch: { status: result.status, finishedAt: now, error: result.error },
        });
      }
      this.pushLog(run, "找不到 Electron 可执行文件,跳过浏览器检查");
      return;
    }

    const configPath = join(tmpdir(), `vela-test-center-${run.id}.json`);
    await writeFile(configPath, JSON.stringify({ fixtures }), "utf8");

    const totalTimeout = fixtures.reduce((sum, fixture) => sum + fixture.timeoutMs, 0) + 60_000;
    await new Promise((resolve) => {
      const child = spawn(electronPath, [this.uiRunnerPath, configPath], {
        cwd: repoRoot,
        env: { ...process.env, VELA_TEST_CENTER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.startPhaseTimer(totalTimeout, () => {
        this.phaseTimedOut = true;
        this.pushLog(run, "浏览器检查批次超时,已终止");
        this.killChild();
      });

      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.handleUiLine(run, line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        for (const line of chunk.split("\n")) this.pushLog(run, line);
      });
      child.on("error", (error) => {
        this.pushLog(run, `无法启动浏览器检查进程: ${error.message}`);
      });
      child.on("close", () => {
        if (buffer.trim()) this.handleUiLine(run, buffer);
        this.clearPhaseTimer();
        resolve();
      });
    });

    await rm(configPath, { force: true });

    const now = Date.now();
    for (const task of uiTasks) {
      if (!uiTaskIds.has(task.id)) continue;
      const result = run.results[task.id];
      if (result.status === "passed" || result.status === "failed") continue;
      result.status = this.cancelled ? "cancelled" : "failed";
      result.finishedAt = now;
      result.error = result.error ?? {
        message: this.cancelled ? "运行已取消" : this.phaseTimedOut ? "浏览器检查超时" : "浏览器检查未产生结果",
      };
      this.emitMessage({
        type: "task:update",
        taskId: task.id,
        patch: { status: result.status, finishedAt: now, error: result.error },
      });
    }
  }

  handleUiLine(run, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith(reporterPrefix)) {
      this.pushLog(run, trimmed);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(trimmed.slice(reporterPrefix.length));
    } catch {
      this.pushLog(run, trimmed);
      return;
    }
    if (payload.type === "runner:error") {
      this.pushLog(run, `浏览器检查: ${payload.message ?? "未知错误"}`);
      return;
    }
    const taskId = payload.id;
    if (!taskId || !(taskId in run.results)) return;
    const result = run.results[taskId];
    const now = Date.now();
    switch (payload.type) {
      case "fixture:start": {
        result.status = "running";
        result.startedAt = result.startedAt ?? now;
        this.emitMessage({ type: "task:update", taskId, patch: { status: "running", startedAt: result.startedAt } });
        break;
      }
      case "fixture:output": {
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        if (!chunk) break;
        result.output = (result.output + chunk).slice(-maxTaskOutput);
        this.emitMessage({ type: "task:output", taskId, stream: payload.stream ?? "console", chunk });
        break;
      }
      case "fixture:end": {
        result.status = payload.status === "passed" ? "passed" : "failed";
        result.durationMs = typeof payload.durationMs === "number" ? payload.durationMs : null;
        result.finishedAt = now;
        result.error = payload.status === "passed" ? null : serializeError(payload.error) ?? { message: "浏览器检查失败" };
        this.emitMessage({
          type: "task:update",
          taskId,
          patch: { status: result.status, durationMs: result.durationMs, finishedAt: now, error: result.error },
        });
        break;
      }
      default:
        break;
    }
  }

  startPhaseTimer(ms, onTimeout) {
    this.clearPhaseTimer();
    this.phaseTimer = setTimeout(onTimeout, ms);
    this.phaseTimer.unref?.();
  }

  clearPhaseTimer() {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }

  killChild() {
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已经退出。
    }
    this.killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程可能已经退出。
      }
    }, killGraceMs);
    this.killTimer.unref?.();
  }

  async persistLastRun(run) {
    if (!this.lastRunPath) return;
    const payload = {
      generatedAt: Date.now(),
      run: {
        id: run.id,
        status: run.status,
        phase: run.phase,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        selection: run.selection,
        summary: run.summary,
        log: run.log.slice(-200),
        results: Object.fromEntries(
          Object.entries(run.results).map(([id, result]) => [
            id,
            { ...result, output: truncateOutput(result.output, lastRunOutputLimit) },
          ]),
        ),
      },
    };
    try {
      await mkdir(dirname(this.lastRunPath), { recursive: true });
      await writeFile(this.lastRunPath, JSON.stringify(payload), "utf8");
    } catch (error) {
      this.pushLog(run, `保存上次运行结果失败: ${String(error?.message ?? error)}`);
    }
  }
}

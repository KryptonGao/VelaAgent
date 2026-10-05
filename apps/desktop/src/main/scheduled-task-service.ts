import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskPatch, ScheduledTaskRun, ScheduledTasksState } from "@vela/shared";
import { nextTaskTime, parseTaskInput } from "./task-schedule";

export type TaskExecutor = (task: ScheduledTask, linkConversation: (id: string) => void, run: ScheduledTaskRun) => Promise<void>;

/** Claims are atomically persisted before external effects. Interrupted claims are never replayed. */
export class ScheduledTaskScheduler {
  private state: ScheduledTasksState = { tasks: [], runs: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private suspended = false;
  private readonly running = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(state: ScheduledTasksState) => void>();
  constructor(private readonly file: string, private readonly execute: TaskExecutor, private readonly now: () => number = Date.now) {}

  init(): void {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const stored = JSON.parse(raw);
    if (stored.version !== 1 || !Array.isArray(stored.tasks) || !Array.isArray(stored.runs)) throw new Error("定时任务存储格式不正确");
    for (const task of stored.tasks) {
      parseTaskInput(task);
      if (typeof task.id !== "string" || !["active", "paused", "completed"].includes(task.status) ||
        (task.nextRunAt !== null && !Number.isFinite(task.nextRunAt))) throw new Error("定时任务状态不正确");
    }
    if (new Set(stored.tasks.map((task: ScheduledTask) => task.id)).size !== stored.tasks.length) throw new Error("重复的任务 ID");
    for (const run of stored.runs) {
      if (!run || typeof run.id !== "string" || typeof run.taskId !== "string" ||
        !["running", "success", "failed", "skipped", "interrupted"].includes(run.status) || !Number.isFinite(run.scheduledAt)) throw new Error("执行记录不正确");
    }
    this.state = { tasks: stored.tasks, runs: stored.runs };
    if (this.state.runs.some(run => run.status === "running")) this.commit(state => {
      for (const run of state.runs) if (run.status === "running") {
        run.status = "interrupted"; run.finishedAt = this.now(); run.error = "应用退出导致执行中断；为避免重复操作，不自动重放";
      }
    });
  }

  list(workspace?: string): ScheduledTasksState {
    const tasks = this.state.tasks.filter(task => workspace === undefined || task.workspace === workspace);
    const ids = new Set(tasks.map(task => task.id));
    return structuredClone({ tasks, runs: this.state.runs.filter(run => ids.has(run.taskId)) });
  }
  subscribe(listener: (state: ScheduledTasksState) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async create(raw: ScheduledTaskInput): Promise<ScheduledTask> {
    const input = parseTaskInput(raw);
    await this.assertWorkspace(input.workspace);
    const now = this.now();
    const nextRunAt = nextTaskTime(input.schedule, now);
    if (nextRunAt === null) throw new Error("一次性任务的时间必须在未来");
    const task: ScheduledTask = { ...input, missedPolicy: input.missedPolicy ?? "run-once", id: randomUUID(), status: "active", nextRunAt, createdAt: now, updatedAt: now };
    this.commit(state => { state.tasks.push(task); }); this.arm();
    return structuredClone(task);
  }
  async update(id: string, raw: ScheduledTaskPatch): Promise<ScheduledTask> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("修改参数不正确");
    if (raw.status !== undefined && raw.status !== "active" && raw.status !== "paused") throw new Error("任务状态不正确");
    const initial = this.task(id);
    if (initial.recipeBinding && typeof raw.prompt === 'string' && raw.prompt.trim() !== initial.prompt && raw.recipeBinding !== null) throw new Error('此任务绑定配方；修改执行内容请重新绑定配方，或明确移除绑定');
    const input = parseTaskInput({ ...initial, ...raw });
    await this.assertWorkspace(input.workspace);
    // Re-read after filesystem await: another caller may have deleted or edited the task.
    const current = this.task(id);
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw new Error("任务已更新，请刷新后重试");
    const status = raw.status ?? current.status;
    const recalculate = raw.schedule !== undefined || (status === "active" && current.status !== "active");
    const nextRunAt = status === "active" ? (recalculate ? nextTaskTime(input.schedule, this.now()) : current.nextRunAt) : null;
    if (status === "active" && nextRunAt === null) throw new Error("请为一次性任务设置未来的时间");
    const updated = { ...current, ...input, missedPolicy: input.missedPolicy ?? "run-once", status, nextRunAt, updatedAt: this.now() };
    this.commit(state => { state.tasks[state.tasks.findIndex(task => task.id === id)] = updated; }); this.arm();
    return structuredClone(updated);
  }
  async delete(id: string): Promise<void> {
    this.task(id);
    if (this.running.has(id)) throw new Error("任务正在执行，请等待完成后删除");
    this.commit(state => { state.tasks = state.tasks.filter(task => task.id !== id); state.runs = state.runs.filter(run => run.taskId !== id); }); this.arm();
  }
  async runNow(id: string): Promise<ScheduledTaskRun> {
    if (this.stopped || this.suspended) throw new Error("调度器尚未启动或已挂起");
    if (this.running.has(id)) throw new Error("任务正在执行");
    return this.claim(this.task(id), "manual", this.now());
  }
  start(): void { this.stopped = false; this.tick(); }
  suspend(): void { this.suspended = true; this.clearTimer(); }
  resume(): void { this.suspended = false; if (!this.stopped) this.tick(); }
  stop(): void {
    this.stopped = true; this.clearTimer();
    if (this.state.runs.some(run => run.status === "running")) this.commit(state => {
      for (const run of state.runs) if (run.status === "running") {
        run.status = "interrupted"; run.finishedAt = this.now(); run.error = "应用退出导致执行中断；不自动重放";
      }
    });
  }
  async drain(): Promise<void> { await Promise.allSettled(this.running.values()); }

  /** One poll handles at most one overdue occurrence per task, including after wake/restart. */
  tick(): void {
    if (this.stopped || this.suspended) return;
    this.clearTimer();
    try {
      const now = this.now();
      for (const task of this.list().tasks) {
        if (task.status !== "active" || task.nextRunAt === null || task.nextRunAt > now) continue;
        const overlap = this.running.has(task.id);
        const missed = now - task.nextRunAt > 60_000 && task.missedPolicy === "skip";
        this.claim(task, "scheduled", task.nextRunAt, overlap ? "上一次执行尚未结束" : missed ? "已按策略跳过错过的执行" : undefined);
      }
    } catch (error) { console.error("[vela] scheduled task poll failed", error); }
    finally { this.arm(); }
  }
  private claim(task: ScheduledTask, trigger: ScheduledTaskRun["trigger"], scheduledAt: number, skip?: string): ScheduledTaskRun {
    const run: ScheduledTaskRun = { id: randomUUID(), taskId: task.id, trigger, scheduledAt, startedAt: this.now(),
      finishedAt: skip ? this.now() : null, status: skip ? "skipped" : "running", conversationId: null, error: skip ?? null };
    this.commit(state => {
      state.runs.push(run);
      if (trigger === "scheduled") {
        const current = state.tasks.find(item => item.id === task.id)!;
        current.nextRunAt = nextTaskTime(current.schedule, this.now());
        if (current.nextRunAt === null) current.status = "completed";
        current.updatedAt = this.now();
      }
    });
    if (!skip) {
      // Install the in-process lock before starting any asynchronous external effect.
      const pending = Promise.resolve().then(async () => {
        let failure: string | null = null;
        try {
          if (this.stopped) throw new Error("调度器已停止");
          await this.assertWorkspace(task.workspace);
          if (this.stopped) throw new Error("调度器已停止");
          await this.execute(task, id => this.patchRun(run.id, { conversationId: id }), structuredClone(run));
        } catch (error) { failure = error instanceof Error ? error.message : String(error); }
        this.patchRun(run.id, { status: failure ? "failed" : "success", error: failure, finishedAt: this.now() });
      }).catch(error => { console.error("[vela] task record write failed", error); }).finally(() => { this.running.delete(task.id); });
      this.running.set(task.id, pending);
    }
    return structuredClone(run);
  }
  private patchRun(id: string, patch: Partial<ScheduledTaskRun>): void {
    this.commit(state => {
      const run = state.runs.find(item => item.id === id);
      if (run && (run.status === "running" || !patch.status)) Object.assign(run, patch);
    });
  }
  private task(id: string): ScheduledTask {
    if (typeof id !== "string") throw new Error("任务 ID 不正确");
    const task = this.state.tasks.find(item => item.id === id);
    if (!task) throw new Error("任务不存在");
    return structuredClone(task);
  }
  private async assertWorkspace(workspace: string): Promise<void> {
    if (!(await stat(workspace)).isDirectory()) throw new Error("工作区目录不可用");
  }
  private commit(change: (state: ScheduledTasksState) => void): void {
    const next = structuredClone(this.state); change(next);
    // Prune after transitions too: finishing a run must not leave 101 terminal records.
    const terminalCounts = new Map<string, number>();
    next.runs = next.runs.slice().reverse().filter(run => {
      if (run.status === "running") return true;
      const count = (terminalCounts.get(run.taskId) ?? 0) + 1;
      terminalCounts.set(run.taskId, count); return count <= 100;
    }).reverse();
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, ...next }), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
    this.state = next;
    for (const listener of this.listeners) { try { listener(this.list()); } catch (error) { console.error(error); } }
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private arm(): void {
    this.clearTimer(); if (this.stopped || this.suspended) return;
    const upcoming = this.state.tasks.filter(task => task.status === "active" && task.nextRunAt !== null).map(task => task.nextRunAt!);
    const delay = Math.min(30_000, Math.max(100, Math.min(...upcoming) - this.now()));
    this.timer = setTimeout(() => this.tick(), delay); this.timer.unref();
  }
}

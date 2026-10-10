import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  backgroundSandboxMode,
  createLogger,
  deriveResidentState,
  isResidentTaskActive,
  localDay,
  mergeResidentSettings,
  normalizeResidentSettings,
  residentLimits,
  defaultResidentSettings,
  type ResidentSettings,
  type ResidentStatus,
  type ResidentSubmitInput,
  type ResidentSubmitResult,
  type ResidentTask,
  type ResidentTaskSource,
  type SandboxMode,
  type SessionStatus,
  type TranscriptMessage,
} from "@vela/shared";
import type { ResidentDelegateResult, ResidentInboxSummary, ResidentToolHost } from "@vela/agent";
import { writeJsonAtomic } from "./atomic-json";

const log = createLogger("resident-agent");

const schemaVersion = 1;
const residentTitle = "Resident Agent";

/** Supervisor 只依赖运行时的这几个入口，测试里用假对象替换。它是协调层，不是新的模型运行时。 */
export interface ResidentRuntime {
  ensureResidentConversation(cwd: string, knownId: string | null): Promise<string>;
  promptBackground(conversationId: string, text: string): Promise<void>;
  runScheduledTask(
    cwd: string,
    text: string,
    onCreated: (id: string) => void,
    execution: { sandboxMode?: SandboxMode | null; mode?: "agent" | "plan" },
  ): Promise<void>;
  abort(conversationId: string): Promise<void>;
  getConversationInfo(conversationId: string): { status: SessionStatus; model: string | null } | null;
  getMessages(conversationId: string): TranscriptMessage[];
  subscribe(listener: (event: { type: string; conversationId?: string }) => void): () => void;
}

export interface ResidentInboxSource {
  pendingWaits(): Array<{ conversationId: string | undefined }>;
  pendingCount(): number;
  recent(filter: { pendingOnly: boolean; limit: number }): ResidentInboxSummary[];
  subscribe(listener: () => void): () => void;
}

export interface ResidentApprovals {
  request(input: { kind: "delegate"; conversationId: string; command: string; cwd: string; workspace: string; insideWorkspace: false; signal?: AbortSignal }): Promise<boolean>;
}

export interface ResidentPower {
  isOnBattery(): boolean;
  /** 订阅挂起、恢复与供电来源变化，返回取消函数。 */
  subscribe(listener: (event: "suspend" | "resume" | "battery" | "ac") => void): () => void;
}

export interface ResidentSupervisorOptions {
  file: string;
  /** Resident 会话的执行目录：一个空目录，不是任何工作区。 */
  residentDir: string;
  runtime: ResidentRuntime;
  inbox: ResidentInboxSource;
  approvals: ResidentApprovals;
  power: ResidentPower;
  /** 已登记的工作区，任务只能指向其中之一。 */
  workspaces: () => string[];
  sandboxMode: () => SandboxMode;
  now?: () => number;
}

interface Stored {
  schemaVersion: number;
  settings: ResidentSettings;
  conversationId: string | null;
  tasks: ResidentTask[];
  proactive: { day: string; runs: number };
}

export interface ResidentTaskSpec {
  title: string;
  prompt: string;
  workspace: string;
  source: ResidentTaskSource;
  ruleId?: string;
  reason?: string;
  /** 在 Plan 模式（只读）下运行。 */
  readOnly?: boolean;
}

export type ResidentStartResult =
  | { ok: true; taskId: string; status: "queued" | "running" }
  | { ok: false; reason: "disabled" | "paused" | "unknown_workspace" | "queue_full" | "invalid" };

interface RunSpec { prompt: string; mode: "agent" | "plan"; sandboxMode: SandboxMode | null; deadline: ReturnType<typeof setTimeout> | null; timedOut: boolean; cancelled: boolean }

/**
 * 常驻 Agent 的协调层：持久会话身份、手动与委派的任务队列、并发与时限、暂停与电源状态。
 * 空闲时不产生任何模型调用：只有用户消息、已授权的任务或规则命中才会启动运行时。
 */
export class ResidentAgentSupervisor implements ResidentToolHost {
  private settings: ResidentSettings = defaultResidentSettings;
  private conversationId: string | null = null;
  private ledger: ResidentTask[] = [];
  private proactive = { day: "", runs: 0 };
  private readonly runs = new Map<string, RunSpec>();
  private suspended = false;
  private onBattery = false;
  private error: string | null = null;
  private storeError: string | null = null;
  private lastActivityAt: number | null = null;
  private revision = 0;
  private lastKey = "";
  private disposed = false;
  private ensuring: Promise<string> | null = null;
  private readonly statusListeners = new Set<(status: ResidentStatus) => void>();
  private readonly settingsListeners = new Set<(settings: ResidentSettings) => void>();
  private readonly offs: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly options: ResidentSupervisorOptions) {
    this.now = options.now ?? Date.now;
  }

  init(): void {
    this.load();
    // 重启后没有真实的等待点或运行中的 Agent：未完成的任务一律标为中断，不自动重放。
    let changed = false;
    for (const task of this.ledger) {
      if (!isResidentTaskActive(task.status)) continue;
      task.status = "interrupted";
      task.error = "应用退出或重启时任务尚未完成";
      task.finishedAt = this.now();
      changed = true;
    }
    this.onBattery = this.options.power.isOnBattery();
    if (changed) this.persist();
    this.offs.push(
      this.options.power.subscribe(event => {
        if (event === "suspend") this.suspended = true;
        else if (event === "resume") this.suspended = false;
        else this.onBattery = event === "battery";
        this.publish();
      }),
      this.options.runtime.subscribe(event => {
        if (event.conversationId && (event.conversationId === this.conversationId || this.isTaskConversation(event.conversationId))) this.publish();
      }),
      this.options.inbox.subscribe(() => this.publish()),
    );
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    for (const run of this.runs.values()) if (run.deadline) clearTimeout(run.deadline);
    this.publish();
  }

  // ---------- 读取 ----------

  getSettings(): ResidentSettings { return this.settings; }
  getResidentConversationId(): string | null { return this.conversationId; }
  isResidentConversation(id: string): boolean { return this.conversationId !== null && id === this.conversationId; }
  getRuntimeFlags(): { suspended: boolean; onBattery: boolean } { return { suspended: this.suspended, onBattery: this.onBattery }; }
  proactiveRunsToday(): number { return this.proactive.day === localDay(this.now()) ? this.proactive.runs : 0; }

  /** 供 Inbox 适配器给任务对话分类：来自常驻 Agent 的任务不当作普通对话回合。 */
  taskForConversation(conversationId: string): (ResidentTask & { timedOut: boolean; cancelled: boolean }) | null {
    const task = this.ledger.find(item => item.conversationId === conversationId);
    if (!task) return null;
    const run = this.runs.get(task.id);
    return { ...task, timedOut: run?.timedOut === true || task.status === "timed_out", cancelled: run?.cancelled === true || task.status === "cancelled" };
  }

  hasActiveRuleTask(ruleId: string): boolean {
    return this.ledger.some(task => task.ruleId === ruleId && isResidentTaskActive(task.status));
  }

  getStatus(): ResidentStatus {
    const running = this.ledger.filter(task => task.status === "running").length;
    const queued = this.ledger.filter(task => task.status === "queued").length;
    const info = this.conversationId ? this.options.runtime.getConversationInfo(this.conversationId) : null;
    const residentBusy = info?.status === "streaming";
    const taskConversations = new Set(this.ledger.filter(task => isResidentTaskActive(task.status) && task.conversationId).map(task => task.conversationId!));
    const waiting = this.options.inbox.pendingWaits()
      .filter(wait => wait.conversationId !== undefined && (wait.conversationId === this.conversationId || taskConversations.has(wait.conversationId))).length;
    const error = this.error ?? this.storeError;
    return {
      state: deriveResidentState({
        mode: this.settings.mode, paused: this.settings.paused, suspended: this.suspended, runtimeAvailable: !this.disposed,
        error, runningTasks: running, residentBusy, waitingItems: waiting,
      }),
      mode: this.settings.mode,
      paused: this.settings.paused,
      conversationId: this.conversationId,
      model: info?.model ?? null,
      residentBusy,
      runningTasks: running,
      queuedTasks: queued,
      waitingItems: waiting,
      pendingItems: this.options.inbox.pendingCount(),
      lastActivityAt: this.lastActivityAt,
      suspended: this.suspended,
      onBattery: this.onBattery,
      error,
      proactiveRunsToday: this.proactiveRunsToday(),
      tasks: this.ledger.slice(-residentLimits.maxTasksShown).reverse(),
      workspaces: this.options.workspaces(),
      revision: this.revision,
    };
  }

  getMessages(): TranscriptMessage[] {
    if (!this.conversationId) return [];
    try { return this.options.runtime.getMessages(this.conversationId); }
    catch (error) { log.error("resident messages unavailable", error); return []; }
  }

  subscribe(listener: (status: ResidentStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  /** 设置变化（含暂停与恢复）。菜单栏、登录项和通知据此调整。 */
  subscribeSettings(listener: (settings: ResidentSettings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => { this.settingsListeners.delete(listener); };
  }

  // ---------- 设置 ----------

  updateSettings(patch: unknown): ResidentSettings {
    const next = mergeResidentSettings(this.settings, patch);
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return this.settings;
    this.settings = next;
    this.persist();
    for (const listener of this.settingsListeners) this.safely(() => listener(next));
    this.publish();
    // 并发上限调大后，排队的任务可以立即开始。
    this.pump();
    return next;
  }

  pause(): ResidentSettings { return this.updateSettings({ paused: true }); }
  resume(): ResidentSettings { return this.updateSettings({ paused: false }); }

  // ---------- 任务 ----------

  /** 用户在 Inbox 里提交。指定工作区时直接创建后台任务，否则交给 Resident Agent 的持久会话。 */
  async submit(input: ResidentSubmitInput): Promise<ResidentSubmitResult> {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > residentLimits.maxPrompt) return { ok: false, reason: "invalid" };
    const blocked = this.blockReason();
    if (blocked) return { ok: false, reason: blocked };
    this.lastActivityAt = this.now();
    if (input.workspace !== undefined) {
      const started = this.startTask({ title: titleOf(text), prompt: text, workspace: input.workspace, source: "user" });
      return started.ok ? { ok: true, target: "task", taskId: started.taskId } : { ok: false, reason: started.reason };
    }
    try {
      const id = await this.ensureConversation();
      this.error = null;
      void this.options.runtime.promptBackground(id, text).catch(error => {
        log.error("resident prompt failed", error);
        this.error = error instanceof Error ? error.message : String(error);
        this.publish();
      }).finally(() => { this.lastActivityAt = this.now(); this.publish(); });
      this.publish();
      return { ok: true, target: "resident" };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.publish();
      return { ok: false, reason: "failed", message: this.error };
    }
  }

  /** 创建一个后台任务。用户、Resident Agent 与主动规则共用同一个入口：并发、队列、暂停与时限都在这里。 */
  startTask(spec: ResidentTaskSpec): ResidentStartResult {
    const blocked = this.blockReason();
    if (blocked) return { ok: false, reason: blocked };
    const workspace = this.resolveWorkspace(spec.workspace);
    if (!workspace) return { ok: false, reason: "unknown_workspace" };
    const prompt = spec.prompt.trim();
    if (!prompt || prompt.length > residentLimits.maxPrompt) return { ok: false, reason: "invalid" };
    if (this.ledger.filter(task => task.status === "queued").length >= residentLimits.maxQueued) return { ok: false, reason: "queue_full" };

    const now = this.now();
    const task: ResidentTask = {
      id: randomUUID(),
      title: spec.title.trim().slice(0, residentLimits.maxTitle) || titleOf(prompt),
      prompt: prompt.slice(0, 600),
      workspace,
      source: spec.source,
      ...(spec.ruleId ? { ruleId: spec.ruleId } : {}),
      ...(spec.reason ? { reason: spec.reason.slice(0, 300) } : {}),
      conversationId: null,
      status: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.runs.set(task.id, {
      prompt,
      mode: spec.readOnly ? "plan" : "agent",
      // 主动触发的任务不使用 Full Access：规则不能绕过审批。
      sandboxMode: spec.source === "rule" ? backgroundSandboxMode(this.options.sandboxMode()) : null,
      deadline: null, timedOut: false, cancelled: false,
    });
    this.ledger.push(task);
    if (spec.source === "rule") this.countProactiveRun();
    this.lastActivityAt = now;
    this.trim();
    this.persist();
    this.publish();
    this.pump();
    return { ok: true, taskId: task.id, status: task.status === "queued" ? "queued" : "running" };
  }

  async cancelTask(id: string): Promise<void> {
    const task = this.ledger.find(item => item.id === id);
    const run = this.runs.get(id);
    if (!task || !isResidentTaskActive(task.status)) return;
    if (run) run.cancelled = true;
    if (task.status === "queued") {
      this.finish(task, "cancelled");
      this.publish();
      return;
    }
    if (task.conversationId) await this.options.runtime.abort(task.conversationId);
  }

  // ---------- ResidentToolHost：Resident Agent 的协调工具 ----------

  workspaces(): string[] { return this.options.workspaces(); }
  tasks(): ResidentTask[] { return this.ledger.slice(-residentLimits.maxTasksShown).reverse(); }
  inbox(filter: { pendingOnly: boolean; limit: number }): ResidentInboxSummary[] { return this.options.inbox.recent(filter); }

  async delegate(input: { workspace: string; title: string; prompt: string; signal?: AbortSignal }): Promise<ResidentDelegateResult> {
    const blocked = this.blockReason();
    if (blocked) return { ok: false, reason: blocked === "disabled" ? "常驻 Agent 已关闭，不能创建后台任务" : "后台自动任务已暂停，不能创建后台任务" };
    const workspace = this.resolveWorkspace(input.workspace);
    if (!workspace) return { ok: false, reason: "这不是已登记的工作区；先用 list_workspaces 确认" };
    const conversationId = this.conversationId;
    if (!conversationId) return { ok: false, reason: "常驻会话尚未建立" };
    const allowed = await this.options.approvals.request({
      kind: "delegate",
      conversationId,
      command: `${input.title}\n\n${input.prompt}`.slice(0, 2000),
      cwd: workspace,
      workspace: this.options.residentDir,
      insideWorkspace: false,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!allowed) return { ok: false, reason: "用户拒绝了这个后台任务" };
    // 批准期间状态可能变了（暂停、关闭）：以批准当下的权威状态为准。
    const started = this.startTask({ title: input.title, prompt: input.prompt, workspace, source: "agent" });
    if (!started.ok) return { ok: false, reason: `无法创建任务：${started.reason}` };
    return { ok: true, taskId: started.taskId, status: started.status };
  }

  // ---------- 内部 ----------

  private blockReason(): "disabled" | "paused" | null {
    if (this.settings.mode === "disabled") return "disabled";
    if (this.settings.paused) return "paused";
    return null;
  }

  private resolveWorkspace(raw: string): string | null {
    if (typeof raw !== "string" || !raw) return null;
    const normalized = resolve(raw);
    return this.options.workspaces().find(path => resolve(path) === normalized) ?? null;
  }

  private ensureConversation(): Promise<string> {
    if (this.ensuring) return this.ensuring;
    mkdirSync(this.options.residentDir, { recursive: true });
    const pending = this.options.runtime.ensureResidentConversation(this.options.residentDir, this.conversationId).then(id => {
      if (id !== this.conversationId) { this.conversationId = id; this.persist(); }
      return id;
    });
    this.ensuring = pending;
    void pending.then(() => { this.ensuring = null; }, () => { this.ensuring = null; });
    return pending;
  }

  private isTaskConversation(id: string): boolean {
    return this.ledger.some(task => task.conversationId === id);
  }

  private pump(): void {
    if (this.disposed) return;
    // 暂停与关闭只阻止新的任务开始；已在运行的不中断，排队中的保持排队。
    if (this.blockReason()) return;
    const limit = this.settings.limits.maxConcurrentTasks;
    for (;;) {
      const running = this.ledger.filter(task => task.status === "running").length;
      const next = this.ledger.find(task => task.status === "queued");
      if (!next || running >= limit) return;
      void this.execute(next);
    }
  }

  private async execute(task: ResidentTask): Promise<void> {
    const run = this.runs.get(task.id);
    if (!run) { this.finish(task, "interrupted", "任务内容已丢失"); return; }
    task.status = "running";
    task.startedAt = this.now();
    this.persist();
    this.publish();
    const minutes = this.settings.limits.maxTaskMinutes;
    run.deadline = setTimeout(() => {
      run.timedOut = true;
      if (task.conversationId) void this.options.runtime.abort(task.conversationId).catch(error => log.error("task timeout abort failed", error));
    }, minutes * 60_000);
    run.deadline.unref?.();
    try {
      await this.options.runtime.runScheduledTask(task.workspace, run.prompt, id => {
        task.conversationId = id;
        this.persist();
        this.publish();
      }, { sandboxMode: run.sandboxMode, mode: run.mode });
      this.finish(task, run.timedOut ? "timed_out" : run.cancelled ? "cancelled" : "succeeded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (run.timedOut) this.finish(task, "timed_out", `超过 ${minutes} 分钟，已停止`);
      else if (run.cancelled) this.finish(task, "cancelled");
      else if (this.disposed) this.finish(task, "interrupted", message);
      else this.finish(task, "failed", message);
    } finally {
      this.publish();
      this.pump();
    }
  }

  private finish(task: ResidentTask, status: ResidentTask["status"], error?: string): void {
    const run = this.runs.get(task.id);
    if (run?.deadline) clearTimeout(run.deadline);
    this.runs.delete(task.id);
    task.status = status;
    task.finishedAt = this.now();
    if (error) task.error = error.slice(0, 500);
    this.lastActivityAt = task.finishedAt;
    this.persist();
  }

  private countProactiveRun(): void {
    const day = localDay(this.now());
    this.proactive = this.proactive.day === day ? { day, runs: this.proactive.runs + 1 } : { day, runs: 1 };
  }

  private trim(): void {
    const excess = this.ledger.length - residentLimits.maxTasksKept;
    if (excess <= 0) return;
    const removable = this.ledger.filter(task => !isResidentTaskActive(task.status)).slice(0, excess);
    this.ledger = this.ledger.filter(task => !removable.includes(task));
  }

  /** 状态没有实质变化时不推送，避免运行时的每个工具事件都刷新界面。 */
  private publish(): void {
    const status = this.getStatus();
    const { revision: _revision, ...rest } = status;
    const key = JSON.stringify(rest);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.revision += 1;
    const next = { ...status, revision: this.revision };
    for (const listener of this.statusListeners) this.safely(() => listener(next));
  }

  private safely(work: () => void): void {
    try { work(); } catch (error) { log.error("resident listener failed", error); }
  }

  private persist(): void {
    const stored: Stored = { schemaVersion, settings: this.settings, conversationId: this.conversationId, tasks: this.ledger, proactive: this.proactive };
    try { writeJsonAtomic(this.options.file, stored, 2); }
    catch (error) {
      log.error("resident state write failed", error);
      this.storeError = `无法保存常驻 Agent 状态：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private load(): void {
    let raw: string;
    try { raw = readFileSync(this.options.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.storeError = `无法读取常驻 Agent 状态：${(error as Error).message}`;
      return;
    }
    try {
      const value = JSON.parse(raw) as Partial<Stored>;
      if (!value || typeof value !== "object" || value.schemaVersion !== schemaVersion) throw new Error("格式不正确");
      this.settings = normalizeResidentSettings(value.settings);
      this.conversationId = typeof value.conversationId === "string" && value.conversationId ? value.conversationId : null;
      this.ledger = Array.isArray(value.tasks) ? value.tasks.filter(isTask).slice(-residentLimits.maxTasksKept) : [];
      const proactive = value.proactive;
      this.proactive = proactive && typeof proactive.day === "string" && Number.isFinite(proactive.runs) ? { day: proactive.day, runs: proactive.runs } : { day: "", runs: 0 };
    } catch (error) {
      const quarantined = `${this.options.file}.corrupt-${this.now()}`;
      try { renameSync(this.options.file, quarantined); } catch { /* 隔离失败时仍从默认设置开始。 */ }
      this.storeError = `常驻 Agent 状态已损坏，已隔离为 ${quarantined}`;
      log.error("resident state corrupt", error);
      try { mkdirSync(dirname(this.options.file), { recursive: true }); } catch { /* 目录创建失败会在写入时报告。 */ }
    }
  }
}

function titleOf(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || residentTitle;
}

function isTask(value: unknown): value is ResidentTask {
  const task = value as ResidentTask | null;
  return Boolean(task && typeof task.id === "string" && typeof task.title === "string" && typeof task.workspace === "string"
    && typeof task.status === "string" && Number.isFinite(task.createdAt));
}

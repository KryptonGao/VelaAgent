import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import {
  admitProactiveRun,
  createLogger,
  isIgnoredWorkspacePath,
  localDay,
  normalizeRuleInput,
  residentLimits,
  truncateInboxText,
  type ProactiveRule,
  type ProactiveRuleInput,
  type ProactiveRuleResult,
  type ProactiveRulesState,
  type ProactiveSkipReason,
  type ResidentSettings,
} from "@vela/shared";
import { writeJsonAtomic } from "./atomic-json";
import type { ResidentStartResult, ResidentTaskSpec } from "./resident-agent-supervisor";

const log = createLogger("proactive-rules");
const schemaVersion = 1;

export interface WatchHandle { close(): void }
/** fs.watch 的最小接口。filename 为 null 表示平台没有给出文件名。 */
export type WatchFactory = (path: string, options: { recursive: boolean }, listener: (filename: string | null) => void) => WatchHandle;

export interface ProactiveHost {
  settings(): ResidentSettings;
  flags(): { suspended: boolean; onBattery: boolean };
  globalRunsToday(): number;
  ruleRunning(ruleId: string): boolean;
  startTask(spec: ResidentTaskSpec): ResidentStartResult;
  workspaces(): string[];
  /** 工作区的 Git 目录；不是仓库时为 null。 */
  gitDir(workspace: string): string | null;
  watch: WatchFactory;
}

export interface ProactiveRulesOptions {
  file: string;
  host: ProactiveHost;
  now?: () => number;
  schedule?: (work: () => void, ms: number) => { cancel(): void };
}

/** 事件合并窗口：保存一个文件常常产生几十次文件系统事件，只启动一次分析。 */
export const debounceMs = { inbox_error: 0, git_change: 3000, file_change: 5000 } as const;
/** 没有空位时的重试退避。 */
export const retryBackoffMs = [30_000, 120_000, 600_000] as const;

interface Pending {
  reasons: string[];
  count: number;
  timer: { cancel(): void } | null;
  attempt: number;
}

/** 可以被 Inbox 事项触发的最小字段。 */
export interface ProactiveInboxSignal {
  id: string;
  type: string;
  origin: string;
  workspaceId?: string;
  title: string;
  summary: string;
}

/**
 * 用户订阅的主动规则。只在 Proactive 模式下才会创建文件监听；每个信号经过合并、冷却、
 * 每日上限、并发保护和电池策略之后才会唤醒 Agent，被拦下的原因记在规则上供界面解释。
 */
export class ProactiveRuleService {
  private rules: ProactiveRule[] = [];
  private error: string | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly watchers = new Map<string, WatchHandle[]>();
  private readonly listeners = new Set<(state: ProactiveRulesState) => void>();
  private readonly now: () => number;
  private readonly schedule: NonNullable<ProactiveRulesOptions["schedule"]>;
  private disposed = false;

  constructor(private readonly options: ProactiveRulesOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((work, ms) => {
      const timer = setTimeout(work, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    });
  }

  init(): void {
    this.load();
    this.sync();
  }

  dispose(): void {
    this.disposed = true;
    this.closeWatchers();
    for (const pending of this.pending.values()) pending.timer?.cancel();
    this.pending.clear();
  }

  list(): ProactiveRulesState { return { rules: this.rules, error: this.error }; }

  subscribe(listener: (state: ProactiveRulesState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  save(raw: unknown, id?: string): ProactiveRuleResult {
    const parsed = normalizeRuleInput(raw);
    if (!parsed.ok) return parsed;
    const input = parsed.input;
    if (!this.options.host.workspaces().includes(input.workspace)) return { ok: false, error: "规则只能指向已登记的工作区" };
    const now = this.now();
    const existing = id ? this.rules.find(rule => rule.id === id) : undefined;
    if (id && !existing) return { ok: false, error: "规则不存在" };
    if (!existing && this.rules.length >= residentLimits.maxRules) return { ok: false, error: "规则数量已达上限" };
    const rule: ProactiveRule = existing
      ? { ...existing, ...input, updatedAt: now }
      : { ...input, id: randomUUID(), createdAt: now, updatedAt: now, lastTriggeredAt: null, runDay: "", runsToday: 0, lastSkip: null };
    this.rules = existing ? this.rules.map(item => item.id === rule.id ? rule : item) : [...this.rules, rule];
    this.commit();
    return { ok: true, rule };
  }

  remove(id: string): ProactiveRulesState {
    this.rules = this.rules.filter(rule => rule.id !== id);
    this.cancelPending(id);
    this.commit();
    return this.list();
  }

  /** 设置或工作区变化后调用：Proactive 且未暂停时才监听，其余时候不占任何资源。 */
  sync(): void {
    this.closeWatchers();
    const settings = this.options.host.settings();
    if (this.disposed || settings.mode !== "proactive" || settings.paused) return;
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.kind === "inbox_error") continue;
      try { this.watchRule(rule); }
      catch (error) {
        this.error = `无法监听工作区：${error instanceof Error ? error.message : String(error)}`;
        log.error("watch failed", error);
      }
    }
    this.emit();
  }

  /** 收件箱里新出现的失败事项。常驻 Agent 和主动分析自己的失败不触发规则，避免循环。 */
  onInboxItem(item: ProactiveInboxSignal): void {
    if (item.type !== "error" || item.origin === "proactive" || item.origin === "resident") return;
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.kind !== "inbox_error" || item.workspaceId !== rule.workspace) continue;
      if (rule.trigger.filter && !`${item.title}\n${item.summary}`.toLowerCase().includes(rule.trigger.filter.toLowerCase())) continue;
      this.signal(rule, `${item.title || "任务"} 失败：${truncateInboxText(item.summary, 200)}`);
    }
  }

  // ---------- 信号 ----------

  private watchRule(rule: ProactiveRule): void {
    const handles: WatchHandle[] = [];
    const { host } = this.options;
    if (rule.trigger.kind === "file_change") {
      handles.push(host.watch(rule.workspace, { recursive: true }, filename => {
        if (!filename || isIgnoredWorkspacePath(filename)) return;
        if (rule.trigger.filter && !filename.toLowerCase().includes(rule.trigger.filter.toLowerCase())) return;
        this.signal(rule, `文件变化：${filename}`);
      }));
    } else if (rule.trigger.kind === "git_change") {
      const gitDir = host.gitDir(rule.workspace);
      if (!gitDir) throw new Error(`${rule.workspace} 不是 Git 仓库`);
      // HEAD 随切换分支变化；logs 随每次提交、重置和拉取变化。暂存区变化不算。
      handles.push(host.watch(gitDir, { recursive: false }, filename => {
        if (filename === "HEAD" || filename === "MERGE_HEAD") this.signal(rule, `Git 状态变化：${filename}`);
      }));
      try {
        handles.push(host.watch(`${gitDir}/logs`, { recursive: true }, () => this.signal(rule, "Git 提交或引用变化")));
      } catch { /* 新仓库还没有 logs 目录。 */ }
    }
    this.watchers.set(rule.id, handles);
  }

  private signal(rule: ProactiveRule, reason: string): void {
    if (this.disposed) return;
    const current = this.pending.get(rule.id) ?? { reasons: [], count: 0, timer: null, attempt: 0 };
    current.count += 1;
    if (current.reasons.length < 5 && !current.reasons.includes(reason)) current.reasons.push(reason);
    this.pending.set(rule.id, current);
    if (current.timer) return;
    const wait = debounceMs[rule.trigger.kind];
    if (wait === 0) { this.fire(rule.id); return; }
    current.timer = this.schedule(() => this.fire(rule.id), wait);
  }

  private cancelPending(ruleId: string): void {
    this.pending.get(ruleId)?.timer?.cancel();
    this.pending.delete(ruleId);
  }

  private fire(ruleId: string): void {
    const pending = this.pending.get(ruleId);
    const rule = this.rules.find(item => item.id === ruleId);
    if (!pending || !rule) { this.pending.delete(ruleId); return; }
    pending.timer = null;
    const { host } = this.options;
    const now = this.now();
    const admission = admitProactiveRun({
      rule, settings: host.settings(), now, ...host.flags(),
      ruleRunning: host.ruleRunning(rule.id), globalRunsToday: host.globalRunsToday(),
    });
    if (!admission.ok) { this.skip(rule, admission.reason); this.pending.delete(ruleId); return; }

    const reason = pending.reasons.join("；") + (pending.count > pending.reasons.length ? `（共 ${pending.count} 次事件）` : "");
    const result = host.startTask({
      title: rule.title,
      prompt: composePrompt(rule, reason),
      workspace: rule.workspace,
      source: "rule",
      ruleId: rule.id,
      reason: `规则「${rule.title}」：${reason}`,
      readOnly: !rule.allowTools,
    });
    if (result.ok) {
      this.pending.delete(ruleId);
      const runDay = localDay(now);
      this.update(rule.id, { lastTriggeredAt: now, runDay, runsToday: rule.runDay === runDay ? rule.runsToday + 1 : 1, lastSkip: null }, true);
      return;
    }
    // 队列满等暂时性失败：退避重试，仍然失败就放弃这一批事件。
    const delay = result.reason === "queue_full" ? retryBackoffMs[pending.attempt] : undefined;
    if (delay === undefined) { this.skip(rule, result.reason === "unknown_workspace" ? "filtered" : "busy"); this.pending.delete(ruleId); return; }
    pending.attempt += 1;
    pending.timer = this.schedule(() => this.fire(ruleId), delay);
    this.skip(rule, "busy");
  }

  private skip(rule: ProactiveRule, reason: ProactiveSkipReason): void {
    this.update(rule.id, { lastSkip: { at: this.now(), reason } }, false);
  }

  private update(id: string, patch: Partial<ProactiveRule>, persist: boolean): void {
    this.rules = this.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule);
    if (persist) this.commit(false); else this.emit();
  }

  // ---------- 存储 ----------

  /** 写盘后通知界面；规则内容变化才需要重建监听，命中计数变化不需要。 */
  private commit(resync = true): void {
    try {
      writeJsonAtomic(this.options.file, { schemaVersion, rules: this.rules }, 2);
    } catch (error) {
      this.error = `无法保存主动规则：${error instanceof Error ? error.message : String(error)}`;
      log.error("rules write failed", error);
    }
    if (resync) this.sync(); else this.emit();
  }

  private emit(): void {
    const state = this.list();
    for (const listener of this.listeners) {
      try { listener(state); } catch (error) { log.error("rules listener failed", error); }
    }
  }

  private closeWatchers(): void {
    for (const handles of this.watchers.values()) for (const handle of handles) { try { handle.close(); } catch { /* 监听已经失效。 */ } }
    this.watchers.clear();
  }

  private load(): void {
    let raw: string;
    try { raw = readFileSync(this.options.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = `无法读取主动规则：${(error as Error).message}`;
      return;
    }
    try {
      const value = JSON.parse(raw) as { schemaVersion?: number; rules?: unknown };
      if (value.schemaVersion !== schemaVersion || !Array.isArray(value.rules)) throw new Error("格式不正确");
      this.rules = value.rules.flatMap(item => {
        const parsed = normalizeRuleInput(item);
        const stored = item as Partial<ProactiveRule>;
        if (!parsed.ok || typeof stored.id !== "string") return [];
        return [{
          ...parsed.input, id: stored.id,
          createdAt: Number.isFinite(stored.createdAt) ? stored.createdAt! : this.now(),
          updatedAt: Number.isFinite(stored.updatedAt) ? stored.updatedAt! : this.now(),
          lastTriggeredAt: Number.isFinite(stored.lastTriggeredAt) ? stored.lastTriggeredAt! : null,
          runDay: typeof stored.runDay === "string" ? stored.runDay : "",
          runsToday: Number.isFinite(stored.runsToday) ? stored.runsToday! : 0,
          lastSkip: null,
        } satisfies ProactiveRule];
      }).slice(0, residentLimits.maxRules);
    } catch (error) {
      const quarantined = `${this.options.file}.corrupt-${this.now()}`;
      try { renameSync(this.options.file, quarantined); } catch { /* 隔离失败时仍从空规则开始。 */ }
      this.error = `主动规则文件已损坏，已隔离为 ${quarantined}`;
      log.error("rules store corrupt", error);
    }
  }
}

function composePrompt(rule: ProactiveRuleInput, reason: string): string {
  const mode = rule.allowTools
    ? "你可以运行命令和修改文件，但每一步都会请求用户批准；除非规则明确要求，否则只分析并给出建议，不要直接修改。"
    : "当前是只读分析：不要修改任何文件，只查阅并给出建议。";
  return `这是用户订阅的主动规则「${rule.title}」触发的分析，不是用户当面提出的请求。
触发原因：${reason}

规则要求：
${rule.prompt}

${mode}
用简洁的结论开头，列出具体、可以执行的建议；如果没有发现需要用户处理的问题，直接说明「没有发现需要处理的事项」。`;
}

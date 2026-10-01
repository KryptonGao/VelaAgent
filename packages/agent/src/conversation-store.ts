import type { ConversationGoal, ExecutionPlan, ExecutionPlanItem, InteractionMode, ProposedPlanItem } from "@vela/shared";
import { normalizeStoredGoal } from "./goal-validation";
import { normalizeStoredAgents, type StoredAgent } from "./agent-history";
import { latestPlan, migrateLegacyPlan, sortPlans, type LegacyPlanRecord } from "./plan";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredConversation {
  /** 与 Pi 会话 id 一致,重启后据此找回会话文件。 */
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  toolCallCount: number;
  sessionFile: string | null;
  /** 创建对话时快照的额外指令。之后修改设置不会改写已有对话。 */
  instructions: string;
  mode: InteractionMode;
  /** 全部 ProposedPlan revision,按 revision 升序;旧版本只读保留。 */
  plans: ProposedPlanItem[];
  /** 最新 revision 的 id,供界面快速定位。 */
  latestProposedPlanId: string | null;
  /** 历次执行计划;重新规划后旧执行计划保留但不再激活。 */
  executionPlans: ExecutionPlan[];
  activeExecutionPlanId: string | null;
  goal: ConversationGoal | null;
  /** 非空表示已归档(侧边栏隐藏、设置里可搜索恢复),值为归档时间。 */
  archivedAt: number | null;
  /** 旧会话没有此字段；启动时可从主会话结果迁移。 */
  agents?: StoredAgent[];
}

interface StorePayload {
  version: 2;
  conversations: StoredConversation[];
}

const persistDelayMs = 400;

/**
 * 对话元数据(列表、标题、Context 用量、会话文件路径)的 JSON 持久化。
 * 消息正文本身由 Pi 的 SessionManager 落在 JSONL 会话文件里,这里只存索引。
 * Plan revision 与 ExecutionPlan 属于会话元数据,存在这里。
 * 写入按防抖合并;新建对话与进程退出时用 flushSync 立即落盘。
 */
export class ConversationStore {
  private readonly conversations = new Map<string, StoredConversation>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StorePayload>;
      if (!Array.isArray(raw.conversations)) return;
      for (const entry of raw.conversations) {
        const parsed = normalize(entry);
        if (parsed) this.conversations.set(parsed.id, parsed);
      }
    } catch {
      // 首次启动或文件损坏时从空列表开始。
    }
  }

  list(): StoredConversation[] {
    return [...this.conversations.values()];
  }

  get(id: string): StoredConversation | null {
    const entry = this.conversations.get(id);
    return entry ? { ...entry } : null;
  }

  update(id: string, patch: Partial<Omit<StoredConversation, "id">>): void {
    const current = this.conversations.get(id);
    if (!current) return;
    this.conversations.set(id, { ...current, ...patch });
    this.schedule();
  }

  put(entry: StoredConversation): void {
    this.conversations.set(entry.id, { ...entry });
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist();
    }, persistDelayMs);
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    const payload: StorePayload = { version: 2, conversations: [...this.conversations.values()] };
    const tempPath = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    } catch {
      // 磁盘不可写时保留内存状态,下次变更再试。
    }
  }

  /** 进程退出前的同步落盘(before-quit 里没有异步余量)。 */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const payload: StorePayload = { version: 2, conversations: [...this.conversations.values()] };
    // 同步写也用临时文件 + rename,强制退出时不会留下写了一半的 JSON。
    const tempPath = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tempPath, this.filePath);
    } catch {
      // 忽略退出时的写盘失败。
    }
  }
}

function normalize(entry: unknown): StoredConversation | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.cwd !== "string") return null;
  const mode = normalizeMode(record.mode);
  let plans = normalizePlans(record.plans);
  let latestProposedPlanId = typeof record.latestProposedPlanId === "string" ? record.latestProposedPlanId : null;
  let executionPlans = normalizeExecutionPlans(record.executionPlans);
  let activeExecutionPlanId = typeof record.activeExecutionPlanId === "string" ? record.activeExecutionPlanId : null;
  if (plans.length === 0) {
    // version 1 只有会被覆盖的 conversation.plan;迁移成 v1 ProposedPlan + 执行进度。
    const legacy = normalizeLegacyPlan(record.plan);
    const migration = legacy ? migrateLegacyPlan(legacy, { mode, now: Date.now() }) : null;
    if (migration) {
      plans = migration.plans;
      latestProposedPlanId = migration.latestProposedPlanId;
      if (migration.executionPlan) {
        executionPlans = [migration.executionPlan];
        activeExecutionPlanId = migration.executionPlan.id;
      }
    }
  }
  if (latestProposedPlanId && !plans.some((plan) => plan.id === latestProposedPlanId)) {
    latestProposedPlanId = latestPlan(plans)?.id ?? null;
  }
  if (!latestProposedPlanId && plans.length > 0) {
    latestProposedPlanId = latestPlan(plans)?.id ?? null;
  }
  if (activeExecutionPlanId && !executionPlans.some((plan) => plan.id === activeExecutionPlanId)) {
    activeExecutionPlanId = null;
  }
  return {
    id: record.id,
    cwd: record.cwd,
    title: typeof record.title === "string" ? record.title : "新对话",
    createdAt: numberOr(record.createdAt, Date.now()),
    updatedAt: numberOr(record.updatedAt, Date.now()),
    messageCount: numberOr(record.messageCount, 0),
    toolCallCount: numberOr(record.toolCallCount, 0),
    sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : null,
    instructions: typeof record.instructions === "string" ? record.instructions : "",
    mode,
    plans,
    latestProposedPlanId,
    executionPlans,
    activeExecutionPlanId,
    goal: normalizeStoredGoal(record.goal),
    archivedAt: numberOr(record.archivedAt, 0) > 0 ? (record.archivedAt as number) : null,
    agents: normalizeStoredAgents(record.agents),
  };
}

function normalizeMode(value: unknown): InteractionMode {
  return value === "plan" || value === "goal" ? value : "agent";
}

function normalizePlans(value: unknown): ProposedPlanItem[] {
  if (!Array.isArray(value)) return [];
  const plans: ProposedPlanItem[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const plan = normalizeProposedPlan(item);
    if (!plan || seen.has(plan.id)) continue;
    seen.add(plan.id);
    plans.push(plan);
  }
  return sortPlans(plans);
}

function normalizeProposedPlan(value: unknown): ProposedPlanItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id : null;
  const markdown = typeof record.markdown === "string" ? record.markdown : "";
  const revision = numberOr(record.revision, 0);
  if (!id || !markdown.trim() || revision < 1) return null;
  const status = record.status === "approved" || record.status === "superseded" ? record.status : "draft";
  return {
    id,
    markdown,
    revision,
    supersedes: typeof record.supersedes === "string" && record.supersedes ? record.supersedes : null,
    status,
    objective: typeof record.objective === "string" && record.objective.trim() ? record.objective : null,
    createdAt: numberOr(record.createdAt, Date.now()),
    approvedAt: numberOr(record.approvedAt, 0) > 0 ? (record.approvedAt as number) : null,
  };
}

function normalizeExecutionPlans(value: unknown): ExecutionPlan[] {
  if (!Array.isArray(value)) return [];
  const plans: ExecutionPlan[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const plan = normalizeExecutionPlan(item);
    if (!plan || seen.has(plan.id)) continue;
    seen.add(plan.id);
    plans.push(plan);
  }
  return plans;
}

function normalizeExecutionPlan(value: unknown): ExecutionPlan | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id : null;
  const sourcePlanId = typeof record.sourcePlanId === "string" && record.sourcePlanId.trim()
    ? record.sourcePlanId
    : null;
  if (!id || !sourcePlanId) return null;
  const items: ExecutionPlanItem[] = [];
  if (Array.isArray(record.items)) {
    for (const item of record.items) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (!text) continue;
      const status = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
      items.push({
        id: typeof entry.id === "string" && entry.id ? entry.id : randomStepId(),
        text,
        status,
      });
    }
  }
  return { id, sourcePlanId, items, updatedAt: numberOr(record.updatedAt, Date.now()) };
}

/** 旧 version 1 的 plan 字段;只在迁移时读取。 */
function normalizeLegacyPlan(value: unknown): LegacyPlanRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || typeof record.overview !== "string" || !Array.isArray(record.steps)) {
    return null;
  }
  const steps: LegacyPlanRecord["steps"] = [];
  for (const step of record.steps) {
    if (!step || typeof step !== "object") continue;
    const item = step as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || typeof item.text !== "string" || !item.text.trim()) continue;
    steps.push({ id: item.id, text: item.text, done: item.done === true });
  }
  if (!record.title.trim() || steps.length === 0) return null;
  return {
    title: record.title,
    overview: record.overview,
    steps,
    updatedAt: numberOr(record.updatedAt, Date.now()),
  };
}

function randomStepId(): string {
  return `step-${Math.random().toString(36).slice(2, 10)}`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

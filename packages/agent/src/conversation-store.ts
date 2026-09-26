import type { ConversationGoal, ConversationPlan, GoalStatus, InteractionMode, PlanStep } from "@vela/shared";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
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
  plan: ConversationPlan | null;
  goal: ConversationGoal | null;
  /** 非空表示已归档(侧边栏隐藏、设置里可搜索恢复),值为归档时间。 */
  archivedAt: number | null;
}

interface StorePayload {
  version: 1;
  conversations: StoredConversation[];
}

const persistDelayMs = 400;

/**
 * 对话元数据(列表、标题、Context 用量、会话文件路径)的 JSON 持久化。
 * 消息正文本身由 Pi 的 SessionManager 落在 JSONL 会话文件里,这里只存索引。
 * 写入按防抖合并;进程退出时用 flushSync 保证落盘。
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
    const payload: StorePayload = { version: 1, conversations: [...this.conversations.values()] };
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
    const payload: StorePayload = { version: 1, conversations: [...this.conversations.values()] };
    try {
      writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // 忽略退出时的写盘失败。
    }
  }
}

function normalize(entry: unknown): StoredConversation | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.cwd !== "string") return null;
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
    mode: normalizeMode(record.mode),
    plan: normalizePlan(record.plan),
    goal: normalizeGoal(record.goal),
    archivedAt: numberOr(record.archivedAt, 0) > 0 ? (record.archivedAt as number) : null,
  };
}

function normalizeMode(value: unknown): InteractionMode {
  return value === "plan" || value === "goal" ? value : "agent";
}

function normalizePlan(value: unknown): ConversationPlan | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || typeof record.overview !== "string" || !Array.isArray(record.steps)) {
    return null;
  }
  const steps: PlanStep[] = [];
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

function normalizeGoal(value: unknown): ConversationGoal | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.objective !== "string" || !record.objective.trim()) {
    return null;
  }
  const status = normalizeGoalStatus(record.status);
  if (!status) return null;
  const note = typeof record.note === "string" && record.note.trim() ? record.note : null;
  // 重启时没有正在跑的循环，进行中的目标改为暂停，避免自己接着跑。
  if (status === "active") {
    return {
      id: record.id,
      objective: record.objective,
      status: "paused",
      note: note ?? "应用重启后已暂停，可以继续",
      updatedAt: numberOr(record.updatedAt, Date.now()),
    };
  }
  return {
    id: record.id,
    objective: record.objective,
    status,
    note,
    updatedAt: numberOr(record.updatedAt, Date.now()),
  };
}

function normalizeGoalStatus(value: unknown): GoalStatus | null {
  return value === "active" || value === "paused" || value === "complete" ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

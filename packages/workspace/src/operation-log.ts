import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  GitOperationQuery,
  GitOperationRecord,
  GitOperationSnapshot,
  GitOperationStep,
  GitOperationType,
} from "@vela/shared";

const maxStoredRecords = 200;
const maxRecentRecords = 50;

export interface GitOperationBeginInput {
  type: GitOperationType;
  workspace: string | null;
  repoRoot: string | null;
  branch: string | null;
  expectedHead: string | null;
  steps: { id: string; label: string }[];
}

export type GitOperationPatch = Partial<
  Pick<
    GitOperationRecord,
    "status" | "resultSha" | "resultUrl" | "prNumber" | "error" | "completedAt" | "branch" | "expectedHead"
  >
> & {
  steps?: GitOperationStep[];
};

/**
 * Git 操作记录:持久化为一个小 JSON 数组,进程异常退出后把 running
 * 记录标记为 unconfirmed,供界面提示用户核对结果。
 */
export class GitOperationLog {
  private readonly filePath: string | null;
  private records: GitOperationRecord[] = [];

  constructor(filePath: string | null) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (!this.filePath) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch {
      // 文件不存在或损坏时从空记录开始。
      return;
    }
    if (!Array.isArray(parsed)) return;
    const records = parsed.filter(isOperationRecord);
    let repaired = records.length !== parsed.length;
    for (const record of records) {
      if (record.status === "running") {
        record.status = "unconfirmed";
        record.error = "应用在操作完成前退出，结果需要核对";
        record.completedAt = Date.now();
        repaired = true;
      }
    }
    this.records = records;
    this.prune();
    if (repaired) this.persist();
  }

  begin(input: GitOperationBeginInput): GitOperationRecord {
    const record: GitOperationRecord = {
      id: randomUUID(),
      type: input.type,
      workspace: input.workspace,
      repoRoot: input.repoRoot,
      branch: input.branch,
      expectedHead: input.expectedHead,
      status: "running",
      steps: input.steps.map((step) => ({
        id: step.id,
        label: step.label,
        status: "pending",
        detail: null,
      })),
      startedAt: Date.now(),
      completedAt: null,
      resultSha: null,
      resultUrl: null,
      prNumber: null,
      error: null,
    };
    this.records.unshift(record);
    this.prune();
    this.persist();
    return cloneRecord(record);
  }

  update(id: string, patch: GitOperationPatch): GitOperationRecord | null {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) return null;
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.resultSha !== undefined) record.resultSha = patch.resultSha;
    if (patch.resultUrl !== undefined) record.resultUrl = patch.resultUrl;
    if (patch.prNumber !== undefined) record.prNumber = patch.prNumber;
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.completedAt !== undefined) record.completedAt = patch.completedAt;
    if (patch.branch !== undefined) record.branch = patch.branch;
    if (patch.expectedHead !== undefined) record.expectedHead = patch.expectedHead;
    if (patch.steps !== undefined) record.steps = patch.steps.map((step) => ({ ...step }));
    this.persist();
    return cloneRecord(record);
  }

  finish(id: string, patch: GitOperationPatch = {}): GitOperationRecord | null {
    return this.update(id, {
      ...patch,
      completedAt: patch.completedAt ?? Date.now(),
    });
  }

  get(id: string): GitOperationRecord | null {
    const record = this.records.find((entry) => entry.id === id);
    return record ? cloneRecord(record) : null;
  }

  all(): GitOperationRecord[] {
    return this.records.map(cloneRecord);
  }

  snapshot(workspace: string | null, query?: GitOperationQuery | null): GitOperationSnapshot {
    const matches = (record: GitOperationRecord): boolean =>
      workspace === null || record.workspace === workspace;
    const running = this.records
      .filter((record) => record.status === "running" && matches(record))
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(cloneRecord);
    const limit = normalizeLimit(query?.limit);
    const filtered = this.records.filter(
      (record) => record.status !== "running" && matches(record) && matchesQuery(record, query),
    );
    const recent = filtered
      .sort((left, right) => {
        const leftAt = left.completedAt ?? left.startedAt;
        const rightAt = right.completedAt ?? right.startedAt;
        return rightAt - leftAt;
      })
      .slice(0, limit)
      .map(cloneRecord);
    return { running, recent, total: filtered.length };
  }

  private prune(): void {
    while (this.records.length > maxStoredRecords) {
      let oldestIndex = -1;
      let oldestAt = Number.POSITIVE_INFINITY;
      this.records.forEach((record, index) => {
        if (record.status === "running") return;
        const at = record.completedAt ?? record.startedAt;
        if (at <= oldestAt) {
          oldestAt = at;
          oldestIndex = index;
        }
      });
      // 极端情况下没有已完成记录,丢弃最旧的一条以保证上限。
      if (oldestIndex < 0) oldestIndex = this.records.length - 1;
      this.records.splice(oldestIndex, 1);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(this.records), "utf8");
      renameSync(tempPath, this.filePath);
    } catch {
      // 记录持久化失败不应影响 Git 操作本身。
    }
  }
}

function cloneRecord(record: GitOperationRecord): GitOperationRecord {
  return {
    ...record,
    steps: record.steps.map((step) => ({ ...step })),
  };
}

function normalizeLimit(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return maxRecentRecords;
  return Math.max(1, Math.min(maxStoredRecords, Math.floor(value)));
}

/** 按目标、时间与结果检索:文本匹配类型、分支、工作区、SHA、PR 编号、步骤与错误。 */
function matchesQuery(record: GitOperationRecord, query: GitOperationQuery | null | undefined): boolean {
  if (!query) return true;
  if (query.types && query.types.length > 0 && !query.types.includes(record.type)) return false;
  if (query.statuses && query.statuses.length > 0 && !query.statuses.includes(record.status)) return false;
  const at = record.completedAt ?? record.startedAt;
  if (typeof query.since === "number" && at < query.since) return false;
  if (typeof query.until === "number" && at > query.until) return false;
  const text = query.text?.trim().toLowerCase();
  if (!text) return true;
  const haystack = [
    record.type,
    record.branch ?? "",
    record.workspace ?? "",
    record.repoRoot ?? "",
    record.resultSha ?? "",
    record.resultUrl ?? "",
    record.prNumber === null ? "" : `#${record.prNumber}`,
    record.error ?? "",
    ...record.steps.flatMap((step) => [step.label, step.detail ?? ""]),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(text);
}

function isOperationRecord(value: unknown): value is GitOperationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.status === "string" &&
    Array.isArray(record.steps) &&
    typeof record.startedAt === "number"
  );
}

import { parseStoredSummaries, serializeStoredSummaries, type ThinkingSummaryState } from "./thinking-summary";
import { createLogger } from "./logger";

const log = createLogger("thinking-summary");

// 保存格式未变时保持同一个键；提示词更新只影响之后生成的总结。
export const thinkingSummariesStorageKey = "vela.thinkingSummaries";
const legacyStorageKeys = ["vela.thinkingSummaries.v1", "vela.thinkingSummaries.v2"] as const;

/** 首次读取合并旧版本记录，同一段思考优先保留较新版本的总结。 */
export function readThinkingSummaries(storage: Pick<Storage, "getItem" | "setItem">): Record<string, ThinkingSummaryState> {
  const saved = storage.getItem(thinkingSummariesStorageKey);
  if (saved !== null) return parseStoredSummaries(saved);

  let records: Record<string, ThinkingSummaryState> = {};
  for (const key of legacyStorageKeys) {
    records = { ...records, ...parseStoredSummaries(storage.getItem(key)) };
  }
  if (Object.keys(records).length > 0) {
    const serialized = serializeStoredSummaries(records);
    records = parseStoredSummaries(serialized);
    try {
      storage.setItem(thinkingSummariesStorageKey, serialized);
    } catch {
      // 写入失败时本次仍显示历史总结，旧记录保留以便下次重试迁移。
      log.error("failed to migrate thinking summaries");
    }
  }
  return records;
}

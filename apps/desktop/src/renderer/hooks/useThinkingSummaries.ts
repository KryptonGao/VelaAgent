import { uiStorage } from "../ui-storage";
import type { AppLocale } from "@vela/shared";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  ThinkingCompletionTracker,
  parseStoredSummaries,
  serializeStoredSummaries,
  thinkingDigest,
  thinkingSummaryKey,
  type ThinkingSummaryState,
} from "../thinking-summary";
import type { ThinkingSummaryStyle } from "./usePreferences";
import type { UiMessage } from "./useSession";

export interface ThinkingSummariesApi {
  enabled: boolean;
  style: ThinkingSummaryStyle;
  get(messageId: string, text: string): ThinkingSummaryState | undefined;
  request(messageId: string, text: string): void;
}

/** 已完成的总结落盘保存,窗口重开后按思考内容哈希恢复,不再退回“总结”按钮。
 * 键名带版本号:总结提示词改变口径后递增,避免旧的错误总结继续命中缓存。 */
const storageKey = "vela.thinkingSummaries.v2";

function readStoredSummaries(): Record<string, ThinkingSummaryState> {
  try {
    return parseStoredSummaries(uiStorage.getItem(storageKey));
  } catch {
    return {};
  }
}

function writeStoredSummaries(records: Record<string, ThinkingSummaryState>) {
  try {
    uiStorage.setItem(storageKey, serializeStoredSummaries(records));
  } catch {
    console.error("[vela] Failed to save thinking summaries");
  }
}

export function useThinkingSummaries({ conversationId, messages, streaming, modelReady, enabled, style = "inline", locale }: {
  conversationId: string | null;
  messages: UiMessage[];
  streaming: boolean;
  modelReady: boolean;
  enabled: boolean;
  style?: ThinkingSummaryStyle;
  locale: AppLocale;
}): ThinkingSummariesApi {
  const [records, setRecords] = useState<Record<string, ThinkingSummaryState>>(readStoredSummaries);
  const recordsRef = useRef(records);
  // 同一段思考内容只算一次哈希;流式增长后文本变化再重算。
  const digests = useRef(new Map<string, { text: string; digest: string }>());
  const tracker = useRef(new ThinkingCompletionTracker());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const digestFor = useCallback((messageId: string, text: string) => {
    const scope = `${conversationId ?? ""}\u0000${messageId}`;
    const cached = digests.current.get(scope);
    if (cached?.text === text) return cached.digest;
    const digest = thinkingDigest(text);
    digests.current.set(scope, { text, digest });
    return digest;
  }, [conversationId]);

  const request = useCallback((messageId: string, text: string) => {
    const api = window.vela;
    if (!enabled || !conversationId || !api || !text.trim()) return;
    const key = thinkingSummaryKey(conversationId, locale, digestFor(messageId, text));
    const existing = recordsRef.current[key];
    if (existing && existing.status !== "error") return;
    const pending: ThinkingSummaryState = { status: "pending" };
    const save = (value: ThinkingSummaryState) => {
      if (!mounted.current) return;
      recordsRef.current = { ...recordsRef.current, [key]: value };
      setRecords(recordsRef.current);
      if (value.status === "done") writeStoredSummaries(recordsRef.current);
    };
    save(pending);
    void api.summarizeThinking({ conversationId, text, locale }).then(
      (summary) => {
        if (recordsRef.current[key] === pending) save({ status: "done", text: summary });
      },
      (error: unknown) => {
        if (recordsRef.current[key] === pending) save({
          status: "error",
          error: error instanceof Error ? error.message : "无法生成思考总结",
        });
      },
    );
  }, [conversationId, enabled, locale, digestFor]);

  useEffect(() => {
    if (!conversationId) return;
    const completed = tracker.current.observe(conversationId, messages, streaming, enabled);
    if (modelReady) for (const message of completed) request(message.id, message.thinking);
  }, [conversationId, messages, streaming, enabled, modelReady, request]);

  const get = useCallback((messageId: string, text: string) => {
    if (!conversationId) return undefined;
    return records[thinkingSummaryKey(conversationId, locale, digestFor(messageId, text))];
  }, [conversationId, locale, records, digestFor]);

  return useMemo(() => ({ enabled, style, get, request }), [enabled, style, get, request]);
}

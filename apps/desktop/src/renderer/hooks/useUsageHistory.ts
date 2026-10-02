import { useEffect, useMemo, useState } from "react";
import type { ConversationSummary, TraceSnapshot } from "@vela/shared";
import { emptyTrace, mergeTrace, type TraceState } from "../components/trace/trace-model";
import { collectUsageRequests } from "../components/usage/usage-model";

/** Reuse persisted traces and their live updates; never load response payloads into this page. */
export function useUsageHistory(conversations: ConversationSummary[]) {
  const scope = JSON.stringify(conversations.map(conversation => conversation.id).sort());
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<{ scope: string; traces: Record<string, TraceState>; loading: boolean; failed: number }>({
    scope: "", traces: {}, loading: true, failed: 0,
  });
  useEffect(() => {
    const api = window.vela;
    const ids: string[] = JSON.parse(scope);
    const wanted = new Set(ids);
    let alive = true;
    setHistory({ scope, traces: {}, loading: Boolean(api && ids.length), failed: 0 });
    if (!api || ids.length === 0) return;
    const merge = (id: string, snapshot: TraceSnapshot & { reset?: boolean }) => {
      if (!alive) return;
      setHistory(current => ({ ...current, traces: { ...current.traces,
        [id]: mergeTrace(current.traces[id] ?? emptyTrace, { ...snapshot, nodes: [] }),
      } }));
    };
    const unsubscribe = api.onEvent(event => {
      if (event.type === "trace" && wanted.has(event.conversationId)) merge(event.conversationId, event);
    });
    let cursor = 0;
    const worker = async () => {
      while (alive && cursor < ids.length) {
        const id = ids[cursor++]!;
        try {
          merge(id, await api.getTrace(id));
        } catch {
          if (alive) setHistory(current => ({ ...current, failed: current.failed + 1 }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker)).then(() => {
      if (alive) setHistory(current => ({ ...current, loading: false }));
    });
    return () => { alive = false; unsubscribe(); };
  }, [scope, revision]);
  const requests = useMemo(() => history.scope === scope
    ? collectUsageRequests(Object.entries(history.traces).map(([id, trace]) => ({ id, requests: trace.requests })))
    : [], [history.traces, history.scope, scope]);
  const summaryRequests = useMemo(() => history.scope === scope
    ? Object.entries(history.traces).flatMap(([id, trace]) =>
        trace.summaries.map(summary => ({ ...summary, id: `${id}/${summary.id}` })))
    : [], [history.traces, history.scope, scope]);
  return {
    requests,
    summaryRequests,
    loading: history.scope !== scope || history.loading,
    failed: history.scope === scope ? history.failed : 0,
    warnings: history.scope === scope ? Object.values(history.traces).filter(trace => trace.warning).length : 0,
    refresh: () => setRevision(value => value + 1),
  };
}

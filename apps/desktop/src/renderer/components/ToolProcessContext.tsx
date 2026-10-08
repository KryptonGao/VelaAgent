import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from "react";
import type { ToolTrace } from "@vela/shared";
import { useTrace } from "../hooks/useTrace";
import { trf } from "../locale";
import { formatDuration, indexToolDurations, readToolDuration, readTurnDuration, type ToolDurationSource } from "./tool-duration";
import type { ToolFoldStore } from "./tool-fold-state";

const ToolProcessContext = createContext<{ store: ToolFoldStore; timings: Map<string, ToolDurationSource> } | null>(null);
const noopSubscribe = () => () => {};

/** Session-owned state; useTrace hides stale snapshots during a scope change. */
export function ToolProcessProvider({ sessionId, store, compact, enabled = true, children }: {
  sessionId: string | null; store: ToolFoldStore; compact: boolean; enabled?: boolean; children: ReactNode;
}) {
  // Disabled means no trace read and no persisted fold state; rows fall back to local state.
  const { trace } = useTrace(enabled && compact ? sessionId : null);
  const timings = useMemo(() => indexToolDurations(trace.nodes), [trace.nodes]);
  const value = useMemo(() => enabled ? { store, timings } : null, [enabled, store, timings]);
  useEffect(() => {
    const flush = () => store.flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [store]);
  return <ToolProcessContext.Provider value={value}>{children}</ToolProcessContext.Provider>;
}

/** Card mode and calls without an ID keep their existing local state. */
export function useToolExpanded(id: string | null, compact = true, fallback = false): [boolean, (value: SetStateAction<boolean>) => void] {
  const context = useContext(ToolProcessContext);
  const store = compact && id ? context?.store : undefined;
  const [local, setLocal] = useState(fallback);
  useEffect(() => { setLocal(fallback); }, [context?.store, id, fallback]);
  const snapshot = useCallback(() => store?.peekExpanded(id, fallback) ?? local, [store, id, fallback, local]);
  const expanded = useSyncExternalStore(store?.subscribe ?? noopSubscribe, snapshot, snapshot);
  useEffect(() => { store?.isExpanded(id, fallback); }, [store, id, fallback, expanded]);
  const setExpanded = useCallback((value: SetStateAction<boolean>) => {
    if (store) store.setExpanded(id, typeof value === "function" ? value(store.peekExpanded(id, fallback)) : value);
    else setLocal(value);
  }, [store, id, fallback]);
  return [expanded, setExpanded];
}

export function useToolsDuration(tools: readonly ToolTrace[]): number | null {
  const context = useContext(ToolProcessContext);
  return readTurnDuration(tools.map(tool => tool.status === "running" ? tool : context?.timings.get(tool.id) ?? tool));
}

export function ToolDurationLabel({ tool }: { tool: ToolTrace }) {
  const context = useContext(ToolProcessContext);
  if (!context) return null;
  const duration = tool.status === "running" ? null : readToolDuration(context.timings.get(tool.id) ?? tool);
  return <DurationLabel duration={duration} />;
}

/** Whether the optional duration labels and fold memory are active for this subtree. */
export function useToolProcessDetails(): boolean {
  return useContext(ToolProcessContext) !== null;
}

export function DurationLabel({ duration }: { duration: number | null }) {
  const label = duration === null ? null : formatDuration(duration);
  return <span className="tool-duration" aria-hidden={label === null} aria-label={label ? trf("耗时 {0}", "Duration {0}", label) : undefined}>
    {label ? `· ${label}` : null}
  </span>;
}

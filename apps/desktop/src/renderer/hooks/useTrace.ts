import { useEffect, useState } from "react";
import {
  emptyTrace,
  mergeTrace,
  type TraceState,
} from "../components/trace/trace-model";
export function useTrace(conversationId: string | null) {
  const [trace, setTrace] = useState<TraceState>(emptyTrace);
  const [scope, setScope] = useState(conversationId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setScope(conversationId);
    setTrace(emptyTrace);
    setLoading(true);
    setError(null);
    const api = window.vela;
    if (!api || !conversationId) {
      setLoading(false);
      return;
    }
    let alive = true;
    const unsub = api.onEvent((event) => {
      if (
        alive &&
        event.type === "trace" &&
        event.conversationId === conversationId
      )
        setTrace((current) => mergeTrace(current, event));
    });
    void api
      .getTrace(conversationId)
      .then((snapshot) => {
        if (alive) {
          setTrace((current) => mergeTrace(current, snapshot));
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      unsub();
    };
  }, [conversationId]);
  // The render before the effect runs must not expose the previous chat's timings.
  return { trace: scope === conversationId ? trace : emptyTrace, loading: scope !== conversationId || loading, error: scope === conversationId ? error : null };
}

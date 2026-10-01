import { useCallback, useLayoutEffect, useRef } from "react";

/** Merge message commits and resize notifications into one layout task per frame. */
export function useFrameTask(task: () => void) {
  const latest = useRef(task);
  const frame = useRef<number | null>(null);
  useLayoutEffect(() => { latest.current = task; });
  useLayoutEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  return useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      latest.current();
    });
  }, []);
}

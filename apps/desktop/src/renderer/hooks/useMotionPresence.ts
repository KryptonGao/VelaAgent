import { useLayoutEffect, useState, useSyncExternalStore } from "react";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(callback: () => void) {
  const media = window.matchMedia(reducedMotionQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches, () => false);
}

/** Retain an exiting surface, cancel its removal on reopen, and skip delays for reduced motion. */
export function useMotionPresence(present: boolean, exitMs: number) {
  const reducedMotion = useReducedMotion();
  const [retained, setRetained] = useState(present);
  if (present && !retained) setRetained(true);

  useLayoutEffect(() => {
    if (present || !retained) return;
    if (reducedMotion) {
      setRetained(false);
      return;
    }
    // Transition events normally finish first; cover removed styles and interrupted transitions.
    const timer = window.setTimeout(() => setRetained(false), exitMs + 32);
    return () => window.clearTimeout(timer);
  }, [present, retained, reducedMotion, exitMs]);

  return {
    reducedMotion,
    mounted: present || (retained && !reducedMotion),
    closing: !present,
    finishExit: () => { if (!present) setRetained(false); },
  };
}

import { useRef, type ReactNode } from "react";
import { useMotionPresence } from "../hooks/useMotionPresence";

/** Defer expensive children until opened; freeze during exit, then release them. */
export function LazyMount({ open, children, exitMs = 280 }: {
  open: boolean;
  children: () => ReactNode;
  exitMs?: number;
}) {
  const presence = useMotionPresence(open, exitMs);
  const frozen = useRef<ReactNode>(null);
  if (open) frozen.current = children();
  if (!presence.mounted) {
    frozen.current = null;
    return null;
  }
  return <>{frozen.current}</>;
}

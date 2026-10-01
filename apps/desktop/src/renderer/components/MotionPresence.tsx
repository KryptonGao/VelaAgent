import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type TransitionEvent } from "react";
import { useMotionPresence } from "../hooks/useMotionPresence";

/** One lifetime for menus, including composite children and native top-layer popovers. */
export function PopoverPresence({ present, children }: { present: boolean; children: ReactNode }) {
  const presence = useMotionPresence(present, 110);
  const frozen = useRef(children);
  if (present) frozen.current = children;
  if (!presence.mounted) return null;

  return <div className={`popover-presence${presence.closing ? " is-closing" : ""}`}
    inert={presence.closing} aria-hidden={presence.closing || undefined}
    onTransitionEnd={(event) => {
      if (event.propertyName === "opacity" && event.target instanceof HTMLElement &&
        event.target.matches(".dock-popover, .skill-menu, .context-usage-popover")) presence.finishExit();
    }}>
    {present ? children : frozen.current}
  </div>;
}

export function ScreenPresence({ present, children, className }: {
  present: boolean; children: ReactNode; className: string;
}) {
  const presence = useMotionPresence(present, 140);
  const frozen = useRef(children);
  if (present) frozen.current = children;
  if (!presence.mounted) return null;
  return <div className={`app-screen ${className}${presence.closing ? " is-closing" : ""}`}
    inert={presence.closing} aria-hidden={presence.closing || undefined}
    onTransitionEnd={(event) => {
      if (event.target === event.currentTarget && event.propertyName === "opacity") presence.finishExit();
    }}>
    {present ? children : frozen.current}
  </div>;
}

/** Keep inactive tab state mounted, but hide its box once the crossfade finishes. */
export function WorkbenchTabPanel({ hidden = false, swapKey, children, ...props }:
  HTMLAttributes<HTMLDivElement> & { swapKey?: string }) {
  const presence = useMotionPresence(!hidden, 120);
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef({ hidden, swapKey });
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { hidden, swapKey };
    // File tabs share one preview instance; animate its content without remounting the editor.
    if (hidden || old.hidden || old.swapKey === swapKey || presence.reducedMotion) return;
    const animation = ref.current?.animate([
      { opacity: 0, transform: "translateY(2px)" },
      { opacity: 1, transform: "none" },
    ], { duration: 120, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    return () => animation?.cancel();
  }, [hidden, swapKey, presence.reducedMotion]);
  function onTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && event.propertyName === "opacity") presence.finishExit();
  }
  return <div {...props} ref={ref} hidden={!presence.mounted}
    className={`workbench-tabpanel${hidden ? " is-inactive" : ""}`}
    inert={hidden} aria-hidden={hidden || undefined} onTransitionEnd={onTransitionEnd}>
    {children}
  </div>;
}

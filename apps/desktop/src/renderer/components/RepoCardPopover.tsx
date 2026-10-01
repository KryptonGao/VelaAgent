import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { positionRepoPopover } from "./popover-position";

/** The native top layer escapes sidebar/card clipping while retaining inherited theme tokens. */
export function RepoCardPopover({ anchor, className, label, children }: {
  anchor: RefObject<HTMLElement | null>;
  className: string;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popover = ref.current;
    const trigger = anchor.current;
    if (!popover || !trigger) return;
    popover.showPopover();
    const update = () => {
      const position = positionRepoPopover(trigger.getBoundingClientRect(),
        { width: popover.offsetWidth, height: Math.min(380, popover.scrollHeight + 2) },
        { width: window.innerWidth, height: window.innerHeight });
      popover.style.left = `${position.left}px`;
      popover.style.top = `${position.top}px`;
      popover.style.maxHeight = `${position.maxHeight}px`;
      popover.dataset.side = position.side;
      const originX = Math.max(0, Math.min(popover.offsetWidth,
        (trigger.getBoundingClientRect().left + trigger.getBoundingClientRect().right) / 2 - position.left));
      popover.style.transformOrigin = `${originX}px ${position.side === "above" ? "100%" : "0%"}`;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(trigger);
    observer.observe(popover);
    const owner = trigger.closest(".main-chat-view, .sidebar-right");
    if (owner) observer.observe(owner);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (popover.matches(":popover-open")) popover.hidePopover();
    };
  }, [anchor]);

  return (
    <div ref={ref} popover="manual" role="dialog" aria-label={label}
      className={`dock-popover composer-popover repo-card-popover ${className}`}>
      {children}
    </div>
  );
}

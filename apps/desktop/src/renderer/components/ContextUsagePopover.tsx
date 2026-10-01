import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ContextUsage } from "@vela/shared";
import { tr } from "../locale";
import { ContextUsageCard } from "./ContextPanel";
import { useMotionPresence } from "../hooks/useMotionPresence";
import { CloseIcon } from "./icons";
import { positionContextPopover } from "./popover-position";

export function ContextUsageTrigger({ usage, high, children }: {
  usage: ContextUsage | null | undefined;
  high: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, finishExit } = useMotionPresence(open, 110);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const id = useId();

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!mounted) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const update = () => {
      const position = positionContextPopover(trigger.getBoundingClientRect(), { width: popover.offsetWidth, height: popover.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight });
      popover.style.left = `${position.left}px`;
      popover.style.top = `${position.top}px`;
      popover.style.transformOrigin = `${position.originX}px ${position.side === "above" ? "100%" : "0%"}`;
      popover.dataset.side = position.side;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(trigger);
    observer.observe(popover);
    const chat = trigger.closest(".main-chat-view");
    if (chat) observer.observe(chat);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [mounted]);

  useLayoutEffect(() => {
    if (!open) return;
    popoverRef.current?.focus({ preventScroll: true });
    const outside = (target: EventTarget | null) => target instanceof Node
      && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target);
    const pointerDown = (event: Event) => { if (outside(event.target)) close(); };
    const focusIn = (event: FocusEvent) => { if (outside(event.target)) close(); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("click", pointerDown);
    window.addEventListener("focusin", focusIn);
    window.addEventListener("keydown", keyDown, true);
    return () => {
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("click", pointerDown);
      window.removeEventListener("focusin", focusIn);
      window.removeEventListener("keydown", keyDown, true);
    };
  }, [open]);

  return <>
    <button ref={triggerRef} type="button" className={`composer-stat composer-stat-context context-usage-trigger${high ? " high" : ""}`}
      aria-label={tr("查看上下文用量", "View context usage")} title={tr("查看上下文用量", "View context usage")}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={mounted ? id : undefined}
      onClick={() => { if (open) close(); else setOpen(true); }}>
      {children}
    </button>
    {mounted ? createPortal(
      <div id={id} ref={popoverRef} role="dialog" tabIndex={-1} aria-label={tr("上下文用量", "Context usage")}
        className={`context-usage-popover${open ? "" : " is-closing"}`} inert={!open ? true : undefined} aria-hidden={!open || undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "opacity") finishExit();
        }}>
        <button type="button" className="context-popover-close" onClick={() => close(true)}
          aria-label={tr("关闭上下文用量", "Close context usage")} title={tr("关闭", "Close")}><CloseIcon size={13} /></button>
        <ContextUsageCard context={usage} details />
      </div>, document.body,
    ) : null}
  </>;
}

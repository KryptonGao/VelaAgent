import { useEffect, useRef, useState, type AnimationEvent, type ReactNode, type TransitionEvent } from "react";
import { createPortal } from "react-dom";

/**
 * 离开时保持挂载,等透明度过渡结束再卸载。
 * 进入的一屏留在文档流里,离开的一屏绝对定位盖在上面淡出。
 */
export function Presence({
  present,
  className,
  children,
  keepMounted = false,
}: {
  present: boolean;
  className?: string;
  children: ReactNode;
  /** Retain expensive guest resources while the containing view is hidden. */
  keepMounted?: boolean;
}) {
  const [mounted, setMounted] = useState(present);
  const [shown, setShown] = useState(present);

  if (present && !mounted) {
    setMounted(true);
    setShown(false);
  }

  useEffect(() => {
    if (!present) {
      setShown(false);
      return;
    }
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [present]);

  useEffect(() => {
    if (present || !mounted || keepMounted) return;
    const timer = window.setTimeout(() => setMounted(false), 450);
    return () => window.clearTimeout(timer);
  }, [present, mounted, keepMounted]);

  if (!mounted) return null;

  function onTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== "opacity") return;
    if (!present && !keepMounted) setMounted(false);
  }

  const hidden = !shown || !present;
  return (
    <div
      className={[className, hidden ? "is-hidden" : "", !present ? "is-overlay" : ""].filter(Boolean).join(" ")}
      onTransitionEnd={onTransitionEnd}
      inert={keepMounted && !present}
      aria-hidden={(keepMounted && !present) || undefined}
    >
      {children}
    </div>
  );
}

/**
 * 对话框进出场。进入靠 CSS 动画,退出在动画结束前保持挂载。
 * 子节点需要带 `.sheet-backdrop`,本组件负责挂到 document.body。
 */
export function SheetPresence({ present, children }: { present: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(present);
  const [leaving, setLeaving] = useState(false);
  const frozen = useRef(children);
  if (present) frozen.current = children;

  if (present && !mounted) {
    setMounted(true);
    setLeaving(false);
  } else if (present && leaving) {
    setLeaving(false);
  } else if (!present && mounted && !leaving) {
    setLeaving(true);
  }

  useEffect(() => {
    if (!leaving || present) return;
    const timer = window.setTimeout(() => setMounted(false), 450);
    return () => window.clearTimeout(timer);
  }, [leaving, present]);

  if (!mounted) return null;

  function onAnimationEnd(event: AnimationEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.classList?.contains("sheet-backdrop")) return;
    if (event.animationName !== "sheet-backdrop-out") return;
    setMounted(false);
  }

  return createPortal(
    <div className={`sheet-presence${leaving && !present ? " is-leaving" : ""}`} onAnimationEnd={onAnimationEnd}>
      {present ? children : frozen.current}
    </div>,
    document.body,
  );
}

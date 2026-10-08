import { useEffect, type RefObject } from "react";

const visibleMs = 1000;

/** 滚动时给容器加 is-scrolling,停止约 1 秒后移除;配合 .autohide-scrollbar 让滚动条只在滚动时显现。 */
export function useAutoHideScrollbar(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    let hideTimer: number | undefined;
    const show = () => {
      scroller.classList.add("is-scrolling");
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => scroller.classList.remove("is-scrolling"), visibleMs);
    };
    scroller.addEventListener("scroll", show, { passive: true });
    return () => {
      window.clearTimeout(hideTimer);
      scroller.classList.remove("is-scrolling");
      scroller.removeEventListener("scroll", show);
    };
  }, [ref]);
}

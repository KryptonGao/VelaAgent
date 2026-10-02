import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useReducedMotion } from "../hooks/useMotionPresence";

const TAB_SELECTOR = "[data-tab-key]";

interface SlidingTabIndicatorOptions {
  /** 当前激活项的 key,需与按钮上的 data-tab-key 对应。 */
  activeKey: string;
  /** 悬停激活项时横线向左右两侧各延伸的像素。 */
  expand?: number;
}

/**
 * 共享的滑动下划线 indicator。整条横线是一个绝对定位元素,始终跟随 activeKey:
 * - 切换激活项时补间 translateX/width,平滑滑动并伸缩;
 * - 悬停激活项时向两侧展开,鼠标移开后收回;
 * - 悬停未激活项不会让它移动或展开。
 *
 * 用法:把返回的 navRef / onPointerMove / onPointerLeave 挂到 `position: relative` 的 nav,
 * 每个按钮用 registerTab(key) 作 ref 并带 data-tab-key,再把 indicator 放进 nav。
 */
export function useSlidingTabIndicator({ activeKey, expand = 6 }: SlidingTabIndicatorOptions) {
  const navRef = useRef<HTMLElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const buttonsRef = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const [hovered, setHovered] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();

  const expanded = hovered === activeKey;
  const activeKeyRef = useRef(activeKey);
  const expandedRef = useRef(expanded);
  const expandRef = useRef(expand);
  activeKeyRef.current = activeKey;
  expandedRef.current = expanded;
  expandRef.current = expand;

  const measure = useCallback((animate: boolean) => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    const button = buttonsRef.current.get(activeKeyRef.current);
    if (!nav || !indicator || !button) return;
    const navRect = nav.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const pad = expandedRef.current ? expandRef.current : 0;
    const width = `${(rect.width + pad * 2).toFixed(2)}px`;
    const transform = `translateX(${(rect.left - navRect.left + nav.scrollLeft - pad).toFixed(2)}px)`;
    if (animate && !reducedMotion) {
      indicator.style.width = width;
      indicator.style.transform = transform;
      return;
    }
    // 首次挂载或窗口/字体/语言变化时直接落位,不让布局抖动被补间放大。
    indicator.style.transition = "none";
    indicator.style.width = width;
    indicator.style.transform = transform;
    void indicator.offsetWidth;
    indicator.style.transition = "";
  }, [reducedMotion]);

  const mounted = useRef(false);
  useLayoutEffect(() => {
    const animate = mounted.current;
    mounted.current = true;
    measure(animate);
  }, [activeKey, expanded, measure]);

  // 文字宽度会随语言/字体变化,用 ResizeObserver 兜住这些没有 activeKey 变化的场景。
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(nav);
    buttonsRef.current.forEach((button) => observer.observe(button));
    const remeasure = () => measure(false);
    window.addEventListener("resize", remeasure);
    nav.addEventListener("scroll", remeasure, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
      nav.removeEventListener("scroll", remeasure);
    };
  }, [measure]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(TAB_SELECTOR);
    setHovered(button?.dataset.tabKey ?? null);
  }, []);

  const onPointerLeave = useCallback(() => setHovered(null), []);

  const registerTab = useCallback((key: string) => {
    let callback = refCallbacks.current.get(key);
    if (!callback) {
      callback = (element) => {
        if (element) buttonsRef.current.set(key, element);
        else buttonsRef.current.delete(key);
      };
      refCallbacks.current.set(key, callback);
    }
    return callback;
  }, []);

  const indicator: ReactNode = <span ref={indicatorRef} className="tab-indicator" aria-hidden="true" />;

  return { navRef, onPointerMove, onPointerLeave, registerTab, indicator };
}

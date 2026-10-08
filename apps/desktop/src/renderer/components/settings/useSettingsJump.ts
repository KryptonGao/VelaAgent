import { useEffect, type RefObject } from "react";
import { useReducedMotion } from "../../hooks/useMotionPresence";

export interface SettingsJumpTarget {
  id: string;
  /** 同一目标重复点击时也要重新触发。 */
  nonce: number;
}

const maxWaitMs = 1200;
const flashMs = 1600;

function visible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

/**
 * 切到目标页后,等设置项挂载(MCP、记忆等页面是异步加载的),
 * 展开祖先 <details>,滚动到视口中央并短暂高亮。找不到就停在页面顶部,不报错。
 */
export function useSettingsJump(container: RefObject<HTMLElement | null>, target: SettingsJumpTarget | null, page: string) {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!target) return;
    const root = container.current;
    if (!root) return;
    const started = performance.now();
    let frame = 0;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    let flashed: HTMLElement | null = null;
    const attempt = () => {
      const element = [...root.querySelectorAll<HTMLElement>("[data-setting-id]")]
        .find((item) => item.dataset.settingId === target.id);
      if (element) {
        for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
          if (node instanceof HTMLDetailsElement) node.open = true;
        }
        if (visible(element)) {
          const behavior = reduced ? "auto" : "smooth";
          if (root.scrollHeight > root.clientHeight + 1) {
            // 只滚设置内容区本身;scrollIntoView 会连带滚动 overflow 为 hidden 的祖先,把整个设置页顶歪。
            const rootRect = root.getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            const offset = root.scrollTop + (rect.top - rootRect.top);
            const centered = offset - (root.clientHeight - rect.height) / 2;
            root.scrollTo({ top: Math.max(0, rect.height > root.clientHeight ? offset - 24 : centered), behavior });
          } else {
            // 内容区自己不滚动(嵌在没有限高的预览容器里)时,交给浏览器处理。
            element.scrollIntoView({ block: "center", behavior });
          }
          element.classList.remove("setting-flash");
          // 重新触发动画
          void element.offsetWidth;
          element.classList.add("setting-flash");
          flashed = element;
          flashTimer = setTimeout(() => element.classList.remove("setting-flash"), flashMs);
          return;
        }
      }
      if (performance.now() - started < maxWaitMs) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => {
      cancelAnimationFrame(frame);
      if (flashTimer) clearTimeout(flashTimer);
      flashed?.classList.remove("setting-flash");
    };
  }, [container, target, page, reduced]);
}

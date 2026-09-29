import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampSidebarWidth,
  defaultSidebarWidths,
  parseSidebarWidths,
  resolveSidebarWidths,
  sidebarTargets,
  sidebarWidthsStorageKey,
  widthFromPointer,
  type SidebarTarget,
  type SidebarWidths,
} from "../sidebar-resize";

/** 三种宽度状态各自对应的根节点 CSS 变量,样式表直接读它们。 */
const cssVariables: Record<SidebarTarget, string> = {
  left: "--sidebar-left-width",
  right: "--sidebar-right-width",
  preview: "--sidebar-right-preview-width",
  agent: "--agent-pane-width",
};

export interface SidebarResize {
  widths: SidebarWidths;
  startResize: (target: SidebarTarget, event: React.PointerEvent<HTMLElement>) => void;
  nudge: (target: SidebarTarget, delta: number) => void;
  reset: (target: SidebarTarget) => void;
}

function readStoredWidths(): SidebarWidths {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(sidebarWidthsStorageKey);
  } catch {
    // 隐私模式读不到本地存储时用默认宽度。
  }
  return resolveSidebarWidths(parseSidebarWidths(raw), window.innerWidth);
}

function clampFor(target: SidebarTarget, width: number, current: SidebarWidths): number {
  const viewport = window.innerWidth;
  // 子代理面板夹在对话区与右栏之间，两侧已占用的宽度都要扣掉。
  const reserved =
    target === "left" ? 0 : target === "agent" ? current.left + current.right : current.left;
  return clampSidebarWidth(target, width, viewport, reserved);
}

export function useSidebarResize(): SidebarResize {
  const [widths, setWidths] = useState<SidebarWidths>(readStoredWidths);
  const widthsRef = useRef(widths);
  // 拖拽中挂起的收尾函数:组件在拖动过程中被卸载时用它解开监听和指针捕获。
  const stopRef = useRef<(() => void) | null>(null);

  const writeVariable = useCallback((target: SidebarTarget, width: number) => {
    document.documentElement.style.setProperty(cssVariables[target], `${width}px`);
  }, []);

  const commit = useCallback(
    (target: SidebarTarget, width: number) => {
      const next = { ...widthsRef.current, [target]: width };
      widthsRef.current = next;
      // 状态只在拖拽结束、键盘微调和双击复位时变化,顺带写入 CSS 变量。
      setWidths(next);
    },
    [],
  );

  useEffect(() => {
    for (const target of sidebarTargets) {
      writeVariable(target, widths[target]);
    }
  }, [widths, writeVariable]);

  useEffect(() => {
    try {
      localStorage.setItem(sidebarWidthsStorageKey, JSON.stringify(widths));
    } catch {
      // 存不下时保留本次运行的选择。
    }
  }, [widths]);

  useEffect(() => () => stopRef.current?.(), []);

  const startResize = useCallback(
    (target: SidebarTarget, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || stopRef.current) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const root = document.documentElement;
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // 指针已经释放时继续监听窗口事件即可。
      }
      // 拖拽期间关掉宽度过渡并锁定光标,拖动才跟手。
      root.dataset.resizing = "true";

      // 子代理面板不靠窗口边缘，用指针位移换算宽度；其余侧栏量到窗口边。
      const startX = event.clientX;
      const startWidth = widthsRef.current[target];
      const apply = (clientX: number) => {
        const viewport = window.innerWidth;
        const current = widthsRef.current;
        const raw = target === "agent"
          ? startWidth - (clientX - startX)
          : widthFromPointer(target, clientX, viewport);
        const next = clampFor(target, raw, current);
        if (next === current[target]) return;
        // 拖拽过程直接改 CSS 变量,避免每帧重渲染聊天区。
        widthsRef.current = { ...current, [target]: next };
        writeVariable(target, next);
      };

      const finish = (finishEvent: PointerEvent) => {
        if (finishEvent.pointerId !== pointerId) return;
        stopRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        delete root.dataset.resizing;
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // 指针已经释放,忽略。
        }
        commit(target, widthsRef.current[target]);
      };
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        apply(moveEvent.clientX);
      };

      stopRef.current = () => {
        stopRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        delete root.dataset.resizing;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [commit, writeVariable],
  );

  const nudge = useCallback(
    (target: SidebarTarget, delta: number) => {
      const current = widthsRef.current;
      commit(target, clampFor(target, current[target] + delta, current));
    },
    [commit],
  );

  const reset = useCallback(
    (target: SidebarTarget) => {
      const current = widthsRef.current;
      commit(target, clampFor(target, defaultSidebarWidths[target], current));
    },
    [commit],
  );

  return { widths, startResize, nudge, reset };
}

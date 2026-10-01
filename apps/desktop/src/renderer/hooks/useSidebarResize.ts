import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampSidebarWidth,
  defaultSidebarWidths,
  parseSidebarWidths,
  resolveSidebarWidths,
  sidebarTargets,
  sidebarWidthRange,
  sidebarWidthsStorageKey,
  widthFromPointer,
  widthFromPointerDelta,
  type SidebarTarget,
  type SidebarWidths,
} from "../sidebar-resize";

/** 各宽度状态对应的根节点 CSS 变量。 */
const cssVariables: Record<SidebarTarget, string> = {
  left: "--sidebar-left-width",
  right: "--sidebar-right-width",
  workbench: "--workbench-width",
};

export interface SidebarResize {
  widths: SidebarWidths;
  workbenchDocked?: boolean;
  startResize: (target: SidebarTarget, event: React.PointerEvent<HTMLElement>) => void;
  nudge: (target: SidebarTarget, delta: number) => void;
  reset: (target: SidebarTarget) => void;
}

function readStoredWidths(leftPanelOpen: boolean, rightPanelOpen: boolean): SidebarWidths {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(sidebarWidthsStorageKey);
  } catch {
    // 隐私模式读不到本地存储时用默认宽度。
  }
  const preferred = parseSidebarWidths(raw);
  const resolved = resolveSidebarWidths(preferred, window.innerWidth, rightPanelOpen, leftPanelOpen);
  // Keep the user's preferred workbench width across responsive layouts. CSS
  // applies the current available width, while drag limits use that same cap.
  return {
    ...resolved,
    workbench: Math.round(Math.min(
      Math.max(preferred.workbench, sidebarWidthRange.workbench.min),
      sidebarWidthRange.workbench.max,
    )),
  };
}

function clampFor(
  target: SidebarTarget,
  width: number,
  current: SidebarWidths,
  leftPanelOpen: boolean,
  rightPanelOpen: boolean,
  workbenchDocked: boolean,
): number {
  const viewport = window.innerWidth;
  // 折叠侧栏的有效宽度为 0；展开时才占用可用空间。
  const leftWidth = leftPanelOpen ? current.left : 0;
  const reserved = target === "left" ? 0 : target === "workbench"
    ? leftWidth + (rightPanelOpen ? current.right : 0)
    : leftWidth;
  return clampSidebarWidth(target, width, viewport, reserved, workbenchDocked);
}

export function useSidebarResize(leftPanelOpen = true, rightPanelOpen = true, workbenchDocked = false): SidebarResize {
  const [widths, setWidths] = useState<SidebarWidths>(() => readStoredWidths(leftPanelOpen, rightPanelOpen));
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

      // 工作面板从 ContextPanel 左缘向左扩展，按指针位移换算宽度。
      const startX = event.clientX;
      const renderedWidth = target === "workbench"
        ? handle.parentElement?.getBoundingClientRect().width
        : undefined;
      const startWidth = renderedWidth && renderedWidth > 0 ? renderedWidth : widthsRef.current[target];
      let lastAppliedWidth = startWidth;
      const apply = (clientX: number) => {
        const viewport = window.innerWidth;
        const current = widthsRef.current;
        const raw = target === "workbench"
          ? widthFromPointerDelta(startWidth, startX, clientX)
          : widthFromPointer(target, clientX, viewport);
        const next = clampFor(target, raw, current, leftPanelOpen, rightPanelOpen, workbenchDocked);
        if (next === lastAppliedWidth) return;
        // 拖拽过程直接改 CSS 变量,避免每帧重渲染聊天区。
        widthsRef.current = { ...current, [target]: next };
        writeVariable(target, next);
        lastAppliedWidth = next;
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
    [commit, writeVariable, leftPanelOpen, rightPanelOpen, workbenchDocked],
  );

  const nudge = useCallback(
    (target: SidebarTarget, delta: number) => {
      const current = widthsRef.current;
      const visibleWidth = clampFor(target, current[target], current, leftPanelOpen, rightPanelOpen, workbenchDocked);
      const next = clampFor(target, visibleWidth + delta, current, leftPanelOpen, rightPanelOpen, workbenchDocked);
      if (target === "workbench" && next === visibleWidth) return;
      commit(target, next);
    },
    [commit, leftPanelOpen, rightPanelOpen, workbenchDocked],
  );

  const reset = useCallback(
    (target: SidebarTarget) => {
      const current = widthsRef.current;
      const width = target === "workbench"
        ? defaultSidebarWidths.workbench
        : clampFor(target, defaultSidebarWidths[target], current, leftPanelOpen, rightPanelOpen, workbenchDocked);
      commit(target, width);
    },
    [commit, leftPanelOpen, rightPanelOpen, workbenchDocked],
  );

  return { widths, workbenchDocked, startResize, nudge, reset };
}

import type { SidebarResize } from "../hooks/useSidebarResize";
import { sidebarResizeStep, sidebarWidthLimits, type SidebarTarget } from "../sidebar-resize";
import { tr } from "../locale";

const labels: Record<SidebarTarget, [string, string]> = {
  left: ["调整左侧边栏宽度", "Resize left sidebar"],
  right: ["调整右侧面板宽度", "Resize right panel"],
  workbench: ["调整工作面板宽度", "Resize workbench"],
};

interface SidebarResizeHandleProps {
  target: SidebarTarget;
  resize: SidebarResize;
  contextOpen?: boolean;
  leftOpen?: boolean;
}

/**
 * 贴在侧栏内侧边缘的拖拽条:命中区跨过 1px 描边,
 * 拖动实时改宽度,双击复位,方向键可微调。
 */
export function SidebarResizeHandle({
  target,
  resize,
  contextOpen = true,
  leftOpen = true,
}: SidebarResizeHandleProps) {
  const leftWidth = leftOpen ? resize.widths.left : 0;
  const reservedWidth = target === "left" ? 0 : target === "right"
    ? leftWidth
    : leftWidth + (contextOpen ? resize.widths.right : 0);
  const { min, max } = sidebarWidthLimits(target, window.innerWidth, reservedWidth, resize.workbenchDocked);
  const [chinese, english] = labels[target];
  // 左栏的手柄贴在右边缘；右侧面板和工作面板的手柄贴在左边缘。
  const expand = target === "left" ? 1 : -1;

  return (
    <div
      className={`sidebar-resize-handle${expand === 1 ? " edge-right" : " edge-left"}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={tr(chinese, english)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(Math.max(min, Math.min(max, resize.widths[target])))}
      title={tr(chinese, english)}
      tabIndex={0}
      onPointerDown={(event) => resize.startResize(target, event)}
      onDoubleClick={() => resize.reset(target)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const step = event.shiftKey ? sidebarResizeStep * 3 : sidebarResizeStep;
        resize.nudge(target, direction * expand * step);
      }}
    />
  );
}

import type { SidebarResize } from "../hooks/useSidebarResize";
import { sidebarResizeStep, sidebarWidthRange, type SidebarTarget } from "../sidebar-resize";
import { tr } from "../locale";

const labels: Record<SidebarTarget, [string, string]> = {
  left: ["调整左侧边栏宽度", "Resize left sidebar"],
  right: ["调整右侧面板宽度", "Resize right panel"],
  preview: ["调整文件预览宽度", "Resize file preview"],
  agent: ["调整子代理面板宽度", "Resize subagent pane"],
};

interface SidebarResizeHandleProps {
  target: SidebarTarget;
  resize: SidebarResize;
}

/**
 * 贴在侧栏内侧边缘的拖拽条:命中区跨过 1px 描边,
 * 拖动实时改宽度,双击复位,方向键可微调。
 */
export function SidebarResizeHandle({ target, resize }: SidebarResizeHandleProps) {
  const { min, max } = sidebarWidthRange[target];
  const [chinese, english] = labels[target];
  // 左栏的手柄贴在它的右边缘,右栏(含预览)贴在左边缘,方向键因此要反向。
  const expand = target === "left" ? 1 : -1;

  return (
    <div
      className={`sidebar-resize-handle${expand === 1 ? " edge-right" : " edge-left"}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={tr(chinese, english)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(resize.widths[target])}
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

/**
 * 侧栏宽度的纯计算:左栏、右栏、右栏文件预览和子代理面板各自记宽,
 * 拖拽只负责换算和钳制,具体写入由 hook 完成。
 */

export type SidebarTarget = "left" | "right" | "preview" | "agent";

/** 本地持久化键:各种宽度一起存,启动时恢复。 */
export const sidebarWidthsStorageKey = "vela.sidebar.widths";

export interface SidebarWidths {
  left: number;
  right: number;
  preview: number;
  agent: number;
}

export const sidebarTargets: SidebarTarget[] = ["left", "right", "preview", "agent"];

export const defaultSidebarWidths: SidebarWidths = {
  left: 250,
  right: 340,
  preview: 640,
  agent: 480,
};

/** 每种状态的宽度区间:左栏只放会话列表,右栏和子代理面板要能容纳完整运行流。 */
export const sidebarWidthRange: Record<SidebarTarget, { min: number; max: number }> = {
  left: { min: 200, max: 420 },
  right: { min: 280, max: 760 },
  preview: { min: 320, max: 1100 },
  agent: { min: 340, max: 900 },
};

/** 拖宽一侧时为对话区保留的最小宽度;预览在窄窗口是浮层,只留一条边。 */
const stageReserve: Record<SidebarTarget, number> = {
  left: 360,
  right: 360,
  preview: 24,
  agent: 420,
};

/** 键盘微调的步长,按住 Shift 时放大三倍。 */
export const sidebarResizeStep = 16;

export function clampSidebarWidth(
  target: SidebarTarget,
  width: number,
  viewportWidth: number,
  reservedWidth = 0,
): number {
  const { min, max } = sidebarWidthRange[target];
  const available = viewportWidth - reservedWidth - stageReserve[target];
  const ceiling = Math.max(min, Math.min(max, available));
  return Math.round(Math.min(Math.max(width, min), ceiling));
}

/** 把指针位置换算成该侧栏的可用宽度:左栏量到窗口左边,右栏量到窗口右边。 */
export function widthFromPointer(target: SidebarTarget, clientX: number, viewportWidth: number): number {
  return target === "left" ? clientX : viewportWidth - clientX;
}

/** 读取持久化结果时只校验数值,越界和窗口适配交给 resolveSidebarWidths。 */
export function parseSidebarWidths(raw: string | null): SidebarWidths {
  const widths: SidebarWidths = { ...defaultSidebarWidths };
  if (!raw) return widths;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return widths;
  }
  if (!parsed || typeof parsed !== "object") return widths;
  const record = parsed as Record<string, unknown>;
  for (const target of sidebarTargets) {
    const value = record[target];
    if (typeof value === "number" && Number.isFinite(value)) {
      widths[target] = value;
    }
  }
  return widths;
}

/** 按当前窗口尺寸重新钳制三种宽度,保证对话区始终留得下。 */
export function resolveSidebarWidths(widths: SidebarWidths, viewportWidth: number): SidebarWidths {
  const left = clampSidebarWidth("left", widths.left, viewportWidth);
  return {
    left,
    right: clampSidebarWidth("right", widths.right, viewportWidth, left),
    preview: clampSidebarWidth("preview", widths.preview, viewportWidth, left),
    agent: clampSidebarWidth("agent", widths.agent, viewportWidth, left),
  };
}

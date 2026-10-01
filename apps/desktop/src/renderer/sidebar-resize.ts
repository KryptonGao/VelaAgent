/** 侧栏宽度纯计算；工作面板统一使用文件预览原有宽度作为迁移来源。 */

export type SidebarTarget = "left" | "right" | "workbench";

/** 本地持久化键:各种宽度一起存,启动时恢复。 */
export const sidebarWidthsStorageKey = "vela.sidebar.widths";

export interface SidebarWidths {
  left: number;
  right: number;
  workbench: number;
}

export const sidebarTargets: SidebarTarget[] = ["left", "right", "workbench"];

export const defaultSidebarWidths: SidebarWidths = {
  left: 250,
  right: 340,
  workbench: 640,
};

/** 左栏只放会话列表；工作面板需要容纳文件、计划和子代理内容。 */
export const sidebarWidthRange: Record<SidebarTarget, { min: number; max: number }> = {
  left: { min: 200, max: 420 },
  right: { min: 280, max: 760 },
  workbench: { min: 320, max: 1100 },
};

/** 宽屏为对话区保留 420px；窄屏工作面板改为浮层，只留 24px 边界。 */
const stageReserve: Record<SidebarTarget, number> = {
  left: 360,
  right: 360,
  workbench: 420,
};

/** 键盘微调的步长,按住 Shift 时放大三倍。 */
export const sidebarResizeStep = 16;

export function sidebarWidthLimits(
  target: SidebarTarget,
  viewportWidth: number,
  reservedWidth = 0,
  workbenchDocked = false,
): { min: number; max: number } {
  const { min: targetMin, max } = sidebarWidthRange[target];
  const narrowWorkbench = target === "workbench" && viewportWidth <= 1100;
  const reserve = narrowWorkbench ? (workbenchDocked ? 360 : 24) : stageReserve[target];
  const available = viewportWidth - reservedWidth - reserve;
  // Keep the conversation and ContextPanel visible if the workbench has to
  // shrink below 320px; narrow overlay mode only reserves a 24px conversation edge.
  const min = target === "workbench" && available < targetMin ? Math.max(0, available) : targetMin;
  return { min, max: Math.max(min, Math.min(max, available)) };
}

export function clampSidebarWidth(
  target: SidebarTarget,
  width: number,
  viewportWidth: number,
  reservedWidth = 0,
  workbenchDocked = false,
): number {
  const { min, max } = sidebarWidthLimits(target, viewportWidth, reservedWidth, workbenchDocked);
  return Math.round(Math.min(Math.max(width, min), max));
}

/** 把指针位置换算成该侧栏的可用宽度:左栏量到窗口左边,右栏量到窗口右边。 */
export function widthFromPointer(target: "left" | "right", clientX: number, viewportWidth: number): number {
  return target === "left" ? clientX : viewportWidth - clientX;
}

/** 工作面板的左边界向左移动时扩宽。 */
export function widthFromPointerDelta(startWidth: number, startX: number, clientX: number): number {
  return startWidth - (clientX - startX);
}

/**
 * 读取持久化结果时只校验数值，越界和窗口适配交给 resolveSidebarWidths。
 * 旧版本分别记录 preview/agent/plan；统一面板只迁移 preview，避免沿用已废弃的独立宽度。
 */
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
  for (const target of ["left", "right"] as const) {
    const value = record[target];
    if (typeof value === "number" && Number.isFinite(value)) {
      widths[target] = value;
    }
  }
  const workbench = record.workbench;
  const legacyPreview = record.preview;
  if (typeof workbench === "number" && Number.isFinite(workbench)) {
    widths.workbench = workbench;
  } else if (typeof legacyPreview === "number" && Number.isFinite(legacyPreview)) {
    widths.workbench = legacyPreview;
  }
  return widths;
}

/** 按当前窗口重新钳制宽度；工作面板位于对话区与 ContextPanel 之间。 */
export function resolveSidebarWidths(
  widths: SidebarWidths,
  viewportWidth: number,
  rightPanelOpen = true,
  leftPanelOpen = true,
): SidebarWidths {
  const left = clampSidebarWidth("left", widths.left, viewportWidth);
  const effectiveLeft = leftPanelOpen ? left : 0;
  const right = clampSidebarWidth("right", widths.right, viewportWidth, effectiveLeft);
  return {
    left,
    right,
    workbench: clampSidebarWidth(
      "workbench",
      widths.workbench,
      viewportWidth,
      effectiveLeft + (rightPanelOpen ? right : 0),
    ),
  };
}

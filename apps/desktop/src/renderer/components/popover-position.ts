interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Prefer above the status ring, flip when needed, and clamp to the viewport. */
export function positionContextPopover(anchor: Rect, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 12;
  const gap = 10;
  const above = anchor.top - gap - margin;
  const below = viewport.height - anchor.bottom - gap - margin;
  const side = above >= size.height || above >= below ? "above" : "below";
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, Math.max(margin, max)));
  const left = clamp(anchor.right - size.width, viewport.width - size.width - margin);
  const top = clamp(side === "above" ? anchor.top - size.height - gap : anchor.bottom + gap,
    viewport.height - size.height - margin);
  const originX = Math.max(0, Math.min(size.width, (anchor.left + anchor.right) / 2 - left));
  return { left, top, side, originX };
}

/** Repository menus prefer below the trigger and scroll within the available side. */
export function positionRepoPopover(anchor: Rect, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 12;
  const gap = 8;
  const above = Math.max(0, anchor.top - gap - margin);
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const side = below >= size.height || below >= above ? "below" : "above";
  const maxHeight = Math.min(380, side === "below" ? below : above);
  const height = Math.min(size.height, maxHeight);
  const left = Math.max(margin, Math.min(anchor.right - size.width, viewport.width - size.width - margin));
  const top = Math.max(margin, Math.min(side === "below" ? anchor.bottom + gap : anchor.top - height - gap,
    viewport.height - height - margin));
  return { left, top, maxHeight, side };
}

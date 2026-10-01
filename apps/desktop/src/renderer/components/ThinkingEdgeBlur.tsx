import { useMemo } from "react";

const EDGE_HEIGHT = 66;

/** Blend the viewport itself: nested Chromium scrollers can lose masked backdrop blur. */
export function ThinkingEdgeBlur({ id, top, bottom, height }: {
  id: string;
  top: boolean;
  bottom: boolean;
  height: number;
}) {
  const mask = useMemo(() => {
    const edge = Math.min(EDGE_HEIGHT / Math.max(height, 1), 0.5);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="${Math.max(height, 1)}"><defs><linearGradient id="edges" x1="0" y1="0" x2="0" y2="1"><stop stop-color="white" stop-opacity="${top ? 1 : 0}"/><stop offset="${edge}" stop-color="white" stop-opacity="0"/><stop offset="${1 - edge}" stop-color="white" stop-opacity="0"/><stop offset="1" stop-color="white" stop-opacity="${bottom ? 1 : 0}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#edges)"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }, [top, bottom, height]);

  return (
    <svg className="thinking-edge-filter" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feImage href={mask} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="edge-mask" />
          <feComposite in="blur" in2="edge-mask" operator="in" result="blurred-edges" />
          <feComposite in="SourceGraphic" in2="edge-mask" operator="out" result="clear-content" />
          {/* Add complementary alpha weights so the transition keeps the original opacity. */}
          <feComposite in="blurred-edges" in2="clear-content" operator="arithmetic" k2="1" k3="1" />
        </filter>
      </defs>
    </svg>
  );
}

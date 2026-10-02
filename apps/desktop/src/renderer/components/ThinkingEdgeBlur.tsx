import { Fragment } from "react";
import { SCROLL_EDGE_HEIGHT as EDGE_HEIGHT } from "./thinking-edges";

const BLUR_STAGES = [1, 2, 3];

/** Native filter masks avoid decoding a new feImage during scroll/resize updates. */
export function ThinkingEdgeBlur({ id, top, bottom, height }: {
  id: string;
  top: number;
  bottom: number;
  height: number;
}) {
  const viewportHeight = Math.max(height, 1);
  const edge = Math.min(EDGE_HEIGHT, viewportHeight / 2);
  return (
    <svg className="thinking-edge-filter" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id={id} filterUnits="userSpaceOnUse" x="0" y={-EDGE_HEIGHT} width="100%" height={viewportHeight + EDGE_HEIGHT * 2} colorInterpolationFilters="sRGB">
          {BLUR_STAGES.map((radius, index) => {
            // Each stronger blur occupies a narrower, feathered band at the edge.
            const band = edge * (1 - index / BLUR_STAGES.length);
            const input = index === 0 ? "SourceGraphic" : `stage-${index - 1}`;
            return (
              <Fragment key={radius}>
                <feFlood x="0" y={-EDGE_HEIGHT} width="100%" height={EDGE_HEIGHT + band / 3} floodColor="white" floodOpacity={top} result={`top-${index}`} />
                <feFlood x="0" y={viewportHeight - band / 3} width="100%" height={EDGE_HEIGHT + band / 3} floodColor="white" floodOpacity={bottom} result={`bottom-${index}`} />
                <feComposite in={`top-${index}`} in2={`bottom-${index}`} operator="over" result={`edges-${index}`} />
                <feGaussianBlur in={`edges-${index}`} stdDeviation={`0 ${band / 3}`} x="0" y="0" width="100%" height={viewportHeight} result={`mask-${index}`} />
                <feGaussianBlur in={input} stdDeviation={radius} edgeMode="duplicate" x="0" y="0" width="100%" height={viewportHeight} result={`blur-${index}`} />
                <feComposite in={`blur-${index}`} in2={`mask-${index}`} operator="in" result={`blurred-${index}`} />
                <feComposite in={input} in2={`mask-${index}`} operator="out" result={`clear-${index}`} />
                {/* Complementary alpha weights preserve the original opacity. */}
                <feComposite in={`blurred-${index}`} in2={`clear-${index}`} operator="arithmetic" k2="1" k3="1" result={`stage-${index}`} />
              </Fragment>
            );
          })}
        </filter>
      </defs>
    </svg>
  );
}

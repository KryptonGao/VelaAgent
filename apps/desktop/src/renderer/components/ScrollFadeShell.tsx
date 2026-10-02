import { useId, type CSSProperties, type ReactNode } from "react";
import { ThinkingEdgeBlur } from "./ThinkingEdgeBlur";
import { SCROLL_EDGE_HEIGHT } from "./thinking-edges";

/** Shared painting for thinking, task summaries and conclusions; callers own scrolling. */
export function ScrollFadeShell({ children, className, edges, height }: {
  children: ReactNode;
  className?: string;
  edges: { top: number; bottom: number };
  height: number;
}) {
  const filterId = `${useId()}-edge-blur`;
  return (
    <div
      className={`thinking-scroll-shell has-content-edge-blur${className ? ` ${className}` : ""}`}
      style={{
        "--thinking-edge-height": `${Math.min(SCROLL_EDGE_HEIGHT, height / 2)}px`,
        "--scroll-edge-filter": `url("#${filterId}")`,
      } as CSSProperties}
    >
      <ThinkingEdgeBlur id={filterId} {...edges} height={height} />
      {children}
      <div className="thinking-scroll-fade thinking-scroll-fade-top" style={{ opacity: edges.top }} aria-hidden="true" />
      <div className="thinking-scroll-fade thinking-scroll-fade-bottom" style={{ opacity: edges.bottom }} aria-hidden="true" />
    </div>
  );
}

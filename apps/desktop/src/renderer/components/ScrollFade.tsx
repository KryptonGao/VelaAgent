import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ScrollFadeShell } from "./ScrollFadeShell";
import { thinkingEdges } from "./thinking-edges";

/**
 * 限高滚动容器：内容超过高度时上下显示渐进模糊，和思考内容展开使用同一套视觉。
 * 内容保持挂载；Markdown 异步渲染或内容高度变化由 ResizeObserver 重新计算边缘状态。
 */
export function ScrollFade({
  children,
  className,
  contentClassName,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: 0, bottom: 0 });
  const [viewportHeight, setViewportHeight] = useState(0);

  const sync = (): void => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    setViewportHeight(viewport.clientHeight);
    const next = thinkingEdges(viewport.scrollTop, viewport.scrollHeight, viewport.clientHeight);
    setEdges((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  };

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport) return;
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <ScrollFadeShell className={className} edges={edges} height={viewportHeight}>
      <div
        className="thinking-scroll-viewport"
        ref={scrollRef}
        onScroll={sync}
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
      >
        <div className={`thinking-text${contentClassName ? ` ${contentClassName}` : ""}`} ref={contentRef}>
          {children}
        </div>
      </div>
    </ScrollFadeShell>
  );
}

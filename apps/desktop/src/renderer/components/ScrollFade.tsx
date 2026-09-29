import { useEffect, useRef, useState, type ReactNode } from "react";

function edgesFrom(viewport: HTMLDivElement): { top: boolean; bottom: boolean } {
  const maxScroll = viewport.scrollHeight - viewport.clientHeight;
  return {
    top: viewport.scrollTop > 2,
    bottom: maxScroll > 2 && viewport.scrollTop < maxScroll - 2,
  };
}

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
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport) return;
    const sync = () => {
      const next = edgesFrom(viewport);
      setEdges((current) =>
        current.top === next.top && current.bottom === next.bottom ? current : next,
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onScroll = (): void => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const next = edgesFrom(viewport);
    setEdges((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  };

  return (
    <div className={`thinking-scroll-shell${className ? ` ${className}` : ""}`}>
      <div
        className="thinking-scroll-viewport"
        ref={scrollRef}
        onScroll={onScroll}
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
      >
        <div className={`thinking-text${contentClassName ? ` ${contentClassName}` : ""}`} ref={contentRef}>
          {children}
        </div>
      </div>
      <div
        className={`thinking-scroll-fade thinking-scroll-fade-top${edges.top ? " is-visible" : ""}`}
        aria-hidden="true"
      />
      <div
        className={`thinking-scroll-fade thinking-scroll-fade-bottom${edges.bottom ? " is-visible" : ""}`}
        aria-hidden="true"
      />
    </div>
  );
}

import { useLayoutEffect, useRef, useState, type TouchEvent, type WheelEvent } from "react";
import { ActivityIndicator } from "./ActivityIndicator";
import { Markdown } from "./Markdown";
import { nextStreamFollow, releasesStreamFollow } from "./chat-scroll";
import { tr } from "../locale";

/** 思考进行中默认展开,思考结束(出现新工具、开始回复或回合结束)时自动折叠;任意长度都能手动开合。 */
export function Thinking({
  text,
  active,
  showActivityIndicator,
}: {
  text: string;
  active: boolean;
  showActivityIndicator: boolean;
}) {
  const [open, setOpen] = useState(active);
  const [revealed, setRevealed] = useState(active);
  const [fadeEdges, setFadeEdges] = useState({ top: false, bottom: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevActive = useRef(active);
  // 只有当用户停在底部时才跟随新增的思考内容;向上阅读后保持当前位置。
  const follow = useRef({ pinned: active, lastScrollTop: 0 });
  const touchY = useRef(0);

  const syncFadeEdges = () => {
    const element = scrollRef.current;
    if (!element) return;
    const maxScroll = element.scrollHeight - element.clientHeight;
    const next = {
      top: element.scrollTop > 2,
      bottom: maxScroll > 2 && element.scrollTop < maxScroll - 2,
    };
    setFadeEdges((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  };

  const scrollToEnd = () => {
    const element = scrollRef.current;
    if (!element) return;
    const maxScroll = element.scrollHeight - element.clientHeight;
    if (maxScroll - element.scrollTop >= 1) element.scrollTop = maxScroll;
    // 记录程序化滚动后的位置,避免随后触发的 scroll 事件被误判为用户滚离底部。
    follow.current.lastScrollTop = element.scrollTop;
  };

  const handleScroll = () => {
    const element = scrollRef.current;
    if (element) {
      const scrollTop = element.scrollTop;
      follow.current.pinned = nextStreamFollow({
        following: follow.current.pinned,
        scrollTop,
        previousScrollTop: follow.current.lastScrollTop,
        distanceFromBottom: element.scrollHeight - scrollTop - element.clientHeight,
      });
      follow.current.lastScrollTop = scrollTop;
    }
    syncFadeEdges();
  };

  // 在滚动真正发生前就解除跟随,避免输出恰好插入时把视口又拉回底部。
  const releaseFollow = (towardEarlier: boolean) => {
    const element = scrollRef.current;
    if (element && releasesStreamFollow(element.scrollTop, towardEarlier)) follow.current.pinned = false;
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    releaseFollow(event.deltaY < 0);
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchY.current = event.touches[0]?.clientY ?? touchY.current;
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY;
    if (y == null) return;
    releaseFollow(y > touchY.current + 2);
    touchY.current = y;
  };

  useLayoutEffect(() => {
    if (prevActive.current && !active) setOpen(false);
    prevActive.current = active;
  }, [active]);

  // 新增思考内容后,如果用户仍在底部就继续贴底。
  useLayoutEffect(() => {
    if (!open || !revealed || !follow.current.pinned) return;
    scrollToEnd();
  }, [text, open, revealed]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!open || !revealed || !scrollElement || !contentElement) {
      setFadeEdges({ top: false, bottom: false });
      return;
    }

    // 流式追加、Markdown 异步渲染或展开动画都会改变高度,贴底时持续跟随到底部。
    const sync = () => {
      syncFadeEdges();
      if (follow.current.pinned) scrollToEnd();
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(scrollElement);
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [open, revealed]);

  const toggle = () => {
    // 展开过就保留 Markdown 挂载,收起时才有平滑的高度过渡。
    setRevealed(true);
    setOpen((value) => !value);
  };
  const showActivity = active && showActivityIndicator;

  const label = (
    <>
      <span>{tr("思考", "Thinking")}</span>
      <svg className="time-spent-trigger-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </>
  );
  return (
    <div className={`time-spent-collapsible${open ? " expanded" : ""}`}>
      <button className={`time-spent-trigger${showActivity ? " is-running" : ""}`} type="button" aria-expanded={open} onClick={toggle}>
        {label}
        {showActivity ? <ActivityIndicator /> : null}
      </button>
      <div className="time-spent-body" aria-hidden={!open}>
        <div className="time-spent-body-inner">
          <div className="thinking-scroll-shell">
            <div
              className="thinking-scroll-viewport"
              ref={scrollRef}
              onScroll={handleScroll}
              onWheel={handleWheel}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              role="region"
              aria-label={tr("思考内容，可在区域内滚动", "Thinking content, scrollable")}
              tabIndex={0}
            >
              <div className="stream-prose-block thinking-text" ref={contentRef}>
                {revealed ? <Markdown text={text} /> : null}
              </div>
            </div>
            <div
              className={`thinking-scroll-fade thinking-scroll-fade-top${fadeEdges.top ? " is-visible" : ""}`}
              aria-hidden="true"
            />
            <div
              className={`thinking-scroll-fade thinking-scroll-fade-bottom${fadeEdges.bottom ? " is-visible" : ""}`}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

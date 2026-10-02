import { useContext, useId, useLayoutEffect, useRef, useState, type TouchEvent, type WheelEvent } from "react";
import { ActivityIndicator } from "./ActivityIndicator";
import { Markdown } from "./Markdown";
import { nextStreamFollow, releasesStreamFollow } from "./chat-scroll";
import { localizeError, tr } from "../locale";
import { thinkingSummaryLayout } from "../thinking-summary";
import { ThinkingSummaryContext } from "./ThinkingSummaryContext";
import { ThinkingEdgeBlur } from "./ThinkingEdgeBlur";

/** 思考进行中默认展开,思考结束(出现新工具、开始回复或回合结束)时自动折叠;任意长度都能手动开合。 */
export function Thinking({
  text,
  messageId,
  active,
  showActivityIndicator,
  contentEdgeBlur = false,
}: {
  text: string;
  messageId?: string;
  active: boolean;
  showActivityIndicator: boolean;
  contentEdgeBlur?: boolean;
}) {
  const summaries = useContext(ThinkingSummaryContext);
  const summaryAvailable = !active && summaries?.enabled && messageId !== undefined;
  const summary = summaryAvailable ? summaries.get(messageId, text) : undefined;
  const bodyId = useId();
  const summarize = () => {
    if (summaryAvailable) summaries.request(messageId, text);
  };
  const [open, setOpen] = useState(active);
  const [revealed, setRevealed] = useState(active);
  const [fadeEdges, setFadeEdges] = useState({ top: false, bottom: false });
  const [viewportHeight, setViewportHeight] = useState(280);
  const edgeFilterId = `${bodyId}-edge-blur`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevActive = useRef(active);
  // 只有当用户停在底部时才跟随新增的思考内容;向上阅读后保持当前位置。
  const follow = useRef({ pinned: active, lastScrollTop: 0 });
  const touchY = useRef(0);
  const layout = thinkingSummaryLayout(summaries?.style ?? "inline", summary, open);

  const syncFadeEdges = () => {
    const element = scrollRef.current;
    if (!element) return;
    const maxScroll = element.scrollHeight - element.clientHeight;
    if (contentEdgeBlur) setViewportHeight(element.clientHeight);
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

  const arrow = (
    <svg className="time-spent-trigger-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
  const label = (
    <>
      <span>{tr("思考", "Thinking")}</span>
      {arrow}
    </>
  );
  // 总结作为标题时,它自己就是开合按钮;正文样式时另起一块,用末尾的图标收起思考。
  const headline = layout === "headline" && summary?.status === "done" ? (
    <div className="thinking-header">
      <button className="time-spent-trigger thinking-headline-trigger" type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle} title={summary.text}>
        <span className="thinking-summary-excerpt summary-arrival">{summary.text}</span>
        {arrow}
      </button>
    </div>
  ) : null;
  const prose = layout === "prose" && summary?.status === "done" ? (
    <div
      className="thinking-prose-summary agent-reply-prose summary-arrival"
      onClick={(event) => {
        // 划选总结文字时不触发展开;单击整段文字等同点击末尾图标。
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return;
        toggle();
      }}
    >
      {/* 图标跟在总结文字之后排进最后一行,避免右侧预留空隙导致上一行提前换行。 */}
      <p className="thinking-prose-text">
        {summary.text}
        <button
          className={`thinking-prose-toggle${open ? " expanded" : ""}`}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? tr("收起思考内容", "Hide the thinking") : tr("展开思考内容", "Show the thinking")}
          aria-label={open ? tr("收起思考内容", "Hide the thinking") : tr("展开思考内容", "Show the thinking")}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </p>
    </div>
  ) : null;
  return (
    <div className={`time-spent-collapsible thinking-block${open ? " expanded" : ""}`}>
      {headline ?? prose ?? (
        <div className="thinking-header">
          <button className={`time-spent-trigger${showActivity ? " is-running" : ""}`} type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
            {label}
            {showActivity ? <ActivityIndicator /> : null}
          </button>
          {/* 折叠时只在“思考”右侧露出一行总结;展开后完整总结移到标题下方,这里不再重复。 */}
          {summaryAvailable && (!open || !summary || summary.status === "error") ? (
            <div className="thinking-summary-inline">
              {!open && summary?.status === "done" ? (
                <button className="thinking-summary-preview" type="button" onClick={toggle} title={summary.text} aria-expanded={open} aria-controls={bodyId}>
                  <span className="thinking-summary-excerpt summary-arrival">{summary.text}</span>
                </button>
              ) : null}
              {!open && summary?.status === "pending" ? (
                <span className="thinking-summary-status" role="status"><ActivityIndicator label={tr("正在总结", "Summarizing")} />{tr("正在总结…", "Summarizing…")}</span>
              ) : null}
              {!summary || summary.status === "error" ? (
                <>
                  {summary ? <span className="thinking-summary-failed" role="status" title={localizeError(summary.error)}>{tr("总结失败", "Summary failed")}</span> : null}
                  <button className="thinking-summary-action" type="button" onClick={summarize} title={tr("使用设置中的思考总结模型生成总结", "Summarize with the thinking summary model configured in settings")}>
                    {summary ? tr("重试", "Retry") : tr("总结", "Summarize")}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <div id={bodyId} className="time-spent-body" aria-hidden={!open} inert={!open ? true : undefined}>
        <div className="time-spent-body-inner">
          {summary && layout !== "prose" ? (
            <aside className="thinking-summary-panel" aria-label={tr("思考总结", "Thinking summary")} aria-busy={summary.status === "pending"}>
              <span className="thinking-summary-label">{tr("总结", "Summary")}</span>
              {summary.status === "done" ? <p key="done" className="summary-arrival">{summary.text}</p> : summary.status === "pending" ? (
                <p className="thinking-summary-status">{tr("正在生成总结…", "Generating a summary…")}</p>
              ) : <p className="thinking-summary-failed">{localizeError(summary.error)}</p>}
            </aside>
          ) : null}
          <div className={`thinking-scroll-shell${contentEdgeBlur ? " has-content-edge-blur" : ""}`}>
            {contentEdgeBlur ? <ThinkingEdgeBlur id={edgeFilterId} {...fadeEdges} height={viewportHeight} /> : null}
            <div
              className="thinking-scroll-viewport"
              style={contentEdgeBlur && (fadeEdges.top || fadeEdges.bottom) ? { filter: `url("#${edgeFilterId}")` } : undefined}
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
                {revealed ? <Markdown text={text} streaming={active} /> : null}
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

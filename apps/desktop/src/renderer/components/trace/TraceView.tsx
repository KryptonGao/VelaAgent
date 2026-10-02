import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppState, TraceNode } from "@vela/shared";
import { useTrace } from "../../hooks/useTrace";
import { useEntryArrival } from "../../hooks/useEntryArrival";
import { tr } from "../../locale";
import {
  traceMetrics,
  traceTimeline,
  slowestTraceNode,
  type TimelineMode,
} from "./trace-model";
import {
  TraceIcon,
  TraceInspector,
  TraceStatusBadge,
  kindLabel,
  durationLabel,
  timeLabel,
} from "./TraceInspector";

const rowHeight = 30;
// Reserve the lane labels (52px) and the right gutter (8px) outside the scale.
const timelinePadding = 60;
const zoomLabel = (zoom: number) =>
  `${Number.isInteger(zoom) ? zoom : zoom.toFixed(1)}×`;
export function TraceView({
  state,
  onConversation,
  onAbort,
  pendingInteraction,
}: {
  state: AppState | null;
  onConversation: () => void;
  onAbort: () => Promise<void>;
  pendingInteraction: boolean;
}) {
  const conversationId = state?.activeConversationId ?? null;
  const { trace, loading, error } = useTrace(conversationId);
  const [selected, setSelected] = useState<string | null>(null),
    [inspector, setInspector] = useState(true),
    [mode, setMode] = useState<TimelineMode>("sequence");
  const [scroll, setScroll] = useState({ top: 0, height: 500 }),
    [timelineWindow, setTimelineWindow] = useState({ left: 0, width: 900 }),
    [follow, setFollow] = useState(true),
    [now, setNow] = useState(Date.now),
    [zoom, setZoom] = useState(1);
  const list = useRef<HTMLDivElement>(null),
    timeline = useRef<HTMLDivElement>(null),
    followRef = useRef(true),
    zoomAnchor = useRef<number | null>(null);
  const selectionPause = useRef(false);
  const running =
    trace.nodes.some((n) => n.status === "Running") ||
    state?.session.status === "streaming";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  const initialSystem = trace.nodes.find((n) => n.kind === "system");
  const nodes = useMemo(
    () => trace.nodes.filter((n) => n.id !== initialSystem?.id),
    [trace.nodes, initialSystem?.id],
  );
  const indexById = useMemo(
    () => new Map(nodes.map((n, i) => [n.id, i])),
    [nodes],
  );
  const geometry = useMemo(
    () => traceTimeline(
      trace.nodes, trace.requests, mode, now, zoom,
      Math.max(1, timelineWindow.width - timelinePadding),
    ),
    [trace.nodes, trace.requests, mode, now, zoom, timelineWindow.width],
  );
  const arrivalKeys = useMemo(() => [
    ...nodes.map((node) => `row:${node.id}`),
    ...geometry.bars.map((bar) => `bar:${bar.node.id}`),
  ], [nodes, geometry.bars]);
  const selectedBar = geometry.bars.find((b) => b.node.id === selected);
  const selectedNode =
    trace.nodes.find((n) => n.id === selected) ??
    selectedBar?.node ??
    initialSystem ??
    trace.nodes[0] ??
    null;
  const metrics = useMemo(() => traceMetrics(trace.requests), [trace.requests]);
  useLayoutEffect(() => {
    const element = list.current,
      chart = timeline.current;
    if (!element || !chart) return;
    const measure = () => {
      setScroll((s) => ({ ...s, height: element.clientHeight }));
      setTimelineWindow({ left: chart.scrollLeft, width: chart.clientWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(chart);
    return () => observer.disconnect();
  }, []);
  // Keep the visible time range centered while zooming, then refresh the window
  // so ruler and group labels match what is actually visible.
  useLayoutEffect(() => {
    const chart = timeline.current;
    if (!chart) return;
    if (zoom === 1) {
      chart.scrollLeft = 0;
      zoomAnchor.current = null;
    } else if (zoomAnchor.current !== null) {
      chart.scrollLeft = Math.max(
        0,
        zoomAnchor.current * geometry.width - chart.clientWidth / 2,
      );
      zoomAnchor.current = null;
    }
    setTimelineWindow((window) =>
      window.left === chart.scrollLeft && window.width === chart.clientWidth
        ? window
        : { left: chart.scrollLeft, width: chart.clientWidth },
    );
  }, [zoom, mode, geometry.width]);
  const applyZoom = (next: number) => {
    const chart = timeline.current;
    if (chart && geometry.width > 0 && next !== zoom)
      zoomAnchor.current =
        (chart.scrollLeft + chart.clientWidth / 2) / geometry.width;
    setZoom(next);
  };
  useLayoutEffect(() => {
    if (followRef.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [nodes.length, trace.version]);
  const choose = (node: TraceNode) => {
    selectionPause.current = true;
    setSelected(node.id);
    setInspector(true);
    followRef.current = false;
    setFollow(false);
    const bar = geometry.bars.find((b) => b.node.id === node.id);
    const index = indexById.get(bar?.sourceNodeId ?? node.id),
      scroller = list.current;
    if (index !== undefined && scroller) {
      const y = index * rowHeight;
      if (
        y < scroller.scrollTop ||
        y + rowHeight > scroller.scrollTop + scroller.clientHeight
      )
        scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
    }
    const chart = timeline.current;
    if (
      bar &&
      chart &&
      (bar.x < chart.scrollLeft ||
        bar.x + bar.width > chart.scrollLeft + chart.clientWidth - 48)
    )
      chart.scrollLeft = Math.max(0, bar.x - chart.clientWidth / 2 + 48);
  };
  const start = Math.max(0, Math.floor(scroll.top / rowHeight) - 8),
    end = Math.min(
      nodes.length,
      Math.ceil((scroll.top + scroll.height) / rowHeight) + 8,
    );
  const turns = trace.nodes.reduce((max, n) => Math.max(max, n.turn), 0),
    calls = trace.nodes.filter((n) => n.kind === "tool-call").length;
  const slowest = slowestTraceNode(geometry.bars.map((b) => b.node), trace.requests);
  // Keep ruler labels roughly 140px apart; a fixed tick count bunches or
  // scatters once the zoom slider changes the canvas width.
  const tickCount = Math.max(2, Math.min(200, Math.round(geometry.width / 140)));
  const timeTicks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    x: (geometry.width * i) / tickCount,
    label: durationLabel(geometry.duration * (i / tickCount)),
  }));
  const groupSize = geometry.width / geometry.groups;
  const groupStart = Math.max(
      0,
      Math.floor(timelineWindow.left / groupSize) - 1,
    ),
    groupEnd = Math.min(
      geometry.groups,
      Math.ceil((timelineWindow.left + timelineWindow.width) / groupSize) + 1,
    );
  const ticks =
    mode === "sequence"
      ? []
      : mode === "duration"
      ? timeTicks
      : Array.from({ length: groupEnd - groupStart }, (_, i) => ({
          x: (i + groupStart) * groupSize + 8,
          label: `${mode === "turn" ? tr("轮次", "Turn") : tr("请求", "Request")} #${i + groupStart + 1}`,
        }));
  const arrivalRef = useEntryArrival(conversationId ?? "empty", arrivalKeys);
  return (
    <section
      ref={arrivalRef}
      className="trace-view"
      aria-label={tr("Agent 执行轨迹", "Agent execution trace")}
    >
      <div className="trace-toolbar">
        <div
          className="trace-dimensions"
          role="group"
          aria-label={tr("时间轴尺度", "Timeline scale")}
        >
          {(["duration", "turn", "request"] as TimelineMode[]).map((m) => (
            <button
              aria-pressed={mode === m}
              onClick={() => {
                setMode((current) => current === m ? "sequence" : m);
                if (timeline.current) timeline.current.scrollLeft = 0;
              }}
              key={m}
            >
              {m === "duration"
                ? tr("时长", "Duration")
                : m === "turn"
                  ? tr("轮次", "Turns")
                  : tr("调用", "Calls")}
            </button>
          ))}
        </div>
        <span className="trace-scale-hint">
          {mode === "sequence"
            ? tr("等宽事件 · 按记录顺序", "Equal events · recorded order")
            : mode !== "duration"
            ? tr(
                "等宽区段 · 非真实时间比例",
                "Equal segments · not to time scale",
              )
            : trace.nodes.some((n) => n.historical)
              ? tr(
                  "历史事件包含记录时间；缺失耗时未估算",
                  "Historical timestamps; missing durations are not estimated",
                )
              : tr("实际时间", "Elapsed time")}
        </span>
        <div className="trace-toolbar-actions">
          <div
            className="trace-scale-control"
            role="group"
            aria-label={tr("时间轴缩放", "Timeline zoom")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <rect x="1.5" y="5.5" width="13" height="5" rx="1" />
              <path d="M4.5 5.5v2M7 5.5v3M9.5 5.5v2M12 5.5v3" />
            </svg>
            <input
              className="trace-scale-input"
              type="range"
              min={1}
              max={8}
              step={0.5}
              value={zoom}
              disabled={!nodes.length}
              aria-label={tr("调整比例尺", "Adjust scale")}
              aria-valuetext={zoomLabel(zoom)}
              title={tr("拖动调整时间轴比例尺", "Drag to scale the timeline")}
              onChange={(e) => applyZoom(Number(e.currentTarget.value))}
            />
            <button
              className="trace-scale-value"
              disabled={zoom === 1}
              title={tr("适应宽度，展示完整过程", "Fit width to show the full trace")}
              aria-label={tr("适应宽度，展示完整过程", "Fit width to show the full trace")}
              onClick={() => applyZoom(1)}
            >
              {zoomLabel(zoom)}
            </button>
          </div>
          {running ? (
            <button className="trace-stop" onClick={() => void onAbort()}>
              {tr("停止运行", "Stop")}
            </button>
          ) : null}
          <button
            className="trace-icon-button"
            aria-label={
              inspector
                ? tr("关闭详情", "Close inspector")
                : tr("打开详情", "Open inspector")
            }
            title={
              inspector
                ? tr("关闭详情", "Close inspector")
                : tr("打开详情", "Open inspector")
            }
            aria-pressed={inspector}
            onClick={() => setInspector((v) => !v)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
              <path d="M10 3v10" />
            </svg>
          </button>
        </div>
      </div>
      <div
        className={`trace-timeline${mode === "sequence" ? " trace-timeline-sequence" : ""}`}
        ref={timeline}
        onScroll={(e) =>
          setTimelineWindow({
            left: e.currentTarget.scrollLeft,
            width: e.currentTarget.clientWidth,
          })
        }
        aria-label={tr("执行时间轴", "Execution timeline")}
      >
        <div
          className="trace-timeline-canvas"
          style={{ width: geometry.width + timelinePadding }}
        >
          {mode !== "sequence" ? <div className="trace-ruler">
            {ticks.map((t, i) => (
              <span key={i} style={{
                left: t.x + 52,
                transform: mode === "duration" && i === ticks.length - 1
                  ? "translateX(-100%)"
                  : undefined,
              }}>
                {t.label}
              </span>
            ))}
          </div> : null}
          {[tr("输入", "Input"), tr("模型", "Model"), tr("工具", "Tools")].map(
            (label, lane) => (
              <div
                className="trace-lane"
                key={lane}
                style={{ height: mode === "sequence" ? 14 : geometry.rows[lane]! * 14 + 8 }}
              >
                <span className="trace-lane-label">{label}</span>
                {geometry.bars
                  .filter(
                    (b) =>
                      b.lane === lane &&
                      b.x + b.width >= timelineWindow.left - 100 &&
                      b.x <= timelineWindow.left + timelineWindow.width + 100,
                  )
                  .map((b) => (
                    <button
                      key={b.node.id}
                      data-arrival-key={`bar:${b.node.id}`}
                      className={`trace-bar trace-kind-${b.node.kind}${b.node.status === "Failed" ? " failed" : ""}${b.node.status === "Interrupted" ? " interrupted" : ""}${b.node.status === "Running" ? " running" : ""}${selectedNode?.id === b.node.id ? " selected" : ""}`}
                      style={{
                        left: b.x + 52,
                        width: b.width,
                        top: b.row * 14 + 4,
                      }}
                      onClick={() => choose(b.node)}
                      aria-label={`${b.sourceNodeId ? tr("模型请求", "Model request") : kindLabel(b.node.kind)} · ${b.node.toolName ?? ""} ${b.node.summary}`}
                      aria-pressed={selectedNode?.id === b.node.id}
                      title={`${b.sourceNodeId ? tr("模型请求", "Model request") : kindLabel(b.node.kind)} ${b.node.toolName ?? ""}\n${b.node.summary}\n${timeLabel(b.node.startedAt)} · ${durationLabel(b.node.durationMs)}`}
                    />
                  ))}
              </div>
            ),
          )}
        </div>
      </div>
      {pendingInteraction ? (
        <div className="trace-interaction-notice" role="status">
          <span>
            {tr(
              "Agent 正在等待批准或回答",
              "Agent is waiting for approval or an answer",
            )}
          </span>
          <button onClick={onConversation}>
            {tr("切换到对话处理", "Open conversation")}
          </button>
        </div>
      ) : null}
      {trace.warning || error ? (
        <div className="trace-warning" role="alert">
          {trace.warning ?? error}
        </div>
      ) : null}
      <div className="trace-body">
        <div className="trace-list-pane">
          <button
            className={`trace-system-row${selectedNode?.id === initialSystem?.id ? " selected" : ""}`}
            disabled={!initialSystem}
            onClick={() => {
              if (initialSystem) choose(initialSystem);
            }}
          >
            <span className="trace-kind trace-kind-system">
              <TraceIcon kind="system" />
            </span>
            <span>{tr("初始系统提示词", "Initial system prompt")}</span>
            <span className="trace-muted">
              {initialSystem
                ? tr("提示词与工具", "Prompt & tools")
                : tr("首次请求后记录", "Recorded on first request")}
            </span>
          </button>
          <div
            className="trace-list"
            ref={list}
            role="listbox"
            aria-label={tr("执行事件", "Execution events")}
            tabIndex={0}
            aria-activedescendant={
              selectedNode &&
              indexById.has(selectedNode.id) &&
              indexById.get(selectedNode.id)! >= start &&
              indexById.get(selectedNode.id)! < end
                ? `trace-row-${selectedNode.id}`
                : undefined
            }
            onKeyDown={(e) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
                return;
              e.preventDefault();
              const index = selectedNode
                ? (indexById.get(selectedNode.id) ?? -1)
                : -1;
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? nodes.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          nodes.length - 1,
                          index + (e.key === "ArrowDown" ? 1 : -1),
                        ),
                      );
              if (nodes[next]) choose(nodes[next]!);
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              setScroll({ top: el.scrollTop, height: el.clientHeight });
              if (!selectionPause.current) {
                const pinned =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                followRef.current = pinned;
                setFollow(pinned);
              }
            }}
            onWheel={(e) => {
              selectionPause.current = false;
              if (e.deltaY < 0) {
                followRef.current = false;
                setFollow(false);
              }
            }}
            onPointerDown={() => {
              selectionPause.current = false;
              followRef.current = false;
              setFollow(false);
            }}
          >
            {loading && !nodes.length ? (
              <div className="trace-empty">
                <span className="trace-spinner" />
                {tr("正在加载轨迹…", "Loading trace…")}
              </div>
            ) : !nodes.length ? (
              <div className="trace-empty">
                <TraceIcon kind="thinking" size={24} />
                <strong>
                  {tr(
                    "准备观察 Agent 的执行过程",
                    "Ready to observe the agent",
                  )}
                </strong>
                <p>
                  {tr(
                    "发送任务后，思考、工具调用和返回会实时出现在这里。",
                    "Thinking, tool calls and results appear here as the task runs.",
                  )}
                </p>
                <button onClick={onConversation}>
                  {tr("到对话中开始任务", "Start a task in conversation")}
                </button>
              </div>
            ) : (
              <div
                className="trace-list-spacer"
                style={{ height: nodes.length * rowHeight }}
              >
                {nodes.slice(start, end).map((node, i) => (
                  <div
                    id={`trace-row-${node.id}`}
                    key={node.id}
                    data-arrival-key={`row:${node.id}`}
                    role="option"
                    aria-selected={selectedNode?.id === node.id}
                    aria-posinset={start + i + 1}
                    aria-setsize={nodes.length}
                    className={`trace-row${selectedNode?.id === node.id ? " selected" : ""}`}
                    style={{ top: (start + i) * rowHeight }}
                    onClick={() => choose(node)}
                  >
                    <span className="trace-sequence">
                      {node.turn > 0 ? `#${node.turn}` : ""}
                    </span>
                    <span className={`trace-kind trace-kind-${node.kind}`}>
                      <TraceIcon kind={node.kind} />
                    </span>
                    <span
                      className={`trace-row-content${node.kind === "tool-call" || node.kind === "tool-result" ? " mono" : ""}`}
                    >
                      <strong>{node.toolName ?? kindLabel(node.kind)}</strong>
                      <span>{node.summary}</span>
                    </span>
                    {node.status !== "Completed" ? (
                      <TraceStatusBadge node={node} />
                    ) : null}
                    <span className="trace-row-duration">
                      {node.durationMs === null
                        ? "—"
                        : durationLabel(node.durationMs)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {!follow && nodes.length ? (
            <button
              className="trace-follow"
              onClick={() => {
                selectionPause.current = false;
                followRef.current = true;
                setFollow(true);
                if (list.current)
                  list.current.scrollTop = list.current.scrollHeight;
              }}
            >
              {tr("回到最新", "Jump to latest")} ↓
            </button>
          ) : null}
        </div>
        {inspector && selectedNode && conversationId ? (
          <TraceInspector
            key={selectedNode.id}
            conversationId={conversationId}
            node={selectedNode}
            sourceNodeId={selectedBar?.sourceNodeId}
            onClose={() => setInspector(false)}
          />
        ) : null}
      </div>
      <footer className="trace-summary">
        <span>
          {turns} {tr("轮", "turns")}
        </span>
        <span>
          {trace.requests.length} {tr("步", "steps")}
        </span>
        <span>
          {calls} {tr("调用", "calls")}
        </span>
        <span>
          {metrics.speed === null
            ? "—"
            : Math.round(metrics.speed).toLocaleString()}{" "}
          tok/s
        </span>
        <span>
          {metrics.tokens === null
            ? "—"
            : Intl.NumberFormat("en-US", {
                notation: "compact",
                maximumFractionDigits: 1,
              }).format(metrics.tokens)}{" "}
          tok
        </span>
        <span>
          {tr("缓存命中", "Cache hit")}{" "}
          {metrics.cache === null ? "—" : `${Math.round(metrics.cache * 100)}%`}
        </span>
        <span>
          {tr("上下文", "Context")}{" "}
          {state?.context.percent == null
            ? "—"
            : `${state.context.percent.toFixed(0)}%`}
        </span>
        <button
          disabled={!slowest}
          onClick={() => {
            const node = trace.nodes.find((n) => n.id === slowest) ?? geometry.bars.find((b) => b.node.id === slowest)?.node;
            if (node) choose(node);
          }}
        >
          {tr("定位最慢步骤", "Slowest step")}
        </button>
      </footer>
    </section>
  );
}

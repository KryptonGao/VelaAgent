import { intlLocale } from "@vela/shared";
import type { ToolTrace } from "@vela/shared";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { localizeError, tr, useAppLocale, trf } from "../locale";
import { ConversationLinkContext } from "./ConversationLinkContext";
import { Markdown } from "./Markdown";
import { ScrollFade } from "./ScrollFade";
import { ExternalIcon } from "./icons";
import { useSlidingTabIndicator } from "./useSlidingTabIndicator";
import { formatMcpResponse, mcpResultUrl, presentMcpResult, type McpSearchResult } from "./mcp-tool-result";

type DetailTab = "result" | "call" | "raw";
const tabs: DetailTab[] = ["result", "call", "raw"];

export function McpToolDetails({ tool }: { tool: ToolTrace }) {
  useAppLocale();
  const { activity, status } = tool;
  const [tab, setTab] = useState<DetailTab>("result");
  const indicator = useSlidingTabIndicator({ activeKey: tab });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const body = activity.body ?? "";
  const result = useMemo(() => presentMcpResult(body), [body]);
  const raw = useMemo(() => formatMcpResponse(body), [body]);
  useEffect(() => { setCopyState("idle"); }, [body]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [copyState]);
  const labels = { result: tr("结果", "Results"), call: tr("调用信息", "Call info"), raw: tr("原始响应", "Raw response") };

  return <section className="mcp-tool-details" aria-label={tr("MCP 工具详情", "MCP tool details")}>
    <nav ref={indicator.navRef} className="conversation-view-tabs mcp-detail-tabs" role="tablist" aria-label={tr("详情视图", "Detail view")}
      onPointerMove={indicator.onPointerMove} onPointerLeave={indicator.onPointerLeave}>
      {tabs.map((item, index) => <button key={item} type="button" role="tab" id={`${id}-${item}`} aria-controls={`${id}-panel`}
        data-tab-key={item} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} ref={node => {
          tabRefs.current[index] = node; indicator.registerTab(item)(node);
        }}
        onClick={() => setTab(item)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); setTab(tabs[next]); tabRefs.current[next]?.focus();
        }}>{labels[item]}</button>)}
      {indicator.indicator}
    </nav>
    <ScrollFade key={tab} className="mcp-detail-scroll" ariaLabel={tr("MCP 工具详情，可在区域内滚动", "MCP tool details, scrollable")}>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0} className="mcp-detail-panel">
      {tab === "call" ? <>
        <dl className="mcp-call-fields">
          <div><dt>{tr("MCP 服务器", "MCP server")}</dt><dd>{activity.mcp?.server}</dd></div>
          <div><dt>{tr("工具", "Tool")}</dt><dd>{activity.mcp?.tool}</dd></div>
          <div><dt>{tr("状态", "Status")}</dt><dd className={`mcp-call-status is-${status}`}>{status === "running" ? tr("正在执行", "Running") : status === "error" ? tr("执行失败", "Failed") : tr("已完成", "Completed")}</dd></div>
          {activity.command ? <div><dt>{tr("命令", "Command")}</dt><dd><pre>{activity.command}</pre></dd></div> : null}
          {activity.path ? <div><dt>{tr("路径", "Path")}</dt><dd>{activity.path}</dd></div> : null}
        </dl>
        <p className="mcp-detail-muted">{tr("此记录未包含完整输入参数。", "Full input parameters are not included in this record.")}</p>
      </> : tab === "raw" ? <>
        <div className="mcp-result-heading"><span>{tr("响应内容", "Response content")}</span>
          <button type="button" className="mcp-detail-action" disabled={!body} onClick={() => {
            void navigator.clipboard.writeText(body).then(() => setCopyState("copied"), () => setCopyState("failed"));
          }}>{tr("复制", "Copy")}</button></div>
        <span className="mcp-copy-feedback" role="status">{copyState === "copied" ? tr("已复制", "Copied") : copyState === "failed" ? tr("复制失败，请选择文本复制", "Copy failed. Select the text to copy.") : ""}</span>
        {body ? <pre className="mcp-response-code">{raw}</pre> : <p className="mcp-detail-muted">{tr("暂无响应内容", "No response yet")}</p>}
      </> : status === "error" ? <div className="mcp-result-error" role="alert"><strong>{tr("调用失败", "Call failed")}</strong>
        <div className="tool-markdown tool-error"><Markdown text={body ? localizeError(body) : tr("执行失败", "Execution failed")} /></div></div>
        : !body ? <p className="mcp-detail-muted">{status === "running" ? tr("正在等待工具返回结果…", "Waiting for tool results…") : tr("工具未返回内容", "The tool returned no content")}</p>
        : result.kind === "search" ? <>
          <div className="mcp-result-heading"><span>{tr("搜索结果", "Search results")}</span><span className="mcp-detail-muted">{trf("{0} 条", "{0} results", result.results.length)}</span></div>
          {result.results.length ? <ol className="mcp-result-list">{result.results.map((item, index) => <SearchResult key={`${item.id ?? item.url ?? item.title}-${index}`} item={item} />)}</ol>
            : <p className="mcp-detail-muted">{tr("未找到匹配结果", "No matching results")}</p>}
        </> : result.kind === "json" ? <>
          <div className="mcp-result-heading">{tr("返回内容", "Returned content")}</div>
          {result.value && typeof result.value === "object" && !Array.isArray(result.value) ? <dl className="mcp-call-fields mcp-json-fields">{Object.entries(result.value).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "string" ? value : <pre>{JSON.stringify(value, null, 2)}</pre>}</dd></div>)}</dl>
            : <pre className="mcp-response-code">{raw}</pre>}
        </> : <div className="tool-markdown tool-note"><Markdown text={result.text} /></div>}
    </div>
    </ScrollFade>
  </section>;
}

function SearchResult({ item }: { item: McpSearchResult }) {
  const locale = useAppLocale();
  const openLink = useContext(ConversationLinkContext);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const snippetRef = useRef<HTMLDivElement>(null);
  const url = mcpResultUrl(item.url);
  const date = item.timestamp ? new Date(item.timestamp) : null;
  const updated = date && Number.isFinite(date.getTime()) ? date.toLocaleDateString(intlLocale(locale), { year: "numeric", month: "short", day: "numeric" }) : null;
  useEffect(() => {
    const node = snippetRef.current;
    if (!node || expanded) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [item.highlight, expanded]);
  return <li className="mcp-search-result">
    {url ? <a className="mcp-result-title" href={url.href} target="_blank" rel="noreferrer noopener" onClick={event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (openLink?.(url.href)) event.preventDefault();
    }}><span>{item.title}</span><ExternalIcon size={14} /></a> : <div className="mcp-result-title">{item.title}</div>}
    {item.highlight ? <><div ref={snippetRef} className={`mcp-result-snippet${expanded ? " is-expanded" : ""}`}><Markdown text={item.highlight} /></div>
      {overflows || expanded ? <button className="mcp-detail-action" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? tr("收起片段", "Collapse excerpt") : tr("展开片段", "Expand excerpt")}</button> : null}</> : null}
    <div className="mcp-result-meta">{url ? <span>{url.hostname === "app.notion.com" || url.hostname === "www.notion.so" ? "Notion" : url.hostname}</span> : null}
      {item.type ? <span>{item.type === "page" ? tr("页面", "Page") : item.type}</span> : null}
      {updated ? <span title={item.timestamp}>{trf("更新于 {0}", "Updated {0}", updated)}</span> : null}</div>
    {item.id || item.url ? <details className="mcp-result-source"><summary>{tr("来源详情", "Source details")}</summary><dl className="mcp-call-fields">
      {item.url ? <div><dt>URL</dt><dd>{item.url}</dd></div> : null}{item.id ? <div><dt>ID</dt><dd>{item.id}</dd></div> : null}
    </dl></details> : null}
  </li>;
}

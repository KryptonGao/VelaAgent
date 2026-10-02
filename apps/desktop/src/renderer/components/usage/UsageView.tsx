import { useId, useMemo, useState } from "react";
import type { ProviderSummary, TraceRequest, TraceSummaryRequest } from "@vela/shared";
import { useTrace } from "../../hooks/useTrace";
import { isEnglish, localizeError, tr } from "../../locale";
import { useSlidingTabIndicator } from "../useSlidingTabIndicator";
import {
  formatUsageNumber, formatUsagePercent, summarizeUsage, usageCacheHitRate,
  usageCalendar, usageCoverage, usageInputTokens, type UsageTotals,
} from "./usage-model";
import "./usage.css";

type UsageTab = "overview" | "models" | "summaries" | "providers" | "coverage";

function TokenValue({ value, metered }: { value: number; metered: number }) {
  return <span title={metered > 0 ? value.toLocaleString(isEnglish() ? "en-US" : "zh-CN") : undefined}>
    {metered > 0 ? formatUsageNumber(value, isEnglish()) : "—"}
  </span>;
}

function UsageShare({ value, total }: { value: number; total: number }) {
  const share = total > 0 ? value / total : null;
  return <div className="usage-share" title={tr("占已记录 Token 总数的比例", "Share of recorded tokens")}>
    <span className="usage-share-track" aria-hidden="true"><span style={{ width: `${(share ?? 0) * 100}%` }} /></span>
    <span>{formatUsagePercent(share)}</span>
  </div>;
}

function UsageOverview({ totals, activeDays, undated, settings }: { totals: UsageTotals; activeDays: number; undated: number; settings: boolean }) {
  const cards = [
    [tr("请求数", "Requests"), formatUsageNumber(totals.requests, isEnglish())],
    [tr("已计量", "Metered"), formatUsageNumber(totals.metered, isEnglish())],
    [tr("Token 总数", "Total tokens"), <TokenValue value={totals.totalTokens} metered={totals.metered} />],
    [tr("缓存命中 Token", "Cache read tokens"), <TokenValue value={totals.cacheRead} metered={totals.metered} />],
    [tr("覆盖率", "Coverage"), formatUsagePercent(usageCoverage(totals))],
    [tr("活跃天数", "Active days"), activeDays > 0 || undated === 0 ? String(activeDays) : "—"],
  ] as const;
  return <>
    <div className="usage-summary-grid">
      {cards.map(([label, value]) => <div className="usage-summary-card" key={label}>
        <span>{label}</span><strong>{value}</strong>
      </div>)}
    </div>
    <p className="usage-note">{settings
      ? tr("已计量表示提供方返回了 Token 用量；覆盖率 = 已计量请求数 / 请求总数。分支对话复制的历史请求只计一次。", "Metered requests have token usage reported by the provider; coverage = metered requests / all requests. History copied into conversation branches is counted once.")
      : tr("统计当前对话中的模型请求。已计量表示提供方返回了 Token 用量；覆盖率 = 已计量请求数 / 请求总数。", "Model requests in this conversation. Metered requests have token usage reported by the provider; coverage = metered requests / all requests.")}
      {undated > 0 ? ` ${tr(`${undated} 个请求缺少日期，未计入活跃天数。`, `${undated} requests have no date and are excluded from active days.`)}` : ""}
    </p>
  </>;
}

export function UsageView({ conversationId, providers }: {
  conversationId: string | null;
  providers: Pick<ProviderSummary, "id" | "name">[];
}) {
  const { trace, loading, error } = useTrace(conversationId);
  return <UsageReport requests={trace.requests} summaries={trace.summaries} providers={providers} loading={loading} error={error} warning={trace.warning} />;
}

export function UsageReport({ requests, summaries = [], providers, loading = false, error = null, warning = null, settings = false, start = "", end = "" }: {
  requests: TraceRequest[];
  summaries?: TraceSummaryRequest[];
  providers: Pick<ProviderSummary, "id" | "name">[];
  loading?: boolean;
  error?: string | null;
  warning?: string | null;
  settings?: boolean;
  start?: string;
  end?: string;
}) {
  const stats = useMemo(() => summarizeUsage(requests), [requests]);
  const summaryStats = useMemo(() => summarizeUsage(summaries), [summaries]);
  const providerNames = useMemo(() => new Map(providers.map(provider => [provider.id, provider.name])), [providers]);
  const providerName = (id: string) => providerNames.get(id) ?? (id || tr("未知提供方", "Unknown provider"));
  const [tab, setTab] = useState<UsageTab>("overview");
  const [search, setSearch] = useState("");
  const tabIndicator = useSlidingTabIndicator({ activeKey: tab });
  const id = useId();
  const models = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return stats.models.filter(model => model.model.toLocaleLowerCase().includes(query));
  }, [stats.models, search]);
  const tabs: { key: UsageTab; label: string; value: string }[] = [
    { key: "overview", label: tr("概览", "Overview"), value: String(stats.totals.requests) },
    { key: "models", label: tr("模型", "Models"), value: String(stats.models.length) },
    { key: "summaries", label: tr("思考内容总结模型", "Thinking summary model"), value: String(summaryStats.totals.requests) },
    { key: "providers", label: tr("提供方", "Providers"), value: String(stats.providers.length) },
    { key: "coverage", label: tr("覆盖率明细", "Coverage details"), value: formatUsagePercent(usageCoverage(stats.totals)) },
  ];
  return <section className="usage-view" aria-label={tr("使用统计", "Usage statistics")} aria-busy={loading}>
    <nav className="usage-tabs" role="tablist" aria-label={tr("使用统计页面", "Usage pages")}
      ref={tabIndicator.navRef} onPointerMove={tabIndicator.onPointerMove} onPointerLeave={tabIndicator.onPointerLeave}>
      {tabs.map(({ key, label, value }, index) => <button key={key} id={`${id}-${key}`} type="button"
        role="tab" data-tab-key={key} ref={tabIndicator.registerTab(key)} aria-selected={tab === key} aria-controls={`${id}-panel`} tabIndex={tab === key ? 0 : -1}
        onClick={() => setTab(key)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
            : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          setTab(tabs[next]!.key);
          document.getElementById(`${id}-${tabs[next]!.key}`)?.focus();
        }}>
        {label}<span>{loading ? "—" : value}</span>
      </button>)}
      {tabIndicator.indicator}
    </nav>
    <div className="usage-content" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {loading ? <p className="usage-empty" role="status">{tr("正在加载使用统计…", "Loading usage statistics…")}</p> : <>
        {error ? <p className="usage-warning" role="alert">{tr("使用统计加载失败：", "Could not load usage statistics: ")}{localizeError(error)}</p> : null}
        {warning ? <p className="usage-warning" role="status">{localizeError(warning)}</p> : null}
        {!error || stats.totals.requests > 0 ? <>
          {tab === "overview" ? <UsageOverview totals={stats.totals} activeDays={stats.activeDays} undated={stats.undated} settings={settings} /> : null}
          {settings && tab === "overview" ? <UsageActivity days={stats.days} start={start} end={end} /> : null}
          {stats.totals.requests === 0 && summaryStats.totals.requests === 0 ? <p className="usage-empty">{settings
            ? tr("所选范围内没有模型请求。可调整时间范围或提供方。", "No model requests in this range. Try a different date range or provider.")
            : tr("当前对话还没有模型请求，开始对话后会在这里显示使用统计。", "This conversation has no model requests yet. Usage will appear here after you start chatting.")}</p> : <>
            {tab === "overview" || tab === "models" ? <section className="usage-section" aria-labelledby={`${id}-models-title`}>
              <h2 id={`${id}-models-title`}>{tr("模型", "Models")}</h2>
              <input className="usage-search" type="search" value={search} onChange={event => setSearch(event.target.value)}
                placeholder={tr("搜索模型…", "Search models…")} aria-label={tr("搜索模型", "Search models")} />
              <div className="usage-table-scroll" tabIndex={0} role="region" aria-label={tr("模型使用统计表", "Model usage table")}>
                <table className="usage-table usage-model-table">
                  <thead><tr>
                    <th scope="col">{tr("模型", "Model")}</th><th scope="col">{tr("提供方", "Provider")}</th>
                    <th scope="col">{tr("占比", "Share")}</th><th scope="col">{tr("Token 数", "Tokens")}</th>
                    <th scope="col">{tr("请求数", "Requests")}</th><th scope="col">{tr("已计量", "Metered")}</th>
                    <th scope="col">{tr("输入 Token", "Input tokens")}</th><th scope="col">{tr("输出 Token", "Output tokens")}</th>
                    <th scope="col">{tr("缓存命中 Token", "Cache read tokens")}</th><th scope="col">{tr("缓存写入 Token", "Cache write tokens")}</th>
                    <th scope="col">{tr("命中率", "Cache hit rate")}</th>
                  </tr></thead>
                  <tbody>{models.map(model => <tr key={model.key}>
                    <th scope="row" className="usage-model-name">{model.model || tr("未知模型", "Unknown model")}</th>
                    <td className="usage-provider-name">{providerName(model.provider)}</td>
                    <td><UsageShare value={model.totalTokens} total={stats.totals.totalTokens} /></td>
                    <td><TokenValue value={model.totalTokens} metered={model.metered} /></td>
                    <td>{model.requests.toLocaleString()}</td><td>{model.metered.toLocaleString()}</td>
                    <td><TokenValue value={usageInputTokens(model)} metered={model.metered} /></td>
                    <td><TokenValue value={model.output} metered={model.metered} /></td>
                    <td><TokenValue value={model.cacheRead} metered={model.metered} /></td>
                    <td><TokenValue value={model.cacheWrite} metered={model.metered} /></td>
                    <td>{formatUsagePercent(usageCacheHitRate(model))}</td>
                  </tr>)}</tbody>
                </table>
                {models.length === 0 ? <p className="usage-empty">{tr("没有匹配的模型", "No matching models")}</p> : null}
              </div>
              <p className="usage-note">{tr("输入 Token 包含缓存命中与缓存写入；占比按已记录的 Token 总数计算。", "Input tokens include cache reads and writes. Shares are based on recorded token totals.")}</p>
            </section> : null}
            {tab === "summaries" ? <section className="usage-section" aria-labelledby={`${id}-summaries-title`}>
              <h2 id={`${id}-summaries-title`}>{tr("思考内容总结模型", "Thinking summary model")}</h2>
              <div className="usage-summary-grid">
                {([
                  [tr("请求数", "Requests"), formatUsageNumber(summaryStats.totals.requests, isEnglish())],
                  [tr("已计量", "Metered"), formatUsageNumber(summaryStats.totals.metered, isEnglish())],
                  [tr("Token 总数", "Total tokens"), <TokenValue value={summaryStats.totals.totalTokens} metered={summaryStats.totals.metered} />],
                  [tr("缓存命中 Token", "Cache read tokens"), <TokenValue value={summaryStats.totals.cacheRead} metered={summaryStats.totals.metered} />],
                  [tr("覆盖率", "Coverage"), formatUsagePercent(usageCoverage(summaryStats.totals))],
                ] as const).map(([label, value]) => <div className="usage-summary-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
              </div>
              {summaryStats.totals.requests === 0 ? <p className="usage-empty">{settings
                ? tr("所选范围内没有思考内容总结请求。", "No thinking summary requests in this range.")
                : tr("当前对话还没有思考内容总结请求。开启思考总结并完成一段思考后会在这里显示。", "This conversation has no thinking summary requests yet. Enable summaries and finish a thinking passage to see usage here.")}</p> : <div className="usage-table-scroll" tabIndex={0} role="region" aria-label={tr("思考内容总结模型使用统计表", "Thinking summary model usage table")}>
                <table className="usage-table usage-model-table">
                  <thead><tr>
                    <th scope="col">{tr("模型", "Model")}</th><th scope="col">{tr("提供方", "Provider")}</th>
                    <th scope="col">{tr("占比", "Share")}</th><th scope="col">{tr("Token 数", "Tokens")}</th>
                    <th scope="col">{tr("请求数", "Requests")}</th><th scope="col">{tr("已计量", "Metered")}</th>
                    <th scope="col">{tr("输入 Token", "Input tokens")}</th><th scope="col">{tr("输出 Token", "Output tokens")}</th>
                    <th scope="col">{tr("缓存命中 Token", "Cache read tokens")}</th><th scope="col">{tr("缓存写入 Token", "Cache write tokens")}</th>
                    <th scope="col">{tr("命中率", "Cache hit rate")}</th>
                  </tr></thead>
                  <tbody>{summaryStats.models.map(model => <tr key={model.key}>
                    <th scope="row" className="usage-model-name">{model.model || tr("未知模型", "Unknown model")}</th>
                    <td className="usage-provider-name">{providerName(model.provider)}</td>
                    <td><UsageShare value={model.totalTokens} total={summaryStats.totals.totalTokens} /></td>
                    <td><TokenValue value={model.totalTokens} metered={model.metered} /></td>
                    <td>{model.requests.toLocaleString()}</td><td>{model.metered.toLocaleString()}</td>
                    <td><TokenValue value={usageInputTokens(model)} metered={model.metered} /></td>
                    <td><TokenValue value={model.output} metered={model.metered} /></td>
                    <td><TokenValue value={model.cacheRead} metered={model.metered} /></td>
                    <td><TokenValue value={model.cacheWrite} metered={model.metered} /></td>
                    <td>{formatUsagePercent(usageCacheHitRate(model))}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
              <p className="usage-note">{tr("这些请求由思考内容总结功能发起，使用设置中指定的专属总结模型；未指定时使用发起总结时对话选定的模型。它们不计入其他标签页的请求与 Token 统计。", "These requests are made by the thinking summary feature using the dedicated summary model from settings, or the conversation's model when none is set. They are not counted in the other tabs.")}</p>
            </section> : null}
            {tab === "overview" || tab === "providers" ? <section className="usage-section" aria-labelledby={`${id}-providers-title`}>
              <h2 id={`${id}-providers-title`}>{tr("提供方", "Providers")}</h2>
              <div className="usage-table-scroll" tabIndex={0} role="region" aria-label={tr("提供方使用统计表", "Provider usage table")}>
                <table className="usage-table usage-provider-table">
                  <thead><tr><th scope="col">{tr("提供方", "Provider")}</th><th scope="col">{tr("请求数", "Requests")}</th>
                    <th scope="col">{tr("已计量", "Metered")}</th><th scope="col">{tr("Token 数", "Tokens")}</th>
                    <th scope="col">{tr("占比", "Share")}</th></tr></thead>
                  <tbody>{stats.providers.map(provider => <tr key={provider.provider}>
                    <th scope="row">{providerName(provider.provider)}</th><td>{provider.requests.toLocaleString()}</td>
                    <td>{provider.metered.toLocaleString()}</td><td><TokenValue value={provider.totalTokens} metered={provider.metered} /></td>
                    <td><UsageShare value={provider.totalTokens} total={stats.totals.totalTokens} /></td>
                  </tr>)}</tbody>
                </table>
              </div>
            </section> : null}
            {tab === "coverage" || (settings && tab === "overview") ? <section className="usage-section" aria-labelledby={`${id}-coverage-title`}>
              <h2 id={`${id}-coverage-title`}>{tr("覆盖率明细", "Coverage details")}</h2>
              <div className="usage-summary-grid">
                {([
                  [tr("已计量", "Metered"), stats.totals.metered],
                  [tr("提供方上报", "Provider reported"), stats.totals.metered],
                  [tr("估算", "Estimated"), 0],
                  [tr("未上报", "Not reported"), stats.totals.requests - stats.totals.metered],
                  [tr("不支持", "Unsupported"), "—"],
                ] as const).map(([label, value]) => <div className="usage-summary-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
              </div>
              <p className="usage-note">{tr("仅统计提供方上报的用量，不估算 Token。现有记录无法区分未上报与不支持，因此不支持显示为未知。", "Only provider-reported usage is counted; tokens are not estimated. Existing records cannot distinguish unsupported usage from missing reports, so unsupported is shown as unknown.")}</p>
              <p className="usage-note">{tr("覆盖率反映请求的用量记录完整度。进行中或未返回用量的请求仍计入请求数；Token 总数仅汇总已计量请求。缓存命中率 = 缓存命中 Token / 输入 Token。", "Coverage reflects how many requests have usage records. Running requests and requests without reported usage still count as requests; token totals only include metered requests. Cache hit rate = cache read tokens / input tokens.")}</p>
              <div className="usage-table-scroll" tabIndex={0} role="region" aria-label={tr("覆盖率明细表", "Usage coverage table")}>
                <table className="usage-table usage-coverage-table">
                  <thead><tr><th scope="col">{tr("模型", "Model")}</th><th scope="col">{tr("提供方", "Provider")}</th>
                    <th scope="col">{tr("请求数", "Requests")}</th><th scope="col">{tr("已计量", "Metered")}</th>
                    <th scope="col">{tr("未计量", "Unmetered")}</th><th scope="col">{tr("覆盖率", "Coverage")}</th>
                    <th scope="col">{tr("缓存命中率", "Cache hit rate")}</th></tr></thead>
                  <tbody>{stats.models.map(model => <tr key={model.key}>
                    <th scope="row" className="usage-model-name">{model.model || tr("未知模型", "Unknown model")}</th>
                    <td className="usage-provider-name">{providerName(model.provider)}</td>
                    <td>{model.requests.toLocaleString()}</td><td>{model.metered.toLocaleString()}</td>
                    <td>{(model.requests - model.metered).toLocaleString()}</td><td>{formatUsagePercent(usageCoverage(model))}</td>
                    <td>{formatUsagePercent(usageCacheHitRate(model))}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </section> : null}
          </>}
        </> : null}
      </>}
    </div>
  </section>;
}

function UsageActivity({ days, start, end }: { days: Map<string, UsageTotals>; start: string; end: string }) {
  const lastDay = end ? new Date(`${end}T12:00:00`) : new Date();
  const calendar = usageCalendar(lastDay);
  const offset = new Date(`${calendar[0]}T12:00:00`).getDay();
  const cells = [...Array.from({ length: offset }, () => null), ...calendar];
  const maximum = Math.max(1, ...[...days.values()].map(day => day.requests));
  const locale = isEnglish() ? "en-US" : "zh-CN";
  const gridTemplateColumns = `repeat(${Math.ceil(cells.length / 7)}, minmax(10px, 1fr))`;
  return <section className="usage-activity" aria-label={tr("每日活动", "Daily activity")}>
    <h2>{tr("每日活动", "Daily activity")}</h2>
    <p className="usage-note">{tr("按每日请求数显示最近一年，颜色越深表示请求越多。", "Requests per day over the last year. Darker cells indicate more requests.")}</p>
    <div className="usage-heatmap-scroll" tabIndex={0} role="region" aria-label={tr("每日请求活动图", "Daily request activity chart")}>
      <div className="usage-heatmap-months" aria-hidden="true" style={{ gridTemplateColumns }}>
        {Array.from({ length: Math.ceil(cells.length / 7) }, (_, index) => {
          const date = cells.slice(index * 7, index * 7 + 7).find(day => day?.endsWith("-01")) ?? (index === 0 ? calendar[0] : null);
          return <span key={index}>{date ? new Date(`${date}T12:00:00`).toLocaleDateString(locale, { month: "short" }) : ""}</span>;
        })}
      </div>
      <div className="usage-heatmap" style={{ gridTemplateColumns }}>
        {cells.map((day, index) => {
          if (!day) return <span key={`blank-${index}`} className="usage-heatmap-blank" />;
          const count = days.get(day)?.requests ?? 0;
          const excluded = Boolean((start && day < start) || (end && day > end));
          const level = count === 0 ? 0 : Math.max(1, Math.ceil(count / maximum * 4));
          const label = excluded ? tr(`${day}：不在所选范围`, `${day}: outside selected range`)
            : tr(`${day}：${count} 次请求`, `${day}: ${count} requests`);
          return <span key={day} className={`usage-heatmap-cell level-${level}${excluded ? " excluded" : ""}`}
            role="img" aria-label={label} title={label} />;
        })}
      </div>
    </div>
    <div className="usage-heatmap-legend" aria-label={tr("活动强度：少到多", "Activity intensity: less to more")}>
      <span>{tr("少", "Less")}</span>{[0, 1, 2, 3, 4].map(level => <span key={level} className={`usage-heatmap-cell level-${level}`} aria-hidden="true" />)}<span>{tr("多", "More")}</span>
    </div>
    {days.size > 0 ? <details className="usage-daily-details"><summary>{tr("查看每日请求明细", "View daily request counts")}</summary>
      <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th scope="col">{tr("日期", "Date")}</th><th scope="col">{tr("请求数", "Requests")}</th><th scope="col">{tr("Token 数", "Tokens")}</th></tr></thead>
        <tbody>{[...days].sort(([a], [b]) => b.localeCompare(a)).map(([day, total]) => <tr key={day}><th scope="row">{day}</th><td>{total.requests}</td><td><TokenValue value={total.totalTokens} metered={total.metered} /></td></tr>)}</tbody>
      </table></div>
    </details> : null}
  </section>;
}

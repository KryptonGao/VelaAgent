import { useId, useMemo, useState } from "react";
import type { ConversationSummary, ProviderSummary } from "@vela/shared";
import { useUsageHistory } from "../../hooks/useUsageHistory";
import { tr, trf } from "../../locale";
import { UsageReport } from "./UsageView";
import { filterUsageRequests, requestDate, summarizeUsage, usageDateKey } from "./usage-model";

type Range = "all" | "30" | "7" | "custom";

export function SettingsUsageView({ conversations, providers }: {
  conversations: ConversationSummary[];
  providers: Pick<ProviderSummary, "id" | "name">[];
}) {
  const history = useUsageHistory(conversations);
  const [range, setRange] = useState<Range>("30");
  const [provider, setProvider] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const id = useId();
  const today = usageDateKey(new Date());
  const firstDay = new Date(`${today}T12:00:00`);
  firstDay.setDate(firstDay.getDate() - (range === "7" ? 6 : 29));
  const filterStart = range === "all" ? "" : range === "custom" ? start : usageDateKey(firstDay);
  const filterEnd = range === "all" ? "" : range === "custom" ? end : today;
  const invalidRange = range === "custom" && Boolean(start && end && start > end);
  const requests = useMemo(() => invalidRange ? [] : filterUsageRequests(history.requests, {
    provider, start: filterStart, end: filterEnd,
  }), [history.requests, provider, filterStart, filterEnd, invalidRange]);
  const summaryRequests = useMemo(() => invalidRange ? [] : filterUsageRequests(history.summaryRequests, {
    provider, start: filterStart, end: filterEnd,
  }), [history.summaryRequests, provider, filterStart, filterEnd, invalidRange]);
  const available = useMemo(() => summarizeUsage([...history.requests, ...history.summaryRequests]).providers, [history.requests, history.summaryRequests]);
  const missingDates = history.requests.filter(request => requestDate(request) === null).length;
  const providerNames = new Map(providers.map(item => [item.id, item.name]));
  return <section className="settings-usage" data-setting-id="usage" aria-labelledby={`${id}-title`}>
    <div className="usage-heading">
      <div><h2 id={`${id}-title`}>{tr("使用统计", "Usage statistics")}</h2>
        <p className="usage-note">{tr("汇总本地所有对话（含归档）的模型请求与 Token 用量。缺失的用量不会显示为零。", "Model requests and token usage across all local conversations, including archived chats. Missing usage is never shown as zero.")}</p>
      </div>
      <button type="button" className="settings-secondary" onClick={history.refresh} disabled={history.loading}>
        {tr("刷新", "Refresh")}
      </button>
    </div>
    <div className="usage-filters">
      <label className="usage-provider-filter">{tr("提供方", "Provider")}
        <select value={provider} onChange={event => setProvider(event.target.value)}>
          <option value="">{tr("全部", "All")}</option>
          {available.filter(item => item.provider).map(item => <option key={item.provider} value={item.provider}>
            {providerNames.get(item.provider) ?? item.provider}
          </option>)}
        </select>
      </label>
      <div className="usage-range" role="group" aria-label={tr("时间范围", "Date range")}>
        {([ ["all", tr("可用历史", "All history")], ["30", tr("30 天", "30 days")],
          ["7", tr("7 天", "7 days")], ["custom", tr("自定义", "Custom")] ] as const).map(([key, label]) =>
          <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)}>{label}</button>)}
      </div>
    </div>
    {range === "custom" ? <div className="usage-date-range">
      <label>{tr("开始日期", "Start date")}<input type="date" value={start} onChange={event => setStart(event.target.value)}
        onInput={event => setStart(event.currentTarget.value)}
        aria-invalid={invalidRange} aria-describedby={invalidRange ? `${id}-range-error` : undefined} /></label>
      <label>{tr("结束日期", "End date")}<input type="date" value={end} onChange={event => setEnd(event.target.value)}
        onInput={event => setEnd(event.currentTarget.value)}
        aria-invalid={invalidRange} aria-describedby={invalidRange ? `${id}-range-error` : undefined} /></label>
      {invalidRange ? <p className="usage-warning" id={`${id}-range-error`} role="alert">{tr("结束日期不能早于开始日期。", "The end date must be on or after the start date.")}</p> : null}
    </div> : null}
    {history.failed || history.warnings ? <p className="usage-warning" role="status">
      {trf("{0} 个对话加载失败，{1} 个对话的记录不完整；当前统计可能不完整，可点击刷新重试。", "{0} conversations failed to load; {1} have incomplete records. Statistics may be incomplete. Refresh to retry.", history.failed, history.warnings)}
    </p> : null}
    {missingDates > 0 && (filterStart || filterEnd) ? <p className="usage-note">
      {trf("{0} 个请求缺少日期，未纳入日期筛选；可在「可用历史」中查看。", "{0} undated requests are excluded from date filters. Select All history to include them.", missingDates)}
    </p> : null}
    <UsageReport requests={requests} summaries={summaryRequests} providers={providers} loading={history.loading} settings
      start={filterStart} end={filterEnd} />
  </section>;
}

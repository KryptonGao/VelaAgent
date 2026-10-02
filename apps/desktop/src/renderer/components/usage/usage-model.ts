import type { TraceRequest, TraceUsage } from "@vela/shared";

/** Minimal shape shared by turn requests and standalone summary requests. */
export interface UsageRecord {
  id: string;
  model: string;
  startedAt: number | null;
  completedAt: number | null;
  usage: TraceUsage | null;
}

export function usageDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function requestDate(request: UsageRecord): string | null {
  const timestamp = request.startedAt ?? request.completedAt;
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? usageDateKey(date) : null;
}

/** Request IDs are local counters. Forks copy dated requests, so count shared history once. */
export function collectUsageRequests(conversations: { id: string; requests: TraceRequest[] }[]): TraceRequest[] {
  const requests = new Map<string, TraceRequest>();
  for (const conversation of conversations) {
    for (const request of conversation.requests) {
      const key = JSON.stringify([requestDate(request) === null ? conversation.id : null,
        request.id, request.model, request.contextId, request.startedAt, request.completedAt]);
      const previous = requests.get(key);
      if (!previous || request.usage || !previous.usage) requests.set(key, { ...request, id: key });
    }
  }
  return [...requests.values()];
}

export function filterUsageRequests<T extends UsageRecord>(requests: T[], filter: { provider: string; start: string; end: string }): T[] {
  return requests.filter(request => {
    if (filter.provider && !request.model.startsWith(`${filter.provider}/`)) return false;
    if (!filter.start && !filter.end) return true;
    const day = requestDate(request);
    return day !== null && (!filter.start || day >= filter.start) && (!filter.end || day <= filter.end);
  });
}

/** Calendar arithmetic keeps local days intact across DST changes. */
export function usageCalendar(end: Date, dayCount = 365): string[] {
  const day = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  day.setDate(day.getDate() - dayCount + 1);
  return Array.from({ length: dayCount }, () => {
    const key = usageDateKey(day);
    day.setDate(day.getDate() + 1);
    return key;
  });
}

export interface UsageTotals extends TraceUsage {
  requests: number;
  metered: number;
}

export interface ModelUsage extends UsageTotals {
  key: string;
  model: string;
  provider: string;
}

export interface ProviderUsage extends UsageTotals {
  provider: string;
}

function emptyTotals(): UsageTotals {
  return { requests: 0, metered: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addRequest(totals: UsageTotals, request: UsageRecord) {
  totals.requests++;
  if (!request.usage) return;
  totals.metered++;
  totals.input += request.usage.input;
  totals.output += request.usage.output;
  totals.cacheRead += request.usage.cacheRead;
  totals.cacheWrite += request.usage.cacheWrite;
  totals.totalTokens += request.usage.totalTokens;
}

export function usageCoverage(totals: UsageTotals): number | null {
  return totals.requests > 0 ? totals.metered / totals.requests : null;
}

/** Cache tokens are part of the prompt; input contains only uncached tokens. */
export function usageInputTokens(totals: TraceUsage): number {
  return totals.input + totals.cacheRead + totals.cacheWrite;
}

export function usageCacheHitRate(totals: UsageTotals): number | null {
  const input = usageInputTokens(totals);
  return totals.metered > 0 && input > 0 ? totals.cacheRead / input : null;
}

export function summarizeUsage(requests: UsageRecord[]) {
  const totals = emptyTotals();
  const models = new Map<string, ModelUsage>();
  const providers = new Map<string, ProviderUsage>();
  const days = new Map<string, UsageTotals>();
  let undated = 0;
  // Snapshot updates replace requests with the same ID; never count one twice.
  for (const request of new Map(requests.map(request => [request.id, request])).values()) {
    const separator = request.model.indexOf("/");
    const provider = separator > 0 ? request.model.slice(0, separator) : "";
    const model = separator > 0 ? request.model.slice(separator + 1) : request.model;
    let modelUsage = models.get(request.model);
    if (!modelUsage) {
      modelUsage = { ...emptyTotals(), key: request.model, provider, model };
      models.set(request.model, modelUsage);
    }
    let providerUsage = providers.get(provider);
    if (!providerUsage) {
      providerUsage = { ...emptyTotals(), provider };
      providers.set(provider, providerUsage);
    }
    addRequest(totals, request);
    addRequest(modelUsage, request);
    addRequest(providerUsage, request);
    const date = requestDate(request);
    if (date) {
      const day = days.get(date) ?? emptyTotals();
      addRequest(day, request);
      days.set(date, day);
    } else {
      undated++;
    }
  }
  const byUsage = (a: UsageTotals, b: UsageTotals) => b.totalTokens - a.totalTokens || b.requests - a.requests;
  return {
    totals,
    models: [...models.values()].sort(byUsage),
    providers: [...providers.values()].sort(byUsage),
    activeDays: days.size,
    days,
    undated,
  };
}

export function formatUsageNumber(value: number, english = false): string {
  const units: [number, string][] = english
    ? [[1e9, "B"], [1e6, "M"], [1e3, "K"]]
    : [[1e8, "亿"], [1e4, "万"]];
  const unit = units.find(([threshold]) => value >= threshold);
  if (!unit) return value.toLocaleString(english ? "en-US" : "zh-CN");
  return `${Number((value / unit[0]).toFixed(1))}${unit[1]}`;
}

export function formatUsagePercent(value: number | null): string {
  return value === null ? "—" : `${Number((value * 100).toFixed(1))}%`;
}

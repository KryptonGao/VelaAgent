import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceRequest } from "@vela/shared";
import {
  formatUsageNumber, formatUsagePercent, summarizeUsage,
  usageCacheHitRate, usageCoverage, usageInputTokens,
  collectUsageRequests, filterUsageRequests, requestDate, usageCalendar, usageDateKey,
} from "../src/renderer/components/usage/usage-model.ts";
import { emptyTrace, mergeTrace } from "../src/renderer/components/trace/trace-model.ts";

const firstDay = new Date(2026, 9, 1, 23, 59).getTime();
const secondDay = new Date(2026, 9, 2, 0, 1).getTime();
function request(id: string, extra: Partial<TraceRequest> = {}): TraceRequest {
  return {
    id, number: 1, turn: 1, model: "openai/model-a", status: "Completed", contextId: "c1",
    startedAt: firstDay, completedAt: firstDay + 1000, durationMs: 1000,
    firstTokenMs: 300, generationMs: 700,
    usage: { input: 100, output: 50, cacheRead: 800, cacheWrite: 100, totalTokens: 1050 },
    ...extra,
  };
}

describe("conversation usage statistics", () => {
  it("keeps total, model and provider counts consistent, including unmetered requests", () => {
    const stats = summarizeUsage([
      request("1"), request("2", { model: "openai/model-b", startedAt: secondDay }),
      request("3", { model: "other/model-a" }),
      request("4", { status: "Failed", usage: null }),
      request("5", { model: "other/model-a", status: "Running", usage: null, completedAt: null }),
    ]);
    assert.equal(stats.totals.requests, 5);
    assert.equal(stats.totals.metered, 3);
    assert.equal(stats.totals.totalTokens, 3150);
    assert.equal(stats.totals.cacheRead, 2400);
    assert.equal(usageInputTokens(stats.totals), 3000);
    assert.equal(usageCacheHitRate(stats.totals), 0.8);
    assert.equal(usageCoverage(stats.totals), 0.6);
    assert.equal(stats.activeDays, 2);
    assert.equal(stats.models.length, 3);
    assert.equal(stats.providers.length, 2);
    assert.deepEqual(stats.providers.map(provider => [provider.provider, provider.requests, provider.metered, provider.totalTokens]),
      [["openai", 3, 2, 2100], ["other", 2, 1, 1050]]);
    for (const field of ["requests", "metered", "input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      assert.equal(stats.models.reduce((sum, model) => sum + model[field], 0), stats.totals[field]);
      assert.equal(stats.providers.reduce((sum, provider) => sum + provider[field], 0), stats.totals[field]);
    }
  });

  it("does not invent usage or dates when records are incomplete", () => {
    const stats = summarizeUsage([request("1", {
      model: "legacy-model", startedAt: null, completedAt: null, usage: null,
    })]);
    assert.equal(stats.models[0]!.model, "legacy-model");
    assert.equal(stats.models[0]!.provider, "");
    assert.equal(stats.totals.metered, 0);
    assert.equal(usageCoverage(stats.totals), 0);
    assert.equal(usageCacheHitRate(stats.totals), null);
    assert.equal(stats.activeDays, 0);
    assert.equal(stats.undated, 1);
  });

  it("counts historical requests by completion date and keeps slashes in model IDs", () => {
    const stats = summarizeUsage([request("1", { model: "custom/org/model", startedAt: null, completedAt: secondDay })]);
    assert.equal(stats.models[0]!.provider, "custom");
    assert.equal(stats.models[0]!.model, "org/model");
    assert.equal(stats.activeDays, 1);
  });

  it("aggregates standalone summary records that omit turn-only fields", () => {
    const stats = summarizeUsage([
      { id: "summary-1", model: "opencode-go/deepseek", startedAt: firstDay, completedAt: firstDay + 100, usage: { input: 900, output: 120, cacheRead: 6400, cacheWrite: 300, totalTokens: 7420 } },
      { id: "summary-2", model: "opencode-go/deepseek", startedAt: secondDay, completedAt: secondDay + 100, usage: null },
    ]);
    assert.equal(stats.totals.requests, 2);
    assert.equal(stats.totals.metered, 1);
    assert.equal(stats.totals.totalTokens, 7420);
    assert.equal(stats.models.length, 1);
    assert.deepEqual([stats.models[0]?.provider, stats.models[0]?.model], ["opencode-go", "deepseek"]);
    assert.equal(usageCoverage(stats.totals), 0.5);
  });

  it("distinguishes reported zero usage from missing usage", () => {
    const stats = summarizeUsage([request("1", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } })]);
    assert.equal(stats.totals.metered, 1);
    assert.equal(usageCoverage(stats.totals), 1);
    assert.equal(usageCacheHitRate(stats.totals), null);
    assert.equal(stats.totals.totalTokens, 0);
  });

  it("updates live requests once and replaces statistics on rewind", () => {
    let trace = mergeTrace(emptyTrace, { version: 1, nodes: [], summaries: [], warning: null, requests: [request("1", { status: "Running", usage: null })] });
    assert.equal(summarizeUsage(trace.requests).totals.metered, 0);
    trace = mergeTrace(trace, { version: 2, nodes: [], summaries: [], warning: null, requests: [request("1")] });
    const updated = summarizeUsage(trace.requests);
    assert.equal(updated.totals.requests, 1);
    assert.equal(updated.totals.metered, 1);
    assert.equal(updated.totals.totalTokens, 1050);
    trace = mergeTrace(trace, { version: 3, nodes: [], summaries: [], warning: null, requests: [], reset: true });
    assert.equal(summarizeUsage(trace.requests).totals.requests, 0);
    assert.equal(summarizeUsage([request("1", { usage: null }), request("1")]).totals.requests, 1);
  });

  it("represents empty statistics without dividing by zero", () => {
    const stats = summarizeUsage([]);
    assert.equal(stats.activeDays, 0);
    assert.equal(usageCoverage(stats.totals), null);
    assert.equal(usageCacheHitRate(stats.totals), null);
    assert.deepEqual(stats.models, []);
    assert.deepEqual(stats.providers, []);
  });

  it("formats compact Chinese and English counts without price fields", () => {
    assert.equal(formatUsageNumber(42_848_000), "4284.8万");
    assert.equal(formatUsageNumber(406_670_000), "4.1亿");
    assert.equal(formatUsageNumber(561), "561");
    assert.equal(formatUsageNumber(42_848_000, true), "42.8M");
    assert.equal(formatUsagePercent(null), "—");
    assert.equal(formatUsagePercent(341 / 347), "98.3%");
    assert.equal(formatUsagePercent(1), "100%");
    assert.ok(Object.keys(summarizeUsage([request("1")]).totals).every(key => !/price|cost/i.test(key)));
  });
});

describe("settings usage history", () => {
  it("counts archived histories and deduplicates copied branch requests without colliding local request IDs", () => {
    const original = request("request-1");
    const independent = request("request-1", { startedAt: secondDay, completedAt: secondDay + 1000 });
    const requests = collectUsageRequests([
      { id: "original", requests: [original] },
      { id: "branch", requests: [{ ...original }, request("request-2")] },
      { id: "archived", requests: [independent] },
    ]);
    assert.equal(requests.length, 3);
    assert.equal(summarizeUsage(requests).totals.totalTokens, 3150);
    assert.equal(summarizeUsage(requests).days.get(usageDateKey(new Date(firstDay)))?.requests, 2);
    assert.equal(summarizeUsage(requests).days.get(usageDateKey(new Date(secondDay)))?.requests, 1);
  });

  it("keeps undated requests from independent conversations and prefers reported fork usage", () => {
    const undated = request("request-1", { startedAt: null, completedAt: null });
    assert.equal(collectUsageRequests([{ id: "a", requests: [undated] }, { id: "b", requests: [undated] }]).length, 2);
    const requests = collectUsageRequests([
      { id: "a", requests: [request("request-1")] },
      { id: "b", requests: [request("request-1", { usage: null })] },
    ]);
    assert.equal(summarizeUsage(requests).totals.metered, 1);
  });

  it("filters calendar dates inclusively and combines them with exact provider matches", () => {
    const day = usageDateKey(new Date(secondDay));
    const requests = [request("1"), request("2", { startedAt: secondDay }),
      request("3", { startedAt: secondDay, model: "openai-other/model-a" }),
      request("4", { startedAt: null, completedAt: null, usage: null })];
    assert.deepEqual(filterUsageRequests(requests, { provider: "openai", start: day, end: day }).map(item => item.id), ["2"]);
    assert.equal(filterUsageRequests(requests, { provider: "", start: "", end: "" }).length, 4);
    assert.equal(filterUsageRequests(requests, { provider: "", start: day, end: "" }).length, 2);
    assert.equal(filterUsageRequests(requests, { provider: "", start: day, end: "2026-09-01" }).length, 0);
  });

  it("handles local midnight, completion-only timestamps, and invalid dates", () => {
    assert.equal(requestDate(request("1", { startedAt: null, completedAt: secondDay })), usageDateKey(new Date(secondDay)));
    assert.equal(requestDate(request("2", { startedAt: NaN })), null);
    assert.equal(requestDate(request("3", { startedAt: 1e20 })), null);
    const days = usageCalendar(new Date(2026, 9, 2), 7);
    assert.equal(days.length, 7);
    assert.equal(days[0], "2026-09-26");
    assert.equal(days[6], "2026-10-02");
    assert.deepEqual(usageCalendar(new Date(2024, 2, 1), 3), ["2024-02-28", "2024-02-29", "2024-03-01"]);
    const year = usageCalendar(new Date(2026, 9, 2));
    assert.equal(new Set(year).size, 365);
    assert.equal(year.at(-1), "2026-10-02");
  });

  it("leaves missing daily usage unknown and preserves reported zero usage", () => {
    const stats = summarizeUsage([request("1", { usage: null }), request("2", {
      startedAt: secondDay, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    })]);
    assert.equal(stats.days.get(usageDateKey(new Date(firstDay)))?.metered, 0);
    assert.equal(stats.days.get(usageDateKey(new Date(secondDay)))?.metered, 1);
    assert.equal(stats.activeDays, 2);
  });
});

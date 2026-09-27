import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextUsage } from "@vela/shared";
import { composerStats, formatRate, formatSpeed, formatTokens } from "../src/renderer/components/composer/composer-stats.ts";

function usage(patch: Partial<ContextUsage> = {}): ContextUsage {
  return {
    messageCount: 0,
    toolCallCount: 0,
    turnCount: 0,
    stepCount: 0,
    tokens: 0,
    contextWindow: null,
    percent: null,
    segments: { system: 0, tools: 0, rules: 0, skills: 0, conversation: 0 },
    sessionTokens: null,
    cacheHitRate: null,
    outputSpeed: null,
    ...patch,
  };
}

describe("composer stats", () => {
  it("renders rounds, steps and speed in the first group", () => {
    const stats = composerStats(usage({ turnCount: 2, stepCount: 11, outputSpeed: 241.4 }));
    assert.equal(stats.activity, "2 轮 11 步 · 241 tok/s");
  });

  it("keeps rounds and steps when speed is not measurable yet", () => {
    assert.equal(composerStats(usage({ turnCount: 1, stepCount: 3 })).activity, "1 轮 3 步");
  });

  it("shows tokens and cache hit rate together", () => {
    const stats = composerStats(usage({ sessionTokens: 257_000, cacheHitRate: 0.968 }));
    assert.equal(stats.tokens, "257K tok · 缓存命中 97%");
  });

  it("omits fields the provider has not reported", () => {
    const stats = composerStats(usage({ turnCount: 1, stepCount: 2 }));
    assert.equal(stats.tokens, null);
    assert.equal(stats.percent, null);
    assert.equal(stats.percentLabel, null);
  });

  it("drops an all-zero session instead of printing placeholders", () => {
    const stats = composerStats(usage());
    assert.equal(stats.activity, null);
    assert.equal(stats.tokens, null);
  });

  it("tolerates a missing usage snapshot", () => {
    const stats = composerStats(undefined);
    assert.equal(stats.activity, null);
    assert.equal(stats.tokens, null);
    assert.equal(stats.percentLabel, null);
  });

  it("rounds the context percentage and keeps it available above 100", () => {
    assert.equal(composerStats(usage({ percent: 4.4 })).percentLabel, "4%");
    assert.equal(composerStats(usage({ percent: 132.6 })).percentLabel, "133%");
  });

  it("clamps nonsense rates and formats sizes", () => {
    assert.equal(formatRate(1.2), "100%");
    assert.equal(formatRate(-0.2), "0%");
    assert.equal(formatSpeed(0.42), "0.4");
    assert.equal(formatSpeed(8.75), "8.8");
    assert.equal(formatSpeed(241.4), "241");
    assert.equal(formatTokens(940), "940");
    assert.equal(formatTokens(257_000), "257K");
    assert.equal(formatTokens(1_240_000), "1.2M");
  });
});

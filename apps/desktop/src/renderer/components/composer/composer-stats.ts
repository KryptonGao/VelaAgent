import type { ContextUsage } from "@vela/shared";

/**
 * 输入框统计条的数据模型。三段都可以单独缺失：没有会话、没产生用量或提供方
 * 不上报缓存时，对应的一段整个不渲染，避免出现 "0 tok/s" 这种没意义的数字。
 */
export interface ComposerStats {
  /** 轮数 / 步数 / 速度，例如 "2 轮 11 步 · 241 tok/s"。 */
  activity: string | null;
  /** 会话累计 token 与缓存命中率，例如 "257K tok · 缓存命中 97%"。 */
  tokens: string | null;
  /** 上下文占用百分比；窗口未知时为空。 */
  percent: number | null;
  /** 占用百分比的展示文本。 */
  percentLabel: string | null;
}

export function composerStats(usage: ContextUsage | undefined | null): ComposerStats {
  const turnCount = Math.max(0, usage?.turnCount ?? 0);
  const stepCount = Math.max(0, usage?.stepCount ?? 0);
  const speed = usage?.outputSpeed ?? null;
  const sessionTokens = usage?.sessionTokens ?? null;
  const hitRate = usage?.cacheHitRate ?? null;
  const percent = usage?.percent ?? null;

  const activityParts: string[] = [];
  if (turnCount > 0 || stepCount > 0) {
    activityParts.push(`${turnCount} 轮 ${stepCount} 步`);
  }
  if (speed !== null && speed > 0) {
    activityParts.push(`${formatSpeed(speed)} tok/s`);
  }

  const tokenParts: string[] = [];
  if (sessionTokens !== null && sessionTokens > 0) {
    tokenParts.push(`${formatTokens(sessionTokens)} tok`);
  }
  if (hitRate !== null) {
    tokenParts.push(`缓存命中 ${formatRate(hitRate)}`);
  }

  return {
    activity: activityParts.length > 0 ? activityParts.join(" · ") : null,
    tokens: tokenParts.length > 0 ? tokenParts.join(" · ") : null,
    percent: percent !== null && Number.isFinite(percent) ? percent : null,
    percentLabel: percent !== null && Number.isFinite(percent) ? `${Math.round(percent)}%` : null,
  };
}

/** 速度取整；不足 1 的数字保留一位小数，免得一开始就显示成 0。 */
export function formatSpeed(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 10) return (Math.round(value * 10) / 10).toFixed(1);
  return String(Math.round(value));
}

/** 命中率按整数百分比展示，四舍五入可能得到 100%。 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  const clamped = Math.min(1, Math.max(0, rate));
  return `${Math.round(clamped * 100)}%`;
}

/** 258000 → "258K"，1_240_000 → "1.2M"；不足 1000 原样显示。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  return `${trimDecimal(value / 1000)}K`;
}

function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

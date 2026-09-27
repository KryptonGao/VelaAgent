import type { ContextUsage } from "@vela/shared";
import { composerStats } from "./composer-stats";

/**
 * 输入框下方的会话统计条：轮数/步数/速度、累计 token 与缓存命中率、上下文占用环。
 * 没有数据的分组整个不渲染，全部缺失时整条隐藏。
 */
export function ComposerStatsRow({ usage }: { usage: ContextUsage | undefined | null }) {
  const stats = composerStats(usage);
  const hasGroup = Boolean(stats.activity || stats.tokens || stats.percentLabel);
  if (!hasGroup) return null;

  return (
    <div className="composer-stats-row" role="group" aria-label="会话统计">
      {stats.activity ? (
        <span className="composer-stat" title={stats.activity}>
          <span className="composer-stat-icon" aria-hidden="true"><ActivityIcon /></span>
          <span className="composer-stat-text">{stats.activity}</span>
        </span>
      ) : null}
      {stats.tokens ? (
        <span className="composer-stat" title={stats.tokens}>
          <span className="composer-stat-icon" aria-hidden="true"><TokenStackIcon /></span>
          <span className="composer-stat-text">{stats.tokens}</span>
        </span>
      ) : null}
      {stats.percentLabel ? (
        <span
          className={`composer-stat composer-stat-context${(stats.percent ?? 0) >= 80 ? " high" : ""}`}
          title={`上下文占用 ${stats.percentLabel}`}
        >
          <ContextRing percent={stats.percent ?? 0} />
          <span className="composer-stat-text">{stats.percentLabel}</span>
        </span>
      ) : null}
    </div>
  );
}

/** 占用环：底圈固定，进度圈用 dashoffset 表现百分比。 */
function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, percent / 100));
  const offset = circumference * (1 - clamped);
  return (
    <span className="composer-stat-ring" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle className="composer-stat-ring-track" cx="7" cy="7" r={radius} />
        <circle
          className="composer-stat-ring-progress"
          cx="7"
          cy="7"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
    </span>
  );
}

function ActivityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function TokenStackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="6" rx="8" ry="3.2" />
      <path d="M4 6v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V6" />
      <path d="M4 12v6c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-6" />
    </svg>
  );
}

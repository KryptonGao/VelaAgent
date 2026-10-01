import type { AppLocale } from "@vela/shared";

/** 提交列表用的相对时间:刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期。 */
export function formatRelativeTime(ms: number, locale: AppLocale, now = Date.now()): string {
  const diff = now - ms;
  if (!Number.isFinite(ms) || diff < 0) return formatAbsoluteTime(ms, locale);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return locale === "en" ? "just now" : "刚刚";
  if (diff < hour) {
    const value = Math.floor(diff / minute);
    return locale === "en" ? `${value} min ago` : `${value} 分钟前`;
  }
  if (diff < day) {
    const value = Math.floor(diff / hour);
    return locale === "en" ? `${value} h ago` : `${value} 小时前`;
  }
  if (diff < 2 * day) return locale === "en" ? "yesterday" : "昨天";
  if (diff < 30 * day) {
    const value = Math.floor(diff / day);
    return locale === "en" ? `${value} d ago` : `${value} 天前`;
  }
  return formatAbsoluteTime(ms, locale);
}

export function formatAbsoluteTime(ms: number, locale: AppLocale): string {
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

export function formatDateOnly(ms: number, locale: AppLocale): string {
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { dateStyle: "medium" }).format(new Date(ms));
}

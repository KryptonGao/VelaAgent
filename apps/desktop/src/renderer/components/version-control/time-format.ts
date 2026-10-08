import { intlLocale, localizeTemplate, localizeZh, type AppLocale } from "@vela/shared";

/** 提交列表用的相对时间:刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期。 */
export function formatRelativeTime(ms: number, locale: AppLocale, now = Date.now()): string {
  const diff = now - ms;
  if (!Number.isFinite(ms) || diff < 0) return formatAbsoluteTime(ms, locale);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return localizeZh(locale, "刚刚", "just now");
  if (diff < hour) return localizeTemplate(locale, "{0} 分钟前", "{0} min ago", Math.floor(diff / minute));
  if (diff < day) return localizeTemplate(locale, "{0} 小时前", "{0} h ago", Math.floor(diff / hour));
  if (diff < 2 * day) return localizeZh(locale, "昨天", "yesterday");
  if (diff < 30 * day) return localizeTemplate(locale, "{0} 天前", "{0} d ago", Math.floor(diff / day));
  return formatAbsoluteTime(ms, locale);
}

export function formatAbsoluteTime(ms: number, locale: AppLocale): string {
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

export function formatDateOnly(ms: number, locale: AppLocale): string {
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium" }).format(new Date(ms));
}

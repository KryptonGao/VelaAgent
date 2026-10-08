import zhTW from "./i18n-messages/zh-TW";
import ja from "./i18n-messages/ja";
import ko from "./i18n-messages/ko";

export const appLocales = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
export type AppLocale = (typeof appLocales)[number];

/** 语言选择器里的名称，每种语言都用自己的文字显示，不随界面语言变化。 */
export const appLocaleNames: Record<AppLocale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文（台灣）",
  en: "English",
  ja: "日本語",
  ko: "한국어",
};

/** 界面里非中文、非英文语言的译文，按中文原文查找。 */
const messagesByLocale: Record<Exclude<AppLocale, "zh-CN" | "en">, Record<string, string>> = {
  "zh-TW": zhTW,
  ja,
  ko,
};

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (appLocales as readonly string[]).includes(value);
}

/** 日期、数字格式化使用的 BCP 47 标签。 */
export function intlLocale(locale: AppLocale): string {
  switch (locale) {
    case "zh-CN": return "zh-CN";
    case "zh-TW": return "zh-TW";
    case "en": return "en-US";
    case "ja": return "ja-JP";
    case "ko": return "ko-KR";
  }
}

/** 提示词里告诉模型用哪种语言写作。 */
export function modelLanguageName(locale: AppLocale): string {
  switch (locale) {
    case "zh-CN": return "Simplified Chinese";
    case "zh-TW": return "Traditional Chinese (Taiwan)";
    case "en": return "English";
    case "ja": return "Japanese";
    case "ko": return "Korean";
  }
}

/** 取单条文案：中文原文是查找键，英文作为没有译文时的兜底。 */
export function localizeZh(locale: AppLocale, zh: string, en: string): string {
  if (locale === "zh-CN") return zh;
  if (locale === "en") return en;
  return messagesByLocale[locale][zh] ?? en;
}

/** 带 {0}、{1} 占位符的文案；中文和英文模板需要按同样的参数顺序书写。 */
export function localizeTemplate(locale: AppLocale, zh: string, en: string, ...args: unknown[]): string {
  return localizeZh(locale, zh, en).replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

const copyCache = new WeakMap<object, Partial<Record<AppLocale, unknown>>>();

/**
 * 把一组中英文文案对象转成目标语言。中文对象的字符串是查找键，英文对象用作兜底；
 * 结构需要与中文对象一致。
 */
export function localizeCopy<T extends object>(locale: AppLocale, zh: T, en: T): T {
  if (locale === "zh-CN") return zh;
  if (locale === "en") return en;
  const cached = copyCache.get(zh)?.[locale];
  if (cached) return cached as T;
  const result = mapCopy(locale, zh, en) as T;
  const entry = copyCache.get(zh) ?? {};
  entry[locale] = result;
  copyCache.set(zh, entry);
  return result;
}

function mapCopy(locale: Exclude<AppLocale, "zh-CN" | "en">, value: unknown, english: unknown): unknown {
  if (typeof value === "string") {
    return messagesByLocale[locale][value] ?? (typeof english === "string" ? english : value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => mapCopy(locale, item, Array.isArray(english) ? english[index] : undefined));
  }
  if (value && typeof value === "object") {
    const source = english && typeof english === "object" ? (english as Record<string, unknown>) : {};
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapCopy(locale, item, source[key])]),
    );
  }
  return value;
}

const templatePatterns = new Map<string, RegExp>();

/**
 * 把带 {0} 占位符的动态文案（如后端返回的 “分支 foo 已存在”）按译文模板还原。
 * 只在完整匹配时返回译文；中文和英文不经过这里。
 */
export function localizeZhTemplate(locale: AppLocale, text: string): string | undefined {
  if (locale === "zh-CN" || locale === "en") return undefined;
  const dictionary = messagesByLocale[locale];
  let bestKey: string | undefined;
  let bestCaptures: string[] = [];
  for (const key of Object.keys(dictionary)) {
    if (!key.includes("{") || (bestKey && key.length <= bestKey.length)) continue;
    let pattern = templatePatterns.get(key);
    if (!pattern) {
      const source = key.split(/\{\d+\}/).map(escapeRegExp).join("(.+?)");
      pattern = new RegExp(`^${source}$`);
      templatePatterns.set(key, pattern);
    }
    const match = pattern.exec(text);
    if (match) {
      bestKey = key;
      bestCaptures = match.slice(1);
    }
  }
  if (!bestKey) return undefined;
  return dictionary[bestKey].replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = bestCaptures[Number(index)];
    return value === undefined ? placeholder : value;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

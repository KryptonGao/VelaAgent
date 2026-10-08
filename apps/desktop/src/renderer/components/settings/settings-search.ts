import type { SettingsCopy } from "../settings-copy";
import { settingsEntries, type SettingsEntry, type SettingsPageId } from "./settings-registry";

export interface ResolvedSettingsEntry {
  id: string;
  page: SettingsPageId;
  title: string;
  hint: string;
  pageLabel: string;
  keywords: string[];
}

export interface SettingsSearchResult {
  entry: ResolvedSettingsEntry;
  score: number;
}

/** 全角转半角、去重音式差异、统一小写,让「Ｔheme」「THEME」「theme」等价。 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 按当前界面语言展开文案;关键字保留中英两套,所以跨语言也能搜到。 */
export function resolveSettingsEntries(
  copy: SettingsCopy,
  entries: readonly SettingsEntry[] = settingsEntries,
): ResolvedSettingsEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    page: entry.page,
    title: entry.title(copy),
    hint: entry.hint?.(copy) ?? "",
    pageLabel: copy.pages[entry.page].label,
    keywords: [...(entry.keywords?.zh ?? []), ...(entry.keywords?.en ?? [])],
  }));
}

function scoreToken(token: string, entry: ResolvedSettingsEntry): number {
  const title = normalizeSearchText(entry.title);
  if (title === token) return 120;
  if (title.startsWith(token)) return 100;
  if (title.includes(token)) return 80;
  const keyword = entry.keywords.map(normalizeSearchText);
  if (keyword.some((item) => item === token)) return 70;
  if (keyword.some((item) => item.includes(token))) return 60;
  if (normalizeSearchText(entry.pageLabel).includes(token)) return 40;
  if (normalizeSearchText(entry.hint).includes(token)) return 20;
  return 0;
}

/** 空格分隔的每个词都要命中才算匹配;得分越高越靠前,同分保持登记顺序。 */
export function searchSettings(query: string, entries: readonly ResolvedSettingsEntry[]): SettingsSearchResult[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const results: (SettingsSearchResult & { order: number })[] = [];
  entries.forEach((entry, order) => {
    let total = 0;
    for (const token of tokens) {
      const score = scoreToken(token, entry);
      if (score === 0) return;
      total += score;
    }
    results.push({ entry, score: total, order });
  });
  results.sort((a, b) => b.score - a.score || a.order - b.order);
  return results.map(({ entry, score }) => ({ entry, score }));
}

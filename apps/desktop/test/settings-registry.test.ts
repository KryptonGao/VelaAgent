import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { settingsCopy } from "../src/renderer/components/settings-copy.ts";
import {
  groupOfPage,
  isSettingsPageId,
  settingsEntries,
  settingsGroups,
  settingsPageIds,
} from "../src/renderer/components/settings/settings-registry.ts";
import { normalizeSearchText, resolveSettingsEntries, searchSettings } from "../src/renderer/components/settings/settings-search.ts";

const componentsDir = join(import.meta.dirname, "../src/renderer/components");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? sourceFiles(join(dir, item.name)) : item.name.endsWith(".tsx") ? [join(dir, item.name)] : []);
}

test("page ids are unique and every page belongs to exactly one group", () => {
  assert.equal(new Set(settingsPageIds).size, settingsPageIds.length);
  for (const id of settingsPageIds) {
    assert.equal(settingsGroups.filter((group) => group.pages.includes(id)).length, 1, id);
    assert.ok(isSettingsPageId(id));
  }
  assert.equal(isSettingsPageId("agent"), false);
  assert.equal(groupOfPage("display"), "agent");
});

test("copy exists for every group and page in both locales", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    const copy = settingsCopy(locale);
    for (const group of settingsGroups) assert.ok(copy.groups[group.id], `${locale} group ${group.id}`);
    for (const id of settingsPageIds) {
      assert.ok(copy.pages[id].label, `${locale} label ${id}`);
      assert.ok(copy.pages[id].description, `${locale} description ${id}`);
    }
  }
});

test("search entries are unique, reference real pages and resolve to non-empty titles", () => {
  assert.equal(new Set(settingsEntries.map((entry) => entry.id)).size, settingsEntries.length);
  for (const locale of ["zh-CN", "en"] as const) {
    const copy = settingsCopy(locale);
    for (const entry of resolveSettingsEntries(copy)) {
      assert.ok(settingsPageIds.includes(entry.page), entry.id);
      assert.ok(entry.title.trim(), `${locale} title ${entry.id}`);
    }
  }
});

test("every page has at least one searchable entry", () => {
  for (const id of settingsPageIds) {
    assert.ok(settingsEntries.some((entry) => entry.page === id), `page ${id} has no entries`);
  }
});

test("registry and rendered data-setting-id anchors stay in sync", () => {
  const anchors = new Set<string>();
  for (const file of sourceFiles(componentsDir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<SettingsBlock\s+id="([a-z0-9-]+)"/g)) anchors.add(match[1]);
    for (const match of source.matchAll(/data-setting-id="([a-z0-9-]+)"/g)) anchors.add(match[1]);
  }
  const registered = new Set(settingsEntries.map((entry) => entry.id));
  assert.deepEqual([...anchors].filter((id) => !registered.has(id)).sort(), [], "anchors missing from the registry");
  assert.deepEqual([...registered].filter((id) => !anchors.has(id)).sort(), [], "registry entries without an anchor");
});

test("search matches titles in the interface language", () => {
  const zh = resolveSettingsEntries(settingsCopy("zh-CN"));
  const en = resolveSettingsEntries(settingsCopy("en"));
  assert.equal(searchSettings("思考总结", zh)[0]?.entry.id, "thinking-summary");
  assert.equal(searchSettings("thinking summaries", en)[0]?.entry.id, "thinking-summary");
  assert.equal(searchSettings("MCP", zh)[0]?.entry.page, "mcp");
});

test("search finds settings across languages through keywords", () => {
  const zh = resolveSettingsEntries(settingsCopy("zh-CN"));
  const en = resolveSettingsEntries(settingsCopy("en"));
  assert.ok(searchSettings("theme", zh).some((result) => result.entry.id === "theme"));
  assert.ok(searchSettings("主题", en).some((result) => result.entry.id === "theme"));
  assert.ok(searchSettings("sandbox", zh).some((result) => result.entry.id === "permissions"));
});

test("search requires every word, normalizes case and width, and ranks title hits first", () => {
  const en = resolveSettingsEntries(settingsCopy("en"));
  assert.deepEqual(searchSettings("   ", en), []);
  assert.deepEqual(searchSettings("zzzz-no-such-setting", en), []);
  assert.equal(normalizeSearchText("ＴＨＥＭＥ  Dark"), "theme dark");
  const ranked = searchSettings("theme", en);
  assert.equal(ranked[0].entry.id, "palette", "exact page/title prefix should outrank keyword-only hits");
  assert.ok(searchSettings("DARK mode", en).some((result) => result.entry.id === "theme"));
  assert.equal(searchSettings("theme zzzz", en).length, 0);
});

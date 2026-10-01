import { uiStorage } from "../ui-storage";
import { useCallback, useEffect, useState } from "react";
import {
  defaultDarkTheme,
  defaultLightTheme,
  isDarkTheme,
  isLightTheme,
  type ColorScheme,
  type DarkTheme,
  type LightTheme,
} from "../themes";
import type { AppLocale } from "@vela/shared";

export type InfoLayout = "sidebar" | "floating";
export type Appearance = "system" | "light" | "dark";
export type { AppLocale };

/** 对话里工具调用的展示方式:卡片可逐个展开,紧凑每行一个、多次调用折叠成摘要。 */
export type ToolDisplay = "card" | "compact";
/** 工具折叠的分组范围:按 Assistant 消息,或按界面上的位置关系跨消息合并。 */
export type ToolFold = "message" | "position";
/** 思考总结的展示方式:跟在“思考”后面、替换“思考”作为标题、或跟随回复正文样式。 */
export type ThinkingSummaryStyle = "inline" | "headline" | "prose";
export type FileIconTheme = "devicon" | "material";

const infoLayoutKey = "vela.infoLayout";
const appearanceKey = "vela.appearance";
const lightThemeKey = "vela.theme.light";
const darkThemeKey = "vela.theme.dark";
const localeKey = "vela.locale";
const toolDisplayKey = "vela.toolDisplay";
const toolFoldKey = "vela.toolFold";
const thinkingSummaryKey = "vela.thinkingSummary";
const thinkingSummaryStyleKey = "vela.thinkingSummaryStyle";
const fileIconThemeKey = "vela.fileIconTheme";
const hiddenModelsKey = "vela.hiddenModels";
const darkQuery = "(prefers-color-scheme: dark)";

/** 输入框模型列表里隐藏哪些模型，用 `provider/id` 作为唯一标识。 */
export function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function readStored<T>(key: string, accept: (value: unknown) => value is T, fallback: T): T {
  try {
    const value = uiStorage.getItem(key);
    if (accept(value)) return value;
  } catch {
    // 隐私模式无法读取本地存储时使用默认值。
  }
  return fallback;
}

function writeStored(key: string, value: string) {
  try {
    uiStorage.setItem(key, value);
  } catch {
    // 写不进去时仍保留本次会话的选择。
  }
}

function readStoredJson<T>(key: string, accept: (value: unknown) => value is T, fallback: T): T {
  try {
    const raw = uiStorage.getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    if (accept(value)) return value;
  } catch {
    // 解析失败时使用默认值。
  }
  return fallback;
}

function isHiddenModelList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAppearance(value: unknown): value is Appearance {
  return value === "light" || value === "dark" || value === "system";
}

function isLocale(value: unknown): value is AppLocale {
  return value === "en" || value === "zh-CN";
}

function isToolDisplay(value: unknown): value is ToolDisplay {
  return value === "card" || value === "compact";
}

function isToolFold(value: unknown): value is ToolFold {
  return value === "message" || value === "position";
}

function isThinkingSummaryStyle(value: unknown): value is ThinkingSummaryStyle {
  return value === "inline" || value === "headline" || value === "prose";
}

function isFileIconTheme(value: unknown): value is FileIconTheme {
  return value === "devicon" || value === "material";
}

function systemScheme(): ColorScheme {
  return window.matchMedia(darkQuery).matches ? "dark" : "light";
}

export function usePreferences() {
  const [infoLayout, setInfoLayout] = useState<InfoLayout>(() =>
    readStored(infoLayoutKey, (value): value is InfoLayout => value === "sidebar" || value === "floating", "sidebar"),
  );
  const [appearance, setAppearance] = useState<Appearance>(() => readStored(appearanceKey, isAppearance, "system"));
  const [lightTheme, setLightTheme] = useState<LightTheme>(() =>
    readStored(lightThemeKey, isLightTheme, defaultLightTheme),
  );
  const [darkTheme, setDarkTheme] = useState<DarkTheme>(() => readStored(darkThemeKey, isDarkTheme, defaultDarkTheme));
  const [system, setSystem] = useState<ColorScheme>(systemScheme);
  const [locale, setLocale] = useState<AppLocale>(() => {
    const value = readStored(localeKey, isLocale, "zh-CN");
    document.documentElement.lang = value;
    return value;
  });
  const [toolDisplay, setToolDisplay] = useState<ToolDisplay>(() =>
    readStored(toolDisplayKey, isToolDisplay, "compact"),
  );
  const [toolFold, setToolFold] = useState<ToolFold>(() =>
    readStored(toolFoldKey, isToolFold, "message"),
  );
  const [thinkingSummary, setThinkingSummary] = useState(() =>
    readStored(thinkingSummaryKey, (value): value is string => value === "true", "false") === "true",
  );
  const [thinkingSummaryStyle, setThinkingSummaryStyle] = useState<ThinkingSummaryStyle>(() =>
    readStored(thinkingSummaryStyleKey, isThinkingSummaryStyle, "inline"),
  );
  const [fileIconTheme, setFileIconTheme] = useState<FileIconTheme>(() =>
    readStored(fileIconThemeKey, isFileIconTheme, "material"),
  );
  const [hiddenModels, setHiddenModels] = useState<string[]>(() =>
    readStoredJson(hiddenModelsKey, isHiddenModelList, []),
  );

  const isModelHidden = useCallback(
    (provider: string, id: string) => hiddenModels.includes(modelKey(provider, id)),
    [hiddenModels],
  );

  const setModelHidden = useCallback((provider: string, id: string, hidden: boolean) => {
    setHiddenModels((current) => {
      const key = modelKey(provider, id);
      if (hidden) return current.includes(key) ? current : [...current, key];
      if (!current.includes(key)) return current;
      return current.filter((item) => item !== key);
    });
  }, []);

  const showAllModels = useCallback(() => setHiddenModels([]), []);

  useEffect(() => {
    const media = window.matchMedia(darkQuery);
    const update = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const scheme: ColorScheme = appearance === "system" ? system : appearance;
  const theme = scheme === "dark" ? darkTheme : lightTheme;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.scheme = scheme;
    root.dataset.theme = theme;
  }, [scheme, theme]);

  useEffect(() => writeStored(infoLayoutKey, infoLayout), [infoLayout]);
  useEffect(() => writeStored(appearanceKey, appearance), [appearance]);
  useEffect(() => writeStored(lightThemeKey, lightTheme), [lightTheme]);
  useEffect(() => writeStored(darkThemeKey, darkTheme), [darkTheme]);

  useEffect(() => {
    document.documentElement.lang = locale;
    writeStored(localeKey, locale);
  }, [locale]);

  useEffect(() => writeStored(toolDisplayKey, toolDisplay), [toolDisplay]);
  useEffect(() => writeStored(toolFoldKey, toolFold), [toolFold]);
  useEffect(() => writeStored(thinkingSummaryKey, String(thinkingSummary)), [thinkingSummary]);
  useEffect(() => writeStored(thinkingSummaryStyleKey, thinkingSummaryStyle), [thinkingSummaryStyle]);
  useEffect(() => writeStored(fileIconThemeKey, fileIconTheme), [fileIconTheme]);
  useEffect(() => writeStored(hiddenModelsKey, JSON.stringify(hiddenModels)), [hiddenModels]);

  return {
    infoLayout,
    setInfoLayout,
    appearance,
    scheme,
    theme,
    lightTheme,
    darkTheme,
    locale,
    toolDisplay,
    toolFold,
    thinkingSummary,
    thinkingSummaryStyle,
    fileIconTheme,
    hiddenModels,
    isModelHidden,
    setModelHidden,
    showAllModels,
    setAppearance,
    setLightTheme,
    setDarkTheme,
    setLocale,
    setToolDisplay,
    setToolFold,
    setThinkingSummary,
    setThinkingSummaryStyle,
    setFileIconTheme,
  };
}

export type PreferencesApi = ReturnType<typeof usePreferences>;

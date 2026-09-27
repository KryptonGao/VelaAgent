import { useEffect, useState } from "react";
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

export type Appearance = "system" | "light" | "dark";
export type { AppLocale };

/** 对话里工具调用的展示方式:卡片可逐个展开,紧凑每行一个、多次调用折叠成摘要。 */
export type ToolDisplay = "card" | "compact";
export type FileIconTheme = "devicon" | "material";

const appearanceKey = "vela.appearance";
const lightThemeKey = "vela.theme.light";
const darkThemeKey = "vela.theme.dark";
const localeKey = "vela.locale";
const toolDisplayKey = "vela.toolDisplay";
const fileIconThemeKey = "vela.fileIconTheme";
const darkQuery = "(prefers-color-scheme: dark)";

function readStored<T>(key: string, accept: (value: unknown) => value is T, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (accept(value)) return value;
  } catch {
    // 隐私模式无法读取本地存储时使用默认值。
  }
  return fallback;
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 写不进去时仍保留本次会话的选择。
  }
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

function isFileIconTheme(value: unknown): value is FileIconTheme {
  return value === "devicon" || value === "material";
}

function systemScheme(): ColorScheme {
  return window.matchMedia(darkQuery).matches ? "dark" : "light";
}

export function usePreferences() {
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
  const [fileIconTheme, setFileIconTheme] = useState<FileIconTheme>(() =>
    readStored(fileIconThemeKey, isFileIconTheme, "devicon"),
  );

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

  useEffect(() => writeStored(appearanceKey, appearance), [appearance]);
  useEffect(() => writeStored(lightThemeKey, lightTheme), [lightTheme]);
  useEffect(() => writeStored(darkThemeKey, darkTheme), [darkTheme]);

  useEffect(() => {
    document.documentElement.lang = locale;
    writeStored(localeKey, locale);
  }, [locale]);

  useEffect(() => writeStored(toolDisplayKey, toolDisplay), [toolDisplay]);
  useEffect(() => writeStored(fileIconThemeKey, fileIconTheme), [fileIconTheme]);

  return {
    appearance,
    scheme,
    theme,
    lightTheme,
    darkTheme,
    locale,
    toolDisplay,
    fileIconTheme,
    setAppearance,
    setLightTheme,
    setDarkTheme,
    setLocale,
    setToolDisplay,
    setFileIconTheme,
  };
}

export type PreferencesApi = ReturnType<typeof usePreferences>;

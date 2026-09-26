export type ColorScheme = "light" | "dark";

export const lightThemes = ["daylight", "paper", "celadon"] as const;
export const darkThemes = ["midnight", "graphite", "ember"] as const;

export type LightTheme = (typeof lightThemes)[number];
export type DarkTheme = (typeof darkThemes)[number];
export type ThemeId = LightTheme | DarkTheme;

export const defaultLightTheme: LightTheme = "daylight";
export const defaultDarkTheme: DarkTheme = "midnight";

export function isLightTheme(value: unknown): value is LightTheme {
  return (lightThemes as readonly unknown[]).includes(value);
}

export function isDarkTheme(value: unknown): value is DarkTheme {
  return (darkThemes as readonly unknown[]).includes(value);
}

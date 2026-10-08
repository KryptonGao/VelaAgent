import type { Appearance, FileIconTheme, PreferencesApi } from "../../hooks/usePreferences";
import { darkThemes, lightThemes, type ColorScheme, type DarkTheme, type LightTheme, type ThemeId } from "../../themes";
import type { SettingsCopy } from "../settings-copy";
import { Segmented, SettingsBlock } from "./primitives";
import { ThemeGroup } from "./ThemeGroup";

export function AppearancePage({ copy, preferences }: { copy: SettingsCopy; preferences: PreferencesApi }) {
  const { appearance, theme, lightTheme, darkTheme, fileIconTheme, setAppearance, setFileIconTheme } = preferences;
  const text = copy.appearance;
  // 固定为另一种明暗时,点选主题顺带切过去,否则点了看不到效果。
  const pickTheme = (scheme: ColorScheme, id: ThemeId) => {
    if (scheme === "light") preferences.setLightTheme(id as LightTheme);
    else preferences.setDarkTheme(id as DarkTheme);
    if (appearance !== "system" && appearance !== scheme) setAppearance(scheme);
  };
  const themes: { id: Appearance; label: string }[] = [
    { id: "system", label: text.system },
    { id: "light", label: text.light },
    { id: "dark", label: text.dark },
  ];
  const fileIconThemeOptions: { id: FileIconTheme; label: string }[] = [
    { id: "material", label: text.materialIconTheme },
    { id: "devicon", label: text.devicon },
  ];

  return (
    <section className="settings-section">
      <SettingsBlock id="theme" title={text.theme}>
        <Segmented label={text.theme} value={appearance} options={themes} onChange={setAppearance} />
      </SettingsBlock>
      <SettingsBlock id="palette" title={text.palette} hint={text.paletteHint}>
        <ThemeGroup
          copy={copy}
          label={text.lightThemes}
          scheme="light"
          ids={lightThemes}
          selected={lightTheme}
          active={theme}
          onPick={pickTheme}
        />
        <ThemeGroup
          copy={copy}
          label={text.darkThemes}
          scheme="dark"
          ids={darkThemes}
          selected={darkTheme}
          active={theme}
          onPick={pickTheme}
        />
      </SettingsBlock>
      <SettingsBlock id="file-icon-theme" title={text.fileIconTheme} hint={text.fileIconThemeHint}>
        <Segmented
          label={text.fileIconTheme}
          value={fileIconTheme}
          options={fileIconThemeOptions}
          onChange={setFileIconTheme}
        />
      </SettingsBlock>
    </section>
  );
}

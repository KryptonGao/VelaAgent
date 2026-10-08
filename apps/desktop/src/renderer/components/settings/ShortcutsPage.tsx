import type { SettingsCopy } from "../settings-copy";
import { SettingsBlock } from "./primitives";

export function ShortcutsPage({ copy, mod }: { copy: SettingsCopy; mod: string }) {
  const text = copy.appearance;
  const shortcuts = [
    { label: text.items.sidebar, keys: [`${mod}B`] },
    { label: text.items.panel, keys: [`${mod}J`] },
    { label: text.items.settings, keys: [`${mod},`] },
    { label: text.items.search, keys: [`${mod}F`] },
    { label: text.items.close, keys: ["Esc"] },
    { label: text.items.send, keys: ["Enter"] },
    { label: text.items.newline, keys: ["Shift", "Enter"] },
  ];

  return (
    <section className="settings-section">
      <SettingsBlock id="shortcuts" title={text.shortcuts} hint={text.shortcutsHint}>
        <div className="settings-shortcuts">
          {shortcuts.map((shortcut) => (
            <div className="settings-shortcut" key={shortcut.label}>
              <span>{shortcut.label}</span>
              <span className="settings-keys">
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </SettingsBlock>
    </section>
  );
}

import type { ColorScheme, ThemeId } from "../../themes";
import type { SettingsCopy } from "../settings-copy";

export function ThemeGroup({
  copy,
  label,
  scheme,
  ids,
  selected,
  active,
  onPick,
}: {
  copy: SettingsCopy;
  label: string;
  scheme: ColorScheme;
  ids: readonly ThemeId[];
  selected: ThemeId;
  active: ThemeId;
  onPick: (scheme: ColorScheme, id: ThemeId) => void;
}) {
  const text = copy.appearance;
  return (
    <div className="theme-group">
      <span className="theme-group-label">{label}</span>
      <div className="theme-grid" role="radiogroup" aria-label={label}>
        {ids.map((id) => {
          const meta = text.themes[id];
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={id === selected}
              className={`theme-card${id === selected ? " selected" : ""}`}
              onClick={() => onPick(scheme, id)}
            >
              <ThemePreview scheme={scheme} id={id} />
              <span className="theme-card-meta">
                <span className="theme-card-name">
                  {meta.name}
                  {id === active ? <span className="theme-card-badge">{text.inUse}</span> : null}
                </span>
                <span className="theme-card-hint">{meta.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 迷你窗口示意图;data-scheme / data-theme 让它套用对应主题的 CSS 变量。 */
function ThemePreview({ scheme, id }: { scheme: ColorScheme; id: ThemeId }) {
  return (
    <span className="theme-preview" data-scheme={scheme} data-theme={id} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <span className="theme-preview-line title" />
        <span className="theme-preview-line active" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line" />
      </span>
      <span className="theme-preview-main">
        <span className="theme-preview-bubble" />
        <span className="theme-preview-code">
          <span className="theme-preview-row">
            <span className="tok keyword" />
            <span className="tok function" />
            <span className="tok fg" />
          </span>
          <span className="theme-preview-row">
            <span className="tok indent" />
            <span className="tok type" />
            <span className="tok string" />
          </span>
          <span className="theme-preview-row">
            <span className="tok comment" />
          </span>
        </span>
        <span className="theme-preview-dock">
          <span className="theme-preview-send" />
        </span>
      </span>
    </span>
  );
}

import type { ReactNode } from "react";

interface SettingsBlockProps {
  /** 设置项锚点:搜索跳转和高亮靠它定位,必须在 settings-registry 里登记。 */
  id?: string;
  title: string;
  hint?: string;
  /** 给出后渲染成可折叠区块;搜索跳转会自动展开祖先 <details>。 */
  collapsible?: { defaultOpen?: boolean };
  children: ReactNode;
}

export function SettingsBlock({ id, title, hint, collapsible, children }: SettingsBlockProps) {
  if (collapsible) {
    return (
      <details className="settings-block settings-collapsible" data-setting-id={id} open={collapsible.defaultOpen}>
        <summary>
          <h3>{title}</h3>
        </summary>
        {hint ? <p className="settings-hint">{hint}</p> : null}
        {children}
      </details>
    );
  }
  return (
    <section className="settings-block" data-setting-id={id}>
      <h3>{title}</h3>
      {hint ? <p className="settings-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-segment" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={`settings-segment-item${option.id === value ? " active" : ""}`}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsSwitch({
  checked,
  label,
  title,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      className={`settings-skill-toggle${checked ? " on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-skill-toggle-knob" />
    </button>
  );
}

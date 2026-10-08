import { logLevels, type LogLevel, type LogSettings } from "@vela/shared";
import { useEffect, useState } from "react";
import { applyRendererLogLevel } from "../../logger";
import { localizeError } from "../../locale";
import type { SettingsCopy } from "../settings-copy";
import { SettingsBlock } from "./primitives";

export function LogsPage({ copy }: { copy: SettingsCopy }) {
  const text = copy.logs;
  const api = window.vela?.logs;
  const [settings, setSettings] = useState<LogSettings | null>(null);
  const [includeTrace, setIncludeTrace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api?.getSettings().then(next => { if (active) setSettings(next); }).catch(() => { if (active) setError(text.failed); });
    return () => { active = false; };
  }, [api, text.failed]);
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setNotice(null); setError(null);
    try { await action(); }
    catch (error) {
      const message = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "")
        : text.failed;
      setError(localizeError(message));
    }
    finally { setBusy(false); }
  }
  if (!api) return <section className="settings-section"><p className="settings-note">{text.unavailable}</p></section>;
  return <section className="settings-section" aria-busy={busy}>
    <SettingsBlock id="log-level" title={text.levelTitle} hint={settings?.locked ? text.locked : text.levelHint}>
      <select
        className="settings-select"
        aria-label={text.levelTitle}
        value={settings?.level ?? "info"}
        disabled={!settings || settings.locked || busy}
        onChange={event => {
          const level = event.target.value as LogLevel;
          void run(async () => { const next = await api.setLevel(level); setSettings(next); applyRendererLogLevel(next.level); });
        }}
      >
        {logLevels.map(level => <option key={level} value={level}>{text.levels[level]}</option>)}
      </select>
    </SettingsBlock>
    <SettingsBlock id="log-folder" title={text.folderTitle} hint={text.folderHint}>
      {settings ? <p className="settings-note"><code>{settings.dir}</code></p> : null}
      <div className="settings-actions">
        <button className="settings-secondary" type="button" disabled={busy} onClick={() => void run(() => api.openFolder())}>{text.openFolder}</button>
      </div>
    </SettingsBlock>
    <SettingsBlock id="log-export" title={text.exportTitle} hint={text.exportHint}>
      <label className="check-row">
        <input type="checkbox" checked={includeTrace} onChange={event => setIncludeTrace(event.target.checked)} />
        <span>{text.includeTrace}</span>
      </label>
      <div className="settings-actions">
        <button className="primary-btn" type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await api.export({ includeTrace });
          if (result) setNotice(text.exported(result.path));
        })}>
          {busy ? text.exporting : text.export}
        </button>
      </div>
      {notice ? <p className="settings-saved" role="status">{notice}</p> : null}
    </SettingsBlock>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </section>;
}

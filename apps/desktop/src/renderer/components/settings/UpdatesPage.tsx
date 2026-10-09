import { intlLocale, type AppLocale, type UpdateState } from "@vela/shared";
import { useState } from "react";
import { fillTemplate, useUpdates } from "../../hooks/useUpdates";
import { Markdown } from "../Markdown";
import type { SettingsCopy } from "../settings-copy";
import { SettingsBlock, SettingsSwitch } from "./primitives";

function percent(state: UpdateState): number | null {
  const progress = state.progress;
  return progress && progress.totalBytes > 0 ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)) : null;
}

export function UpdatesPage({ copy, locale }: { copy: SettingsCopy; locale: AppLocale }) {
  const text = copy.updates;
  const { state, api } = useUpdates();
  const [acting, setActing] = useState(false);
  if (!api) return <section className="settings-section"><p className="settings-note">{text.unavailable}</p></section>;
  if (!state) return <section className="settings-section" aria-busy="true" />;

  const act = async (action: () => Promise<unknown>) => {
    setActing(true);
    try { await action(); } catch { /* 错误状态由主进程推送 */ } finally { setActing(false); }
  };
  const working = acting || state.status === "checking" || state.status === "downloading";
  const progress = percent(state);
  const checkedAt = state.checkedAt ? new Date(state.checkedAt).toLocaleString(intlLocale(locale)) : null;

  let status: string;
  switch (state.status) {
    case "checking": status = text.checking; break;
    case "up-to-date": status = text.upToDate; break;
    case "available": status = fillTemplate(state.installable && !state.autoUpdate ? text.availableManual : state.installable ? text.available : text.notInstallable, state.version ?? ""); break;
    case "downloading": status = fillTemplate(text.downloading, state.version ?? ""); break;
    case "ready": status = fillTemplate(text.ready, state.version ?? ""); break;
    case "error": status = text.errors[state.error?.code ?? "unknown"]; break;
    default: status = text.idle;
  }

  return <section className="settings-section" aria-busy={working}>
    <SettingsBlock id="update-status" title={text.title}>
      <div className="update-card">
        <div className="update-card-head">
          <div className="update-card-main">
            <span className="update-version">{fillTemplate(text.versionLine, state.currentVersion)}</span>
            <span className={`update-status${state.status === "error" ? " error" : ""}`} role="status">{status}</span>
            {state.status === "ready" ? <span className="update-sub">{text.readyHint}</span> : null}
            {state.status === "downloading" ? <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
              <span style={{ width: `${progress ?? 4}%` }} />
            </div> : null}
            {checkedAt && (state.status === "up-to-date" || state.status === "available") ? <span className="update-sub">{fillTemplate(text.lastChecked, checkedAt)}</span> : null}
            {state.status === "error" && state.error?.message ? <span className="update-sub update-detail">{state.error.message}</span> : null}
          </div>
          <div className="settings-actions">
            {state.status === "ready"
              ? <button className="primary-btn" type="button" onClick={() => void act(() => api.restart())}>{text.restartNow}</button>
              : state.status === "available" && state.installable && !state.autoUpdate
                ? <button className="primary-btn" type="button" disabled={acting} onClick={() => void act(() => api.download())}>{text.downloadNow}</button>
                : state.status === "available" && !state.installable
                  ? <button className="primary-btn" type="button" onClick={() => void act(() => api.openReleasePage())}>{text.openReleasePage}</button>
                  : null}
            <button className="settings-secondary" type="button" disabled={working || state.status === "ready"} onClick={() => void act(() => api.check())}>
              {state.status === "checking" ? text.checking : text.checkNow}
            </button>
          </div>
        </div>
        {state.notes && state.version && (state.status === "available" || state.status === "downloading" || state.status === "ready") ? <details className="update-notes">
          <summary>{text.notes} · {state.version}</summary>
          <div className="update-notes-body"><Markdown text={state.notes} /></div>
        </details> : null}
      </div>
    </SettingsBlock>
    <SettingsBlock id="update-auto" title={text.autoTitle} hint={text.autoHint}>
      <SettingsSwitch checked={state.autoUpdate} label={text.autoTitle} onChange={next => void act(() => api.setAutoUpdate(next))} />
    </SettingsBlock>
  </section>;
}

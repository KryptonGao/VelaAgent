import type { AppLocale } from "@vela/shared";
import { useState } from "react";
import { fillTemplate, useUpdates } from "../hooks/useUpdates";
import "../updates.css";
import { settingsCopy } from "./settings-copy";

/**
 * 更新已下载完成时的重启提示（或这份安装只能手动下载时的提示）。
 * 「稍后」只在本次运行内收起；退出应用时已下载的更新仍会自动安装。
 */
export function UpdateNotice({ locale }: { locale: AppLocale }) {
  const { state, api } = useUpdates();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!api || !state?.version || dismissed === state.version) return null;
  const ready = state.status === "ready";
  const manual = state.status === "available" && !state.installable;
  if (!ready && !manual) return null;
  const text = settingsCopy(locale).updates;
  return <aside className="update-notice" role="status" aria-live="polite">
    <div className="update-notice-text">
      <strong>{fillTemplate(ready ? text.noticeReadyTitle : text.noticeManualTitle, state.version)}</strong>
      <span>{ready ? text.noticeReadyHint : text.noticeManualHint}</span>
    </div>
    <div className="update-notice-actions">
      <button className="primary-btn" type="button" onClick={() => void (ready ? api.restart() : api.openReleasePage()).catch(() => undefined)}>
        {ready ? text.restartNow : text.openReleasePage}
      </button>
      <button className="settings-secondary" type="button" onClick={() => setDismissed(state.version ?? null)}>{text.later}</button>
    </div>
  </aside>;
}

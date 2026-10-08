import { useEffect, useState } from "react";
import type { GitPushInput } from "@vela/shared";
import { tr, trf } from "../../locale";

/** 首次发布分支:显式选择远程与目标分支,并建立 upstream。 */
export function PushDialog({
  open,
  remotes,
  defaultBranch,
  title,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  remotes: string[];
  defaultBranch: string;
  title: string;
  confirmLabel: string;
  onClose(): void;
  onConfirm(target: GitPushInput): void;
}) {
  const [remote, setRemote] = useState(remotes[0] ?? "origin");
  const [branch, setBranch] = useState(defaultBranch);

  useEffect(() => {
    if (!open) return;
    setRemote(remotes[0] ?? "origin");
    setBranch(defaultBranch);
  }, [open, remotes, defaultBranch]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="vc-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="vc-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        {remotes.length === 0 ? (
          <div className="vc-state vc-state-error" role="alert">
            {tr("当前仓库没有配置远程。请先在终端运行 git remote add。", "No remote is configured. Run git remote add in a terminal first.")}
          </div>
        ) : (
          <>
            <label className="vc-field">
              <span>{tr("远程", "Remote")}</span>
              <select className="vc-select" value={remote} onChange={(event) => setRemote(event.target.value)}>
                {remotes.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="vc-field">
              <span>{tr("目标分支", "Target branch")}</span>
              <input className="vc-input" value={branch} onChange={(event) => setBranch(event.target.value)} />
            </label>
            <p className="vc-hint">
              {trf("将把本地 {0} 推送到 {1}/{2}，并建立跟踪关系。", "Pushes local {0} to {1}/{2} and sets the upstream.", defaultBranch, remote, branch)}
            </p>
          </>
        )}
        <div className="vc-dialog-actions">
          <button type="button" className="vc-btn vc-btn-ghost" onClick={onClose}>{tr("取消", "Cancel")}</button>
          <button
            type="button"
            className="vc-btn vc-btn-primary"
            disabled={remotes.length === 0 || !branch.trim()}
            onClick={() => onConfirm({ remote, branch: branch.trim(), setUpstream: true })}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

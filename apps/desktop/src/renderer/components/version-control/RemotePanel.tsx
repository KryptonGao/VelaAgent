import { useState } from "react";
import type { AppLocale, GitRemote, GitRemoteChange } from "@vela/shared";
import { tr } from "../../locale";
import { useDismissable } from "../../hooks/useDismissable";
import { AlertIcon, CheckIcon, PencilIcon, PlusIcon, TrashIcon } from "../icons";

/**
 * 远程管理(SY-01):添加/编辑/删除远程与 push 地址。
 * 删除会同时移除对应的远程跟踪引用;不会改动其他 Git 配置。
 */
export function RemotePanel({
  open,
  onClose,
  remotes,
  onAdd,
  onSetUrl,
  onRemove,
  onRename,
  locale,
}: {
  open: boolean;
  onClose(): void;
  remotes: GitRemote[];
  onAdd(input: { name: string; url: string; pushUrl?: string | null }): Promise<GitRemoteChange | null>;
  onSetUrl(name: string, url: string, pushUrl?: string | null): Promise<GitRemoteChange | null>;
  onRemove(name: string): Promise<GitRemoteChange | null>;
  onRename(name: string, nextName: string): Promise<GitRemoteChange | null>;
  locale: AppLocale;
}) {
  const ref = useDismissable<HTMLDivElement>(open, onClose);
  const [mode, setMode] = useState<{ kind: "add" } | { kind: "edit"; name: string } | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [pushUrl, setPushUrl] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; next: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const startAdd = () => {
    setMode({ kind: "add" });
    setName("");
    setUrl("");
    setPushUrl("");
    setError(null);
  };
  const startEdit = (remote: GitRemote) => {
    setMode({ kind: "edit", name: remote.name });
    setName(remote.name);
    setUrl(remote.fetchUrl);
    setPushUrl(remote.pushUrl !== remote.fetchUrl ? remote.pushUrl : "");
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const nextPush = pushUrl.trim() ? pushUrl.trim() : null;
    const result =
      mode?.kind === "add"
        ? await onAdd({ name: name.trim(), url: url.trim(), pushUrl: nextPush })
        : mode?.kind === "edit"
          ? await onSetUrl(mode.name, url.trim(), nextPush)
          : null;
    setBusy(false);
    if (result) setMode(null);
  };

  const rename = async (name: string, nextName: string) => {
    if (!nextName.trim() || nextName.trim() === name) {
      setRenaming(null);
      return;
    }
    const result = await onRename(name, nextName.trim());
    if (result) setRenaming(null);
  };

  const remove = async (remote: GitRemote) => {
    setConfirmRemove(null);
    await onRemove(remote.name);
  };

  return (
    <div className="vc-popover vc-remote-popover" ref={ref} role="dialog" aria-label={tr("远程管理", "Remotes")}>
      <div className="vc-ops-head">
        <b>{tr("远程管理", "Remotes")}</b>
        <button type="button" className="vc-link" onClick={startAdd}>
          <PlusIcon size={11} /> {tr("添加远程", "Add remote")}
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>
      <p className="vc-hint">
        {tr(
          "Git 命令与 PR 都使用这里配置的远程；分支的跟踪关系在分支面板中设置。",
          "Git commands and pull requests use the remotes configured here; branch tracking is set in the branches panel.",
        )}
      </p>

      {remotes.length === 0 ? <div className="vc-state">{tr("还没有配置远程", "No remotes configured")}</div> : null}
      <div className="vc-remote-list">
        {remotes.map((remote) => (
          <div key={remote.name} className="vc-remote-row">
            <div className="vc-remote-copy">
              <div className="vc-remote-name">
                <b>{remote.name}</b>
                {remote.slug ? <span className="vc-badge vc-badge-muted">{remote.slug}</span> : <span className="vc-badge vc-badge-pending">{tr("非 GitHub", "Not GitHub")}</span>}
              </div>
              <div className="vc-remote-url" title={remote.fetchUrl}>{tr("fetch", "fetch")} {remote.fetchUrl}</div>
              {remote.pushUrl && remote.pushUrl !== remote.fetchUrl ? (
                <div className="vc-remote-url" title={remote.pushUrl}>{tr("push", "push")} {remote.pushUrl}</div>
              ) : null}
            </div>
            <div className="vc-remote-actions">
              {renaming?.name === remote.name ? (
                <span className="vc-confirm">
                  <input
                    className="vc-input vc-input-inline"
                    aria-label={tr("新远程名", "New remote name")}
                    value={renaming.next}
                    autoFocus
                    onChange={(event) => setRenaming({ name: remote.name, next: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void rename(remote.name, renaming.next);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                  <button type="button" className="vc-link" onClick={() => void rename(remote.name, renaming.next)}>{tr("确定", "OK")}</button>
                  <button type="button" className="vc-link" onClick={() => setRenaming(null)}>{tr("取消", "Cancel")}</button>
                </span>
              ) : confirmRemove === remote.name ? (
                <span className="vc-confirm">
                  <button type="button" className="vc-link vc-danger" onClick={() => void remove(remote)}>
                    {tr("确认删除", "Delete")}
                  </button>
                  <button type="button" className="vc-link" onClick={() => setConfirmRemove(null)}>{tr("取消", "Cancel")}</button>
                </span>
              ) : (
                <>
                  <button type="button" className="vc-icon-btn" title={tr("编辑地址", "Edit URL")} aria-label={`${tr("编辑", "Edit")} ${remote.name}`} onClick={() => startEdit(remote)}>
                    <PencilIcon size={11} />
                  </button>
                  <button type="button" className="vc-link" onClick={() => setRenaming({ name: remote.name, next: remote.name })}>{tr("重命名", "Rename")}</button>
                  <button
                    type="button"
                    className="vc-icon-btn vc-danger"
                    title={tr("删除远程", "Remove remote")}
                    aria-label={`${tr("删除", "Remove")} ${remote.name}`}
                    onClick={() => setConfirmRemove(remote.name)}
                  >
                    <TrashIcon size={11} />
                  </button>
                </>
              )}
            </div>
            {confirmRemove === remote.name ? (
              <div className="vc-inline-notice" role="alert">
                <AlertIcon size={12} />
                {tr(
                  "删除远程会移除对应的远程跟踪引用；依赖它的分支会失去 upstream 配置。",
                  "Removing a remote deletes its remote-tracking refs; branches depending on it lose their upstream.",
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {mode ? (
        <div className="vc-remote-form">
          <div className="vc-stage-all-head">
            <b>{mode.kind === "add" ? tr("添加远程", "Add remote") : tr(`编辑远程 ${mode.name}`, `Edit remote ${mode.name}`)}</b>
          </div>
          {mode.kind === "add" ? (
            <input
              className="vc-input"
              placeholder={tr("远程名，如 origin 或 upstream", "Remote name, e.g. origin or upstream")}
              aria-label={tr("远程名", "Remote name")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          ) : null}
          <input
            className="vc-input"
            placeholder={tr("地址，如 git@github.com:owner/repo.git", "URL, e.g. git@github.com:owner/repo.git")}
            aria-label={tr("远程地址", "Remote URL")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <input
            className="vc-input"
            placeholder={tr("push 地址（可选，留空与 fetch 相同）", "Push URL (optional; same as fetch when empty)")}
            aria-label={tr("push 地址", "Push URL")}
            value={pushUrl}
            onChange={(event) => setPushUrl(event.target.value)}
          />
          {error ? <div className="vc-error-banner" role="alert"><AlertIcon size={12} />{error}</div> : null}
          <div className="vc-dialog-actions">
            <button type="button" className="vc-btn vc-btn-ghost" onClick={() => setMode(null)}>{tr("取消", "Cancel")}</button>
            <button
              type="button"
              className="vc-btn vc-btn-primary"
              disabled={busy || !url.trim() || (mode.kind === "add" && !name.trim())}
              onClick={() => void submit()}
            >
              <CheckIcon size={12} /> {mode.kind === "add" ? tr("添加", "Add") : tr("保存", "Save")}
            </button>
          </div>
        </div>
      ) : null}
      <p className="vc-hint">
        {locale === "en" ? "Only repository-level config is changed." : "只写入仓库级配置，不修改全局 Git 配置。"}
      </p>
    </div>
  );
}

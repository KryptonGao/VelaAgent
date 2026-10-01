import { useEffect, useState } from "react";
import type { AppLocale } from "@vela/shared";
import { tr } from "../../locale";
import type { VersionControlApi } from "../../hooks/useVersionControl";
import { AlertIcon, EyeIcon, StackIcon, TrashIcon } from "../icons";
import { DiffPane } from "../DiffPane";
import { formatRelativeTime } from "./time-format";

/**
 * Stash 管理(ST-01):命名保存、可选包含未跟踪文件、预览、Apply/Pop/删除。
 * Apply/Pop 冲突时 Stash 记录保留,可先处理冲突再重试。
 */
export function StashPanel({
  open,
  onClose,
  api,
  locale,
}: {
  open: boolean;
  onClose(): void;
  api: VersionControlApi;
  locale: AppLocale;
}) {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewDiff, setPreviewDiff] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);

  useEffect(() => {
    if (open) api.refreshStashes();
  }, [open, api]);

  useEffect(() => {
    if (open) {
      setMessage("");
      setIncludeUntracked(false);
      setPreviewId(null);
      setPreviewDiff("");
      setConfirmDrop(null);
    }
  }, [open]);

  // 预览按需读取;切换目标或关闭时清理旧差异。
  useEffect(() => {
    if (!previewId) {
      setPreviewDiff("");
      return;
    }
    let active = true;
    setPreviewLoading(true);
    void api.stashDiff(previewId).then((diff) => {
      if (active) {
        setPreviewDiff(diff);
        setPreviewLoading(false);
      }
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId]);

  if (!open) return null;

  return (
    <div className="vc-popover vc-stash-popover" role="dialog" aria-label={tr("Stash", "Stashes")}>
      <div className="vc-ops-head">
        <b><StackIcon size={12} /> {tr("Stash", "Stashes")}</b>
        <button type="button" className="vc-icon-btn" title={tr("刷新", "Refresh")} aria-label={tr("刷新 Stash 列表", "Refresh stashes")} onClick={api.refreshStashes}>
          <StackIcon size={12} />
        </button>
        <button type="button" className="vc-link" onClick={onClose}>{tr("关闭", "Close")}</button>
      </div>

      <div className="vc-stash-create">
        <input
          className="vc-input"
          placeholder={tr("Stash 名称（可选）", "Stash name (optional)")}
          aria-label={tr("Stash 名称", "Stash name")}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <label className="vc-radio">
          <input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} />
          {tr("包含未跟踪文件", "Include untracked files")}
        </label>
        <button
          type="button"
          className="vc-btn vc-btn-primary"
          disabled={api.busy !== null || api.guard?.agentRunning === true}
          onClick={() => {
            void api.createStash({ message, includeUntracked }).then((result) => {
              if (result?.ok) {
                setMessage("");
                setIncludeUntracked(false);
              }
            });
          }}
        >
          {api.busy === "stash" ? tr("保存中…", "Saving…") : tr("保存当前改动", "Save changes")}
        </button>
        <p className="vc-hint">
          {tr("保存后工作区会恢复干净；失败不会改动工作区。", "The working tree becomes clean after saving; a failure leaves it untouched.")}
        </p>
      </div>

      {api.stashesLoading && api.stashes.length === 0 ? <div className="vc-state">{tr("正在读取…", "Loading…")}</div> : null}
      {!api.stashesLoading && api.stashes.length === 0 ? <div className="vc-state">{tr("没有 Stash 记录", "No stashes")}</div> : null}
      <div className="vc-stash-list">
        {api.stashes.map((entry) => (
          <div key={entry.id} className="vc-stash-row">
            <div className="vc-stash-head">
              <code className="vc-stash-id">{entry.id}</code>
              <span className="vc-stash-msg" title={entry.message}>{entry.message || tr("（无说明）", "(no message)")}</span>
              {entry.branch ? <span className="vc-badge vc-badge-muted">{entry.branch}</span> : null}
              <span className="vc-hint">{entry.at ? formatRelativeTime(entry.at, locale) : ""}</span>
            </div>
            <div className="vc-stash-actions">
              <button type="button" className="vc-btn vc-btn-ghost" disabled={api.busy !== null} onClick={() => void api.applyStash(entry.id, "apply")}>
                {tr("应用（保留记录）", "Apply (keep)")}
              </button>
              <button type="button" className="vc-btn vc-btn-ghost" disabled={api.busy !== null} onClick={() => void api.applyStash(entry.id, "pop")}>
                {tr("Pop（恢复并移除）", "Pop (apply and drop)")}
              </button>
              <button type="button" className="vc-icon-btn" title={tr("预览差异", "Preview diff")} aria-label={tr("预览差异", "Preview diff")} aria-pressed={previewId === entry.id} onClick={() => setPreviewId((current) => (current === entry.id ? null : entry.id))}>
                <EyeIcon size={11} />
              </button>
              {confirmDrop === entry.id ? (
                <span className="vc-confirm">
                  <button
                    type="button"
                    className="vc-link vc-danger"
                    onClick={() => {
                      setConfirmDrop(null);
                      void api.dropStash(entry.id);
                    }}
                  >
                    {tr("确认删除", "Delete")}
                  </button>
                  <button type="button" className="vc-link" onClick={() => setConfirmDrop(null)}>{tr("取消", "Cancel")}</button>
                </span>
              ) : (
                <button type="button" className="vc-icon-btn vc-danger" title={tr("删除该记录", "Drop this stash")} aria-label={tr("删除该记录", "Drop this stash")} onClick={() => setConfirmDrop(entry.id)}>
                  <TrashIcon size={11} />
                </button>
              )}
            </div>
            {previewId === entry.id ? (
              <div className="vc-stash-diff">
                {previewLoading ? <div className="vc-state">{tr("正在读取差异…", "Loading diff…")}</div> : previewDiff ? <DiffPane path={entry.id} diff={previewDiff} mode="unified" /> : <div className="vc-state">{tr("没有可显示的差异（例如只包含未跟踪文件）", "No diff to show (e.g. only untracked files)")}</div>}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="vc-inline-notice">
        <AlertIcon size={12} />
        {tr("Apply/Pop 遇到冲突时会保留 Stash 记录，先解决冲突再重试。", "If apply/pop conflicts, the stash entry is kept; resolve the conflict and retry.")}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, PencilIcon } from "./icons";
import { localizeError, tr } from "../locale";

/** The action row remains outside the bubble, aligned with its right edge. */
export function UserMessageFrame({ text, timestamp, disabled, className, onEdit, children }: {
  text: string;
  timestamp?: number | null;
  disabled: boolean;
  className?: string;
  onEdit?: (text: string) => Promise<void>;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) { textarea.current?.focus(); textarea.current?.setSelectionRange(draft.length, draft.length); }
  }, [editing]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const date = timestamp == null ? null : new Date(timestamp);
  const validDate = date && Number.isFinite(date.getTime()) ? date : null;
  const cancel = () => { if (!saving) { setEditing(false); setError(null); window.requestAnimationFrame(() => editButton.current?.focus()); } };
  const submit = async () => {
    if (!onEdit || saving || disabled || !draft.trim()) return;
    setSaving(true);
    setError(null);
    try { await onEdit(draft.trim()); setEditing(false); }
    catch (error) { setError(error instanceof Error ? localizeError(error.message) : tr("无法修改消息", "Could not edit message")); }
    finally { setSaving(false); }
  };
  return (
    <div className={`user-msg-container${className ?? ""}`}>
      {editing ? (
        <form className="user-message-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <textarea ref={textarea} value={draft} aria-label={tr("修改消息", "Edit message")} maxLength={100_000}
            disabled={saving} rows={Math.min(10, Math.max(3, draft.split("\n").length))}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") { event.preventDefault(); cancel(); }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
            }} />
          <p className="user-edit-note">{tr("重新发送会撤回这条消息及之后的内容和文件更改，保留原图片附件。", "Resending discards this message and everything after it, restores file changes, and keeps the original images.")}</p>
          {error ? <p className="user-edit-error" role="alert">{error}</p> : null}
          <div className="user-edit-buttons">
            <button type="button" className="user-edit-cancel" disabled={saving} onClick={cancel}>{tr("取消", "Cancel")}</button>
            <button type="submit" className="user-edit-submit" disabled={saving || disabled || !draft.trim()}>{saving ? tr("正在回退…", "Rewinding…") : tr("重新发送", "Resend")}</button>
          </div>
        </form>
      ) : children}
      <div className="user-message-actions">
        {validDate ? <time dateTime={validDate.toISOString()} title={validDate.toLocaleString()}>
          {validDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
        </time> : null}
        <button className="reply-action user-message-action" type="button" disabled={!text || saving}
          title={copied ? tr("已复制", "Copied") : tr("复制消息", "Copy message")}
          aria-label={copied ? tr("已复制", "Copied") : tr("复制消息", "Copy message")}
          onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setError(null); }, () => setError(tr("复制失败，请重试", "Copy failed. Try again."))); }}>
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
        <button ref={editButton} className="reply-action user-message-action" type="button" disabled={disabled || !onEdit || saving || editing}
          title={disabled ? tr("等待当前任务完成后修改", "Wait for the current task to finish before editing") : tr("修改消息", "Edit message")}
          aria-label={tr("修改消息", "Edit message")}
          onClick={() => { setDraft(text); setError(null); setEditing(true); }}><PencilIcon size={13} /></button>
        <span className="sr-only" role="status">{copied ? tr("已复制", "Copied") : ""}</span>
      </div>
      {!editing && error ? <p className="user-edit-error" role="alert">{error}</p> : null}
    </div>
  );
}

import { conversationTitleMaxLength } from "@vela/shared";
import { useEffect, useId, useRef, useState } from "react";
import { localizeError, tr } from "../locale";

interface RenameConversationDialogProps {
  conversation: { id: string; title: string };
  onSave: (id: string, title: string) => Promise<void>;
  onClose: () => void;
}

export function RenameConversationDialog({ conversation, onSave, onClose }: RenameConversationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [title, setTitle] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog?.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]")) opener.focus();
      if (document.activeElement === document.body) document.querySelector<HTMLButtonElement>(".sidebar-search-trigger")?.focus();
    };
  }, []);

  async function save() {
    if (savingRef.current) return;
    const normalized = title.replace(/\s+/g, " ").trim();
    if (!normalized) {
      setError(tr("对话名称不能为空", "Chat name cannot be empty."));
      inputRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(conversation.id, normalized);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? localizeError(reason.message) : tr("改名失败，请重试", "Could not rename chat. Try again."));
      inputRef.current?.focus();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="rename-conversation-dialog"
      aria-labelledby={headingId}
      onCancel={event => {
        event.preventDefault();
        if (!savingRef.current) onClose();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if ((event.key === "Enter" || event.key === "Escape") && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
      }}
    >
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <h2 id={headingId}>{tr("重命名对话", "Rename chat")}</h2>
        <label htmlFor={inputId}>{tr("对话名称", "Chat name")}</label>
        <input
          ref={inputRef}
          id={inputId}
          value={title}
          maxLength={conversationTitleMaxLength}
          readOnly={saving}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          onChange={event => { setTitle(event.target.value); setError(null); }}
        />
        <p id={hintId} className="rename-conversation-hint">{tr("Enter 保存 · Esc 取消", "Enter to save · Esc to cancel")}</p>
        {error ? <p id={errorId} className="rename-conversation-error" role="alert">{error}</p> : null}
        <div className="rename-conversation-actions">
          <button type="button" disabled={saving} onClick={onClose}>{tr("取消", "Cancel")}</button>
          <button type="submit" className="rename-conversation-save" disabled={saving}>
            {saving ? tr("保存中…", "Saving…") : tr("保存", "Save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

import { useContext, useEffect, useId, useRef, useState } from "react";
import type { UiMessage } from "../hooks/useSession";
import { useDismissable } from "../hooks/useDismissable";
import { localizeError, tr } from "../locale";
import { RecipeActionsContext } from "./recipe-actions-context";
import type { RecipeMessageSeed } from "./TaskRecipesPage";
import { PopoverPresence } from "./MotionPresence";

export function ChatActionsMenu({ messages, streaming }: { messages: UiMessage[]; streaming: boolean }) {
  const actions = useContext(RecipeActionsContext);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<RecipeMessageSeed | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportingRef = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const selectedText = useRef<string | null>(null);
  const menuId = useId();
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const hasText = messages.some(message => (message.role === "user" || message.role === "assistant") && message.text.trim());
  const disabled = !actions?.conversationId || !hasText || streaming;

  useEffect(() => {
    if (open) item.current?.focus();
    else setExportError(null);
  }, [open]);

  const canExport = Boolean(actions?.conversationId) && messages.length > 0;

  /** Exports with the postmortem defaults: trace and file diffs on, thinking off. The save dialog cancels to null. */
  async function exportChat(format: "markdown" | "html") {
    const conversationId = actions?.conversationId;
    if (!canExport || !conversationId || exportingRef.current || !window.vela) return;
    exportingRef.current = true;
    setExporting(true);
    setExportError(null);
    try {
      await window.vela.exportConversation(conversationId, { format, includeTrace: true, includeDiffs: true, includeThinking: false });
      setOpen(false);
      trigger.current?.focus();
    } catch (reason) {
      setExportError(reason instanceof Error ? localizeError(reason.message) : tr("导出失败", "Export failed"));
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }

  function moveFocus(key: string) {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = key === "Home" ? 0 : key === "End" ? items.length - 1
      : key === "ArrowDown" ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1);
    items[next]?.focus();
  }

  function toggle(selection = window.getSelection()?.toString() ?? "") {
    if (!open && actions?.conversationId) {
      const candidates = messages.filter(message => (message.role === "user" || message.role === "assistant") && message.text.trim());
      const selected = selection.trim() ? candidates.findLast(message => message.text.includes(selection)) : undefined;
      const message = selected ?? candidates.at(-1);
      setSeed(message ? { text: selected ? selection : message.text, conversationId: actions.conversationId, messageId: message.id } : null);
    }
    setOpen(value => !value);
  }

  return <div className="chat-actions-anchor" ref={ref}>
    <button ref={trigger} type="button" className={`view-icon-btn${open ? " active" : ""}`}
      title={tr("更多对话操作", "More chat actions")} aria-label={tr("更多对话操作", "More chat actions")}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onPointerDown={() => { selectedText.current = window.getSelection()?.toString() ?? ""; }}
      onMouseDown={event => event.preventDefault()} onClick={() => { toggle(selectedText.current ?? undefined); selectedText.current = null; }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) toggle(); else item.current?.focus(); }
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
      </svg>
    </button>
    <PopoverPresence present={open}>
      <div ref={menu} id={menuId} className="dock-popover chat-actions-menu" data-side="below" role="menu" aria-label={tr("对话操作", "Chat actions")}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
          else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); moveFocus(event.key); }
          else if (event.key === "Tab") setOpen(false);
        }}>
        <button ref={item} type="button" role="menuitem" aria-disabled={disabled} tabIndex={-1}
          title={streaming ? tr("等待当前回复完成后创建配方", "Wait for the current reply to finish") : !hasText ? tr("对话中有文字消息后可创建配方", "Add a text message to create a recipe") : undefined}
          onClick={() => { if (disabled || !seed) return; setOpen(false); actions?.fromMessage(seed); }}>
          {tr("从对话创建配方", "Create recipe from chat")}
        </button>
        {(["markdown", "html"] as const).map(format => (
          <button key={format} type="button" role="menuitem" aria-disabled={!canExport || exporting} tabIndex={-1}
            title={canExport ? tr("导出对话、轨迹和文件 diff,用于复盘", "Export the chat with its trace and file diffs for a postmortem") : tr("对话中有消息后可导出", "Send a message to enable export")}
            onClick={() => { if (!canExport || exporting) return; void exportChat(format); }}>
            {exporting ? tr("导出中…", "Exporting…") : format === "markdown" ? tr("导出为 Markdown…", "Export as Markdown…") : tr("导出为 HTML…", "Export as HTML…")}
          </button>
        ))}
        {exportError ? <p className="chat-actions-error" role="alert">{exportError}</p> : null}
      </div>
    </PopoverPresence>
  </div>;
}

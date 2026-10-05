import { useContext, useEffect, useId, useRef, useState } from "react";
import type { UiMessage } from "../hooks/useSession";
import { useDismissable } from "../hooks/useDismissable";
import { tr } from "../locale";
import { RecipeActionsContext } from "./recipe-actions-context";
import type { RecipeMessageSeed } from "./TaskRecipesPage";
import { PopoverPresence } from "./MotionPresence";

export function ChatActionsMenu({ messages, streaming }: { messages: UiMessage[]; streaming: boolean }) {
  const actions = useContext(RecipeActionsContext);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<RecipeMessageSeed | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const selectedText = useRef<string | null>(null);
  const menuId = useId();
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const hasText = messages.some(message => (message.role === "user" || message.role === "assistant") && message.text.trim());
  const disabled = !actions?.conversationId || !hasText || streaming;

  useEffect(() => {
    if (open) item.current?.focus();
  }, [open]);

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
      <div id={menuId} className="dock-popover chat-actions-menu" data-side="below" role="menu" aria-label={tr("对话操作", "Chat actions")}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
          else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); item.current?.focus(); }
          else if (event.key === "Tab") setOpen(false);
        }}>
        <button ref={item} type="button" role="menuitem" aria-disabled={disabled} tabIndex={-1}
          title={streaming ? tr("等待当前回复完成后创建配方", "Wait for the current reply to finish") : !hasText ? tr("对话中有文字消息后可创建配方", "Add a text message to create a recipe") : undefined}
          onClick={() => { if (disabled || !seed) return; setOpen(false); actions?.fromMessage(seed); }}>
          {tr("从对话创建配方", "Create recipe from chat")}
        </button>
      </div>
    </PopoverPresence>
  </div>;
}

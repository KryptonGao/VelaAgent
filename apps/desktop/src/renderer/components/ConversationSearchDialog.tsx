import type { ConversationSummary } from "@vela/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tr } from "../locale";
import { searchActiveConversations, workspaceName } from "./conversation-search";

interface ConversationSearchDialogProps {
  id: string;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}

export function ConversationSearchDialog({ id, conversations, activeConversationId, onSelect, onNewChat, onClose }: ConversationSearchDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listId = useId();
  const labelId = useId();
  const untitledLabel = tr("新对话", "New chat");
  const results = useMemo(() => searchActiveConversations(conversations, query, untitledLabel), [conversations, query, untitledLabel]);
  const selectedIndex = Math.max(0, results.findIndex(item => item.id === selectedId));
  const selected = results[selectedIndex];

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog?.showModal();
    inputRef.current?.focus();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]")) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (selected) document.getElementById(`${listId}-${selected.id}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, selected?.id]);

  function openConversation(conversationId: string) {
    onClose();
    onSelect(conversationId);
  }

  return createPortal(
    <dialog
      id={id}
      ref={dialogRef}
      className="conversation-search-dialog"
      aria-label={tr("搜索会话", "Search chats")}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Enter" || event.key === "Escape") event.preventDefault();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!results.length) return;
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setSelectedId(results[(selectedIndex + delta + results.length) % results.length]!.id);
          inputRef.current?.focus();
        }
      }}
    >
      <form className="conversation-search-header" onSubmit={event => { event.preventDefault(); if (selected) openConversation(selected.id); }}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={tr("搜索会话标题或工作区", "Search chat titles or workspaces")}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined}
          placeholder={tr("搜索会话", "Search chats")}
          value={query}
          onChange={event => { setQuery(event.target.value); setSelectedId(null); }}
        />
        <button type="button" className="conversation-search-close" aria-label={tr("关闭搜索", "Close search")} title={tr("关闭搜索", "Close search")} onClick={onClose}>×</button>
      </form>
      <div className="conversation-search-content">
        <div id={labelId} className="conversation-search-section-label">{tr("会话", "Chats")}</div>
        <div id={listId} role="listbox" aria-labelledby={labelId} className="conversation-search-results">
          {results.map((conversation, index) => (
            <button
              id={`${listId}-${conversation.id}`}
              key={conversation.id}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={`conversation-search-result${index === selectedIndex ? " selected" : ""}`}
              title={`${conversation.title || untitledLabel}\n${conversation.cwd}`}
              onFocus={() => setSelectedId(conversation.id)}
              onClick={() => openConversation(conversation.id)}
            >
              <span className="conversation-search-result-title">{conversation.title || untitledLabel}</span>
              <span className="conversation-search-workspace">{workspaceName(conversation.cwd)}</span>
              {conversation.id === activeConversationId ? <span className="conversation-search-current">{tr("当前", "Current")}</span> : null}
            </button>
          ))}
        </div>
        {results.length === 0 ? <div className="conversation-search-empty" role="status">{query.trim() ? tr("没有匹配的会话", "No matching chats") : tr("还没有会话", "No chats yet")}</div> : null}
        <div className="conversation-search-section-label">{tr("快捷操作", "Quick actions")}</div>
        <button className="conversation-search-new" type="button" onClick={() => { onClose(); onNewChat(); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {tr("新对话", "New chat")}
        </button>
      </div>
      <div className="conversation-search-footer">{tr("↑↓ 选择 · Enter 打开 · Esc 关闭", "↑↓ to select · Enter to open · Esc to close")}</div>
    </dialog>,
    document.body,
  );
}

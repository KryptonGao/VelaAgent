import { memo, useEffect, useRef } from "react";
import type { AppLocale, ThinkingSummaryModel } from "@vela/shared";
import type { MessageStore } from "../hooks/message-store";
import { useMessages } from "../hooks/useMessages";
import type { ThinkingSummaryStyle } from "../hooks/usePreferences";
import { useThinkingSummaries } from "../hooks/useThinkingSummaries";
import { ChatView, type ChatViewProps } from "./ChatView";
import { uiStorage } from "../ui-storage";
import { createFoldStore, type ToolFoldStore } from "./tool-fold-state";
import { ToolProcessProvider } from "./ToolProcessContext";

// A remount renders before the old provider's cleanup flushes. Reuse its memory
// state here, including when durable storage is unavailable.
const sessionFoldStores = new Map<string | null, ToolFoldStore>();

/** Own the main stream and summary updates below App and the workbench. */
export const SessionChatView = memo(function SessionChatView({ messageStore, summaryEnabled, summaryStyle, summaryModel = null, locale, toolProcessDetails = false, ...props }:
  Omit<ChatViewProps, "messages" | "thinkingSummaries"> & {
    messageStore: MessageStore;
    summaryEnabled: boolean;
    summaryStyle: ThinkingSummaryStyle;
    summaryModel?: ThinkingSummaryModel | null;
    locale: AppLocale;
    /** 紧凑过程行的耗时标签与折叠记忆,默认关闭。 */
    toolProcessDetails?: boolean;
  }) {
  const sessionId = props.state?.activeConversationId ?? null;
  const stores = sessionFoldStores;
  const previousSessionIds = useRef(new Set<string>());
  let foldStore = stores.get(sessionId);
  if (!foldStore) {
    foldStore = createFoldStore({ sessionId, storage: uiStorage });
    stores.set(sessionId, foldStore);
  }
  useEffect(() => {
    if (!props.state) return;
    // The complete list includes archived chats; only a removed session is reset.
    const existing = new Set(props.state.conversations.map(conversation => conversation.id));
    const known = new Set([...previousSessionIds.current, ...stores.keys()]);
    for (const id of known) {
      if (id && id !== sessionId && !existing.has(id)) {
        (stores.get(id) ?? createFoldStore({ sessionId: id, storage: uiStorage })).resetSession();
        stores.delete(id);
      }
    }
    previousSessionIds.current = existing;
  }, [props.state?.conversations, sessionId, stores]);
  const messages = useMessages(messageStore, sessionId);
  const thinkingSummaries = useThinkingSummaries({
    conversationId: props.state?.activeConversationId ?? null,
    messages,
    streaming: props.state?.session.status === "streaming",
    modelReady: summaryModel
      ? Boolean(props.models.catalog?.models.some(model => model.provider === summaryModel.provider && model.id === summaryModel.id && model.available))
      : props.state?.session.modelReady ?? false,
    enabled: summaryEnabled,
    style: summaryStyle,
    model: summaryModel,
    locale,
  });
  return <ToolProcessProvider sessionId={sessionId} store={foldStore} compact={props.toolDisplay === "compact"} enabled={toolProcessDetails}>
    <ChatView {...props} messages={messages} thinkingSummaries={thinkingSummaries} />
  </ToolProcessProvider>;
});

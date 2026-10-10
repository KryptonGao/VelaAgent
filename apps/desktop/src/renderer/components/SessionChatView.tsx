import { memo, useEffect, useMemo, useRef } from "react";
import type { AppLocale, ThinkingSummaryModel } from "@vela/shared";
import type { MessageStore } from "../hooks/message-store";
import { useMessages } from "../hooks/useMessages";
import type { ThinkingSummaryStyle } from "../hooks/usePreferences";
import { useThinkingSummaries } from "../hooks/useThinkingSummaries";
import { ChatView, type ChatViewProps } from "./ChatView";
import { uiStorage } from "../ui-storage";
import { createFoldStore, type ToolFoldStore } from "./tool-fold-state";
import { ToolProcessProvider } from "./ToolProcessContext";
import { mayContainUi } from "@vela/shared";
import { UiHostProvider, uiStateStore, type UiHost } from "./intelligent-ui/UiRuntime";
import { stableUiMessageId } from "./intelligent-ui/ui-state-store";

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
      // 会话被删除：连同交互界面的本地状态一起清理。
      if (id && id !== sessionId && !existing.has(id)) {
        uiStateStore.removeConversation(id);
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
  const streaming = props.state?.session.status === "streaming";
  const modelReady = props.state?.session.modelReady ?? false;
  const onSend = props.onSend;
  // 第 n 条含界面的助手回复得到稳定位置 u{n}：实时消息与历史恢复的消息 id 不同，但这个序号一致。
  const uiOrdinals = useMemo(() => {
    const ordinals = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "assistant" && mayContainUi(message.text)) ordinals.set(message.id, stableUiMessageId(ordinals.size));
    }
    return ordinals;
  }, [messages]);
  // 回退、编辑重发之后不再存在的位置，其本地状态一并清除；流式中或历史未加载时不动。
  useEffect(() => {
    if (sessionId && !streaming && messages.length > 0) uiStateStore.pruneConversation(sessionId, uiOrdinals.size);
  }, [sessionId, streaming, messages.length, uiOrdinals.size]);
  const uiHost = useMemo<UiHost>(() => ({
    conversationId: sessionId,
    stableMessageId: (messageId) => uiOrdinals.get(messageId) ?? null,
    canSubmit: modelReady,
    agentBusy: streaming,
    // 与输入框一致：运行中进入队列，不打断当前任务。
    submit: (text) => onSend(text, undefined, streaming ? "queue" : undefined),
    openLink: () => false,
  }), [sessionId, uiOrdinals, modelReady, streaming, onSend]);
  return <ToolProcessProvider sessionId={sessionId} store={foldStore} compact={props.toolDisplay === "compact"} enabled={toolProcessDetails}>
    <UiHostProvider value={uiHost}>
      <ChatView {...props} messages={messages} thinkingSummaries={thinkingSummaries} />
    </UiHostProvider>
  </ToolProcessProvider>;
});

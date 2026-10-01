import { memo } from "react";
import type { AppLocale } from "@vela/shared";
import type { MessageStore } from "../hooks/message-store";
import { useMessages } from "../hooks/useMessages";
import type { ThinkingSummaryStyle } from "../hooks/usePreferences";
import { useThinkingSummaries } from "../hooks/useThinkingSummaries";
import { ChatView, type ChatViewProps } from "./ChatView";

/** Own the main stream and summary updates below App and the workbench. */
export const SessionChatView = memo(function SessionChatView({ messageStore, summaryEnabled, summaryStyle, locale, ...props }:
  Omit<ChatViewProps, "messages" | "thinkingSummaries"> & {
    messageStore: MessageStore;
    summaryEnabled: boolean;
    summaryStyle: ThinkingSummaryStyle;
    locale: AppLocale;
  }) {
  const messages = useMessages(messageStore, props.state?.activeConversationId ?? null);
  const thinkingSummaries = useThinkingSummaries({
    conversationId: props.state?.activeConversationId ?? null,
    messages,
    streaming: props.state?.session.status === "streaming",
    modelReady: props.state?.session.modelReady ?? false,
    enabled: summaryEnabled,
    style: summaryStyle,
    locale,
  });
  return <ChatView {...props} messages={messages} thinkingSummaries={thinkingSummaries} />;
});

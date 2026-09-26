export interface EnterTrack {
  conversationId: string | null;
  ids: Set<string>;
  /** 当前对话的首批消息已经安顿好。之后新出现的 id 才播放进场。 */
  primed: boolean;
  enter: Set<string>;
}

/**
 * 切换对话时把已经在列表里的消息记下来,不播放进场。
 * 历史是在对话 id 确定后一次性补进来的(通常多于两条);
 * 发送会一次放上用户消息和空的助手消息,这两条要进场。
 */
export function trackEnteredMessages(
  previous: EnterTrack | null,
  conversationId: string | null,
  messageIds: readonly string[],
): EnterTrack {
  if (!previous || previous.conversationId !== conversationId) {
    return {
      conversationId,
      ids: new Set(messageIds),
      primed: messageIds.length > 0,
      enter: new Set(),
    };
  }

  const fresh = messageIds.filter((id) => !previous.ids.has(id));
  if (fresh.length === 0) return previous;

  if (!previous.primed && fresh.length > 2) {
    const ids = new Set(previous.ids);
    for (const id of fresh) ids.add(id);
    return { conversationId, ids, primed: true, enter: previous.enter };
  }

  const ids = new Set(previous.ids);
  const enter = new Set(previous.enter);
  for (const id of fresh) {
    ids.add(id);
    enter.add(id);
  }
  return { conversationId, ids, primed: true, enter };
}

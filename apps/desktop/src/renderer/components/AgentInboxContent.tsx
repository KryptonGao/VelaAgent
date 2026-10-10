import { useEffect, useMemo, useState } from "react";
import type { AgentInboxContent as Content, AgentInboxItem } from "@vela/shared";
import { tr } from "../locale";
import { AssistantMarkdown } from "./intelligent-ui/AssistantMarkdown";
import { UiHostProvider, type UiHost } from "./intelligent-ui/UiRuntime";
import { stableUiMessageId } from "./intelligent-ui/ui-state-store";

type Loaded = { key: string; content: Content | null };

/**
 * 事项详情里的完整回复：含 Intelligent UI 时按事项里保存的位置读取原消息并渲染。
 * 界面里的 `submit_to_agent` 由主进程按这个事项的来源对话投递，渲染层不能指定别的目标，
 * 也不会借此批准任何工具请求——审批只能用上面的审批按钮。
 */
export function AgentInboxContent({ item, fallback }: { item: AgentInboxItem; fallback: string }) {
  const ref = item.contentRef;
  const key = ref ? `${item.id}:${ref.conversationId}:${ref.uiOrdinal}:${ref.fingerprint}` : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const api = window.vela?.agentInbox;

  useEffect(() => {
    setNotice(null);
    if (!key || !api) return;
    let live = true;
    api.getContent(item.id).then(
      content => { if (live) setLoaded({ key, content }); },
      () => { if (live) setLoaded({ key, content: null }); },
    );
    return () => { live = false; };
  }, [api, item.id, key]);

  const content = loaded?.key === key ? loaded.content : null;
  const host = useMemo<UiHost | null>(() => content && api ? {
    conversationId: content.conversationId,
    stableMessageId: () => stableUiMessageId(content.uiOrdinal),
    canSubmit: Boolean(item.conversationId),
    agentBusy: false,
    submit: async text => {
      setNotice(null);
      try {
        const result = await api.submitToSource(item.id, text);
        setNotice(result.ok ? { ok: true, text: tr("已发送给 Agent。", "Sent to the Agent.") } : { ok: false, text: result.message });
      } catch (error) {
        setNotice({ ok: false, text: error instanceof Error ? error.message : String(error) });
      }
    },
    openLink: () => false,
  } : null, [api, content, item.id, item.conversationId]);

  if (!key) return <div className="agent-inbox-text">{fallback}</div>;
  if (!loaded || loaded.key !== key) return <p className="agent-inbox-muted" role="status">{tr("正在读取…", "Loading…")}</p>;
  if (!content || !host) {
    return <>
      <p className="agent-inbox-muted" role="status">{tr("原来的交互界面已经不可用（对话被回退或删除），这里显示文字摘要。", "The original interface is no longer available (the conversation was rolled back or deleted), so this shows the text summary.")}</p>
      <div className="agent-inbox-text">{fallback}</div>
    </>;
  }
  return <div className="agent-inbox-content">
    <UiHostProvider value={host}>
      <div className="agent-reply-prose"><AssistantMarkdown messageId={`inbox:${item.id}`} text={content.text} /></div>
    </UiHostProvider>
    {notice ? <p className="agent-inbox-notice" role={notice.ok ? "status" : "alert"}>{notice.text}</p> : null}
  </div>;
}

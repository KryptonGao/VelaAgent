/** Local UI fixture: real preference, completion hook, disclosure, and summary rendering; mocked model calls. */
import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ThinkingSummaryInput, VelaApi } from "@vela/shared";
import { Thinking } from "../src/renderer/components/Thinking";
import { ThinkingSummaryContext } from "../src/renderer/components/ThinkingSummaryContext";
import { useThinkingSummaries } from "../src/renderer/hooks/useThinkingSummaries";
import { usePreferences, type ThinkingSummaryStyle } from "../src/renderer/hooks/usePreferences";
import type { UiMessage } from "../src/renderer/hooks/useSession";
import { AppLocaleProvider, setActiveLocale } from "../src/renderer/locale";
import "../src/renderer/styles.css";

const passage = "I will inspect the runtime and model selection before changing the UI. The summary must use the chat's selected model and the interface language. I am not yet sure whether the renderer can detect completion reliably, so I will verify stream transitions and retry behavior.";
const history: UiMessage = { id: "historical", role: "assistant", thinking: passage, text: "An earlier response.", tools: [] };
let failNext = false;

function Fixture() {
  const preferences = usePreferences();
  const [conversationId, setConversationId] = useState("chat-a");
  const [buckets, setBuckets] = useState<Record<string, UiMessage[]>>({ "chat-a": [history], "chat-b": [{ ...history, id: "other-history" }] });
  const [streaming, setStreaming] = useState(false);
  const [style, setStyle] = useState<ThinkingSummaryStyle>("inline");
  const [calls, setCalls] = useState<ThinkingSummaryInput[]>([]);
  const [narrow, setNarrow] = useState(false);
  const messages = buckets[conversationId]!;
  window.vela = {
    summarizeThinking: async (input: ThinkingSummaryInput) => {
      setCalls((current) => [...current, input]);
      const shouldFail = failNext;
      failNext = false;
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (shouldFail) throw new Error("无法生成思考总结");
      return input.locale === "en"
        ? "Inspect runtime and model selection, then verify completion and retry behavior before changing the interface."
        : "先检查运行时与模型选择，再验证思考完成和重试逻辑，确认后调整界面。";
    },
  } as unknown as VelaApi;
  const summaries = useThinkingSummaries({ conversationId, messages, streaming, modelReady: true, enabled: preferences.thinkingSummary, style, locale: preferences.locale });
  setActiveLocale(preferences.locale);
  const updateLast = (patch: Partial<UiMessage>) => setBuckets((current) => ({
    ...current,
    [conversationId]: current[conversationId]!.map((message, index, list) => index === list.length - 1 ? { ...message, ...patch } : message),
  }));
  return (
    <AppLocaleProvider locale={preferences.locale}>
      <div style={{ padding: 32, background: "var(--bg-chat)", minHeight: "100vh" }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 32 }}>
          <label><input type="checkbox" checked={preferences.thinkingSummary} onChange={(event) => preferences.setThinkingSummary(event.target.checked)} />自动总结</label>
          <button onClick={() => preferences.setLocale(preferences.locale === "en" ? "zh-CN" : "en")}>切换语言</button>
          <button onClick={() => preferences.setAppearance(preferences.scheme === "dark" ? "light" : "dark")}>切换主题</button>
          <button onClick={() => setNarrow((value) => !value)}>切换窄窗口</button>
          {(["inline", "headline", "prose"] as const).map((option) => (
            <button key={option} onClick={() => setStyle(option)} style={{ fontWeight: style === option ? 700 : 400 }}>
              {option}{style === option ? " ✓" : ""}
            </button>
          ))}
          <button onClick={() => { setConversationId(conversationId === "chat-a" ? "chat-b" : "chat-a"); setStreaming(false); }}>切换对话</button>
          <button onClick={() => {
            setBuckets((current) => ({ ...current, [conversationId]: [...current[conversationId]!, { ...history, id: crypto.randomUUID(), text: "", turnStartedAt: Date.now() }] }));
            setStreaming(true);
          }}>开始新思考</button>
          <button onClick={() => { updateLast({ text: "Done." }); setStreaming(false); }}>完成思考</button>
          <button onClick={() => { failNext = true; }}>下次生成失败</button>
        </div>
        <p>Requests: {calls.length}; Chat: {conversationId}; Language: {preferences.locale}</p>
        <ol>{calls.map((call, index) => <li key={index}>{call.conversationId} / {call.locale}</li>)}</ol>
        <ThinkingSummaryContext.Provider value={summaries}>
          <div style={{ width: narrow ? 360 : 720, maxWidth: "100%" }}>
            {messages.map((message, index) => (
              <article className="assistant-block" key={`${conversationId}/${message.id}`} style={{ margin: "24px 0" }}>
                <Thinking messageId={message.id} text={message.thinking} active={streaming && index === messages.length - 1 && !message.text} showActivityIndicator />
              </article>
            ))}
          </div>
        </ThinkingSummaryContext.Provider>
      </div>
    </AppLocaleProvider>
  );
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);

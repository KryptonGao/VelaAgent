/** Real thinking components in a chat and nested subagent scrollers. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentInfo, ToolTrace } from "@vela/shared";
import { AgentPane } from "../src/renderer/components/AgentPane";
import { Thinking } from "../src/renderer/components/Thinking";
import { ToolCard } from "../src/renderer/components/ToolCard";
import type { UiMessage } from "../src/renderer/hooks/useSession";
import "../src/renderer/styles.css";

const paragraph = (i: number) =>
  `第 ${i} 段思考内容：先确认当前的问题，再决定下一步要看哪些文件，以及怎样在不破坏既有行为的前提下完成修改。\n\n\`\`\`ts\nasync function completeTitle(runtime, model, input, maxTokens) {\n  const result = await runtime.completeSimple(model, {\n    temperature: 0.2,\n    maxTokens,\n    input,\n  });\n  return result.text;\n}\nconst titleMaxTokens = 2048;\nconst titleRetryMaxTokens = 4096;\n\`\`\``;
const longText = (count: number) => Array.from({ length: count }, (_, i) => paragraph(i)).join("\n\n");

const params = new URLSearchParams(location.search);
const agent = {
  id: "agent-1", parentId: "root", path: "/root/graph-layout", name: "graph-layout", kind: "worker",
  status: "running", depth: 1, task: "UI", steps: [], mutated: false, finalText: null, error: null,
  createdAt: 1, updatedAt: 1,
} as unknown as AgentInfo;

function MainPane() {
  const [count, setCount] = useState(8);
  const [active, setActive] = useState(true);
  return (
    <div className="blur-main" style={{ width: 460, minWidth: 0 }}>
      <div style={{ fontSize: 12, marginBottom: 6 }}>main chat</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button data-blur-action="append" onClick={() => setCount((value) => value + 1)}>Append</button>
        <button data-blur-action="short" onClick={() => setCount(0)}>Short</button>
        <button data-blur-action="long" onClick={() => setCount(8)}>Long</button>
        <button data-blur-action="finish" onClick={() => setActive(false)}>Finish</button>
      </div>
      <Thinking text={count ? longText(count) : "A short thought."} active={active} showActivityIndicator={false} />
    </div>
  );
}

function SummaryPane({ compact }: { compact: boolean }) {
  const [count, setCount] = useState(8);
  const tool: ToolTrace = {
    id: compact ? "blur-compact" : "blur-card", name: "spawn_agent", status: "done",
    activity: { agentPath: "/root/summary", body: `Fixture task\n${count ? longText(count) : "Short conclusion."}` },
  };
  return (
    <div className={compact ? "blur-summary-compact" : "blur-summary-card"} style={{ width: 460 }}>
      <div style={{ fontSize: 12, marginBottom: 6 }}>{compact ? "compact summary" : "card summary"}</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button data-summary-action="append" onClick={() => setCount(value => value + 1)}>Append</button>
        <button data-summary-action="short" onClick={() => setCount(0)}>Short</button>
        <button data-summary-action="long" onClick={() => setCount(8)}>Long</button>
      </div>
      <ToolCard tool={tool} compact={compact} />
    </div>
  );
}

function Pane({ isolated, scrollOffset, stream }: { isolated: boolean; scrollOffset: number; stream: boolean }) {
  const [messages, setMessages] = useState<UiMessage[]>(() => [
    { id: "m1", role: "assistant", text: "", thinking: longText(8), tools: [] },
  ]);
  const rootRef = useRef<HTMLDivElement>(null);
  const counter = useRef(8);
  useEffect(() => {
    if (!stream) return;
    const timer = setInterval(() => {
      ++counter.current;
      const next = counter.current;
      setMessages([{ id: "m1", role: "assistant", text: "", thinking: longText(next), tools: [] }]);
    }, 350);
    return () => clearInterval(timer);
  }, [stream]);
  useEffect(() => {
    if (!scrollOffset) return;
    const timer = setTimeout(() => {
      const viewport = rootRef.current?.querySelector<HTMLDivElement>(".thinking-scroll-viewport");
      if (!viewport) return;
      const max = viewport.scrollHeight - viewport.clientHeight;
      viewport.scrollTop = Math.max(0, max - scrollOffset);
      viewport.dispatchEvent(new Event("scroll"));
    }, 900);
    return () => clearTimeout(timer);
  }, [scrollOffset]);
  return (
    <div ref={rootRef} className={isolated ? "pane-isolated" : undefined} style={{ width: 460, height: 700, display: "flex", background: "var(--bg-chat)" }}>
      <div className="workbench-panel" style={{ width: "100%", display: "flex", flexDirection: "column" }}>
        <div className="workbench-content">
          <div className="workbench-tabpanel">
            <AgentPane agent={agent} agents={[agent]} messages={messages} onSwitch={() => {}} ensureMessages={() => {}} toolDisplay="cards" />
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 460px)", gap: 20, padding: 24, background: "var(--bg-chat)", minHeight: "100vh" }}>
      <style>{`.pane-isolated .agent-pane-scroll { isolation: isolate; }`}</style>
      <MainPane />
      <div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>plain (no isolation)</div>
        <Pane isolated={false} scrollOffset={Number(params.get("scrollup") ?? 0)} stream={params.has("stream")} />
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>isolation: isolate</div>
        <Pane isolated scrollOffset={Number(params.get("scrollup") ?? 0)} stream={params.has("stream")} />
      </div>
      <SummaryPane compact={false} />
      <SummaryPane compact />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

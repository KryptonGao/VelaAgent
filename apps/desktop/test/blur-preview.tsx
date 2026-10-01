/** Temporary fixture: two subagent panes, left without isolation, right with `isolation: isolate` on the scroller. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentInfo } from "@vela/shared";
import { AgentPane } from "../src/renderer/components/AgentPane";
import type { UiMessage } from "../src/renderer/hooks/useSession";
import "../src/renderer/styles.css";

const paragraph = (i: number) =>
  `第 ${i} 段思考内容：先确认当前的问题，再决定下一步要看哪些文件，以及怎样在不破坏既有行为的前提下完成修改。laneSegments 每行的 lane 占用用于绘制连续直线。`;
const longText = (count: number) => Array.from({ length: count }, (_, i) => paragraph(i)).join("\n\n");

const params = new URLSearchParams(location.search);
const agent = {
  id: "agent-1", parentId: "root", path: "/root/graph-layout", name: "graph-layout", kind: "worker",
  status: "running", depth: 1, task: "UI", steps: [], mutated: false, finalText: null, error: null,
  createdAt: 1, updatedAt: 1,
} as unknown as AgentInfo;

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
      setMessages([{ id: "m1", role: "assistant", text: "", thinking: `${longText(8)}\n\n${paragraph(next)}`, tools: [] }]);
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
    <div style={{ display: "flex", gap: 20, padding: 24, background: "var(--bg-chat)", minHeight: "100vh" }}>
      <style>{`.pane-isolated .agent-pane-scroll { isolation: isolate; }`}</style>
      <div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>plain (no isolation)</div>
        <Pane isolated={false} scrollOffset={Number(params.get("scrollup") ?? 0)} stream={params.has("stream")} />
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>isolation: isolate</div>
        <Pane isolated scrollOffset={Number(params.get("scrollup") ?? 0)} stream={params.has("stream")} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

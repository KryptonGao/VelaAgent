/** Real Batch 3 components; in-memory IPC, no provider or workspace side effects. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentInfo, AppState, ProposedPlanItem, TraceNode, TraceUpdate, VelaApi } from "@vela/shared";
import { Markdown } from "../src/renderer/components/Markdown";
import { PlanDocumentPane, PlanDocumentProvider } from "../src/renderer/components/PlanPanel";
import { FileTree } from "../src/renderer/components/preview/ExplorerPane";
import { buildFileTree } from "../src/renderer/components/preview/tree";
import { StartView } from "../src/renderer/components/StartView";
import { Thinking } from "../src/renderer/components/Thinking";
import { ThinkingSummaryContext } from "../src/renderer/components/ThinkingSummaryContext";
import { SkillMenu } from "../src/renderer/components/composer/SkillMenu";
import { AgentPane } from "../src/renderer/components/AgentPane";
import { TraceView } from "../src/renderer/components/trace/TraceView";
import type { UiMessage } from "../src/renderer/hooks/useSession";
import "../src/renderer/styles.css";
import { runBatch3MotionChecks } from "./motion-batch3-checks";

const automated = new URLSearchParams(location.search).has("checks");
const media = Object.assign(new EventTarget(), { matches: false, media: "(prefers-reduced-motion: reduce)" });
const originalMatchMedia = window.matchMedia.bind(window);
if (automated) window.matchMedia = (query) => query === media.media ? media as unknown as MediaQueryList : originalMatchMedia(query);
const reducedStyle = document.createElement("style");
function setReducedMotion(value: boolean) {
  if (value) {
    reducedStyle.textContent = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]
      .filter((rule) => rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion: reduce"))
      .flatMap((rule) => [...(rule as CSSMediaRule).cssRules].map((inner) => inner.cssText))).join("\n");
    document.head.append(reducedStyle);
  } else reducedStyle.remove();
  media.matches = value; media.dispatchEvent(new Event("change"));
}
const startText = "# 流式输出\n\n已完成的第一段。\n\n第二段。\n\n正在生成的尾段";
const plans: ProposedPlanItem[] = [1, 2].map((revision) => ({ id: `plan-${revision}`, revision,
  markdown: `# 计划 v${revision}\n\n` + Array.from({ length: 30 }, (_, i) => `## 步骤 ${i + 1}\n\n版本 ${revision} 的实施说明。`).join("\n\n"),
  supersedes: revision === 2 ? "plan-1" : null, status: revision === 1 ? "superseded" : "draft",
  objective: "Implement Batch 3", createdAt: revision, approvedAt: null }));
const agent = { id: "agent-1", parentId: "root", path: "/root/frontend", name: "frontend", kind: "worker", status: "running", depth: 1,
  task: "UI animation", steps: [], mutated: false, finalText: null, error: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, activeMs: 0, runningSince: null, pauseRequested: false, createdAt: 1, updatedAt: 1 } as AgentInfo;
const message = (id: string, text: string): UiMessage => ({ id, role: "assistant", text, thinking: "", tools: [] });
const skills = Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i}`, description: `Skill ${i} description`, location: `/fixture/skill-${i}`, origin: "user" })) as any[];
const skillItems = skills.map(skill => ({ type: "skill" as const, skill }));
const node = (i: number): TraceNode => ({ id: `trace-${i}`, sequence: i, kind: i === 0 ? "system" : "assistant", turn: 1, step: i,
  requestId: null, toolCallId: null, toolName: null, status: "Completed", summary: `执行事件 ${i}`, startedAt: i * 100, completedAt: i * 100 + 50,
  executionStartedAt: null, durationMs: 50, version: i + 1, historical: false });
let traceNodes = Array.from({ length: 120 }, (_, i) => node(i));
let version = 120;
const listeners = new Set<(event: TraceUpdate) => void>();
const snapshot = () => ({ version, nodes: traceNodes, requests: [], summaries: [], warning: null });
window.vela = {
  onEvent: (callback: any) => { listeners.add(callback); return () => listeners.delete(callback); },
  getTrace: async () => snapshot(),
  getTraceDetails: async (_conversationId: string, id: string) => ({ node: traceNodes.find((item) => item.id === id), content: "Fixture trace detail", raw: {}, source: {}, arguments: null, result: null, context: null, request: null, responseBlocks: [] }),
} as unknown as VelaApi;
const traceState = { activeConversationId: "batch3", session: { status: "ready" }, context: { percent: 15 } } as AppState;
const noop = () => {};
const ensure = () => {};
function Fixture() {
  const [text, setText] = useState(startText), [revision, setRevision] = useState("plan-1"), [draft, setDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>()), [path, setPath] = useState<string | null>(null);
  const [summary, setSummary] = useState(false), [summaryStyle, setSummaryStyle] = useState<"inline" | "headline" | "prose">("inline");
  const [activeSkill, setActiveSkill] = useState(0), [messages, setMessages] = useState([message("m1", "子代理开始检查界面。")]);
  Object.assign(window, { batch3Fixture: {
    text: (value: string) => flushSync(() => setText(value)),
    revision: (value: string) => flushSync(() => setRevision(value)),
    draft: (value: string | null) => flushSync(() => { setDraft(value); if (value !== null) setRevision("draft"); }),
    tree: (value: boolean) => flushSync(() => setExpanded(value ? new Set(["src", "src/components"]) : new Set())),
    summary: (value: boolean, style = "inline") => flushSync(() => { setSummary(value); setSummaryStyle(style as any); }),
    skill: (value: number) => flushSync(() => setActiveSkill(value)),
    messages: (value: UiMessage[]) => flushSync(() => setMessages(value)),
    traceAppend: () => { const next = node(traceNodes.length); traceNodes = [...traceNodes, next]; ++version; flushSync(() => listeners.forEach((callback) => callback({ type: "trace", conversationId: "batch3", ...snapshot() }))); },
  } });
  useEffect(() => { if (automated) void runBatch3MotionChecks(setReducedMotion); }, []);
  return <div className="batch3-preview">
    <style>{`.batch3-preview { padding: 24px; background: var(--bg-chat); color: var(--text-primary); min-height: 100vh; }
      .batch3-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      .fixture-card { border: 1px solid var(--border-subtle); border-radius:12px; padding:16px; min-width:0; }
      .fixture-card h3 { margin:0 0 12px; font-size:14px; } .fixture-pane { height:350px; display:flex; overflow:hidden; }
      .fixture-card .skill-menu { position:relative; inset:auto; width:100%; } .skill-menu-list { max-height:130px; }
      .fixture-actions { display:flex; gap:12px; margin:12px 0; } .fixture-actions button { background:var(--bg-hover); border-radius:6px; padding:6px 10px; }
      .fixture-card .start-view { height:auto; } .fixture-card .start-view-inner { max-width:none; padding:0; }
    `}</style>
    <h1>Batch 3 · 流式体验与交互打磨</h1>
    <div className="fixture-actions">
      <button onClick={() => setText((current) => current + "\n\n新追加的段落，轻微淡入。")}>追加段落</button>
      <button onClick={() => setRevision((current) => current === "plan-1" ? "plan-2" : "plan-1")}>切换计划</button>
      <button onClick={() => setSummary((current) => !current)}>生成总结</button>
      <button onClick={() => setMessages((current) => [...current, message(`m${current.length + 1}`, "新追加的子代理步骤。")])}>子代理步骤</button>
    </div>
    <div className="batch3-grid">
      <div className="fixture-card fixture-markdown"><h3>流式 Markdown</h3><Markdown text={text} streaming /></div>
      <div className="fixture-card"><h3>计划版本</h3><div className="fixture-pane">
        <PlanDocumentProvider plans={plans} draft={draft === null ? null : { id: "draft", revision: 3, markdown: draft, streaming: true }} activePlanId={revision} selectedRevisionId={revision}
          openPlan={setRevision} closePlan={noop} selectRevision={setRevision}>
          <PlanDocumentPane busy={false} execution={null} onRevise={noop} onExecutePlan={noop} />
        </PlanDocumentProvider>
      </div></div>
      <div className="fixture-card"><h3>文件树与菜单</h3>
        <FileTree nodes={buildFileTree(["src/components/Button.tsx", "src/components/Input.tsx", "README.md"])} expanded={expanded} activePath={path}
          onToggleDir={(dir) => setExpanded((current) => { const next = new Set(current); if (!next.delete(dir)) next.add(dir); return next; })} onOpenFile={setPath} />
        <SkillMenu items={skillItems} loadingSkills={false} loadingRecipes={false} error={null} recipeError={null} query="" activeIndex={activeSkill} onActiveIndex={setActiveSkill} onSelect={noop} />
      </div>
      <div className="fixture-card"><h3>起始卡片、总结与按压反馈</h3>
        <StartView gitAvailable onAction={noop} />
        <ThinkingSummaryContext.Provider value={{ enabled: true, style: summaryStyle,
          get: () => summary ? { status: "done", text: "已定位动画入口，并复用共享动效。", model: "fixture", updatedAt: 1 } as any : { status: "pending" } as any, request: noop }}>
          <Thinking text="先检查组件，再实现动画。" messageId="thinking" active={false} showActivityIndicator={false} />
        </ThinkingSummaryContext.Provider>
        <button className="mode-pill mode-plan">Plan</button> <button className="sandbox-pill sandbox-smart">Smart sandbox</button>
      </div>
      <div className="fixture-card"><h3>子代理步骤</h3><div className="fixture-pane"><AgentPane agent={agent} agents={[agent]} messages={messages}
        onSwitch={noop} ensureMessages={ensure} onControl={noop} toolDisplay="compact" /></div></div>
      <div className="fixture-card"><h3>Trace</h3><div className="fixture-pane"><TraceView state={traceState} onConversation={noop} onAbort={async () => {}} pendingInteraction={false} /></div></div>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

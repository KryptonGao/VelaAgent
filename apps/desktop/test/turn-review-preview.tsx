/** Real chat cards, review state and workbench; deterministic records without file/Git reads. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AppState, ToolTrace, VelaApi } from "@vela/shared";
import { ChatView } from "../src/renderer/components/ChatView";
import { WorkbenchPanel, type WorkbenchTab } from "../src/renderer/components/WorkbenchPanel";
import { FilePreviewProvider } from "../src/renderer/components/preview/FilePreviewContext";
import { useTurnReview } from "../src/renderer/hooks/useTurnReview";
import type { UiMessage } from "../src/renderer/hooks/useSession";
import type { useModels } from "../src/renderer/hooks/useModels";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import type { ToolDisplay, ToolFold } from "../src/renderer/hooks/usePreferences";
import { AppLocaleProvider, setActiveLocale, tr } from "../src/renderer/locale";
import "../src/renderer/styles.css";
import "../src/renderer/version-control.css";

const params = new URLSearchParams(location.search);
const locale = params.has("en") ? "en" : "zh-CN";
setActiveLocale(locale);
document.documentElement.dataset.scheme = params.get("theme") ?? "light";
const noop = () => {};
const subscribe = () => noop;
let reads = 0;
window.vela = {
  platform: "darwin", listOpenTargets: async () => [], listSkills: async () => ({ skills: [] }),
  getAgentSettings: async () => ({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" }),
  onWorkspaceEvent: subscribe, onGitEvent: subscribe, onEvent: subscribe,
  pickAttachments: async () => [], hydrateAttachments: async () => [],
  readWorkspaceFile: async () => { reads++; throw new Error("Review must use saved records"); },
} as unknown as VelaApi;
const models = { catalog: { models: [], providers: [] }, login: { active: false }, select: noop, setThinking: noop } as unknown as ReturnType<typeof useModels>;
const edit = (id: string, path: string, diff?: string): ToolTrace => ({ id, name: "edit", status: "done", activity: { path, diff } });
const sourceMessages: UiMessage[] = [
  { id: "u1", role: "user", text: "更新桌面客户端版本，并补充审查说明。", thinking: "", tools: [] },
  { id: "r1", role: "assistant", text: "版本已更新，文件变更如下。", thinking: "", tools: [
    edit("a", "apps/desktop/electron-builder.yml", "   ...\n 2 productName: Vela\n-3 buildVersion: 0.1.1.1\n+3 buildVersion: 0.1.1.2\n 4 artifactName: Vela-${shortVersion}\n   ...\n 24 mac:\n-25   bundleShortVersion: 0.1.1.1\n+25   bundleShortVersion: 0.1.1.2\n-26   bundleVersion: 0.1.1.1\n+26   bundleVersion: 0.1.1.2\n 27   category: public.app-category.productivity"),
    edit("b", "apps/desktop/package.json", ' 1 {\n 2   "name": "@vela/desktop",\n-3   "version": "0.1.1+1",\n+3   "version": "0.1.1+2",\n-4   "shortVersion": "0.1.1.1",\n+4   "shortVersion": "0.1.1.2",\n 5   "private": true\n 6 }'),
    edit("c", "src/review.ts", Array.from({ length: 100 }, (_, i) => `+${i + 1} export const saved${i} = "${i === 0 ? "very_long_unbroken_content_".repeat(14) : "saved edit"}";`).join("\n")),
    edit("d", "src/review.ts", "-1 export const saved0 = false;\n+1 export const saved0 = true;\n… 内容过长，已截断"),
    edit("e", "README.md"),
  ] },
  { id: "u2", role: "user", text: "再新增一份说明。", thinking: "", tools: [] },
  { id: "r2", role: "assistant", text: "已新增说明。", thinking: "", tools: [edit("f", "docs/next.md", "+1 # Second turn\n+2 \n+3 Saved independently.")] },
];

let controls: {
  scope(chat: string, workspace?: string): void;
  width(value: number): void;
  variant(display: ToolDisplay, fold: ToolFold, noReply: boolean): void;
  activateOther(): void;
};

function Fixture() {
  const [chat, setChat] = useState("a");
  const [workspace, setWorkspace] = useState("/fixture");
  const [width, setWidth] = useState(params.has("compact") ? 480 : 780);
  const [display, setDisplay] = useState<ToolDisplay>("compact");
  const [fold, setFold] = useState<ToolFold>("message");
  const [noReply, setNoReply] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(true);
  const review = useTurnReview(workspace, chat);
  const tab: WorkbenchTab | null = review.review ? { id: review.tabId, kind: "turn-review", label: tr("变更审查", "Change review"), review: review.review } : null;
  const tabs: WorkbenchTab[] = [...(startOpen ? [{ id: "start", kind: "start" as const, label: tr("新标签页", "New tab") }] : []), ...(tab ? [tab] : [])];
  useEffect(() => { setActive(review.review ? review.tabId : "start"); }, [workspace, chat]);
  controls = {
    scope(nextChat, nextWorkspace = workspace) { setChat(nextChat); setWorkspace(nextWorkspace); },
    width: setWidth,
    variant(nextDisplay, nextFold, nextNoReply) { setDisplay(nextDisplay); setFold(nextFold); setNoReply(nextNoReply); },
    activateOther() { setActive("start"); },
  };
  const project = { workspace: { current: workspace, recents: [] }, git: null, approval: null, sandboxMode: "ask", listBranches: async () => [] } as unknown as ProjectApi;
  const state = {
    activeConversationId: chat,
    session: { id: chat, title: "文件变更审查", cwd: workspace, status: "ready", model: "Fixture", modelReady: true,
      modelProvider: "fixture", modelId: "fixture", tools: [], mode: "agent", thinkingLevel: "medium", thinkingLevels: ["medium"] },
    agents: [], context: { tokens: 100, contextWindow: 10000, percent: 1, messageCount: 4, toolCallCount: 6,
      segments: { system: 0, tools: 0, rules: 0, skills: 0, conversation: 100 } },
  } as unknown as AppState;
  const messages = noReply ? sourceMessages.map(message => message.role === "assistant" ? { ...message, text: "" } : message) : sourceMessages;
  return <>
    <div className="fixture-controls">
      <button onClick={() => setChat(current => current === "a" ? "b" : "a")}>Chat {chat}</button>
      <button onClick={() => setWidth(current => current < 600 ? 780 : 480)}>Panel {width}px</button>
      <button onClick={() => { const next = document.documentElement.dataset.scheme === "light" ? "dark" : "light"; document.documentElement.dataset.scheme = next; }}>Theme</button>
    </div>
    <div className="vela-window platform-darwin left-collapsed right-collapsed layout-floating"
      style={{ height: "calc(100vh - 36px)", "--workbench-width": `${width}px` } as React.CSSProperties}>
      <div className="main-stage"><div className="main-stage-pane">
        <ChatView messages={messages} state={state} project={project} sendError={null} platform="darwin"
          leftCollapsed rightCollapsed floatingInfo environmentCollapsed toolDisplay={display} toolFold={fold}
          models={models} onToggleLeft={noop} onToggleRight={noop} onSend={async () => {}} onAbort={async () => {}}
          onMode={async () => {}} getQuestion={() => null} onReplyQuestion={noop} onBranch={noop}
          showNewTab={false} onNewTab={noop} onOpenChanges={noop}
          onReviewTurn={request => { review.open(request); setActive(review.tabId); }} />
        <WorkbenchPanel tabs={tabs} activeTabId={active} contextOpen={false} leftOpen={false}
          resize={{ widths: { left: 250, right: 340, workbench: width }, startResize: noop, nudge: noop, reset: noop }}
          project={project} busy={false} execution={null} onRevise={noop} onExecutePlan={noop}
          initialDiffPath={null} initialDiffPathRequestKey={0} selectedChangePath={null} onSelectedChangePath={noop}
          onShowDiff={noop} agents={[]} ensureAgentMessages={noop} onOpenAgent={noop} onNewTab={noop}
          onStartAction={noop} gitAvailable={false} onActivateTab={item => setActive(item.id)}
          onCloseTab={item => {
            if (item.kind === "turn-review") { review.close(); setActive(startOpen ? "start" : null); }
            else { setStartOpen(false); setActive(review.review ? review.tabId : null); }
          }} />
      </div></div>
    </div>
  </>;
}
const style = document.createElement("style");
style.textContent = ".fixture-controls{height:36px;display:flex;align-items:center;gap:12px;padding:0 12px;font-size:12px}.fixture-controls button{padding:4px 8px;border:1px solid var(--border-subtle);border-radius:4px}.vela-window .workbench-panel{width:var(--workbench-width)!important;min-width:var(--workbench-width)!important}.main-chat-view{min-width:0}";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<AppLocaleProvider locale={locale}><FilePreviewProvider><Fixture /></FilePreviewProvider></AppLocaleProvider>);

const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const cards = () => document.querySelectorAll<HTMLButtonElement>(".turn-changes-review");
const view = () => document.querySelector<HTMLElement>(".turn-review-view");
const reviewTab = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find(tab => tab.textContent === tr("变更审查", "Change review"));
async function clickReview(index = 0) { flushSync(() => cards()[index].click()); await wait(); }

async function run() {
  const result = document.createElement("pre");
  result.id = "turn-review-results";
  result.style.cssText = "position:fixed;bottom:0;left:0;z-index:1000;max-height:30vh;overflow:auto;background:var(--bg-chat);color:var(--text-primary);padding:12px;font-size:12px;pointer-events:none";
  document.body.append(result);
  const pass = (message: string) => { result.textContent += `PASS ${message}\n`; };
  try {
    await wait(300);
    assert(cards().length === 2, "One card per completed turn");
    await clickReview();
    assert(reviewTab()?.getAttribute("aria-selected") === "true", "Click activates review tab");
    assert(view()?.querySelectorAll(".turn-review-file").length === 4, "All files are continuous");
    assert(!document.querySelector(".turn-changes-diffs"), "No inline diff expansion");
    assert(view()?.textContent?.includes(tr("编辑 2 / 2", "Edit 2 / 2")), "Repeated edits are separate");
    assert(view()?.textContent?.includes(tr("这项编辑没有保存可显示的差异", "No saved diff is available for this edit")), "Missing diff explanation");
    assert(view()?.textContent?.includes("… 内容过长，已截断"), "Truncation remains visible");
    pass("card opens read-only review, including repeated edits and missing/truncated records");

    const filter = view()!.querySelector<HTMLInputElement>(".turn-review-filter input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => { setValue.call(filter, "PACKAGE"); filter.dispatchEvent(new Event("input", { bubbles: true })); });
    await wait();
    assert(view()?.querySelectorAll(".turn-review-file").length === 1, "Filter affects main content");
    assert(view()?.querySelectorAll(".turn-review-file-link").length === 1, "Filter affects navigator");
    await clickReview();
    assert(view()?.querySelector<HTMLInputElement>("input")?.value === "PACKAGE", "Same turn preserves UI state");
    flushSync(() => { setValue.call(filter, ""); filter.dispatchEvent(new Event("input", { bubbles: true })); });
    await wait();
    const directory = view()!.querySelector<HTMLButtonElement>(".turn-review-directory")!;
    flushSync(() => directory.click());
    assert(directory.getAttribute("aria-expanded") === "false", "Directory collapses");
    flushSync(() => directory.click());
    pass("filtering, directory collapse and repeated review clicks");

    const link = view()!.querySelector<HTMLButtonElement>('.turn-review-file-link[title="src/review.ts"]')!;
    flushSync(() => link.click());
    await wait();
    assert(link.getAttribute("aria-current") === "location", "File navigation selects target");
    const scroll = view()!.querySelector<HTMLElement>(".turn-review-scroll")!;
    assert(scroll.scrollTop > 0, "Navigation scrolls main content");
    const lastLink = view()!.querySelector<HTMLButtonElement>('.turn-review-file-link[title="README.md"]')!;
    flushSync(() => lastLink.click());
    await wait();
    assert(lastLink.getAttribute("aria-current") === "location", "Short final file stays selected at bottom");
    scroll.scrollTo({ top: 0 });
    await wait();
    assert(view()?.querySelector('.turn-review-file-link[title="apps/desktop/electron-builder.yml"]')?.getAttribute("aria-current") === "location", "Scroll updates active file");
    pass("file navigation and active file follow scrolling");

    flushSync(() => controls.width(480));
    await wait(350);
    const row = view()!.querySelector<HTMLElement>(".diff-split-row")!;
    assert(getComputedStyle(row).gridTemplateColumns.split(" ").length === 2, "Narrow panel retains two columns");
    assert(view()?.querySelector<HTMLElement>(".turn-review-sidebar")?.hidden, "Narrow navigator starts hidden");
    const toggle = view()!.querySelector<HTMLButtonElement>(".turn-review-files-toggle")!;
    flushSync(() => toggle.click());
    await wait();
    assert(!view()?.querySelector<HTMLElement>(".turn-review-sidebar")?.hidden, "Files toggle opens drawer");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait();
    assert(view()?.querySelector<HTMLElement>(".turn-review-sidebar")?.hidden && reviewTab(), "Escape closes drawer before tab");
    assert(document.activeElement === toggle, "Drawer dismissal restores focus");
    pass("compact panel keeps split diff and supports keyboard drawer dismissal");

    const firstTabId = reviewTab()!.id;
    await clickReview(1);
    assert(reviewTab()?.id === firstTabId, "Different turn reuses tab");
    assert(view()?.textContent?.includes("# Second turn"), "Different turn changes content");
    assert(view()?.querySelector<HTMLInputElement>("input")?.value === "", "New turn resets filter");
    assert(view()?.querySelector<HTMLElement>(".turn-review-scroll")?.scrollTop === 0, "New turn resets scroll");
    pass("different turns replace one review tab and reset UI state");

    flushSync(() => controls.scope("b")); await wait();
    assert(!reviewTab(), "Other chat has no prior review");
    await clickReview();
    flushSync(() => controls.scope("a")); await wait();
    assert(view()?.textContent?.includes("# Second turn"), "Original chat retains its snapshot");
    flushSync(() => controls.scope("a", "/other")); await wait();
    assert(!reviewTab(), "Other workspace is isolated");
    flushSync(() => controls.scope("a", "/fixture")); await wait();
    assert(view()?.textContent?.includes("# Second turn"), "Original workspace retains review");
    pass("chat and workspace isolation");

    flushSync(() => controls.activateOther()); await wait(300);
    assert(view()?.closest<HTMLElement>('[role="tabpanel"]')?.hidden, "Other tab hides review");
    await clickReview(1);
    const close = document.querySelector<HTMLButtonElement>(`.workbench-tab-close[aria-label="${tr("关闭 变更审查", "Close Change review")}"]`)!;
    flushSync(() => close.click()); await wait();
    assert(!reviewTab(), "Close removes review tab");
    await clickReview();
    assert(Boolean(reviewTab()), "Card reopens closed review");
    pass("tab switching, closing and reopening");

    for (const display of ["card", "compact"] as const) for (const fold of ["message", "position"] as const) for (const noReply of [false, true]) {
      flushSync(() => controls.variant(display, fold, noReply)); await wait();
      assert(cards().length === 2, `Cards remain in ${display}/${fold}/${noReply}`);
      await clickReview(1);
      assert(view()?.textContent?.includes("# Second turn"), `Review opens in ${display}/${fold}/${noReply}`);
    }
    pass("all eight tool display/fold/final reply combinations");
    assert(reads === 0, "Review does not read live files");
    pass("saved review needs no live file reads or Git repository");
    const closeStart = document.querySelector<HTMLButtonElement>(`.workbench-tab-close[aria-label="${tr("关闭 新标签页", "Close New tab")}"]`)!;
    flushSync(() => closeStart.click()); await wait();
    const closeLast = document.querySelector<HTMLButtonElement>(".workbench-tab-close")!;
    flushSync(() => closeLast.click());
    assert(document.querySelector(".workbench-panel.is-closing") && view(), "Last review keeps content during exit");
    await wait(300);
    assert(!document.querySelector(".workbench-panel"), "Last review panel closes after animation");
    await clickReview();
    assert(Boolean(view()), "Card reopens panel after last tab closed");
    pass("last review tab preserves content during close animation and reopens");
    flushSync(() => { controls.width(780); controls.variant("compact", "message", false); }); await wait(300);
    await clickReview();
    result.dataset.status = "passed";
  } catch (error) {
    result.textContent += `FAIL ${String(error)}\n`;
    result.dataset.status = "failed";
    console.error(error);
  }
}
if (params.has("checks")) void run();

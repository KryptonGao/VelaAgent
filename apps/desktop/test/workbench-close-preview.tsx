/** Focused renderer regression checks with in-memory file content and no IPC. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WorkbenchPanel, type WorkbenchTab } from "../src/renderer/components/WorkbenchPanel";
import { FilePreviewProvider, useFilePreview } from "../src/renderer/components/preview/FilePreviewContext";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import type { SidebarResize } from "../src/renderer/hooks/useSidebarResize";
import "../src/renderer/styles.css";

const content = "Content stays visible until the panel slides out.";
const sidebarOpen = new URLSearchParams(location.search).has("sidebar");
window.vela = {
  readWorkspaceFile: async (path: string) => ({ path, kind: "text", content }),
  listWorkspaceFiles: async () => ({ root: "/fixture", files: ["first.txt", "second.txt"] }),
  onGitEvent: () => () => {},
  onWorkspaceEvent: () => () => {},
} as unknown as Window["vela"];
const media = Object.assign(new EventTarget(), { matches: false, media: "(prefers-reduced-motion: reduce)" });
const originalMatchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => query === media.media ? media as unknown as MediaQueryList : originalMatchMedia(query);

let controls: { openFile(path: string): void; addTab(): void; previewTabs: number };
let closeCalls = 0;
function Fixture() {
  const [tabs, setTabs] = useState<WorkbenchTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  return <FilePreviewProvider
    onOpenFile={(file) => {
      const tab: WorkbenchTab = { id: file.id, kind: "file", path: file.path, title: file.path, label: file.name };
      setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
      setActive(tab.id);
    }}
    onCloseFileTab={(id) => setTabs((current) => current.filter((tab) => tab.id !== id))}
  >
    <Panel tabs={tabs} active={active} onActivate={setActive}
      addTab={() => {
        setTabs((current) => [...current, { id: "start", kind: "start", label: "New tab" }]);
        setActive("start");
      }}
      onClose={(tab) => {
        closeCalls++;
        setTabs((current) => current.filter((item) => item.id !== tab.id));
        setActive((current) => current === tab.id ? null : current);
      }} />
  </FilePreviewProvider>;
}
function Panel({ tabs, active, onActivate, addTab, onClose }: {
  tabs: WorkbenchTab[]; active: string | null; onActivate(id: string): void;
  addTab(): void; onClose(tab: WorkbenchTab): void;
}) {
  const preview = useFilePreview()!;
  controls = { openFile: preview.openFile, addTab, previewTabs: preview.tabs.length };
  return <div className={`vela-window left-collapsed${sidebarOpen ? "" : " layout-floating right-collapsed"}`}>
    <div className="main-stage"><div className="main-stage-pane">
    <div className="main-chat-view" tabIndex={-1} style={{ flex: 1 }}>Chat</div>
    <WorkbenchPanel tabs={tabs} activeTabId={active} contextOpen={sidebarOpen} leftOpen={false}
      resize={{ widths: { left: 250, right: 340, workbench: 500 }, startResize() {}, nudge() {}, reset() {} } as SidebarResize}
      project={{} as ProjectApi} busy={false} execution={null} onRevise={() => {}} onExecutePlan={() => {}}
      initialDiffPath={null} initialDiffPathRequestKey={0} selectedChangePath={null} onSelectedChangePath={() => {}}
      onShowDiff={() => {}} agents={[]} getAgentMessages={() => []} ensureAgentMessages={() => {}} onOpenAgent={() => {}}
      onNewTab={addTab} onStartAction={() => {}} gitAvailable={false} onActivateTab={(tab) => onActivate(tab.id)}
      onCloseTab={onClose} />
    {sidebarOpen ? <aside className="sidebar-right">
      <div className="sidebar-right-header">Sidebar header</div>
      <div className="sidebar-right-scroll">Sidebar content</div>
    </aside> : null}
    </div></div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const panel = () => document.querySelector<HTMLElement>(".workbench-panel");
const close = () => flushSync(() => document.querySelector<HTMLButtonElement>(".workbench-tab-close")!.click());
function assert(condition: boolean, message: string) { if (!condition) throw new Error(message); }
async function open(path: string) {
  flushSync(() => controls.openFile(path));
  await wait(340);
  assert(Boolean(panel()?.textContent?.includes(content)), "File content loaded");
}
async function run() {
  const results = document.createElement("pre");
  results.id = "workbench-close-results";
  results.style.cssText = "position:fixed;inset:0;z-index:1000;background:white;color:black;padding:24px;pointer-events:none";
  document.body.append(results);
  const pass = (message: string) => { results.textContent += `PASS ${message}\n`; };
  try {
    await open("first.txt");
    const fileView = document.querySelector(".panel-file-preview-view");
    const originalPanel = panel()!.getBoundingClientRect();
    const originalChat = document.querySelector(".main-chat-view")!.getBoundingClientRect();
    close();
    await wait(60);
    assert(Boolean(panel()?.inert), "Exiting panel is inert");
    assert(document.querySelector(".panel-file-preview-view") === fileView, "File view remains mounted");
    assert(Boolean(panel()?.textContent?.includes(content)), "Content remains visible during slide");
    assert(controls.previewTabs === 1 && closeCalls === 0, "Cleanup waits for slide completion");
    assert(getComputedStyle(panel()!).opacity === "1", "Exit does not fade");
    assert(getComputedStyle(panel()!).transitionProperty === "margin-right", "Exit releases its layout space");
    const movingPanel = panel()!.getBoundingClientRect();
    const growingChat = document.querySelector(".main-chat-view")!.getBoundingClientRect();
    assert(movingPanel.left > originalPanel.left, "The whole panel moves right");
    const docked = getComputedStyle(panel()!).position !== "absolute";
    if (docked) assert(growingChat.width > originalChat.width, "Chat expands during the slide");
    assert(Math.abs(movingPanel.width - originalPanel.width) < 1, "Content width stays stable while sliding");
    if (docked) assert(Math.abs((movingPanel.left - originalPanel.left) - (growingChat.width - originalChat.width)) < 1,
      "Panel movement and layout space release stay synchronized");
    if (sidebarOpen) {
      const sidebar = document.querySelector<HTMLElement>(".sidebar-right")!;
      const bounds = sidebar.getBoundingClientRect();
      const x = bounds.left + Math.min(10, (movingPanel.right - bounds.left) / 2);
      assert(x > bounds.left && x < movingPanel.right, "Sliding panel overlaps the sidebar region");
      // Enable hit testing briefly to inspect paint order; restore the exiting surface immediately.
      const exiting = panel()!;
      exiting.inert = false;
      exiting.style.pointerEvents = "auto";
      try {
        for (const y of [20, 120]) {
          const top = document.elementFromPoint(x, bounds.top + y);
          assert(Boolean(top?.closest(".sidebar-right")), `Sidebar stays above exiting content at y=${y}`);
        }
      } finally {
        exiting.inert = true;
        exiting.style.removeProperty("pointer-events");
      }
    }
    await wait(240);
    assert(!panel() && controls.previewTabs === 0 && closeCalls === 1, "Panel and file cleaned up once");
    pass("Panel and layout space slide together while preserving file content");
    if (sidebarOpen) pass("Sidebar stays above the exiting panel header and content");

    await open("first.txt");
    await open("second.txt");
    close();
    assert(!panel()?.inert && controls.previewTabs === 1 && closeCalls === 2, "Other tabs still close immediately");
    pass("Closing one of multiple tabs remains immediate");
    close();
    await wait(40);
    flushSync(() => controls.addTab());
    await wait(240);
    assert(Boolean(panel()) && !panel()?.inert && document.querySelectorAll(".workbench-tab").length === 1,
      "A new tab cancels the panel exit");
    assert(controls.previewTabs === 0 && closeCalls === 3, "Interrupted close cleans up only the old file");
    pass("Opening a new tab during exit retains the new tab");
    close();
    await wait(240);

    await open("first.txt");
    flushSync(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    close();
    assert(!panel() && controls.previewTabs === 0 && closeCalls === 5, "Reduced motion cleans up immediately");
    pass("Reduced motion closes without waiting");
    results.dataset.status = "passed";
  } catch (error) {
    results.dataset.status = "failed";
    results.textContent += `FAIL ${String(error)}`;
  }
}
setTimeout(() => { void run(); }, 100);

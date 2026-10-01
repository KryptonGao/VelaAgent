/** Isolated renderer fixture: real surfaces, no IPC or filesystem actions. */
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PopoverPresence, ScreenPresence, WorkbenchTabPanel } from "../src/renderer/components/MotionPresence";
import { WorkbenchPanel, type WorkbenchTab } from "../src/renderer/components/WorkbenchPanel";
import { RepoCardPopover } from "../src/renderer/components/RepoCardPopover";
import { AttachMenu } from "../src/renderer/components/composer/AttachMenu";
import { ModeChip } from "../src/renderer/components/composer/ModeChip";
import { ContextUsageTrigger } from "../src/renderer/components/ContextUsagePopover";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import type { SidebarResize } from "../src/renderer/hooks/useSidebarResize";
import "../src/renderer/styles.css";
import { runMotionChecks } from "./motion-checks";

const automated = new URLSearchParams(location.search).has("checks");
// Model the OS preference signal so the same checks can run on any developer machine.
const media = Object.assign(new EventTarget(), { matches: false, media: "(prefers-reduced-motion: reduce)" });
if (automated) {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) => query === media.media ? media as unknown as MediaQueryList : original(query);
}
function setReducedMotion(value: boolean) {
  media.matches = value;
  media.dispatchEvent(new Event("change"));
}

function Fixture() {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState(false);
  const [tab, setTab] = useState("a");
  const [fileKey, setFileKey] = useState("file-a");
  const [tabs, setTabs] = useState<WorkbenchTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [mode, setMode] = useState<"agent" | "plan" | "goal">("agent");
  const addTab = () => {
    const next: WorkbenchTab = { id: String(Date.now()), kind: "start", label: "New tab" };
    setTabs((current) => [...current, next]); setActive(next.id);
  };
  // Deterministic browser checks can change state in one commit, including rapid reversals.
  Object.assign(window, { motionFixture: {
    popover: (value: boolean) => flushSync(() => setOpen(value)),
    screen: (value: boolean) => flushSync(() => setScreen(value)),
    tab: (value: string) => flushSync(() => setTab(value)),
    file: (value: string) => flushSync(() => setFileKey(value)),
    workbench: (value: boolean) => flushSync(() => {
      setTabs(value ? [{ id: "start", kind: "start", label: "New tab" }] : []);
      setActive(value ? "start" : null);
    }),
    repo: (value: boolean) => flushSync(() => setRepoOpen(value)),
  } });
  return <>
    <div style={{ position: "absolute", top: 20, left: 20, zIndex: 10, display: "flex", gap: 20 }}>
      <button onClick={() => setScreen((value) => !value)}>Switch screen</button>
      <button onClick={addTab}>Open workbench</button>
      <div className="composer-chip-anchor">
        <button onClick={() => setOpen((value) => !value)}>Toggle menu</button>
        <PopoverPresence present={open}><div className="dock-popover composer-popover" id="test-menu"><input defaultValue="kept" /></div></PopoverPresence>
      </div>
      <button ref={anchor} onClick={() => setRepoOpen((value) => !value)}>Repo menu</button>
      <PopoverPresence present={repoOpen}><RepoCardPopover anchor={anchor} className="test-repo" label="Repository"><input defaultValue="repo" /></RepoCardPopover></PopoverPresence>
      <AttachMenu onAttachments={() => {}} disabled={false} />
      <ModeChip mode={mode} disabled={false} onChange={setMode} />
      <ContextUsageTrigger usage={null} high={false}>Context</ContextUsageTrigger>
    </div>
    <div className="app-screens">
      <ScreenPresence present={!screen} className="app-screen-onboarding"><div className="vela-window" style={{ padding: 100 }}>Onboarding</div></ScreenPresence>
      <ScreenPresence present={screen} className="app-screen-main">
        <div className="vela-window left-collapsed layout-floating">
          <div style={{ flex: 1, padding: 100 }}>Main screen
            <div className="workbench-content" style={{ height: 200 }}>
              <WorkbenchTabPanel id="tab-a" swapKey={fileKey} hidden={tab !== "a"}><input defaultValue="A" /></WorkbenchTabPanel>
              <WorkbenchTabPanel id="tab-b" hidden={tab !== "b"}><input defaultValue="B" /></WorkbenchTabPanel>
            </div>
          </div>
          <WorkbenchPanel tabs={tabs} activeTabId={active} contextOpen={false} leftOpen={false}
            resize={{ widths: { left: 250, right: 340, workbench: 500 }, startResize() {}, nudge() {}, reset() {} } as SidebarResize}
            project={{} as ProjectApi} busy={false} execution={null} onRevise={() => {}} onExecutePlan={() => {}}
            initialDiffPath={null} initialDiffPathRequestKey={0} selectedChangePath={null} onSelectedChangePath={() => {}}
            onShowDiff={() => {}} agents={[]} getAgentMessages={() => []} ensureAgentMessages={() => {}} onOpenAgent={() => {}}
            onNewTab={addTab} onStartAction={() => {}} gitAvailable={false} onActivateTab={(value) => setActive(value.id)}
            onCloseTab={(value) => { setTabs((current) => current.filter((item) => item.id !== value.id)); setActive(null); }} />
        </div>
      </ScreenPresence>
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

if (automated) {
  setTimeout(() => { void runMotionChecks(setReducedMotion); }, 300);
}

import type { AgentInfo, ExecutionPlan, PlanExecutionContextStrategy } from "@vela/shared";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ProjectApi } from "../hooks/useProject";
import type { SidebarResize } from "../hooks/useSidebarResize";
import type { ToolDisplay } from "../hooks/usePreferences";
import type { MessageStore } from "../hooks/message-store";
import type { UiMessage } from "../hooks/useSession";
import { useMotionPresence } from "../hooks/useMotionPresence";
import { WorkbenchTabPanel } from "./MotionPresence";
import { tr, trf } from "../locale";
import { AgentPane } from "./AgentPane";
import { AgentStatusMark } from "./AgentPanel";
import { ChangesView } from "./ChangesView";
import { TurnReviewView } from "./TurnReviewView";
import type { TurnReviewRequest } from "./turn-changes";
import { FileTypeIcon } from "./FileTypeIcon";
import { FileBrowserView } from "./preview/FileBrowserView";
import { FilePreviewView } from "./preview/FilePreviewView";
import { useFilePreview } from "./preview/FilePreviewContext";
import { PlanDocumentPane } from "./PlanPanel";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { StartView, type StartTabAction } from "./StartView";
import { TerminalView } from "./TerminalView";
import { BrowserPanel, BrowserTabLabel } from "./browser/BrowserPanel";
import type { BrowserController } from "../browser/browser-controller";
import { ArrowRightIcon, CloseIcon, FileIcon, FolderIcon, GlobeIcon, PlanIcon, PlusIcon, TerminalIcon } from "./icons";

export type WorkbenchTab =
  | { id: string; kind: "plan"; label: string; title?: string }
  | { id: string; kind: "file"; label: string; title: string; path: string }
  | { id: string; kind: "changes"; label: string; title?: string }
  | { id: string; kind: "turn-review"; label: string; title?: string; review: TurnReviewRequest }
  | { id: string; kind: "agent"; label: string; title: string; agent: AgentInfo }
  | { id: string; kind: "start"; label: string; title?: string }
  | { id: string; kind: "files"; label: string; title?: string }
  | { id: string; kind: "browser"; label: string; title?: string; controller: BrowserController }
  | { id: string; kind: "terminal"; label: string; title?: string; sessionId: string };

interface WorkbenchPanelProps {
  tabs: WorkbenchTab[];
  collapsed?: boolean;
  browserOperating?: boolean;
  onCollapse?: () => void;
  activeTabId: string | null;
  contextOpen: boolean;
  leftOpen: boolean;
  resize: SidebarResize;
  project: ProjectApi;
  busy: boolean;
  execution: ExecutionPlan | null;
  onRevise: () => void;
  onExecutePlan: (strategy: PlanExecutionContextStrategy) => void;
  initialDiffPath: string | null;
  initialDiffPathRequestKey: number;
  selectedChangePath: string | null;
  onSelectedChangePath: (path: string | null) => void;
  onShowDiff: (path: string) => void;
  agents: readonly AgentInfo[];
  getAgentMessages?: (agentId: string) => UiMessage[];
  messageStore?: MessageStore;
  conversationId?: string | null;
  toolDisplay?: ToolDisplay;
  ensureAgentMessages: (agentId: string) => void;
  onOpenAgent: (agentId: string) => void;
  /** 新建一个起始标签页 */
  onNewTab: () => void;
  /** 起始页选中某个入口后,把该标签替换成对应内容 */
  onStartAction: (tab: WorkbenchTab, action: StartTabAction) => void;
  /** 当前工作区是否是 Git 仓库,决定「变更」入口是否可选 */
  gitAvailable: boolean;
  onActivateTab: (tab: WorkbenchTab) => void;
  onCloseTab: (tab: WorkbenchTab) => void;
}

function safeId(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return /[a-zA-Z0-9_-]/.test(character) ? character : `_${code.toString(16)}_`;
  }).join("");
}

function TabIcon({ tab }: { tab: WorkbenchTab }) {
  // 文件标签用对应文件类型的图标(与文件树、变更列表同一套组件与主题)。
  if (tab.kind === "file") return <FileTypeIcon path={tab.path} />;
  if (tab.kind === "changes" || tab.kind === "turn-review") return <FileIcon size={12} />;
  if (tab.kind === "plan") return <PlanIcon size={12} />;
  if (tab.kind === "start") return <PlusIcon size={12} />;
  if (tab.kind === "files") return <FolderIcon size={12} />;
  if (tab.kind === "terminal") return <TerminalIcon size={12} />;
  if (tab.kind === "browser") return <GlobeIcon size={12} />;
  return <AgentStatusMark status={tab.agent.status} />;
}

export function WorkbenchPanel(props: WorkbenchPanelProps) {
  const [pendingClose, setPendingClose] = useState<{ tabId: string; complete: () => void } | null>(null);
  const presence = useMotionPresence(props.tabs.length > 0 && !pendingClose, 160);
  const frozen = useRef(props);
  if (props.tabs.length > 0 && !pendingClose) frozen.current = props;
  useLayoutEffect(() => {
    if (!pendingClose) return;
    // Keep content providers and mounted views alive until the panel has slid out.
    // A new tab interrupts the exit and closes only the previously requested tab.
    const interrupted = props.tabs.some((tab) => tab.id !== pendingClose.tabId);
    if (presence.mounted && !interrupted) return;
    pendingClose.complete();
    setPendingClose(null);
  }, [pendingClose, presence.mounted, props.tabs]);
  if (!presence.mounted) return null;
  return <WorkbenchPanelContent {...(presence.closing ? frozen.current : props)}
    onLastTabClose={(tab, complete) => setPendingClose({ tabId: tab.id, complete })}
    closing={presence.closing} finishExit={presence.finishExit} />;
}

function WorkbenchPanelContent({
  closing,
  finishExit,
  onLastTabClose,
  tabs,
  collapsed = false,
  onCollapse,
  activeTabId,
  contextOpen,
  leftOpen,
  resize,
  project,
  busy,
  execution,
  onRevise,
  onExecutePlan,
  initialDiffPath,
  initialDiffPathRequestKey,
  selectedChangePath,
  onSelectedChangePath,
  onShowDiff,
  agents,
  getAgentMessages,
  messageStore,
  conversationId,
  browserOperating,
  toolDisplay,
  ensureAgentMessages,
  onOpenAgent,
  onNewTab,
  onStartAction,
  gitAvailable,
  onActivateTab,
  onCloseTab,
}: WorkbenchPanelProps & {
  closing: boolean;
  finishExit: () => void;
  onLastTabClose: (tab: WorkbenchTab, complete: () => void) => void;
}) {
  const preview = useFilePreview();
  const panelRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!closing || !panel) return;
    panel.style.setProperty("--workbench-exit-width", `${panel.getBoundingClientRect().width}px`);
  }, [closing]);
  const id = useId();
  const baseId = `workbench-${safeId(id)}`;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const planTab = tabs.find((tab) => tab.kind === "plan") ?? null;
  const changesTab = tabs.find((tab) => tab.kind === "changes") ?? null;
  const fileTabs = tabs.filter((tab): tab is Extract<WorkbenchTab, { kind: "file" }> => tab.kind === "file");
  const agentTabs = tabs.filter((tab): tab is Extract<WorkbenchTab, { kind: "agent" }> => tab.kind === "agent");
  const startTabs = tabs.filter((tab): tab is Extract<WorkbenchTab, { kind: "start" }> => tab.kind === "start");
  const terminalTabs = tabs.filter((tab): tab is Extract<WorkbenchTab, { kind: "terminal" }> => tab.kind === "terminal");
  const browserTabs = tabs.filter((tab): tab is Extract<WorkbenchTab, { kind: "browser" }> => tab.kind === "browser");
  const filesTab = tabs.find((tab): tab is Extract<WorkbenchTab, { kind: "files" }> => tab.kind === "files") ?? null;
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const tabListRef = useRef<HTMLElement | null>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const [closeButtonPositions, setCloseButtonPositions] = useState<Record<string, { left: number; top: number; clipped: boolean }>>({});
  /*
   * 标签宽度由这里算好写成内联 width:标签行可用宽度按数量平分,夹在 72–220px 之间。
   * 之所以不用 flex 平分,是因为 flex 分配出来的宽度没法做过渡动画;
   * 值写成明确的 px 后,宽度变化就交给 CSS transition 平滑过去。
   * pinnedTabWidth 是指针停在标签行时锁定的宽度(关闭标签不重排)。
   */
  const [tabWidth, setTabWidth] = useState(0);
  const [pinnedTabWidth, setPinnedTabWidth] = useState<number | null>(null);
  const tabbarHovered = useRef(false);
  const previousTabCount = useRef(tabs.length);

  const measureTabWidth = useCallback((list: HTMLElement, count: number, pinned: number | null): number => {
    if (pinned !== null) return pinned;
    if (!count) return 0;
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    const usable = Math.max(0, list.clientWidth - gap * (count - 1));
    // 72/220 与 .workbench-tab 的 min-width / max-width 对应,改一个记得改另一个。
    return Math.max(72, Math.min(220, usable / count));
  }, []);

  // 数量/锁定状态变化时重算宽度:先于绘制执行,首帧不会拿旧宽度闪一下。
  useLayoutEffect(() => {
    const list = tabListRef.current;
    if (!list) return;
    const next = measureTabWidth(list, tabs.length, pinnedTabWidth);
    setTabWidth((current) => (Math.abs(current - next) < 0.01 ? current : next));
  }, [measureTabWidth, pinnedTabWidth, tabs.length]);

  // 新建标签:即使指针停在标签行上也要立刻按新数量变窄,直接把锁定值换成新目标宽度即可
  // (宽度过渡由 CSS 完成);关闭标签则保持锁定。指针离开行时由 onPointerLeave 解开。
  useEffect(() => {
    const previous = previousTabCount.current;
    previousTabCount.current = tabs.length;
    if (!tabbarHovered.current || tabs.length <= previous) return;
    const list = tabListRef.current;
    if (!list) return;
    setPinnedTabWidth(measureTabWidth(list, tabs.length, null));
  }, [measureTabWidth, tabs.length]);

  const tabPanelId = (tab: WorkbenchTab): string => {
    if (tab.kind === "file") return `${baseId}-panel-files`;
    return `${baseId}-panel-${safeId(tab.id)}`;
  };
  const tabButtonId = (tab: WorkbenchTab): string => `${baseId}-tab-${safeId(tab.id)}`;
  const filePanelTab = activeTab?.kind === "file" ? activeTab : fileTabs[0] ?? null;

  useLayoutEffect(() => {
    const tabList = tabListRef.current;
    const tabBar = tabBarRef.current;
    if (!tabList || !tabBar) return;

    const updateClosePositions = () => {
      const listRect = tabList.getBoundingClientRect();
      const barRect = tabBar.getBoundingClientRect();
      const next: Record<string, { left: number; top: number; clipped: boolean }> = {};
      for (const tab of tabs) {
        const button = tabButtons.current.get(tab.id);
        if (!button) continue;
        const rect = button.getBoundingClientRect();
        // Place X at the visible end of the tab, including tabs clipped by the strip edge.
        const visibleLeft = Math.max(rect.left, listRect.left);
        const visibleRight = Math.min(rect.right, listRect.right);
        if (visibleRight - visibleLeft < 24) continue;
        next[tab.id] = {
          left: visibleRight - barRect.left - 24,
          top: rect.top - barRect.top + (rect.height - 24) / 2,
          clipped: rect.right > listRect.right,
        };
      }
      setCloseButtonPositions((current) => {
        const currentIds = Object.keys(current);
        const nextIds = Object.keys(next);
        if (currentIds.length === nextIds.length && nextIds.every((key) =>
          current[key]?.left === next[key]?.left && current[key]?.top === next[key]?.top &&
          current[key]?.clipped === next[key]?.clipped
        )) return current;
        return next;
      });
    };

    const revealActiveTab = () => {
      const activeButton = activeTabId ? tabButtons.current.get(activeTabId) : null;
      if (!activeButton) return;
      const listRect = tabList.getBoundingClientRect();
      const activeRect = activeButton.getBoundingClientRect();
      if (activeRect.left < listRect.left) {
        tabList.scrollLeft -= listRect.left - activeRect.left;
      } else if (activeRect.right > listRect.right) {
        tabList.scrollLeft += activeRect.right - listRect.right;
      }
    };
    revealActiveTab();

    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateClosePositions();
      });
    };
    updateClosePositions();
    tabList.addEventListener("scroll", scheduleUpdate, { passive: true });
    /*
     * 标签多到溢出时用滚轮横滚:标签页到下限后不再继续缩窄,靠这条滑动看其余标签。
     * 鼠标只有竖向滚轮也映射成横向;已经滚到头就把事件还给页面,不抢别的滚动。
     */
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const max = tabList.scrollWidth - tabList.clientWidth;
      if (max <= 0) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const next = Math.max(0, Math.min(max, tabList.scrollLeft + delta));
      if (next === tabList.scrollLeft) return;
      event.preventDefault();
      tabList.scrollLeft = next;
    };
    tabList.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(() => {
      revealActiveTab();
      scheduleUpdate();
      // 标签行自身被拉宽/收窄时宽度目标要跟着变(锁定期间则保持锁定值)。
      const next = measureTabWidth(tabList, tabs.length, pinnedTabWidth);
      setTabWidth((current) => (Math.abs(current - next) < 0.01 ? current : next));
    });
    observer.observe(tabList);
    observer.observe(tabBar);
    for (const button of tabButtons.current.values()) observer.observe(button);
    return () => {
      tabList.removeEventListener("scroll", scheduleUpdate);
      tabList.removeEventListener("wheel", onWheel);
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeTabId, measureTabWidth, pinnedTabWidth, tabs]);


  const activateTab = (tab: WorkbenchTab): void => {
    if (tab.kind === "file") preview?.setActiveTab(tab.path);
    onActivateTab(tab);
  };

  const focusTab = (tab: WorkbenchTab): void => {
    activateTab(tab);
    requestAnimationFrame(() => tabButtons.current.get(tab.id)?.focus());
  };

  const closeTab = (tab: WorkbenchTab): void => {
    if (closing) return;
    const index = tabs.findIndex((candidate) => candidate.id === tab.id);
    const next = activeTabId === tab.id
      ? tabs[index + 1] ?? tabs[index - 1] ?? null
      : activeTab;
    const completeClose = () => {
      if (tab.kind === "file") {
        preview?.closeTab(tab.path);
      }
      onCloseTab(tab);
    };
    if (tabs.length === 1 && tab.kind !== "browser") onLastTabClose(tab, completeClose);
    else completeClose();
    requestAnimationFrame(() => {
      if (next) tabButtons.current.get(next.id)?.focus();
      else document.querySelector<HTMLElement>(".main-chat-view")?.focus();
    });
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: WorkbenchTab): void => {
    const index = tabs.findIndex((tab) => tab.id === current.id);
    let target: WorkbenchTab | undefined;
    if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") target = tabs[0];
    else if (event.key === "End") target = tabs[tabs.length - 1];
    if (!target) return;
    event.preventDefault();
    focusTab(target);
  };

  return (
    <aside
      ref={panelRef}
      className={`workbench-panel${contextOpen ? " is-context-open" : ""}${closing ? " is-closing" : ""}${collapsed ? " is-collapsed" : ""}`}
      inert={closing || collapsed} aria-hidden={closing || collapsed || undefined}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "margin-right") finishExit();
      }}
      aria-label={tr("工作面板", "Workbench")}
    >
      <SidebarResizeHandle target="workbench" resize={resize} contextOpen={contextOpen} leftOpen={leftOpen} />
      <div
        className="workbench-tabbar"
        ref={tabBarRef}
        onPointerEnter={(event) => {
          // 触控没有“悬停”语义,不锁宽度。
          if (event.pointerType === "touch") return;
          tabbarHovered.current = true;
          setPinnedTabWidth((current) => current ?? tabWidth);
        }}
        onPointerLeave={() => {
          tabbarHovered.current = false;
          setPinnedTabWidth(null);
        }}
      >
        <nav
          ref={(node) => { tabListRef.current = node; }}
          className="workbench-tablist"
          role="tablist"
          aria-label={tr("工作面板标签", "Workbench tabs")}
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeTabId;
            const title = tab.title ?? tab.label;
            return (
              <button
                ref={(node) => {
                  if (node) tabButtons.current.set(tab.id, node);
                  else tabButtons.current.delete(tab.id);
                }}
                id={tabButtonId(tab)}
                className="workbench-tab"
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={tabPanelId(tab)}
                tabIndex={selected ? 0 : -1}
                title={title}
                style={tabWidth ? { width: `${tabWidth}px` } : undefined}
                onClick={() => activateTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, tab)}
                key={tab.id}
              >
                <TabIcon tab={tab} />
                {tab.kind === "browser" ? <BrowserTabLabel controller={tab.controller} />
                  : <span className="workbench-tab-label">{tab.label}</span>}
              </button>
            );
        })}
        </nav>
        <div className="workbench-tab-close-layer">
          {tabs.map((tab) => {
            const position = closeButtonPositions[tab.id];
            if (!position) return null;
            return (
              <button
                className={`workbench-tab-close${position.clipped ? " is-clipped" : ""}`}
                type="button"
                aria-label={trf("关闭 {0}", "Close {0}", tab.label)}
                title={tr("关闭标签", "Close tab")}
                style={{ left: position.left, top: position.top }}
                onClick={() => closeTab(tab)}
                key={tab.id}
              >
                <CloseIcon size={12} />
              </button>
            );
          })}
        </div>
        <button
          className="workbench-new-tab"
          type="button"
          aria-label={tr("新建标签页", "New tab")}
          title={tr("新建标签页", "New tab")}
          onClick={onNewTab}
        >
          <PlusIcon size={14} />
        </button>
        {onCollapse && <button className="workbench-collapse" type="button" aria-expanded={!collapsed}
          aria-label={tr("折叠工作面板", "Collapse workbench")}
          title={tr("折叠工作面板", "Collapse workbench")} onClick={onCollapse}>
          <ArrowRightIcon size={14} />
        </button>}
      </div>

      <div className="workbench-content" inert={collapsed} aria-hidden={collapsed || undefined}>
        {browserTabs.map((tab) => (
          <WorkbenchTabPanel key={tab.id} id={tabPanelId(tab)} role="tabpanel"
            aria-labelledby={tabButtonId(tab)} hidden={activeTabId !== tab.id}>
            <BrowserPanel controller={tab.controller} tabId={tab.id} operating={browserOperating}
              onAbort={() => { if (conversationId) void window.vela?.abort(conversationId); }} />
          </WorkbenchTabPanel>
        ))}
        {fileTabs.length > 0 && preview ? (
          <WorkbenchTabPanel
            id={`${baseId}-panel-files`}
            swapKey={activeTab?.kind === "file" ? activeTab.id : undefined}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={filePanelTab ? tabButtonId(filePanelTab) : undefined}
            tabIndex={0}
            hidden={activeTab?.kind !== "file"}
          >
            <FilePreviewView project={project} onShowDiff={onShowDiff} />
          </WorkbenchTabPanel>
        ) : null}

        {planTab ? (
          <WorkbenchTabPanel
            id={tabPanelId(planTab)}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={tabButtonId(planTab)}
            tabIndex={0}
            hidden={activeTab?.kind !== "plan"}
          >
            <PlanDocumentPane
              busy={busy}
              execution={execution}
              onRevise={onRevise}
              onExecutePlan={onExecutePlan}
              visible={activeTab?.kind === "plan"}
            />
          </WorkbenchTabPanel>
        ) : null}

        {changesTab ? (
          <WorkbenchTabPanel
            id={tabPanelId(changesTab)}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={tabButtonId(changesTab)}
            tabIndex={0}
            hidden={activeTab?.kind !== "changes"}
          >
            <ChangesView
              project={project}
              initialPath={initialDiffPath}
              initialPathRequestKey={initialDiffPathRequestKey}
              selectedPath={selectedChangePath}
              onSelectedPathChange={onSelectedChangePath}
              visible={activeTab?.kind === "changes"}
              onClose={() => closeTab(changesTab)}
              onPreviewFile={(path) => {
                const fileTab = fileTabs.find((tab) => tab.path === path || tab.id === path);
                if (fileTab) activateTab(fileTab);
                preview?.openFile(path);
              }}
            />
          </WorkbenchTabPanel>
        ) : null}

        {tabs.filter((tab): tab is Extract<WorkbenchTab, { kind: "turn-review" }> => tab.kind === "turn-review").map(tab => (
          <WorkbenchTabPanel
            id={tabPanelId(tab)}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={tabButtonId(tab)}
            tabIndex={0}
            hidden={activeTab?.id !== tab.id}
            key={tab.id}
          >
            <TurnReviewView key={tab.review.turnId} review={tab.review}
              visible={activeTab?.id === tab.id} onClose={() => closeTab(tab)} />
          </WorkbenchTabPanel>
        ))}

        {filesTab ? (
          <WorkbenchTabPanel
            id={tabPanelId(filesTab)}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={tabButtonId(filesTab)}
            tabIndex={0}
            hidden={activeTab?.id !== filesTab.id}
          >
            <FileBrowserView />
          </WorkbenchTabPanel>
        ) : null}

        {startTabs.map((tab) => (
          <WorkbenchTabPanel
            id={tabPanelId(tab)}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={tabButtonId(tab)}
            tabIndex={0}
            hidden={activeTab?.id !== tab.id}
            key={tab.id}
          >
            <StartView gitAvailable={gitAvailable} onAction={(action) => onStartAction(tab, action)} />
          </WorkbenchTabPanel>
        ))}

        {terminalTabs.map((tab) => (
          <WorkbenchTabPanel
            id={tabPanelId(tab)}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={tabButtonId(tab)}
            tabIndex={0}
            hidden={activeTab?.id !== tab.id}
            key={tab.id}
          >
            <TerminalView sessionId={tab.sessionId} visible={activeTab?.id === tab.id} />
          </WorkbenchTabPanel>
        ))}

        {agentTabs.map((tab) => (
          <WorkbenchTabPanel
            id={tabPanelId(tab)}
            className="workbench-tabpanel"
            role="tabpanel"
            aria-labelledby={tabButtonId(tab)}
            tabIndex={0}
            hidden={activeTab?.id !== tab.id}
            key={tab.id}
          >
            <AgentPane
                agent={tab.agent}
                agents={agents}
                messages={getAgentMessages?.(tab.agent.id)}
                messageStore={messageStore}
                conversationId={conversationId}
                toolDisplay={toolDisplay}
                visible={activeTab?.id === tab.id}
                onSwitch={(agentId) => {
                  const next = tabs.find((candidate) => candidate.kind === "agent" && candidate.agent.id === agentId);
                  if (next) activateTab(next);
                  else onOpenAgent(agentId);
                }}
                ensureMessages={ensureAgentMessages}
            />
          </WorkbenchTabPanel>
        ))}
      </div>
    </aside>
  );
}

import { QuestionContext } from "./QuestionContext";
import { LazyMount } from "./LazyMount";
import { useFrameTask } from "../hooks/useFrameTask";
import { VersionControlView } from "./version-control/VersionControlView";
import { TraceView } from "./trace/TraceView";
import { UsageView } from "./usage/UsageView";
import type { AppState, AskUserQuestionRequest, InteractionMode } from "@vela/shared";
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgentWorkspace } from "./AgentPanel";
import { modKeyLabel } from "../platform";
import { ArrowLeftIcon, BranchIcon, CheckIcon, CopyIcon, FolderIcon, PlusIcon, StackIcon } from "./icons";
import { trackEnteredMessages, type EnterTrack } from "./message-motion";
import type { useModels } from "../hooks/useModels";
import type { ProjectApi } from "../hooks/useProject";
import type { ToolDisplay, ToolFold } from "../hooks/usePreferences";
import type { UiMessage } from "../hooks/useSession";
import { RepoCard } from "./RepoCard";
import { Composer } from "./Composer";
import { useContentArrival } from "./BatchMotion";
import { Markdown } from "./Markdown";
import { ConversationLinkContext } from "./ConversationLinkContext";
import { OpenInAppButton } from "./OpenInAppButton";
import { Thinking } from "./Thinking";
import { ThinkingSummaryContext } from "./ThinkingSummaryContext";
import type { ThinkingSummariesApi } from "../hooks/useThinkingSummaries";
import { ToolCard, ToolList, CompactToolGroup, CompactToolLine, ToolRunGroup, type QuestionLookup } from "./ToolCard";
import { toolCompactKind } from "./tool-compact";
import { buildTurnItems, groupProcessItems, type ProcessNode } from "./tool-sequence";
import { formatDuration, readToolDuration } from "./tool-duration";
import { foldSequenceId } from "./tool-fold-state";
import { useToolExpanded, useToolProcessDetails, useToolsDuration } from "./ToolProcessContext";
import { PlanPreviewList } from "./PlanPanel";
import { collectPlanIds, planReferenceModel } from "../plan-draft";
import { SkillToken } from "./composer/SkillMenu";
import { parseSkillPrompt } from "./composer/skill-picker";
import { useFilePreview } from "./preview/FilePreviewContext";
import { nextStreamFollow, releasesStreamFollow, shouldResumeFollowForMessages } from "./chat-scroll";
import { summarizeTurnChanges, type TurnChanges, type TurnReviewRequest } from "./turn-changes";
import { chatLaneDefaultMaxWidth, planChatLane } from "../chat-lane";
import { ConversationViewTabs, type ConversationViewKey } from "./ConversationViewTabs";
import { UserMessageFrame } from "./UserMessageFrame";
import { ImageViewer, type ImageViewerRequest } from "./ImageViewer";
import { isEnglish, localizeError, tr } from "../locale";

interface FollowState {
  pinned: boolean;
  lastScrollTop: number;
  ignoreScroll: boolean;
  conversationId: string | null | undefined;
  userMessageId: string | null | undefined;
}

function scrollFollowToEnd(scroller: HTMLDivElement, follow: FollowState) {
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;
  if (maxScroll - scroller.scrollTop < 1) {
    follow.lastScrollTop = scroller.scrollTop;
    return;
  }
  follow.ignoreScroll = true;
  scroller.scrollTop = scroller.scrollHeight;
  if (follow.ignoreScroll) {
    follow.ignoreScroll = false;
    follow.lastScrollTop = scroller.scrollTop;
  }
}

function latestUserMessageId(messages: UiMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.id;
  }
  return null;
}

interface MessageTurn {
  id: string;
  user: UiMessage | null;
  assistants: UiMessage[];
}

function groupMessagesIntoTurns(messages: UiMessage[], previous: MessageTurn[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  let current: MessageTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = { id: message.id, user: message, assistants: [] };
      turns.push(current);
    } else {
      if (!current) {
        current = { id: message.id, user: null, assistants: [] };
        turns.push(current);
      }
      current.assistants.push(message);
    }
  }
  const old = new Map(previous.map(turn => [turn.id, turn]));
  return turns.map(turn => {
    const before = old.get(turn.id);
    return before && before.user === turn.user && before.assistants.length === turn.assistants.length &&
      before.assistants.every((message, index) => message === turn.assistants[index]) ? before : turn;
  });
}

function formatElapsedTime(startedAt: number | undefined, completedAt: number | undefined): string | null {
  if (startedAt === undefined || completedAt === undefined) return null;
  const totalSeconds = Math.max(0, Math.floor((completedAt - startedAt) / 1000));
  if (totalSeconds < 1) return tr("不到 1 秒", "<1 sec");
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return tr(`${hours}小时${minutes}分${seconds}秒`, `${hours}h ${minutes}m ${seconds}s`);
  if (minutes > 0) return tr(`${minutes}分${seconds}秒`, `${minutes}m ${seconds}s`);
  return tr(`${seconds}秒`, `${seconds}s`);
}

/**
 * 运行中的轮次在最终回复出现前显示“已处理 xx”。回复完成后这一行会被
 * CompletedAssistantTurn 的“用时 xx”触发器接替,位置与分界线保持不变。
 */
function TurnProgressHeader({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsed = formatElapsedTime(startedAt, now);
  if (!elapsed) return null;
  return (
    <span className="time-spent-trigger assistant-turn-trigger">
      {tr(`已处理 ${elapsed}`, `Worked ${elapsed}`)}
    </span>
  );
}

export interface ChatViewProps {
  messages: UiMessage[];
  state: AppState | null;
  sendError: string | null;
  platform: string;
  leftCollapsed: boolean;
  onToggleLeft: () => void;
  onRenameConversation?: (id: string) => void;
  floatingInfo?: boolean;
  environmentCollapsed?: boolean;
  changesActive?: boolean;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  project: ProjectApi;
  toolDisplay?: ToolDisplay;
  toolFold?: ToolFold;
  thinkingSummaries?: ThinkingSummariesApi;
  /** 在输入框模型列表中隐藏的模型，key 为 `provider/id`。 */
  hiddenModels?: string[];
  onSend: (text: string, images?: import("@vela/shared").ImageAttachment[], deliverAs?: import("@vela/shared").RuntimeInstructionMode) => Promise<void>;
  /** 撤销一条还没被模型消费的排队/调整指令。 */
  onRemoveInstruction: (instructionId: string) => Promise<void>;
  onEdit?: (turnIndex: number, text: string, images?: import("@vela/shared").ImageAttachment[]) => Promise<void>;
  onAbort: () => Promise<void>;
  onMode: (mode: import("@vela/shared").InteractionMode) => void;
  models: ReturnType<typeof useModels>;
  question?: AskUserQuestionRequest | null;
  getQuestion: QuestionLookup;
  onReplyQuestion: (id: string, answer: string | null) => void;
  /** 从某一轮回复处分支出新对话;参数是可见用户消息的序号。 */
  onBranch: (turnIndex: number) => void;
  /** 顶栏的「新建标签页」入口:工作面板没开、或右侧栏收起时才显示,避免和标签栏的 + 重复。 */
  showNewTab: boolean;
  onExpandWorkbench?: () => void;
  onOpenWebLink?: (url: string) => boolean;
  onNewTab: () => void;
  onOpenChanges: () => void;
  onReviewTurn?: (request: TurnReviewRequest) => void;
  planDraft?: import("../plan-draft").PlanDraft | null;
  onOpenPlan?: (planId: string) => void;
}

export function ChatView({
  messages,
  state,
  sendError,
  platform,
  leftCollapsed,
  onToggleLeft,
  onRenameConversation,
  rightCollapsed,
  onToggleRight,
  floatingInfo = false,
  environmentCollapsed = false,
  changesActive = false,
  project,
  toolDisplay = "card",
  toolFold = "message",
  thinkingSummaries,
  hiddenModels = [],
  onSend,
  onRemoveInstruction,
  onEdit,
  onAbort,
  onMode,
  models,
  question = null,
  getQuestion,
  onReplyQuestion,
  onBranch,
  showNewTab,
  onExpandWorkbench,
  onOpenWebLink,
  onNewTab,
  onOpenChanges,
  onReviewTurn,
  planDraft = null,
  onOpenPlan,
}: ChatViewProps) {
  const [views, setViews] = useState<Record<string, ConversationViewKey>>({});
  const [vcMounted, setVcMounted] = useState(false);
  const [imageView, setImageView] = useState<ImageViewerRequest | null>(null);
  // 换会话时收起全屏查看器:里面是上一条对话的图片。
  useEffect(() => { setImageView(null); }, [state?.activeConversationId]);
  const viewKey = state?.activeConversationId ?? "empty";
  const view = views[viewKey] ?? "chat";
  const setView = (next: ConversationViewKey) => {
    if (next === "versionControl") setVcMounted(true);
    setViews(current => ({ ...current, [viewKey]: next }));
  };
  const pendingInteraction = Boolean(project.approval) || messages.some(message => message.tools.some(tool => getQuestion(tool.id)));
  const session = state?.session;
  const streaming = session?.status === "streaming";
  const activeAssistantId = streaming
    ? [...messages].reverse().find((message) => message.role === "assistant")?.id
    : undefined;
  const title = session?.title || tr("新对话", "New chat");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<FollowState>({
    pinned: true,
    lastScrollTop: 0,
    ignoreScroll: false,
    conversationId: undefined,
    userMessageId: undefined,
  });

  const scheduleLayout = useFrameTask(() => {
    const scroller = scrollerRef.current;
    const dock = dockRef.current;
    const root = scroller?.parentElement;
    if (!scroller || !dock || !root || view !== "chat") return;
    const height = dock.getBoundingClientRect().height;
    if (height > 0) root.style.setProperty("--composer-clearance", `${Math.ceil(height + 36)}px`);
    if (followRef.current.pinned) scrollFollowToEnd(scroller, followRef.current);
  });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const dock = dockRef.current;
    const root = scroller?.parentElement;
    if (!scroller || !dock || !root) return;

    let scrollbarHideTimer: number | undefined;
    const showScrollbar = () => {
      scroller.classList.add("is-scrolling");
      window.clearTimeout(scrollbarHideTimer);
      scrollbarHideTimer = window.setTimeout(() => {
        scroller.classList.remove("is-scrolling");
      }, 800);
    };

    const onScroll = () => {
      showScrollbar();
      const follow = followRef.current;
      if (follow.ignoreScroll) {
        follow.ignoreScroll = false;
        follow.lastScrollTop = scroller.scrollTop;
        return;
      }
      const scrollTop = scroller.scrollTop;
      const distanceFromBottom = scroller.scrollHeight - scrollTop - scroller.clientHeight;
      const wasPinned = follow.pinned;
      follow.pinned = nextStreamFollow({
        following: follow.pinned,
        scrollTop,
        previousScrollTop: follow.lastScrollTop,
        distanceFromBottom,
      });
      if (!wasPinned && follow.pinned) scheduleLayout();
      else follow.lastScrollTop = scrollTop;
    };

    const releaseIfScrollingUp = (towardEarlier: boolean) => {
      if (releasesStreamFollow(scroller.scrollTop, towardEarlier)) followRef.current.pinned = false;
    };
    const onWheel = (event: WheelEvent) => releaseIfScrollingUp(event.deltaY < 0);

    let touchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? touchY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y == null) return;
      releaseIfScrollingUp(y > touchY + 2);
      touchY = y;
    };

    scheduleLayout();
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(dock);
    // 展开思考或工具差异会改变消息高度,即使消息本身没有更新,贴底时也要跟随到底部,
    // 否则新增内容会被固定在底部的输入框挡住。
    const contentObserver = new ResizeObserver(scheduleLayout);
    const observedContent = new Set<Element>();
    const syncObservedContent = () => {
      const content = new Set(Array.from(scroller.children));
      for (const child of observedContent) {
        if (!content.has(child)) {
          contentObserver.unobserve(child);
          observedContent.delete(child);
        }
      }
      for (const child of content) {
        if (!observedContent.has(child)) {
          observedContent.add(child);
          contentObserver.observe(child);
        }
      }
    };
    syncObservedContent();
    const contentMutations = new MutationObserver(syncObservedContent);
    contentMutations.observe(scroller, { childList: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      window.clearTimeout(scrollbarHideTimer);
      scroller.classList.remove("is-scrolling");
      observer.disconnect();
      contentObserver.disconnect();
      contentMutations.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      root.style.removeProperty("--composer-clearance");
    };
  }, [scheduleLayout]);

  // 流式输出时只有贴着底部才跟随;用户向上滚之后保持当前位置。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const follow = followRef.current;
    const conversationId = state?.activeConversationId ?? null;
    const userMessageId = latestUserMessageId(messages);
    if (
      shouldResumeFollowForMessages({
        conversationChanged: conversationId !== follow.conversationId,
        previousUserMessageId: follow.userMessageId ?? null,
        userMessageId,
      })
    ) {
      follow.pinned = true;
    }
    follow.conversationId = conversationId;
    follow.userMessageId = userMessageId;
    if (follow.pinned) scheduleLayout();
  }, [messages, state?.activeConversationId, scheduleLayout, view]);

  const messageSurfaceKey = JSON.stringify([project.workspace?.current ?? null, state?.activeConversationId ?? null]);
  const messageSurfaceRef = useContentArrival(messageSurfaceKey, 180, 6);

  // 悬浮信息布局下,环境卡片会盖住居中的对话列右缘:被盖住时把对话列放到
  // 「左侧边栏分界 → 卡片左缘」之间居中,两侧预留滚动区的横向 padding。
  // 卡片避让最多收窄不到 10%,间距另计;超过预算就保持原样(见 chat-lane.ts)。
  useLayoutEffect(() => {
    const pane = scrollerRef.current?.parentElement;
    if (!floatingInfo || environmentCollapsed || !pane) return;

    // 消息面会在工作区/会话切换时按 key 重建,每次测量都重新取一遍实时元素。
    const measure = () => {
      const surface = pane.querySelector<HTMLElement>(".chat-message-surface");
      const card = pane.querySelector<HTMLElement>(".floating-environment");
      const scroller = scrollerRef.current;
      if (!surface || !card || !scroller) return null;
      const surfaceBox = surface.getBoundingClientRect();
      if (!(surfaceBox.width > 0)) return null;
      // 列宽上限由 CSS 变量维护,JS 只负责按实测几何决定移多少、收多少。
      const maxLane =
        Number.parseFloat(getComputedStyle(pane).getPropertyValue("--chat-lane-max")) || chatLaneDefaultMaxWidth;
      const laneWidth = Math.min(surfaceBox.width, maxLane);
      return planChatLane({
        laneLeft: surfaceBox.left + (surfaceBox.width - laneWidth) / 2,
        laneWidth,
        minGap: Number.parseFloat(getComputedStyle(scroller).paddingLeft),
        cardLeft: card.getBoundingClientRect().left,
        // 左侧边栏分界即对话区左缘,让位后左右两侧的距离以它为参照。
        laneLimitLeft: pane.getBoundingClientRect().left,
      });
    };

    const apply = () => {
      const plan = measure();
      if (!plan) return;
      const scroller = scrollerRef.current;
      if (scroller) pane.style.setProperty("--chat-scrollbar-width", `${scroller.offsetWidth - scroller.clientWidth}px`);
      pane.style.setProperty("--chat-lane-shift", `${plan.shift}px`);
      pane.style.setProperty("--chat-lane-shrink", `${plan.shrink}px`);
    };

    apply();
    // 触发条件只有窗口/侧栏和卡片自身的尺寸变化;变量只改对话列宽度,不会反哺这三者。
    const observer = new ResizeObserver(apply);
    observer.observe(pane);
    const card = pane.querySelector<HTMLElement>(".floating-environment");
    if (card) observer.observe(card);
    return () => {
      observer.disconnect();
      pane.style.removeProperty("--chat-scrollbar-width");
      pane.style.removeProperty("--chat-lane-shift");
      pane.style.removeProperty("--chat-lane-shrink");
    };
  }, [floatingInfo, environmentCollapsed, messageSurfaceKey]);

  const enterTrack = useRef<EnterTrack | null>(null);
  enterTrack.current = trackEnteredMessages(
    enterTrack.current,
    state?.activeConversationId ?? null,
    messages.map((message) => message.id),
  );
  const entering = enterTrack.current.enter;
  const mod = modKeyLabel(platform);
  const rightLabel = floatingInfo
    ? (environmentCollapsed ? tr("展开环境卡片", "Expand environment card") : tr("折叠环境卡片", "Collapse environment card"))
    : rightCollapsed ? tr("展开右侧面板", "Expand right panel") : tr("收起右侧面板", "Collapse right panel");
  const { agents: roster, activeAgentId, openAgent } = useAgentWorkspace();
  const subagents = useMemo(() => roster.filter((agent) => agent.kind !== "root"), [roster]);
  const runningSubagents = subagents.filter((agent) => agent.status === "running").length;
  const openMostRelevantAgent = (): void => {
    const target = [...subagents].sort(
      (a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt - a.updatedAt,
    )[0];
    if (target) openAgent(target.id);
  };
  const previousTurns = useRef<MessageTurn[]>([]);
  const turns = useMemo(() => groupMessagesIntoTurns(messages, previousTurns.current), [messages]);
  useLayoutEffect(() => { previousTurns.current = turns; }, [turns]);
  const changesCache = useRef(new Map<MessageTurn, { root: string | null; changes: TurnChanges | null }>());
  const turnChanges = useMemo(() => {
    const root = project.workspace?.current ?? null;
    const cache = new Map<MessageTurn, { root: string | null; changes: TurnChanges | null }>();
    const cards = new Map<string, TurnChanges>();
    turns.forEach((turn, index) => {
      if (streaming && index === turns.length - 1) return;
      const old = changesCache.current.get(turn);
      const entry = old?.root === root ? old : {
        root, changes: summarizeTurnChanges(turn.assistants.flatMap(message => message.tools), root),
      };
      cache.set(turn, entry);
      const last = turn.assistants.at(-1);
      if (last && entry.changes) cards.set(last.id, entry.changes);
    });
    changesCache.current = cache;
    return cards;
  }, [turns, streaming, project.workspace?.current]);
  // 分支按轮次定位:数到回复所在轮的用户消息序号,与 runtime 重建的历史一致。
  const userOrdinalById = useMemo(() => {
    const ordinal = new Map<string, number>();
    let count = 0;
    for (const message of messages) {
      if (message.role !== "user") continue;
      ordinal.set(message.id, count);
      count += 1;
    }
    return ordinal;
  }, [messages]);

  return (
    <QuestionContext.Provider value={question}>
    <ThinkingSummaryContext.Provider value={thinkingSummaries ?? null}>
    <main className="main-chat-view" tabIndex={-1}>
      <header className="main-chat-header">
        <div className="chat-title-group">
          {leftCollapsed ? (
            <button
              className="view-icon-btn"
              type="button"
              title={`${tr("展开侧边栏", "Expand sidebar")} (${mod}B)`}
              aria-label={tr("展开侧边栏", "Expand sidebar")}
              onClick={onToggleLeft}
            >
              <SidebarIcon />
            </button>
          ) : null}
          {state?.activeConversationId && onRenameConversation ? (
            <button
              className="chat-active-title chat-title-rename"
              type="button"
              title={tr("重命名对话", "Rename chat")}
              aria-label={`${tr("重命名对话", "Rename chat")} “${title}”`}
              onClick={() => onRenameConversation(state.activeConversationId!)}
            ><span>{title}</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6L16 3Z" /><path d="m14 5 5 5" /></svg></button>
          ) : <span className="chat-active-title" title={title}>{title}</span>}
        </div>
        <div className="chat-header-actions">
          {project.workspace?.current ? (
            <span className="chat-project-context" title={project.workspace.current}>
              <span className="chat-project-name">{project.workspace.current.split(/[\\/]/).filter(Boolean).pop()}</span>
              {project.git?.branch ? <span className="chat-project-branch">{project.git.branch}</span> : null}
            </span>
          ) : null}
          <OpenInAppButton path={project.workspace?.current ?? null} />
          {subagents.length > 0 ? (
            <button
              className={`chat-agents-button${activeAgentId ? " active" : ""}`}
              type="button"
              title={tr("查看子代理运行", "View subagent runs")}
              aria-label={tr("查看子代理运行", "View subagent runs")}
              onClick={openMostRelevantAgent}
            >
              <StackIcon size={13} />
              <span>
                {runningSubagents > 0
                  ? tr(`${runningSubagents} 运行中`, `${runningSubagents} running`)
                  : tr(`${subagents.length} 个子代理`, `${subagents.length} subagents`)}
              </span>
            </button>
          ) : null}
          {onExpandWorkbench && <button className="view-icon-btn workbench-expand" type="button"
            title={tr("展开工作面板", "Expand workbench")}
            aria-label={tr("展开工作面板", "Expand workbench")} aria-expanded={false}
            onClick={onExpandWorkbench}>
            <ArrowLeftIcon size={15} />
          </button>}
          {showNewTab ? (
            <button
              className="view-icon-btn"
              type="button"
              title={`${tr("新建标签页", "New tab")} (${mod}T)`}
              aria-label={tr("新建标签页", "New tab")}
              onClick={onNewTab}
            >
              <PlusIcon size={15} />
            </button>
          ) : null}
          <button
            className={`view-icon-btn${rightCollapsed ? "" : " active"}`}
            type="button"
            title={`${rightLabel} (${mod}J)`}
            aria-label={rightLabel}
            aria-pressed={!rightCollapsed}
            onClick={onToggleRight}
          >
            {floatingInfo ? <EnvironmentInfoIcon /> : <PanelIcon />}
          </button>
        </div>
      </header>

      <ConversationViewTabs view={view} onChange={setView} />
      {view === "trace" ? <TraceView key={viewKey} state={state} onConversation={() => setView("chat")} onAbort={onAbort} pendingInteraction={pendingInteraction} /> : null}
      {view === "usage" ? <UsageView key={viewKey} conversationId={state?.activeConversationId ?? null} providers={models.catalog?.providers ?? []} /> : null}
      {vcMounted ? <VersionControlView
        project={project}
        session={session ?? null}
        hidden={view !== "versionControl"}
        pendingInteraction={pendingInteraction}
        onOpenConversation={() => setView("chat")}
        onAbort={onAbort}
        onOpenFile={(absolutePath) => void project.openFile(absolutePath)}
      /> : null}
      <div className="chat-conversation-pane" hidden={view !== "chat"} inert={view !== "chat" ? true : undefined}>
      {floatingInfo && !environmentCollapsed ? (
        <div className="floating-environment">
          <RepoCard project={project} onOpenChanges={onOpenChanges} activeChanges={changesActive}
            plan={planReferenceModel(session?.proposedPlan ?? null, planDraft, session?.executionPlan ?? null)}
            onOpenPlan={onOpenPlan}
            onToggle={onToggleRight} />
        </div>
      ) : null}
      <ConversationLinkContext.Provider value={onOpenWebLink ?? null}>
      <div className="chat-scroll-area" ref={scrollerRef}>
        <div className="chat-message-surface" key={messageSurfaceKey} ref={messageSurfaceRef}>
        {session?.status === "error" && session.error ? (
          <div className="chat-error-card" role="alert">
            <div className="chat-error-card-title">{tr("会话还不能开始", "Chat is not ready yet")}</div>
            <p>{localizeError(session.error)}</p>
          </div>
        ) : null}

        {messages.length === 0 ? (
          <EmptyState
            workspace={project.workspace?.current ?? null}
            modelMissing={session?.status === "ready" && !session.modelReady}
            mode={session?.mode ?? "agent"}
            onChooseWorkspace={() => void project.openWorkspaceDialog()}
          />
        ) : (
          turns.map((turn, index) => {
            const finalReply = [...turn.assistants].reverse().find((message) => message.text.trim().length > 0) ?? null;
            const lastAssistant = turn.assistants[turn.assistants.length - 1] ?? null;
            const isCurrentTurn = index === turns.length - 1;
            const canCollapse = Boolean(finalReply) && (!isCurrentTurn || (
              session?.status === "ready" &&
              (lastAssistant?.turnStartedAt === undefined || lastAssistant.turnCompletedAt !== undefined)
            ));
            const changes = lastAssistant ? turnChanges.get(lastAssistant.id) ?? null : null;
            const branchTurn = turn.user ? userOrdinalById.get(turn.user.id) ?? null : null;
            // 只有正在运行的本轮才计时;历史中未完成的轮次没有起始时间,不显示这一行。
            const liveStartedAt = isCurrentTurn && streaming && lastAssistant?.turnCompletedAt === undefined
              ? lastAssistant?.turnStartedAt ?? [...turn.assistants].reverse().find((message) => message.turnStartedAt !== undefined)?.turnStartedAt
              : undefined;

            return (
              <Fragment key={turn.id}>
                {turn.user ? (
                  <UserTurnMessage
                    message={turn.user}
                    thinkingActive={false}
                    entering={entering.has(turn.user.id)}
                    changes={null}
                    onOpenChanges={onOpenChanges}
                    onReviewTurn={onReviewTurn}
                    canManageChanges={Boolean(project.git?.repo)}
                    getQuestion={getQuestion}
                    onReplyQuestion={onReplyQuestion}
                    onOpenImage={setImageView}
                    editDisabled={session?.status !== "ready" || subagents.some(agent => agent.status === "running")}
                    editTurn={branchTurn}
                    onEditTurn={onEdit}
                  />
                ) : null}
                {canCollapse && finalReply && lastAssistant ? (
                  <CompletedAssistantTurn
                    key={lastAssistant.id}
                    messages={turn.assistants}
                    finalReply={finalReply}
                    elapsed={formatElapsedTime(lastAssistant.turnStartedAt, lastAssistant.turnCompletedAt)}
                    entering={turn.assistants.some((message) => entering.has(message.id))}
                    changes={changes}
                    onOpenChanges={onOpenChanges}
                    onReviewTurn={onReviewTurn}
                    canManageChanges={Boolean(project.git?.repo)}
                    getQuestion={getQuestion}
                    onReplyQuestion={onReplyQuestion}
                    toolDisplay={toolDisplay}
                    toolFold={toolFold}
                    branchTurn={branchTurn}
                    replyTime={finalReply.timestamp ?? lastAssistant.timestamp ?? lastAssistant.turnCompletedAt ?? null}
                    onBranch={onBranch}
                  />
                ) : turn.assistants.length > 0 ? (
                  <div className="assistant-live-turn">
                    {liveStartedAt !== undefined ? <TurnProgressHeader startedAt={liveStartedAt} /> : null}
                    {toolFold === "position" ? (
                      <article className="assistant-block">
                        <ToolSequence
                          messages={turn.assistants}
                          activeAssistantId={activeAssistantId}
                          entering={entering}
                          toolDisplay={toolDisplay}
                          getQuestion={getQuestion}
                          onReplyQuestion={onReplyQuestion}
                        />
                        {changes ? (
                          <TurnChangesCard
                            turnId={lastAssistant!.id}
                            changes={changes}
                            onOpenChanges={onOpenChanges}
                            onReviewTurn={onReviewTurn}
                            canManageChanges={Boolean(project.git?.repo)}
                          />
                        ) : null}
                      </article>
                    ) : (
                      // 每一步 assistant 的思考都跟着自己的工具调用走;Thinking 组件负责运行中展开、结束后折叠。
                      turn.assistants.map((message) => (
                        <Message
                          key={message.id}
                          message={message}
                          thinkingActive={message.id === activeAssistantId && !message.text && message.tools.length === 0}
                          streaming={message.id === activeAssistantId}
                          entering={entering.has(message.id)}
                          changes={turnChanges.get(message.id) ?? null}
                          onOpenChanges={onOpenChanges}
                          onReviewTurn={onReviewTurn}
                          canManageChanges={Boolean(project.git?.repo)}
                          getQuestion={getQuestion}
                          onReplyQuestion={onReplyQuestion}
                          toolDisplay={toolDisplay}
                        />
                      ))
                    )}
                    <PlanPreviewList planIds={collectPlanIds(turn.assistants)} />
                    {finalReply ? (
                      <ReplyActions
                        text={finalReply.text}
                        timestamp={finalReply.timestamp ?? null}
                        branchTurn={branchTurn}
                        branchDisabled={session?.status !== "ready"}
                        onBranch={onBranch}
                      />
                    ) : null}
                  </div>
                ) : null}
              </Fragment>
            );
          })
        )}
        </div>
      </div>

      </ConversationLinkContext.Provider>
      <Composer
        ref={dockRef}
        disabled={session?.status !== "ready" && session?.status !== "streaming"}
        streaming={Boolean(streaming)}
        platform={platform}
        instructions={state?.session.pendingInstructions ?? []}
        showSetupControls={messages.length === 0 && !streaming && (state?.context.turnCount ?? 0) === 0}
        model={session?.model}
        modelProvider={session?.modelProvider ?? null}
        modelId={session?.modelId ?? null}
        modelReady={session?.modelReady ?? false}
        thinkingLevel={session?.thinkingLevel ?? "medium"}
        thinkingLevels={session?.thinkingLevels ?? ["off"]}
        hiddenModels={hiddenModels}
        models={models}
        mode={session?.mode ?? "agent"}
        sendError={sendError}
        usage={state?.context ?? null}
        contextPopover={floatingInfo}
        project={project}
        onSend={onSend}
        onRemoveInstruction={onRemoveInstruction}
        onAbort={onAbort}
        onMode={onMode}
      />
      </div>
      {imageView ? <ImageViewer request={imageView} onClose={() => setImageView(null)} /> : null}
    </main>
    </ThinkingSummaryContext.Provider>
    </QuestionContext.Provider>
  );
}

const modeHints: Record<InteractionMode, [string, string]> = {
  agent: ["描述要完成的任务，Agent 会阅读代码、修改文件并运行命令。", "Describe a task. The agent will inspect the code, edit files, and run commands."],
  plan: ["Plan 模式只查阅代码并写出计划，确认后才会开始修改。", "Plan mode inspects the code and drafts a plan. Changes begin after you approve it."],
  goal: ["Goal 模式会围绕目标连续执行，随时可以停止。", "Goal mode works toward an objective continuously. You can stop at any time."],
};

/** 空对话的引导文案按缺失的前置条件切换:先选工作区,再准备模型,最后才是开始任务。 */
function EmptyState({
  workspace,
  modelMissing,
  mode,
  onChooseWorkspace,
}: {
  workspace: string | null;
  modelMissing: boolean;
  mode: InteractionMode;
  onChooseWorkspace: () => void;
}) {
  if (!workspace) {
    return (
      <div className="empty-state">
        <h1>Vela</h1>
        <p>{tr("先选择一个工作区。工作区决定了 Agent 的文件范围、Shell 目录与 Git 上下文。", "Choose a workspace to set the agent's file access, shell directory, and Git context.")}</p>
        <button className="empty-state-action" type="button" onClick={onChooseWorkspace}>
          <FolderIcon />
          <span>{tr("选择工作区…", "Choose workspace…")}</span>
        </button>
      </div>
    );
  }
  const name = workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
  return (
    <div className="empty-state">
      <h1>{name}</h1>
      <p>
        {modelMissing
          ? tr("还没有可用的模型。点输入框右下角的模型按钮登录提供方，或添加一个兼容接口。", "No models are available yet. Use the model button at the bottom right to sign in to a provider or add a compatible API.")
          : tr(modeHints[mode][0], modeHints[mode][1])}
      </p>
    </div>
  );
}

function UserText({ text }: { text: string }) {
  const skill = parseSkillPrompt(text);
  if (!skill) return <Markdown text={text} />;
  return (
    <div className="user-skill-message">
      <SkillToken name={skill.name} />
      {skill.body ? <Markdown text={skill.body} /> : null}
    </div>
  );
}

const UserTurnMessage = memo(function UserTurnMessage({ editTurn, onEditTurn, ...props }:
  Omit<Parameters<typeof Message>[0], "onEdit"> & { editTurn: number | null; onEditTurn?: ChatViewProps["onEdit"] }) {
  const edit = useCallback((text: string) => onEditTurn!(editTurn!, text, props.message.images),
    [onEditTurn, editTurn, props.message.images]);
  return <Message {...props} onEdit={onEditTurn && editTurn !== null ? edit : undefined} />;
});

const Message = memo(function Message({
  message,
  thinkingActive,
  streaming = false,
  entering,
  changes,
  onOpenChanges,
  onReviewTurn,
  canManageChanges,
  getQuestion,
  onReplyQuestion,
  onOpenImage,
  editDisabled = true,
  onEdit,
  toolDisplay,
}: {
  message: UiMessage;
  thinkingActive: boolean;
  streaming?: boolean;
  entering: boolean;
  changes: TurnChanges | null;
  onOpenChanges: () => void;
  onReviewTurn?: (request: TurnReviewRequest) => void;
  canManageChanges: boolean;
  getQuestion: QuestionLookup;
  onReplyQuestion: (id: string, answer: string | null) => void;
  /** 只有用户消息的图片会打开全屏查看器;助手消息沿用同一个组件时不需要传。 */
  onOpenImage?: (request: ImageViewerRequest) => void;
  editDisabled?: boolean;
  onEdit?: (text: string) => Promise<void>;
  toolDisplay?: ToolDisplay;
}) {
  const enterClass = entering ? " message-enter" : "";
  if (message.role === "user") {
    const images = message.images ?? [];
    return (
      <UserMessageFrame text={message.text} timestamp={message.timestamp} disabled={editDisabled} className={enterClass} onEdit={onEdit}>
        {images.length > 0 ? (
          <div className="user-attachments">
            {images.map((image, index) => (
              <button
                key={index}
                className="user-attachment-thumb"
                type="button"
                aria-label={tr(`全屏查看图片 ${index + 1}`, `View image ${index + 1} full screen`)}
                title={tr("全屏查看", "View full screen")}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onOpenImage?.({
                    images: images.map((item, position) => ({
                      src: `data:${item.mimeType};base64,${item.data}`,
                      alt: tr(`图片 ${position + 1}`, `Image ${position + 1}`),
                    })),
                    index,
                    origin: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                    focusTarget: event.currentTarget,
                  });
                }}
              >
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={tr(`图片 ${index + 1}`, `Image ${index + 1}`)}
                  draggable={false}
                />
              </button>
            ))}
          </div>
        ) : null}
        {message.text ? (
          <div className="user-bubble">
            <UserText text={message.text} />
          </div>
        ) : null}
      </UserMessageFrame>
    );
  }

  return (
    <article className={`assistant-block${enterClass}`}>
      <AssistantMessageContent
        message={message}
        thinkingActive={thinkingActive}
        streaming={streaming}
        thinkingDisclosure
        showTools
        showText
        changes={changes}
        onOpenChanges={onOpenChanges}
        onReviewTurn={onReviewTurn}
        canManageChanges={canManageChanges}
        getQuestion={getQuestion}
        onReplyQuestion={onReplyQuestion}
        toolDisplay={toolDisplay}
      />
    </article>
  );
});

function AssistantMessageContent({
  message,
  thinkingActive,
  streaming = false,
  thinkingDisclosure = true,
  showTools,
  showText,
  changes,
  onOpenChanges,
  onReviewTurn,
  canManageChanges,
  getQuestion,
  onReplyQuestion,
  toolDisplay,
}: {
  message: UiMessage;
  thinkingActive: boolean;
  streaming?: boolean;
  thinkingDisclosure?: boolean;
  showTools: boolean;
  showText: boolean;
  changes: TurnChanges | null;
  onOpenChanges: () => void;
  onReviewTurn?: (request: TurnReviewRequest) => void;
  canManageChanges: boolean;
  getQuestion: QuestionLookup;
  onReplyQuestion: (id: string, answer: string | null) => void;
  toolDisplay?: ToolDisplay;
}) {
  return (
    <>
      {message.thinking ? (
        thinkingDisclosure ? (
          <Thinking
            messageId={message.id}
            text={message.thinking}
            active={thinkingActive}
            showActivityIndicator={toolDisplay === "compact"}
          />
        ) : (
          <div className="stream-prose-block thinking-text process-thinking-text">
            <Markdown text={message.thinking} streaming={thinkingActive} />
          </div>
        )
      ) : null}
      {showTools && message.tools.length > 0 ? (
        <ToolList
          tools={message.tools}
          getQuestion={getQuestion}
          onReplyQuestion={onReplyQuestion}
          display={toolDisplay}
        />
      ) : null}
      {showText && message.text ? (
        <div className="agent-reply-prose">
          <Markdown text={message.text} streaming={streaming} />
        </div>
      ) : null}
      {changes ? <TurnChangesCard turnId={message.id} changes={changes} onOpenChanges={onOpenChanges} onReviewTurn={onReviewTurn} canManageChanges={canManageChanges} /> : null}
    </>
  );
}

/** 位置关系折叠:整轮拍平成序列后合并相邻工具;思考、可见正文和交互卡片都会打断。 */
function ToolSequence({
  messages,
  activeAssistantId,
  entering,
  includeText,
  toolDisplay,
  getQuestion,
  onReplyQuestion,
}: {
  messages: UiMessage[];
  activeAssistantId?: string;
  entering?: Set<string>;
  includeText?: (message: UiMessage) => boolean;
  toolDisplay: ToolDisplay;
  getQuestion: QuestionLookup;
  onReplyQuestion: (id: string, answer: string | null) => void;
}) {
  const nodes = useMemo(
    () => groupProcessItems(buildTurnItems(messages, { includeText }), toolDisplay),
    [messages, includeText, toolDisplay],
  );
  const messageById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const compact = toolDisplay === "compact";

  const withEnter = (key: string, messageId: string, content: ReactNode): ReactNode =>
    entering?.has(messageId)
      ? <div key={key} className="message-enter">{content}</div>
      : <Fragment key={key}>{content}</Fragment>;

  const renderTool = (node: Extract<ProcessNode, { type: "tool" | "run" }>): ReactNode => {
    if (node.type === "run") {
      return withEnter(node.id, node.messageId, compact ? <CompactToolGroup tools={node.tools} sequenceId={node.id} /> : <ToolRunGroup tools={node.tools} />);
    }
    return withEnter(
      node.id,
      node.messageId,
      compact && toolCompactKind(node.tool.name) ? (
        <CompactToolLine tool={node.tool} />
      ) : (
        <ToolCard tool={node.tool} getQuestion={getQuestion} onReplyQuestion={onReplyQuestion} compact={compact} />
      ),
    );
  };

  const output: ReactNode[] = [];
  let buffer: Extract<ProcessNode, { type: "tool" | "run" }>[] = [];
  const flushTools = () => {
    if (buffer.length === 0) return;
    output.push(
      <div key={`tools:${buffer[0]!.id}`} className={compact ? "tool-card-list is-compact" : "tool-card-list"}>
        {buffer.map((node) => renderTool(node))}
      </div>,
    );
    buffer = [];
  };

  for (const node of nodes) {
    if (node.type === "tool" || node.type === "run") {
      buffer.push(node);
      continue;
    }
    flushTools();
    if (node.type === "thinking") {
      const message = messageById.get(node.messageId);
      const active = node.messageId === activeAssistantId && Boolean(message && !message.text && message.tools.length === 0);
      output.push(withEnter(node.id, node.messageId, <Thinking messageId={node.messageId} text={node.text} active={active} showActivityIndicator={compact} />));
    } else {
      output.push(
        withEnter(
          node.id,
          node.messageId,
          <div className="agent-reply-prose"><Markdown text={node.text} streaming={node.messageId === activeAssistantId} /></div>,
        ),
      );
    }
  }
  flushTools();
  return <>{output}</>;
}

const CompletedAssistantTurn = memo(function CompletedAssistantTurn({
  messages,
  finalReply,
  elapsed,
  entering,
  changes,
  onOpenChanges,
  onReviewTurn,
  canManageChanges,
  getQuestion,
  onReplyQuestion,
  toolDisplay,
  toolFold,
  branchTurn,
  replyTime,
  onBranch,
}: {
  messages: UiMessage[];
  finalReply: UiMessage;
  elapsed: string | null;
  entering: boolean;
  changes: TurnChanges | null;
  onOpenChanges: () => void;
  onReviewTurn?: (request: TurnReviewRequest) => void;
  canManageChanges: boolean;
  getQuestion: QuestionLookup;
  onReplyQuestion: (id: string, answer: string | null) => void;
  toolDisplay?: ToolDisplay;
  toolFold?: ToolFold;
  branchTurn: number | null;
  replyTime: number | null;
  onBranch: (turnIndex: number) => void;
}) {
  const [expanded, setExpanded] = useToolExpanded(foldSequenceId(messages[0]?.id ? `turn:${messages[0].id}` : undefined), toolDisplay === "compact");
  const details = useToolProcessDetails();
  const toolsDuration = useToolsDuration(messages.flatMap(message => message.tools));
  const startedAt = messages.find(message => message.turnStartedAt !== undefined)?.turnStartedAt;
  const completedAt = messages[messages.length - 1]?.turnCompletedAt;
  const turnDuration = details && toolDisplay === "compact" ? readToolDuration({ startedAt, completedAt }) ?? toolsDuration : null;
  const displayedElapsed = turnDuration === null ? elapsed : formatDuration(turnDuration);
  const processId = useId();
  const hasProcess = messages.some((message) => (
    message.id !== finalReply.id && Boolean(message.text || message.thinking || message.tools.length > 0)
  )) || Boolean(finalReply.thinking || finalReply.tools.length > 0);
  const enterClass = entering ? " message-enter" : "";
  const triggerContent = (
    <>
      <span>{displayedElapsed ? tr(`用时 ${displayedElapsed}`, `Took ${displayedElapsed}`) : hasProcess ? tr("查看过程", "View process") : tr("耗时未记录", "Duration unavailable")}</span>
      {hasProcess ? (
        <svg className="time-spent-trigger-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      ) : null}
    </>
  );

  return (
    <article className={`assistant-block assistant-turn${enterClass}`}>
      <div className={`time-spent-collapsible${expanded ? " expanded" : ""}`}>
        {hasProcess ? (
          <button
            className="time-spent-trigger assistant-turn-trigger"
            type="button"
            aria-expanded={expanded}
            aria-controls={processId}
            onClick={() => setExpanded((value) => !value)}
          >
            {triggerContent}
          </button>
        ) : (
          <span className="time-spent-trigger assistant-turn-trigger">{triggerContent}</span>
        )}
        <div id={processId} className="time-spent-body" aria-hidden={!expanded} inert={!expanded}>
          <div className="time-spent-body-inner">
            <LazyMount open={expanded}>{() => <>
            {toolFold === "position" ? (
              <article className="assistant-block assistant-turn-process-item">
                <ToolSequence
                  messages={messages}
                  includeText={(message) => message.id !== finalReply.id}
                  toolDisplay={toolDisplay ?? "card"}
                  getQuestion={getQuestion}
                  onReplyQuestion={onReplyQuestion}
                />
              </article>
            ) : (
              messages.map((message) => (
                <article className="assistant-block assistant-turn-process-item" key={message.id}>
                  <AssistantMessageContent
                    message={message}
                    thinkingActive={false}
                    thinkingDisclosure
                    showTools
                    showText={message.id !== finalReply.id}
                    changes={null}
                    onOpenChanges={onOpenChanges}
                    onReviewTurn={onReviewTurn}
                    canManageChanges={canManageChanges}
                    getQuestion={getQuestion}
                    onReplyQuestion={onReplyQuestion}
                    toolDisplay={toolDisplay}
                  />
                </article>
              ))
            )}
            </>}</LazyMount>
          </div>
        </div>
      </div>
      <div className="agent-reply-prose">
        <Markdown text={finalReply.text} />
      </div>
      <PlanPreviewList planIds={collectPlanIds(messages)} />
      <ReplyActions
        text={finalReply.text}
        timestamp={replyTime}
        branchTurn={branchTurn}
        branchDisabled={branchTurn === null}
        onBranch={onBranch}
      />
      {changes ? <TurnChangesCard turnId={messages[messages.length - 1].id} changes={changes} onOpenChanges={onOpenChanges} onReviewTurn={onReviewTurn} canManageChanges={canManageChanges} /> : null}
    </article>
  );
});

/** 回复下方的操作行:左侧复制与分支,右侧显示回复完成的时间点。 */
function ReplyActions({
  text,
  timestamp,
  branchTurn,
  branchDisabled,
  onBranch,
}: {
  text: string;
  timestamp: number | null;
  branchTurn: number | null;
  branchDisabled: boolean;
  onBranch: (turnIndex: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const time = formatReplyTime(timestamp);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => setCopied(false),
    );
  };

  return (
    <div className="reply-actions">
      <button
        className="reply-action"
        type="button"
        title={copied ? tr("已复制", "Copied") : tr("复制回复", "Copy reply")}
        aria-label={copied ? tr("已复制", "Copied") : tr("复制回复", "Copy reply")}
        onClick={copy}
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        <span>{copied ? tr("已复制", "Copied") : tr("复制", "Copy")}</span>
      </button>
      <button
        className="reply-action"
        type="button"
        disabled={branchDisabled || branchTurn === null}
        title={tr("保留这条回复及之前的对话，在新聊天里继续", "Keep this reply and the conversation before it, then continue in a new chat")}
        aria-label={tr("分支到新聊天", "Branch to new chat")}
        onClick={() => {
          if (branchTurn !== null) onBranch(branchTurn);
        }}
      >
        <BranchIcon size={13} />
        <span>{tr("分支到新聊天", "Branch to new chat")}</span>
      </button>
      {time && timestamp !== null ? (
        <time className="reply-time" dateTime={new Date(timestamp).toISOString()} title={formatReplyTimeTitle(timestamp)}>
          {time}
        </time>
      ) : null}
    </div>
  );
}

function formatReplyTime(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const locale = isEnglish() ? "en-US" : "zh-CN";
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatReplyTimeTitle(timestamp: number): string {
  return new Date(timestamp).toLocaleString(isEnglish() ? "en-US" : "zh-CN");
}

/** 本轮完成后展示文件统计；审查读取保存的工具差异，不受后续工作区改动影响。 */
function TurnChangesCard({ turnId, changes, onOpenChanges, onReviewTurn, canManageChanges }: {
  turnId: string;
  changes: TurnChanges;
  onOpenChanges: () => void;
  onReviewTurn?: (request: TurnReviewRequest) => void;
  canManageChanges: boolean;
}) {
  const preview = useFilePreview();
  const [showAll, setShowAll] = useState(false);
  const files = showAll ? changes.files : changes.files.slice(0, 3);
  const remaining = changes.files.length - 3;

  return (
    <section className="turn-changes" aria-label={tr("本轮文件变更统计", "File changes in this turn")}>
      <header className="turn-changes-header">
        <span className="turn-changes-icon" aria-hidden="true"><FileChangeIcon /></span>
        <div className="turn-changes-summary">
          <strong>{tr(`已编辑 ${changes.files.length} 个文件`, `Edited ${changes.files.length} files`)}</strong>
          <span className="turn-changes-total">
            <span className="turn-changes-added">+{changes.added}</span>
            <span className="turn-changes-removed">−{changes.removed}</span>
          </span>
        </div>
        <div className="turn-changes-actions">
          <button
            type="button"
            className="turn-changes-undo"
            title={tr("在工作区变更中选择文件并确认撤销当前改动", "Choose files in Workspace Changes to confirm reverting these edits")}
            disabled={!canManageChanges}
            onClick={onOpenChanges}
          >
            {tr("撤销", "Revert")} <UndoIcon />
          </button>
          <button
            type="button"
            className="turn-changes-review"
            disabled={!onReviewTurn}
            onClick={() => onReviewTurn?.({ turnId, changes })}
          >
            {tr("审查", "Review")}
          </button>
        </div>
      </header>
      <div className="turn-changes-body">
        {files.map((file) => (
          <div className="turn-changes-file" key={file.path}>
            {preview ? (
              <button className="turn-changes-path" type="button" title={`${tr("预览", "Preview")} ${file.path}`} onClick={() => preview.openFile(file.path)}>
                {file.path}
              </button>
            ) : (
              <span className="turn-changes-path" title={file.path}>{file.path}</span>
            )}
            <span className="turn-changes-file-stat" aria-label={tr(`增加 ${file.added} 行，删除 ${file.removed} 行`, `${file.added} lines added, ${file.removed} removed`)}>
              <span className="turn-changes-added">+{file.added}</span>
              <span className="turn-changes-removed">−{file.removed}</span>
            </span>
          </div>
        ))}
        {remaining > 0 ? (
          <button className="turn-changes-more" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
            {showAll ? tr("收起文件", "Show fewer files") : tr(`再显示 ${remaining} 个文件`, `Show ${remaining} more files`)}
            <ChevronIcon up={showAll} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function FileChangeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2.5" width="18" height="19" rx="3" />
      <path d="M8 8h8M8 16h8M12 5v6" />
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg className={up ? "is-up" : ""} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-2" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function EnvironmentInfoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5.5" cy="6.5" r="2.5" />
      <circle cx="5.5" cy="17.5" r="2.5" />
      <path d="M12 6.5h9M12 17.5h9" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="16" y1="3" x2="16" y2="21" />
    </svg>
  );
}

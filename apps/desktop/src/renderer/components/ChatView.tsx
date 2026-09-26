import type { AppState, InteractionMode } from "@vela/shared";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { modKeyLabel } from "../platform";
import { FolderIcon } from "./icons";
import { trackEnteredMessages, type EnterTrack } from "./message-motion";
import type { useModels } from "../hooks/useModels";
import type { ProjectApi } from "../hooks/useProject";
import type { UiMessage } from "../hooks/useSession";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { ToolList, type QuestionLookup } from "./ToolCard";
import { SkillToken } from "./composer/SkillMenu";
import { parseSkillPrompt } from "./composer/skill-picker";
import { useFilePreview } from "./preview/FilePreviewContext";
import { nextStreamFollow, releasesStreamFollow, shouldResumeFollowForMessages } from "./chat-scroll";

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

interface ChatViewProps {
  messages: UiMessage[];
  state: AppState | null;
  sendError: string | null;
  platform: string;
  leftCollapsed: boolean;
  onToggleLeft: () => void;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  project: ProjectApi;
  onSend: (text: string, images?: import("@vela/shared").ImageAttachment[]) => Promise<void>;
  onAbort: () => Promise<void>;
  onMode: (mode: import("@vela/shared").InteractionMode) => void;
  models: ReturnType<typeof useModels>;
  getQuestion: QuestionLookup;
  onReplyQuestion: (id: string, answer: string | null) => void;
}

export function ChatView({
  messages,
  state,
  sendError,
  platform,
  leftCollapsed,
  onToggleLeft,
  rightCollapsed,
  onToggleRight,
  project,
  onSend,
  onAbort,
  onMode,
  models,
  getQuestion,
  onReplyQuestion,
}: ChatViewProps) {
  const session = state?.session;
  const streaming = session?.status === "streaming";
  const title = session?.title || "新对话";
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<FollowState>({
    pinned: true,
    lastScrollTop: 0,
    ignoreScroll: false,
    conversationId: undefined,
    userMessageId: undefined,
  });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const dock = dockRef.current;
    const root = scroller?.parentElement;
    if (!scroller || !dock || !root) return;

    const syncClearance = () => {
      const height = dock.getBoundingClientRect().height;
      if (height < 1) return;
      root.style.setProperty("--composer-clearance", `${Math.ceil(height + 20)}px`);
      if (followRef.current.pinned) scrollFollowToEnd(scroller, followRef.current);
    };

    const onScroll = () => {
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
      if (!wasPinned && follow.pinned) scrollFollowToEnd(scroller, follow);
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

    syncClearance();
    const observer = new ResizeObserver(syncClearance);
    observer.observe(dock);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      root.style.removeProperty("--composer-clearance");
    };
  }, []);

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
    if (follow.pinned) scrollFollowToEnd(scroller, follow);
  }, [messages, state?.activeConversationId]);

  const enterTrack = useRef<EnterTrack | null>(null);
  enterTrack.current = trackEnteredMessages(
    enterTrack.current,
    state?.activeConversationId ?? null,
    messages.map((message) => message.id),
  );
  const entering = enterTrack.current.enter;
  const mod = modKeyLabel(platform);
  const rightLabel = rightCollapsed ? "展开右侧面板" : "收起右侧面板";

  return (
    <main className="main-chat-view">
      <header className="main-chat-header">
        <div className="chat-title-group">
          {leftCollapsed ? (
            <button
              className="view-icon-btn"
              type="button"
              title={`展开侧边栏 (${mod}B)`}
              aria-label="展开侧边栏"
              onClick={onToggleLeft}
            >
              <SidebarIcon />
            </button>
          ) : null}
          <span className="chat-active-title" title={title}>{title}</span>
        </div>
        <div className="chat-header-actions">
          <button
            className={`view-icon-btn${rightCollapsed ? "" : " active"}`}
            type="button"
            title={`${rightLabel} (${mod}J)`}
            aria-label={rightLabel}
            aria-pressed={!rightCollapsed}
            onClick={onToggleRight}
          >
            <PanelIcon />
          </button>
        </div>
      </header>

      <div className="chat-scroll-area" ref={scrollerRef}>
        {session?.status === "error" && session.error ? (
          <div className="chat-error-card" role="alert">
            <div className="chat-error-card-title">会话还不能开始</div>
            <p>{session.error}</p>
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
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              entering={entering.has(message.id)}
              getQuestion={getQuestion}
              onReplyQuestion={onReplyQuestion}
            />
          ))
        )}
        <div className="chat-scroll-spacer" aria-hidden="true" />
      </div>

      <Composer
        ref={dockRef}
        disabled={session?.status !== "ready" && session?.status !== "streaming"}
        streaming={Boolean(streaming)}
        model={session?.model}
        modelProvider={session?.modelProvider ?? null}
        modelId={session?.modelId ?? null}
        modelReady={session?.modelReady ?? false}
        thinkingLevel={session?.thinkingLevel ?? "medium"}
        thinkingLevels={session?.thinkingLevels ?? ["off"]}
        models={models}
        mode={session?.mode ?? "agent"}
        sendError={sendError}
        project={project}
        onSend={onSend}
        onAbort={onAbort}
        onMode={onMode}
      />
    </main>
  );
}

const modeHints: Record<InteractionMode, string> = {
  agent: "描述要完成的任务，Agent 会阅读代码、修改文件并运行命令。",
  plan: "Plan 模式只查阅代码并写出计划，确认后才会开始修改。",
  goal: "Goal 模式会围绕目标连续执行，随时可以停止。",
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
        <p>先选择一个工作区。工作区决定了 Agent 的文件范围、Shell 目录与 Git 上下文。</p>
        <button className="empty-state-action" type="button" onClick={onChooseWorkspace}>
          <FolderIcon />
          <span>选择工作区…</span>
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
          ? "还没有可用的模型。点输入框右下角的模型按钮登录提供方，或添加一个兼容接口。"
          : modeHints[mode]}
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

function Message({
  message,
  entering,
  getQuestion,
  onReplyQuestion,
}: {
  message: UiMessage;
  entering: boolean;
  getQuestion: QuestionLookup;
  onReplyQuestion: (id: string, answer: string | null) => void;
}) {
  const enterClass = entering ? " message-enter" : "";
  if (message.role === "user") {
    return (
      <div className={`user-msg-container${enterClass}`}>
        <div className="user-bubble">
          <UserText text={message.text} />
        </div>
      </div>
    );
  }

  return (
    <article className={`assistant-block${enterClass}`}>
      {message.thinking ? <Thinking text={message.thinking} /> : null}
      {message.tools.length > 0 ? (
        <ToolList tools={message.tools} getQuestion={getQuestion} onReplyQuestion={onReplyQuestion} />
      ) : null}
      {message.text ? (
        <div className="agent-reply-prose">
          <Markdown text={message.text} />
        </div>
      ) : null}
      <ChangedFiles tools={message.tools} />
    </article>
  );
}

/** 助手回复下方展示本条消息改动的文件,点击在侧栏预览。 */
function ChangedFiles({ tools }: { tools: UiMessage["tools"] }) {
  const preview = useFilePreview();
  const paths = useMemo(() => {
    const seen = new Set<string>();
    for (const tool of tools) {
      if (tool.name !== "edit" && tool.name !== "write") continue;
      const path = tool.activity?.path?.trim();
      if (path) seen.add(path.replaceAll("\\", "/"));
    }
    return [...seen];
  }, [tools]);
  if (paths.length === 0 || !preview) return null;

  return (
    <div className="reply-files">
      <span className="reply-files-label">改动文件</span>
      <div className="reply-files-chips">
        {paths.slice(0, 6).map((path) => (
          <button
            type="button"
            className="reply-file-chip"
            key={path}
            title={path}
            onClick={() => preview.openFile(path)}
          >
            {path.split("/").pop() ?? path}
          </button>
        ))}
        {paths.length > 6 ? <span className="reply-files-more">+{paths.length - 6}</span> : null}
      </div>
    </div>
  );
}

/** 思考内容不超过 3 行时直接平铺展示,更长才折叠为可展开区块。 */
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [short, setShort] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // 450 字符以上的文本在这个容器里不可能只有 3 行,跳过测量也免去流式期间的 Markdown 渲染。
    if (text.length > 450) {
      setShort(false);
      return;
    }
    const measure = () => {
      // 13px 字号 × 1.65 行高 ≈ 21.5px/行,88px 约为 3 行文本(含段落间距)。
      setShort(el.scrollHeight <= 88);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  const expanded = open || short;
  const label = (
    <>
      <span>思考</span>
      <svg className="time-spent-trigger-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </>
  );
  return (
    <div className={`time-spent-collapsible${expanded ? " expanded" : ""}`}>
      {short ? (
        <span className="time-spent-trigger">{label}</span>
      ) : (
        <button
          className="time-spent-trigger"
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen((value) => !value)}
        >
          {label}
        </button>
      )}
      <div className="time-spent-body" aria-hidden={!expanded}>
        <div className="time-spent-body-inner">
          <div className="stream-prose-block thinking-text" ref={bodyRef}>
            {text.length <= 450 || open ? <Markdown text={text} /> : null}
          </div>
        </div>
      </div>
    </div>
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

function PanelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="16" y1="3" x2="16" y2="21" />
    </svg>
  );
}

import type {
  AgentInfo,
  AgentRuntimeStreamEvent,
  AgentStatus,
  AgentStreamEvent,
  AppState,
  AskUserQuestionRequest,
  ImageAttachment,
  InteractionMode,
  PlanExecutionContextStrategy,
  RuntimeInstructionMode,
  ToolActivity,
  ToolStep,
  ToolTrace,
  TranscriptMessage,
} from "@vela/shared";
import { agentStatuses } from "@vela/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMessageStore, emptyMessages, messageScope } from "./message-store";
import { applyPlanDraft, type PlanDraft } from "../plan-draft";
import { localizeError, tr } from "../locale";
import { didCompleteTask, noSound, streamNotificationSound, type NotifySound } from "../notification-sounds";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: ToolTrace[];
  /** role 为 user 时随消息发出的图片附件。 */
  images?: ImageAttachment[];
  /** 这条 assistant 消息里 <proposed_plan> 对应的 revision id；聊天里据此显示 Plan Preview。 */
  planIds?: string[];
  turnStartedAt?: number;
  turnCompletedAt?: number;
  /** 这条消息写入会话文件的时间;实时消息在完成时补上。 */
  timestamp?: number;
  /** 历史恢复的消息不能被当成新完成的思考再次自动总结。 */
  historical?: boolean;
}

/** 每个对话独立保存界面上的消息,切换对话时互不影响。 */
export type MessageBuckets = Record<string, UiMessage[]>;

/** conversationId -> agentId -> 子代理自己的消息流，供右侧 Agent Pane 渲染。 */
export type AgentMessageBuckets = Record<string, Record<string, UiMessage[]>>;

type StreamUpdate = Exclude<AgentStreamEvent, { type: "state" } | { type: "trace" }>;

export function useSession(notify: NotifySound = noSound) {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [state, setState] = useState<AppState | null>(null);
  const [messageStore] = useState(createMessageStore);
  // Only restored history is needed by App to reconstruct legacy agent tabs.
  const [agentHistory, setAgentHistory] = useState<MessageBuckets>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** conversationId -> 该对话当前待回答的问题(同一对话一次只有一个)。 */
  const [questions, setQuestions] = useState<Record<string, AskUserQuestionRequest>>({});
  /** conversationId -> 该对话的常驻 agent 树快照。 */
  const [agents, setAgents] = useState<Record<string, AgentInfo[]>>({});
  /** conversationId -> 正在流式接收的 <proposed_plan> 草稿。 */
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanDraft | null>>({});
  /** 当前对话开始生成新方案时指向它，用来打开 Plan Document。 */
  const [planFocus, setPlanFocus] = useState<{ planId: string; nonce: number } | null>(null);
  const activeConversationId = state?.activeConversationId ?? null;
  const activeIdRef = useRef<string | null>(null);
  const bucketsRef = useRef<MessageBuckets>({});
  const agentBucketsRef = useRef<AgentMessageBuckets>({});
  const questionsRef = useRef<Record<string, AskUserQuestionRequest>>({});
  const statusesRef = useRef<Record<string, AppState["session"]["status"]>>({});
  const turnStartedAtRef = useRef<Record<string, number>>({});
  const completionBlockedRef = useRef<Record<string, boolean>>({});
  activeIdRef.current = activeConversationId;
  questionsRef.current = questions;

  const setBuckets = useCallback((update: (current: MessageBuckets) => MessageBuckets) => {
    const current = bucketsRef.current;
    const next = update(current);
    bucketsRef.current = next;
    for (const id of Object.keys(next)) {
      if (next[id] !== current[id]) messageStore.publish(messageScope(id), trimEmptyAssistant(next[id]!));
    }
  }, [messageStore]);

  const setAgentBuckets = useCallback((update: (current: AgentMessageBuckets) => AgentMessageBuckets) => {
    const current = agentBucketsRef.current;
    const next = update(current);
    agentBucketsRef.current = next;
    for (const id of Object.keys(next)) {
      if (next[id] === current[id]) continue;
      const agentIds = new Set([...Object.keys(current[id] ?? {}), ...Object.keys(next[id] ?? {})]);
      for (const agentId of agentIds) {
        if (next[id]?.[agentId] !== current[id]?.[agentId]) {
          messageStore.publish(messageScope(id, agentId), next[id]?.[agentId] ?? emptyMessages);
        }
      }
    }
  }, [messageStore]);

  /** 从主进程读取对话完整历史;本地已有消息(可能正在流式)时不覆盖。 */
  const loadTranscript = useCallback(async (id: string) => {
    const api = window.vela;
    if (!api || bucketsRef.current[id]?.length) return;
    try {
      const transcript = await api.getMessages(id);
      const restored = transcript.map(toUiMessage);
      if (restored.length && !bucketsRef.current[id]?.length) {
        setAgentHistory(current => ({ ...current, [id]: restored }));
      }
      setBuckets((current) => {
        if (current[id]?.length) return current;
        if (transcript.length === 0) return current;
        const startedAt = turnStartedAtRef.current[id];
        return { ...current, [id]: startedAt ? stampLastAssistant(restored, { startedAt }) : restored };
      });
    } catch {
      // 恢复失败时保持空列表,不影响新消息收发。
    }
  }, [setBuckets]);

  /** 从主进程读取某个子代理的消息历史;本地已有实时流时不覆盖。 */
  const loadAgentMessages = useCallback(async (conversationId: string, agentId: string) => {
    const api = window.vela;
    if (!api) return;
    if (agentBucketsRef.current[conversationId]?.[agentId]?.length) return;
    try {
      const transcript = await api.getAgentMessages(conversationId, agentId);
      if (transcript.length === 0) return;
      setAgentBuckets((current) => {
        if (current[conversationId]?.[agentId]?.length) return current;
        const restored = transcript.map(toUiMessage);
        return {
          ...current,
          [conversationId]: { ...(current[conversationId] ?? {}), [agentId]: restored },
        };
      });
    } catch {
      // 读取失败时保留实时流,不影响 Pane 展示。
    }
  }, [setAgentBuckets]);

  useEffect(() => {
    const api = window.vela;
    if (!api) return;

    let active = true;
    let receivedStateEvent = false;
    const acceptState = (next: AppState) => {
      const id = next.activeConversationId;
      if (id && next.agents) setAgents((current) => ({ ...current, [id]: sanitizeAgents(next.agents!) }));
      let completedStream = false;
      // 后台对话也需要记录完成时间，否则切回时会把离开的时间算进用时。
      for (const conversation of next.conversations) {
        const timing = conversation.id === id ? next.session : conversation;
        const conversationId = conversation.id;
        const status = timing.status;
        const previous = statusesRef.current[conversationId];
        if (didCompleteTask(previous, status, Boolean(completionBlockedRef.current[conversationId]))) {
          notifyRef.current("complete");
        }
        if (status === "streaming" && previous !== "streaming") {
          const startedAt = timing.turnStartedAt ?? Date.now();
          turnStartedAtRef.current[conversationId] = startedAt;
          completionBlockedRef.current[conversationId] = false;
          setBuckets((current) => updateLastAssistant(current, conversationId, { startedAt }));
        } else if (previous === "streaming" && status !== "streaming") {
          completedStream = true;
          if (status === "ready" && !completionBlockedRef.current[conversationId]) {
            const completedAt = timing.turnCompletedAt ?? Date.now();
            const startedAt = timing.turnStartedAt ?? turnStartedAtRef.current[conversationId] ?? completedAt;
            setBuckets((current) => updateLastAssistant(current, conversationId, { startedAt, completedAt }));
          } else if (status === "ready") {
            // 中止或失败也要留下回复时间,操作行右侧才有值可显示。
            setBuckets((current) => updateLastAssistant(current, conversationId, { timestamp: timing.turnCompletedAt ?? Date.now() }));
          }
          delete turnStartedAtRef.current[conversationId];
          delete completionBlockedRef.current[conversationId];
        }
        statusesRef.current[conversationId] = status;
      }
      // Publish final text/timing before ready state can collapse or summarize it.
      if (completedStream) messageStore.flush();
      setState(next);
    };

    void api.getState().then((next) => {
      if (!active) return;
      if (!receivedStateEvent) acceptState(next);
      // 应用重启后界面消息桶是空的,从持久化会话恢复当前对话的历史。
      if (next.activeConversationId) void loadTranscript(next.activeConversationId);
    });

    const unsubscribe = api.onEvent((event) => {
      const sound = streamNotificationSound(event);
      if (sound) notifyRef.current(sound);
      if (event.type === "trace") return;
      if (event.type === "state") {
        receivedStateEvent = true;
        acceptState(event.state);
        // 会话可能比界面晚就绪。桶还是空的就再读一次历史，避免启动竞态丢掉工具内容。
        const id = event.state.activeConversationId;
        if (id) void loadTranscript(id);
        return;
      }
      if (event.type === "error") {
        completionBlockedRef.current[event.conversationId] = true;
        setErrors((current) => ({ ...current, [event.conversationId]: event.message }));
        setBuckets((current) => appendAssistantError(current, event.conversationId, event.message));
        messageStore.flush();
        return;
      }
      if (event.type === "agents") {
        const next = sanitizeAgents(event.agents);
        setAgents((current) => ({ ...current, [event.conversationId]: next }));
        return;
      }
      if (event.type === "agent_event") {
        const streamEvent = sanitizeAgentEvent(event.event);
        if (!streamEvent) return;
        setAgentBuckets((current) =>
          applyAgentStreamEvent(current, event.conversationId, event.agentId, streamEvent),
        );
        return;
      }
      if (event.type === "proposed_plan_start" || event.type === "proposed_plan_delta" || event.type === "proposed_plan_end") {
        setPlanDrafts((current) => ({
          ...current,
          [event.conversationId]: applyPlanDraft(current[event.conversationId] ?? null, event),
        }));
        const planId = event.type === "proposed_plan_end" ? event.plan.id : event.planId;
        setBuckets((current) => attachPlanToLastAssistant(current, event.conversationId, planId, turnStartedAtRef.current[event.conversationId]));
        // 开始生成时把 Plan Document 带到前台；完成后保留用户手动关闭的选择。
        if (event.type === "proposed_plan_start" && event.conversationId === activeIdRef.current) {
          setPlanFocus((current) => ({ planId: event.planId, nonce: (current?.nonce ?? 0) + 1 }));
        }
        return;
      }
      setBuckets((current) => applyStreamEvent(current, event, turnStartedAtRef.current[event.conversationId]));
    });

    const unsubscribeQuestions = api.onQuestionEvent((event) => {
      if (event.type === "request") {
        const request = event.request;
        notifyRef.current("question");
        setQuestions((current) => ({ ...current, [request.conversationId]: request }));
        return;
      }
      setQuestions((current) => {
        const pending = Object.entries(current).find(([, request]) => request.id === event.id);
        if (!pending) return current;
        const next = { ...current };
        delete next[pending[0]];
        return next;
      });
    });

    return () => {
      active = false;
      unsubscribe();
      unsubscribeQuestions();
      messageStore.flush();
    };
  }, [loadTranscript, messageStore, setAgentBuckets, setBuckets]);

  const send = useCallback(async (text: string, images?: ImageAttachment[], deliverAs?: RuntimeInstructionMode) => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    const attachments = images && images.length > 0 ? images : undefined;
    setErrors((current) => ({ ...current, [id]: "" }));
    if (deliverAs) {
      // 运行中追加指令:不在对话里预建消息,待处理条由快照驱动;
      // 真正被模型消费时主进程再广播 user_message。
      try {
        setState(await api.prompt(text, images, id, deliverAs));
      } catch (error) {
        const message = error instanceof Error ? localizeError(error.message) : tr("发送失败", "Failed to send message");
        setErrors((current) => ({ ...current, [id]: message }));
      }
      return;
    }
    completionBlockedRef.current[id] = false;
    setBuckets((current) => ({
      ...current,
      [id]: [
        ...(current[id] ?? []),
        { id: crypto.randomUUID(), role: "user", text, images: attachments, thinking: "", tools: [], timestamp: Date.now() },
        { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [] },
      ],
    }));
    try {
      const next = await api.prompt(text, images, id);
      setState(next);
    } catch (error) {
      const message = error instanceof Error ? localizeError(error.message) : tr("发送失败", "Failed to send message");
      completionBlockedRef.current[id] = true;
      setErrors((current) => ({ ...current, [id]: message }));
      setBuckets((current) => appendAssistantError(current, id, message));
    }
  }, []);

  /** 撤销一条尚未被模型消费的排队/调整指令。 */
  const removeInstruction = useCallback(async (instructionId: string) => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    try {
      setState(await api.removeInstruction(instructionId, id));
    } catch (error) {
      const message = error instanceof Error ? localizeError(error.message) : tr("无法撤销指令", "Could not remove the instruction");
      setErrors((current) => ({ ...current, [id]: message }));
    }
  }, []);

  const abort = useCallback(async () => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    completionBlockedRef.current[id] = true;
    const next = await api.abort(id);
    setState(next);
  }, []);

  const setMode = useCallback(async (mode: InteractionMode) => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      setState(await api.setInteractionMode(mode, id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法切换模式";
      setErrors((current) => ({ ...current, [id]: message }));
    }
  }, []);

  const executePlan = useCallback(async (strategy: PlanExecutionContextStrategy) => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      setState(await api.executePlan(id, strategy));
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法执行计划";
      setErrors((current) => ({ ...current, [id]: message }));
    }
  }, []);

  const resumeGoal = useCallback(async () => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      setState(await api.resumeGoal(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法继续目标";
      setErrors((current) => ({ ...current, [id]: message }));
    }
  }, []);

  /** 新建一个对话并切换过去;当前对话保留在侧边栏里。 */
  const newChat = useCallback(async (cwd?: string) => {
    const api = window.vela;
    if (!api) return;
    try {
      setState(await api.createConversation(cwd));
    } catch (error) {
      const id = activeIdRef.current;
      const message = error instanceof Error ? error.message : "新建对话失败";
      if (id) setErrors((current) => ({ ...current, [id]: message }));
    }
  }, []);

  const switchTo = useCallback(async (id: string) => {
    const api = window.vela;
    if (!api) return;
    try {
      setState(await api.switchConversation(id));
      void loadTranscript(id);
    } catch {
      // 对话可能已失效(例如主进程刚重启),列表刷新后自然消失。
    }
  }, [loadTranscript]);

  /** 归档一个对话;若归档的是当前对话,主进程会自动切到最近的未归档对话。 */
  const rename = useCallback(async (id: string, title: string) => {
    const api = window.vela;
    if (!api) throw new Error("会话服务不可用");
    // 让编辑器保留输入并显示失败，成功后由同一状态更新列表和聊天头部。
    setState(await api.renameConversation(id, title));
  }, []);

  const archive = useCallback(async (id: string) => {
    const api = window.vela;
    if (!api) return;
    try {
      const next = await api.archiveConversation(id);
      setState(next);
      if (next.activeConversationId) void loadTranscript(next.activeConversationId);
    } catch {
      // 对话可能已失效,列表刷新后自然消失。
    }
  }, [loadTranscript]);

  const unarchive = useCallback(async (id: string) => {
    const api = window.vela;
    if (!api) return;
    try {
      setState(await api.unarchiveConversation(id));
    } catch {
      // 对话可能已失效,列表刷新后自然消失。
    }
  }, []);

  /** 从某一轮回复处分支出新对话并切换过去;turnIndex 是可见用户消息的序号。 */
  const branch = useCallback(async (turnIndex: number) => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      const next = await api.branchConversation(id, turnIndex);
      setState(next);
      if (next.activeConversationId) void loadTranscript(next.activeConversationId);
    } catch (error) {
      const message = error instanceof Error
        ? localizeError(error.message)
        : tr("无法分支到新聊天", "Could not branch to a new chat");
      setErrors((current) => ({ ...current, [id]: message }));
    }
  }, [loadTranscript]);

  const edit = useCallback(async (turnIndex: number, text: string, images?: ImageAttachment[]) => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) throw new Error(tr("对话不存在或已结束", "Chat not found or already ended."));
    if (!text.trim() && !images?.length) throw new Error(tr("消息不能为空", "Message cannot be empty."));
    if (text.length > 100_000) throw new Error(tr("消息过长", "Message is too long."));
    setErrors(current => ({ ...current, [id]: "" }));
    const result = await api.rewindConversation(id, turnIndex);
    setState(result.state);
    const history = result.messages.map(toUiMessage);
    setAgentHistory(current => ({ ...current, [id]: history }));
    completionBlockedRef.current[id] = false;
    delete turnStartedAtRef.current[id];
    delete statusesRef.current[id];
    setAgentBuckets(current => ({ ...current, [id]: {} }));
    setPlanDrafts(current => ({ ...current, [id]: null }));
    setPlanFocus(null);
    setBuckets(current => ({ ...current, [id]: [
      ...history,
      { id: crypto.randomUUID(), role: "user", text, images, thinking: "", tools: [], timestamp: Date.now() },
      { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [] },
    ] }));
    // The editor closes after the rewind succeeds. Stream events fill the new assistant block.
    void api.prompt(text, images, id).then(setState, error => {
      const message = error instanceof Error ? localizeError(error.message) : tr("发送失败", "Failed to send message");
      completionBlockedRef.current[id] = true;
      setErrors(current => ({ ...current, [id]: message }));
      setBuckets(current => appendAssistantError(current, id, message));
    });
  }, []);

  const sendError = activeConversationId ? errors[activeConversationId] || null : null;
  /** 按工具调用 id 找到对应的问题请求,消息流里的提问卡片用它判断是否可交互。 */
  const getQuestion = useCallback(
    (toolCallId: string): AskUserQuestionRequest | null => {
      for (const request of Object.values(questionsRef.current)) {
        if (request.toolCallId === toolCallId) return request;
      }
      return null;
    },
    [],
  );

  const replyQuestion = useCallback(async (id: string, answer: string | null) => {
    const api = window.vela;
    if (!api) return;
    try {
      await api.replyQuestion(id, answer);
    } catch {
      // 回复失败(例如问题已被中止)时保留卡片,由用户重试或跳过。
    }
  }, []);

  /** 右侧 Pane 首次展示某个 agent 时回填历史；已有实时流时跳过。 */
  const ensureAgentMessages = useCallback(
    (agentId: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      void loadAgentMessages(conversationId, agentId);
    },
    [loadAgentMessages],
  );

  const activeAgents = useMemo(
    () => (activeConversationId ? agents[activeConversationId] ?? state?.agents ?? [] : []),
    [activeConversationId, agents, state?.agents],
  );
  const waitingConversationIds = useMemo(() => Object.keys(questions), [questions]);

  return {
    available: typeof window.vela !== "undefined",
    state,
    messageStore,
    agentHistory: activeConversationId ? agentHistory[activeConversationId] ?? emptyMessages : emptyMessages,
    conversations: state?.conversations ?? [],
    activeConversationId,
    waitingConversationIds,
    agents: activeAgents,
    /** 当前对话正在流式生成的方案草稿；没有时为 null。 */
    planDraft: activeConversationId ? planDrafts[activeConversationId] ?? null : null,
    /** 当前对话刚开始生成新方案时指向它，用来打开 Plan Document。 */
    planFocus,
    sendError,
    question:
      activeConversationId && questions[activeConversationId]
        ? questions[activeConversationId]
        : null,
    getQuestion,
    replyQuestion,
    ensureAgentMessages,
    send,
    removeInstruction,
    edit,
    abort,
    setMode,
    executePlan,
    resumeGoal,
    newChat,
    switchTo,
    archive,
    rename,
    unarchive,
    branch,
    setAppState: setState,
  };
}

export function toUiMessage(message: TranscriptMessage): UiMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    tools: message.tools.map((tool) => ({ ...tool })),
    images: message.images ? message.images.map((image) => ({ ...image })) : undefined,
    planIds: message.planIds ? [...message.planIds] : undefined,
    timestamp: message.timestamp ?? undefined,
    turnStartedAt: message.turnStartedAt,
    turnCompletedAt: message.turnCompletedAt,
    historical: true,
  };
}

/**
 * 把 plan revision 挂到当前对话最后一条 assistant 消息上，供 turn 渲染 Plan Preview。
 * 历史恢复时由 transcript 重建同样的关联。
 */
export function attachPlanToLastAssistant(
  buckets: MessageBuckets,
  conversationId: string,
  planId: string,
  startedAt?: number,
): MessageBuckets {
  const messages = buckets[conversationId] ?? [];
  const message = messages.at(-1);
  // 计划可能是这一轮唯一的输出；不能丢掉它，也不能挂到上一轮的回复。
  if (message?.role !== "assistant") {
    const next = ensureAssistant(messages, startedAt);
    next[next.length - 1]!.planIds = [planId];
    return { ...buckets, [conversationId]: next };
  }
  if (message.planIds?.includes(planId)) return buckets;
  const next = [...messages];
  next[next.length - 1] = { ...message, planIds: [...(message.planIds ?? []), planId] };
  return { ...buckets, [conversationId]: next };
}

function updateLastAssistant(
  buckets: MessageBuckets,
  id: string,
  timing: { startedAt?: number; completedAt?: number; timestamp?: number },
): MessageBuckets {
  const messages = buckets[id] ?? [];
  const next = stampLastAssistant(messages, timing);
  return next === messages ? buckets : { ...buckets, [id]: next };
}

function stampLastAssistant(
  messages: UiMessage[],
  timing: { startedAt?: number; completedAt?: number; timestamp?: number },
): UiMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const next = {
      ...message,
      ...(timing.startedAt !== undefined
        ? { turnStartedAt: timing.startedAt, turnCompletedAt: undefined }
        : {}),
      ...(timing.completedAt !== undefined
        ? { turnCompletedAt: timing.completedAt, timestamp: timing.completedAt }
        : {}),
      ...(timing.timestamp !== undefined ? { timestamp: timing.timestamp } : {}),
    };
    return [...messages.slice(0, index), next, ...messages.slice(index + 1)];
  }
  return messages;
}

export function applyStreamEvent(buckets: MessageBuckets, event: StreamUpdate, startedAt?: number): MessageBuckets {
  const id = event.conversationId;
  const next = applyToMessages(buckets[id] ?? [], event, startedAt);
  return { ...buckets, [id]: next };
}

function applyToMessages(messages: UiMessage[], event: StreamUpdate, startedAt?: number): UiMessage[] {
  if (event.type === "user_message") {
    return [
      ...messages,
      { id: crypto.randomUUID(), role: "user", text: event.text, thinking: "", tools: [], timestamp: Date.now() },
      { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [], turnStartedAt: startedAt },
    ];
  }
  // agent 循环每一步都是独立的 assistant 消息,收到边界就另起一块,
  // 与退出重进后按步骤分块的持久化视图保持一致。
  if (event.type === "assistant_start") {
    const last = messages[messages.length - 1];
    // 发送时预建或上一轮遗留的空 assistant 块直接复用,避免出现两个空气泡。
    if (last?.role === "assistant" && !last.text && !last.thinking && last.tools.length === 0 && !last.planIds?.length) {
      if (startedAt === undefined || last.turnStartedAt === startedAt) return messages;
      return [...messages.slice(0, -1), { ...last, turnStartedAt: startedAt }];
    }
    return [
      ...messages,
      { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [], turnStartedAt: startedAt },
    ];
  }
  const next = ensureAssistant(messages, startedAt);
  const last = next[next.length - 1];
  if (!last || last.role !== "assistant") return next;

  if (event.type === "text_delta") {
    last.text += event.delta;
  } else if (event.type === "thinking_delta") {
    last.thinking += event.delta;
  } else if (event.type === "tool_start") {
    last.tools = [
      ...last.tools,
      {
        id: event.toolCallId,
        name: event.toolName,
        status: "running",
        activity: sanitizeActivity(event.activity),
      },
    ];
  } else if (event.type === "tool_output") {
    last.tools = last.tools.map((tool) =>
      tool.id === event.toolCallId && tool.status === "running"
        ? { ...tool, activity: mergeActivity(tool.activity, sanitizeActivity(event.activity)) }
        : tool,
    );
  } else if (event.type === "tool_end") {
    const activity = sanitizeActivity(event.activity);
    const status = event.isError ? "error" : "done";
    const exists = last.tools.some((tool) => tool.id === event.toolCallId);
    last.tools = exists
      ? last.tools.map((tool) =>
          tool.id === event.toolCallId
            ? { ...tool, name: event.toolName || tool.name, status, activity: { ...activity, mcp: activity.mcp ?? tool.activity?.mcp } }
            : tool,
        )
      : [...last.tools, { id: event.toolCallId, name: event.toolName, status, activity }];
  }

  return next;
}

/** 子代理运行流和主对话用同一套消息结构，只是按 agentId 分桶。 */
export function applyAgentStreamEvent(
  buckets: AgentMessageBuckets,
  conversationId: string,
  agentId: string,
  event: AgentRuntimeStreamEvent,
): AgentMessageBuckets {
  const conversation = buckets[conversationId] ?? {};
  const messages = conversation[agentId] ?? [];
  return {
    ...buckets,
    [conversationId]: { ...conversation, [agentId]: applyAgentToMessages(messages, event) },
  };
}

function applyAgentToMessages(messages: UiMessage[], event: AgentRuntimeStreamEvent): UiMessage[] {
  if (event.type === "user_message") {
    const last = messages[messages.length - 1];
    if (last?.role === "user" && last.text === event.text) return messages;
    return [...messages, { id: crypto.randomUUID(), role: "user", text: event.text, thinking: "", tools: [] }];
  }
  if (event.type === "assistant_start") {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && !last.text && !last.thinking && last.tools.length === 0) return messages;
    return [...messages, { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [] }];
  }
  const next = ensureAssistant(messages);
  const last = next[next.length - 1];
  if (!last || last.role !== "assistant") return next;

  if (event.type === "text_delta") {
    last.text += event.delta;
  } else if (event.type === "thinking_delta") {
    last.thinking += event.delta;
  } else if (event.type === "tool_start") {
    last.tools = [
      ...last.tools,
      {
        id: event.toolCallId,
        name: event.toolName,
        status: "running",
        activity: sanitizeActivity(event.activity),
      },
    ];
  } else if (event.type === "tool_output") {
    last.tools = last.tools.map((tool) =>
      tool.id === event.toolCallId && tool.status === "running"
        ? { ...tool, activity: mergeActivity(tool.activity, sanitizeActivity(event.activity)) }
        : tool,
    );
  } else if (event.type === "tool_end") {
    const activity = sanitizeActivity(event.activity);
    const status = event.isError ? "error" : "done";
    const exists = last.tools.some((tool) => tool.id === event.toolCallId);
    last.tools = exists
      ? last.tools.map((tool) =>
          tool.id === event.toolCallId
            ? { ...tool, name: event.toolName || tool.name, status, activity: { ...activity, mcp: activity.mcp ?? tool.activity?.mcp } }
            : tool,
        )
      : [...last.tools, { id: event.toolCallId, name: event.toolName, status, activity }];
  } else if (event.type === "error") {
    last.text = last.text ? `${last.text}\n\n${event.message}` : event.message;
  }

  return next;
}

function ensureAssistant(messages: UiMessage[], startedAt?: number): UiMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return [...messages.slice(0, -1), { ...last }];
  return [
    ...messages,
    { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [], turnStartedAt: startedAt },
  ];
}

function sanitizeActivity(value: ToolActivity | undefined): ToolActivity {
  const steps = sanitizeSteps(value?.steps);
  const plan = sanitizePlanItems(value?.plan);
  return {
    command: typeof value?.command === "string" ? value.command : undefined,
    path: typeof value?.path === "string" ? value.path : undefined,
    body: typeof value?.body === "string" ? value.body : undefined,
    diff: typeof value?.diff === "string" ? value.diff : undefined,
    plan,
    agent: value?.agent === "explore" || value?.agent === "general" ? value.agent : undefined,
    agentId: typeof value?.agentId === "string" ? value.agentId : undefined,
    agentPath: typeof value?.agentPath === "string" ? value.agentPath : undefined,
    steps,
    mcp: typeof value?.mcp?.server === "string" && value.mcp.server.trim() &&
      typeof value.mcp.tool === "string" && value.mcp.tool.trim()
      ? { server: value.mcp.server, tool: value.mcp.tool }
      : undefined,
    mutated: value?.mutated === true ? true : undefined,
  };
}

function sanitizePlanItems(value: ToolActivity["plan"]): ToolActivity["plan"] {
  if (!Array.isArray(value)) return undefined;
  const items: NonNullable<ToolActivity["plan"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (!text.trim()) continue;
    const status = item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
    items.push({ text, status });
  }
  return items.length > 0 ? items.slice(-60) : undefined;
}

function sanitizeSteps(value: ToolActivity["steps"]): ToolActivity["steps"] {
  if (!Array.isArray(value)) return undefined;
  const steps: ToolStep[] = [];
  for (const step of value) {
    if (!step || typeof step !== "object") continue;
    const id = typeof step.id === "string" ? step.id.trim() : "";
    const name = typeof step.name === "string" ? step.name.trim() : "";
    const summary = typeof step.summary === "string" ? step.summary : "";
    const status = step.status === "running" || step.status === "done" || step.status === "error" ? step.status : null;
    if (!id || !name || !status) continue;
    steps.push({ id, name, summary, status });
  }
  return steps.length > 0 ? steps.slice(-40) : undefined;
}

/** 主进程推来的 agent 快照在渲染层再校验一次，坏数据直接丢掉。 */
function sanitizeAgents(value: unknown): AgentInfo[] {
  if (!Array.isArray(value)) return [];
  const result: AgentInfo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const path = typeof record.path === "string" ? record.path : "";
    const kind = record.kind === "explore" || record.kind === "general" || record.kind === "root"
      ? record.kind
      : null;
    const status =
      typeof record.status === "string" && (agentStatuses as readonly string[]).includes(record.status)
        ? (record.status as AgentStatus)
        : null;
    if (!id || !path || !kind || !status) continue;
    result.push({
      id,
      historyIncomplete: record.historyIncomplete === true,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      path,
      name: typeof record.name === "string" ? record.name : "",
      kind,
      status,
      depth: typeof record.depth === "number" ? record.depth : 0,
      task: typeof record.task === "string" ? record.task : "",
      steps: sanitizeSteps(record.steps as ToolActivity["steps"]) ?? [],
      mutated: record.mutated === true,
      finalText: typeof record.finalText === "string" ? record.finalText : null,
      error: typeof record.error === "string" ? record.error : null,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    });
  }
  return result;
}

/** 子代理会话事件来自 IPC，渲染前再校验一次形状。 */
function sanitizeAgentEvent(value: unknown): AgentRuntimeStreamEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const type = event.type;
  if (type === "user_message") {
    return typeof event.text === "string" ? { type, text: event.text } : null;
  }
  if (type === "assistant_start") return { type };
  if (type === "text_delta" || type === "thinking_delta") {
    return typeof event.delta === "string" ? { type, delta: event.delta } : null;
  }
  if (type === "error") {
    return typeof event.message === "string" ? { type, message: event.message } : null;
  }
  if (type === "tool_start") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (!toolCallId || !toolName) return null;
    return { type, toolCallId, toolName, activity: sanitizeActivity(event.activity as ToolActivity) };
  }
  if (type === "tool_output") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!toolCallId) return null;
    return { type, toolCallId, activity: sanitizeActivity(event.activity as ToolActivity) };
  }
  if (type === "tool_end") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (!toolCallId) return null;
    return { type, toolCallId, toolName, isError: event.isError === true, activity: sanitizeActivity(event.activity as ToolActivity) };
  }
  return null;
}

function mergeActivity(current: ToolActivity | undefined, patch: ToolActivity): ToolActivity {
  const base = current ?? {};
  return {
    command: patch.command ?? base.command,
    path: patch.path ?? base.path,
    body: patch.body ?? base.body,
    diff: patch.diff ?? base.diff,
    plan: patch.plan ?? base.plan,
    agent: patch.agent ?? base.agent,
    agentId: patch.agentId ?? base.agentId,
    agentPath: patch.agentPath ?? base.agentPath,
    steps: patch.steps ?? base.steps,
    mcp: patch.mcp ?? base.mcp,
    mutated: patch.mutated ?? base.mutated,
  };
}

function appendAssistantError(buckets: MessageBuckets, id: string, message: string): MessageBuckets {
  return { ...buckets, [id]: appendToMessages(buckets[id] ?? [], message) };
}

function appendToMessages(messages: UiMessage[], message: string): UiMessage[] {
  const next = ensureAssistant(messages);
  const last = next[next.length - 1];
  if (!last || last.role !== "assistant") return next;
  if (last.text.includes(message)) return next;
  last.text = last.text ? `${last.text}\n\n${message}` : message;
  return next;
}

/** Hide placeholder replies without reallocating completed history. */
function trimEmptyAssistant(messages: UiMessage[]): UiMessage[] {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1]!;
    if (last.role !== "assistant" || last.text || last.thinking || last.tools.length || last.planIds?.length) break;
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

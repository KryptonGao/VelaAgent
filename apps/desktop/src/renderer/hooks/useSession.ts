import type {
  AgentInfo,
  AgentRuntimeStreamEvent,
  AgentStatus,
  AgentStreamEvent,
  AppState,
  AskUserQuestionRequest,
  ImageAttachment,
  InteractionMode,
  ToolActivity,
  ToolStep,
  ToolTrace,
  TranscriptMessage,
} from "@vela/shared";
import { agentStatuses } from "@vela/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localizeError, tr } from "../locale";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: ToolTrace[];
  /** role 为 user 时随消息发出的图片附件。 */
  images?: ImageAttachment[];
  turnStartedAt?: number;
  turnCompletedAt?: number;
}

/** 每个对话独立保存界面上的消息,切换对话时互不影响。 */
type MessageBuckets = Record<string, UiMessage[]>;

/** conversationId -> agentId -> 子代理自己的消息流，供右侧 Agent Pane 渲染。 */
export type AgentMessageBuckets = Record<string, Record<string, UiMessage[]>>;

type StreamUpdate = Exclude<AgentStreamEvent, { type: "state" }>;

export function useSession() {
  const [state, setState] = useState<AppState | null>(null);
  const [buckets, setBuckets] = useState<MessageBuckets>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** conversationId -> 该对话当前待回答的问题(同一对话一次只有一个)。 */
  const [questions, setQuestions] = useState<Record<string, AskUserQuestionRequest>>({});
  /** conversationId -> 该对话的常驻 agent 树快照。 */
  const [agents, setAgents] = useState<Record<string, AgentInfo[]>>({});
  /** conversationId -> agentId -> 子代理运行流。 */
  const [agentBuckets, setAgentBuckets] = useState<AgentMessageBuckets>({});
  const activeConversationId = state?.activeConversationId ?? null;
  const activeIdRef = useRef<string | null>(null);
  const bucketsRef = useRef<MessageBuckets>({});
  const agentBucketsRef = useRef<AgentMessageBuckets>({});
  const questionsRef = useRef<Record<string, AskUserQuestionRequest>>({});
  const statusesRef = useRef<Record<string, AppState["session"]["status"]>>({});
  const turnStartedAtRef = useRef<Record<string, number>>({});
  const completionBlockedRef = useRef<Record<string, boolean>>({});
  activeIdRef.current = activeConversationId;
  bucketsRef.current = buckets;
  agentBucketsRef.current = agentBuckets;
  questionsRef.current = questions;

  /** 从主进程读取对话完整历史;本地已有消息(可能正在流式)时不覆盖。 */
  const loadTranscript = useCallback(async (id: string) => {
    const api = window.vela;
    if (!api || bucketsRef.current[id]?.length) return;
    try {
      const transcript = await api.getMessages(id);
      setBuckets((current) => {
        if (current[id]?.length) return current;
        if (transcript.length === 0) return current;
        const restored = transcript.map(toUiMessage);
        const startedAt = turnStartedAtRef.current[id];
        return { ...current, [id]: startedAt ? stampLastAssistant(restored, { startedAt }) : restored };
      });
    } catch {
      // 恢复失败时保持空列表,不影响新消息收发。
    }
  }, []);

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
  }, []);

  useEffect(() => {
    const api = window.vela;
    if (!api) return;

    let active = true;
    let receivedStateEvent = false;
    const acceptState = (next: AppState) => {
      const id = next.activeConversationId;
      if (id) {
        const status = next.session.status;
        const previous = statusesRef.current[id];
        if (status === "streaming" && previous !== "streaming") {
          const startedAt = Date.now();
          turnStartedAtRef.current[id] = startedAt;
          completionBlockedRef.current[id] = false;
          setBuckets((current) => updateLastAssistant(current, id, { startedAt }));
        } else if (previous === "streaming" && status !== "streaming") {
          if (status === "ready" && !completionBlockedRef.current[id]) {
            const completedAt = Date.now();
            const startedAt = turnStartedAtRef.current[id] ?? completedAt;
            setBuckets((current) => updateLastAssistant(current, id, { startedAt, completedAt }));
          }
          delete turnStartedAtRef.current[id];
          delete completionBlockedRef.current[id];
        }
        statusesRef.current[id] = status;
      }
      setState(next);
    };

    void api.getState().then((next) => {
      if (!active) return;
      if (!receivedStateEvent) acceptState(next);
      // 应用重启后界面消息桶是空的,从持久化会话恢复当前对话的历史。
      if (next.activeConversationId) void loadTranscript(next.activeConversationId);
    });

    const unsubscribe = api.onEvent((event) => {
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
      setBuckets((current) => applyStreamEvent(current, event, turnStartedAtRef.current[event.conversationId]));
    });

    const unsubscribeQuestions = api.onQuestionEvent((event) => {
      if (event.type === "request") {
        const request = event.request;
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
    };
  }, [loadTranscript]);

  const send = useCallback(async (text: string, images?: ImageAttachment[]) => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    completionBlockedRef.current[id] = false;
    const attachments = images && images.length > 0 ? images : undefined;
    setErrors((current) => ({ ...current, [id]: "" }));
    setBuckets((current) => ({
      ...current,
      [id]: [
        ...(current[id] ?? []),
        { id: crypto.randomUUID(), role: "user", text, images: attachments, thinking: "", tools: [] },
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

  const executePlan = useCallback(async () => {
    const api = window.vela;
    const id = activeIdRef.current;
    if (!api || !id) return;
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      setState(await api.executePlan(id));
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
  const newChat = useCallback(async () => {
    const api = window.vela;
    if (!api) return;
    try {
      setState(await api.createConversation());
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

  const sendError = activeConversationId ? errors[activeConversationId] || null : null;
  const messages = useMemo(() => {
    const list = activeConversationId ? buckets[activeConversationId] ?? [] : [];
    // 中止或模型空回复会在末尾留下没有内容的 assistant 块,渲染前裁掉。
    const next = [...list];
    while (next.length > 0) {
      const last = next[next.length - 1];
      if (last.role === "assistant" && !last.text && !last.thinking && last.tools.length === 0) {
        next.pop();
      } else {
        break;
      }
    }
    return next;
  }, [activeConversationId, buckets]);

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

  /** 当前对话里某个 agent 的运行流；没有时返回空列表。 */
  const getAgentMessages = useCallback(
    (agentId: string | null): UiMessage[] => {
      if (!agentId || !activeConversationId) return [];
      return agentBuckets[activeConversationId]?.[agentId] ?? [];
    },
    [activeConversationId, agentBuckets],
  );

  /** 右侧 Pane 首次展示某个 agent 时回填历史；已有实时流时跳过。 */
  const ensureAgentMessages = useCallback(
    (agentId: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      void loadAgentMessages(conversationId, agentId);
    },
    [loadAgentMessages],
  );

  return {
    available: typeof window.vela !== "undefined",
    state,
    messages,
    conversations: state?.conversations ?? [],
    activeConversationId,
    agents: activeConversationId ? agents[activeConversationId] ?? [] : [],
    sendError,
    question:
      activeConversationId && questions[activeConversationId]
        ? questions[activeConversationId]
        : null,
    getQuestion,
    replyQuestion,
    getAgentMessages,
    ensureAgentMessages,
    send,
    abort,
    setMode,
    executePlan,
    resumeGoal,
    newChat,
    switchTo,
    archive,
    unarchive,
    setAppState: setState,
  };
}

function toUiMessage(message: TranscriptMessage): UiMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    tools: message.tools.map((tool) => ({ ...tool })),
    images: message.images ? message.images.map((image) => ({ ...image })) : undefined,
  };
}

function updateLastAssistant(
  buckets: MessageBuckets,
  id: string,
  timing: { startedAt?: number; completedAt?: number },
): MessageBuckets {
  const messages = buckets[id] ?? [];
  const next = stampLastAssistant(messages, timing);
  return next === messages ? buckets : { ...buckets, [id]: next };
}

function stampLastAssistant(
  messages: UiMessage[],
  timing: { startedAt?: number; completedAt?: number },
): UiMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const next = {
      ...message,
      ...(timing.startedAt !== undefined
        ? { turnStartedAt: timing.startedAt, turnCompletedAt: undefined }
        : {}),
      ...(timing.completedAt !== undefined ? { turnCompletedAt: timing.completedAt } : {}),
    };
    return [...messages.slice(0, index), next, ...messages.slice(index + 1)];
  }
  return messages;
}

function applyStreamEvent(buckets: MessageBuckets, event: StreamUpdate, startedAt?: number): MessageBuckets {
  const id = event.conversationId;
  const next = applyToMessages(buckets[id] ?? [], event, startedAt);
  return { ...buckets, [id]: next };
}

function applyToMessages(messages: UiMessage[], event: StreamUpdate, startedAt?: number): UiMessage[] {
  if (event.type === "user_message") {
    return [
      ...messages,
      { id: crypto.randomUUID(), role: "user", text: event.text, thinking: "", tools: [] },
      { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [], turnStartedAt: startedAt },
    ];
  }
  // agent 循环每一步都是独立的 assistant 消息,收到边界就另起一块,
  // 与退出重进后按步骤分块的持久化视图保持一致。
  if (event.type === "assistant_start") {
    const last = messages[messages.length - 1];
    // 发送时预建或上一轮遗留的空 assistant 块直接复用,避免出现两个空气泡。
    if (last?.role === "assistant" && !last.text && !last.thinking && last.tools.length === 0) {
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
          tool.id === event.toolCallId ? { ...tool, name: event.toolName || tool.name, status, activity } : tool,
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
          tool.id === event.toolCallId ? { ...tool, name: event.toolName || tool.name, status, activity } : tool,
        )
      : [...last.tools, { id: event.toolCallId, name: event.toolName, status, activity }];
  } else if (event.type === "error") {
    last.text = last.text ? `${last.text}\n\n${event.message}` : event.message;
  }

  return next;
}

function ensureAssistant(messages: UiMessage[], startedAt?: number): UiMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return [...messages.slice(0, -1), { ...last, tools: [...last.tools] }];
  return [
    ...messages,
    { id: crypto.randomUUID(), role: "assistant", text: "", thinking: "", tools: [], turnStartedAt: startedAt },
  ];
}

function sanitizeActivity(value: ToolActivity | undefined): ToolActivity {
  const steps = sanitizeSteps(value?.steps);
  return {
    command: typeof value?.command === "string" ? value.command : undefined,
    path: typeof value?.path === "string" ? value.path : undefined,
    body: typeof value?.body === "string" ? value.body : undefined,
    diff: typeof value?.diff === "string" ? value.diff : undefined,
    agent: value?.agent === "explore" || value?.agent === "general" ? value.agent : undefined,
    agentId: typeof value?.agentId === "string" ? value.agentId : undefined,
    agentPath: typeof value?.agentPath === "string" ? value.agentPath : undefined,
    steps,
    mutated: value?.mutated === true ? true : undefined,
  };
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
    agent: patch.agent ?? base.agent,
    agentId: patch.agentId ?? base.agentId,
    agentPath: patch.agentPath ?? base.agentPath,
    steps: patch.steps ?? base.steps,
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

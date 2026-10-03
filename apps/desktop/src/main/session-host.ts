import { AgentRuntime, parseThinkingSummaryInput, type RuntimeEvent } from "@vela/agent";
import {
  IpcChannel,
  customModelApis,
  thinkingLevels,
  type AgentSettings,
  type AgentStreamEvent,
  type AppState,
  type AskUserQuestionEvent,
  type AuthMethodType,
  type CustomModelApi,
  type CustomModelInput,
  type ImageAttachment,
  type InteractionMode,
  isAgentToolName,
  isInteractionMode,
  isRuntimeInstructionMode,
  type ModelAuthEvent,
  type NewConversationSelection,
  type PlanExecutionContextStrategy,
  type PromptInput,
  type ThinkingLevel,
} from "@vela/shared";
import { BrowserWindow, ipcMain, shell } from "electron";

const maxPromptLength = 100_000;
const maxImageCount = 10;
const maxImageBytes = 10 * 1024 * 1024;
const maxImageBase64Length = 4 * Math.ceil(maxImageBytes / 3);
const mutatingToolNames = new Set(["bash", "edit", "write", "browser_repl"]);

function toolMutatedWorkspace(toolName: string, mutated: boolean | undefined): boolean {
  if (mutatingToolNames.has(toolName)) return true;
  return isAgentToolName(toolName) && mutated === true;
}

export interface SessionHostHooks {
  /** bash、edit、write，或改动了工作区的 task 结束后调用，用于刷新 Git 状态。 */
  onAgentMutation?: () => void;
  /** 新建对话时应使用的工作区目录。 */
  currentCwd: () => string;
}

export class SessionHost {
  /** 已经触发过 Git 刷新的子代理 id，避免状态事件重复刷新。 */
  private readonly mutatedAgents = new Set<string>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly hooks: SessionHostHooks,
  ) {
    this.runtime.subscribe((event) => {
      this.onRuntimeEvent(event);
    });
    this.runtime.subscribeAuth((event) => {
      this.onModelEvent(event);
    });
    this.runtime.subscribeQuestions((event) => {
      this.broadcastQuestion(event);
    });
  }

  register(): void {
    ipcMain.handle(IpcChannel.getState, () => this.currentState());
    ipcMain.handle(IpcChannel.prompt, async (_event, raw: unknown) => {
      let conversationId = this.runtime.activeConversationId;
      try {
        const input = parsePromptInput(raw);
        if (input.conversationId) conversationId = input.conversationId;
        if (!conversationId) throw new Error("还没有可用的对话");
        await this.runtime.prompt(conversationId, input.text, input.images, input.deliverAs);
      } catch (error) {
        const message = error instanceof Error ? error.message : "发送失败";
        this.broadcast({ type: "error", conversationId: conversationId ?? "", message });
      }
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.abort, async (_event, rawId: unknown) => {
      await this.runtime.abort(parseOptionalConversationId(rawId));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionSetMode, async (_event, rawMode: unknown, rawId: unknown) => {
      const conversationId = resolveConversationId(this.runtime.activeConversationId, rawId);
      try {
        await this.runtime.setMode(conversationId, parseInteractionMode(rawMode));
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法切换模式";
        this.broadcast({ type: "error", conversationId, message });
      }
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionExecutePlan, async (_event, rawId: unknown, rawStrategy: unknown) => {
      const conversationId = resolveConversationId(this.runtime.activeConversationId, rawId);
      try {
        await this.runtime.executePlan(conversationId, parsePlanExecutionStrategy(rawStrategy));
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法执行计划";
        this.broadcast({ type: "error", conversationId, message });
      }
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionResumeGoal, async (_event, rawId: unknown) => {
      const conversationId = resolveConversationId(this.runtime.activeConversationId, rawId);
      try {
        await this.runtime.resumeGoal(conversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法继续目标";
        this.broadcast({ type: "error", conversationId, message });
      }
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionRemoveInstruction, async (_event, rawInstruction: unknown, rawId: unknown) => {
      const conversationId = resolveConversationId(this.runtime.activeConversationId, rawId);
      try {
        await this.runtime.removeInstruction(conversationId, parseId(rawInstruction, "指令"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "无法撤销指令";
        this.broadcast({ type: "error", conversationId, message });
      }
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionCreate, async (_event, rawCwd: unknown) => {
      let cwd = this.hooks.currentCwd();
      if (rawCwd !== undefined) {
        if (typeof rawCwd !== "string" ||
          !this.runtime.listConversations().some(conversation => conversation.cwd === rawCwd)) {
          throw new Error("工作区不存在");
        }
        cwd = rawCwd;
      }
      await this.runtime.createConversation(cwd);
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionSwitch, async (_event, rawId: unknown) => {
      await this.runtime.switchConversation(parseConversationId(rawId, "对话"));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionRename, async (_event, rawId: unknown, rawTitle: unknown) => {
      await this.runtime.renameConversation(parseConversationId(rawId, "对话"), rawTitle);
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionArchive, async (_event, rawId: unknown) => {
      await this.runtime.archiveConversation(parseConversationId(rawId, "对话"));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionUnarchive, async (_event, rawId: unknown) => {
      await this.runtime.unarchiveConversation(parseConversationId(rawId, "对话"));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionBranch, async (_event, rawId: unknown, rawTurn: unknown) => {
      await this.runtime.branchConversation(parseConversationId(rawId, "对话"), parseTurnIndex(rawTurn));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.sessionRewind, async (_event, rawId: unknown, rawTurn: unknown) => {
      const id = parseConversationId(rawId, "对话");
      await this.runtime.rewindConversation(id, parseTurnIndex(rawTurn));
      this.hooks.onAgentMutation?.();
      return { state: this.currentState(), messages: this.runtime.getMessages(id) };
    });
    ipcMain.handle(IpcChannel.sessionTrace, (_event, rawId: unknown) => this.runtime.getTrace(parseConversationId(rawId, "对话")));
    ipcMain.handle(IpcChannel.sessionTraceDetails, (_event, rawId: unknown, rawNode: unknown) => this.runtime.getTraceDetails(parseConversationId(rawId, "对话"), parseId(rawNode, "轨迹节点")));
    ipcMain.handle(IpcChannel.sessionMessages, (_event, rawId: unknown) => {
      return this.runtime.getMessages(parseConversationId(rawId, "对话"));
    });
    ipcMain.handle(IpcChannel.sessionSummarizeThinking, (_event, raw: unknown) => {
      return this.runtime.summarizeThinking(parseThinkingSummaryInput(raw));
    });
    ipcMain.handle(IpcChannel.sessionAgentMessages, (_event, rawConversation: unknown, rawAgent: unknown) => {
      return this.runtime.getAgentMessages(
        parseConversationId(rawConversation, "对话"),
        parseId(rawAgent, "Agent"),
      );
    });
    ipcMain.handle(IpcChannel.getCatalog, () => this.runtime.getCatalog());
    ipcMain.handle(IpcChannel.selectModel, async (_event, provider: unknown, id: unknown) => {
      await this.runtime.selectModel(parseId(provider, "提供方"), parseId(id, "模型"));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.setThinkingLevel, async (_event, level: unknown) => {
      await this.runtime.setThinkingLevel(parseThinkingLevel(level));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.addModel, async (_event, raw: unknown) => {
      await this.runtime.addModel(parseCustomModel(raw));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.registerModel, async (_event, raw: unknown) => {
      await this.runtime.registerModel(parseCustomModel(raw));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.getAgentSettings, () => this.runtime.getAgentSettings());
    ipcMain.handle(IpcChannel.saveAgentSettings, async (_event, raw: unknown) => {
      return this.runtime.saveAgentSettings(parseAgentSettings(raw));
    });
    ipcMain.handle(IpcChannel.listSkills, () => this.runtime.listSkills(this.hooks.currentCwd()));
    ipcMain.handle(IpcChannel.scanExternalSkills, () => this.runtime.scanExternalSkills(this.hooks.currentCwd()));
    ipcMain.handle(IpcChannel.migrateSkills, (_event, raw: unknown) => {
      return this.runtime.migrateSkills(this.hooks.currentCwd(), parseSkillIds(raw));
    });
    ipcMain.handle(IpcChannel.setSkillEnabled, (_event, rawName: unknown, rawEnabled: unknown) => {
      if (typeof rawEnabled !== "boolean") throw new Error("Skill 不正确");
      return this.runtime.setSkillEnabled(this.hooks.currentCwd(), parseSkillName(rawName), rawEnabled);
    });
    ipcMain.handle(IpcChannel.deleteSkill, (_event, rawName: unknown, rawLocation: unknown) => {
      return this.runtime.deleteSkill(this.hooks.currentCwd(), parseSkillName(rawName), parseSkillLocation(rawLocation));
    });
    ipcMain.handle(IpcChannel.openSkillsDir, async () => {
      const error = await shell.openPath(this.runtime.skillsDirectory());
      if (error) throw new Error(error);
    });
    ipcMain.handle(IpcChannel.removeModel, async (_event, provider: unknown, id: unknown) => {
      await this.runtime.removeModel(parseId(provider, "提供方"), parseId(id, "模型"));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.logout, async (_event, providerId: unknown) => {
      await this.runtime.logout(parseId(providerId, "提供方"));
      return this.currentState();
    });
    ipcMain.handle(IpcChannel.login, async (_event, providerId: unknown, type: unknown) => {
      openedLoginUrls.clear();
      const cancelled = (await this.runtime.login(parseId(providerId, "提供方"), parseAuthType(type))) === "cancelled";
      return { state: this.currentState(), cancelled };
    });
    ipcMain.handle(IpcChannel.replyLogin, (_event, promptId: unknown, value: unknown) => {
      this.runtime.replyLogin(parseId(promptId, "登录步骤"), parseLoginReply(value));
    });
    ipcMain.handle(IpcChannel.cancelLogin, () => {
      this.runtime.cancelLogin();
    });
    ipcMain.handle(IpcChannel.questionReply, (_event, rawId: unknown, rawAnswer: unknown) => {
      this.runtime.replyQuestion(parseId(rawId, "问题"), parseQuestionAnswer(rawAnswer));
    });
  }

  dispose(): void {
    this.runtime.dispose();
  }

  currentState(): AppState {
    const activeId = this.runtime.activeConversationId;
    return {
      session: this.runtime.getSnapshot(),
      context: this.runtime.getUsage(activeId),
      conversations: this.runtime.listConversations(),
      activeConversationId: activeId,
      agents: this.runtime.getAgents(activeId),
    };
  }

  private onRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === "tool_start") this.runtime.addUsage(event.conversationId, 0, 1);

    if (event.type === "status") {
      this.broadcast({ type: "state", state: this.currentState() });
      return;
    }

    this.broadcast(event);
    if (event.type === "agents") {
      // 子代理改完工作区后刷新 Git；同一个代理只触发一次。
      for (const agent of event.agents) {
        if (agent.kind === "root" || !agent.mutated || agent.status === "running") continue;
        if (this.mutatedAgents.has(agent.id)) continue;
        this.mutatedAgents.add(agent.id);
        this.hooks.onAgentMutation?.();
      }
      return;
    }
    if (event.type === "tool_start" || event.type === "tool_end" || event.type === "error") {
      if (event.type === "tool_end" && toolMutatedWorkspace(event.toolName, event.activity.mutated)) {
        this.hooks.onAgentMutation?.();
      }
      this.broadcast({ type: "state", state: this.currentState() });
    }
  }

  private onModelEvent(event: ModelAuthEvent): void {
    if (event.type === "notice") {
      const url = event.notice.type === "auth_url"
        ? event.notice.url
        : event.notice.type === "device_code"
          ? event.notice.verificationUri
          : null;
      if (url) openLoginUrl(url);
    }
    this.broadcastModel(event);
  }

  private broadcastModel(event: ModelAuthEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(IpcChannel.modelEvent, event);
    }
  }

  private broadcastQuestion(event: AskUserQuestionEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(IpcChannel.questionEvent, event);
    }
  }

  private broadcast(event: AgentStreamEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(IpcChannel.event, event);
    }
  }
}

const openedLoginUrls = new Set<string>();

function openLoginUrl(url: string): void {
  if (openedLoginUrls.has(url)) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    openedLoginUrls.add(parsed.toString());
    void shell.openExternal(parsed.toString());
  } catch {
    // 登录提示里的地址不合法时，留给界面上的链接。
  }
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}不正确`);
  const text = value.trim();
  if (!text || text.length > 200) throw new Error(`${label}不正确`);
  return text;
}

function parseConversationId(value: unknown, label: string): string {
  const text = parseId(value, label);
  if (!/^[0-9a-f-]{8,64}$/i.test(text)) throw new Error(`${label}不正确`);
  return text;
}

function parseOptionalConversationId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return parseConversationId(value, "对话");
}

function resolveConversationId(activeId: string | null, rawId: unknown): string {
  if (rawId === null || rawId === undefined) {
    if (!activeId) throw new Error("还没有可用的对话");
    return activeId;
  }
  return parseConversationId(rawId, "对话");
}

function parseInteractionMode(value: unknown): InteractionMode {
  if (typeof value !== "string" || !isInteractionMode(value)) throw new Error("不支持这个模式");
  return value;
}

function parsePlanExecutionStrategy(value: unknown): PlanExecutionContextStrategy {
  if (value === undefined || value === null || value === "") return "continue";
  if (value === "continue" || value === "fresh") return value;
  throw new Error("不支持的计划执行方式");
}

function parseThinkingLevel(value: unknown): ThinkingLevel {
  if (typeof value !== "string" || !(thinkingLevels as readonly string[]).includes(value)) {
    throw new Error("不支持这个思考强度");
  }
  return value as ThinkingLevel;
}

function parseAgentSettings(raw: unknown): AgentSettings {
  if (!raw || typeof raw !== "object") throw new Error("设置不正确");
  const record = raw as Record<string, unknown>;
  const provider = record.provider === null || record.provider === undefined || record.provider === ""
    ? null
    : parseId(record.provider, "模型");
  const modelId = record.modelId === null || record.modelId === undefined || record.modelId === ""
    ? null
    : parseId(record.modelId, "模型");
  if (Boolean(provider) !== Boolean(modelId)) throw new Error("需要同时选择提供方和模型");
  const instructions = typeof record.instructions === "string" ? record.instructions : "";
  if (instructions.length > 4000) throw new Error("额外指令过长");
  return {
    provider,
    modelId,
    thinkingLevel: parseThinkingLevel(record.thinkingLevel),
    newConversationSelection: parseNewConversationSelection(record.newConversationSelection),
    instructions,
  };
}

function parseNewConversationSelection(value: unknown): NewConversationSelection {
  // 旧版本没有这个字段,按「设置默认」处理。
  if (value === undefined || value === null || value === "") return "default";
  if (value === "default" || value === "lastUsed") return value;
  throw new Error("新对话的默认选择不正确");
}

function parseSkillIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) throw new Error("请选择要迁移的 Skill");
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new Error("Skill 不正确");
    const id = item.trim();
    const match = /^(codex|claude):(user|project):(.+)$/.exec(id);
    const relativeDir = match?.[3];
    if (!match || !relativeDir || id.length > 400 || id.includes("\\") || id.includes("\0")) {
      throw new Error("Skill 不正确");
    }
    if (relativeDir.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("Skill 不正确");
    }
    ids.push(id);
  }
  return [...new Set(ids)];
}

function parseSkillName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Skill 不正确");
  const name = value.trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Skill 不正确");
  return name;
}

function parseSkillLocation(value: unknown): string {
  if (typeof value !== "string") throw new Error("Skill 不正确");
  const location = value.trim();
  if (!location || location.length > 4096 || !location.endsWith(".md") || location.includes("\0")) {
    throw new Error("Skill 不正确");
  }
  return location;
}

function parseAuthType(value: unknown): AuthMethodType {
  if (value === "api_key" || value === "oauth") return value;
  throw new Error("不支持这个登录方式");
}

function parseLoginReply(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("登录回复不正确");
  if (value.length > 8000) throw new Error("输入过长");
  return value;
}

function parseQuestionAnswer(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("回答不正确");
  const answer = value.trim();
  if (!answer || answer.length > 4000) throw new Error("回答不正确");
  return answer;
}

function parseTurnIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new Error("回复位置不正确");
  }
  return value;
}

function parseCustomModel(raw: unknown): CustomModelInput {
  if (!raw || typeof raw !== "object") throw new Error("模型参数不正确");
  const record = raw as Record<string, unknown>;
  const api = record.api;
  if (typeof api !== "string" || !(customModelApis as readonly string[]).includes(api)) {
    throw new Error("不支持这个接口类型");
  }
  return {
    providerId: requiredText(record.providerId, "提供方"),
    providerName: optionalText(record.providerName),
    baseUrl: requiredText(record.baseUrl, "接口地址"),
    api: api as CustomModelApi,
    apiKey: optionalText(record.apiKey),
    modelId: requiredText(record.modelId, "模型 ID"),
    modelName: optionalText(record.modelName),
    reasoning: record.reasoning === true,
    contextWindow: optionalCount(record.contextWindow),
    maxTokens: optionalCount(record.maxTokens),
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`需要填写${label}`);
  return value;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number") throw new Error("数字参数不正确");
  return value;
}

function parsePromptInput(raw: unknown): PromptInput {
  if (!raw || typeof raw !== "object") throw new Error("消息必须是字符串");
  const record = raw as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new Error("消息不能为空");
  if (text.length > maxPromptLength) throw new Error("消息过长");
  if (record.deliverAs !== undefined && !isRuntimeInstructionMode(record.deliverAs)) {
    throw new Error("投递方式不正确");
  }
  return {
    text,
    images: parseImages(record.images),
    conversationId: record.conversationId === undefined
      ? undefined
      : parseConversationId(record.conversationId, "对话"),
    deliverAs: isRuntimeInstructionMode(record.deliverAs) ? record.deliverAs : undefined,
  };
}

function parseImages(raw: unknown): ImageAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("图片附件不正确");
  if (raw.length > maxImageCount) throw new Error("图片附件过多");
  // 渲染层已将剪贴板图片归一化，但单个附件仍可能损坏或格式不受支持；
  // 这时跳过该附件而不是让整条消息发送失败。
  const images: ImageAttachment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const image = entry as Record<string, unknown>;
    if (image.type !== "image" || typeof image.data !== "string" || !image.data) continue;
    if (image.data.length > maxImageBase64Length) continue;
    const mimeType = detectImageMimeType(image.data);
    if (!mimeType) continue;
    images.push({ type: "image", data: image.data, mimeType });
  }
  return images;
}

/** Clipboard MIME labels can vary; the bytes are authoritative for supported image formats. */
function detectImageMimeType(data: string): string | null {
  const bytes = Buffer.from(data.slice(0, 32), "base64");
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

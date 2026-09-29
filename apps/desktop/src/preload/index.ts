import {
  IpcChannel,
  type AgentSettings,
  type AppLocale,
  type AgentStreamEvent,
  type AppState,
  type AskUserQuestionEvent,
  type AttachmentPickKind,
  type AuthMethodType,
  type BranchSummary,
  type CustomModelInput,
  type ExecutionEnvironment,
  type FileAttachmentPayload,
  type GitStatusSnapshot,
  type InteractionMode,
  type LoginResult,
  type ModelAuthEvent,
  type ModelCatalog,
  type OpenTarget,
  type PromptInput,
  type PullRequestInfo,
  type SandboxApprovalEvent,
  type SandboxMode,
  type SelectableEnvironmentKind,
  type ExternalSkillScan,
  type SkillCatalog,
  type SkillMigrationResult,
  type ThinkingLevel,
  type TranscriptMessage,
  type VelaApi,
  type WorkspaceEvent,
  type WorkspaceFileContent,
  type WorkspaceFileList,
  type WorkspaceSearchResult,
  type WorkspaceState,
} from "@vela/shared";
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const api: VelaApi = {
  platform: process.platform,
  setLocale: (locale: AppLocale) => ipcRenderer.send(IpcChannel.appSetLocale, locale),
  getState: () => ipcRenderer.invoke(IpcChannel.getState) as Promise<AppState>,
  prompt: (text, images, conversationId) =>
    ipcRenderer.invoke(IpcChannel.prompt, {
      text,
      images: images ?? [],
      ...(conversationId ? { conversationId } : {}),
    } satisfies PromptInput) as Promise<AppState>,
  abort: (conversationId) =>
    ipcRenderer.invoke(IpcChannel.abort, conversationId ?? null) as Promise<AppState>,
  setInteractionMode: (mode: InteractionMode, conversationId) =>
    ipcRenderer.invoke(IpcChannel.sessionSetMode, mode, conversationId ?? null) as Promise<AppState>,
  executePlan: (conversationId) =>
    ipcRenderer.invoke(IpcChannel.sessionExecutePlan, conversationId ?? null) as Promise<AppState>,
  resumeGoal: (conversationId) =>
    ipcRenderer.invoke(IpcChannel.sessionResumeGoal, conversationId ?? null) as Promise<AppState>,
  createConversation: () => ipcRenderer.invoke(IpcChannel.sessionCreate) as Promise<AppState>,
  switchConversation: (id: string) =>
    ipcRenderer.invoke(IpcChannel.sessionSwitch, id) as Promise<AppState>,
  archiveConversation: (id: string) =>
    ipcRenderer.invoke(IpcChannel.sessionArchive, id) as Promise<AppState>,
  unarchiveConversation: (id: string) =>
    ipcRenderer.invoke(IpcChannel.sessionUnarchive, id) as Promise<AppState>,
  getMessages: (conversationId: string) =>
    ipcRenderer.invoke(IpcChannel.sessionMessages, conversationId) as Promise<TranscriptMessage[]>,
  getAgentMessages: (conversationId: string, agentId: string) =>
    ipcRenderer.invoke(IpcChannel.sessionAgentMessages, conversationId, agentId) as Promise<TranscriptMessage[]>,
  getCatalog: () => ipcRenderer.invoke(IpcChannel.getCatalog) as Promise<ModelCatalog>,
  selectModel: (provider, id) => ipcRenderer.invoke(IpcChannel.selectModel, provider, id) as Promise<AppState>,
  setThinkingLevel: (level: ThinkingLevel) => ipcRenderer.invoke(IpcChannel.setThinkingLevel, level) as Promise<AppState>,
  addModel: (input: CustomModelInput) => ipcRenderer.invoke(IpcChannel.addModel, input) as Promise<AppState>,
  registerModel: (input: CustomModelInput) =>
    ipcRenderer.invoke(IpcChannel.registerModel, input) as Promise<AppState>,
  getAgentSettings: () => ipcRenderer.invoke(IpcChannel.getAgentSettings) as Promise<AgentSettings>,
  saveAgentSettings: (settings: AgentSettings) =>
    ipcRenderer.invoke(IpcChannel.saveAgentSettings, settings) as Promise<AgentSettings>,
  listSkills: () => ipcRenderer.invoke(IpcChannel.listSkills) as Promise<SkillCatalog>,
  openSkillsDirectory: () => ipcRenderer.invoke(IpcChannel.openSkillsDir) as Promise<void>,
  scanExternalSkills: () => ipcRenderer.invoke(IpcChannel.scanExternalSkills) as Promise<ExternalSkillScan>,
  migrateSkills: (ids) => ipcRenderer.invoke(IpcChannel.migrateSkills, ids) as Promise<SkillMigrationResult>,
  setSkillEnabled: (name, enabled) =>
    ipcRenderer.invoke(IpcChannel.setSkillEnabled, name, enabled) as Promise<SkillCatalog>,
  deleteSkill: (name, location) =>
    ipcRenderer.invoke(IpcChannel.deleteSkill, name, location) as Promise<SkillCatalog>,
  removeModel: (provider, id) => ipcRenderer.invoke(IpcChannel.removeModel, provider, id) as Promise<AppState>,
  logout: (providerId) => ipcRenderer.invoke(IpcChannel.logout, providerId) as Promise<AppState>,
  login: (providerId, type: AuthMethodType) => ipcRenderer.invoke(IpcChannel.login, providerId, type) as Promise<LoginResult>,
  replyLogin: (promptId, value) => ipcRenderer.invoke(IpcChannel.replyLogin, promptId, value) as Promise<void>,
  cancelLogin: () => ipcRenderer.invoke(IpcChannel.cancelLogin) as Promise<void>,
  openWorkspaceDialog: () =>
    ipcRenderer.invoke(IpcChannel.workspaceOpenDialog) as Promise<WorkspaceState>,
  getWorkspaceState: () =>
    ipcRenderer.invoke(IpcChannel.workspaceGetState) as Promise<WorkspaceState>,
  selectWorkspace: (path: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceSelect, path) as Promise<WorkspaceState>,
  closeWorkspace: () => ipcRenderer.invoke(IpcChannel.workspaceClose) as Promise<WorkspaceState>,
  removeRecentWorkspace: (path: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceRemoveRecent, path) as Promise<WorkspaceState>,
  getEnvironment: () => ipcRenderer.invoke(IpcChannel.envGet) as Promise<ExecutionEnvironment | null>,
  listEnvironments: () => ipcRenderer.invoke(IpcChannel.envList) as Promise<ExecutionEnvironment[]>,
  setEnvironment: (kind: SelectableEnvironmentKind) =>
    ipcRenderer.invoke(IpcChannel.envSet, kind) as Promise<ExecutionEnvironment>,
  getGitStatus: () => ipcRenderer.invoke(IpcChannel.gitGetStatus) as Promise<GitStatusSnapshot | null>,
  listBranches: () => ipcRenderer.invoke(IpcChannel.gitListBranches) as Promise<BranchSummary[]>,
  switchBranch: (name: string) =>
    ipcRenderer.invoke(IpcChannel.gitSwitchBranch, name) as Promise<GitStatusSnapshot | null>,
  createBranch: (name: string) =>
    ipcRenderer.invoke(IpcChannel.gitCreateBranch, name) as Promise<GitStatusSnapshot | null>,
  getFileDiff: (path: string, staged: boolean) =>
    ipcRenderer.invoke(IpcChannel.gitFileDiff, path, staged) as Promise<string>,
  stageFiles: (paths: string[]) => ipcRenderer.invoke(IpcChannel.gitStage, paths) as Promise<GitStatusSnapshot | null>,
  unstageFiles: (paths: string[]) => ipcRenderer.invoke(IpcChannel.gitUnstage, paths) as Promise<GitStatusSnapshot | null>,
  discardFiles: (paths: string[]) => ipcRenderer.invoke(IpcChannel.gitDiscard, paths) as Promise<GitStatusSnapshot | null>,
  openFile: (absolutePath: string) => ipcRenderer.invoke(IpcChannel.gitOpenFile, absolutePath) as Promise<void>,
  readWorkspaceFile: (path: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceFileRead, path) as Promise<WorkspaceFileContent>,
  listWorkspaceFiles: () => ipcRenderer.invoke(IpcChannel.workspaceFileList) as Promise<WorkspaceFileList>,
  searchWorkspaceCode: (query: string) =>
    ipcRenderer.invoke(IpcChannel.workspaceSearch, query) as Promise<WorkspaceSearchResult>,
  getPullRequest: () => ipcRenderer.invoke(IpcChannel.prGet) as Promise<PullRequestInfo>,
  openPullRequest: (url: string) => ipcRenderer.invoke(IpcChannel.prOpen, url) as Promise<void>,
  createPullRequest: () => ipcRenderer.invoke(IpcChannel.prCreate) as Promise<void>,
  getSandboxMode: () => ipcRenderer.invoke(IpcChannel.sandboxGetMode) as Promise<SandboxMode>,
  setSandboxMode: (mode: SandboxMode) =>
    ipcRenderer.invoke(IpcChannel.sandboxSetMode, mode) as Promise<SandboxMode>,
  replyApproval: (id: string, allowed: boolean) =>
    ipcRenderer.invoke(IpcChannel.sandboxApprovalReply, id, allowed) as Promise<void>,
  replyQuestion: (id: string, answer: string | null) =>
    ipcRenderer.invoke(IpcChannel.questionReply, id, answer) as Promise<void>,
  pickAttachments: (kind: AttachmentPickKind) =>
    ipcRenderer.invoke(IpcChannel.appPickAttachments, kind) as Promise<FileAttachmentPayload[]>,
  hydrateAttachments: (paths: string[]) =>
    ipcRenderer.invoke(IpcChannel.appHydrateAttachments, paths) as Promise<FileAttachmentPayload[]>,
  listOpenTargets: () =>
    ipcRenderer.invoke(IpcChannel.appListOpenTargets) as Promise<OpenTarget[]>,
  openInTarget: (targetId: string, path: string) =>
    ipcRenderer.invoke(IpcChannel.appOpenInTarget, targetId, path) as Promise<void>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isStreamEvent(payload)) return;
      listener(payload);
    };
    ipcRenderer.on(IpcChannel.event, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.event, wrapped);
    };
  },
  onModelEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isModelEvent(payload)) return;
      listener(payload);
    };
    ipcRenderer.on(IpcChannel.modelEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.modelEvent, wrapped);
    };
  },
  onWorkspaceEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isWorkspaceEvent(payload)) return;
      listener(payload as WorkspaceEvent);
    };
    ipcRenderer.on(IpcChannel.workspaceEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.workspaceEvent, wrapped);
    };
  },
  onGitEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isRecord(payload) || payload.type !== "status-changed") return;
      listener({ type: "status-changed" });
    };
    ipcRenderer.on(IpcChannel.gitEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.gitEvent, wrapped);
    };
  },
  onApprovalEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isApprovalEvent(payload)) return;
      listener(payload as SandboxApprovalEvent);
    };
    ipcRenderer.on(IpcChannel.sandboxApprovalEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.sandboxApprovalEvent, wrapped);
    };
  },
  onQuestionEvent: (listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      if (!isQuestionEvent(payload)) return;
      listener(payload as AskUserQuestionEvent);
    };
    ipcRenderer.on(IpcChannel.questionEvent, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.questionEvent, wrapped);
    };
  },
  onMenuAction: (listener) => {
    const wrapped = (_event: IpcRendererEvent, action: unknown) => {
      if (action !== "new-chat" && action !== "toggle-settings") return;
      listener(action);
    };
    ipcRenderer.on(IpcChannel.appMenuAction, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannel.appMenuAction, wrapped);
    };
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("vela", api);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "type" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelEvent(value: unknown): value is ModelAuthEvent {
  if (!isRecord(value)) return false;
  const type = value.type;
  return type === "notice" || type === "prompt" || type === "cleared";
}

function isStreamEvent(value: unknown): value is AgentStreamEvent {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (type === "user_message") {
    return typeof value.conversationId === "string" && typeof value.text === "string";
  }
  if (type === "agents") {
    return typeof value.conversationId === "string" && Array.isArray(value.agents);
  }
  if (type === "agent_event") {
    return (
      typeof value.conversationId === "string" &&
      typeof value.agentId === "string" &&
      isObject(value.event)
    );
  }
  return (
    type === "state" ||
    type === "text_delta" ||
    type === "thinking_delta" ||
    type === "assistant_start" ||
    type === "tool_start" ||
    type === "tool_output" ||
    type === "tool_end" ||
    type === "error"
  );
}

function isWorkspaceEvent(value: unknown): value is WorkspaceEvent {
  if (!isRecord(value) || value.type !== "changed") return false;
  const workspace = value.workspace;
  return (
    isObject(workspace) &&
    (workspace.current === null || typeof workspace.current === "string") &&
    Array.isArray(workspace.recents)
  );
}

function isApprovalEvent(value: unknown): value is SandboxApprovalEvent {
  if (!isRecord(value)) return false;
  if (value.type === "request") {
    // 注意用 isObject:isRecord 要求对象带 type 字段,而请求对象本身没有。
    const request = value.request;
    return isObject(request) && typeof request.id === "string" && typeof request.kind === "string";
  }
  return value.type === "resolved" && typeof value.id === "string";
}

function isQuestionEvent(value: unknown): value is AskUserQuestionEvent {
  if (!isRecord(value)) return false;
  if (value.type === "request") {
    // 注意用 isObject:isRecord 要求对象带 type 字段,而问题请求对象本身没有。
    const request = value.request;
    return (
      isObject(request) &&
      typeof request.id === "string" &&
      typeof request.conversationId === "string" &&
      typeof request.toolCallId === "string" &&
      typeof request.question === "string" &&
      Array.isArray(request.options)
    );
  }
  return (
    value.type === "resolved" &&
    typeof value.id === "string" &&
    (value.answer === null || typeof value.answer === "string")
  );
}

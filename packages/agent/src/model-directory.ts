import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type AuthEvent, type AuthInteraction, type AuthPrompt, type AuthType, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  customModelApis,
  thinkingLevels,
  type AuthMethodSummary,
  type AuthNotice,
  type AuthPromptRequest,
  type AuthSource,
  type AgentSettings,
  type CustomModelApi,
  type CustomModelInput,
  type ModelAuthEvent,
  type ModelCatalog,
  type ModelSummary,
  type ProviderSummary,
  type ThinkingLevel,
} from "@vela/shared";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const defaultThinkingLevel: ThinkingLevel = "medium";

export interface ModelSelection {
  provider: string | null;
  modelId: string | null;
  thinkingLevel: ThinkingLevel;
  instructions: string;
}

const maxInstructionLength = 4000;

interface PendingPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface ModelsFile {
  providers: Record<string, ProviderRecord>;
  rest: Record<string, unknown>;
}

interface ProviderRecord {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: ModelRecord[];
  [key: string]: unknown;
}

interface ModelRecord {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export class ModelDirectory {
  readonly runtime: ModelRuntime;
  selection: ModelSelection = {
    provider: null,
    modelId: null,
    thinkingLevel: defaultThinkingLevel,
    instructions: "",
  };

  private readonly authListeners = new Set<(event: ModelAuthEvent) => void>();
  private readonly pending = new Map<string, PendingPrompt>();
  private loginAbort: AbortController | null = null;

  private constructor(
    private readonly dir: string,
    runtime: ModelRuntime,
  ) {
    this.runtime = runtime;
  }

  static async open(dir: string): Promise<ModelDirectory> {
    await mkdir(dir, { recursive: true });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const directory = new ModelDirectory(dir, runtime);
    directory.selection = await directory.readSelection();
    return directory;
  }

  subscribeAuth(listener: (event: ModelAuthEvent) => void): () => void {
    this.authListeners.add(listener);
    return () => {
      this.authListeners.delete(listener);
    };
  }

  async catalog(): Promise<ModelCatalog> {
    const custom = await this.readCustomKeys();
    const stored = new Set((await this.runtime.listCredentials()).map((item) => item.providerId));
    const available = new Set(this.runtime.getAvailableSnapshot().map(modelKey));
    const file = await this.readModelsFile();
    const providers: ProviderSummary[] = [];
    const models: ModelSummary[] = [];

    for (const provider of this.runtime.getProviders()) {
      const methods = authMethods(provider.auth);
      const status = this.runtime.getProviderAuthStatus(provider.id);
      const endpoint = customEndpoint(file.providers[provider.id]);
      const customProvider = provider.id in file.providers;
      const providerModels = provider.getModels();
      if (methods.length === 0 && !status.configured && !customProvider) continue;

      providers.push({
        id: provider.id,
        name: provider.name || provider.id,
        authenticated: status.configured,
        stored: stored.has(provider.id),
        custom: customProvider,
        authSource: isAuthSource(status.source) ? status.source : null,
        methods,
        endpoint,
        modelCount: providerModels.length,
      });

      for (const model of providerModels) {
        models.push(summarizeModel(model, provider.name || provider.id, available.has(modelKey(model)), custom.has(modelKey(model))));
      }
    }

    providers.sort((a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name, "zh"));
    models.sort((a, b) => a.providerName.localeCompare(b.providerName, "zh") || a.name.localeCompare(b.name, "zh"));
    return { providers, models, error: this.runtime.getError() ?? null };
  }

  modelForSelection(): Model<Api> | undefined {
    const { provider, modelId } = this.selection;
    if (!provider || !modelId) return undefined;
    return this.runtime.getModel(provider, modelId);
  }

  availableSelection(): Model<Api> | undefined {
    const model = this.modelForSelection();
    if (!model || !this.isAvailable(model)) return undefined;
    return model;
  }

  isAvailable(model: { provider: string; id: string }): boolean {
    return this.runtime.getAvailableSnapshot().some((item) => item.provider === model.provider && item.id === model.id);
  }

  async select(providerId: string, modelId: string): Promise<Model<Api>> {
    const model = this.runtime.getModel(providerId, modelId);
    if (!model) throw new Error("找不到这个模型");
    if (!this.isAvailable(model)) throw new Error("这个模型还不能使用，请先登录或填写密钥");
    this.selection = {
      ...this.selection,
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: clampLevel(model, this.selection.thinkingLevel),
    };
    await this.writeSelection();
    return model;
  }

  async setThinkingLevel(level: ThinkingLevel, model: Model<Api> | undefined): Promise<ThinkingLevel> {
    const next = model ? clampLevel(model, level) : level;
    this.selection = { ...this.selection, thinkingLevel: next };
    await this.writeSelection();
    return next;
  }

  getSettings(): AgentSettings {
    return {
      provider: this.selection.provider,
      modelId: this.selection.modelId,
      thinkingLevel: this.selection.thinkingLevel,
      instructions: this.selection.instructions,
    };
  }

  /** 写入新建对话的默认值,不改已经打开的会话。 */
  async saveSettings(input: AgentSettings): Promise<AgentSettings> {
    if (!isThinkingLevel(input.thinkingLevel)) throw new Error("不支持这个思考强度");
    const instructions = normalizeInstructions(input.instructions);
    const hasProvider = Boolean(input.provider);
    const hasModel = Boolean(input.modelId);
    if (hasProvider !== hasModel) throw new Error("需要同时选择提供方和模型");

    let provider: string | null = null;
    let modelId: string | null = null;
    let thinkingLevel: ThinkingLevel = input.thinkingLevel;
    if (input.provider && input.modelId) {
      const model = this.runtime.getModel(input.provider, input.modelId);
      if (!model) throw new Error("找不到这个模型");
      if (!this.isAvailable(model)) throw new Error("这个模型还不能使用，请先登录或填写密钥");
      provider = model.provider;
      modelId = model.id;
      thinkingLevel = clampLevel(model, input.thinkingLevel);
    }

    this.selection = { provider, modelId, thinkingLevel, instructions };
    await this.writeSelection();
    return this.getSettings();
  }

  requireAvailable(providerId: string, modelId: string): Model<Api> {
    const model = this.runtime.getModel(providerId, modelId);
    if (!model) throw new Error("找不到这个模型");
    if (!this.isAvailable(model)) throw new Error("这个模型还不能使用，请先登录或填写密钥");
    return model;
  }

  async addCustom(input: CustomModelInput): Promise<{ providerId: string; modelId: string }> {
    const providerId = parseProviderId(input.providerId);
    const modelId = parseModelId(input.modelId);
    const baseUrl = parseHttpUrl(input.baseUrl);
    const api = parseApi(input.api);
    const providerName = optionalText(input.providerName, "提供方名称", 80);
    const modelName = optionalText(input.modelName, "模型名称", 120);
    const contextWindow = optionalCount(input.contextWindow, "上下文长度");
    const maxTokens = optionalCount(input.maxTokens, "输出上限");
    const apiKey = input.apiKey.trim();
    if (apiKey.length > 8000) throw new Error("密钥过长");

    const existingProvider = this.runtime.getProvider(providerId);
    const file = await this.readModelsFile();
    const current = file.providers[providerId];
    if (existingProvider && !current) {
      throw new Error("这是内置提供方，请使用登录，不要把它写成自定义接口");
    }
    if (!current && !apiKey) throw new Error("新接口需要填写密钥");

    const nextProvider: ProviderRecord = {
      ...(current ?? {}),
      baseUrl,
      api,
      models: upsertModel(current?.models ?? [], {
        id: modelId,
        ...(modelName ? { name: modelName } : {}),
        api,
        reasoning: input.reasoning,
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      }),
    };
    if (providerName) nextProvider.name = providerName;
    else if (!nextProvider.name) delete nextProvider.name;
    if (apiKey) nextProvider.apiKey = apiKey;
    else if (!nextProvider.apiKey) throw new Error("这个接口还没有密钥");

    file.providers[providerId] = nextProvider;
    await this.writeModelsFile(file);
    await this.reloadModels();
    const loaded = this.runtime.getModel(providerId, modelId);
    if (!loaded) throw new Error(this.runtime.getError() ?? "模型没有加载成功");
    return { providerId, modelId };
  }

  async removeCustom(providerId: string, modelId: string): Promise<void> {
    const file = await this.readModelsFile();
    const current = file.providers[providerId];
    const models = current?.models ?? [];
    if (!current || !models.some((model) => model.id === modelId)) {
      throw new Error("只能删除在这里添加的模型");
    }
    const remaining = models.filter((model) => model.id !== modelId);
    if (remaining.length === 0 && isManagedProvider(current)) {
      file.providers = Object.fromEntries(Object.entries(file.providers).filter(([id]) => id !== providerId));
    }
    else file.providers[providerId] = { ...current, models: remaining };
    await this.writeModelsFile(file);
    await this.reloadModels();
    if (this.selection.provider === providerId && this.selection.modelId === modelId) {
      this.selection = { ...this.selection, provider: null, modelId: null };
      await this.writeSelection();
    }
  }

  async logout(providerId: string): Promise<void> {
    await this.runtime.logout(providerId);
  }

  async login(providerId: string, type: AuthType): Promise<"ok" | "cancelled"> {
    if (this.loginAbort) throw new Error("已有一个登录在进行");
    const provider = this.runtime.getProvider(providerId);
    if (!provider) throw new Error("找不到这个提供方");
    if (type === "oauth" && !provider.auth.oauth) throw new Error("这个提供方不支持登录");
    if (type === "api_key" && !provider.auth.apiKey?.login) throw new Error("这个提供方不支持填写密钥");

    const abort = new AbortController();
    this.loginAbort = abort;
    try {
      await this.runtime.login(providerId, type, this.interaction(abort.signal));
      return abort.signal.aborted ? "cancelled" : "ok";
    } catch (error) {
      if (abort.signal.aborted || isCancelled(error)) return "cancelled";
      throw error;
    } finally {
      this.rejectPending(new LoginCancelled());
      this.loginAbort = null;
      this.emit({ type: "cleared" });
    }
  }

  replyLogin(promptId: string, value: string | null): void {
    const pending = this.pending.get(promptId);
    if (!pending) return;
    if (value === null) {
      pending.reject(new LoginCancelled());
      this.loginAbort?.abort();
      return;
    }
    pending.resolve(value);
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
    this.rejectPending(new LoginCancelled());
  }

  private interaction(signal: AbortSignal): AuthInteraction {
    return {
      signal,
      notify: (event) => {
        const notice = toNotice(event);
        if (notice) this.emit({ type: "notice", notice });
      },
      prompt: (prompt) => this.ask(prompt, signal),
    };
  }

  private ask(prompt: AuthPrompt, loginSignal: AbortSignal): Promise<string> {
    if (prompt.signal?.aborted || loginSignal.aborted) return Promise.reject(new LoginCancelled());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: string) => {
        if (!this.pending.delete(id)) return;
        prompt.signal?.removeEventListener("abort", onPromptAbort);
        loginSignal.removeEventListener("abort", onLoginAbort);
        this.emit({ type: "cleared" });
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const onPromptAbort = () => finish(new PromptClosed());
      const onLoginAbort = () => finish(new LoginCancelled());
      this.pending.set(id, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      });
      prompt.signal?.addEventListener("abort", onPromptAbort, { once: true });
      loginSignal.addEventListener("abort", onLoginAbort, { once: true });
      this.emit({ type: "prompt", request: { id, prompt: serializePrompt(prompt) } });
    });
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private emit(event: ModelAuthEvent): void {
    for (const listener of this.authListeners) listener(event);
  }

  private async reloadModels(): Promise<void> {
    await this.runtime.refresh({ allowNetwork: false });
  }

  private async readSelection(): Promise<ModelSelection> {
    try {
      const parsed = JSON.parse(await readFile(this.selectionPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return this.selection;
      const record = parsed as Record<string, unknown>;
      const provider = typeof record.provider === "string" ? record.provider : null;
      const modelId = typeof record.modelId === "string" ? record.modelId : null;
      const thinkingLevel = typeof record.thinkingLevel === "string" && isThinkingLevel(record.thinkingLevel)
        ? record.thinkingLevel
        : defaultThinkingLevel;
      return { provider, modelId, thinkingLevel, instructions: readInstructions(record.instructions) };
    } catch {
      return { provider: null, modelId: null, thinkingLevel: defaultThinkingLevel, instructions: "" };
    }
  }

  private async writeSelection(): Promise<void> {
    const body: Record<string, string> = {
      thinkingLevel: this.selection.thinkingLevel,
      instructions: this.selection.instructions,
    };
    if (this.selection.provider && this.selection.modelId) {
      body.provider = this.selection.provider;
      body.modelId = this.selection.modelId;
    }
    await writePrivateJson(this.selectionPath, body);
  }

  private async readModelsFile(): Promise<ModelsFile> {
    try {
      const parsed = JSON.parse(await readFile(this.modelsPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("models.json 格式不正确");
      const providers = "providers" in parsed ? parsed.providers : undefined;
      if (providers === undefined) return { providers: {}, rest: parsed as Record<string, unknown> };
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw new Error("models.json 格式不正确");
      const rest = { ...(parsed as Record<string, unknown>) };
      delete rest.providers;
      return { providers: providers as Record<string, ProviderRecord>, rest };
    } catch (error) {
      if (isMissingFile(error)) return { providers: {}, rest: {} };
      throw error instanceof Error ? error : new Error("无法读取模型配置");
    }
  }

  private async readCustomKeys(): Promise<Set<string>> {
    const file = await this.readModelsFile();
    const keys = new Set<string>();
    for (const [providerId, provider] of Object.entries(file.providers)) {
      for (const model of provider.models ?? []) {
        if (model && typeof model.id === "string") keys.add(`${providerId}\0${model.id}`);
      }
    }
    return keys;
  }

  private async writeModelsFile(file: ModelsFile): Promise<void> {
    await writePrivateJson(this.modelsPath, { ...file.rest, providers: file.providers });
  }

  private get selectionPath(): string {
    return join(this.dir, "selection.json");
  }

  private get modelsPath(): string {
    return join(this.dir, "models.json");
  }
}

class LoginCancelled extends Error {
  constructor() {
    super("已取消登录");
    this.name = "LoginCancelled";
  }
}

class PromptClosed extends Error {
  constructor() {
    super("登录步骤已结束");
    this.name = "PromptClosed";
  }
}

function isCancelled(error: unknown): boolean {
  return error instanceof LoginCancelled || (error instanceof Error && /login cancelled/i.test(error.message));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (thinkingLevels as readonly string[]).includes(value);
}

function readInstructions(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, maxInstructionLength);
}

function normalizeInstructions(value: string): string {
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length > maxInstructionLength) throw new Error("额外指令过长");
  return text;
}

function clampLevel(model: Model<Api>, level: ThinkingLevel): ThinkingLevel {
  const clamped = clampThinkingLevel(model, level);
  return isThinkingLevel(clamped) ? clamped : "off";
}

function supportedLevels(model: Model<Api>): ThinkingLevel[] {
  return getSupportedThinkingLevels(model).filter(isThinkingLevel);
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}\0${model.id}`;
}

function summarizeModel(model: Model<Api>, providerName: string, available: boolean, custom: boolean): ModelSummary {
  return {
    provider: model.provider,
    providerName,
    id: model.id,
    name: model.name?.trim() || model.id,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    available,
    custom,
    thinkingLevels: supportedLevels(model),
  };
}

function authMethods(auth: { apiKey?: { name?: string; login?: unknown }; oauth?: { name?: string; loginLabel?: string } }): AuthMethodSummary[] {
  const methods: AuthMethodSummary[] = [];
  if (auth.apiKey?.login) methods.push({ type: "api_key", label: auth.apiKey.name || "API 密钥" });
  if (auth.oauth) methods.push({ type: "oauth", label: auth.oauth.loginLabel || auth.oauth.name || "登录" });
  return methods;
}

function customEndpoint(provider: ProviderRecord | undefined): ProviderSummary["endpoint"] {
  if (!provider?.baseUrl || !provider.api) return null;
  return { baseUrl: provider.baseUrl, api: provider.api };
}

function upsertModel(models: ModelRecord[], next: ModelRecord): ModelRecord[] {
  const index = models.findIndex((model) => model.id === next.id);
  if (index < 0) return [...models, next];
  return models.map((model, itemIndex) => (itemIndex === index ? { ...model, ...next } : model));
}

function isManagedProvider(provider: ProviderRecord): boolean {
  return Object.keys(provider).every((key) => key === "name" || key === "baseUrl" || key === "api" || key === "apiKey" || key === "models");
}

function parseProviderId(value: string): string {
  const id = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error("提供方名称只能包含字母、数字、点、下划线和短横线");
  return id;
}

function parseModelId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 200 || /[\r\n]/.test(id)) throw new Error("模型 ID 不正确");
  return id;
}

function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("接口地址不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("接口地址需要以 http 或 https 开头");
  return url.toString().replace(/\/$/, "");
}

function parseApi(value: string): CustomModelApi {
  if ((customModelApis as readonly string[]).includes(value)) return value as CustomModelApi;
  throw new Error("不支持这个接口类型");
}

function optionalText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (text.length > max) throw new Error(`${label}过长`);
  return text;
}

function optionalCount(value: number | null, label: string): number | undefined {
  if (value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 10_000_000) throw new Error(`${label}需要是正整数`);
  return value;
}

function toNotice(event: AuthEvent): AuthNotice | null {
  if (event.type === "progress") return { type: "progress", message: clip(event.message, 500) };
  if (event.type === "info") {
    return {
      type: "info",
      message: clip(event.message, 1000),
      links: event.links?.flatMap((link) => {
        const url = httpUrl(link.url);
        return url ? [{ url, label: link.label ? clip(link.label, 80) : undefined }] : [];
      }),
    };
  }
  if (event.type === "auth_url") {
    const url = httpUrl(event.url);
    if (!url) return null;
    return { type: "auth_url", url, instructions: event.instructions ? clip(event.instructions, 500) : undefined };
  }
  if (event.type === "device_code") {
    const verificationUri = httpUrl(event.verificationUri);
    if (!verificationUri || !event.userCode.trim()) return null;
    return {
      type: "device_code",
      userCode: clip(event.userCode.trim(), 80),
      verificationUri,
      expiresInSeconds: event.expiresInSeconds,
    };
  }
  return null;
}

function serializePrompt(prompt: AuthPrompt): AuthPromptRequest["prompt"] {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: clip(prompt.message, 1000),
      options: prompt.options.slice(0, 50).map((option) => ({
        id: option.id,
        label: clip(option.label, 160),
        description: option.description ? clip(option.description, 300) : undefined,
      })),
    };
  }
  return {
    type: prompt.type,
    message: clip(prompt.message, 1000),
    placeholder: prompt.placeholder ? clip(prompt.placeholder, 200) : undefined,
  };
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function isAuthSource(value: string | undefined): value is AuthSource {
  return value === "stored"
    || value === "runtime"
    || value === "environment"
    || value === "fallback"
    || value === "models_json_key"
    || value === "models_json_command";
}

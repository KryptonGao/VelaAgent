import {
  customModelApis,
  thinkingLevelLabel,
  type AuthMethodType,
  type AuthNotice,
  type CustomModelApi,
  type CustomModelInput,
  type ModelCatalog,
  type ModelSummary,
  type ProviderSummary,
  type ThinkingLevel,
} from "@vela/shared";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useEscapeKey } from "../hooks/useDismissable";
import type { LoginState } from "../hooks/useModels";
import { SheetPresence } from "./Presence";

interface ModelControlsProps {
  modelLabel: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  disabled: boolean;
  catalog: ModelCatalog | null;
  catalogError: string | null;
  actionError: string | null;
  login: LoginState;
  onSelect: (provider: string, id: string) => Promise<unknown>;
  onThinking: (level: ThinkingLevel) => Promise<unknown>;
  onAdd: (input: CustomModelInput) => Promise<string | null>;
  onRemove: (provider: string, id: string) => Promise<unknown>;
  onLogout: (providerId: string) => Promise<unknown>;
  onLogin: (providerId: string, type: AuthMethodType) => Promise<unknown>;
  onReplyLogin: (promptId: string, value: string | null) => Promise<void>;
  onCancelLogin: () => Promise<void>;
  onDismissLogin: () => void;
}

export function ModelControls(props: ModelControlsProps) {
  const [menu, setMenu] = useState<"model" | "thinking" | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const thinkingChoices = props.thinkingLevels.length > 0 ? props.thinkingLevels : (["off"] as ThinkingLevel[]);
  const shownThinking = thinkingChoices.includes(props.thinkingLevel) ? props.thinkingLevel : thinkingChoices[0] ?? "off";

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="model-controls" ref={rootRef}>
      <div className="dock-menu">
        <button
          className="model-choice-pill"
          type="button"
          title={thinkingChoices.length < 2 ? "当前模型不支持调整思考强度" : "思考强度"}
          aria-haspopup="true"
          aria-expanded={menu === "thinking"}
          disabled={props.disabled || thinkingChoices.length < 2}
          onClick={() => setMenu((current) => (current === "thinking" ? null : "thinking"))}
        >
          <span>{thinkingLevelLabel[shownThinking]}</span>
          <Chevron />
        </button>
        {menu === "thinking" ? (
          <div className="dock-popover thinking-popover">
            {thinkingChoices.map((level) => (
              <button
                key={level}
                className={`menu-row${level === shownThinking ? " active" : ""}`}
                type="button"
                onClick={() => {
                  setMenu(null);
                  void props.onThinking(level);
                }}
              >
                <span>{thinkingLevelLabel[level]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="dock-menu">
        <button
          className="model-choice-pill model-pill"
          type="button"
          title={props.modelLabel ? `模型:${props.modelLabel}` : "选择模型"}
          aria-haspopup="true"
          aria-expanded={menu === "model"}
          disabled={props.disabled}
          onClick={() => setMenu((current) => (current === "model" ? null : "model"))}
        >
          <span className="model-pill-label">{props.modelLabel ?? "选择模型"}</span>
          <Chevron />
        </button>
        {menu === "model" ? (
          <ModelMenu
            catalog={props.catalog}
            catalogError={props.catalogError}
            actionError={props.actionError}
            provider={props.modelProvider}
            modelId={props.modelId}
            onSelect={(provider, id) => {
              setMenu(null);
              void props.onSelect(provider, id);
            }}
            onAdd={() => {
              setMenu(null);
              setAddOpen(true);
            }}
            onAccounts={() => {
              setMenu(null);
              setAccountsOpen(true);
            }}
          />
        ) : null}
      </div>

      <SheetPresence present={accountsOpen}>
        <AccountSheet
          catalog={props.catalog}
          actionError={props.actionError}
          onClose={() => setAccountsOpen(false)}
          onLogin={props.onLogin}
          onLogout={props.onLogout}
          onRemove={props.onRemove}
        />
      </SheetPresence>
      <SheetPresence present={addOpen}>
        <AddModelSheet
          catalog={props.catalog}
          onClose={() => setAddOpen(false)}
          onAdd={async (input) => {
            const message = await props.onAdd(input);
            if (!message) setAddOpen(false);
            return message;
          }}
        />
      </SheetPresence>
      <SheetPresence present={props.login.active}>
        <LoginDialog
          login={props.login}
          onReply={props.onReplyLogin}
          onCancel={props.onCancelLogin}
          onDismiss={props.onDismissLogin}
        />
      </SheetPresence>
    </div>
  );
}

function ModelMenu({
  catalog,
  catalogError,
  actionError,
  provider,
  modelId,
  onSelect,
  onAdd,
  onAccounts,
}: {
  catalog: ModelCatalog | null;
  catalogError: string | null;
  actionError: string | null;
  provider: string | null;
  modelId: string | null;
  onSelect: (provider: string, id: string) => void;
  onAdd: () => void;
  onAccounts: () => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupModels(catalog?.models ?? [], query), [catalog, query]);

  return (
    <div className="dock-popover model-popover">
      <input
        className="menu-search"
        placeholder="搜索模型"
        aria-label="搜索模型"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <div className="menu-scroll">
        {catalogError ? <p className="menu-note">{catalogError}</p> : null}
        {actionError ? <p className="menu-note menu-note-error">{actionError}</p> : null}
        {catalog?.error ? <p className="menu-note menu-note-error">{catalog.error}</p> : null}
        {!catalog && !catalogError ? <p className="menu-note">正在读取模型</p> : null}
        {catalog && provider && modelId && !catalog.models.some((model) => model.available && model.provider === provider && model.id === modelId) ? (
          <p className="menu-note">当前模型还不能使用，请先在账号里登录。</p>
        ) : null}
        {catalog && groups.length === 0 ? <p className="menu-note">还没有可用模型。先登录提供方，或添加一个兼容接口。</p> : null}
        {groups.map((group) => (
          <section key={group.provider}>
            <div className="menu-section">{group.name}</div>
            {group.models.map((model) => {
              const selected = model.provider === provider && model.id === modelId;
              return (
                <button
                  key={`${model.provider}/${model.id}`}
                  className={`menu-row${selected ? " active" : ""}`}
                  type="button"
                  onClick={() => onSelect(model.provider, model.id)}
                >
                  <span className="menu-row-title">
                    {model.name}
                    {model.custom ? <em>自定义</em> : null}
                  </span>
                  <span className="menu-row-meta">{model.id}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <div className="menu-footer">
        <button className="menu-footer-btn" type="button" onClick={onAccounts}>账号</button>
        <button className="menu-footer-btn" type="button" onClick={onAdd}>添加模型</button>
      </div>
    </div>
  );
}

function AccountSheet({
  catalog,
  actionError,
  onClose,
  onLogin,
  onLogout,
  onRemove,
}: {
  catalog: ModelCatalog | null;
  actionError: string | null;
  onClose: () => void;
  onLogin: (providerId: string, type: AuthMethodType) => Promise<unknown>;
  onLogout: (providerId: string) => Promise<unknown>;
  onRemove: (provider: string, id: string) => Promise<unknown>;
}) {
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const providers = (catalog?.providers ?? []).filter((provider) => {
    const haystack = `${provider.name} ${provider.id}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const dialogRef = useEscapeKey<HTMLDivElement>(true, onClose);

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="sheet-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-sheet-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-header">
          <h2 id="account-sheet-title">账号</h2>
          <button className="sheet-close" type="button" onClick={onClose}>关闭</button>
        </header>
        <input
          className="menu-search sheet-search"
          placeholder="搜索提供方"
          aria-label="搜索提供方"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {actionError ? <p className="menu-note menu-note-error">{actionError}</p> : null}
        <div className="sheet-scroll">
          <p className="menu-note">登录和密钥保存在 Vela 自己的目录里。</p>
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              models={(catalog?.models ?? []).filter((model) => model.provider === provider.id && model.custom)}
              pendingDelete={pendingDelete}
              onLogin={onLogin}
              onLogout={onLogout}
              onRemove={async (model) => {
                const key = `${model.provider}/${model.id}`;
                if (pendingDelete !== key) {
                  setPendingDelete(key);
                  return;
                }
                setPendingDelete(null);
                await onRemove(model.provider, model.id);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  models,
  pendingDelete,
  onLogin,
  onLogout,
  onRemove,
}: {
  provider: ProviderSummary;
  models: ModelSummary[];
  pendingDelete: string | null;
  onLogin: (providerId: string, type: AuthMethodType) => Promise<unknown>;
  onLogout: (providerId: string) => Promise<unknown>;
  onRemove: (model: ModelSummary) => Promise<unknown>;
}) {
  return (
    <article className="provider-row">
      <div className="provider-row-head">
        <div>
          <div className="menu-row-title">{provider.name}</div>
          <div className="menu-row-meta">{providerStatus(provider)}</div>
        </div>
        <div className="provider-actions">
          {provider.methods.map((method) => (
            <button key={method.type} className="menu-footer-btn" type="button" onClick={() => void onLogin(provider.id, method.type)}>
              {method.type === "oauth" ? "登录" : "填写密钥"}
            </button>
          ))}
          {provider.stored ? (
            <button className="menu-footer-btn" type="button" onClick={() => void onLogout(provider.id)}>退出</button>
          ) : null}
        </div>
      </div>
      {models.map((model) => {
        const key = `${model.provider}/${model.id}`;
        return (
          <div className="custom-model-row" key={key}>
            <span>{model.name}</span>
            <button className="menu-footer-btn" type="button" onClick={() => void onRemove(model)}>
              {pendingDelete === key ? "确认删除" : "删除"}
            </button>
          </div>
        );
      })}
    </article>
  );
}

function AddModelSheet({
  catalog,
  onClose,
  onAdd,
}: {
  catalog: ModelCatalog | null;
  onClose: () => void;
  onAdd: (input: CustomModelInput) => Promise<string | null>;
}) {
  const [form, setForm] = useState<CustomModelInput>({
    providerId: "",
    providerName: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    modelId: "",
    modelName: "",
    reasoning: false,
    contextWindow: null,
    maxTokens: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useEscapeKey<HTMLFormElement>(!saving, onClose);

  function fillKnownProvider(): void {
    const match = catalog?.providers.find((provider) => provider.id === form.providerId.trim());
    if (!match?.endpoint) return;
    setForm((current) => ({
      ...current,
      baseUrl: current.baseUrl || match.endpoint?.baseUrl || "",
      api: isCustomApi(match.endpoint?.api) ? match.endpoint.api : current.api,
    }));
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form
        ref={dialogRef}
        className="sheet-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-model-sheet-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void onAdd(form).then((message) => {
            if (!message) return;
            setError(message);
            setSaving(false);
          });
        }}
      >
        <header className="sheet-header">
          <h2 id="add-model-sheet-title">添加模型</h2>
          <button className="sheet-close" type="button" onClick={onClose}>关闭</button>
        </header>
        <div className="sheet-scroll form-grid">
          <p className="menu-note">用于 OpenAI、Anthropic 或 Google 兼容接口。内置提供方请用账号登录，Codex 走 ChatGPT 登录。</p>
          <Field label="提供方 ID">
            <input value={form.providerId} placeholder="ollama" onBlur={fillKnownProvider} onChange={(event) => setForm({ ...form, providerId: event.target.value })} />
          </Field>
          <Field label="显示名称">
            <input value={form.providerName} placeholder="可选" onChange={(event) => setForm({ ...form, providerName: event.target.value })} />
          </Field>
          <Field label="接口类型">
            <select value={form.api} onChange={(event) => setForm({ ...form, api: event.target.value as CustomModelApi })}>
              {customModelApis.map((api) => (
                <option key={api} value={api}>{apiLabel[api]}</option>
              ))}
            </select>
          </Field>
          <Field label="接口地址">
            <input value={form.baseUrl} placeholder="http://127.0.0.1:11434/v1" onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
          </Field>
          <Field label="密钥">
            <input type="password" value={form.apiKey} placeholder="已有接口可以留空" onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
          </Field>
          <Field label="模型 ID">
            <input value={form.modelId} placeholder="qwen2.5-coder:7b" onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
          </Field>
          <Field label="模型名称">
            <input value={form.modelName} placeholder="可选" onChange={(event) => setForm({ ...form, modelName: event.target.value })} />
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={form.reasoning} onChange={(event) => setForm({ ...form, reasoning: event.target.checked })} />
            <span>支持思考强度</span>
          </label>
          <Field label="上下文长度">
            <input
              inputMode="numeric"
              value={form.contextWindow ?? ""}
              placeholder="可选"
              onChange={(event) => setForm({ ...form, contextWindow: event.target.value ? Number(event.target.value) : null })}
            />
          </Field>
          <Field label="输出上限">
            <input
              inputMode="numeric"
              value={form.maxTokens ?? ""}
              placeholder="可选"
              onChange={(event) => setForm({ ...form, maxTokens: event.target.value ? Number(event.target.value) : null })}
            />
          </Field>
          {error ? <p className="menu-note menu-note-error">{error}</p> : null}
        </div>
        <div className="sheet-footer">
          <button className="primary-btn" type="submit" disabled={saving}>{saving ? "正在添加" : "添加"}</button>
        </div>
      </form>
    </div>
  );
}

export function LoginDialog({
  login,
  onReply,
  onCancel,
  onDismiss,
}: {
  login: LoginState;
  onReply: (promptId: string, value: string | null) => Promise<void>;
  onCancel: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [value, setValue] = useState("");
  const prompt = login.prompt;

  useEffect(() => {
    setValue("");
  }, [prompt?.id]);
  const dialogRef = useEscapeKey<HTMLElement>(true, () => {
    if (login.error) onDismiss();
    else void onCancel();
  });

  return (
    <div className="sheet-backdrop">
      <section ref={dialogRef} className="sheet-card login-card" role="dialog" aria-modal="true" aria-labelledby="login-sheet-title">
        <header className="sheet-header">
          <h2 id="login-sheet-title">登录</h2>
          {login.error ? (
            <button className="sheet-close" type="button" onClick={onDismiss}>关闭</button>
          ) : (
            <button className="sheet-close" type="button" onClick={() => void onCancel()}>取消</button>
          )}
        </header>
        <div className="sheet-scroll login-body">
          {login.notices.map((notice, index) => (
            <Notice key={`${notice.type}-${index}`} notice={notice} />
          ))}
          {login.progress ? <p className="menu-note">{translate(login.progress)}</p> : null}
          {login.error ? <p className="menu-note menu-note-error">{login.error}</p> : null}
          {prompt?.prompt.type === "select" ? (
            <div className="login-options">
              <p>{translate(prompt.prompt.message)}</p>
              {prompt.prompt.options.map((option) => (
                <button key={option.id} className="menu-row" type="button" onClick={() => void onReply(prompt.id, option.id)}>
                  <span className="menu-row-title">{translate(option.label)}</span>
                  {option.description ? <span className="menu-row-meta">{translate(option.description)}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          {prompt && prompt.prompt.type !== "select" ? (
            <form
              className="login-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!value.trim()) return;
                void onReply(prompt.id, value);
              }}
            >
              <p>{translate(prompt.prompt.message)}</p>
              <input
                type={prompt.prompt.type === "secret" ? "password" : "text"}
                value={value}
                placeholder={prompt.prompt.placeholder ? translate(prompt.prompt.placeholder) : ""}
                onChange={(event) => setValue(event.target.value)}
              />
              <button className="primary-btn" type="submit" disabled={!value.trim()}>继续</button>
            </form>
          ) : null}
          {!prompt && !login.error ? <p className="menu-note">正在等待登录完成。</p> : null}
        </div>
      </section>
    </div>
  );
}

function Notice({ notice }: { notice: AuthNotice }) {
  if (notice.type === "device_code") {
    return (
      <div className="login-device">
        <p>在验证页面输入这组设备码</p>
        <code>{notice.userCode}</code>
        <a href={notice.verificationUri} target="_blank" rel="noreferrer">打开验证页面</a>
      </div>
    );
  }
  if (notice.type === "auth_url") {
    return (
      <div className="login-link">
        <p>{translate(notice.instructions ?? "在浏览器中完成登录。")}</p>
        <a href={notice.url} target="_blank" rel="noreferrer">打开登录页面</a>
      </div>
    );
  }
  if (notice.type === "info") {
    return (
      <div className="login-link">
        <p>{translate(notice.message)}</p>
        {notice.links?.map((link) => (
          <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label ?? "打开链接"}</a>
        ))}
      </div>
    );
  }
  return null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function groupModels(models: ModelSummary[], query: string): { provider: string; name: string; models: ModelSummary[] }[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, { provider: string; name: string; models: ModelSummary[] }>();
  for (const model of models) {
    if (!model.available) continue;
    const haystack = `${model.providerName} ${model.name} ${model.id}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    const group = groups.get(model.provider) ?? { provider: model.provider, name: model.providerName, models: [] };
    group.models.push(model);
    groups.set(model.provider, group);
  }
  return [...groups.values()];
}

function providerStatus(provider: ProviderSummary): string {
  if (provider.stored) return "已登录";
  if (provider.authSource === "environment") return "环境变量";
  if (provider.authSource === "models_json_key" || provider.authSource === "models_json_command") return "已保存密钥";
  if (provider.authenticated) return "可用";
  return "未登录";
}

function isCustomApi(value: string | undefined): value is CustomModelApi {
  return !!value && (customModelApis as readonly string[]).includes(value);
}

const apiLabel: Record<CustomModelApi, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
};

const knownText: Record<string, string> = {
  "Select OpenAI Codex login method:": "选择 Codex 登录方式",
  "Browser login (default)": "浏览器登录",
  "Device code login (headless)": "设备码登录",
  "Complete login in your browser, or paste the authorization code / redirect URL here:": "在浏览器完成登录，或把授权码 / 回调地址粘贴到这里",
  "A browser window should open. Complete login to finish.": "将打开浏览器。完成登录后会自动继续，也可以把回调地址粘贴到下面。",
};

function translate(message: string): string {
  const known = knownText[message];
  if (known) return known;
  const enter = /^Enter (.+)$/.exec(message);
  if (enter?.[1]) return `输入 ${enter[1]}`;
  return message;
}

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
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useEscapeKey } from "../hooks/useDismissable";
import type { LoginState } from "../hooks/useModels";
import { modelKey } from "../hooks/usePreferences";
import { PopoverPresence } from "./MotionPresence";
import { SheetPresence } from "./Presence";
import { localizeError, tr } from "../locale";

const thinkingLabelsEn: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function thinkingLabel(level: ThinkingLevel): string {
  return tr(thinkingLevelLabel[level], thinkingLabelsEn[level]);
}

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
  /** 在输入框模型列表中隐藏的模型，key 为 `provider/id`。 */
  hiddenModels: string[];
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
  const [sliderLevel, setSliderLevel] = useState(props.thinkingLevel);
  const rootRef = useRef<HTMLDivElement>(null);
  const thinkingRequestRef = useRef(0);
  const thinkingPopoverId = useId();
  const thinkingChoices = props.thinkingLevels.length > 0 ? props.thinkingLevels : (["off"] as ThinkingLevel[]);
  const shownThinking = thinkingChoices.includes(props.thinkingLevel) ? props.thinkingLevel : thinkingChoices[0] ?? "off";
  const sliderThinking = thinkingChoices.includes(sliderLevel) ? sliderLevel : shownThinking;
  const sliderIndex = Math.max(0, thinkingChoices.indexOf(sliderThinking));
  const sliderMax = Math.max(0, thinkingChoices.length - 1);
  const hasOffChoice = thinkingChoices[0] === "off";
  const sliderOffset = hasOffChoice ? 0 : 1;
  const sliderRangeMax = sliderMax + sliderOffset;
  const sliderValue = sliderIndex + sliderOffset;
  const sliderProgress = sliderRangeMax > 0 ? sliderValue / sliderRangeMax : 0;
  const particleDuration = `${(3.4 - sliderProgress * 2.65).toFixed(2)}s`;

  useEffect(() => {
    if (menu !== "thinking") setSliderLevel(shownThinking);
  }, [menu, shownThinking]);

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
          title={thinkingChoices.length < 2 ? tr("当前模型不支持调整思考强度", "The current model does not support adjustable reasoning") : tr("思考强度", "Reasoning effort")}
          aria-controls={thinkingPopoverId}
          aria-expanded={menu === "thinking"}
          disabled={props.disabled || thinkingChoices.length < 2}
          onClick={() => {
            if (menu === "thinking") {
              setMenu(null);
              return;
            }
            setSliderLevel(shownThinking);
            setMenu("thinking");
          }}
        >
          <span>{thinkingLabel(shownThinking)}</span>
          <Chevron />
        </button>
        <PopoverPresence present={menu === "thinking"}>
          <div id={thinkingPopoverId} className="dock-popover thinking-popover" role="group" aria-label={tr("思考强度", "Reasoning effort")}>
            <div className="thinking-popover-heading">
              <span className="thinking-level-value" aria-live="polite">{thinkingLabel(sliderThinking)}</span>
              <span className="thinking-model-label">{props.modelLabel ?? tr("选择模型", "Choose a model")}</span>
            </div>
            <div
              className="thinking-slider"
              style={{
                "--thinking-progress": `${sliderProgress * 100}%`,
                "--thinking-particle-duration": particleDuration,
              } as CSSProperties}
            >
              <div className="thinking-slider-track" aria-hidden="true">
                <div className="thinking-fill-frame">
                  {sliderProgress > 0 ? (
                    <div className="thinking-slider-fill">
                      <div className="thinking-particles">
                        {[0, 1, 2, 3, 4].map((particle) => (
                          <span
                            key={particle}
                            className={`thinking-particle particle-${particle + 1}`}
                            style={{ "--thinking-particle-delay": `${particle * -0.31}s` } as CSSProperties}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="thinking-slider-markers">
                  {thinkingChoices.map((level, index) => (
                    <span
                      key={level}
                      className={index <= sliderIndex ? "is-active" : undefined}
                      style={{ left: `${sliderRangeMax > 0 ? ((index + sliderOffset) / sliderRangeMax) * 100 : 0}%` }}
                    />
                  ))}
                </div>
              </div>
              <input
                className="thinking-slider-input"
                aria-label={tr("思考强度", "Reasoning effort")}
                aria-valuetext={thinkingLabel(sliderThinking)}
                type="range"
                min={0}
                max={sliderRangeMax}
                step={1}
                value={sliderValue}
                disabled={props.disabled || thinkingChoices.length < 2}
                onChange={(event) => {
                  const nextIndex = Number(event.currentTarget.value) - sliderOffset;
                  const nextLevel = thinkingChoices[nextIndex];
                  if (!nextLevel || nextLevel === sliderThinking) return;
                  setSliderLevel(nextLevel);
                  const request = ++thinkingRequestRef.current;
                  void props.onThinking(nextLevel).then((result) => {
                    if (request === thinkingRequestRef.current && typeof result === "string") {
                      setSliderLevel(shownThinking);
                    }
                  }).catch(() => {
                    if (request === thinkingRequestRef.current) setSliderLevel(shownThinking);
                  });
                }}
              />
            </div>
          </div>
        </PopoverPresence>
      </div>

      <div className="dock-menu">
        <button
          className="model-choice-pill model-pill"
          type="button"
          title={props.modelLabel ? `${tr("模型", "Model")}: ${props.modelLabel}` : tr("选择模型", "Choose a model")}
          aria-haspopup="true"
          aria-expanded={menu === "model"}
          disabled={props.disabled}
          onClick={() => setMenu((current) => (current === "model" ? null : "model"))}
        >
          <span className="model-pill-label">{props.modelLabel ?? tr("选择模型", "Choose a model")}</span>
          <Chevron />
        </button>
        <PopoverPresence present={menu === "model"}>
          <ModelMenu
            catalog={props.catalog}
            catalogError={props.catalogError}
            actionError={props.actionError}
            provider={props.modelProvider}
            modelId={props.modelId}
            hiddenModels={props.hiddenModels}
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
        </PopoverPresence>
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
  hiddenModels,
  onSelect,
  onAdd,
  onAccounts,
}: {
  catalog: ModelCatalog | null;
  catalogError: string | null;
  actionError: string | null;
  provider: string | null;
  modelId: string | null;
  hiddenModels: string[];
  onSelect: (provider: string, id: string) => void;
  onAdd: () => void;
  onAccounts: () => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => groupModels(catalog?.models ?? [], query, hiddenModels, provider, modelId),
    [catalog, query, hiddenModels, provider, modelId],
  );
  const hiddenCount = useMemo(() => {
    return (catalog?.models ?? []).filter(
      (model) => model.available && hiddenModels.includes(modelKey(model.provider, model.id)),
    ).length;
  }, [catalog, hiddenModels]);
  const allHidden = useMemo(() => {
    const available = (catalog?.models ?? []).filter((model) => model.available);
    return available.length > 0 && available.every((model) => hiddenModels.includes(modelKey(model.provider, model.id)));
  }, [catalog, hiddenModels]);

  return (
    <div className="dock-popover model-popover">
      <input
        className="menu-search"
        placeholder={tr("搜索模型", "Search models")}
        aria-label={tr("搜索模型", "Search models")}
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <div className="menu-scroll">
        {catalogError ? <p className="menu-note">{localizeError(catalogError)}</p> : null}
        {actionError ? <p className="menu-note menu-note-error">{localizeError(actionError)}</p> : null}
        {catalog?.error ? <p className="menu-note menu-note-error">{localizeError(catalog.error)}</p> : null}
        {!catalog && !catalogError ? <p className="menu-note">{tr("正在读取模型", "Loading models…")}</p> : null}
        {catalog && provider && modelId && !catalog.models.some((model) => model.available && model.provider === provider && model.id === modelId) ? (
          <p className="menu-note">{tr("当前模型还不能使用，请先在账号里登录。", "This model is unavailable. Sign in to the provider first.")}</p>
        ) : null}
        {catalog && groups.length === 0 && !allHidden ? <p className="menu-note">{tr("还没有可用模型。先登录提供方，或添加一个兼容接口。", "No models are available. Sign in to a provider or add a compatible API.")}</p> : null}
        {catalog && groups.length === 0 && allHidden ? <p className="menu-note">{tr("可用模型都已隐藏，可在设置的「模型与账号」里调整。", "All available models are hidden. Adjust this in Settings → Models & accounts.")}</p> : null}
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
                    {model.custom ? <em>{tr("自定义", "Custom")}</em> : null}
                  </span>
                  <span className="menu-row-meta">{model.id}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      {hiddenCount > 0 ? (
        <p className="menu-note menu-footer-note">
          {tr(`已隐藏 ${hiddenCount} 个模型，可在设置里调整`, `${hiddenCount} hidden · manage in settings`)}
        </p>
      ) : null}
      <div className="menu-footer">
        <button className="menu-footer-btn" type="button" onClick={onAccounts}>{tr("账号", "Accounts")}</button>
        <button className="menu-footer-btn" type="button" onClick={onAdd}>{tr("添加模型", "Add model")}</button>
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
          <h2 id="account-sheet-title">{tr("账号", "Accounts")}</h2>
          <button className="sheet-close" type="button" onClick={onClose}>{tr("关闭", "Close")}</button>
        </header>
        <input
          className="menu-search sheet-search"
          placeholder={tr("搜索提供方", "Search providers")}
          aria-label={tr("搜索提供方", "Search providers")}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {actionError ? <p className="menu-note menu-note-error">{localizeError(actionError)}</p> : null}
        <div className="sheet-scroll">
          <p className="menu-note">{tr("登录和密钥保存在 Vela 自己的目录里。", "Sign-ins and API keys are stored in Vela's data directory.")}</p>
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
              {method.type === "oauth" ? tr("登录", "Sign in") : tr("填写密钥", "Enter API key")}
            </button>
          ))}
          {provider.stored ? (
            <button className="menu-footer-btn" type="button" onClick={() => void onLogout(provider.id)}>{tr("退出", "Sign out")}</button>
          ) : null}
        </div>
      </div>
      {models.map((model) => {
        const key = `${model.provider}/${model.id}`;
        return (
          <div className="custom-model-row" key={key}>
            <span>{model.name}</span>
            <button className="menu-footer-btn" type="button" onClick={() => void onRemove(model)}>
              {pendingDelete === key ? tr("确认删除", "Confirm delete") : tr("删除", "Delete")}
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
          <h2 id="add-model-sheet-title">{tr("添加模型", "Add model")}</h2>
          <button className="sheet-close" type="button" onClick={onClose}>{tr("关闭", "Close")}</button>
        </header>
        <div className="sheet-scroll form-grid">
          <p className="menu-note">{tr("用于 OpenAI、Anthropic 或 Google 兼容接口。内置提供方请用账号登录，Codex 走 ChatGPT 登录。", "For OpenAI, Anthropic, or Google compatible APIs. Sign in to built-in providers; use ChatGPT sign-in for Codex.")}</p>
          <Field label={tr("提供方 ID", "Provider ID")}>
            <input value={form.providerId} placeholder="ollama" onBlur={fillKnownProvider} onChange={(event) => setForm({ ...form, providerId: event.target.value })} />
          </Field>
          <Field label={tr("显示名称", "Display name")}>
            <input value={form.providerName} placeholder={tr("可选", "Optional")} onChange={(event) => setForm({ ...form, providerName: event.target.value })} />
          </Field>
          <Field label={tr("接口类型", "API type")}>
            <select value={form.api} onChange={(event) => setForm({ ...form, api: event.target.value as CustomModelApi })}>
              {customModelApis.map((api) => (
                <option key={api} value={api}>{apiLabel[api]}</option>
              ))}
            </select>
          </Field>
          <Field label={tr("接口地址", "API URL")}>
            <input value={form.baseUrl} placeholder="http://127.0.0.1:11434/v1" onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
          </Field>
          <Field label={tr("密钥", "API key")}>
            <input type="password" value={form.apiKey} placeholder={tr("已有接口可以留空", "Leave blank if already configured")} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
          </Field>
          <Field label={tr("模型 ID", "Model ID")}>
            <input value={form.modelId} placeholder="qwen2.5-coder:7b" onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
          </Field>
          <Field label={tr("模型名称", "Model name")}>
            <input value={form.modelName} placeholder={tr("可选", "Optional")} onChange={(event) => setForm({ ...form, modelName: event.target.value })} />
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={form.reasoning} onChange={(event) => setForm({ ...form, reasoning: event.target.checked })} />
            <span>{tr("支持思考强度", "Supports reasoning effort")}</span>
          </label>
          <Field label={tr("上下文长度", "Context window")}>
            <input
              inputMode="numeric"
              value={form.contextWindow ?? ""}
              placeholder={tr("可选", "Optional")}
              onChange={(event) => setForm({ ...form, contextWindow: event.target.value ? Number(event.target.value) : null })}
            />
          </Field>
          <Field label={tr("输出上限", "Maximum output tokens")}>
            <input
              inputMode="numeric"
              value={form.maxTokens ?? ""}
              placeholder={tr("可选", "Optional")}
              onChange={(event) => setForm({ ...form, maxTokens: event.target.value ? Number(event.target.value) : null })}
            />
          </Field>
          {error ? <p className="menu-note menu-note-error">{localizeError(error)}</p> : null}
        </div>
        <div className="sheet-footer">
          <button className="primary-btn" type="submit" disabled={saving}>{saving ? tr("正在添加", "Adding…") : tr("添加", "Add")}</button>
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
          <h2 id="login-sheet-title">{tr("登录", "Sign in")}</h2>
          {login.error ? (
            <button className="sheet-close" type="button" onClick={onDismiss}>{tr("关闭", "Close")}</button>
          ) : (
            <button className="sheet-close" type="button" onClick={() => void onCancel()}>{tr("取消", "Cancel")}</button>
          )}
        </header>
        <div className="sheet-scroll login-body">
          {login.notices.map((notice, index) => (
            <Notice key={`${notice.type}-${index}`} notice={notice} />
          ))}
          {login.progress ? <p className="menu-note">{translate(login.progress)}</p> : null}
          {login.error ? <p className="menu-note menu-note-error">{localizeError(login.error)}</p> : null}
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
              <button className="primary-btn" type="submit" disabled={!value.trim()}>{tr("继续", "Continue")}</button>
            </form>
          ) : null}
          {!prompt && !login.error ? <p className="menu-note">{tr("正在等待登录完成。", "Waiting for sign-in to complete…")}</p> : null}
        </div>
      </section>
    </div>
  );
}

function Notice({ notice }: { notice: AuthNotice }) {
  if (notice.type === "device_code") {
    return (
      <div className="login-device">
        <p>{tr("在验证页面输入这组设备码", "Enter this device code on the verification page")}</p>
        <code>{notice.userCode}</code>
        <a href={notice.verificationUri} target="_blank" rel="noreferrer">{tr("打开验证页面", "Open verification page")}</a>
      </div>
    );
  }
  if (notice.type === "auth_url") {
    return (
      <div className="login-link">
        <p>{translate(notice.instructions ?? tr("在浏览器中完成登录。", "Complete sign-in in your browser."))}</p>
        <a href={notice.url} target="_blank" rel="noreferrer">{tr("打开登录页面", "Open sign-in page")}</a>
      </div>
    );
  }
  if (notice.type === "info") {
    return (
      <div className="login-link">
        <p>{translate(notice.message)}</p>
        {notice.links?.map((link) => (
          <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label ?? tr("打开链接", "Open link")}</a>
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

function groupModels(
  models: ModelSummary[],
  query: string,
  hidden: string[],
  selectedProvider: string | null,
  selectedId: string | null,
): { provider: string; name: string; models: ModelSummary[] }[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, { provider: string; name: string; models: ModelSummary[] }>();
  for (const model of models) {
    if (!model.available) continue;
    const current = model.provider === selectedProvider && model.id === selectedId;
    if (!current && hidden.includes(modelKey(model.provider, model.id))) continue;
    const haystack = `${model.providerName} ${model.name} ${model.id}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    const group = groups.get(model.provider) ?? { provider: model.provider, name: model.providerName, models: [] };
    group.models.push(model);
    groups.set(model.provider, group);
  }
  return [...groups.values()];
}

function providerStatus(provider: ProviderSummary): string {
  if (provider.stored) return tr("已登录", "Signed in");
  if (provider.authSource === "environment") return tr("环境变量", "Environment variable");
  if (provider.authSource === "models_json_key" || provider.authSource === "models_json_command") return tr("已保存密钥", "Saved API key");
  if (provider.authenticated) return tr("可用", "Available");
  return tr("未登录", "Not signed in");
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

const knownText: Record<string, [string, string]> = {
  "Select OpenAI Codex login method:": ["选择 Codex 登录方式", "Select a Codex sign-in method"],
  "Browser login (default)": ["浏览器登录", "Sign in with browser (default)"],
  "Device code login (headless)": ["设备码登录", "Sign in with device code (headless)"],
  "Complete login in your browser, or paste the authorization code / redirect URL here:": ["在浏览器完成登录，或把授权码 / 回调地址粘贴到这里", "Complete sign-in in your browser, or paste the authorization code / redirect URL here:"],
  "A browser window should open. Complete login to finish.": ["将打开浏览器。完成登录后会自动继续，也可以把回调地址粘贴到下面。", "A browser window should open. Complete sign-in to continue, or paste the redirect URL below."],
};

function translate(message: string): string {
  const known = knownText[message];
  if (known) return tr(known[0], known[1]);
  const enter = /^Enter (.+)$/.exec(message);
  if (enter?.[1]) return tr(`输入 ${enter[1]}`, `Enter ${enter[1]}`);
  return message;
}

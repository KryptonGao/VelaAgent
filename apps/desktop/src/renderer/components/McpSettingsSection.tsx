import type {
  McpCatalog,
  McpCatalogInput,
  McpServerSnapshot,
  McpToolInfo,
  McpServerTarget,
} from "@vela/shared";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AppLocale } from "../hooks/usePreferences";
import { settingsCopy, type SettingsCopy } from "./settings-copy";
import {
  credentialUpdate,
  McpFormError,
  parseMcpArgs,
  parseMcpImport,
  parseMcpJson,
  prepareMcpOverride,
  validateMcpConfig,
  type McpExposure,
  type McpFormConfig,
} from "./mcp-settings-model";

type McpCopy = SettingsCopy["mcp"];

function errorText(error: unknown, text: McpCopy): string {
  if (error instanceof McpFormError) {
    const field =
      text.fields[error.field as keyof typeof text.fields] ?? error.field;
    return `${field}: ${text.errors[error.reason]}`;
  }
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+':\s*(Error:\s*)?/i,
        "",
      )
    : text.failed;
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="mcp-field">
      <span>{label}</span>
      {children}
      {hint ? <span className="settings-hint">{hint}</span> : null}
    </label>
  );
}

function ServerForm({
  text,
  config,
  name,
  scope,
  cwd,
  editing,
  overriding,
  busy,
  onSave,
  onCancel,
}: {
  text: McpCopy;
  config?: McpFormConfig;
  name?: string;
  scope: "global" | "project";
  cwd: string;
  editing: boolean;
  overriding: boolean;
  busy: boolean;
  onSave: (
    name: string,
    scope: "global" | "project",
    config: McpFormConfig,
  ) => Promise<boolean>;
  onCancel: () => void;
}) {
  const id = useId();
  const [serverName, setName] = useState(name ?? "");
  const [targetScope, setScope] = useState(scope);
  const [transport, setTransport] = useState<"stdio" | "http">(
    config?.type === "stdio" || !config ? "stdio" : "http",
  );
  const [command, setCommand] = useState(config?.command ?? "");
  const [args, setArgs] = useState(JSON.stringify(config?.args ?? [], null, 2));
  const [processCwd, setProcessCwd] = useState(config?.cwd ?? "");
  const [url, setUrl] = useState(config?.url ?? "");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [oauth, setOauth] = useState(
    Boolean(
      config?.oauth ||
        (config?.auth as { provider?: string } | undefined)?.provider ===
          "oauth",
    ),
  );
  const [oauthOptions, setOauthOptions] = useState("");
  const [exposure, setExposure] = useState<McpExposure>(
    config?.exposure ?? "deferred",
  );
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [error, setError] = useState<unknown>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const invalidField = error instanceof McpFormError ? error.field : null;
  const secretHint = config ? text.credentialsHint : text.newCredentialsHint;

  async function submit(): Promise<void> {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(serverName.trim()))
        throw new McpFormError("name", "required");
      const base = { ...config };
      for (const key of [
        "type",
        "transport",
        "command",
        "args",
        "cwd",
        "env",
        "url",
        "headers",
        "oauth",
        "auth",
      ])
        delete base[key];
      const next = validateMcpConfig(
        transport === "stdio"
          ? {
              ...base,
              type: transport,
              command,
              args: parseMcpArgs(args),
              cwd: processCwd,
              env: credentialUpdate(env, "env") ?? config?.env,
              exposure,
              enabled,
            }
          : {
              ...base,
              type:
                config?.type === "streamable-http"
                  ? "streamable-http"
                  : transport,
              url,
              headers: credentialUpdate(headers, "headers") ?? config?.headers,
              ...(oauth
                ? {
                    ...(config?.auth ? { auth: config.auth } : {}),
                    oauth: oauthOptions.trim()
                      ? parseMcpJson(oauthOptions, "oauth")
                      : (config?.oauth ?? {}),
                  }
                : config?.auth &&
                    (config.auth as { provider?: string }).provider !== "oauth"
                  ? { auth: config.auth }
                  : {}),
              exposure,
              enabled,
            },
      );
      setError(null);
      await onSave(serverName.trim(), targetScope, next);
    } catch (caught) {
      setError(caught);
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }
  const invalid = (field: string) => ({
    "aria-invalid": invalidField === field || undefined,
    "aria-describedby": invalidField === field ? `${id}-error` : undefined,
  });

  return (
    <form
      className="settings-form mcp-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>{editing ? text.edit : overriding ? text.override : text.add}</h2>
      {overriding ? (
        <p className="settings-hint">{text.overrideCredentials}</p>
      ) : null}
      {error ? (
        <p
          ref={errorRef}
          id={`${id}-error`}
          role="alert"
          tabIndex={-1}
          className="settings-error"
        >
          {errorText(error, text)}
        </p>
      ) : null}
      <fieldset disabled={busy} className="mcp-fields">
        <div className="mcp-form-grid">
          <Field label={text.name}>
            <input
              autoFocus
              required
              value={serverName}
              disabled={editing}
              {...invalid("name")}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={text.scope}>
            <select
              value={targetScope}
              disabled={editing}
              onChange={(event) =>
                setScope(event.target.value as "global" | "project")
              }
            >
              <option value="global">{text.global}</option>
              <option value="project" disabled={!cwd}>
                {text.project}
              </option>
            </select>
          </Field>
        </div>
        <Field label={text.transport}>
          <select
            value={transport}
            onChange={(event) =>
              setTransport(event.target.value as "stdio" | "http")
            }
          >
            <option value="stdio">{text.stdio}</option>
            <option value="http">{text.http}</option>
          </select>
        </Field>
        {transport === "stdio" ? (
          <>
            <Field label={text.command}>
              <input
                required
                value={command}
                {...invalid("command")}
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field>
            <Field label={text.args}>
              <textarea
                className="settings-textarea mcp-code"
                value={args}
                spellCheck={false}
                {...invalid("args")}
                onChange={(event) => setArgs(event.target.value)}
              />
            </Field>
            <Field label={text.cwd}>
              <input
                value={processCwd}
                {...invalid("cwd")}
                onChange={(event) => setProcessCwd(event.target.value)}
              />
            </Field>
            <Field label={text.env} hint={secretHint}>
              <textarea
                className="settings-textarea mcp-code"
                value={env}
                placeholder={config?.env ? "••••••••" : "{}"}
                spellCheck={false}
                autoComplete="off"
                {...invalid("env")}
                onChange={(event) => setEnv(event.target.value)}
              />
            </Field>
            {config?.env && Object.keys(config.env).length ? (
              <p className="settings-hint">
                {text.credentialKeys}: {Object.keys(config.env).join(", ")}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <Field label={text.url}>
              <input
                required
                type="url"
                value={url}
                {...invalid("url")}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field label={text.headers} hint={secretHint}>
              <textarea
                className="settings-textarea mcp-code"
                value={headers}
                placeholder={config?.headers ? "••••••••" : "{}"}
                spellCheck={false}
                autoComplete="off"
                {...invalid("headers")}
                onChange={(event) => setHeaders(event.target.value)}
              />
            </Field>
            {config?.headers && Object.keys(config.headers).length ? (
              <p className="settings-hint">
                {text.credentialKeys}: {Object.keys(config.headers).join(", ")}
              </p>
            ) : null}
            <label className="mcp-check">
              <input
                type="checkbox"
                checked={oauth}
                onChange={(event) => setOauth(event.target.checked)}
              />
              {text.oauth}
            </label>
            {oauth ? (
              <Field label={text.oauthOptions} hint={text.oauthHint}>
                <textarea
                  className="settings-textarea mcp-code"
                  value={oauthOptions}
                  placeholder="{}"
                  autoComplete="off"
                  spellCheck={false}
                  {...invalid("oauth")}
                  onChange={(event) => setOauthOptions(event.target.value)}
                />
              </Field>
            ) : null}
          </>
        )}
        <Field label={text.exposure} hint={text.exposureHint}>
          <select
            value={exposure}
            onChange={(event) => setExposure(event.target.value as McpExposure)}
          >
            {(["deferred", "direct", "hidden"] as const).map((value) => (
              <option key={value} value={value}>
                {text[value]}
              </option>
            ))}
          </select>
        </Field>
        <label className="mcp-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {text.enabled}
        </label>
      </fieldset>
      <div className="settings-actions">
        <button
          type="submit"
          className="settings-secondary"
          disabled={busy || (targetScope === "project" && !cwd)}
        >
          {busy ? text.saving : text.save}
        </button>
        <button
          type="button"
          className="settings-secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {text.cancel}
        </button>
      </div>
    </form>
  );
}

export interface McpSettingsSectionProps {
  locale: AppLocale;
  workspacePath: string | null;
  conversationId?: string | null;
}

export function McpSettingsSection({
  locale,
  workspacePath,
  conversationId,
}: McpSettingsSectionProps) {
  const text = settingsCopy(locale).mcp;
  const [selected, setSelected] = useState<{
    id: string | null;
    cwd: string;
    requestedId: string | null | undefined;
    workspacePath: string | null;
  } | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const needsState = conversationId == null || !workspacePath;
  useEffect(() => {
    if (!needsState || !window.vela) return;
    let active = true;
    let receivedEvent = false;
    setSelectionError(null);
    const update = (
      state: Awaited<ReturnType<NonNullable<typeof window.vela>["getState"]>>,
    ) => {
      if (!active) return;
      setSelected({
        id: state.activeConversationId,
        cwd: state.session.cwd,
        requestedId: conversationId,
        workspacePath,
      });
      setSelectionError(null);
    };
    const off = window.vela.onEvent((event) => {
      if (event.type === "state") {
        receivedEvent = true;
        update(event.state);
      }
    });
    void window.vela.getState().then(
      (state) => {
        if (!receivedEvent) update(state);
      },
      (caught) => {
        if (active && !receivedEvent)
          setSelectionError(errorText(caught, text));
      },
    );
    return () => {
      active = false;
      off();
    };
  }, [conversationId, workspacePath, needsState, retry]);
  const resolved =
    selected &&
    selected.requestedId === conversationId &&
    selected.workspacePath === workspacePath
      ? selected
      : null;
  // null means no chat, so the state cwd is authoritative even if a stale project path is present.
  const cwd =
    conversationId == null
      ? (resolved?.cwd ?? "")
      : (workspacePath ?? resolved?.cwd ?? "");
  const id = conversationId === undefined ? resolved?.id : conversationId;
  if (!window.vela?.getMcpCatalog)
    return <p className="settings-note">{text.unavailable}</p>;
  if (needsState && !resolved) {
    return selectionError ? (
      <div className="settings-block">
        <p role="alert" className="settings-error">
          {selectionError}
        </p>
        <button
          type="button"
          className="settings-secondary"
          onClick={() => setRetry((value) => value + 1)}
        >
          {text.refresh}
        </button>
      </div>
    ) : (
      <p role="status" className="settings-note">
        {text.loading}
      </p>
    );
  }
  return (
    <McpSettingsContent
      key={`${cwd}\0${id ?? ""}`}
      locale={locale}
      cwd={cwd}
      conversationId={id ?? null}
    />
  );
}

function formConfig(
  server: McpServerSnapshot,
  overriding = false,
): McpFormConfig {
  const config = overriding
    ? prepareMcpOverride(server.config, server.secretFields)
    : server.config;
  return {
    ...config,
    type:
      config.type === "streamable-http"
        ? "streamable-http"
        : typeof config.url === "string"
          ? "http"
          : "stdio",
    enabled: server.enabled,
    exposure: ["deferred", "direct", "hidden"].includes(String(config.exposure))
      ? (config.exposure as McpExposure)
      : "deferred",
  };
}

function connectionLabel(server: McpServerSnapshot, text: McpCopy): string {
  if (!server.enabled) return text.disabled;
  if (!server.effective) return text.overridden;
  if (!server.trusted) return text.untrusted;
  if (server.authStatus === "authenticating") return text.loginPending;
  if (server.authStatus === "required") return text.statuses["auth-required"];
  return text.statuses[server.connectionStatus];
}

function endpoint(config: Record<string, unknown>): string {
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args)
      ? config.args.filter((item): item is string => typeof item === "string")
      : [];
    return [config.command, ...args.map((arg) => JSON.stringify(arg))].join(
      " ",
    );
  }
  return typeof config.url === "string" ? config.url : "";
}

function McpSettingsContent({
  locale,
  cwd,
  conversationId,
}: {
  locale: AppLocale;
  cwd: string;
  conversationId: string | null;
}) {
  const text = settingsCopy(locale).mcp;
  const api = window.vela;
  const input: McpCatalogInput = { cwd, conversationId };
  const [catalog, setCatalog] = useState<McpCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    server?: McpServerSnapshot;
    scope: "global" | "project";
    override?: boolean;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [readOnlyConfirm, setReadOnlyConfirm] = useState<McpToolInfo | null>(
    null,
  );
  const [importJson, setImportJson] = useState("");
  const [importScope, setImportScope] = useState<"global" | "project">(
    "global",
  );
  const [preview, setPreview] = useState<ReturnType<
    typeof parseMcpImport
  > | null>(null);
  const [importSelection, setImportSelection] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const alive = useRef(true);
  const sequence = useRef(0);
  const actionLock = useRef(false);
  const importErrorRef = useRef<HTMLParagraphElement>(null);

  const accepts = (next: McpCatalog) =>
    next.cwd === cwd && next.conversationId === conversationId;
  function apply(next: McpCatalog): void {
    if (alive.current && accepts(next)) {
      sequence.current++;
      setCatalog(next);
    }
  }
  async function refresh(): Promise<void> {
    if (!api?.getMcpCatalog) {
      setLoading(false);
      return;
    }
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = await api.getMcpCatalog(input);
      if (alive.current && request === sequence.current && accepts(next)) {
        setCatalog(next);
        setError(null);
      }
    } catch (caught) {
      if (alive.current && request === sequence.current)
        setError(errorText(caught, text));
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = api?.onMcpStatus
      ? api.onMcpStatus((event) => {
          if (event.cwd !== cwd || event.conversationId !== conversationId)
            return;
          if (event.catalog) apply(event.catalog);
          else void refresh();
        })
      : undefined;
    return () => {
      alive.current = false;
      sequence.current++;
      off?.();
    };
  }, [cwd, conversationId]);

  async function act(
    key: string,
    action: () => Promise<McpCatalog>,
  ): Promise<boolean> {
    if (actionLock.current) return false;
    actionLock.current = true;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (!alive.current) return false;
      apply(next);
      setNotice(text.saved);
      return true;
    } catch (caught) {
      if (alive.current) setError(errorText(caught, text));
      return false;
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(null);
    }
  }
  const target = (server: McpServerSnapshot): McpServerTarget => ({
    ...input,
    scope: server.scope,
    name: server.name,
  });
  const authTarget = target;
  const keyOf = (server: McpServerSnapshot) => `${server.scope}:${server.name}`;

  async function login(server: McpServerSnapshot): Promise<void> {
    if (!api || loginPending) return;
    setLoginPending(keyOf(server));
    setError(null);
    setNotice(null);
    try {
      apply(await api.loginMcpServer(authTarget(server)));
    } catch (caught) {
      if (alive.current) setError(errorText(caught, text));
    } finally {
      if (alive.current) setLoginPending(null);
    }
  }

  async function importSelected(): Promise<void> {
    if (!preview || !api) return;
    const selected = preview.filter((entry) =>
      importSelection.includes(entry.name),
    );
    let done = 0;
    await act("import", async () => {
      let next = catalog!;
      for (const entry of selected) {
        next = await api.saveMcpServer({
          ...input,
          scope: importScope,
          name: entry.name,
          config: entry.config,
        });
        done++;
        if (!alive.current) return next;
        apply(next);
        setImportSelection((current) =>
          current.filter((name) => name !== entry.name),
        );
        setNotice(text.importProgress(done, selected.length));
      }
      if (alive.current) {
        setPreview(null);
        setImportJson("");
      }
      return next;
    });
    if (alive.current && done)
      setNotice(text.importProgress(done, selected.length));
  }

  if (!api?.getMcpCatalog)
    return (
      <section className="settings-section">
        <h2>{text.title}</h2>
        <p className="settings-note">{text.unavailable}</p>
      </section>
    );
  const projectServers = catalog?.projectTrust.review ?? [];
  const unavailable = Boolean(busy || !catalog || !cwd);

  return (
    <section
      className="settings-section mcp-settings"
      aria-busy={Boolean(busy)}
    >
      <div className="settings-block">
        <h2>{text.title}</h2>
        <p className="settings-hint">{text.hint}</p>
        {cwd ? (
          <p className="settings-path">{cwd}</p>
        ) : (
          <p className="settings-note">{text.noWorkspace}</p>
        )}
        <div className="settings-actions">
          <button
            className="settings-secondary"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void refresh()}
          >
            {loading ? text.loading : text.refresh}
          </button>
          <button
            className="settings-secondary"
            type="button"
            disabled={unavailable}
            onClick={() => setEditor({ scope: "global" })}
          >
            {text.add}
          </button>
        </div>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      <div role="status" aria-live="polite">
        {notice ? <p className="settings-saved">{notice}</p> : null}
        {catalog?.pendingApply ? (
          <p className="settings-note">{text.pendingApply}</p>
        ) : null}
      </div>
      {catalog?.errors.map((message, index) => (
        <p className="settings-error" role="alert" key={`${index}:${message}`}>
          {message}
        </p>
      ))}
      {catalog &&
      (projectServers.length > 0 || catalog.projectTrust.trusted) ? (
        <div className="settings-block mcp-trust">
          <h2>{text.trustTitle}</h2>
          <p className="settings-hint">{text.trustHint}</p>
          <p className="settings-path">{catalog.projectTrust.path}</p>
          <p className="settings-note">
            {catalog.projectTrust.trusted ? text.trusted : text.untrusted}
          </p>
          {projectServers.map((server) => (
            <div key={server.name}>
              <strong>{server.name}</strong>
              <pre className="settings-path">{endpoint(server.config)}</pre>
              {typeof server.config.cwd === "string" ? (
                <p className="settings-path">{server.config.cwd}</p>
              ) : null}
              <details>
                <summary>{text.reviewConfig}</summary>
                <pre className="settings-path">
                  {JSON.stringify(server.config, null, 2)}
                </pre>
              </details>
            </div>
          ))}
          <p className="settings-hint">{text.trustChanged}</p>
          <button
            className="settings-secondary"
            type="button"
            disabled={unavailable || !catalog.projectTrust.digest}
            onClick={() =>
              void act("trust", () =>
                api.setMcpProjectTrust({
                  cwd,
                  trusted: !catalog.projectTrust.trusted,
                  digest: catalog.projectTrust.digest,
                }),
              )
            }
          >
            {catalog.projectTrust.trusted ? text.revokeTrust : text.trust}
          </button>
        </div>
      ) : null}
      {!loading && catalog?.servers.length === 0 ? (
        <p className="settings-note">{text.empty}</p>
      ) : null}
      <div className="settings-stack">
        {catalog?.servers.filter(server => !server.pluginId).map((server) => {
          const key = keyOf(server);
          const authBusy =
            server.authStatus === "authenticating" || loginPending === key;
          return (
            <article className="mcp-server" key={key} aria-label={server.name}>
              <div className="mcp-server-header">
                <h3>{server.name}</h3>
                <span
                  className={
                    server.connectionStatus === "connected" &&
                    server.enabled &&
                    server.effective &&
                    server.trusted &&
                    server.authStatus !== "required" &&
                    server.authStatus !== "authenticating"
                      ? "settings-saved"
                      : "settings-note"
                  }
                >
                  {connectionLabel(server, text)}
                </span>
              </div>
              <div className="mcp-server-meta">
                <span>
                  {server.scope === "global" ? text.global : text.project}
                </span>
                <span>
                  {text.source}:{" "}
                  {server.scope === "project"
                    ? catalog.projectTrust.path
                    : text.global}
                </span>
                <span>
                  {text[server.config.exposure as McpExposure] ?? text.deferred}
                </span>
              </div>
              {endpoint(server.config) ? (
                <pre className="settings-path">{endpoint(server.config)}</pre>
              ) : null}
              {server.error ? (
                <p className="settings-error" role="alert">
                  {server.error}
                </p>
              ) : null}
              <div className="settings-actions">
                <button
                  className="settings-secondary"
                  type="button"
                  disabled={Boolean(busy || authBusy)}
                  onClick={() => setEditor({ server, scope: server.scope })}
                >
                  {text.edit}
                </button>
                {server.scope === "global" && cwd ? (
                  <button
                    className="settings-secondary"
                    type="button"
                    disabled={Boolean(busy || authBusy)}
                    onClick={() =>
                      setEditor({ server, scope: "project", override: true })
                    }
                  >
                    {text.override}
                  </button>
                ) : null}
                <button
                  className="settings-secondary"
                  type="button"
                  disabled={Boolean(busy || authBusy)}
                  onClick={() =>
                    void act(key, () =>
                      api.setMcpEnabled({
                        ...target(server),
                        enabled: !server.enabled,
                      }),
                    )
                  }
                >
                  {server.enabled ? text.disable : text.enable}
                </button>
                {api.reconnectMcpServer ? (
                  <button
                    className="settings-secondary"
                    type="button"
                    disabled={Boolean(
                      busy ||
                        authBusy ||
                        !server.enabled ||
                        !server.effective ||
                        !server.trusted,
                    )}
                    onClick={() =>
                      void act(key, () =>
                        api.reconnectMcpServer!(target(server)),
                      )
                    }
                  >
                    {text.reconnect}
                  </button>
                ) : null}
                {typeof server.config.url === "string" &&
                server.effective &&
                server.trusted &&
                server.configDigest ? (
                  <>
                    {authBusy ? (
                      <button
                        className="settings-secondary"
                        type="button"
                        disabled={Boolean(busy || !api.cancelMcpLogin)}
                        onClick={() =>
                          void act(key, () =>
                            api.cancelMcpLogin!(target(server)),
                          )
                        }
                      >
                        {text.cancelLogin}
                      </button>
                    ) : server.authStatus === "authenticated" ? (
                      <button
                        className="settings-secondary"
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void act(key, () =>
                            api.logoutMcpServer(authTarget(server)),
                          )
                        }
                      >
                        {text.logout}
                      </button>
                    ) : (
                      <button
                        className="settings-secondary"
                        type="button"
                        disabled={Boolean(
                          busy || loginPending || !server.enabled,
                        )}
                        onClick={() => void login(server)}
                      >
                        {server.authStatus === "error"
                          ? text.retryLogin
                          : text.login}
                      </button>
                    )}
                  </>
                ) : null}
                <button
                  className="settings-secondary settings-danger"
                  type="button"
                  disabled={Boolean(busy || authBusy)}
                  onClick={() => setRemoving(key)}
                >
                  {text.remove}
                </button>
              </div>
              {removing === key ? (
                <div
                  className="mcp-confirm"
                  role="group"
                  aria-label={text.confirmRemove}
                >
                  <p>{text.removeConfirm}</p>
                  <div className="settings-actions">
                    <button
                      className="settings-secondary settings-danger"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void act(key, () =>
                          api.removeMcpServer(target(server)),
                        ).then((ok) => {
                          if (ok) setRemoving(null);
                        })
                      }
                    >
                      {text.confirmRemove}
                    </button>
                    <button
                      className="settings-secondary"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => setRemoving(null)}
                    >
                      {text.cancel}
                    </button>
                  </div>
                </div>
              ) : null}
              <details>
                <summary>
                  {text.tools} ({server.tools.length})
                </summary>
                <div className="mcp-tools">
                  {server.tools.length === 0 ? (
                    <p className="settings-note">{text.toolsEmpty}</p>
                  ) : (
                    server.tools.map((tool) => (
                      <div className="mcp-tool" key={tool.name}>
                        <span className="mcp-tool-name">{tool.name}</span>
                        {tool.description ? (
                          <p className="settings-hint">{tool.description}</p>
                        ) : null}
                        {tool.annotations?.readOnlyHint ? (
                          <p className="settings-note">{text.serverReadOnly}</p>
                        ) : null}
                        {tool.inputSchema ? (
                          <details>
                            <summary>{text.schema}</summary>
                            <pre className="settings-path">
                              {JSON.stringify(tool.inputSchema, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                        <div className="settings-actions">
                          <span className="settings-note">
                            {tool.readOnly
                              ? text.userReadOnly
                              : text.readOnlyHint}
                          </span>
                          <button
                            className="settings-secondary"
                            type="button"
                            disabled={Boolean(
                              busy || !server.effective || !server.trusted,
                            )}
                            onClick={() =>
                              tool.readOnly
                                ? void act(`${key}:${tool.name}`, () =>
                                    api.setMcpToolReadOnly({
                                      ...input,
                                      server: tool.server,
                                      tool: tool.name,
                                      readOnly: false,
                                      configDigest: tool.configDigest,
                                      toolDigest: tool.toolDigest,
                                    }),
                                  )
                                : setReadOnlyConfirm(tool)
                            }
                          >
                            {tool.readOnly ? text.clearReadOnly : text.readOnly}
                          </button>
                        </div>
                        {readOnlyConfirm?.server === tool.server &&
                        readOnlyConfirm.name === tool.name &&
                        readOnlyConfirm.configDigest === tool.configDigest &&
                        readOnlyConfirm.toolDigest === tool.toolDigest ? (
                          <div className="mcp-confirm">
                            <p>{text.readOnlyHint}</p>
                            <div className="settings-actions">
                              <button
                                className="settings-secondary"
                                type="button"
                                disabled={Boolean(busy)}
                                onClick={() =>
                                  void act(`${key}:${tool.name}`, () =>
                                    api.setMcpToolReadOnly({
                                      ...input,
                                      server: readOnlyConfirm.server,
                                      tool: readOnlyConfirm.name,
                                      readOnly: true,
                                      configDigest:
                                        readOnlyConfirm.configDigest,
                                      toolDigest: readOnlyConfirm.toolDigest,
                                    }),
                                  ).then((ok) => {
                                    if (ok) setReadOnlyConfirm(null);
                                  })
                                }
                              >
                                {text.confirmReadOnly}
                              </button>
                              <button
                                className="settings-secondary"
                                type="button"
                                disabled={Boolean(busy)}
                                onClick={() => setReadOnlyConfirm(null)}
                              >
                                {text.cancel}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </details>
            </article>
          );
        })}
      </div>
      {editor ? (
        <ServerForm
          key={`${editor.scope}:${editor.server?.name ?? "new"}:${editor.override ?? false}`}
          text={text}
          config={
            editor.server
              ? formConfig(editor.server, editor.override)
              : undefined
          }
          name={editor.server?.name}
          scope={editor.scope}
          cwd={cwd}
          editing={Boolean(editor.server && !editor.override)}
          overriding={Boolean(editor.override)}
          busy={Boolean(busy)}
          onCancel={() => setEditor(null)}
          onSave={async (name, scope, config) => {
            const ok = await act("save", () =>
              api.saveMcpServer({ ...input, scope, name, config }),
            );
            if (ok) setEditor(null);
            return ok;
          }}
        />
      ) : null}
      <details className="settings-block">
        <summary>{text.importTitle}</summary>
        <p className="settings-hint">{text.importHint}</p>
        <div className="settings-form">
          {importError ? (
            <p
              ref={importErrorRef}
              tabIndex={-1}
              className="settings-error"
              role="alert"
            >
              {importError}
            </p>
          ) : null}
          <Field label={text.scope}>
            <select
              value={importScope}
              disabled={Boolean(busy)}
              onChange={(event) =>
                setImportScope(event.target.value as "global" | "project")
              }
            >
              <option value="global">{text.global}</option>
              <option value="project" disabled={!cwd}>
                {text.project}
              </option>
            </select>
          </Field>
          <Field label={text.importTitle}>
            <textarea
              className="settings-textarea mcp-code"
              value={importJson}
              disabled={Boolean(busy)}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setImportJson(event.target.value);
                setPreview(null);
                setImportError(null);
              }}
            />
          </Field>
          <button
            className="settings-secondary"
            type="button"
            disabled={unavailable || !importJson.trim()}
            onClick={() => {
              try {
                const next = parseMcpImport(importJson);
                setPreview(next);
                setImportSelection(next.map((entry) => entry.name));
                setImportError(null);
              } catch (caught) {
                setPreview(null);
                setImportError(errorText(caught, text));
                requestAnimationFrame(() => importErrorRef.current?.focus());
              }
            }}
          >
            {text.preview}
          </button>
          {preview ? (
            <div className="settings-stack">
              {preview.map((entry) => (
                <label className="mcp-check" key={entry.name}>
                  <input
                    type="checkbox"
                    checked={importSelection.includes(entry.name)}
                    disabled={Boolean(busy)}
                    onChange={(event) =>
                      setImportSelection((current) =>
                        event.target.checked
                          ? [...current, entry.name]
                          : current.filter((name) => name !== entry.name),
                      )
                    }
                  />
                  <span>
                    {entry.name} ·{" "}
                    {entry.config.type === "stdio" ? text.stdio : text.http} ·{" "}
                    {text[entry.config.exposure]}
                  </span>
                </label>
              ))}
              <button
                className="settings-secondary"
                type="button"
                disabled={
                  unavailable ||
                  importSelection.length === 0 ||
                  (importScope === "project" && !cwd)
                }
                onClick={() => void importSelected()}
              >
                {busy === "import" ? text.saving : text.importSave}
              </button>
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}

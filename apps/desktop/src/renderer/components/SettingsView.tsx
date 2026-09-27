import {
  customModelApis,
  thinkingLevels,
  type AgentSettings,
  type AuthMethodType,
  type ConversationSummary,
  type CustomModelApi,
  type CustomModelInput,
  type ExecutionEnvironmentKind,
  type ModelCatalog,
  type ProviderSummary,
  type SandboxMode,
  type SelectableEnvironmentKind,
  type SkillCatalog,
  type SkillMigrationResult,
  type ThinkingLevel,
} from "@vela/shared";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { useModels } from "../hooks/useModels";
import type { Appearance, AppLocale, PreferencesApi } from "../hooks/usePreferences";
import type { ProjectApi } from "../hooks/useProject";
import { modKeyLabel } from "../platform";
import { darkThemes, lightThemes, type ColorScheme, type DarkTheme, type LightTheme, type ThemeId } from "../themes";
import { LoginDialog } from "./ModelControls";
import { SheetPresence } from "./Presence";
import { SkillMigrationDialog } from "./SkillMigrationDialog";
import { settingsCopy, type SettingsCopy } from "./settings-copy";
import { localizeError, tr } from "../locale";

type SettingsSection = "agent" | "archived" | "models" | "permissions" | "workspace" | "appearance";
type ModelsApi = ReturnType<typeof useModels>;

interface SettingsViewProps {
  preferences: PreferencesApi;
  platform: string;
  models: ModelsApi;
  project: ProjectApi;
  conversations: ConversationSummary[];
  onUnarchiveConversation: (id: string) => void;
  onClose: () => void;
}

const sections: SettingsSection[] = ["agent", "archived", "models", "permissions", "workspace", "appearance"];

export function SettingsView({
  preferences,
  platform,
  models,
  project,
  conversations,
  onUnarchiveConversation,
  onClose,
}: SettingsViewProps) {
  const { locale } = preferences;
  const copy = settingsCopy(locale);
  const [section, setSection] = useState<SettingsSection>("agent");
  const mod = modKeyLabel(platform);

  return (
    <main className="settings-view">
      <header className="settings-header">
        <h1>{copy.title}</h1>
        <button className="settings-done" type="button" onClick={onClose}>
          {copy.done}
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={copy.title}>
          {sections.map((id) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-item${section === id ? " active" : ""}`}
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {copy.nav[id]}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <div hidden={section !== "agent"}>
            <AgentSection copy={copy} catalog={models.catalog} workspacePath={project.workspace?.current ?? null} />
          </div>
          <div hidden={section !== "archived"}>
            <ArchivedSection
              copy={copy}
              locale={locale}
              conversations={conversations}
              onUnarchive={onUnarchiveConversation}
            />
          </div>
          <div hidden={section !== "models"}>
            <ModelsSection copy={copy} models={models} />
          </div>
          <div hidden={section !== "permissions"}>
            <PermissionsSection copy={copy} project={project} />
          </div>
          <div hidden={section !== "workspace"}>
            <WorkspaceSection copy={copy} project={project} />
          </div>
          <div hidden={section !== "appearance"}>
            <AppearanceSection copy={copy} preferences={preferences} mod={mod} />
          </div>
        </div>
      </div>
      <SheetPresence present={models.login.active}>
        <LoginDialog
          login={models.login}
          onReply={models.replyLogin}
          onCancel={models.cancelLogin}
          onDismiss={models.dismissLogin}
        />
      </SheetPresence>
    </main>
  );
}

function AgentSection({
  copy,
  catalog,
  workspacePath,
}: {
  copy: SettingsCopy;
  catalog: ModelCatalog | null;
  workspacePath: string | null;
}) {
  const text = copy.agent;
  const [saved, setSaved] = useState<AgentSettings | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.vela;
    if (!api) return;
    let active = true;
    void api.getAgentSettings().then(
      (settings) => {
        if (!active) return;
        setSaved(settings);
        setDraft(settings);
        setError(null);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : text.loadError);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const choices = useMemo(
    () => levelsFor(catalog, draft?.provider ?? null, draft?.modelId ?? null),
    [catalog, draft?.provider, draft?.modelId],
  );
  const thinking = draft ? clampChoice(choices, draft.thinkingLevel) : "medium";
  const dirty = Boolean(draft && saved && !sameSettings(draft, saved, thinking));
  const groups = useMemo(() => groupAvailable(catalog), [catalog]);
  const selectedMissing = Boolean(
    draft?.provider &&
      draft.modelId &&
      !catalog?.models.some((model) => model.provider === draft.provider && model.id === draft.modelId && model.available),
  );

  async function save(): Promise<void> {
    const api = window.vela;
    if (!api || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveAgentSettings({ ...draft, thinkingLevel: thinking });
      setSaved(next);
      setDraft(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : text.loadError);
    } finally {
      setSaving(false);
    }
  }

  function restore(): void {
    setDraft((current) => {
      if (!current) return current;
      const nextChoices = levelsFor(catalog, current.provider, current.modelId);
      return { ...current, thinkingLevel: clampChoice(nextChoices, "medium"), instructions: "" };
    });
    setError(null);
  }

  const restored =
    draft !== null &&
    draft.instructions.trim() === "" &&
    thinking === clampChoice(choices, "medium");

  return (
    <section className="settings-section">
      <SettingsBlock title={text.model} hint={text.modelHint}>
        {groups.length === 0 && !selectedMissing ? <p className="settings-note">{text.modelMissing}</p> : null}
        <select
          className="settings-select"
          value={draft?.provider && draft.modelId ? modelValue(draft.provider, draft.modelId) : ""}
          disabled={!draft}
          onChange={(event) => {
            const parsed = parseModelValue(event.target.value);
            setDraft((current) => (current ? { ...current, provider: parsed.provider, modelId: parsed.modelId } : current));
          }}
        >
          <option value="">{text.modelEmpty}</option>
          {selectedMissing && draft?.provider && draft.modelId ? (
            <option value={modelValue(draft.provider, draft.modelId)}>{text.modelUnavailable}</option>
          ) : null}
          {groups.map((group) => (
            <optgroup key={group.provider} label={group.name}>
              {group.models.map((model) => (
                <option key={modelValue(model.provider, model.id)} value={modelValue(model.provider, model.id)}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </SettingsBlock>

      <SettingsBlock title={text.thinking} hint={text.thinkingHint}>
        <div className="settings-choice-row" role="radiogroup" aria-label={text.thinking}>
          {choices.map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={level === thinking}
              className={`settings-choice${level === thinking ? " active" : ""}`}
              disabled={!draft}
              onClick={() => setDraft((current) => (current ? { ...current, thinkingLevel: level } : current))}
            >
              {text.levels[level]}
            </button>
          ))}
        </div>
      </SettingsBlock>

      <SettingsBlock title={text.instructions} hint={text.instructionsHint}>
        <textarea
          className="settings-textarea"
          value={draft?.instructions ?? ""}
          maxLength={4000}
          placeholder={text.instructionsPlaceholder}
          disabled={!draft}
          onChange={(event) => setDraft((current) => (current ? { ...current, instructions: event.target.value } : current))}
        />
      </SettingsBlock>

      <div className="settings-actions">
        <button className="settings-secondary" type="button" disabled={!draft || restored} onClick={restore}>
          {text.restore}
        </button>
        <button className="primary-btn" type="button" disabled={!draft || !dirty || saving} onClick={() => void save()}>
          {saving ? text.saving : text.save}
        </button>
        {!dirty && saved && !saving && !error ? <span className="settings-saved">{text.saved}</span> : null}
        {error ? <span className="settings-error">{error}</span> : null}
      </div>
      <SkillsBlock copy={copy} workspacePath={workspacePath} />
    </section>
  );
}

/** 已归档对话:搜索、取消归档。列表数据来自 AppState.conversations 的归档子集。 */
function ArchivedSection({
  copy,
  locale,
  conversations,
  onUnarchive,
}: {
  copy: SettingsCopy;
  locale: AppLocale;
  conversations: ConversationSummary[];
  onUnarchive: (id: string) => void;
}) {
  const text = copy.archived;
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const archived = useMemo(
    () =>
      conversations
        .filter((conversation) => conversation.archivedAt !== null)
        .sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt)),
    [conversations],
  );

  const keyword = query.trim().toLowerCase();
  const matches = keyword
    ? archived.filter((conversation) =>
        `${conversation.title}\n${workspaceName(conversation.cwd)}`.toLowerCase().includes(keyword),
      )
    : archived;

  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { dateStyle: "medium" }),
    [locale],
  );

  function unarchive(conversation: ConversationSummary): void {
    setNotice(`${conversation.title || tr("新对话", "New chat")} · ${text.unarchived}`);
    onUnarchive(conversation.id);
  }

  return (
    <section className="settings-section">
      <SettingsBlock title={text.title} hint={text.hint}>
        <input
          className="settings-input"
          type="search"
          value={query}
          placeholder={text.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
        {archived.length === 0 ? <p className="settings-note">{text.empty}</p> : null}
        {archived.length > 0 && matches.length === 0 ? <p className="settings-note">{text.searchEmpty}</p> : null}
        <div className="settings-stack">
          {matches.map((conversation) => (
            <div className="settings-recent" key={conversation.id}>
              <div className="settings-recent-main" title={conversation.cwd}>
                <span className="settings-recent-name">{conversation.title || tr("新对话", "New chat")}</span>
                <span className="settings-recent-path">
                  {`${workspaceName(conversation.cwd)} · ${formatter.format(conversation.archivedAt ?? conversation.updatedAt)}`}
                </span>
              </div>
              <button
                className="settings-secondary"
                type="button"
                onClick={() => unarchive(conversation)}
              >
                {text.unarchive}
              </button>
            </div>
          ))}
        </div>
        {notice ? <p className="settings-saved">{notice}</p> : null}
      </SettingsBlock>
    </section>
  );
}

function workspaceName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return name || cwd;
}

function SkillsBlock({ copy, workspacePath }: { copy: SettingsCopy; workspacePath: string | null }) {
  const text = copy.agent;
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationNotice, setMigrationNotice] = useState<string | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.vela;
    if (!api) return;
    let active = true;
    void api.listSkills().then(
      (next) => {
        if (!active) return;
        setCatalog(next);
        setError(null);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : text.skillsLoadError);
      },
    );
    return () => {
      active = false;
    };
  }, [workspacePath, text.skillsLoadError, refreshKey]);

  async function openDir(): Promise<void> {
    try {
      await window.vela?.openSkillsDirectory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : text.skillsLoadError);
    }
  }

  function finishMigration(result: SkillMigrationResult): void {
    const count = result.copied.length + result.replaced.length;
    setMigrationOpen(false);
    setMigrationNotice(count > 0 ? text.migrateDone(count) : text.migrateNone);
    setMigrationError(result.skipped.length > 0
      ? result.skipped.map((item) => `${item.name}: ${item.message ?? text.migrateSkip[item.reason]}`).join(" ")
      : null);
    setRefreshKey((current) => current + 1);
  }

  return (
    <SettingsBlock title={text.skills} hint={text.skillsHint}>
      {catalog ? <div className="settings-path">{catalog.skillsDir}</div> : null}
      <div className="settings-actions">
        <button className="settings-secondary" type="button" onClick={() => void openDir()}>
          {text.openSkills}
        </button>
        <button
          className="settings-secondary"
          type="button"
          onClick={() => {
            setMigrationNotice(null);
            setMigrationError(null);
            setMigrationOpen(true);
          }}
        >
          {text.migrate}
        </button>
        {migrationNotice ? <span className="settings-saved">{migrationNotice}</span> : null}
      </div>
      {migrationError ? <p className="settings-error">{migrationError}</p> : null}
      <SheetPresence present={migrationOpen}>
        <SkillMigrationDialog copy={text} onClose={() => setMigrationOpen(false)} onDone={finishMigration} />
      </SheetPresence>
      {catalog && catalog.skills.length === 0 ? <p className="settings-note">{text.skillsEmpty}</p> : null}
      {catalog && catalog.skills.length > 0 ? (
        <div className="settings-stack">
          {catalog.skills.map((skill) => (
            <SkillRow key={skill.location} skill={skill} originLabel={text.skillOrigins[skill.origin]} commandOnly={text.skillCommandOnly} />
          ))}
        </div>
      ) : null}
      {catalog && catalog.diagnostics.length > 0 ? (
        <div className="settings-stack">
          {catalog.diagnostics.map((item) => (
            <p key={`${item.type}:${item.path ?? ""}:${item.message}`} className="settings-error">
              {item.message}
              {item.path ? ` (${item.path})` : ""}
            </p>
          ))}
        </div>
      ) : null}
      {error ? <p className="settings-error">{error}</p> : null}
    </SettingsBlock>
  );
}

function SkillRow({
  skill,
  originLabel,
  commandOnly,
}: {
  skill: SkillCatalog["skills"][number];
  originLabel: string;
  commandOnly: string;
}) {
  return (
    <div className="settings-skill">
      <span className="settings-radio-title">{skill.name}</span>
      <span className="settings-radio-hint">{skill.description}</span>
      <span className="settings-skill-meta">
        <span>{originLabel}</span>
        {skill.disableModelInvocation ? <span>{commandOnly}</span> : null}
      </span>
    </div>
  );
}

function ModelsSection({ copy, models }: { copy: SettingsCopy; models: ModelsApi }) {
  const text = copy.models;
  const catalog = models.catalog;
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [form, setForm] = useState<CustomModelInput>(emptyModel);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState(false);

  const providers = catalog?.providers ?? [];

  async function removeProvider(provider: ProviderSummary): Promise<void> {
    const custom = (catalog?.models ?? []).filter((model) => model.provider === provider.id && model.custom);
    for (const model of custom) {
      const message = await models.remove(model.provider, model.id);
      if (typeof message === "string" && message) return;
    }
    setPendingRemove(null);
  }

  return (
    <section className="settings-section">
      <SettingsBlock title={text.connected}>
        {models.catalogError ? <p className="settings-error">{localizeError(models.catalogError)}</p> : null}
        {models.actionError ? <p className="settings-error">{localizeError(models.actionError)}</p> : null}
        {catalog?.error ? <p className="settings-error">{catalog.error}</p> : null}
        {providers.length === 0 ? <p className="settings-note">{text.empty}</p> : null}
        <div className="settings-stack">
          {providers.map((provider) => {
            const available = (catalog?.models ?? []).filter((model) => model.provider === provider.id && model.available).length;
            const connected = provider.authenticated || provider.stored;
            return (
              <article className="settings-provider" key={provider.id}>
                <div className="settings-provider-copy">
                  <div className="settings-provider-name">{provider.name}</div>
                  <div className="settings-provider-meta">
                    <span className={connected ? "settings-status connected" : "settings-status"}>
                      {connected ? text.connectedStatus : text.disconnectedStatus}
                    </span>
                    <span>{text.modelCount(available)}</span>
                  </div>
                </div>
                <div className="settings-provider-actions">
                  {provider.methods.map((method) => (
                    <button
                      key={method.type}
                      className="settings-secondary"
                      type="button"
                      onClick={() => void models.loginProvider(provider.id, method.type as AuthMethodType)}
                    >
                      {method.type === "oauth" ? text.login : text.apiKey}
                    </button>
                  ))}
                  {provider.stored ? (
                    <button className="settings-secondary" type="button" onClick={() => void models.logout(provider.id)}>
                      {text.logout}
                    </button>
                  ) : null}
                  {provider.custom ? (
                    <button
                      className="settings-secondary settings-danger"
                      type="button"
                      onClick={() => {
                        if (pendingRemove !== provider.id) {
                          setPendingRemove(provider.id);
                          return;
                        }
                        void removeProvider(provider);
                      }}
                    >
                      {pendingRemove === provider.id ? text.confirmRemove : text.remove}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </SettingsBlock>

      <SettingsBlock title={text.add}>
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            const providerId = providerIdFromName(form.providerName);
            if (!providerId) {
              setFormError(text.providerInvalid);
              setAdded(false);
              return;
            }
            setSaving(true);
            setFormError(null);
            setAdded(false);
            void models.register({ ...form, providerId, providerName: form.providerName.trim() }).then((message) => {
              setSaving(false);
              if (typeof message === "string" && message) {
                setFormError(message);
                return;
              }
              setAdded(true);
              setForm((current) => ({
                ...current,
                apiKey: "",
                modelId: "",
                modelName: "",
                reasoning: false,
                contextWindow: null,
                maxTokens: null,
              }));
            });
          }}
        >
          <Field label={text.providerName}>
            <input
              value={form.providerName}
              placeholder={text.providerPlaceholder}
              onChange={(event) => setForm({ ...form, providerName: event.target.value })}
            />
          </Field>
          <Field label={text.baseUrl}>
            <input
              value={form.baseUrl}
              placeholder={text.baseUrlPlaceholder}
              spellCheck={false}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            />
          </Field>
          <Field label={text.api}>
            <select value={form.api} onChange={(event) => setForm({ ...form, api: event.target.value as CustomModelApi })}>
              {customModelApis.map((api) => (
                <option key={api} value={api}>{text.apis[api]}</option>
              ))}
            </select>
          </Field>
          <Field label={text.apiKeyField}>
            <input
              type="password"
              value={form.apiKey}
              placeholder={text.apiKeyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            />
          </Field>
          <Field label={text.modelId}>
            <input
              value={form.modelId}
              placeholder={text.modelIdPlaceholder}
              spellCheck={false}
              onChange={(event) => setForm({ ...form, modelId: event.target.value })}
            />
          </Field>
          <Field label={text.displayName}>
            <input
              value={form.modelName}
              placeholder={text.displayNamePlaceholder}
              onChange={(event) => setForm({ ...form, modelName: event.target.value })}
            />
          </Field>
          <div className="settings-optional">
            <div className="settings-kicker">{text.optional}</div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.reasoning}
                onChange={(event) => setForm({ ...form, reasoning: event.target.checked })}
              />
              <span>{text.reasoning}</span>
            </label>
            <Field label={text.context}>
              <input
                inputMode="numeric"
                value={form.contextWindow ?? ""}
                placeholder={text.optionalPlaceholder}
                onChange={(event) => setForm({ ...form, contextWindow: event.target.value ? Number(event.target.value) : null })}
              />
            </Field>
            <Field label={text.maxOutput}>
              <input
                inputMode="numeric"
                value={form.maxTokens ?? ""}
                placeholder={text.optionalPlaceholder}
                onChange={(event) => setForm({ ...form, maxTokens: event.target.value ? Number(event.target.value) : null })}
              />
            </Field>
          </div>
          {formError ? <p className="settings-error">{formError}</p> : null}
          {added ? <p className="settings-saved">{text.added}</p> : null}
          <div className="settings-actions">
            <button className="primary-btn" type="submit" disabled={saving}>
              {saving ? text.submitting : text.submit}
            </button>
          </div>
          <p className="settings-note">{text.keyHint}</p>
        </form>
      </SettingsBlock>
    </section>
  );
}

function PermissionsSection({ copy, project }: { copy: SettingsCopy; project: ProjectApi }) {
  const text = copy.permissions;
  const mode = project.sandboxMode;
  const options: { id: SandboxMode; title: string; hint: string }[] = [
    { id: "ask", title: text.ask, hint: text.askHint },
    { id: "full", title: text.full, hint: text.fullHint },
  ];

  return (
    <section className="settings-section">
      <div className="settings-stack" role="radiogroup" aria-label={copy.nav.permissions}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={mode === option.id}
            className={`settings-radio${mode === option.id ? " active" : ""}`}
            onClick={() => void project.setSandboxMode(option.id)}
          >
            <span className="settings-radio-title">{option.title}</span>
            <span className="settings-radio-hint">{option.hint}</span>
          </button>
        ))}
      </div>
      <p className="settings-note">{text.note}</p>
      {project.error ? <p className="settings-error">{localizeError(project.error)}</p> : null}
    </section>
  );
}

function WorkspaceSection({ copy, project }: { copy: SettingsCopy; project: ProjectApi }) {
  const text = copy.workspace;
  const current = project.workspace?.current ?? null;
  const recents = project.workspace?.recents ?? [];
  const [pending, setPending] = useState<SelectableEnvironmentKind | null>(null);
  const activeKind = project.environment?.kind ?? "local";

  async function switchEnvironment(kind: SelectableEnvironmentKind): Promise<void> {
    if (pending || kind === activeKind) return;
    setPending(kind);
    try {
      await project.setEnvironment(kind);
    } finally {
      setPending(null);
    }
  }

  const environments: {
    kind: ExecutionEnvironmentKind;
    title: string;
    hint: string;
    selectable: boolean;
  }[] = [
    { kind: "local", title: text.local, hint: text.localHint, selectable: true },
    { kind: "worktree", title: text.worktree, hint: text.worktreeHint, selectable: true },
    { kind: "sandbox", title: text.sandbox, hint: text.soon, selectable: false },
    { kind: "remote", title: text.remote, hint: text.soon, selectable: false },
  ];

  return (
    <section className="settings-section">
      <SettingsBlock title={text.current}>
        <div className="settings-path" title={current ?? undefined}>
          {current ?? text.empty}
        </div>
        <div className="settings-actions">
          <button className="settings-secondary" type="button" onClick={() => void project.openWorkspaceDialog()}>
            {text.choose}
          </button>
          <button className="settings-secondary" type="button" disabled={!current} onClick={() => void project.closeWorkspace()}>
            {text.close}
          </button>
        </div>
      </SettingsBlock>

      <SettingsBlock title={text.recent}>
        {recents.length === 0 ? <p className="settings-note">{text.recentEmpty}</p> : null}
        <div className="settings-stack">
          {recents.map((recent) => (
            <div className={`settings-recent${recent.path === current ? " active" : ""}`} key={recent.path}>
              <button
                type="button"
                className="settings-recent-main"
                title={recent.path}
                onClick={() => {
                  if (recent.path !== current) void project.selectRecentWorkspace(recent.path);
                }}
              >
                <span className="settings-recent-name">{recent.name}</span>
                <span className="settings-recent-path">{recent.path}</span>
              </button>
              <button
                type="button"
                className="settings-recent-remove"
                aria-label={text.removeRecent}
                title={text.removeRecent}
                onClick={() => void project.removeRecentWorkspace(recent.path)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </SettingsBlock>

      <SettingsBlock title={text.environment}>
        <div className="settings-stack">
          {environments.map((environment) => {
            const active = environment.kind === activeKind;
            const path = project.environments.find((entry) => entry.kind === environment.kind)?.path;
            if (!environment.selectable) {
              return (
                <div className="settings-radio disabled" key={environment.kind}>
                  <span className="settings-radio-title">{environment.title}</span>
                  <span className="settings-radio-hint">{environment.hint}</span>
                </div>
              );
            }
            const kind = environment.kind as SelectableEnvironmentKind;
            return (
              <button
                key={environment.kind}
                type="button"
                className={`settings-radio${active ? " active" : ""}`}
                disabled={Boolean(pending)}
                onClick={() => void switchEnvironment(kind)}
              >
                <span className="settings-radio-title">
                  {environment.title}
                  {pending === kind ? ` · ${text.switching}` : ""}
                </span>
                <span className="settings-radio-hint">{environment.hint}</span>
                {path ? <span className="settings-radio-path">{path}</span> : null}
              </button>
            );
          })}
        </div>
      </SettingsBlock>
      {project.error ? <p className="settings-error">{localizeError(project.error)}</p> : null}
    </section>
  );
}

function AppearanceSection({
  copy,
  preferences,
  mod,
}: {
  copy: SettingsCopy;
  preferences: PreferencesApi;
  mod: string;
}) {
  const { appearance, locale, theme, lightTheme, darkTheme, setAppearance, setLocale } = preferences;
  const text = copy.appearance;
  // 固定为另一种明暗时,点选主题顺带切过去,否则点了看不到效果。
  const pickTheme = (scheme: ColorScheme, id: ThemeId) => {
    if (scheme === "light") preferences.setLightTheme(id as LightTheme);
    else preferences.setDarkTheme(id as DarkTheme);
    if (appearance !== "system" && appearance !== scheme) setAppearance(scheme);
  };
  const themes: { id: Appearance; label: string }[] = [
    { id: "system", label: text.system },
    { id: "light", label: text.light },
    { id: "dark", label: text.dark },
  ];
  const languages: { id: AppLocale; label: string }[] = [
    { id: "zh-CN", label: text.zh },
    { id: "en", label: text.en },
  ];
  const shortcuts = [
    { label: text.items.sidebar, keys: [`${mod}B`] },
    { label: text.items.panel, keys: [`${mod}J`] },
    { label: text.items.settings, keys: [`${mod},`] },
    { label: text.items.close, keys: ["Esc"] },
    { label: text.items.send, keys: ["Enter"] },
    { label: text.items.newline, keys: ["Shift", "Enter"] },
  ];

  return (
    <section className="settings-section">
      <SettingsBlock title={text.theme}>
        <Segmented
          label={text.theme}
          value={appearance}
          options={themes}
          onChange={setAppearance}
        />
      </SettingsBlock>
      <SettingsBlock title={text.palette} hint={text.paletteHint}>
        <ThemeGroup
          copy={copy}
          label={text.lightThemes}
          scheme="light"
          ids={lightThemes}
          selected={lightTheme}
          active={theme}
          onPick={pickTheme}
        />
        <ThemeGroup
          copy={copy}
          label={text.darkThemes}
          scheme="dark"
          ids={darkThemes}
          selected={darkTheme}
          active={theme}
          onPick={pickTheme}
        />
      </SettingsBlock>
      <SettingsBlock title={text.language}>
        <Segmented
          label={text.language}
          value={locale}
          options={languages}
          onChange={setLocale}
        />
      </SettingsBlock>
      <SettingsBlock title={text.shortcuts} hint={text.shortcutsHint}>
        <div className="settings-shortcuts">
          {shortcuts.map((shortcut) => (
            <div className="settings-shortcut" key={shortcut.label}>
              <span>{shortcut.label}</span>
              <span className="settings-keys">
                {shortcut.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </SettingsBlock>
    </section>
  );
}

function ThemeGroup({
  copy,
  label,
  scheme,
  ids,
  selected,
  active,
  onPick,
}: {
  copy: SettingsCopy;
  label: string;
  scheme: ColorScheme;
  ids: readonly ThemeId[];
  selected: ThemeId;
  active: ThemeId;
  onPick: (scheme: ColorScheme, id: ThemeId) => void;
}) {
  const text = copy.appearance;
  return (
    <div className="theme-group">
      <span className="theme-group-label">{label}</span>
      <div className="theme-grid" role="radiogroup" aria-label={label}>
        {ids.map((id) => {
          const meta = text.themes[id];
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={id === selected}
              className={`theme-card${id === selected ? " selected" : ""}`}
              onClick={() => onPick(scheme, id)}
            >
              <ThemePreview scheme={scheme} id={id} />
              <span className="theme-card-meta">
                <span className="theme-card-name">
                  {meta.name}
                  {id === active ? <span className="theme-card-badge">{text.inUse}</span> : null}
                </span>
                <span className="theme-card-hint">{meta.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 迷你窗口示意图;data-scheme / data-theme 让它套用对应主题的 CSS 变量。 */
function ThemePreview({ scheme, id }: { scheme: ColorScheme; id: ThemeId }) {
  return (
    <span className="theme-preview" data-scheme={scheme} data-theme={id} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <span className="theme-preview-line title" />
        <span className="theme-preview-line active" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line" />
      </span>
      <span className="theme-preview-main">
        <span className="theme-preview-bubble" />
        <span className="theme-preview-code">
          <span className="theme-preview-row">
            <span className="tok keyword" />
            <span className="tok function" />
            <span className="tok fg" />
          </span>
          <span className="theme-preview-row">
            <span className="tok indent" />
            <span className="tok type" />
            <span className="tok string" />
          </span>
          <span className="theme-preview-row">
            <span className="tok comment" />
          </span>
        </span>
        <span className="theme-preview-dock">
          <span className="theme-preview-send" />
        </span>
      </span>
    </span>
  );
}

function SettingsBlock({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="settings-block">
      <h2>{title}</h2>
      {hint ? <p className="settings-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-segment" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={`settings-segment-item${option.id === value ? " active" : ""}`}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const emptyModel: CustomModelInput = {
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
};

function providerIdFromName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) return slug;
  return `custom-${Math.random().toString(36).slice(2, 8)}`;
}

function modelValue(provider: string, id: string): string {
  return `${provider}\n${id}`;
}

function parseModelValue(value: string): { provider: string | null; modelId: string | null } {
  const splitAt = value.indexOf("\n");
  if (!value || splitAt <= 0) return { provider: null, modelId: null };
  return { provider: value.slice(0, splitAt), modelId: value.slice(splitAt + 1) };
}

function levelsFor(catalog: ModelCatalog | null, provider: string | null, modelId: string | null): ThinkingLevel[] {
  if (!provider || !modelId) return [...thinkingLevels];
  const model = catalog?.models.find((item) => item.provider === provider && item.id === modelId);
  if (model && model.thinkingLevels.length > 0) return model.thinkingLevels;
  return [...thinkingLevels];
}

function clampChoice(choices: ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (choices.includes(level)) return level;
  if (choices.includes("medium")) return "medium";
  return choices[0] ?? "off";
}

function sameSettings(draft: AgentSettings, saved: AgentSettings, thinking: ThinkingLevel): boolean {
  return (
    draft.provider === saved.provider &&
    draft.modelId === saved.modelId &&
    thinking === saved.thinkingLevel &&
    draft.instructions === saved.instructions
  );
}

function groupAvailable(catalog: ModelCatalog | null): { provider: string; name: string; models: { provider: string; id: string; name: string }[] }[] {
  const groups = new Map<string, { provider: string; name: string; models: { provider: string; id: string; name: string }[] }>();
  for (const model of catalog?.models ?? []) {
    if (!model.available) continue;
    const group = groups.get(model.provider) ?? { provider: model.provider, name: model.providerName, models: [] };
    group.models.push({ provider: model.provider, id: model.id, name: model.name });
    groups.set(model.provider, group);
  }
  return [...groups.values()];
}

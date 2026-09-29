import {
  customModelApis,
  thinkingLevels,
  type AgentSettings,
  type AuthMethodType,
  type CustomModelInput,
  type ExternalSkillCandidate,
  type ExternalSkillScan,
  type ExternalSkillSource,
  type ProviderSummary,
  type SkillMigrationResult,
  type ThinkingLevel,
} from "@vela/shared";
import { useEffect, useMemo, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import type { useModels } from "../hooks/useModels";
import type { Appearance, PreferencesApi } from "../hooks/usePreferences";
import { darkThemes, lightThemes, type ColorScheme, type DarkTheme, type LightTheme, type ThemeId } from "../themes";
import { localizeError } from "../locale";
import { settingsCopy } from "./settings-copy";
import { onboardingCopy } from "./onboarding-copy";
import { LoginDialog } from "./ModelControls";
import { SheetPresence } from "./Presence";
import velaLogoUrl from "../../../resources/icon.png";

type ModelsApi = ReturnType<typeof useModels>;

interface OnboardingViewProps {
  preferences: PreferencesApi;
  models: ModelsApi;
  initialStep: number;
  onStepChange: (step: number) => void;
  onComplete: () => void;
}

const sources: ExternalSkillSource[] = ["codex", "claude"];

const emptyCustomModel: CustomModelInput = {
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

export function OnboardingView({ preferences, models, initialStep, onStepChange, onComplete }: OnboardingViewProps) {
  const locale = preferences.locale;
  const copy = onboardingCopy(locale);
  const settings = settingsCopy(locale);
  const settingsCopyAgent = settings.agent;
  const appearanceCopy = settings.appearance;
  const [step, setStep] = useState(() => clampStep(initialStep));
  const [scan, setScan] = useState<ExternalSkillScan | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(() => new Set());
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [scanAttempt, setScanAttempt] = useState(0);
  const [skillsNotice, setSkillsNotice] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [providerId, setProviderId] = useState("");
  const [providerError, setProviderError] = useState<string | null>(null);
  const [customProviderMode, setCustomProviderMode] = useState(false);
  const [customForm, setCustomForm] = useState<CustomModelInput>(emptyCustomModel);
  const [customBusy, setCustomBusy] = useState(false);
  const [savedAgentSettings, setSavedAgentSettings] = useState<AgentSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [savingAgentSettings, setSavingAgentSettings] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const providers = models.catalog?.providers ?? [];
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? null;
  const availableModels = useMemo(
    () => (models.catalog?.models ?? []).filter((model) => model.provider === providerId && model.available),
    [models.catalog?.models, providerId],
  );
  const selectedModel = availableModels.find((model) => model.id === selectedModelId) ?? null;
  const modelThinkingLevels = selectedModel?.thinkingLevels.length ? selectedModel.thinkingLevels : [...thinkingLevels];
  const normalizedThinking = clampThinking(modelThinkingLevels, thinkingLevel);
  const connected = Boolean(selectedProvider && (selectedProvider.authenticated || selectedProvider.stored));
  const filteredProviders = providers.filter((provider) =>
    provider.name.toLocaleLowerCase().includes(providerQuery.trim().toLocaleLowerCase()),
  );
  const chosenSkills = scan?.skills.filter((skill) => selectedSkills.has(skill.id)) ?? [];

  useEffect(() => {
    const api = window.vela;
    if (!api) return;
    let active = true;
    void api.getAgentSettings().then(
      (value) => {
        if (!active) return;
        setSavedAgentSettings(value);
        setSelectedModelId(value.modelId ?? "");
        setThinkingLevel(value.thinkingLevel);
        setSettingsLoaded(true);
      },
      () => {
        if (!active) return;
        setSavedAgentSettings({ provider: null, modelId: null, thinkingLevel: "medium", newConversationSelection: "default", instructions: "" });
        setSettingsLoaded(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!models.catalog || !settingsLoaded) return;
    setProviderId((current) => {
      if (current && models.catalog?.providers.some((provider) => provider.id === current)) return current;
      const savedProvider = savedAgentSettings?.provider;
      if (savedProvider && models.catalog?.providers.some((provider) => provider.id === savedProvider)) return savedProvider;
      return models.catalog?.providers.find((provider) => provider.authenticated || provider.stored)?.id ?? "";
    });
  }, [models.catalog, savedAgentSettings?.provider, settingsLoaded]);

  useEffect(() => {
    if (!providerId || !settingsLoaded) return;
    setSelectedModelId((current) => {
      if (current && availableModels.some((model) => model.id === current)) return current;
      const savedModel = savedAgentSettings?.provider === providerId ? savedAgentSettings.modelId : null;
      if (savedModel && availableModels.some((model) => model.id === savedModel)) return savedModel;
      return availableModels[0]?.id ?? "";
    });
  }, [availableModels, providerId, savedAgentSettings?.modelId, savedAgentSettings?.provider, settingsLoaded]);

  useEffect(() => {
    setThinkingLevel((current) => clampThinking(modelThinkingLevels, current));
  }, [modelThinkingLevels.join("|")]);

  useEffect(() => {
    if (step !== 3) return;
    const api = window.vela;
    if (!api) return;
    let active = true;
    setScan(null);
    setScanError(null);
    setSkillsNotice(null);
    void api.scanExternalSkills().then(
      (next) => {
        if (!active) return;
        setScan(next);
        setSelectedSkills(new Set(next.skills.filter((skill) => skill.selectable && skill.state === "new").map((skill) => skill.id)));
      },
      (error: unknown) => {
        if (!active) return;
        setScanError(error instanceof Error ? error.message : settingsCopyAgent.migrateLoadError);
      },
    );
    return () => {
      active = false;
    };
  }, [scanAttempt, settingsCopyAgent.migrateLoadError, step]);

  function goTo(next: number): void {
    const safe = clampStep(next);
    setStep(safe);
    onStepChange(safe);
    setSaveError(null);
  }

  function pickTheme(scheme: ColorScheme, id: ThemeId): void {
    if (scheme === "light") preferences.setLightTheme(id as LightTheme);
    else preferences.setDarkTheme(id as DarkTheme);
    if (preferences.appearance !== "system" && preferences.appearance !== scheme) {
      preferences.setAppearance(scheme);
    }
  }

  function pickProvider(provider: ProviderSummary): void {
    setProviderId(provider.id);
    setCustomProviderMode(false);
    setProviderError(null);
    if (savedAgentSettings?.provider === provider.id && savedAgentSettings.modelId) {
      setSelectedModelId(savedAgentSettings.modelId);
    } else {
      const first = models.catalog?.models.find((model) => model.provider === provider.id && model.available);
      setSelectedModelId(first?.id ?? "");
    }
  }

  function toggleSkill(skill: ExternalSkillCandidate): void {
    if (!skill.selectable || skillsBusy) return;
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      return next;
    });
  }

  function toggleSource(items: ExternalSkillCandidate[]): void {
    const ids = items.filter((skill) => skill.selectable).map((skill) => skill.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedSkills.has(id));
    setSelectedSkills((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function continueFromSkills(): Promise<void> {
    if (!window.vela || !scan || chosenSkills.length === 0) {
      goTo(4);
      return;
    }
    setSkillsBusy(true);
    setScanError(null);
    try {
      const result: SkillMigrationResult = await window.vela.migrateSkills(chosenSkills.map((skill) => skill.id));
      const migrated = result.copied.length + result.replaced.length;
      const suffix = result.skipped.length ? ` ${copy.migrationPartial}` : "";
      setSkillsNotice(`${copy.migrationDone(migrated)}${suffix}`);
      goTo(4);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : copy.migrationError);
    } finally {
      setSkillsBusy(false);
    }
  }

  async function addCustomProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!models.register) return;
    const id = providerIdFromName(customForm.providerName);
    if (!id) {
      setProviderError(settings.models.providerInvalid);
      return;
    }
    if (!customForm.baseUrl.trim() || !customForm.modelId.trim()) {
      setProviderError(copy.connectError);
      return;
    }
    setCustomBusy(true);
    setProviderError(null);
    const result = await models.register({
      ...customForm,
      providerId: id,
      providerName: customForm.providerName.trim(),
      baseUrl: customForm.baseUrl.trim(),
      modelId: customForm.modelId.trim(),
      modelName: customForm.modelName.trim(),
    });
    setCustomBusy(false);
    if (typeof result === "string" && result) {
      setProviderError(result);
      return;
    }
    setProviderId(id);
    setSelectedModelId(customForm.modelId.trim());
    setCustomProviderMode(false);
    setProviderError(null);
    setCustomForm(emptyCustomModel);
  }

  async function continueFromModel(): Promise<void> {
    if (!window.vela || !selectedProvider || !selectedModel) return;
    setSavingAgentSettings(true);
    setSaveError(null);
    try {
      const next: AgentSettings = {
        provider: selectedProvider.id,
        modelId: selectedModel.id,
        thinkingLevel: normalizedThinking,
        newConversationSelection: savedAgentSettings?.newConversationSelection ?? "default",
        instructions: savedAgentSettings?.instructions ?? "",
      };
      setSavedAgentSettings(await window.vela.saveAgentSettings(next));
      goTo(6);
    } catch (error) {
      setSaveError(error instanceof Error ? localizeError(error.message) : copy.saveError);
    } finally {
      setSavingAgentSettings(false);
    }
  }

  function finish(): void {
    onComplete();
  }

  const themeSummary = `${appearanceCopy.themes[preferences.lightTheme].name} / ${appearanceCopy.themes[preferences.darkTheme].name}`;
  const selectedProviderName = selectedProvider?.name ?? savedAgentSettings?.provider ?? "";
  const levelLabels = copy.thinkingLevels;
  const skillScopes = settingsCopyAgent.migrateScopes;
  const skillSources = settingsCopyAgent.migrateSources;
  const skillStates = settingsCopyAgent.migrateStates;

  return (
    <div className="onboarding-view">
      <aside className="onboarding-stepper">
        <div className="onboarding-brand">
          <img className="onboarding-brand-mark" src={velaLogoUrl} alt="" aria-hidden="true" />
          <span>Vela</span>
        </div>
        <div className="onboarding-stepper-intro">
          <h2>{copy.sidebarTitle}</h2>
          <p>{copy.sidebarHint}</p>
        </div>
        <nav className="onboarding-steps" aria-label={copy.sidebarTitle}>
          {copy.steps.map((title, index) => {
            const targetStep = index + 1;
            const active = step === targetStep;
            const done = step > targetStep;
            const canVisit = targetStep <= step || step === 6;
            return (
              <button
                key={title}
                type="button"
                className={`onboarding-step${active ? " active" : ""}${done ? " done" : ""}`}
                disabled={!canVisit}
                aria-current={active ? "step" : undefined}
                onClick={() => canVisit && goTo(targetStep)}
              >
                <span className="onboarding-step-number">{done ? <CheckIcon /> : targetStep}</span>
                <span>{title}</span>
                {targetStep === 3 ? <span className="onboarding-step-optional">{copy.optional}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="onboarding-local-note">
          <strong>{copy.sidebarFootTitle}</strong>
          <span>{copy.sidebarFootHint}</span>
        </div>
      </aside>

      <main className="onboarding-main">
        <header className="onboarding-header">
          <div className="onboarding-header-title"><img className="onboarding-brand-mark small" src={velaLogoUrl} alt="" aria-hidden="true" />{copy.appTitle}</div>
          <span className="onboarding-saved-badge">{copy.savedOnDevice}</span>
        </header>
        <div className="onboarding-content" key={step}>
          {step === 0 ? (
            <section className="onboarding-screen onboarding-welcome" aria-labelledby="onboarding-welcome-title">
              <div className="onboarding-welcome-content">
                <img className="onboarding-brand-mark onboarding-hero-mark" src={velaLogoUrl} alt="" aria-hidden="true" />
                <div className="onboarding-kicker">{copy.welcomeKicker}</div>
                <h1 id="onboarding-welcome-title">{copy.welcomeTitle}</h1>
                <p className="onboarding-lead">{copy.welcomeHint}</p>
                <div className="onboarding-meta">
                  {copy.welcomeMeta.map((item) => <span key={item}>{item}</span>)}
                </div>
                <div className="onboarding-feature-grid">
                  {copy.welcomeFeatures.map((feature) => (
                    <article className="onboarding-feature" key={feature.title}>
                      <strong>{feature.title}</strong>
                      <span>{feature.hint}</span>
                    </article>
                  ))}
                </div>
                <button className="onboarding-primary onboarding-start" type="button" onClick={() => goTo(1)}>
                  {copy.start}<ArrowIcon />
                </button>
              </div>
            </section>
          ) : null}

          {step === 1 ? (
            <section className="onboarding-screen" aria-labelledby="onboarding-preferences-title">
              <ScreenHeading kicker={copy.stepKickers[0]} title={copy.preferencesTitle} hint={copy.preferencesHint} />
              <SettingsGroup title={copy.language} hint={copy.languageHint}>
                <div className="onboarding-segmented" role="radiogroup" aria-label={copy.language}>
                  {([
                    ["zh-CN", appearanceCopy.zh],
                    ["en", appearanceCopy.en],
                  ] as const).map(([id, label]) => (
                    <button key={id} type="button" role="radio" aria-checked={preferences.locale === id} className={preferences.locale === id ? "active" : ""} onClick={() => preferences.setLocale(id)}>{label}</button>
                  ))}
                </div>
              </SettingsGroup>
              <SettingsGroup title={copy.appearance} hint={copy.appearanceHint}>
                <div className="onboarding-segmented" role="radiogroup" aria-label={copy.appearance}>
                  {([
                    ["system", appearanceCopy.system],
                    ["light", appearanceCopy.light],
                    ["dark", appearanceCopy.dark],
                  ] as const).map(([id, label]) => (
                    <button key={id} type="button" role="radio" aria-checked={preferences.appearance === id} className={preferences.appearance === id ? "active" : ""} onClick={() => preferences.setAppearance(id as Appearance)}>{label}</button>
                  ))}
                </div>
              </SettingsGroup>
              <SettingsGroup title={copy.theme} hint={copy.themeHint}>
                <ThemeChoices
                  copy={appearanceCopy}
                  label={appearanceCopy.lightThemes}
                  scheme="light"
                  ids={lightThemes}
                  selected={preferences.lightTheme}
                  active={preferences.theme}
                  onPick={pickTheme}
                />
                <ThemeChoices
                  copy={appearanceCopy}
                  label={appearanceCopy.darkThemes}
                  scheme="dark"
                  ids={darkThemes}
                  selected={preferences.darkTheme}
                  active={preferences.theme}
                  onPick={pickTheme}
                />
              </SettingsGroup>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="onboarding-screen" aria-labelledby="onboarding-tools-title">
              <ScreenHeading kicker={copy.stepKickers[1]} title={copy.toolTitle} hint={copy.toolHint} />
              <div className="onboarding-tool-options" role="radiogroup" aria-label={appearanceCopy.toolDisplay}>
                <ToolDisplayCard
                  value="card"
                  selected={preferences.toolDisplay === "card"}
                  title={appearanceCopy.toolCard}
                  hint={copy.toolCardHint}
                  readFile={copy.readFile}
                  editFile={copy.editFile}
                  runCommand={copy.runCommand}
                  onPick={preferences.setToolDisplay}
                />
                <ToolDisplayCard
                  value="compact"
                  selected={preferences.toolDisplay === "compact"}
                  title={appearanceCopy.toolCompact}
                  hint={copy.toolCompactHint}
                  readFile={copy.readFile}
                  editFile={copy.editFile}
                  runCommand={copy.runCommand}
                  onPick={preferences.setToolDisplay}
                  more={copy.moreTools}
                />
              </div>
            </section>
          ) : null}

          {step === 3 ? (
            <section className="onboarding-screen" aria-labelledby="onboarding-skills-title">
              <ScreenHeading kicker={copy.stepKickers[2]} title={copy.migrateTitle} hint={copy.migrateHint} />
              <div className="onboarding-section-head">
                <h2>{copy.foundSkills}</h2>
                {scan ? <span className="onboarding-count">{copy.selectedSkills(chosenSkills.length)}</span> : null}
              </div>
              {skillsNotice ? <p className="onboarding-notice success">{skillsNotice}</p> : null}
              {!scan && !scanError ? <p className="onboarding-inline-note">{settingsCopyAgent.migrateLoading}…</p> : null}
              {scan?.skills.length === 0 ? <p className="onboarding-empty">{copy.skillsEmpty}</p> : null}
              {scan?.skills.length ? (
                <div className="onboarding-skill-groups">
                  {sources.map((source) => {
                    const items = scan.skills.filter((skill) => skill.source === source);
                    if (!items.length) return null;
                    const selectable = items.filter((skill) => skill.selectable);
                    const allSelected = selectable.length > 0 && selectable.every((skill) => selectedSkills.has(skill.id));
                    return (
                      <section key={source} className="onboarding-skill-group">
                        <header>
                          <h3>{skillSources[source]}</h3>
                          {selectable.length ? (
                            <button className="onboarding-link-button" type="button" disabled={skillsBusy} onClick={() => toggleSource(items)}>
                              {allSelected ? settingsCopyAgent.migrateSelectNone : settingsCopyAgent.migrateSelectAll}
                            </button>
                          ) : null}
                        </header>
                        {items.map((skill) => (
                          <label className={`onboarding-skill-row${skill.selectable ? "" : " disabled"}`} key={skill.id}>
                            <input type="checkbox" checked={selectedSkills.has(skill.id)} disabled={!skill.selectable || skillsBusy} onChange={() => toggleSkill(skill)} />
                            <span className="onboarding-skill-copy">
                              <strong>{skill.name}</strong>
                              {skill.description ? <span>{skill.description}</span> : null}
                              <span className="onboarding-skill-tags">
                                <i>{skillScopes[skill.scope]}</i>
                                <i className={skill.selectable && skill.state === "new" ? "good" : ""}>{skill.state === "new" ? copy.skillNew : skillStates[skill.state]}</i>
                                {!skill.selectable ? <i>{settingsCopyAgent.migrateLocalNote}</i> : null}
                              </span>
                            </span>
                          </label>
                        ))}
                      </section>
                    );
                  })}
                </div>
              ) : null}
              {scanError ? (
                <div className="onboarding-error-row"><p>{localizeError(scanError) || copy.skillsLoadError}</p><button className="onboarding-secondary small" type="button" onClick={() => setScanAttempt((attempt) => attempt + 1)}>{copy.retry}</button></div>
              ) : null}
              <div className="onboarding-callout"><InfoIcon /><span>{copy.migrationNote}</span></div>
            </section>
          ) : null}

          {step === 4 ? (
            <section className="onboarding-screen" aria-labelledby="onboarding-provider-title">
              <ScreenHeading kicker={copy.stepKickers[3]} title={copy.providerTitle} hint={copy.providerHint} />
              <div className="onboarding-provider-search">
                <SearchIcon />
                <input value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder={copy.providerSearch} aria-label={copy.providerSearch} />
              </div>
              {models.catalogError ? (
                <div className="onboarding-error-row"><p>{localizeError(models.catalogError) || copy.providerLoadError}</p><button className="onboarding-secondary small" type="button" onClick={() => void models.reload()}>{copy.retry}</button></div>
              ) : null}
              {!models.catalog && !models.catalogError ? <p className="onboarding-inline-note">{copy.providerLoading}</p> : null}
              {models.catalog ? (
                <div className="onboarding-provider-list" role="radiogroup" aria-label={copy.providerTitle}>
                  {filteredProviders.map((provider) => {
                    const isConnected = provider.authenticated || provider.stored;
                    const count = models.catalog?.models.filter((model) => model.provider === provider.id && model.available).length ?? 0;
                    return (
                      <button
                        className={`onboarding-provider-card${providerId === provider.id ? " selected" : ""}`}
                        type="button"
                        role="radio"
                        aria-checked={providerId === provider.id}
                        key={provider.id}
                        onClick={() => pickProvider(provider)}
                      >
                        <span className="onboarding-provider-avatar">{provider.name.slice(0, 1).toLocaleUpperCase()}</span>
                        <span className="onboarding-provider-info"><strong>{provider.name}</strong><small>{copy.providerModelCount(count)}</small></span>
                        <span className={`onboarding-provider-status${isConnected ? " connected" : ""}`}>{isConnected ? copy.providerConnected : copy.providerNeedsConnection}</span>
                      </button>
                    );
                  })}
                  {filteredProviders.length === 0 ? <p className="onboarding-empty">{copy.providerEmpty}</p> : null}
                </div>
              ) : null}
              {models.catalog ? (
                <button
                  className="onboarding-link-button onboarding-custom-provider-trigger"
                  type="button"
                  onClick={() => {
                    setCustomProviderMode((open) => !open);
                    setProviderError(null);
                  }}
                >
                  {customProviderMode ? copy.customProviderClose : copy.customProviderAction}
                </button>
              ) : null}
              {customProviderMode ? (
                <div className="onboarding-provider-detail">
                  <div className="onboarding-section-head compact"><h2>{copy.customProviderTitle}</h2></div>
                  <CustomProviderForm
                    copy={copy}
                    settingsCopy={settings.models}
                    form={customForm}
                    setForm={setCustomForm}
                    busy={customBusy}
                    onSubmit={addCustomProvider}
                  />
                  {providerError ? <p className="onboarding-error-text">{localizeError(providerError)}</p> : null}
                </div>
              ) : null}
              {skillsNotice ? <p className="onboarding-notice success">{skillsNotice}</p> : null}
              {selectedProvider ? (
                <div className="onboarding-provider-detail">
                  <div className="onboarding-section-head compact">
                    <h2>{selectedProvider.name}</h2>
                    {connected ? <span className="onboarding-status-pill connected">{copy.providerConnected}</span> : null}
                  </div>
                  {!selectedProvider.custom ? (
                    <div className="onboarding-provider-methods">
                      {selectedProvider.methods.map((method) => (
                        <button key={method.type} type="button" className={method.type === "oauth" ? "onboarding-primary" : "onboarding-secondary"} onClick={() => void models.loginProvider(selectedProvider.id, method.type as AuthMethodType)}>
                          {method.type === "oauth" ? settings.models.login : settings.models.apiKey}
                        </button>
                      ))}
                      {selectedProvider.methods.length === 0 && !connected ? <p className="onboarding-inline-note">{copy.providerNeedsConnection}</p> : null}
                    </div>
                  ) : null}
                  {connected && availableModels.length === 0 ? <p className="onboarding-error-text">{copy.providerNeedsModel}</p> : null}
                  {models.login.error ? <p className="onboarding-error-text">{localizeError(models.login.error)}</p> : null}
                  {models.actionError ? <p className="onboarding-error-text">{localizeError(models.actionError)}</p> : null}
                </div>
              ) : null}
              {!selectedProvider && models.catalog ? <p className="onboarding-inline-note">{copy.providerSelectHint}</p> : null}
              <div className="onboarding-callout"><InfoIcon /><span>{copy.credentialsHint}</span></div>
            </section>
          ) : null}

          {step === 5 ? (
            <section className="onboarding-screen" aria-labelledby="onboarding-model-title">
              <ScreenHeading kicker={copy.stepKickers[4]} title={copy.modelTitle} hint={copy.modelHint} />
              <div className="onboarding-form-column">
                <SettingsGroup title={copy.defaultModel} hint={selectedProviderName}>
                  {availableModels.length ? (
                    <select className="onboarding-select" value={selectedModelId} onChange={(event) => setSelectedModelId(event.target.value)}>
                      {availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                    </select>
                  ) : (
                    <p className="onboarding-empty">{copy.noModels}</p>
                  )}
                  {savedAgentSettings?.modelId && savedAgentSettings.provider === providerId && !availableModels.some((model) => model.id === savedAgentSettings.modelId) ? (
                    <p className="onboarding-warning">{copy.unavailableModel}</p>
                  ) : null}
                </SettingsGroup>
                <SettingsGroup title={copy.thinkingLevel} hint={copy.thinkingHint}>
                  <div className="onboarding-thinking-options" role="radiogroup" aria-label={copy.thinkingLevel}>
                    {modelThinkingLevels.map((level) => (
                      <button key={level} type="button" role="radio" aria-checked={normalizedThinking === level} className={normalizedThinking === level ? "active" : ""} onClick={() => setThinkingLevel(level)}>
                        {levelLabels[level]}
                      </button>
                    ))}
                  </div>
                </SettingsGroup>
              </div>
              <div className="onboarding-callout"><InfoIcon /><span>{copy.modelNote}</span></div>
              {saveError ? <p className="onboarding-error-text">{saveError}</p> : null}
            </section>
          ) : null}

          {step === 6 ? (
            <section className="onboarding-screen onboarding-complete" aria-labelledby="onboarding-complete-title">
              <div className="onboarding-complete-mark"><CheckIcon /></div>
              <div className="onboarding-kicker">{copy.completeKicker}</div>
              <h1 id="onboarding-complete-title">{copy.completeTitle}</h1>
              <p className="onboarding-lead">{copy.completeHint}</p>
              <div className="onboarding-summary">
                <SummaryRow label={copy.summaryLanguage} value={locale === "en" ? "English" : "简体中文"} />
                <SummaryRow label={copy.summaryTheme} value={`${appearanceCopy[preferences.appearance]} · ${themeSummary}`} />
                <SummaryRow label={copy.summaryTools} value={preferences.toolDisplay === "card" ? appearanceCopy.toolCard : appearanceCopy.toolCompact} />
                <SummaryRow label={copy.summaryProvider} value={selectedProvider?.name ?? "—"} />
                <SummaryRow label={copy.summaryModel} value={selectedModel ? `${selectedModel.name} · ${levelLabels[normalizedThinking]}` : "—"} />
              </div>
              <button className="onboarding-primary" type="button" onClick={finish}>{copy.enterApp}<ArrowIcon /></button>
            </section>
          ) : null}
        </div>

        {step > 0 && step < 6 ? (
          <footer className="onboarding-footer">
            <button type="button" className="onboarding-secondary" onClick={() => goTo(step - 1)} disabled={skillsBusy || customBusy || savingAgentSettings}>{copy.previous}</button>
            <span className="onboarding-footer-hint">{copy.resumeHint}</span>
            <div className="onboarding-footer-actions">
              {step === 3 ? <button type="button" className="onboarding-link-button" onClick={() => goTo(4)} disabled={skillsBusy}>{copy.skip}</button> : null}
              <button
                type="button"
                className="onboarding-primary"
                disabled={
                  skillsBusy || customBusy || savingAgentSettings ||
                  (step === 4 && (!connected || availableModels.length === 0)) ||
                  (step === 5 && (!selectedModel || !settingsLoaded))
                }
                onClick={() => {
                  if (step === 3) void continueFromSkills();
                  else if (step === 5) void continueFromModel();
                  else goTo(step + 1);
                }}
              >
                {skillsBusy ? copy.migrating : customBusy || savingAgentSettings ? copy.connecting : step === 3 && chosenSkills.length ? copy.migrateAndContinue : step === 3 ? copy.continueWithoutMigration : step === 5 ? copy.finishStep : copy.next}
                {!skillsBusy && !customBusy && !savingAgentSettings ? <ArrowIcon /> : null}
              </button>
            </div>
          </footer>
        ) : null}
      </main>
      <SheetPresence present={models.login.active}>
        <LoginDialog
          login={models.login}
          onReply={models.replyLogin}
          onCancel={models.cancelLogin}
          onDismiss={models.dismissLogin}
        />
      </SheetPresence>
    </div>
  );
}

function ScreenHeading({ kicker, title, hint }: { kicker: string; title: string; hint: string }) {
  return (
    <header className="onboarding-screen-head">
      <div className="onboarding-kicker">{kicker}</div>
      <h1>{title}</h1>
      <p>{hint}</p>
    </header>
  );
}

function SettingsGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="onboarding-settings-group">
      <header><h2>{title}</h2>{hint ? <span>{hint}</span> : null}</header>
      {children}
    </section>
  );
}

function ThemeChoices({
  copy,
  label,
  scheme,
  ids,
  selected,
  active,
  onPick,
}: {
  copy: ReturnType<typeof settingsCopy>["appearance"];
  label: string;
  scheme: ColorScheme;
  ids: readonly ThemeId[];
  selected: ThemeId;
  active: ThemeId;
  onPick: (scheme: ColorScheme, id: ThemeId) => void;
}) {
  return (
    <div className="onboarding-theme-group">
      <h3>{label}</h3>
      <div className="onboarding-theme-grid">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            className={`onboarding-theme-card${selected === id ? " selected" : ""}`}
            aria-pressed={selected === id}
            onClick={() => onPick(scheme, id)}
          >
            <ThemePreview id={id} scheme={scheme} />
            <span className="onboarding-theme-name">{copy.themes[id].name}</span>
            <span className="onboarding-theme-hint">{copy.themes[id].hint}</span>
            {active === id ? <span className="onboarding-in-use">{copy.inUse}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemePreview({ id, scheme }: { id: ThemeId; scheme: ColorScheme }) {
  return (
    <span className={`onboarding-theme-preview ${scheme} ${id}`} aria-hidden="true">
      <span className="onboarding-theme-preview-side"><i /><i /><i /></span>
      <span className="onboarding-theme-preview-main">
        <i className="preview-user-line" />
        <i className="preview-code-line" />
        <i className="preview-code-line short" />
        <i className="preview-compose"><b /></i>
      </span>
    </span>
  );
}

function ToolDisplayCard({
  value,
  selected,
  title,
  hint,
  readFile,
  editFile,
  runCommand,
  onPick,
  more,
}: {
  value: "card" | "compact";
  selected: boolean;
  title: string;
  hint: string;
  readFile: string;
  editFile: string;
  runCommand: string;
  onPick: (value: "card" | "compact") => void;
  more?: string;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} className={`onboarding-tool-card${selected ? " selected" : ""}`} onClick={() => onPick(value)}>
      <span className="onboarding-tool-title"><span className="onboarding-radio-dot" />{title}</span>
      <span className="onboarding-tool-hint">{hint}</span>
      <span className="onboarding-tool-preview">
        {value === "card" ? (
          <>
            <ToolSample icon="R" title={readFile} detail="src/App.tsx · 142 lines" />
            <ToolSample icon="E" title={editFile} detail="src/App.tsx · +12 −4" />
          </>
        ) : (
          <>
            <ToolCompactRow icon="R" title={readFile} detail="src/App.tsx" />
            <ToolCompactRow icon="E" title={editFile} detail="+12 −4" />
            <ToolCompactRow icon="⌘" title={runCommand} detail={more ?? "3 more"} />
          </>
        )}
      </span>
    </button>
  );
}

function ToolSample({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return <span className="onboarding-tool-sample"><i>{icon}</i><span><strong>{title}</strong><small>{detail}</small></span><b>⌄</b></span>;
}

function ToolCompactRow({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return <span className="onboarding-tool-compact-row"><i>{icon}</i><span>{title}</span><small>{detail}</small></span>;
}

function CustomProviderForm({
  copy,
  settingsCopy: modelCopy,
  form,
  setForm,
  busy,
  onSubmit,
}: {
  copy: ReturnType<typeof onboardingCopy>;
  settingsCopy: ReturnType<typeof settingsCopy>["models"];
  form: CustomModelInput;
  setForm: Dispatch<SetStateAction<CustomModelInput>>;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="onboarding-custom-form" onSubmit={onSubmit}>
      <label><span>{copy.providerName}</span><input value={form.providerName} placeholder={copy.providerNamePlaceholder} onChange={(event) => setForm({ ...form, providerName: event.target.value })} required /></label>
      <label><span>{copy.baseUrl}</span><input value={form.baseUrl} placeholder={modelCopy.baseUrlPlaceholder} spellCheck={false} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} required /></label>
      <label><span>{copy.apiType}</span><select value={form.api} onChange={(event) => setForm({ ...form, api: event.target.value as CustomModelInput["api"] })}>{customModelApis.map((api) => <option key={api} value={api}>{modelCopy.apis[api]}</option>)}</select></label>
      <label><span>{copy.apiKeyField}</span><input type="password" value={form.apiKey} placeholder={copy.apiKeyPlaceholder} autoComplete="off" spellCheck={false} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></label>
      <label><span>{copy.modelId}</span><input value={form.modelId} placeholder={modelCopy.modelIdPlaceholder} spellCheck={false} onChange={(event) => setForm({ ...form, modelId: event.target.value })} required /></label>
      <label><span>{copy.modelName}</span><input value={form.modelName} placeholder={copy.modelNamePlaceholder} onChange={(event) => setForm({ ...form, modelName: event.target.value })} /></label>
      <label className="onboarding-check-row"><input type="checkbox" checked={form.reasoning} onChange={(event) => setForm({ ...form, reasoning: event.target.checked })} /><span>{copy.supportsReasoning}</span></label>
      <button type="submit" className="onboarding-primary" disabled={busy}>{busy ? copy.connecting : copy.addProvider}<ArrowIcon /></button>
    </form>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="onboarding-summary-row"><span>{label}</span><strong>{value}</strong></div>;
}

function ArrowIcon() {
  return <svg className="onboarding-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M8 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CheckIcon() {
  return <svg className="onboarding-check-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.2 2.8 2.8 6.2-6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function InfoIcon() {
  return <svg className="onboarding-info-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.1" stroke="currentColor" strokeWidth="1.3"/><path d="M8 7.1v3.5M8 4.7h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
}

function SearchIcon() {
  return <svg className="onboarding-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.9" cy="6.9" r="4.6" stroke="currentColor" strokeWidth="1.4"/><path d="m10.4 10.4 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
}

function clampStep(step: number): number {
  return Number.isFinite(step) ? Math.max(0, Math.min(6, Math.floor(step))) : 0;
}

function clampThinking(choices: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (choices.includes(level)) return level;
  if (choices.includes("medium")) return "medium";
  return choices[0] ?? "off";
}

function providerIdFromName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) return slug;
  return `custom-${Math.random().toString(36).slice(2, 8)}`;
}

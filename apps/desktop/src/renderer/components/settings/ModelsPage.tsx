import { customModelApis, type AuthMethodType, type CustomModelApi, type CustomModelInput, type ProviderSummary } from "@vela/shared";
import { useState } from "react";
import type { useModels } from "../../hooks/useModels";
import type { PreferencesApi } from "../../hooks/usePreferences";
import { localizeError } from "../../locale";
import type { SettingsCopy } from "../settings-copy";
import { emptyModel, groupAvailable, providerIdFromName } from "./model-helpers";
import { Field, SettingsBlock, SettingsSwitch } from "./primitives";

type ModelsApi = ReturnType<typeof useModels>;

export function ModelsPage({ copy, models, preferences }: { copy: SettingsCopy; models: ModelsApi; preferences: PreferencesApi }) {
  const text = copy.models;
  const catalog = models.catalog;
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [form, setForm] = useState<CustomModelInput>(emptyModel);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState(false);

  const providers = catalog?.providers ?? [];
  const modelGroups = groupAvailable(catalog);

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
      <SettingsBlock id="providers" title={text.connected}>
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

      <SettingsBlock id="model-visibility" title={text.visibility} hint={text.visibilityHint} collapsible={{ defaultOpen: false }}>
        {modelGroups.length === 0 ? <p className="settings-note">{text.visibilityEmpty}</p> : null}
        {preferences.hiddenModels.length > 0 ? (
          <div className="settings-actions">
            <button className="settings-secondary" type="button" onClick={preferences.showAllModels}>
              {text.visibilityShowAll(preferences.hiddenModels.length)}
            </button>
          </div>
        ) : null}
        {modelGroups.length > 0 ? (
          <div className="settings-stack">
            {modelGroups.map((group) => (
              <div className="settings-visibility-group" key={group.provider}>
                <div className="settings-kicker">{group.name}</div>
                {group.models.map((model) => {
                  const visible = !preferences.isModelHidden(model.provider, model.id);
                  return (
                    <div className={`settings-skill${visible ? "" : " disabled"}`} key={`${group.provider}/${model.id}`}>
                      <div className="settings-skill-main">
                        <span className="settings-radio-title">
                          {model.name}
                          {visible ? null : <span className="settings-skill-state">{text.visibilityHidden}</span>}
                        </span>
                        <span className="settings-radio-hint">{model.id}</span>
                      </div>
                      <div className="settings-skill-actions">
                        <SettingsSwitch
                          checked={visible}
                          label={visible ? text.visibilityHide : text.visibilityShow}
                          title={visible ? text.visibilityHide : text.visibilityShow}
                          onChange={(next) => preferences.setModelHidden(model.provider, model.id, !next)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
      </SettingsBlock>

      <SettingsBlock id="add-model" title={text.add} collapsible={{ defaultOpen: false }}>
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

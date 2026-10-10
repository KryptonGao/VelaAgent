import { useMemo } from "react";
import type { ModelCatalog } from "@vela/shared";
import type { PreferencesApi, ThinkingSummaryStyle, ToolDisplay, ToolFold } from "../../hooks/usePreferences";
import type { SettingsCopy } from "../settings-copy";
import { groupAvailable, modelValue, parseModelValue } from "./model-helpers";
import { Segmented, SettingsBlock } from "./primitives";
import { IntelligentUiSetting } from "../intelligent-ui/IntelligentUiSetting";

export function ConversationDisplayPage({
  copy,
  preferences,
  catalog,
}: {
  copy: SettingsCopy;
  preferences: PreferencesApi;
  catalog: ModelCatalog | null;
}) {
  const {
    toolDisplay,
    toolFold,
    toolProcessDetails,
    thinkingSummary,
    thinkingSummaryStyle,
    thinkingSummaryModel,
    setToolDisplay,
    setToolFold,
    setToolProcessDetails,
    setThinkingSummary,
    setThinkingSummaryStyle,
    setThinkingSummaryModel,
  } = preferences;
  const text = copy.appearance;
  const summaryModelGroups = useMemo(() => groupAvailable(catalog), [catalog]);
  const summaryModelMissing = Boolean(thinkingSummaryModel && !catalog?.models.some(model =>
    model.provider === thinkingSummaryModel.provider && model.id === thinkingSummaryModel.id && model.available,
  ));
  const toolDisplayOptions: { id: ToolDisplay; label: string }[] = [
    { id: "card", label: text.toolCard },
    { id: "compact", label: text.toolCompact },
  ];
  const toolFoldOptions: { id: ToolFold; label: string }[] = [
    { id: "message", label: text.toolFoldMessage },
    { id: "position", label: text.toolFoldPosition },
  ];
  const thinkingSummaryStyleOptions: { id: ThinkingSummaryStyle; label: string }[] = [
    { id: "inline", label: text.thinkingSummaryStyleInline },
    { id: "headline", label: text.thinkingSummaryStyleHeadline },
    { id: "prose", label: text.thinkingSummaryStyleProse },
  ];

  return (
    <section className="settings-section">
      <SettingsBlock id="tool-display" title={text.toolDisplay} hint={text.toolDisplayHint}>
        <Segmented label={text.toolDisplay} value={toolDisplay} options={toolDisplayOptions} onChange={setToolDisplay} />
      </SettingsBlock>
      <SettingsBlock id="tool-fold" title={text.toolFold} hint={text.toolFoldHint}>
        <Segmented label={text.toolFold} value={toolFold} options={toolFoldOptions} onChange={setToolFold} />
      </SettingsBlock>
      <SettingsBlock id="tool-process-details" title={text.toolProcessDetails} hint={text.toolProcessDetailsHint}>
        <Segmented
          label={text.toolProcessDetails}
          value={toolProcessDetails ? "on" : "off"}
          options={[
            { id: "off", label: text.toolProcessDetailsOff },
            { id: "on", label: text.toolProcessDetailsOn },
          ]}
          onChange={(value) => setToolProcessDetails(value === "on")}
        />
      </SettingsBlock>
      <SettingsBlock id="thinking-summary" title={text.thinkingSummary} hint={text.thinkingSummaryHint}>
        <Segmented
          label={text.thinkingSummary}
          value={thinkingSummary ? "on" : "off"}
          options={[
            { id: "off", label: text.thinkingSummaryOff },
            { id: "on", label: text.thinkingSummaryOn },
          ]}
          onChange={(value) => setThinkingSummary(value === "on")}
        />
      </SettingsBlock>
      <SettingsBlock id="thinking-summary-model" title={text.thinkingSummaryModel} hint={text.thinkingSummaryModelHint}>
        <select
          className="settings-select"
          aria-label={text.thinkingSummaryModel}
          aria-describedby="thinking-summary-model-hint"
          value={thinkingSummaryModel ? modelValue(thinkingSummaryModel.provider, thinkingSummaryModel.id) : ""}
          onChange={(event) => {
            const { provider, modelId } = parseModelValue(event.target.value);
            setThinkingSummaryModel(provider && modelId ? { provider, id: modelId } : null);
          }}
        >
          <option value="">{text.thinkingSummaryModelCurrent}</option>
          {summaryModelMissing && thinkingSummaryModel ? (
            <option value={modelValue(thinkingSummaryModel.provider, thinkingSummaryModel.id)} disabled>
              {thinkingSummaryModel.provider} / {thinkingSummaryModel.id} — {text.thinkingSummaryModelUnavailable}
            </option>
          ) : null}
          {summaryModelGroups.map((group) => (
            <optgroup key={group.provider} label={group.name}>
              {group.models.map((model) => (
                <option key={modelValue(model.provider, model.id)} value={modelValue(model.provider, model.id)}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="settings-note" id="thinking-summary-model-hint">
          {summaryModelMissing ? text.thinkingSummaryModelMissing : text.thinkingSummaryModelConfigure}
        </p>
      </SettingsBlock>
      <SettingsBlock id="thinking-summary-style" title={text.thinkingSummaryStyle} hint={text.thinkingSummaryStyleHint}>
        <Segmented
          label={text.thinkingSummaryStyle}
          value={thinkingSummaryStyle}
          options={thinkingSummaryStyleOptions}
          onChange={setThinkingSummaryStyle}
        />
      </SettingsBlock>
      <IntelligentUiSetting />
    </section>
  );
}

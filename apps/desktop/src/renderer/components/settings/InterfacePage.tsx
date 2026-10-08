import { appLocaleNames, appLocales } from "@vela/shared";
import { setSidebarItem, sidebarItemIds, useSidebarItems } from "../../hooks/useSidebarItems";
import type { AppLocale, InfoLayout, PreferencesApi } from "../../hooks/usePreferences";
import type { ConversationLinkTarget } from "../../browser/conversation-link-policy";
import { notificationSoundKinds, type NotifySound } from "../../notification-sounds";
import type { SettingsCopy } from "../settings-copy";
import { Segmented, SettingsBlock, SettingsSwitch } from "./primitives";

export function InterfacePage({
  copy,
  preferences,
  onPreviewSound,
}: {
  copy: SettingsCopy;
  preferences: PreferencesApi;
  onPreviewSound: NotifySound;
}) {
  const {
    locale,
    setLocale,
    infoLayout,
    setInfoLayout,
    conversationLinkTarget,
    setConversationLinkTarget,
    composerCapsules,
    setComposerCapsules,
    sendButtonIcon,
    setSendButtonIcon,
  } = preferences;
  const text = copy.appearance;
  const sidebarItems = useSidebarItems();
  const soundLabels = {
    error: text.soundError, complete: text.soundComplete,
    question: text.soundQuestion, permission: text.soundPermission,
  };
  const languages: { id: AppLocale; label: string }[] = appLocales.map(id => ({ id, label: appLocaleNames[id] }));
  const infoLayoutOptions: { id: InfoLayout; label: string }[] = [
    { id: "sidebar", label: text.infoLayoutSidebar },
    { id: "floating", label: text.infoLayoutFloating },
  ];
  const conversationLinkOptions: { id: ConversationLinkTarget; label: string }[] = [
    { id: "embedded", label: text.linkEmbedded },
    { id: "external", label: text.linkExternal },
  ];

  return (
    <section className="settings-section">
      <SettingsBlock id="language" title={text.language}>
        <Segmented label={text.language} value={locale} options={languages} onChange={setLocale} />
      </SettingsBlock>
      <SettingsBlock id="sound-effects" title={text.soundEffects} hint={text.soundEffectsHint}>
        <Segmented
          label={text.soundEffects}
          value={preferences.soundEffects ? "on" : "off"}
          options={[{ id: "off", label: text.soundEffectsOff }, { id: "on", label: text.soundEffectsOn }]}
          onChange={value => preferences.setSoundEffects(value === "on")}
        />
        <div className="settings-actions" role="group" aria-label={text.soundPreview}>
          {notificationSoundKinds.map(sound => (
            <button key={sound} type="button" className="settings-secondary" onClick={() => onPreviewSound(sound)}>
              {text.soundPreview}: {soundLabels[sound]}
            </button>
          ))}
        </div>
      </SettingsBlock>
      <SettingsBlock id="info-layout" title={text.infoLayout} hint={text.infoLayoutHint}>
        <Segmented label={text.infoLayout} value={infoLayout} options={infoLayoutOptions} onChange={setInfoLayout} />
      </SettingsBlock>
      <SettingsBlock id="conversation-link-target" title={text.conversationLinkTarget} hint={text.conversationLinkHint}>
        <Segmented label={text.conversationLinkTarget} value={conversationLinkTarget}
          options={conversationLinkOptions} onChange={setConversationLinkTarget} />
      </SettingsBlock>
      <SettingsBlock id="sidebar-items" title={text.sidebarItems} hint={text.sidebarItemsHint}>
        {sidebarItemIds.map(id => (
          <div key={id} className="settings-switch-row">
            <span>{text.sidebarItemLabels[id]}</span>
            <SettingsSwitch
              checked={sidebarItems[id]}
              label={text.sidebarItemLabels[id]}
              onChange={next => setSidebarItem(id, next)}
            />
          </div>
        ))}
      </SettingsBlock>
      <SettingsBlock id="composer-capsules" title={text.composerCapsules} hint={text.composerCapsulesHint}>
        <Segmented
          label={text.composerCapsules}
          value={composerCapsules ? "on" : "off"}
          options={[
            { id: "off", label: text.composerCapsulesOff },
            { id: "on", label: text.composerCapsulesOn },
          ]}
          onChange={(value) => setComposerCapsules(value === "on")}
        />
      </SettingsBlock>
      <SettingsBlock id="send-button-icon" title={text.sendButtonIcon}>
        <Segmented
          label={text.sendButtonIcon}
          value={sendButtonIcon}
          options={[
            { id: "paper-plane", label: text.sendButtonIconPaperPlane },
            { id: "arrow-up", label: text.sendButtonIconArrowUp },
          ]}
          onChange={setSendButtonIcon}
        />
      </SettingsBlock>
    </section>
  );
}

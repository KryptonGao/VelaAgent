import type { ConversationSummary } from "@vela/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import type { useModels } from "../hooks/useModels";
import type { PreferencesApi } from "../hooks/usePreferences";
import type { ProjectApi } from "../hooks/useProject";
import { useAutoHideScrollbar } from "../hooks/useAutoHideScrollbar";
import { useStoredState } from "../hooks/useStoredState";
import { modKeyLabel } from "../platform";
import type { NotifySound } from "../notification-sounds";
import { LoginDialog } from "./ModelControls";
import { SheetPresence } from "./Presence";
import { IntegrationsSection } from "./IntegrationsSection";
import { McpSettingsSection } from "./McpSettingsSection";
import { MemorySettingsSection } from "./MemorySettingsSection";
import { settingsCopy } from "./settings-copy";
import { SettingsUsageView } from "./usage/SettingsUsageView";
import { AgentDefaultsPage } from "./settings/AgentDefaultsPage";
import { AppearancePage } from "./settings/AppearancePage";
import { ArchivedPage } from "./settings/ArchivedPage";
import { ConversationDisplayPage } from "./settings/ConversationDisplayPage";
import { DevelopmentPage } from "./settings/DevelopmentPage";
import { InterfacePage } from "./settings/InterfacePage";
import { LogsPage } from "./settings/LogsPage";
import { ModelsPage } from "./settings/ModelsPage";
import { SettingsNav } from "./settings/SettingsNav";
import { ShortcutsPage } from "./settings/ShortcutsPage";
import { SkillsPage } from "./settings/SkillsPage";
import { WorkspacePage } from "./settings/WorkspacePage";
import {
  isSettingsPageId,
  pagesWithOwnHeader,
  settingsPageIds,
  type SettingsPageId,
} from "./settings/settings-registry";
import { resolveSettingsEntries, searchSettings, type SettingsSearchResult } from "./settings/settings-search";
import { useSettingsJump, type SettingsJumpTarget } from "./settings/useSettingsJump";

type ModelsApi = ReturnType<typeof useModels>;

interface SettingsViewProps {
  onPreviewSound: NotifySound;
  preferences: PreferencesApi;
  platform: string;
  models: ModelsApi;
  project: ProjectApi;
  conversations: ConversationSummary[];
  conversationId?: string | null;
  onUnarchiveConversation: (id: string) => void;
  onClose: () => void;
}

export function SettingsView({
  onPreviewSound,
  preferences,
  platform,
  models,
  project,
  conversations,
  conversationId,
  onUnarchiveConversation,
  onClose,
}: SettingsViewProps) {
  const { locale } = preferences;
  const copy = settingsCopy(locale);
  const mod = modKeyLabel(platform);
  const development = window.vela?.development;
  const pages = useMemo(
    () => settingsPageIds.filter((id) => id !== "development" || development),
    [development],
  );
  const [storedPage, setStoredPage] = useStoredState<SettingsPageId>("vela.settingsPage", "appearance", isSettingsPageId);
  const page = pages.includes(storedPage) ? storedPage : pages[0];
  const [query, setQuery] = useState("");
  const [jump, setJump] = useState<SettingsJumpTarget | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const workspacePath = project.environment?.path ?? project.workspace?.current ?? null;

  const entries = useMemo(
    () => resolveSettingsEntries(copy).filter((entry) => pages.includes(entry.page)),
    [copy, pages],
  );
  const results = useMemo(() => searchSettings(query, entries), [query, entries]);
  useSettingsJump(contentRef, jump, page);
  useAutoHideScrollbar(contentRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platform]);

  function pickResult(result: SettingsSearchResult): void {
    setStoredPage(result.entry.page);
    setQuery("");
    setJump((current) => ({ id: result.entry.id, nonce: (current?.nonce ?? 0) + 1 }));
  }

  function selectPage(id: SettingsPageId): void {
    setJump(null);
    setStoredPage(id);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }

  const pageMeta = copy.pages[page];

  return (
    <main className="settings-view">
      <header className="settings-header">
        <h1>{copy.title}</h1>
        <button className="settings-done" type="button" onClick={onClose}>
          {copy.done}
        </button>
      </header>
      <div className="settings-body">
        <SettingsNav
          copy={copy}
          page={page}
          pages={pages}
          onPage={selectPage}
          query={query}
          onQuery={setQuery}
          results={results}
          onPick={pickResult}
          searchRef={searchRef}
        />
        <div className="settings-content autohide-scrollbar" ref={contentRef}>
          {pagesWithOwnHeader.has(page) ? null : (
            <header className="settings-page-header">
              <h2>{pageMeta.label}</h2>
              <p>{pageMeta.description}</p>
            </header>
          )}
          {page === "integrations" ? <IntegrationsSection locale={locale} workspacePath={workspacePath} conversationId={conversationId} /> : null}
          {page === "mcp" ? <McpSettingsSection locale={locale} workspacePath={workspacePath} conversationId={conversationId} /> : null}
          {page === "memory" ? <MemorySettingsSection locale={locale} conversationId={conversationId} /> : null}
          {page === "usage" ? <SettingsUsageView conversations={conversations} providers={models.catalog?.providers ?? []} /> : null}
          <div hidden={page !== "appearance"}>
            <AppearancePage copy={copy} preferences={preferences} />
          </div>
          <div hidden={page !== "interface"}>
            <InterfacePage copy={copy} preferences={preferences} onPreviewSound={onPreviewSound} />
          </div>
          <div hidden={page !== "shortcuts"}>
            <ShortcutsPage copy={copy} mod={mod} />
          </div>
          <div hidden={page !== "defaults"}>
            <AgentDefaultsPage copy={copy} catalog={models.catalog} project={project} />
          </div>
          <div hidden={page !== "display"}>
            <ConversationDisplayPage copy={copy} preferences={preferences} catalog={models.catalog} />
          </div>
          <div hidden={page !== "skills"}>
            <SkillsPage copy={copy} workspacePath={project.workspace?.current ?? null} />
          </div>
          <div hidden={page !== "models"}>
            <ModelsPage copy={copy} models={models} preferences={preferences} />
          </div>
          <div hidden={page !== "workspace"}>
            <WorkspacePage copy={copy} project={project} />
          </div>
          <div hidden={page !== "archived"}>
            <ArchivedPage
              copy={copy}
              locale={locale}
              conversations={conversations}
              onUnarchive={onUnarchiveConversation}
            />
          </div>
          {page === "logs" ? <LogsPage copy={copy} /> : null}
          {development ? <div hidden={page !== "development"}>
            <DevelopmentPage copy={copy} development={development} />
          </div> : null}
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

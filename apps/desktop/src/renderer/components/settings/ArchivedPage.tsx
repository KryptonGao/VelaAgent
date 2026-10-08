import { intlLocale } from "@vela/shared";
import type { ConversationSummary } from "@vela/shared";
import { useMemo, useState } from "react";
import type { AppLocale } from "../../hooks/usePreferences";
import { tr } from "../../locale";
import type { SettingsCopy } from "../settings-copy";
import { SettingsBlock } from "./primitives";

/** 已归档对话:搜索、取消归档。列表数据来自 AppState.conversations 的归档子集。 */
export function ArchivedPage({
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
    () => new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium" }),
    [locale],
  );

  function unarchive(conversation: ConversationSummary): void {
    setNotice(`${conversation.title || tr("新对话", "New chat")} · ${text.unarchived}`);
    onUnarchive(conversation.id);
  }

  return (
    <section className="settings-section">
      <SettingsBlock id="archived" title={text.title} hint={text.hint}>
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

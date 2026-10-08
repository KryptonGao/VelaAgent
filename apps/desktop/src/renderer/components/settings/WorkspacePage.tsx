import type { ExecutionEnvironmentKind, SelectableEnvironmentKind } from "@vela/shared";
import { useState } from "react";
import type { ProjectApi } from "../../hooks/useProject";
import { localizeError } from "../../locale";
import type { SettingsCopy } from "../settings-copy";
import { SettingsBlock } from "./primitives";

export function WorkspacePage({ copy, project }: { copy: SettingsCopy; project: ProjectApi }) {
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
      <SettingsBlock id="workspace-current" title={text.current}>
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

      <SettingsBlock id="workspace-recent" title={text.recent}>
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

      <SettingsBlock id="workspace-environment" title={text.environment}>
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

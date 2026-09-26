import type { ExternalSkillCandidate, ExternalSkillScan, ExternalSkillSource, SkillMigrationResult } from "@vela/shared";
import { useEffect, useState } from "react";
import type { SettingsCopy } from "./settings-copy";

type AgentCopy = SettingsCopy["agent"];

interface SkillMigrationDialogProps {
  copy: AgentCopy;
  onClose: () => void;
  onDone: (result: SkillMigrationResult) => void;
}

const sources: ExternalSkillSource[] = ["codex", "claude"];

export function SkillMigrationDialog({ copy, onClose, onDone }: SkillMigrationDialogProps) {
  const [scan, setScan] = useState<ExternalSkillScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.vela;
    if (!api) return;
    let active = true;
    void api.scanExternalSkills().then(
      (next) => {
        if (!active) return;
        setScan(next);
        setSelected(new Set(next.skills.filter((skill) => skill.selectable && skill.state === "new").map((skill) => skill.id)));
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : copy.migrateLoadError);
      },
    );
    return () => {
      active = false;
    };
  }, [copy.migrateLoadError]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const chosen = scan?.skills.filter((skill) => selected.has(skill.id)) ?? [];
  const earlierNames = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const skill of scan?.skills ?? []) {
    if (!selected.has(skill.id)) continue;
    if (earlierNames.has(skill.directoryName)) duplicateIds.add(skill.id);
    else earlierNames.add(skill.directoryName);
  }

  function toggle(skill: ExternalSkillCandidate): void {
    if (!skill.selectable || busy) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      return next;
    });
  }

  function toggleGroup(items: ExternalSkillCandidate[]): void {
    const selectable = items.filter((skill) => skill.selectable).map((skill) => skill.id);
    const allOn = selectable.length > 0 && selectable.every((id) => selected.has(id));
    setSelected((current) => {
      const next = new Set(current);
      for (const id of selectable) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function confirm(): Promise<void> {
    const api = window.vela;
    if (!api || !scan || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const ids = scan.skills.map((skill) => skill.id).filter((id) => selected.has(id));
      onDone(await api.migrateSkills(ids));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.migrateLoadError);
      setBusy(false);
    }
  }

  const userRoots = scan?.sources.filter((source) => source.scope === "user") ?? [];

  return (
    <div className="sheet-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
      <div
        className="sheet-card skill-migration-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-migration-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-header">
          <h2 id="skill-migration-title">{copy.migrateTitle}</h2>
          <button className="sheet-close" type="button" onClick={onClose} disabled={busy}>
            {copy.migrateClose}
          </button>
        </header>
        <p className="settings-hint skill-migration-hint">{copy.migrateHint}</p>
        <div className="skill-migration-list">
          {!scan && !error ? <p className="settings-note">{copy.migrateLoading}</p> : null}
          {scan && scan.skills.length === 0 ? (
            <div className="skill-migration-empty">
              <p className="settings-note">{copy.migrateEmpty}</p>
              {userRoots.map((source) => (
                <div key={`${source.source}:${source.scope}`} className="settings-path">{source.root}</div>
              ))}
            </div>
          ) : null}
          {sources.map((source) => {
            const items = scan?.skills.filter((skill) => skill.source === source) ?? [];
            if (items.length === 0) return null;
            const selectable = items.filter((skill) => skill.selectable);
            const allOn = selectable.length > 0 && selectable.every((skill) => selected.has(skill.id));
            return (
              <section key={source} className="skill-migration-group">
                <div className="skill-migration-group-head">
                  <h3>{copy.migrateSources[source]}</h3>
                  {selectable.length > 0 ? (
                    <button className="settings-secondary" type="button" disabled={busy} onClick={() => toggleGroup(items)}>
                      {allOn ? copy.migrateSelectNone : copy.migrateSelectAll}
                    </button>
                  ) : null}
                </div>
                {items.map((skill) => {
                  const checked = selected.has(skill.id);
                  return (
                    <label key={skill.id} className={`skill-migration-row${skill.selectable ? "" : " disabled"}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!skill.selectable || busy}
                        onChange={() => toggle(skill)}
                      />
                      <span className="skill-migration-copy">
                        <span className="settings-radio-title">{skill.name}</span>
                        {skill.description ? <span className="settings-radio-hint skill-migration-desc">{skill.description}</span> : null}
                        <span className="settings-skill-meta">
                          <span>{copy.migrateScopes[skill.scope]}</span>
                          {skill.state !== "new" ? <span>{copy.migrateStates[skill.state]}</span> : null}
                          {skill.directoryName !== skill.name ? <span>{skill.directoryName}</span> : null}
                          {!skill.selectable ? <span>{copy.migrateLocalNote}</span> : null}
                          {skill.selectable && skill.state === "present" ? <span>{copy.migrateReplaceNote}</span> : null}
                          {skill.selectable && skill.state === "loaded" ? <span>{copy.migrateLoadedNote}</span> : null}
                          {duplicateIds.has(skill.id) ? <span>{copy.migrateSameName}</span> : null}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </section>
            );
          })}
          {error ? <p className="settings-error">{error}</p> : null}
        </div>
        <footer className="sheet-footer">
          <span className="settings-note skill-migration-count">{copy.migrateSelected(chosen.length)}</span>
          <button className="settings-secondary" type="button" disabled={busy} onClick={onClose}>
            {copy.migrateCancel}
          </button>
          <button className="primary-btn" type="button" disabled={busy || chosen.length === 0} onClick={() => void confirm()}>
            {busy ? copy.migrating : copy.migrateConfirm}
          </button>
        </footer>
      </div>
    </div>
  );
}

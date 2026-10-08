import type { SkillCatalog, SkillMigrationResult } from "@vela/shared";
import { useEffect, useState } from "react";
import { localizeError } from "../../locale";
import { SheetPresence } from "../Presence";
import { SkillMigrationDialog } from "../SkillMigrationDialog";
import { TrashIcon } from "../icons";
import type { SettingsCopy } from "../settings-copy";
import { SettingsBlock, SettingsSwitch } from "./primitives";

export function SkillsPage({ copy, workspacePath }: { copy: SettingsCopy; workspacePath: string | null }) {
  const text = copy.agent;
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
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

  async function toggleSkill(skill: SkillCatalog["skills"][number]): Promise<void> {
    const api = window.vela;
    if (!api || pending) return;
    setPending(skill.name);
    setActionError(null);
    setConfirmingDelete(null);
    try {
      setCatalog(await api.setSkillEnabled(skill.name, !skill.enabled));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : text.skillsLoadError);
    } finally {
      setPending(null);
    }
  }

  async function deleteSkill(skill: SkillCatalog["skills"][number]): Promise<void> {
    const api = window.vela;
    if (!api || pending) return;
    if (confirmingDelete !== skill.name) {
      setConfirmingDelete(skill.name);
      setActionError(null);
      return;
    }
    setPending(skill.name);
    setActionError(null);
    try {
      setCatalog(await api.deleteSkill(skill.name, skill.location));
      setConfirmingDelete(null);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : text.skillsLoadError);
    } finally {
      setPending(null);
    }
  }

  return (
    <SettingsBlock id="skills" title={text.skills} hint={text.skillsHint}>
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
            <SkillRow
              key={skill.location}
              skill={skill}
              copy={text}
              originLabel={text.skillOrigins[skill.origin]}
              commandOnly={text.skillCommandOnly}
              pending={pending === skill.name}
              confirmingDelete={confirmingDelete === skill.name}
              onToggle={() => void toggleSkill(skill)}
              onDelete={() => void deleteSkill(skill)}
            />
          ))}
        </div>
      ) : null}
      {actionError ? <p className="settings-error">{localizeError(actionError)}</p> : null}
      {catalog && catalog.skills.some((skill) => !skill.canDelete) ? (
        <p className="settings-note">{text.skillDeleteNote}</p>
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
  copy,
  originLabel,
  commandOnly,
  pending,
  confirmingDelete,
  onToggle,
  onDelete,
}: {
  skill: SkillCatalog["skills"][number];
  copy: SettingsCopy["agent"];
  originLabel: string;
  commandOnly: string;
  pending: boolean;
  confirmingDelete: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`settings-skill${skill.enabled ? "" : " disabled"}`}>
      <div className="settings-skill-main">
        <span className="settings-radio-title">
          {skill.name}
          {skill.enabled ? null : <span className="settings-skill-state">{copy.skillDisabled}</span>}
        </span>
        <span className="settings-radio-hint">{skill.description}</span>
        <span className="settings-skill-meta">
          <span>{originLabel}</span>
          {skill.disableModelInvocation ? <span>{commandOnly}</span> : null}
        </span>
      </div>
      <div className="settings-skill-actions">
        <SettingsSwitch
          checked={skill.enabled}
          label={skill.enabled ? copy.skillDisable : copy.skillEnable}
          title={copy.skillToggleHint}
          disabled={pending}
          onChange={onToggle}
        />
        {skill.canDelete ? (
          <button
            type="button"
            className={`settings-skill-remove${confirmingDelete ? " confirm" : ""}`}
            aria-label={confirmingDelete ? copy.skillDeleteConfirm : copy.skillDelete}
            title={copy.skillDeleteHint}
            disabled={pending}
            onClick={onDelete}
          >
            {confirmingDelete ? copy.skillDeleteConfirm : <TrashIcon size={13} />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

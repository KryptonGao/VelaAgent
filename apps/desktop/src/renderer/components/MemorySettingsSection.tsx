/**
 * 设置页的“记忆”管理：全部记忆列表、全局与项目编辑。
 *
 * 草稿按目标保存在界面存储里，切换作用域或关闭设置不会静默丢失；
 * 保存和删除都携带读取时的 revision，冲突时保留草稿并提示重新加载。
 */
import { memoryFileMaxBytes, type MemoryCatalog, type MemoryCatalogEntry, type MemoryDocument, type MemoryFailure, type MemoryScope } from "@vela/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AppLocale } from "../hooks/usePreferences";
import { settingsCopy } from "./settings-copy";
import {
  clearMemoryDraft,
  memoryBytes,
  memoryCatalogEntryLabel,
  memoryCatalogEntryStatus,
  memoryDraftKey,
  memoryErrorText,
  memoryOverLimit,
  memoryParentDirectory,
  memoryUnexpectedError,
  readMemoryDraft,
  writeMemoryDraft,
} from "./memory-settings-model";

type MemoryView = "all" | "global" | "project";

interface MemoryTargetState {
  scope: MemoryScope;
  workspace: string | null;
}

const memoryViewOrder: MemoryView[] = ["all", "global", "project"];

export interface MemorySettingsSectionProps {
  locale: AppLocale;
  conversationId?: string | null;
}

export function MemorySettingsSection({ locale, conversationId }: MemorySettingsSectionProps) {
  const copy = settingsCopy(locale).memory;
  const api = window.vela?.memory;
  const [catalog, setCatalog] = useState<MemoryCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<MemoryView>("all");
  const [project, setProject] = useState<string | null>(null);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<MemoryFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const alive = useRef(true);
  const catalogSequence = useRef(0);
  const editorSequence = useRef(0);
  const tabsRef = useRef<HTMLDivElement>(null);

  const activeProject = view === "project"
    ? project ?? catalog?.currentProject ?? catalog?.workspaces[0]?.workspace ?? null
    : null;
  const target = useMemo<MemoryTargetState | null>(() => {
    if (view === "global") return { scope: "global", workspace: null };
    if (view === "project" && activeProject) return { scope: "project", workspace: activeProject };
    return null;
  }, [view, activeProject]);
  const targetKey = target ? memoryDraftKey(target.scope, target.workspace) : null;
  const documentMatchesTarget = Boolean(
    target && document && document.scope === target.scope && (document.workspace ?? null) === target.workspace,
  );
  const dirty = documentMatchesTarget && document !== null && draft !== document.content;

  const refreshCatalog = useCallback(async (): Promise<void> => {
    if (!api) {
      setLoading(false);
      return;
    }
    const request = ++catalogSequence.current;
    setLoading(true);
    try {
      const result = await api.list({ conversationId: conversationId ?? null });
      if (!alive.current || request !== catalogSequence.current) return;
      if (!result.ok) {
        setCatalog(null);
        setCatalogError(memoryErrorText(result.error, copy));
        return;
      }
      setCatalog(result.value);
      setCatalogError(null);
    } catch (error) {
      if (alive.current && request === catalogSequence.current) setCatalogError(memoryUnexpectedError(error, copy));
    } finally {
      if (alive.current && request === catalogSequence.current) setLoading(false);
    }
  }, [api, conversationId, copy]);

  async function toggleMemory(): Promise<void> {
    if (!api || !catalog || toggleBusy || loading) return;
    setToggleBusy(true);
    setToggleError(null);
    try {
      const result = await api.setEnabled({ enabled: !catalog.enabled });
      if (!alive.current) return;
      if (!result.ok) {
        setToggleError(memoryErrorText(result.error, copy));
        return;
      }
      setCatalog((current) => current ? { ...current, enabled: result.value.enabled } : current);
    } catch (error) {
      if (alive.current) setToggleError(memoryUnexpectedError(error, copy));
    } finally {
      if (alive.current) setToggleBusy(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void refreshCatalog();
    return () => {
      alive.current = false;
      catalogSequence.current++;
      editorSequence.current++;
    };
  }, [refreshCatalog]);

  // 目录更新后保持有效的项目选择：优先当前会话的项目，其次第一个已登记工作区。
  useEffect(() => {
    if (!catalog) return;
    setProject((current) => {
      if (current && catalog.workspaces.some((entry) => entry.workspace === current)) return current;
      if (catalog.currentProject && catalog.workspaces.some((entry) => entry.workspace === catalog.currentProject)) {
        return catalog.currentProject;
      }
      return catalog.workspaces[0]?.workspace ?? null;
    });
  }, [catalog]);

  const loadDocument = useCallback(async (next: MemoryTargetState, options?: { discardDraft?: boolean }): Promise<void> => {
    setEditorError(null);
    setNotice(null);
    setConfirmRemove(false);
    if (!api) return;
    const request = ++editorSequence.current;
    setEditorLoading(true);
    try {
      const result = await api.read({ scope: next.scope, workspace: next.workspace });
      if (!alive.current || request !== editorSequence.current) return;
      if (!result.ok) {
        setDocument(null);
        setDraft("");
        setEditorError(result.error);
        return;
      }
      const loaded = result.value;
      const key = memoryDraftKey(loaded.scope, loaded.workspace);
      const stored = options?.discardDraft ? null : readMemoryDraft(key);
      if (options?.discardDraft) clearMemoryDraft(key);
      setDocument(loaded);
      setDraft(stored && stored.content !== loaded.content ? stored.content : loaded.content);
    } catch (error) {
      if (alive.current && request === editorSequence.current) {
        setEditorError({ code: "io-error", message: memoryUnexpectedError(error, copy), path: null });
      }
    } finally {
      if (alive.current && request === editorSequence.current) setEditorLoading(false);
    }
  }, [api, copy]);

  useEffect(() => {
    if (!target) return;
    void loadDocument(target);
  }, [target, loadDocument]);

  // 草稿快照：目标切换或卸载时把上一份未保存内容写入界面存储。
  const snapshot = useRef<{ key: string; document: MemoryDocument | null; draft: string }>({ key: "", document: null, draft: "" });
  useEffect(() => {
    const previous = snapshot.current;
    if (previous.key && previous.key !== (targetKey ?? "") && previous.document) {
      writeDraft(previous.key, previous.document, previous.draft);
    }
    snapshot.current = documentMatchesTarget && document
      ? { key: targetKey ?? "", document, draft }
      : { key: "", document: null, draft: "" };
  });

  useEffect(() => {
    if (!targetKey || !documentMatchesTarget || !document) return;
    const timer = window.setTimeout(() => writeDraft(targetKey, document, draft), 500);
    return () => window.clearTimeout(timer);
  }, [targetKey, document, draft, documentMatchesTarget]);

  useEffect(() => () => {
    const entry = snapshot.current;
    if (entry.key && entry.document) writeDraft(entry.key, entry.document, entry.draft);
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (!api || !target || !document || !documentMatchesTarget || busy) return;
    if (memoryOverLimit(draft)) {
      setEditorError({ code: "content-too-large", message: copy.overLimit, path: document.path });
      return;
    }
    setBusy(true);
    setEditorError(null);
    setNotice(null);
    try {
      const result = await api.save({
        scope: target.scope,
        workspace: target.workspace,
        content: draft,
        expectedRevision: document.revision,
      });
      if (!result.ok) {
        setEditorError(result.error);
        return;
      }
      clearMemoryDraft(memoryDraftKey(result.value.scope, result.value.workspace));
      setDocument(result.value);
      setDraft(result.value.content);
      setNotice(copy.saved);
      void refreshCatalog();
    } catch (error) {
      setEditorError({ code: "io-error", message: memoryUnexpectedError(error, copy), path: null });
    } finally {
      setBusy(false);
    }
  }, [api, target, document, documentMatchesTarget, busy, draft, copy, refreshCatalog]);

  const remove = useCallback(async (): Promise<void> => {
    if (!api || !target || !document || !documentMatchesTarget || busy) return;
    setBusy(true);
    setEditorError(null);
    setNotice(null);
    setConfirmRemove(false);
    try {
      const result = await api.remove({
        scope: target.scope,
        workspace: target.workspace,
        expectedRevision: document.revision,
      });
      if (!result.ok) {
        setEditorError(result.error);
        return;
      }
      clearMemoryDraft(memoryDraftKey(document.scope, document.workspace));
      await loadDocument(target, { discardDraft: true });
      setNotice(copy.removed);
      void refreshCatalog();
    } catch (error) {
      setEditorError({ code: "io-error", message: memoryUnexpectedError(error, copy), path: null });
    } finally {
      setBusy(false);
    }
  }, [api, target, document, documentMatchesTarget, busy, copy, loadDocument, refreshCatalog]);

  function cancel(): void {
    if (!document) return;
    clearMemoryDraft(memoryDraftKey(document.scope, document.workspace));
    setDraft(document.content);
    setEditorError(null);
    setNotice(null);
    setConfirmRemove(false);
  }

  async function reveal(): Promise<void> {
    const open = window.vela?.openInTarget;
    if (!document || !open) {
      setNotice(copy.revealError);
      return;
    }
    const candidates = [memoryParentDirectory(document.path)];
    if (document.scope === "project" && document.workspace) candidates.push(document.workspace);
    for (const candidate of candidates) {
      try {
        await open("finder", candidate);
        return;
      } catch {
        // 尝试下一个候选目录。
      }
    }
    setNotice(copy.revealError);
  }

  function openEntry(entry: MemoryCatalogEntry): void {
    if (entry.scope === "global") {
      setView("global");
      return;
    }
    if (entry.workspace) setProject(entry.workspace);
    setView("project");
  }

  function onTabsKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = memoryViewOrder.indexOf(view);
    const step = event.key === "ArrowRight" ? 1 : memoryViewOrder.length - 1;
    const next = memoryViewOrder[(index + step) % memoryViewOrder.length]!;
    setView(next);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLButtonElement>(`[data-memory-tab="${next}"]`)?.focus());
  }

  const draftBadges = useMemo(() => {
    const keys = new Set<string>();
    if (!catalog) return keys;
    for (const entry of [catalog.global, ...catalog.projects]) {
      const key = memoryDraftKey(entry.scope, entry.workspace);
      if (readMemoryDraft(key)) keys.add(key);
    }
    return keys;
  }, [catalog, view]);

  if (!api) {
    return (
      <section className="settings-section memory-settings">
        <p className="settings-note">{copy.unavailable}</p>
      </section>
    );
  }

  function renderEditorBody() {
    if (editorLoading) return <p className="settings-note" role="status">{copy.loadingFile}</p>;
    if (editorError && (!document || !documentMatchesTarget)) {
      return <p className="settings-error" role="alert">{memoryErrorText(editorError, copy)}</p>;
    }
    if (!document || !documentMatchesTarget || !target) return null;
    const revision = document.revision.replace(/^sha256:/, "").slice(0, 12);
    return (
      <div className="memory-editor">
        <p className="settings-path">{document.path}</p>
        <p className="settings-hint">
          {document.exists ? copy.fileStatus(memoryBytes(document.content)) : copy.statusMissing}
          {document.exists ? ` · ${copy.revisionLabel} ${revision}` : ""}
          {dirty ? ` · ${copy.dirty}` : ""}
        </p>
        <textarea
          className="settings-textarea memory-editor-input"
          value={draft}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label={copy.editorLabel}
          onChange={(event) => {
            setDraft(event.target.value);
            setEditorError(null);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              if (dirty && !busy) void save();
            }
          }}
        />
        <p className="settings-hint">
          {copy.editorHint} · {copy.byteCount(memoryBytes(draft))} / {memoryFileMaxBytes / 1024} KiB
        </p>
        {editorError ? (
          <div className="memory-error">
            <p className="settings-error" role="alert">{memoryErrorText(editorError, copy)}</p>
            {editorError.code === "conflict" && target ? (
              <button className="settings-secondary" type="button" disabled={busy} onClick={() => void loadDocument(target, { discardDraft: true })}>
                {copy.reload}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="settings-actions">
          <button className="primary-btn" type="button" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? copy.saving : copy.save}
          </button>
          <button className="settings-secondary" type="button" disabled={busy || !dirty} onClick={cancel}>
            {copy.cancel}
          </button>
          <button className="settings-secondary" type="button" disabled={busy || draft.length === 0} onClick={() => setDraft("")}>
            {copy.clear}
          </button>
          <button className="settings-secondary settings-danger" type="button" disabled={busy || !document.exists} onClick={() => setConfirmRemove(true)}>
            {copy.remove}
          </button>
          <button className="settings-secondary" type="button" disabled={busy} onClick={() => void reveal()}>
            {copy.reveal}
          </button>
        </div>
        {confirmRemove ? (
          <div className="memory-confirm" role="alertdialog" aria-label={copy.remove}>
            <p>{copy.removeConfirm}</p>
            <div className="settings-actions">
              <button className="settings-danger" type="button" autoFocus disabled={busy} onClick={() => void remove()}>
                {busy ? copy.removing : copy.confirmRemove}
              </button>
              <button className="settings-secondary" type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>
                {copy.cancel}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function renderProjectEditor() {
    if (!catalog) return <p className="settings-note" role="status">{copy.loading}</p>;
    if (catalog.workspaces.length === 0) {
      return (
        <div className="settings-block">
          <p className="settings-hint">{copy.projectHint}</p>
          <p className="settings-note">{copy.noWorkspace}</p>
        </div>
      );
    }
    return (
      <div className="settings-block">
        <p className="settings-hint">{copy.projectHint}</p>
        <label className="memory-project">
          <span>{copy.projectLabel}</span>
          <select value={activeProject ?? ""} disabled={busy} onChange={(event) => setProject(event.target.value)}>
            {catalog.workspaces.map((entry) => (
              <option key={entry.workspace} value={entry.workspace}>
                {entry.name} · {entry.workspace}{entry.available ? "" : ` · ${copy.statusFailed}`}
              </option>
            ))}
          </select>
        </label>
        {renderEditorBody()}
      </div>
    );
  }

  return (
    <section className="settings-section memory-settings">
      <div className="settings-block">
        <h2>{copy.title}</h2>
        <p className="settings-hint">{copy.hint}</p>
      </div>
      <div className="settings-block memory-toggle-block" data-setting-id="memory-enabled">
        <div className="memory-toggle-row">
          <span id="memory-enabled-label">{copy.enabledLabel}</span>
          <div className="settings-skill-actions">
            <span className="settings-note" role="status">
              {toggleBusy ? copy.toggleSaving : catalog ? catalog.enabled ? copy.enabledStatus : copy.disabledStatus : copy.loading}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={catalog?.enabled ?? false}
              aria-labelledby="memory-enabled-label"
              aria-describedby="memory-enabled-hint"
              className={`settings-skill-toggle${catalog?.enabled ? " on" : ""}`}
              disabled={!catalog || loading || toggleBusy}
              onClick={() => void toggleMemory()}
            >
              <span className="settings-skill-toggle-knob" />
            </button>
          </div>
        </div>
        <p className="settings-hint" id="memory-enabled-hint">{copy.enabledHint}</p>
        {toggleError ? <p className="settings-error" role="alert">{toggleError}</p> : null}
      </div>
      <div className="memory-tabs" role="tablist" aria-label={copy.title} ref={tabsRef} onKeyDown={onTabsKeyDown}>
        {memoryViewOrder.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`memory-tab-${id}`}
            data-memory-tab={id}
            aria-selected={view === id}
            aria-controls={`memory-panel-${id}`}
            tabIndex={view === id ? 0 : -1}
            className={`memory-tab${view === id ? " active" : ""}`}
            onClick={() => setView(id)}
          >
            {copy.tabs[id]}
          </button>
        ))}
      </div>
      {catalogError ? <p className="settings-error" role="alert">{catalogError}</p> : null}
      <div role="status" aria-live="polite">
        {notice ? <p className="settings-saved">{notice}</p> : null}
      </div>
      <div className="settings-actions">
        <button className="settings-secondary" type="button" disabled={busy || loading || toggleBusy} onClick={() => void refreshCatalog()}>
          {loading ? copy.loading : copy.refresh}
        </button>
      </div>
      <div role="tabpanel" id={`memory-panel-${view}`} aria-labelledby={`memory-tab-${view}`}>
        {view === "all" ? (
          <div className="settings-block">
            <p className="settings-hint">{copy.allHint}</p>
            {catalog ? (
              <div className="settings-stack">
                {[catalog.global, ...catalog.projects].map((entry) => {
                  const key = memoryDraftKey(entry.scope, entry.workspace);
                  return (
                    <button key={key} type="button" className="memory-entry" onClick={() => openEntry(entry)}>
                      <span className="memory-entry-main">
                        <span className="memory-entry-name">
                          <span className="memory-entry-scope">{entry.scope === "global" ? copy.scopeGlobal : copy.scopeProject}</span>
                          {memoryCatalogEntryLabel(entry, copy)}
                        </span>
                        <span className="memory-entry-path">{entry.path}</span>
                      </span>
                      <span className="memory-entry-meta">
                        {draftBadges.has(key) ? <span className="memory-entry-draft">{copy.draftBadge}</span> : null}
                        <span className={`memory-entry-status is-${entry.status}`}>{memoryCatalogEntryStatus(entry, copy)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : loading ? (
              <p className="settings-note" role="status">{copy.loading}</p>
            ) : null}
          </div>
        ) : view === "global" ? (
          <div className="settings-block">
            <p className="settings-hint">{copy.globalHint}</p>
            {renderEditorBody()}
          </div>
        ) : renderProjectEditor()}
      </div>
    </section>
  );
}

/** 未保存写草稿；与磁盘一致时清掉草稿，避免留下过期内容。 */
function writeDraft(key: string, document: MemoryDocument, draft: string): void {
  if (draft === document.content) clearMemoryDraft(key);
  else writeMemoryDraft(key, draft, document.revision);
}

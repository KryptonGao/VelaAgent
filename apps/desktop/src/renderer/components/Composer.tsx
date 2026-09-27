import type {
  ContextUsage,
  FileAttachmentPayload,
  ImageAttachment,
  InteractionMode,
  SkillSummary,
  ThinkingLevel,
} from "@vela/shared";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { useModels } from "../hooks/useModels";
import type { ProjectApi } from "../hooks/useProject";
import { CloseIcon, FileIcon, SendIcon } from "./icons";
import { ModelControls } from "./ModelControls";
import { ApprovalSlot } from "./composer/ApprovalBanner";
import { AttachMenu } from "./composer/AttachMenu";
import { BranchChip } from "./composer/BranchChip";
import { ComposerStatsRow } from "./composer/ComposerStatsRow";
import { EnvironmentChip } from "./composer/EnvironmentChip";
import { ModeChip } from "./composer/ModeChip";
import { SandboxPill } from "./composer/SandboxPill";
import { SkillMenu, SkillToken } from "./composer/SkillMenu";
import { WorkspaceChip } from "./composer/WorkspaceChip";
import { applySkillPick, composeSkillPrompt, filterSkills, slashTokenAt } from "./composer/skill-picker";
import { localizeError, tr } from "../locale";

export interface ComposerProps {
  disabled: boolean;
  streaming: boolean;
  model: string | null | undefined;
  modelProvider: string | null;
  modelId: string | null;
  modelReady: boolean;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  models: ReturnType<typeof useModels>;
  mode: InteractionMode;
  sendError: string | null;
  /** 会话统计条数据，来自主进程的 Context 用量快照。 */
  usage: ContextUsage | null;
  project: ProjectApi;
  onSend: (text: string, images?: ImageAttachment[]) => Promise<void>;
  onAbort: () => Promise<void>;
  onMode: (mode: InteractionMode) => void;
}

export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer({
  disabled,
  streaming,
  model,
  modelProvider,
  modelId,
  modelReady,
  thinkingLevel,
  thinkingLevels,
  models,
  mode,
  sendError,
  usage,
  project,
  onSend,
  onAbort,
  onMode,
}, ref) {
  const [value, setValue] = useState("");
  const [skill, setSkill] = useState<SkillSummary | null>(null);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [slash, setSlash] = useState<ReturnType<typeof slashTokenAt>>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [attachments, setAttachments] = useState<FileAttachmentPayload[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const skillRequest = useRef(0);
  const dragCounter = useRef(0);
  const workspacePath = project.workspace?.current ?? null;
  const slashKey = slash ? `${slash.start}:${slash.query}` : "";
  const menuOpen = Boolean(slash) && dismissedKey !== slashKey && (!disabled || streaming);
  const filtered = useMemo(() => (skills === null ? [] : filterSkills(skills, slash?.query ?? "")), [skills, slash?.query]);
  const safeIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);
  const prompt = composeSkillPrompt(skill?.name ?? null, value);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }, [value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [slash?.start, slash?.query]);

  useEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [value]);

  useEffect(() => {
    if (!skill || !skills) return;
    if (!skills.some((item) => item.location === skill.location)) setSkill(null);
  }, [skill, skills]);

  useEffect(() => {
    const api = window.vela;
    if (!api) {
      setSkills([]);
      return;
    }
    const id = ++skillRequest.current;
    let active = true;
    void api.listSkills().then(
      (catalog) => {
        if (!active || skillRequest.current !== id) return;
        setSkills(catalog.skills);
        setSkillsError(null);
      },
      (caught: unknown) => {
        if (!active || skillRequest.current !== id) return;
        setSkillsError(caught instanceof Error ? caught.message : "无法读取 Skill");
      },
    );
    return () => {
      active = false;
    };
  }, [workspacePath, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || inputRef.current?.contains(target)) return;
      setDismissedKey(slashKey);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen, slashKey]);

  function addAttachments(payloads: FileAttachmentPayload[]): void {
    setAttachments((current) => {
      const known = new Set(current.map((entry) => entry.path));
      const merged = [...current];
      for (const payload of payloads) {
        if (payload.path && known.has(payload.path)) continue;
        known.add(payload.path);
        merged.push(payload);
      }
      return merged.slice(0, 12);
    });
  }

  async function handleDrop(event: React.DragEvent): Promise<void> {
    event.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const api = window.vela;
    if (!api) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const paths = files
      .map((file) => api.pathForFile(file))
      .filter((path) => path && !path.startsWith("/dev/"));
    if (paths.length === 0) return;
    const payloads = await api.hydrateAttachments(paths).catch(() => []);
    if (payloads.length > 0) addAttachments(payloads);
  }

  async function handlePaste(event: React.ClipboardEvent): Promise<void> {
    const images = Array.from(event.clipboardData.items).filter((item) =>
      item.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    event.preventDefault();
    const payloads: FileAttachmentPayload[] = [];
    for (const item of images.slice(0, 6)) {
      const file = item.getAsFile();
      if (!file) continue;
      const data = await readAsBase64(file);
      if (data) {
        payloads.push({
          path: "",
          name: file.name || tr("粘贴的图片", "Pasted image"),
          kind: "image",
          image: { type: "image", data, mimeType: item.type },
        });
      }
    }
    addAttachments(payloads);
  }

  function selectSkill(nextSkill: SkillSummary): void {
    if (!slash) return;
    const next = applySkillPick(value, slash);
    pendingCaret.current = next.caret;
    setSkill(nextSkill);
    setValue(next.text);
    setSlash(null);
    setDismissedKey(null);
  }

  async function submit(): Promise<void> {
    const text = composeSkillPrompt(skill?.name ?? null, value);
    if (!text || disabled || streaming || !modelReady) return;
    const images = attachments
      .map((entry) => entry.image)
      .filter((image): image is ImageAttachment => image !== null);
    setValue("");
    setSlash(null);
    setSkill(null);
    setAttachments([]);
    await onSend(text, images.length > 0 ? images : undefined);
  }

  const showError = sendError ? localizeError(sendError) : project.error ? localizeError(project.error) : null;
  const sendHint = disabled
    ? tr("会话还没有准备好", "Chat is not ready yet")
    : !modelReady
      ? tr("先选择一个可用的模型", "Choose an available model first")
      : !prompt
        ? tr("输入内容后发送", "Enter a message to send")
        : tr("发送 (Enter)", "Send (Enter)");

  return (
    <div className="chat-dock-wrapper" ref={ref}>
      <form
        className={`floating-input-card${dragging ? " dragging" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          dragCounter.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragCounter.current -= 1;
          if (dragCounter.current <= 0) setDragging(false);
        }}
        onDrop={(event) => void handleDrop(event)}
      >
        <ApprovalSlot approval={project.approval} onReply={project.replyApproval} />

        <div className="composer-status-bar">
          <WorkspaceChip project={project} />
          <EnvironmentChip project={project} />
          <BranchChip project={project} />
          {showError ? (
            <span className="composer-status-notice" role="alert" title={showError}>
              {showError}
            </span>
          ) : null}
        </div>

        {menuOpen ? (
          <div className="skill-menu-anchor" ref={menuRef}>
            <SkillMenu
              skills={skills === null ? null : filtered}
              error={skillsError}
              query={slash?.query ?? ""}
              activeIndex={safeIndex}
              onActiveIndex={setActiveIndex}
              onSelect={selectSkill}
            />
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="attachment-row">
            {attachments.map((entry, index) => (
              <div className={`attachment-chip attachment-${entry.kind}`} key={`${entry.path}-${index}`}>
                {entry.image ? (
                  <img
                    className="attachment-thumb"
                    src={`data:${entry.image.mimeType};base64,${entry.image.data}`}
                    alt={entry.name}
                  />
                ) : (
                  <span className="attachment-file-icon">
                    <FileIcon size={12} />
                  </span>
                )}
                <span className="attachment-name" title={entry.path || entry.name}>
                  {entry.name}
                </span>
                <button
                  type="button"
                  className="attachment-remove"
                  title={tr("移除附件", "Remove attachment")}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="composer-entry">
          {skill ? (
            <SkillToken
              name={skill.name}
              description={skill.description}
              onRemove={() => {
                setSkill(null);
                inputRef.current?.focus();
              }}
            />
          ) : null}
          <textarea
            id="prompt"
            ref={inputRef}
            className={`input-textarea${skill ? " with-skill" : ""}`}
            placeholder={skill ? "" : placeholderFor(mode)}
            aria-label={tr("输入消息", "Message")}
            rows={1}
            value={value}
            disabled={disabled && !streaming}
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "skill-menu" : undefined}
            aria-activedescendant={menuOpen && filtered[safeIndex] ? `skill-option-${safeIndex}` : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setValue(next);
              setSlash(slashTokenAt(next, event.target.selectionStart ?? next.length));
            }}
            onSelect={(event) => {
              const input = event.currentTarget;
              setSlash(slashTokenAt(input.value, input.selectionStart ?? input.value.length));
            }}
            onFocus={() => setDismissedKey(null)}
            onPaste={(event) => void handlePaste(event)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key === "Process") return;
              if (menuOpen && filtered.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const last = filtered.length - 1;
                setActiveIndex(event.key === "ArrowDown"
                  ? (safeIndex >= last ? 0 : safeIndex + 1)
                  : (safeIndex <= 0 ? last : safeIndex - 1));
                return;
              }
              if (menuOpen && event.key === "Escape") {
                event.preventDefault();
                setDismissedKey(slashKey);
                return;
              }
              if (menuOpen && filtered.length > 0 && !event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                const picked = filtered[safeIndex];
                if (picked) selectSkill(picked);
                return;
              }
              if (!menuOpen && event.key === "Backspace" && skill) {
                const input = event.currentTarget;
                if (input.selectionStart === 0 && input.selectionEnd === 0) {
                  event.preventDefault();
                  setSkill(null);
                  return;
                }
              }
              if (menuOpen && skills === null && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        <div className="dock-controls-row">
          <div className="dock-controls-left">
            <AttachMenu onAttachments={addAttachments} disabled={streaming} />
            <ModeChip mode={mode} disabled={disabled || streaming} onChange={onMode} />
            <SandboxPill project={project} />
          </div>
          <div className="dock-controls-right">
            <ModelControls
              modelLabel={model ?? null}
              modelProvider={modelProvider}
              modelId={modelId}
              thinkingLevel={thinkingLevel}
              thinkingLevels={thinkingLevels}
              disabled={streaming}
              catalog={models.catalog}
              catalogError={models.catalogError}
              actionError={models.actionError}
              login={models.login}
              onSelect={models.select}
              onThinking={models.setThinking}
              onAdd={models.add}
              onRemove={models.remove}
              onLogout={models.logout}
              onLogin={models.loginProvider}
              onReplyLogin={models.replyLogin}
              onCancelLogin={models.cancelLogin}
              onDismissLogin={models.dismissLogin}
            />
            {streaming ? (
              <button
                className="send-action-blue-btn stop"
                type="button"
                title={tr("停止生成", "Stop generating")}
                aria-label={tr("停止生成", "Stop generating")}
                onClick={() => void onAbort()}
              >
                <span className="stop-square" />
              </button>
            ) : (
              <button
                className="send-action-blue-btn"
                type="submit"
                title={sendHint}
                aria-label={tr("发送", "Send")}
                disabled={disabled || !modelReady || !prompt}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>

        <ComposerStatsRow usage={usage} />
      </form>
    </div>
  );
});

function placeholderFor(mode: InteractionMode): string {
  if (mode === "plan") return tr("描述你想规划的改动", "Describe the change you want to plan");
  if (mode === "goal") return tr("描述要达成的目标", "Describe the goal you want to achieve");
  return tr("随心输入", "Ask anything or describe a task");
}

function readAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

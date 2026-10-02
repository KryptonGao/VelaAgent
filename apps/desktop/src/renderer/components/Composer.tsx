import type {
  ContextUsage,
  FileAttachmentPayload,
  ImageAttachment,
  InteractionMode,
  RuntimeInstruction,
  RuntimeInstructionMode,
  SkillSummary,
  ThinkingLevel,
} from "@vela/shared";
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { useModels } from "../hooks/useModels";
import type { ProjectApi } from "../hooks/useProject";
import { CloseIcon, FileIcon, SendIcon, SteerIcon } from "./icons";
import { MotionList } from "./BatchMotion";
import { useReducedMotion } from "../hooks/useMotionPresence";
import { PopoverPresence } from "./MotionPresence";
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
import { modKeyLabel } from "../platform";
import { localizeError, tr } from "../locale";

export interface ComposerProps {
  disabled: boolean;
  streaming: boolean;
  /** 用于把快捷键提示里的修饰键适配成当前平台。 */
  platform: string;
  /** 已提交、等待执行的排队/调整指令。 */
  instructions: RuntimeInstruction[];
  /** 工作区、执行环境和分支仅在当前聊天第一轮开始前显示。 */
  showSetupControls: boolean;
  model: string | null | undefined;
  modelProvider: string | null;
  modelId: string | null;
  modelReady: boolean;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  /** 在输入框模型列表中隐藏的模型，key 为 `provider/id`。 */
  hiddenModels: string[];
  models: ReturnType<typeof useModels>;
  mode: InteractionMode;
  sendError: string | null;
  /** 会话统计条数据，来自主进程的 Context 用量快照。 */
  usage: ContextUsage | null;
  contextPopover?: boolean;
  project: ProjectApi;
  onSend: (text: string, images?: ImageAttachment[], deliverAs?: RuntimeInstructionMode) => Promise<void>;
  /** 撤销一条还没被模型消费的排队/调整指令。 */
  onRemoveInstruction: (instructionId: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onMode: (mode: InteractionMode) => void;
}

export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer({
  disabled,
  streaming,
  platform,
  instructions,
  showSetupControls,
  model,
  modelProvider,
  modelId,
  modelReady,
  thinkingLevel,
  thinkingLevels,
  hiddenModels,
  models,
  mode,
  sendError,
  usage,
  contextPopover = false,
  project,
  onSend,
  onRemoveInstruction,
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
  const reducedMotion = useReducedMotion();
  const measuredInput = useRef(false);
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

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const currentHeight = input.getBoundingClientRect().height;
    // Measure at natural height without animating the temporary auto value.
    input.style.transition = "none";
    input.style.height = "auto";
    const targetHeight = Math.min(input.scrollHeight, 140);
    input.style.height = `${currentHeight}px`;
    void input.offsetHeight;
    input.style.transition = measuredInput.current && !reducedMotion ? "" : "none";
    input.style.height = `${targetHeight}px`;
    measuredInput.current = true;
    const observer = new ResizeObserver(() => {
      // Width changes (sidebar resize/window resize) can change line wrapping too.
      if (Math.abs(input.getBoundingClientRect().width - measuredWidth) < 1) return;
      measuredWidth = input.getBoundingClientRect().width;
      input.style.transition = "none";
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
      input.style.transition = "";
    });
    let measuredWidth = input.getBoundingClientRect().width;
    observer.observe(input);
    return () => observer.disconnect();
  }, [value, skill, reducedMotion]);

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
    if (!skills.some((item) => item.location === skill.location && item.enabled)) setSkill(null);
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
      // 粘贴图片没有路径，用图片数据本身去重，避免同一张图被剪贴板的多个表示重复加入。
      const keyOf = (entry: FileAttachmentPayload) => entry.path || entry.image?.data || entry.name;
      const known = new Set(current.map(keyOf));
      const merged = [...current];
      for (const payload of payloads) {
        const key = keyOf(payload);
        if (known.has(key)) continue;
        known.add(key);
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
    // Chromium 从系统剪贴板取图片时常常把 item.type 留空（图片字节已经转成 PNG），
    // 所以不能只按 image/* 过滤，否则这类图片会被静默丢掉。
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && (item.type === "" || item.type.startsWith("image/")))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null && file.size > 0)
      .slice(0, maxPastedImages);
    if (files.length === 0) return;
    event.preventDefault();
    const payloads: FileAttachmentPayload[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const prepared = await preparePastedImage(file);
      if (!prepared) continue;
      if (prepared.fingerprint) {
        if (seen.has(prepared.fingerprint)) continue;
        seen.add(prepared.fingerprint);
      }
      payloads.push(prepared.payload);
    }
    if (payloads.length > 0) addAttachments(payloads);
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

  async function submit(steerIntent = false): Promise<void> {
    const text = composeSkillPrompt(skill?.name ?? null, value);
    if (!text || disabled || !modelReady) return;
    const images = attachments
      .map((entry) => entry.image)
      .filter((image): image is ImageAttachment => image !== null);
    setValue("");
    setSlash(null);
    setSkill(null);
    setAttachments([]);
    // 运行中按追加指令投递:Enter 排队,⌘/Ctrl+Enter 调整当前任务。
    const deliverAs: RuntimeInstructionMode | undefined = streaming
      ? (steerIntent ? "steer" : "queue")
      : undefined;
    await onSend(text, images.length > 0 ? images : undefined, deliverAs);
  }

  const showError = sendError ? localizeError(sendError) : project.error ? localizeError(project.error) : null;
  const modifier = modKeyLabel(platform);
  const sendHint = disabled
    ? tr("会话还没有准备好", "Chat is not ready yet")
    : !modelReady
      ? tr("先选择一个可用的模型", "Choose an available model first")
      : !prompt
        ? tr("输入内容后发送", "Enter a message to send")
        : streaming
          ? tr("排队发送 (Enter)", "Queue (Enter)")
          : tr("发送 (Enter)", "Send (Enter)");
  const steerHint = tr(`调整当前任务 (${modifier}Enter)`, `Steer current task (${modifier}Enter)`);

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

        {showSetupControls || showError ? (
          <div className="composer-status-bar">
            {showSetupControls ? (
              <>
                <WorkspaceChip project={project} />
                <EnvironmentChip project={project} />
                <BranchChip project={project} />
              </>
            ) : null}
            {showError ? (
              <span className="composer-status-notice" role="alert" title={showError}>
                {showError}
              </span>
            ) : null}
          </div>
        ) : null}

        <PopoverPresence present={menuOpen}>
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
        </PopoverPresence>

        <MotionList className="instruction-row" items={instructions} keyOf={(entry) => entry.id} horizontal>
          {(entry) => (
            <div className={`instruction-chip instruction-${entry.mode}`}>
              <span className="instruction-badge">
                {entry.mode === "queue" ? tr("排队", "Queued") : tr("调整", "Steering")}
              </span>
              <span className="instruction-text" title={entry.text}>{entry.text}</span>
              <button
                type="button"
                className="instruction-remove"
                title={tr("撤销这条指令", "Remove this instruction")}
                aria-label={tr("撤销这条指令", "Remove this instruction")}
                onClick={() => void onRemoveInstruction(entry.id)}
              >
                <CloseIcon size={10} />
              </button>
            </div>
          )}
        </MotionList>

        <MotionList className="attachment-row" items={attachments} keyOf={attachmentKey} horizontal>
            {(entry) => (
              <div className={`attachment-chip attachment-${entry.kind}`}>
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
                  onClick={() => setAttachments((current) => current.filter((item) => item !== entry))}
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            )}
        </MotionList>

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
                void submit(event.metaKey || event.ctrlKey);
              }
            }}
          />
        </div>

        <div className="dock-controls-row">
          <div className="dock-controls-left">
            <AttachMenu onAttachments={addAttachments} disabled={disabled} />
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
              hiddenModels={hiddenModels}
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
            <ComposerActions streaming={streaming} sendHint={sendHint} steerHint={steerHint}
              canQueue={Boolean(prompt)} disabled={disabled || !modelReady || !prompt}
              onSteer={() => void submit(true)} onAbort={onAbort} />
          </div>
        </div>

        <ComposerStatsRow usage={usage} contextPopover={contextPopover} />
      </form>
    </div>
  );
});

const attachmentIds = new WeakMap<FileAttachmentPayload, string>();
let nextAttachmentId = 0;
function attachmentKey(entry: FileAttachmentPayload): string {
  let id = attachmentIds.get(entry);
  if (!id) { id = `attachment-${++nextAttachmentId}`; attachmentIds.set(entry, id); }
  return id;
}

function ComposerActions({ streaming, sendHint, steerHint, canQueue, disabled, onSteer, onAbort }: {
  streaming: boolean; sendHint: string; steerHint: string; canQueue: boolean; disabled: boolean;
  onSteer: () => void; onAbort: () => Promise<void>;
}) {
  const steerButton = streaming && canQueue
    ? <button className="composer-steer-btn" type="button" title={steerHint}
        aria-label={steerHint} disabled={disabled} onClick={onSteer}><SteerIcon /></button>
    : null;
  return <span className={`composer-action-slot${streaming ? " is-streaming" : ""}${steerButton ? " has-instruction" : ""}`}>
    {steerButton}
    <span className="composer-action-stack">
      <button className="send-action-blue-btn send" type="submit" title={sendHint}
        aria-label={streaming ? tr("排队发送", "Queue") : tr("发送", "Send")} disabled={disabled}
        inert={streaming && !canQueue} aria-hidden={streaming && !canQueue} tabIndex={streaming && !canQueue ? -1 : undefined}>
        <SendIcon />
      </button>
      <button className="send-action-blue-btn stop" type="button"
        title={tr("停止生成", "Stop generating")} aria-label={tr("停止生成", "Stop generating")}
        inert={!streaming} aria-hidden={!streaming} tabIndex={streaming ? undefined : -1}
        disabled={!streaming} onClick={() => void onAbort()}>
        <span className="stop-square" />
      </button>
    </span>
  </span>;
}

function placeholderFor(mode: InteractionMode): string {
  if (mode === "plan") return tr("描述你想规划的改动", "Describe the change you want to plan");
  if (mode === "goal") return tr("描述要达成的目标", "Describe the goal you want to achieve");
  return tr("随心输入", "Ask anything or describe a task");
}

const maxPastedImages = 6;
/** 转码时限制长边，避免超大图在 base64 传输与模型侧被拒。 */
const maxTranscodeEdge = 4096;
const maxTranscodedBytes = 9 * 1024 * 1024;

type DecodedImage = ImageBitmap | HTMLImageElement;

interface PreparedPastedImage {
  payload: FileAttachmentPayload;
  /** 原始字节摘要，用于批内去重。 */
  fingerprint: string;
}

interface TranscodedImage {
  bytes: Uint8Array;
  data: string;
  mimeType: string;
}

/** 主进程最终只接受这四种格式，这里按字节判断，不信任剪贴板给的 MIME。 */
function detectImageMimeType(bytes: Uint8Array): string | null {
  const startsWith = (prefix: readonly number[]) =>
    prefix.every((value, index) => bytes[index] === value);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (signature.startsWith("RIFF") && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  try {
    // 这里的字节都来自完整的 ArrayBuffer，不会是 SharedArrayBuffer。
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

async function decodeImage(blob: Blob): Promise<DecodedImage | null> {
  try {
    return await createImageBitmap(blob);
  } catch {
    // 个别格式（如带固有尺寸的 SVG）走 <img> 更稳，交给下面的回退路径。
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

function closeDecodedImage(source: DecodedImage | null): void {
  if (source && typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    source.close();
  }
}

function imageSize(source: DecodedImage): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      // 画布被跨域资源污染时 toBlob 会直接抛错。
      resolve(null);
    }
  });
}

/** 把 Chromium 能解码、但模型不接受的格式统一转成 PNG（过大再退 JPEG）。 */
async function transcodeImage(source: DecodedImage): Promise<TranscodedImage | null> {
  const { width, height } = imageSize(source);
  if (!width || !height) return null;
  const scale = Math.min(1, maxTranscodeEdge / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, targetWidth, targetHeight);
  let blob = await canvasToBlob(canvas, "image/png");
  if (blob && blob.size > maxTranscodedBytes) {
    // PNG 太大时压成 JPEG；先铺白底，避免透明区域变黑。
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.9);
    if (jpeg && jpeg.size < blob.size) blob = jpeg;
  }
  if (!blob || blob.size === 0 || blob.size > maxTranscodedBytes) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) return null;
  return { bytes, data: toBase64(bytes), mimeType };
}

/** 读取剪贴板里的一个文件，返回可直接发送的图片附件；无法解码时返回 null。 */
async function preparePastedImage(file: File): Promise<PreparedPastedImage | null> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  const name = file.name || tr("粘贴的图片", "Pasted image");
  const detected = detectImageMimeType(bytes);
  if (detected) {
    return {
      payload: { path: "", name, kind: "image", image: { type: "image", data: toBase64(bytes), mimeType: detected } },
      fingerprint: await digestBytes(bytes),
    };
  }
  // 剪贴板给出的可能是 TIFF/BMP/SVG 等模型不支持的格式，统一转成 PNG/JPEG。
  const decoded = await decodeImage(file);
  if (!decoded) return null;
  const transcoded = await transcodeImage(decoded);
  closeDecodedImage(decoded);
  if (!transcoded) return null;
  return {
    payload: {
      path: "",
      name,
      kind: "image",
      image: { type: "image", data: transcoded.data, mimeType: transcoded.mimeType },
    },
    fingerprint: await digestBytes(transcoded.bytes),
  };
}

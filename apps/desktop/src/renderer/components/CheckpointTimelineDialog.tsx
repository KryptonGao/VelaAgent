import type { CheckpointRestorePreview, CheckpointTimeline } from "@vela/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isEnglish, localizeError, tr } from "../locale";
import { BranchIcon, HistoryIcon } from "./icons";
import "../checkpoints.css";

interface CheckpointTimelineDialogProps {
  conversationId: string;
  /** 回复进行中时只能查看，不能回退或分叉。 */
  busy: boolean;
  /** 打开时选中的轮次；不传时选中最新一轮。 */
  initialTurn?: number | null;
  onRestore: (turnIndex: number) => Promise<void>;
  onFork: (turnIndex: number, restoreFiles: boolean) => Promise<void>;
  onClose: () => void;
}

/** 时间轴上的节点：-1 是对话开始，其余是可见用户消息的序号。 */
interface Node {
  turnIndex: number;
  label: string;
  text: string;
  timestamp: number | null;
  changedFiles: string[] | null;
  restore: CheckpointRestorePreview | null;
  current: boolean;
}

type Pending = { kind: "restore" } | { kind: "fork" } | null;

export function CheckpointTimelineDialog({ conversationId, busy, initialTurn, onRestore, onFork, onClose }: CheckpointTimelineDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const workingRef = useRef(false);
  const [timeline, setTimeline] = useState<CheckpointTimeline | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [confirming, setConfirming] = useState<Pending>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const detailId = useId();

  const load = useCallback(async () => {
    try {
      const next = await window.vela!.getCheckpoints(conversationId);
      setTimeline(next);
      setSelected(current => {
        if (current !== null && current < next.turns.length) return current;
        const wanted = initialTurn ?? next.turns.length - 1;
        return Math.max(-1, Math.min(wanted, next.turns.length - 1));
      });
    } catch (reason) {
      setError(reason instanceof Error ? localizeError(reason.message) : tr("无法读取检查点", "Could not load checkpoints"));
    }
  }, [conversationId, initialTurn]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog?.showModal();
    void load();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]")) opener.focus();
    };
  }, [load]);

  useEffect(() => {
    setConfirming(null);
    setRestoreFiles(false);
  }, [selected]);

  // 选中项随加载或键盘移动滚动到可见区域，并把焦点留在列表里。
  useEffect(() => {
    if (selected === null) return;
    const item = listRef.current?.querySelector<HTMLButtonElement>(`[data-turn="${selected}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [selected, timeline]);

  const nodes: Node[] = timeline ? [
    ...(timeline.turns.length > 0 ? [{
      turnIndex: -1,
      label: tr("对话开始", "Start of chat"),
      text: tr("还没有任何消息", "Before the first message"),
      timestamp: null,
      changedFiles: null,
      restore: timeline.start,
      current: false,
    }] : []),
    ...timeline.turns.map((turn, index) => ({
      turnIndex: turn.turnIndex,
      label: tr(`第 ${turn.turnIndex + 1} 轮`, `Turn ${turn.turnIndex + 1}`),
      text: turn.text.trim() || tr("[图片]", "[Image]"),
      timestamp: turn.timestamp,
      changedFiles: turn.changedFiles,
      restore: turn.restore,
      current: index === timeline.turns.length - 1,
    })),
  ] : [];
  const node = nodes.find(item => item.turnIndex === selected) ?? null;

  async function run(action: () => Promise<void>) {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? localizeError(reason.message) : tr("操作失败，请重试", "Something went wrong. Try again."));
      setConfirming(null);
      void load();
    } finally {
      workingRef.current = false;
      setWorking(false);
    }
  }

  function move(delta: number) {
    if (!nodes.length) return;
    const index = nodes.findIndex(item => item.turnIndex === selected);
    const next = nodes[Math.max(0, Math.min(nodes.length - 1, index + delta))];
    if (!next) return;
    setSelected(next.turnIndex);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-turn="${next.turnIndex}"]`)?.focus();
  }

  const restore = node?.restore ?? null;
  const canRestore = Boolean(node && !node.current && restore?.available && !busy && !working);
  const canFork = Boolean(node && node.turnIndex >= 0 && !busy && !working && (!restoreFiles || node.current || restore?.available));

  return (
    <dialog
      ref={dialogRef}
      className="checkpoint-dialog"
      aria-labelledby={headingId}
      onCancel={event => {
        event.preventDefault();
        if (confirming) setConfirming(null);
        else if (!workingRef.current) onClose();
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      <header className="checkpoint-header">
        <div>
          <h2 id={headingId}>{tr("检查点与回滚", "Checkpoints")}</h2>
          <p>{tr("回到某一轮结束时的对话和文件，或从那里分叉出新对话。", "Return the chat and its files to the end of a turn, or fork a new chat from there.")}</p>
        </div>
        <button type="button" className="checkpoint-close" aria-label={tr("关闭", "Close")} disabled={working} onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>

      <div className="checkpoint-body">
        {!timeline ? (
          <p className="checkpoint-empty">{error ?? tr("正在读取检查点…", "Loading checkpoints…")}</p>
        ) : nodes.length === 0 ? (
          <p className="checkpoint-empty">{tr("这个对话还没有消息。", "This chat has no messages yet.")}</p>
        ) : (
          <>
            <ol ref={listRef} className="checkpoint-timeline" aria-label={tr("对话检查点", "Chat checkpoints")}
              onKeyDown={event => {
                if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
                else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
              }}>
              {nodes.map(item => (
                <li key={item.turnIndex} className={`checkpoint-node${item.current ? " current" : ""}${item.turnIndex === selected ? " selected" : ""}`}>
                  <button type="button" data-turn={item.turnIndex} aria-current={item.turnIndex === selected ? "step" : undefined}
                    aria-controls={detailId} tabIndex={item.turnIndex === selected ? 0 : -1}
                    onClick={() => setSelected(item.turnIndex)}>
                    <span className="checkpoint-dot" aria-hidden="true" />
                    <span className="checkpoint-node-main">
                      <span className="checkpoint-node-meta">
                        <strong>{item.label}</strong>
                        {item.current ? <span className="checkpoint-badge">{tr("当前", "Current")}</span> : null}
                        {item.timestamp !== null ? <time dateTime={new Date(item.timestamp).toISOString()}>{formatTime(item.timestamp)}</time> : null}
                      </span>
                      <span className="checkpoint-node-text">{item.text}</span>
                      {item.turnIndex >= 0 ? (
                        <span className="checkpoint-node-files">
                          {item.changedFiles === null
                            ? tr("与上一轮共用检查点", "Shares the previous checkpoint")
                            : item.changedFiles.length === 0
                              ? tr("没有改动文件", "No file changes")
                              : tr(`改动 ${item.changedFiles.length} 个文件`, item.changedFiles.length === 1 ? "Changed 1 file" : `Changed ${item.changedFiles.length} files`)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ol>

            {node ? (
              <section id={detailId} className="checkpoint-detail" aria-live="polite">
                <h3>{node.turnIndex < 0 ? tr("回到对话开始", "Back to the start") : tr(`${node.label}结束时`, `End of ${node.label.toLowerCase()}`)}</h3>

                <div className="checkpoint-action">
                  <div className="checkpoint-action-copy">
                    <strong><HistoryIcon size={13} /> {tr("回到这里", "Return here")}</strong>
                    {node.current ? (
                      <p>{tr("这是对话当前所在的位置。", "This is where the chat is now.")}</p>
                    ) : restore?.available ? (
                      <p>{restoreSummary(restore)}</p>
                    ) : (
                      <p className="checkpoint-unavailable">{restore?.reason ? localizeError(restore.reason) : tr("这个检查点不可用。", "This checkpoint is unavailable.")}</p>
                    )}
                    {!node.current && restore && restore.files.length > 0 ? <FileList files={restore.files} /> : null}
                  </div>
                  {confirming?.kind === "restore" ? (
                    <div className="checkpoint-confirm" role="group" aria-label={tr("确认回到这里", "Confirm return")}>
                      <button type="button" disabled={working} onClick={() => setConfirming(null)}>{tr("取消", "Cancel")}</button>
                      <button type="button" className="danger" disabled={!canRestore} autoFocus
                        onClick={() => void run(() => onRestore(node.turnIndex))}>
                        {working ? tr("回退中…", "Restoring…") : tr("确认回退", "Confirm")}
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="checkpoint-primary" disabled={!canRestore} onClick={() => setConfirming({ kind: "restore" })}>
                      {tr("回到这里", "Return here")}
                    </button>
                  )}
                </div>

                {node.turnIndex >= 0 ? (
                  <div className="checkpoint-action">
                    <div className="checkpoint-action-copy">
                      <strong><BranchIcon size={13} /> {tr("从这里分叉", "Fork from here")}</strong>
                      <p>{tr("保留到这一轮为止的对话，在新聊天里继续；原对话不变。", "Keep the chat up to this turn and continue in a new chat. The original chat stays as it is.")}</p>
                      {!node.current ? (
                        <label className="checkpoint-option">
                          <input type="checkbox" checked={restoreFiles} disabled={working || !restore?.available}
                            onChange={event => { setRestoreFiles(event.target.checked); setConfirming(null); }} />
                          <span>
                            {tr("同时把工作区文件恢复到这里", "Also restore workspace files to this point")}
                            {restoreFiles ? <em>{tr(
                              `原对话之后 ${restore?.removedTurns ?? 0} 轮的文件改动会从工作区撤销，原对话里不能再回退这些轮次。`,
                              `File changes from the original chat's ${restore?.removedTurns === 1 ? "later turn are" : `${restore?.removedTurns ?? 0} later turns are`} removed from the workspace and can no longer be rewound there.`,
                            )}</em> : null}
                          </span>
                        </label>
                      ) : null}
                    </div>
                    {confirming?.kind === "fork" ? (
                      <div className="checkpoint-confirm" role="group" aria-label={tr("确认分叉", "Confirm fork")}>
                        <button type="button" disabled={working} onClick={() => setConfirming(null)}>{tr("取消", "Cancel")}</button>
                        <button type="button" className="danger" disabled={!canFork} autoFocus
                          onClick={() => void run(() => onFork(node.turnIndex, true))}>
                          {working ? tr("分叉中…", "Forking…") : tr("确认分叉", "Confirm")}
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="checkpoint-primary" disabled={!canFork}
                        onClick={() => {
                          // 只复制对话时不动文件，直接分叉；恢复文件需要再确认一次。
                          if (restoreFiles && !node.current) setConfirming({ kind: "fork" });
                          else void run(() => onFork(node.turnIndex, false));
                        }}>
                        {working && !confirming ? tr("分叉中…", "Forking…") : tr("分叉新对话", "Fork chat")}
                      </button>
                    )}
                  </div>
                ) : null}

                {busy ? <p className="checkpoint-note">{tr("回复进行中，完成后才能回退或分叉。", "Wait for the reply to finish before restoring or forking.")}</p> : null}
                {error ? <p className="checkpoint-error" role="alert">{error}</p> : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    </dialog>
  );
}

function restoreSummary(preview: CheckpointRestorePreview): string {
  const turns = preview.removedTurns;
  const files = preview.files.length;
  const later = turns === 1 ? "the later turn" : `the ${turns} later turns`;
  if (files === 0) return tr(`移除之后的 ${turns} 轮对话，没有文件需要恢复。`, `Removes ${later}. No files need restoring.`);
  return tr(`移除之后的 ${turns} 轮对话，并把 ${files} 个文件恢复到当时的内容。期间你手动做的其他改动会保留。`,
    `Removes ${later} and restores ${files === 1 ? "1 file" : `${files} files`} to how they were. Your other manual edits are kept.`);
}

function FileList({ files }: { files: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, 5);
  return (
    <ul className="checkpoint-files">
      {shown.map(file => <li key={file} title={file}>{file}</li>)}
      {files.length > shown.length ? (
        <li><button type="button" onClick={() => setAll(true)}>{tr(`还有 ${files.length - shown.length} 个`, `${files.length - shown.length} more`)}</button></li>
      ) : null}
    </ul>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const locale = isEnglish() ? "en-US" : "zh-CN";
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

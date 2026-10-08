import { useEffect, useMemo, useState } from "react";
import type { GitHunkAction } from "@vela/shared";
import { tr, trf } from "../../locale";
import { CheckIcon, CloseIcon, DiffIcon, TrashIcon } from "../icons";
import { DiffPane } from "../DiffPane";
import { buildHunkPatch, hunkLabel, parseRenderPatch } from "./diff-hunks";

/**
 * 带代码块操作的差异视图(VC-15)。选择只是界面状态;
 * 每次操作只发送选中代码块组成的补丁,服务端会与最新 Diff 核对。
 */
export function HunkedDiff({
  path,
  diff,
  mode,
  actions,
  disabled,
  onApply,
}: {
  path: string;
  diff: string;
  mode: "unified" | "split";
  /** 允许的代码块操作;空表示只读展示 */
  actions: GitHunkAction[];
  disabled: boolean;
  onApply(action: GitHunkAction, patch: string, count: number): void;
}) {
  const patch = useMemo(() => parseRenderPatch(diff), [diff]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // 差异刷新后清空选择,避免把旧选择应用到新内容。
  useEffect(() => {
    setSelected(new Set());
  }, [path, diff]);

  const toggle = (index: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  if (patch.hunks.length === 0) {
    return <DiffPane path={path} diff={diff} mode={mode} />;
  }

  const indexes = [...selected].sort((a, b) => a - b);
  const actionLabel = (action: GitHunkAction): string =>
    action === "stage" ? tr("暂存选中块", "Stage selected") : action === "unstage" ? tr("取消暂存选中块", "Unstage selected") : tr("丢弃选中块", "Discard selected");

  return (
    <div className="vc-hunked">
      {patch.header.length > 0 ? (
        <div className="vc-hunk-meta">{patch.header.filter((line) => !line.startsWith("index ")).join(" · ")}</div>
      ) : null}
      {actions.length > 0 ? (
        <div className="vc-hunk-bar">
          <button
            type="button"
            className="vc-link"
            onClick={() => setSelected(new Set(patch.hunks.map((hunk) => hunk.index)))}
          >
            {tr("全选代码块", "Select all hunks")}
          </button>
          <span className="vc-hint">{trf("已选 {0} / {1} 块", "{0} of {1} hunks", indexes.length, patch.hunks.length)}</span>
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={`vc-btn vc-btn-ghost${action === "discard" ? " vc-danger" : ""}`}
              disabled={disabled || indexes.length === 0}
              onClick={() => onApply(action, buildHunkPatch(patch, indexes), indexes.length)}
            >
              {actionLabel(action)}
            </button>
          ))}
        </div>
      ) : null}

      {patch.hunks.map((hunk) => {
        const checked = selected.has(hunk.index);
        return (
          <div key={hunk.index} className={`vc-hunk${checked ? " selected" : ""}`}>
            <div className="vc-hunk-head">
              {actions.length > 0 ? (
                <input
                  type="checkbox"
                  className="vc-check"
                  checked={checked}
                  aria-label={trf("选择代码块 {0}", "Select hunk {0}", hunkLabel(hunk))}
                  onChange={() => toggle(hunk.index)}
                />
              ) : (
                <DiffIcon size={11} />
              )}
              <code className="vc-hunk-label">{hunk.header}</code>
              <span className="vc-hint">{hunkLabel(hunk)}</span>
              {actions.length > 0 ? (
                <span className="vc-hunk-actions">
                  {actions.includes("stage") ? (
                    <button
                      type="button"
                      className="vc-icon-btn"
                      title={tr("只暂存这一块", "Stage this hunk")}
                      aria-label={tr("只暂存这一块", "Stage this hunk")}
                      disabled={disabled}
                      onClick={() => onApply("stage", buildHunkPatch(patch, [hunk.index]), 1)}
                    >
                      <CheckIcon size={11} />
                    </button>
                  ) : null}
                  {actions.includes("unstage") ? (
                    <button
                      type="button"
                      className="vc-icon-btn"
                      title={tr("取消暂存这一块", "Unstage this hunk")}
                      aria-label={tr("取消暂存这一块", "Unstage this hunk")}
                      disabled={disabled}
                      onClick={() => onApply("unstage", buildHunkPatch(patch, [hunk.index]), 1)}
                    >
                      <CloseIcon size={11} />
                    </button>
                  ) : null}
                  {actions.includes("discard") ? (
                    <button
                      type="button"
                      className="vc-icon-btn vc-danger"
                      title={tr("丢弃这一块的工作区改动", "Discard this hunk")}
                      aria-label={tr("丢弃这一块的工作区改动", "Discard this hunk")}
                      disabled={disabled}
                      onClick={() => onApply("discard", buildHunkPatch(patch, [hunk.index]), 1)}
                    >
                      <TrashIcon size={11} />
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            <DiffPane path={path} diff={`${hunk.header}\n${hunk.lines.join("\n")}`} mode={mode} />
          </div>
        );
      })}
    </div>
  );
}

import type { AiTextAction, AiTextResult } from "@vela/shared";
import { tr } from "../../locale";
import { CheckIcon, CloseIcon, SparkIcon } from "../icons";
import type { AiTextState } from "./ai-text";

/**
 * Commit / PR 文案的生成、润色与调整入口。
 * 生成结果先作为候选展示,由调用方决定是否采用;运行中可取消。
 */
export function AiAssist({
  state,
  disabled = false,
  hint,
  hasText,
  compact = false,
  onGenerate,
  onApply,
  onDismiss,
  onCancel,
}: {
  state: AiTextState;
  disabled?: boolean;
  hint: string;
  hasText: boolean;
  /** 嵌入表单工具行时使用:只保留按钮与结果区,隐藏常驻的提示文本。 */
  compact?: boolean;
  onGenerate(action: AiTextAction, instruction?: string | null): void;
  onApply(result: AiTextResult): void;
  onDismiss(): void;
  onCancel(): void;
}) {
  const adjustments = [
    { label: tr("更简洁", "More concise"), instruction: tr("在保留全部事实的前提下写得更简洁。", "Make it more concise while keeping every fact.") },
    { label: tr("补充原因", "Add rationale"), instruction: tr("补充改动的原因或背景,不要编造依据。", "Add the reason or background for the change; do not invent evidence.") },
    { label: tr("切换语言", "Switch language"), instruction: tr("把文案换成另一种语言,保持事实不变。", "Rewrite in the other language without changing the facts.") },
  ];
  return (
    <div className={`vc-ai${compact ? " vc-ai-compact" : ""}`}>
      <div className="vc-ai-actions">
        <button
          type="button"
          className="vc-btn vc-btn-ai"
          title={disabled ? hint : undefined}
          disabled={disabled || state.running}
          onClick={() => onGenerate(hasText ? "polish" : "generate")}
        >
          <SparkIcon size={12} />
          {hasText ? tr("AI 润色", "AI polish") : tr("AI 生成", "AI generate")}
        </button>
        {hasText ? (
          <button
            type="button"
            className="vc-btn vc-btn-ghost"
            disabled={disabled || state.running}
            onClick={() => onGenerate("regenerate")}
          >
            {tr("重新生成", "Regenerate")}
          </button>
        ) : null}
        {state.running ? (
          <button type="button" className="vc-btn vc-btn-ghost" onClick={onCancel}>
            {tr("取消", "Cancel")}
          </button>
        ) : null}
      </div>
      {compact ? null : <span className="vc-ai-hint">{hint}</span>}
      {state.running ? (
        <span className="vc-ai-running" role="status">
          <span className="vc-spinner" aria-hidden="true" />
          {tr("正在生成…", "Generating…")}
          <button type="button" className="vc-link" onClick={onCancel}>
            {tr("取消", "Cancel")}
          </button>
        </span>
      ) : null}
      {!state.running && state.error ? (
        <span className="vc-ai-error" role="alert">{state.error}</span>
      ) : null}
      {!state.running && state.result ? (
        <div className="vc-ai-candidate" role="status">
          <div className="vc-ai-candidate-head">
            <b>{tr("生成候选", "Draft candidate")}</b>
            <span>{state.result.modelLabel ?? ""}</span>
          </div>
          <div className="vc-ai-candidate-scope">
            {state.result.scopeLabel}
            {state.stale ? <em>{tr("依据已过期，采用前请核对", "Basis changed; review before applying")}</em> : null}
          </div>
          <div className="vc-ai-candidate-text">
            {state.result.title ? <div className="vc-ai-candidate-title">{state.result.title}</div> : null}
            {state.result.body ? <pre className="vc-ai-candidate-body">{state.result.body}</pre> : null}
          </div>
          <div className="vc-ai-candidate-actions">
            <button type="button" className="vc-btn vc-btn-primary" onClick={() => onApply(state.result!)}>
              <CheckIcon size={12} />
              {tr("采用", "Apply")}
            </button>
            <button type="button" className="vc-btn vc-btn-ghost" onClick={onDismiss}>
              <CloseIcon size={12} />
              {tr("丢弃", "Dismiss")}
            </button>
          </div>
        </div>
      ) : null}
      {hasText && !state.running ? (
        <div className="vc-ai-adjust">
          {adjustments.map((item) => (
            <button
              key={item.label}
              type="button"
              className="vc-chip"
              disabled={disabled}
              onClick={() => onGenerate("adjust", item.instruction)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

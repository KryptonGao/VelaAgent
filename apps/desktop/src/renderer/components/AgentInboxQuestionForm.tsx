import type { AgentInboxDetail } from "@vela/shared";
import { useState } from "react";
import { tr } from "../locale";

type QuestionDetail = Extract<AgentInboxDetail, { kind: "question" }>;

/**
 * Inbox 里的用户问题回答表单：外观与聊天里的 QuestionCard 一致，但只依赖已存储的事项，
 * 不需要工具调用记录。提交由主进程校验，答案必须是选项之一，或在允许时为自由输入。
 */
export function AgentInboxQuestionForm({
  detail,
  busy,
  onAnswer,
  onSkip,
}: {
  detail: QuestionDetail;
  busy: boolean;
  onAnswer: (answer: string) => void;
  onSkip: () => void;
}) {
  const [custom, setCustom] = useState("");
  const submitCustom = () => {
    const text = custom.trim();
    if (text && !busy) onAnswer(text);
  };
  return (
    <div className="question-card interactive agent-inbox-question" aria-busy={busy}>
      <div className="question-card-q">{detail.question}</div>
      {detail.options.length > 0 ? (
        <div className="question-card-options" role="group" aria-label={tr("回答选项", "Answer options")}>
          {detail.options.map(option => (
            <button
              type="button"
              className="question-option"
              key={option.label}
              disabled={busy}
              title={option.description ?? option.label}
              onClick={() => onAnswer(option.label)}
            >
              <span className="question-option-label">{option.label}</span>
              {option.description ? <span className="question-option-desc">{option.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {detail.allowFreeText ? (
        <div className="question-card-custom">
          <input
            className="question-custom-input"
            value={custom}
            disabled={busy}
            placeholder={tr("自定义回答…", "Write a custom answer…")}
            aria-label={tr("自定义回答", "Custom answer")}
            onChange={event => setCustom(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.key === "Process") return;
              if (event.key === "Enter") { event.preventDefault(); submitCustom(); }
            }}
          />
          <button type="button" className="question-custom-send" disabled={busy || !custom.trim()} onClick={submitCustom}>
            {tr("发送", "Send")}
          </button>
        </div>
      ) : null}
      <div className="question-card-skip">
        <button type="button" className="question-skip" disabled={busy} onClick={onSkip}>
          {tr("跳过这个问题", "Skip this question")}
        </button>
      </div>
    </div>
  );
}

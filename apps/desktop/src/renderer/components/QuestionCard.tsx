import type { AskUserQuestionRequest, ToolTrace } from "@vela/shared";
import { useState } from "react";
import { QuestionIcon } from "./icons";
import { tr } from "../locale";
import { ToolDurationLabel } from "./ToolProcessContext";

/**
 * ask_user_question 工具的消息内卡片。
 * 等待回答时显示可点选的选项、自由输入和跳过;回答后(或重启恢复的历史)转为只读,
 * 展示问题、选项与用户的答案。紧凑模式下的历史只保留问题和最终回答。
 */
export function QuestionCard({
  tool,
  request,
  onReply,
  compact = false,
}: {
  tool: ToolTrace;
  request: AskUserQuestionRequest | null;
  onReply: (id: string, answer: string | null) => void;
  compact?: boolean;
}) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = (tool.activity?.body ?? "").split("\n").filter((line) => line.trim().length > 0);
  const question = request?.question ?? lines[0] ?? "…";
  const optionLines = request ? [] : lines.filter((line) => line.startsWith("·"));
  const answerLine = request ? null : lines.find((line) => line.startsWith("用户回答：") || line.startsWith("Your answer: "));
  const interactive = tool.status === "running" && request !== null && !busy;

  function reply(answer: string | null): void {
    if (!request || busy) return;
    setBusy(true);
    onReply(request.id, answer);
  }

  function submitCustom(): void {
    const text = custom.trim();
    if (!text) return;
    reply(text);
  }

  if (compact && tool.status !== "running") {
    const answer = answerLine
      ? answerLine.replace(/^(用户回答：|Your answer: )/, "")
      : tool.status === "error"
        ? tr("问题没有回答", "Question was not answered")
        : tr("没有回答", "No answer");

    return (
      <article className="question-card is-compact-history">
        <div className="question-compact-head">
          <span className="question-compact-icon" aria-hidden="true">
            <QuestionIcon size={13} />
          </span>
          <div className="question-card-q">{question}</div>
          <ToolDurationLabel tool={tool} />
        </div>
        <div className="question-compact-answer">
          <span className="question-compact-guide" aria-hidden="true" />
          <div className={`question-compact-answer-text${answerLine ? "" : " is-empty"}`}>{answer}</div>
        </div>
      </article>
    );
  }

  return (
    <article className={`question-card is-${tool.status}${interactive ? " interactive" : ""}`}>
      <div className="question-card-head">
        <span className="tool-card-icon" aria-hidden="true">
          <QuestionIcon size={13} />
        </span>
        <span className="tool-kind-label">{tr("提问", "Question")}</span>
        <span className="question-card-state">
          {tool.status === "running" ? (
            busy ? (
              tr("已选择，等待确认", "Selected, waiting for confirmation")
            ) : request ? (
              tr("等待你的回答", "Waiting for your answer")
            ) : (
              tr("等待回答", "Waiting for an answer")
            )
          ) : tool.status === "error" ? (
            tr("未回答", "Unanswered")
          ) : null}
        </span>
        {tool.status === "running" ? (
          <span className="tool-spinner" role="status" aria-label={tr("等待回答", "Waiting for an answer")} />
        ) : null}
      </div>
      <div className="question-card-q">{question}</div>
      {interactive && request ? (
        <>
          {request.options.length > 0 ? (
            <div className="question-card-options" role="group" aria-label={tr("回答选项", "Answer options")}>
              {request.options.map((option) => (
                <button
                  type="button"
                  className="question-option"
                  key={option.label}
                  title={option.description ?? option.label}
                  onClick={() => reply(option.label)}
                >
                  <span className="question-option-label">{option.label}</span>
                  {option.description ? (
                    <span className="question-option-desc">{option.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {request.allowFreeText ? (
            <div className="question-card-custom">
              <input
                className="question-custom-input"
                value={custom}
                placeholder={tr("自定义回答…", "Write a custom answer…")}
                aria-label={tr("自定义回答", "Custom answer")}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.key === "Process") return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitCustom();
                  }
                }}
              />
              <button
                type="button"
                className="question-custom-send"
                disabled={!custom.trim()}
                onClick={submitCustom}
              >
                {tr("发送", "Send")}
              </button>
            </div>
          ) : null}
          <div className="question-card-skip">
            <button type="button" className="question-skip" onClick={() => reply(null)}>
              {tr("跳过这个问题", "Skip this question")}
            </button>
          </div>
        </>
      ) : (
        <>
          {optionLines.map((line) => (
            <div className="question-card-option-echo" key={line}>
              {line}
            </div>
          ))}
          {answerLine ? (
            <div className="question-card-a">{answerLine.replace(/^(用户回答：|Your answer: )/, "")}</div>
          ) : tool.status !== "running" ? (
            <p className="tool-wait">{tool.status === "error" ? tr("问题没有回答", "Question was not answered") : tr("没有回答", "No answer")}</p>
          ) : null}
        </>
      )}
    </article>
  );
}

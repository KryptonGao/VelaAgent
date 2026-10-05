import { PopoverPresence } from "../MotionPresence";
import type { SandboxMode } from "@vela/shared";
import type { ProjectApi } from "../../hooks/useProject";
import { useDismissable } from "../../hooks/useDismissable";
import { CheckIcon, ShieldIcon } from "../icons";
import { useState } from "react";
import { tr } from "../../locale";

const modeLabels: Record<SandboxMode, [string, string]> = {
  ask: ["每次询问", "Ask every time"],
  smart: ["帮我批准", "Smart approval"],
  full: ["完全访问", "Full access"],
};

const modeDescriptions: Record<SandboxMode, [string, string]> = {
  ask: ["运行终端命令前需要你逐次批准。修改工作区外的文件前也需要批准；工作区内的文件修改无需逐次确认。", "Approve each terminal command and any file changes outside the workspace. Changes inside the workspace do not need separate approval."],
  smart: ["先由当前对话选择的模型判断风险。只有风险操作或判断失败时才请求批准，低风险操作直接执行。", "The model selected for the current conversation checks each action first. Only risky actions, or when the check fails, need your approval; low-risk actions run directly."],
  full: ["在当前工具权限范围内执行命令和文件修改，不再逐项询问。", "Run commands and make file changes within the current tool permissions without asking each time."],
};

function modeLabel(mode: SandboxMode): string {
  const [chinese, english] = modeLabels[mode];
  return tr(chinese, english);
}

function modeDescription(mode: SandboxMode): string {
  const [chinese, english] = modeDescriptions[mode];
  return tr(chinese, english);
}

export function SandboxPill({ project, conversationMode }: { project: ProjectApi; conversationMode?: SandboxMode }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const mode = conversationMode ?? project.sandboxMode;

  return (
    <div className="composer-chip-anchor" ref={ref}>
      <button
        type="button"
        className={`sandbox-pill sandbox-${mode}`}
        title={modeDescription(mode)}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ShieldIcon size={12} />
        <span>{modeLabel(mode)}</span>
      </button>
      <PopoverPresence present={open}>
        <div className="dock-popover composer-popover up sandbox-popover">
          <div className="composer-popover-title">{tr("执行权限", "Execution permissions")}</div>
          {(["ask", "smart", "full"] as SandboxMode[]).map((candidate) => (
            <button
              type="button"
              key={candidate}
              className={`sandbox-option${candidate === mode ? " active" : ""}`}
              disabled={Boolean(conversationMode)}
              onClick={() => {
                void project.setSandboxMode(candidate);
                setOpen(false);
              }}
            >
              <span className={`sandbox-option-icon sandbox-${candidate}`}>
                <ShieldIcon size={13} />
              </span>
              <span className="sandbox-option-text">
                <span className="sandbox-option-name">{modeLabel(candidate)}</span>
                <span className="sandbox-option-desc">{modeDescription(candidate)}</span>
              </span>
              {candidate === mode ? <CheckIcon /> : null}
            </button>
          ))}
          <div className="composer-popover-footnote">{conversationMode ? tr("此对话使用配方启动时的权限快照；应用默认权限不受影响。", "This chat uses the permission snapshot from its recipe launch. App defaults are unchanged.") : tr("执行权限会影响 Agent 能自动完成的操作。「帮我批准」由当前对话选择的模型判断风险。", "Permissions control which actions the agent can complete automatically. Smart approval uses the model selected for the current conversation to check risk.")}</div>
        </div>
      </PopoverPresence>
    </div>
  );
}

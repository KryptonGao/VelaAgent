import type { SandboxMode } from "@vela/shared";
import type { ProjectApi } from "../../hooks/useProject";
import { useDismissable } from "../../hooks/useDismissable";
import { CheckIcon, ShieldIcon } from "../icons";
import { useState } from "react";

const modeLabels: Record<SandboxMode, string> = {
  ask: "每次询问",
  full: "完全访问",
};

const modeDescriptions: Record<SandboxMode, string> = {
  ask: "运行终端命令前需要你逐次批准。修改工作区外的文件前也需要批准；工作区内的文件修改无需逐次确认。",
  full: "在当前工具权限范围内执行命令和文件修改，不再逐项询问。",
};

export function SandboxPill({ project }: { project: ProjectApi }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const mode = project.sandboxMode;

  return (
    <div className="composer-chip-anchor" ref={ref}>
      <button
        type="button"
        className={`sandbox-pill sandbox-${mode}`}
        title={modeDescriptions[mode]}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ShieldIcon size={12} />
        <span>{modeLabels[mode]}</span>
      </button>
      {open ? (
        <div className="dock-popover composer-popover up sandbox-popover">
          <div className="composer-popover-title">执行权限</div>
          {(["ask", "full"] as SandboxMode[]).map((candidate) => (
            <button
              type="button"
              key={candidate}
              className={`sandbox-option${candidate === mode ? " active" : ""}`}
              onClick={() => {
                void project.setSandboxMode(candidate);
                setOpen(false);
              }}
            >
              <span className={`sandbox-option-icon sandbox-${candidate}`}>
                <ShieldIcon size={13} />
              </span>
              <span className="sandbox-option-text">
                <span className="sandbox-option-name">{modeLabels[candidate]}</span>
                <span className="sandbox-option-desc">{modeDescriptions[candidate]}</span>
              </span>
              {candidate === mode ? <CheckIcon /> : null}
            </button>
          ))}
          <div className="composer-popover-footnote">执行权限会影响 Agent 能自动完成的操作。你可以随时在输入框旁切换。</div>
        </div>
      ) : null}
    </div>
  );
}

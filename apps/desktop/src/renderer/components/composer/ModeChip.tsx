import type { InteractionMode } from "@vela/shared";
import { useEffect, useState } from "react";
import { useDismissable } from "../../hooks/useDismissable";
import { CheckIcon } from "../icons";

const modes: InteractionMode[] = ["agent", "plan", "goal"];

const modeLabels: Record<InteractionMode, string> = {
  agent: "Agent",
  plan: "Plan",
  goal: "Goal",
};

const modeDescriptions: Record<InteractionMode, string> = {
  agent: "直接修改代码、运行命令并完成任务。",
  plan: "只查阅代码并写出计划。确认后才会开始改文件。",
  goal: "围绕一个目标自动连续执行，直到完成或你停止。",
};

export function ModeChip({
  mode,
  disabled,
  onChange,
}: {
  mode: InteractionMode;
  disabled: boolean;
  onChange: (mode: InteractionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="composer-chip-anchor" ref={ref}>
      <button
        type="button"
        className={`mode-pill mode-${mode}`}
        title={modeDescriptions[mode]}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{modeLabels[mode]}</span>
      </button>
      {open ? (
        <div className="dock-popover composer-popover up mode-popover">
          <div className="composer-popover-title">对话模式</div>
          {modes.map((candidate) => (
            <button
              type="button"
              key={candidate}
              className={`mode-option${candidate === mode ? " active" : ""}`}
              onClick={() => {
                onChange(candidate);
                setOpen(false);
              }}
            >
              <span className={`mode-option-icon mode-${candidate}`}>{modeLabels[candidate].slice(0, 1)}</span>
              <span className="mode-option-text">
                <span className="mode-option-name">{modeLabels[candidate]}</span>
                <span className="mode-option-desc">{modeDescriptions[candidate]}</span>
              </span>
              {candidate === mode ? <CheckIcon /> : null}
            </button>
          ))}
          <div className="composer-popover-footnote">模式只影响当前对话。回复进行时不能切换。</div>
        </div>
      ) : null}
    </div>
  );
}

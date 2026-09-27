import type { ProjectApi } from "../../hooks/useProject";
import { useDismissable } from "../../hooks/useDismissable";
import { CheckIcon, MonitorIcon } from "../icons";
import { useState } from "react";
import type { SelectableEnvironmentKind } from "@vela/shared";
import { tr } from "../../locale";

export function EnvironmentChip({ project }: { project: ProjectApi }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<SelectableEnvironmentKind | null>(null);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const environment = project.environment;
  const environments = project.environments;
  if (!environment) return null;

  const local = environments.find((entry) => entry.kind === "local") ?? null;
  const worktree = environments.find((entry) => entry.kind === "worktree") ?? null;
  const worktreeActive = environment.kind === "worktree";
  const activeKind = environment.kind;
  const activeLabel = activeKind === "local"
    ? tr("本地", "Local")
    : activeKind === "worktree"
      ? tr("工作树", "Worktree")
      : activeKind === "sandbox"
        ? tr("沙箱", "Sandbox")
        : activeKind === "remote"
          ? tr("远程", "Remote")
          : environment.label;

  async function switchTo(kind: SelectableEnvironmentKind): Promise<void> {
    if (pending || kind === activeKind) return;
    setPending(kind);
    try {
      await project.setEnvironment(kind);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="composer-chip-anchor" ref={ref}>
      <button
        type="button"
        className="composer-chip"
        title={`${tr("执行环境", "Execution environment")}: ${activeLabel} (${environment.path})`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MonitorIcon />
        <span>{activeLabel}</span>
      </button>
      {open ? (
        <div className="dock-popover composer-popover up">
          <div className="composer-popover-title">{tr("执行环境", "Execution environment")}</div>
          <button
            type="button"
            className={`environment-row${worktreeActive ? "" : " active"}`}
            disabled={Boolean(pending) || !worktreeActive}
            onClick={() => void switchTo("local")}
          >
            <MonitorIcon size={14} />
            <div className="environment-text">
              <span className="environment-name">{tr("本地", "Local")}{pending === "local" ? tr(" · 切换中", " · Switching…") : ""}</span>
              <span className="environment-path" title={local?.path || environment.path}>
                {local?.path || environment.path}
              </span>
            </div>
            {worktreeActive ? null : <CheckIcon />}
          </button>
          <button
            type="button"
            className={`environment-row${worktreeActive ? " active" : ""}`}
            disabled={Boolean(pending) || worktreeActive}
            onClick={() => void switchTo("worktree")}
          >
            <MonitorIcon size={14} />
            <div className="environment-text">
              <span className="environment-name">{tr("工作树", "Worktree")}{pending === "worktree" ? tr(" · 创建中", " · Creating…") : ""}</span>
              <span className="environment-path" title={worktree?.path}>
                {worktreeActive
                  ? environment.path
                  : worktree?.path || tr("为当前仓库创建独立工作树", "Create an isolated worktree for this repository")}
              </span>
            </div>
            {worktreeActive ? <CheckIcon /> : null}
          </button>
          {(["sandbox", "remote"] as const).map((kind) => (
            <div className="environment-row disabled" key={kind}>
              <MonitorIcon size={14} />
              <div className="environment-text">
                <span className="environment-name">{kind === "sandbox" ? tr("沙箱", "Sandbox") : tr("远程", "Remote")}</span>
              </div>
              <span className="environment-soon">{tr("即将支持", "Coming soon")}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

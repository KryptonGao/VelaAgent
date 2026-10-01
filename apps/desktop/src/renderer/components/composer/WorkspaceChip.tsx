import { PopoverPresence } from "../MotionPresence";
import type { ProjectApi } from "../../hooks/useProject";
import { useDismissable } from "../../hooks/useDismissable";
import { CloseIcon, FolderIcon, PlusIcon } from "../icons";
import { useState } from "react";
import { tr } from "../../locale";

function workspaceName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function WorkspaceChip({ project }: { project: ProjectApi }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const current = project.workspace?.current ?? null;
  const recents = project.workspace?.recents ?? [];

  return (
    <div className="composer-chip-anchor" ref={ref}>
      <button
        type="button"
        className="composer-chip"
        title={current ?? tr("选择工作区", "Choose workspace")}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderIcon />
        <span>{current ? workspaceName(current) : tr("选择工作区", "Choose workspace")}</span>
      </button>
      <PopoverPresence present={open}>
        <div className="dock-popover composer-popover up workspace-picker">
          <div className="composer-popover-title">{tr("工作区", "Workspace")}</div>
          {current ? (
            <div className="workspace-current">
              <FolderIcon size={15} />
              <div className="workspace-current-text">
                <span className="workspace-current-name">{workspaceName(current)}</span>
                <span className="workspace-current-path" title={current}>
                  {current}
                </span>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            className="workspace-action-row"
            onClick={() => {
              setOpen(false);
              void project.openWorkspaceDialog();
            }}
          >
            <PlusIcon />
            <span>{tr("打开新的文件夹…", "Open a new folder…")}</span>
          </button>
          {recents.length > 0 ? (
            <>
              <div className="composer-popover-section">{tr("最近", "Recent")}</div>
              <div className="workspace-recent-list">
                {recents.map((recent) => (
                  <div
                    className={`workspace-recent-row${recent.path === current ? " active" : ""}`}
                    key={recent.path}
                  >
                    <button
                      type="button"
                      className="workspace-recent-main"
                      title={recent.path}
                      onClick={() => {
                        setOpen(false);
                        if (recent.path !== current) void project.selectRecentWorkspace(recent.path);
                      }}
                    >
                      <FolderIcon />
                      <span className="workspace-recent-name">{workspaceName(recent.path)}</span>
                    </button>
                    <button
                      type="button"
                      className="workspace-recent-remove"
                      title={tr("从最近列表移除", "Remove from recent list")}
                      aria-label={`${tr("从最近列表移除", "Remove from recent list")} ${workspaceName(recent.path)}`}
                      onClick={() => void project.removeRecentWorkspace(recent.path)}
                    >
                      <CloseIcon size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {current ? (
            <button
              type="button"
              className="workspace-action-row danger"
              onClick={() => {
                setOpen(false);
                void project.closeWorkspace();
              }}
            >
              <CloseIcon />
              <span>{tr("清除当前工作区", "Clear current workspace")}</span>
            </button>
          ) : null}
        </div>
      </PopoverPresence>
    </div>
  );
}

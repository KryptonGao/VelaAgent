import type { ReactNode } from "react";
import { tr } from "../locale";
import { DiffIcon, FolderIcon, TerminalIcon } from "./icons";

/** 起始页提供的三个入口;宿主据此打开对应标签页。 */
export type StartTabAction = "changes" | "terminal" | "files";

function StartOption({
  icon,
  title,
  description,
  disabled = false,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="start-option"
      disabled={disabled}
      onClick={onSelect}
      title={description}
    >
      <span className="start-option-icon" aria-hidden="true">{icon}</span>
      <span className="start-option-copy">
        <span className="start-option-title">{title}</span>
        <span className="start-option-description">{description}</span>
      </span>
    </button>
  );
}

/**
 * 新标签页的起始页:把工作面板最常用的三个入口集中展示。
 * 选中后由宿主把当前起始标签替换成对应内容。
 */
export function StartView({
  gitAvailable,
  onAction,
}: {
  gitAvailable: boolean;
  onAction: (action: StartTabAction) => void;
}) {
  return (
    <div className="start-view">
      <div className="start-view-inner">
        <div className="start-view-header">
          <h2>{tr("新标签页", "New tab")}</h2>
          <p>{tr("选择要在这个标签里打开的内容", "Pick what to open in this tab")}</p>
        </div>
        <div className="start-options">
          <StartOption
            icon={<DiffIcon size={16} />}
            title={tr("变更", "Changes")}
            description={
              gitAvailable
                ? tr("查看未提交的 Git 变更与差异", "Review uncommitted Git changes and diffs")
                : tr("当前工作区不是 Git 仓库", "The current workspace is not a Git repository")
            }
            disabled={!gitAvailable}
            onSelect={() => onAction("changes")}
          />
          <StartOption
            icon={<TerminalIcon size={16} />}
            title={tr("终端", "Terminal")}
            description={tr("在工作区目录运行命令", "Run commands in the workspace directory")}
            onSelect={() => onAction("terminal")}
          />
          <StartOption
            icon={<FolderIcon size={16} />}
            title={tr("文件预览", "File preview")}
            description={tr("浏览工作区文件并预览内容", "Browse workspace files and preview contents")}
            onSelect={() => onAction("files")}
          />
        </div>
      </div>
    </div>
  );
}

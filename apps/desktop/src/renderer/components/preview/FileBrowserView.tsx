import { useEffect } from "react";
import { tr } from "../../locale";
import { FileIcon } from "../icons";
import { ExplorerPane } from "./ExplorerPane";
import { useFilePreview } from "./FilePreviewContext";

/** 起始页的「文件预览」入口:只展示文件树,选中的文件在新标签页里打开。 */
export function FileBrowserView() {
  const preview = useFilePreview();

  useEffect(() => {
    preview?.ensureFileList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rootName = basename(preview?.fileList?.root) ?? tr("工作区", "Workspace");

  return (
    <div className="panel-file-preview-view">
      <div className="preview-subbar">
        <div className="preview-breadcrumbs-text">
          <span>{rootName}</span>
          <strong>{tr("文件", "Files")}</strong>
        </div>
      </div>
      <div className="preview-main-split">
        <div className="file-browser-empty">
          <span className="file-browser-empty-icon" aria-hidden="true">
            <FileIcon size={20} />
          </span>
          <p>{tr("还没有打开的文件", "No file is open yet")}</p>
          <span>{tr("在右侧文件树中选择文件，会在新标签页里打开预览", "Pick a file from the tree to open its preview in a new tab")}</span>
        </div>
        <ExplorerPane />
      </div>
    </div>
  );
}

function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.pop() ?? null;
}

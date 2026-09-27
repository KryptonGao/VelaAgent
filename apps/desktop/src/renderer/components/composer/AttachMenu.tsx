import type { FileAttachmentPayload } from "@vela/shared";
import { useDismissable } from "../../hooks/useDismissable";
import { FileIcon, ImageIcon, PlusIcon } from "../icons";
import { useState } from "react";
import { tr } from "../../locale";

export function AttachMenu({
  onAttachments,
  disabled,
}: {
  onAttachments: (payloads: FileAttachmentPayload[]) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  async function pick(kind: "file" | "image"): Promise<void> {
    const api = window.vela;
    if (!api) return;
    setOpen(false);
    const payloads = await api.pickAttachments(kind).catch(() => []);
    if (payloads.length > 0) onAttachments(payloads);
  }

  return (
    <div className="composer-chip-anchor" ref={ref}>
      <button
        type="button"
        className="attach-btn"
        title={tr("添加附件", "Add attachment")}
        aria-label={tr("添加附件", "Add attachment")}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon />
      </button>
      {open ? (
        <div className="dock-popover composer-popover up attach-menu">
          <button type="button" className="attach-menu-row" onClick={() => void pick("file")}>
            <FileIcon />
            <span>{tr("选择文件…", "Choose file…")}</span>
          </button>
          <button type="button" className="attach-menu-row" onClick={() => void pick("image")}>
            <ImageIcon />
            <span>{tr("选择图片…", "Choose image…")}</span>
          </button>
          <div className="composer-popover-footnote">{tr("也可以把文件或图片直接拖进输入框", "You can also drag files or images into the message box")}</div>
        </div>
      ) : null}
    </div>
  );
}

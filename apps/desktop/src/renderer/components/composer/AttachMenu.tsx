import type { FileAttachmentPayload } from "@vela/shared";
import { useDismissable } from "../../hooks/useDismissable";
import { FileIcon, ImageIcon, PlusIcon } from "../icons";
import { useState } from "react";

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
        title="添加附件"
        aria-label="添加附件"
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
            <span>选择文件…</span>
          </button>
          <button type="button" className="attach-menu-row" onClick={() => void pick("image")}>
            <ImageIcon />
            <span>选择图片…</span>
          </button>
          <div className="composer-popover-footnote">也可以把文件或图片直接拖进输入框</div>
        </div>
      ) : null}
    </div>
  );
}

import type { SandboxApprovalRequest } from "@vela/shared";
import { useState } from "react";
import { ShieldIcon } from "../icons";
import { tr } from "../../locale";

const kindLabels: Record<SandboxApprovalRequest["kind"], [string, string]> = {
  browser_repl: ["运行 JavaScript", "Run JavaScript"],
  bash: ["运行命令", "Run command"],
  edit: ["修改文件", "Edit file"],
  write: ["写入文件", "Write file"],
  mkdir: ["创建目录", "Create directory"],
};

/**
 * 「每次询问」模式下的审批条,出现在输入框顶部:
 * Agent 请求越界操作时等待用户允许或拒绝。
 */
export function ApprovalSlot({
  approval,
  onReply,
}: {
  approval: SandboxApprovalRequest | null;
  onReply: (id: string, allowed: boolean) => void;
}) {
  const [shown, setShown] = useState(approval);
  if (approval && shown?.id !== approval.id) setShown(approval);

  return (
    <div className={`approval-slot${approval ? " open" : ""}`}>
      <div className="approval-slot-inner" inert={approval ? undefined : true}>
        {shown ? <ApprovalBanner approval={shown} onReply={onReply} /> : null}
      </div>
    </div>
  );
}

export function ApprovalBanner({
  approval,
  onReply,
}: {
  approval: SandboxApprovalRequest;
  onReply: (id: string, allowed: boolean) => void;
}) {
  const summary =
    (approval.kind === "bash" || approval.kind === "browser_repl")
      ? approval.command ?? tr("(未提供命令)", "(No command provided)")
      : approval.path ?? tr("(未提供路径)", "(No path provided)");
  const [kindZh, kindEn] = kindLabels[approval.kind];

  return (
    <div className="approval-banner" role="alertdialog" aria-label={tr("执行权限请求", "Permission request")}>
      <div className="approval-banner-head">
        <span className="approval-banner-icon">
          <ShieldIcon size={13} />
        </span>
        <span className="approval-banner-title">{tr(`${kindZh}需要批准`, `${kindEn} requires approval`)}</span>
      </div>
      <pre className="approval-banner-summary">{summary}</pre>
      <div className="approval-banner-actions">
        <button
          type="button"
          className="approval-btn deny"
          onClick={() => onReply(approval.id, false)}
        >
          {tr("拒绝", "Deny")}
        </button>
        <button
          type="button"
          className="approval-btn allow"
          onClick={() => onReply(approval.id, true)}
        >
          {tr("允许一次", "Allow once")}
        </button>
      </div>
    </div>
  );
}

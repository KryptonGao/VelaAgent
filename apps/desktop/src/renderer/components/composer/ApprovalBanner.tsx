import type { SandboxApprovalRequest } from "@vela/shared";
import { useState } from "react";
import { ShieldIcon } from "../icons";

const kindLabels: Record<SandboxApprovalRequest["kind"], string> = {
  bash: "运行命令",
  edit: "修改文件",
  write: "写入文件",
  mkdir: "创建目录",
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
    approval.kind === "bash"
      ? approval.command ?? "(未提供命令)"
      : approval.path ?? "(未提供路径)";

  return (
    <div className="approval-banner" role="alertdialog" aria-label="执行权限请求">
      <div className="approval-banner-head">
        <span className="approval-banner-icon">
          <ShieldIcon size={13} />
        </span>
        <span className="approval-banner-title">{kindLabels[approval.kind]}需要批准</span>
      </div>
      <pre className="approval-banner-summary">{summary}</pre>
      <div className="approval-banner-actions">
        <button
          type="button"
          className="approval-btn deny"
          onClick={() => onReply(approval.id, false)}
        >
          拒绝
        </button>
        <button
          type="button"
          className="approval-btn allow"
          onClick={() => onReply(approval.id, true)}
        >
          允许一次
        </button>
      </div>
    </div>
  );
}

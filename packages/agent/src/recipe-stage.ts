import type { SessionEntry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RecipeStageEvidence, RecipeSubmitResult } from "@vela/shared";
import type { RuntimeEvent } from "./runtime";
import { isVisibleTranscriptMessage } from "./transcript";

const maxStageEvidence = 9999;

export const recipeStageSubagentDenial = "结构化阶段不能启动或控制独立子任务；阶段证据限当前会话";

/** 结构化阶段的回合关闭 Pi 的自动重试和 compaction；返回恢复原设置的函数。 */
export function suspendAutomaticRecovery(settings: SettingsManager): () => void {
  const retryEnabled = settings.getRetrySettings().enabled;
  const compactionEnabled = settings.getCompactionEnabled();
  settings.setRetryEnabled(false);
  settings.setCompactionEnabled(false);
  return () => {
    settings.setRetryEnabled(retryEnabled);
    settings.setCompactionEnabled(compactionEnabled);
  };
}

/** 从运行时事件里收集一次配方提交的结果；阶段提交同时记录工具证据。 */
export class RecipeSubmitOutcome {
  readonly evidence: RecipeStageEvidence[] = [];
  private failure: string | undefined;
  private result: RecipeSubmitResult | undefined;

  constructor(private readonly conversationId: string, private readonly collectEvidence: boolean) {}

  observe(event: RuntimeEvent): void {
    if (event.conversationId !== this.conversationId) return;
    if (event.type === "error") this.failure = event.message;
    if (this.collectEvidence && event.type === "tool_end" && this.evidence.length < maxStageEvidence) {
      const label = `${event.toolName} · ${event.isError ? "error" : "completed"}`.slice(0, 300);
      this.evidence.push({ type: "tool", id: event.toolCallId, label });
    }
    if (event.type === "prompt_end") {
      const status = event.status === "stopped" ? "stopped" : this.failure ? "failed" : event.status;
      this.result = { status, error: this.failure ?? event.error, planPending: event.planPending };
    }
  }

  /** 回合结束后调用；没收到 prompt_end 时按停止或错误推断，都没有就无法确认。 */
  settle(stopRequested: boolean): RecipeSubmitResult {
    if (this.result) return this.result;
    if (stopRequested) return { status: "stopped" };
    if (this.failure) return { status: "failed", error: this.failure };
    throw new Error("无法确认回合结果，请检查聊天");
  }
}

/** 阶段回复证据：提交前的叶子之后最后一条可见的 assistant 消息。 */
export function stageResponseEvidence(branch: readonly SessionEntry[], leaf: string | null | undefined): RecipeStageEvidence | null {
  const start = leaf ? branch.findIndex(item => item.id === leaf) + 1 : 0;
  const response = branch.slice(start).findLast(item =>
    item.type === "message" && item.message.role === "assistant" && isVisibleTranscriptMessage(item.message as AgentMessage));
  return response ? { type: "response", id: response.id, label: "阶段回复 / Stage response" } : null;
}

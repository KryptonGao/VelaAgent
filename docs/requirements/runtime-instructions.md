# 运行中追加指令需求文档

状态：已实现。  
日期：2026-10-03。  
范围：Vela 桌面端在回复进行中追加指令的投递方式、界面反馈与运行时落点。

## 1. 产品目标

回复进行中，用户仍可以继续输入。提交时按用户意图分成两种投递方式，停止沿用现有按钮：

| 方式 | 用户意图 | 生效时机 | 示例 |
| --- | --- | --- | --- |
| 排队发送 | 当前任务结束后继续做下一件事 | 当前任务自然结束、且没有待处理阻塞时 | “完成后补充使用说明” |
| 调整当前任务（Steering） | 补充约束、纠正方向或缩小范围 | 最早可达的执行边界，优先于下一步工作 | “只修登录问题，先不要重构路由” |
| 停止 | 中止当前执行 | 沿用现有停止机制 | 用户点击停止按钮 |

会话空闲时两种方式都按普通用户消息处理，不需要用户区分。

## 2. 交互与反馈

- 回复进行中，输入框保持可编辑；`Enter` 排队发送，`⌘Enter` / `Ctrl+Enter` 调整当前任务。
- 有输入时动作区显示「调整当前任务」按钮（带平台化快捷键提示）；主发送按钮此时是「排队发送」，停止按钮始终可见。
- 已提交、尚未被模型消费的指令显示在输入框上方：
  - 徽标区分「排队」与「调整」；
  - 单条可撤销，撤销后其余指令保持原顺序；
  - 指令真正进入会话后从待处理条消失，并作为用户消息出现在对话里。
- 点击停止会一并撤销所有待处理指令，行为与现有停止一致。

## 3. 语义与落点

两种方式直接映射 Pi `AgentSession` 的队列语义，不另造调度器：

- 排队发送 → `session.followUp()`：Pi 在「没有更多工具调用、也没有 steering 消息」时取出，正好是当前任务自然结束。
- 调整当前任务 → `session.steer()`：Pi 在当前 assistant 轮的工具调用结束后、下一次模型调用前取出。
- 停止 → `AgentRuntime.abort()`：清空 Pi 队列与待处理条，再中止当前运行。

运行时实现（`packages/agent/src/runtime.ts`）：

| 环节 | 实现 |
| --- | --- |
| 提交 | `AgentRuntime.prompt(..., deliverAs)`；会话运行中且有 `deliverAs` 时走 `appendInstruction()` |
| 待处理状态 | `Conversation.pendingInstructions`，镜像进 `SessionSnapshot.pendingInstructions` 并随状态事件广播 |
| 投递识别 | 监听 Pi 的 `queue_update`，按 steering / followUp 队列长度对账，补发 `user_message` 并计数 |
| 撤销 | `removeInstruction()`：`clearQueue()` 后按原顺序回放剩余指令，原始文本让技能命令重新展开 |
| 停止 | `abort()` 先清空待处理条与 Pi 队列，再中止 |

IPC / 渲染层：

- `PromptInput.deliverAs`、`VelaApi.prompt(text, images, conversationId, deliverAs)`、`VelaApi.removeInstruction(id, conversationId)`。
- `useSession.send(text, images, deliverAs)` 在追加模式下不预建消息，等主进程广播 `user_message`。
- `Composer` 渲染待处理条与「排队 / 调整」两个动作。

## 4. 边界行为

- 空指令在运行时与 IPC 解析处都会被拒绝。
- 撤销会重建 Pi 队列；重建期间忽略 `queue_update`，结束后再按队列现状补一次对账。
- 排队指令不参与自动标题生成，也不在提交时计入消息数；被模型消费时才计数。
- 待处理指令只存在于内存，应用重启后不恢复；会话回退（rewind）会清空。
- 排队指令在运行失败后保留，用户可撤销，或在下一次发言时由 Pi 队列继续投递。

## 5. 验收与测试

- `packages/agent/test/runtime-instructions.test.ts`：调整投递、排队投递、单条撤销回放、停止清空、空指令拒绝。
- `apps/desktop/test/motion-batch2-checks.ts`：运行中输入时动作区语义、排队 / 调整快捷键提交、待处理条进出场与撤销。
- `pnpm --filter @vela/agent typecheck`、`pnpm --filter @vela/desktop typecheck`、`pnpm --filter @vela/desktop build`。

# 对话导出

把一段对话导出为 Markdown 或单文件 HTML，附上工具调用、文件 diff 和轨迹（Trace），用于写 postmortem 或分享给同事。

## 使用

对话标题栏右侧的「更多对话操作」菜单里有两项：

- **导出为 Markdown…**：适合贴进 issue、PR 或文档。
- **导出为 HTML…**：单个自包含文件，不含脚本和外链，跟随系统亮暗色，工具输出与 diff 默认折叠，可直接用浏览器打开或打印。

点击后选择保存位置（默认在「文档」目录），保存完成会在 Finder 中定位文件。对话还没有消息时两项不可用；导出失败的原因显示在菜单里。

菜单使用固定选项：附上轨迹、附上文件 diff、**不**导出思考过程。底层接口支持改动这三项，见下文。

## 内容

按顺序包含：

1. 标题与元数据：对话 ID、工作区、创建与更新时间、Vela 版本。时间一律用 UTC，便于跨机器对照。
2. 概览：轮数、工具调用与失败数、修改的文件数、新增/删除行数；有轨迹时再加模型请求数、总耗时和总 token。
3. 失败与中断：失败的工具调用，以及轨迹里状态为 `Failed` 或 `Interrupted` 的节点（附完整失败文本，最多 50 个节点）。
4. 文件变更：按文件汇总 `edit`、`write` 的增删行数和编辑次数。
5. 对话记录：按轮展开用户消息、助手回复和工具调用。`edit`、`write` 带 diff；`bash` 带命令和输出；`read` 只写路径，不导出文件正文。每轮末尾列出该轮文件检查点记录的改动文件，这能补上 `bash` 等工具间接改动的文件。
6. 轨迹：模型请求表（模型、状态、耗时、首 token、输入/输出/缓存读取 token）和节点时间线。已完成的 `state` 节点省略。

长内容会截断并注明省略的字符数：`bash` 输出和失败文本上限 4000 / 2000 字符，其余工具输出 1200 字符，时间线最多 1000 行。用户消息里的图片只记录数量。

助手回复里的交互界面（`vela-ui` 块）导出为纯文字等价物，不含原始 JSON 或可点击动作；有用户保存的输入时使用保存值，详见 [intelligent-ui.md](./intelligent-ui.md)。实现在 `apps/desktop/src/main/intelligent-ui-export.ts`。

表头与小标题跟随应用语言（zh-CN、zh-TW、en、ja、ko）。工具名、轨迹节点类型和状态保持英文标识。

## 脱敏

导出前对整份文档统一处理：

- `redactSensitive`（`packages/shared/src/redaction.ts`）：JSON 里的密钥字段、`Bearer` 头、URL 里的敏感参数和 `user:pass@` 凭据。
- 导出专用的补充规则：`NAME=value` / `NAME: value` 形式的赋值（名称以 `token`、`secret`、`password`、`api_key`、`access_key`、`private_key` 结尾），以及 `sk-`、`ghp_`、`github_pat_`、`xox*-`、`AKIA`、`AIza` 开头的常见令牌。名称必须以敏感词结尾，所以 `max_tokens: 4096` 不会被误伤。
- 用户主目录替换为 `~`。MCP 工具内容在运行时已按对话脱敏。

脱敏是尽力而为，不能保证覆盖所有格式的密钥；文档末尾也会提示。分享前请自行检查，尤其是 `bash` 输出。

## 实现

| 模块 | 职责 |
| --- | --- |
| `apps/desktop/src/main/conversation-export.ts` 的 `buildConversationExport` | 纯函数。先把对话、轨迹和检查点组成中立的区块模型，再分别渲染 Markdown 和 HTML，两种格式内容一致。另有 `conversationExportFileName`、`parseExportOptions`。 |
| `apps/desktop/src/main/conversation-export-host.ts` 的 `ConversationExportHost` | 注册 `IpcChannel.sessionExport`。校验对话 ID 与选项，弹出保存对话框，之后才读取对话、轨迹和检查点（这样对话框打开期间完成的回复也会包含在内），写文件并定位。 |
| `apps/desktop/src/renderer/components/ChatActionsMenu.tsx` | 菜单入口，通过 `window.vela.exportConversation` 调用。 |
| `packages/shared/src/index.ts` 的 `ConversationExportOptions` | 选项类型：`format`（`markdown` 或 `html`）、`includeTrace`、`includeThinking`、`includeDiffs`。 |

数据来源：

- 对话与 diff：`AgentRuntime.getMessages`。`edit`、`write` 的 diff 来自工具结果，与对话里的「本轮变更」卡片一致。
- 轨迹：`AgentRuntime.getTrace`，失败节点的全文来自 `getTraceDetails`。
- 每轮改动的文件：`AgentRuntime.getCheckpoints`。工作区没有检查点或读取失败时只记一条日志并继续导出。

## 已知限制

- diff 来自 `edit`、`write` 工具的展示结果，保留了其「行首 +/-/空格 加行号」的格式，不是可 `git apply` 的补丁。`bash` 间接修改的文件只出现在每轮的检查点文件列表里，没有 diff。
- 导出的是当前分支上的对话。被回退（rewind）掉的轮次不在其中。
- 检查点超出保留策略（见 [checkpoints.md](./checkpoints.md)）被清理的轮次，没有「检查点记录的文件改动」一栏。
- 子代理（`task`）内部的步骤只以工具卡片的摘要形式出现。

## 验证

```bash
pnpm --filter @vela/desktop test:conversation-export   # 内容、脱敏、两种格式、选项
node apps/desktop/test/chat-actions-ui.mjs             # 菜单入口：选项、禁用、错误提示（真实 Electron）
```

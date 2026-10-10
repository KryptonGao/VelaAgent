# Agent Inbox

左侧栏的「Agent 收件箱」是一个独立的一级页面，把分散在各个对话里的审批、Agent 提问和后台任务结果集中到一处。它不属于任何工作区或对话，切换进去不会停止正在运行的 Agent，返回对话后原有的滚动位置和输入草稿保持不变。

本文描述已经实现的部分，覆盖需求文档中的全部七个阶段：事项数据层、独立页面、真实审批与提问（第一至第三阶段），以及 Resident Agent、Intelligent UI 嵌入、后台运行与主动规则（第四至第七阶段，见本文后半部分）。设计依据与验收见 [requirements/agent-inbox.md](./requirements/agent-inbox.md)。

## 事项

事项类型为 `approval`、`question`、`review`、`result`、`error`、`alert`、`suggestion`、`system`；当前会产生的有：

| 类型 | 来源 | 是否计入徽标 |
| --- | --- | --- |
| `approval` | `SandboxPermissionManager` 发出的真实工具审批请求（命令、文件写入、MCP、浏览器 REPL 等） | 是，待决时 |
| `question` | `ask_user_question` 工具发出的用户提问 | 是，待决时 |
| `error` | 对话回合失败、失败的子代理、失败或被中断的定时任务执行 | 是，确认前 |
| `review` | 对话回合结束且有待检查的计划 | 是，确认前 |
| `result` | 对话回合完成（包括任务配方的各阶段回合）、定时任务完成、Resident 后台任务完成 | 否 |
| `system` | 被策略跳过的定时任务执行 | 否 |
| `suggestion` | 主动规则触发的分析结果 | 否 |

**徽标只统计 `status === "pending"` 的事项**，等于「需要处理」视图的数量。每个对话回合结束都会产生一条事项，包括用户正在查看的对话，因为用户可能正停留在别的页面；用户主动停止的回合不记录。定时任务的对话由执行记录单独汇报，不会再产生第二条。子代理只汇报失败：完成的子代理会唤醒主代理，结果由主代理的回合汇报。

业务状态（`pending`、`resolved`、`rejected`、`expired`、`cancelled`、`invalidated`）与阅读状态（`unread`、`read`、`archived`）相互独立：

- 审批：允许为 `resolved`，拒绝为 `rejected`，超过 5 分钟无人回复被自动拒绝为 `expired`。
- 提问：回答为 `resolved`，跳过、停止对话或应用退出为 `cancelled`。
- **归档只改变显示。** 归档一条待决审批不会同意、拒绝或解除阻塞，它仍在「需要处理」中，徽标数量不变。

事项只保存摘要和决策所需的字段：命令截断为 2000 字符，不复制对话记录。事项指向 `conversationId`（审批与提问另有 `requestId`），不保存对话消息 ID，因为消息 ID 在每次载入时都会重新生成。

## 决策：只有 Host 能批准

Inbox 里的按钮提交的是类型化请求（`itemId`、`expectedRevision`、`decision`、`clientActionId`），由主进程决定是否执行：

1. 事项必须存在，版本号等于 `expectedRevision`，且仍是 `pending`；否则返回 `stale` 或 `not_pending`，不会调用 Host。
2. 决策必须在事项的 `actions` 内；回答必须是已存储选项之一，或在允许自由输入时为非空文本（≤ 4000 字符）。
3. 调用与聊天界面相同的入口：审批走 `SandboxPermissionManager.reply`，提问走 `AgentRuntime.replyQuestion`。它们现在返回 `boolean`，`false` 表示原等待点已不存在（已回复、超时、被中断或应用重启），此时事项标记为 `invalidated`，**不会宣称已批准**。
4. 事项状态由 Host 随后发出的 `resolved` 事件推进，因此在聊天里回答和在 Inbox 里回答汇合到同一个结果；已落定的事项不会被后到的事件覆盖。
5. 同一个 `clientActionId` 重复提交返回同一结果，不会再次调用 Host（防止双击）。

渲染层传来的 `requestId` 不被信任：主进程只使用事项里已存储的值。Intelligent UI 的 `submit_to_agent` 不是审批通道，也不会被当作审批。

审批请求的内容只有在事项待决时才提供「允许一次 / 拒绝」按钮；这两个按钮直接复用聊天里的 `ApprovalBanner`。多个审批可以同时存在，不像输入框上方的审批条那样只有一个槽位。

## 重启与恢复

审批和提问的等待点只存在于内存的 Promise 里，应用退出后不可能恢复。因此启动时仍为 `pending` 的 `approval` 与 `question` 一律标为 `invalidated`（`outcome: "app_restarted"`），不重放，也不显示可点击的决策按钮。`error` 与 `review` 只需要确认，重启后保持待处理。

存储遵循「先落盘、后通知」：每次变更先写 `agent-inbox.json`，成功后才推送给窗口。文件用临时文件加 `fsync` 后原子替换。存储损坏时原文件被改名为 `agent-inbox.json.corrupt-<时间戳>` 并以空库启动，页面顶部显示错误；不会静默覆盖。最多保留 1000 条，超出时先淘汰最旧的已完成且已归档事项，永远不淘汰待处理事项。

定时任务的执行记录用一个持久化的游标（`cursors.scheduledRunsAt`）去重，首次启用时只处理之后结束的记录，不会把历史执行灌进收件箱。

## 后台行为

适配器和 IPC 都运行在主进程。macOS 上关闭窗口后应用仍在运行，所以凌晨的定时任务请求审批时，事项会进入收件箱，重新打开窗口即可处理，不依赖 React 页面是否挂载。

仍然成立的限制：

- 审批 5 分钟没有回复会被 `SandboxPermissionManager` 自动拒绝，所以第二天早上看到的通常是 `expired`，需要重新触发任务。Inbox 不改变这个超时。
- 定时任务里的 `ask_user_question` 没有超时，回答前会占着该任务的执行锁。Inbox 让它可见，但不会自动处理。
- 睡眠或退出期间不会执行任何任务；Agent Inbox 不提供云端执行。

## 页面

- 视图：概览（需要你处理 + 最近动态）、需要处理、动态、归档。
- 搜索匹配标题、摘要、命令、路径和工作区；可按类型筛选；待处理的审批与提问排在最前，其余按最近更新。
- 点击事项会标为已读，详情显示来源、工作区、时间、对应的 Host 操作、「打开对话」与归档。
- 窄窗口（≤ 1100px）视图栏变成横条，列表与详情二选一，详情内有「返回列表」，`Esc` 同样返回。
- 主题只使用设计令牌，支持明暗；文案支持 zh-CN、en、zh-TW、ja、ko；列表项是原生按钮，状态用文字而不仅是颜色表达。
- 「Agent 收件箱」可以在设置的侧栏选项里隐藏；徽标始终来自主进程给出的数量。

## Resident Agent

Inbox 左侧导航的「Resident Agent」是一个常驻的协调者：它有一个持久的对话，能理解你交给它的事，并把需要动手的部分委派成工作区里的后台任务。它**不是第二套 Agent 引擎**：Resident 是 `AgentRuntime` 里的一个普通会话，后台任务通过 `runScheduledTask` 创建，运行时、模型、沙箱审批和 Intelligent UI 都沿用现有实现。

### 模式与状态

| 模式 | 行为 |
| --- | --- |
| `disabled` | 不创建新的后台任务，不监听任何事件。**不会中断**已经在运行的对话或任务。 |
| `standby`（默认） | 只处理你交给它的任务。没有新事件时不会调用模型。 |
| `proactive` | 在待命的基础上，按你订阅的规则在事件发生时主动分析。需要显式选择。 |

整体状态由真实记录推导：`paused` > `suspended`（系统休眠）> `offline`（关闭或运行时不可用）> `error` > `working`（有任务在运行或 Resident 正在回复）> `waiting_user`（有审批或提问在等你）> `ready`。有任务在运行时，即使另一个任务在等审批也显示 `working`，等待数量单独显示。

### 它能做什么、不能做什么

Resident 的会话**没有任何文件、命令、浏览器或 MCP 工具**，也不继承全局文件访问。它只有四个协调工具和 `ask_user_question`：

| 工具 | 作用 |
| --- | --- |
| `list_workspaces` | 列出已登记的工作区 |
| `list_background_tasks` | 列出任务及真实状态（不含任务提示和对话 ID） |
| `list_inbox_items` | 列出收件箱事项摘要 |
| `delegate_workspace_task` | 在**一个**已登记的工作区创建后台任务 |

其余工具在 `ToolLoadout.authorize` 被拒绝，并且这四个协调工具在普通对话里同样会被拒绝。每个委派都要经过一次类型为 `delegate` 的审批（显示目标工作区和任务内容），**即使在「帮我批准」模式下也不会交给模型自动判断**；用户拒绝后任务不会创建。批准期间如果状态变了（暂停、关闭），以批准当下的状态为准再检查一次。

### 后台任务

任务记录保存在 `resident-agent.json`（最多保留 60 条，排队上限 20）。执行受三个限制约束：同时运行数（默认 2）、单个任务最长运行时间（默认 60 分钟，超时会被停止并在收件箱里作为失败汇报）、规则触发的任务不会使用「完全访问」（全局设为完全访问时降为「帮我批准」）。用户或 Resident 创建的任务按当前的权限设置运行，需要的审批进入收件箱。

**重启不会重放**：启动时仍是 `queued` 或 `running` 的任务一律标为 `interrupted`，因为它们可能已经产生了副作用。暂停只阻止新任务启动，已在运行的不受影响，已排队的保持排队直到恢复。

任务结果按来源进入收件箱：Resident 创建的显示为「后台任务已完成/失败」，规则触发的显示为「主动建议」并带触发原因；Resident 自己成功的回合只在它的对话里看，不会再产生一条事项。

## Intelligent UI 嵌入

Intelligent UI 复用现有的 `vela-ui` 协议、`UiStreamParser`、`AssistantMarkdown` 与状态存储，没有新的解析器或组件：

- **事项详情**：结果、建议和计划事项在存储时只保留围栏之外的文字，并记录一个 `contentRef`（对话 ID、第几条含界面的回复 `u{n}`、正文指纹）。打开详情时主进程按这个位置重新读取原消息；对话被回退、改写或删除导致位置或指纹对不上时，回退到文字摘要并说明原因，不会渲染别的内容。
- **Resident 对话**：复用聊天的消息流，界面状态的键与聊天一致（会话 + `u{n}` + artifact）。
- **`submit_to_agent` 的目标由主进程决定**：Inbox 里按事项存储的 `conversationId` 投递，渲染层只传事项 ID 和文本，无法指定别的会话；Resident 对话里投递给 Resident。提交前仍要用户在界面上确认。界面动作**不是审批通道**：它只是一条普通消息，不能批准任何工具请求，真实审批只能用 Host 渲染的审批控件。

## 后台运行

- **关闭窗口**：默认应用继续在后台运行（macOS），设置里可改为关闭所有窗口时退出。退出后后台任务、通知和主动规则全部停止，Vela 不会宣称自己仍在线。
- **菜单栏**：可选的状态图标显示待处理数量，菜单有状态、打开 Inbox、打开 Resident、一键暂停/恢复、退出。
- **系统通知**：每个事项最多提醒一次；应用在前台、关闭通知或处于静默时段时不弹（事项和徽标不受影响）；默认只提醒待处理的审批、提问、失败、待检查计划和主动建议，任务完成需要手动开启；一分钟内超过 3 条会合并成一条汇总；可隐藏通知内容。点击通知打开对应事项。启动时已存在的事项不会再提醒。
- **登录启动**：设置里开启后（仅安装版）开机在后台启动，不开窗口。
- **睡眠与电池**：系统休眠时状态显示「系统休眠中」，规则不会触发；电池供电时默认暂停主动规则。任务本身不会因此被取消，也不会在唤醒后重放。
- **资源**：空闲时不调用模型也不轮询；文件监听只在 `proactive` 且未暂停时存在。

## 主动规则

规则由用户订阅，只在 `proactive` 模式下生效：

| 触发器 | 信号 | 合并窗口 |
| --- | --- | --- |
| `inbox_error` | 收件箱出现失败事项（可按标题/内容过滤） | 立即 |
| `git_change` | `.git` 的 `HEAD`/`MERGE_HEAD` 或 `logs` 变化（暂存区变化不算） | 3 秒 |
| `file_change` | 工作区文件变化（可按路径过滤；忽略 `.git`、`node_modules`、`dist`、`build` 等） | 5 秒 |

每个信号依次经过：模式与暂停 → 系统休眠 → 电池 → 同规则已有任务在运行 → 冷却时间 → 规则每日次数 → 全局每日主动运行上限（默认 10，设为 0 禁止），任何一项不满足就不会调用模型，并把原因记在规则上（「最近一次未触发：…」）。队列已满时按 30 秒、2 分钟、10 分钟退避重试，仍然失败就放弃这一批事件，且不占用冷却。保存一个文件产生的几十个事件只会启动一次运行，触发原因会列出具体的文件或提交。

规则默认**只读**（任务在 Plan 模式下运行）；开启「允许运行命令和修改文件」后，每个操作仍然需要在收件箱里批准。为避免循环，Resident 与主动分析自己的失败不会再触发规则。每次触发都会调用模型并产生费用，规则页面会明确提示。

## 限制

- 应用退出或电脑休眠期间不会执行任何东西；没有云端执行。
- 只支持 macOS 菜单栏；登录启动只在安装版有效，开发版不会注册登录项。
- 规则只有三种触发器（失败事项、Git 变化、文件变化），没有跨工作区的联合条件，也没有日历或外部服务事件。
- 文件监听使用 `fs.watch`，在网络盘或事件风暴下可能丢事件；漏掉的变化会在下一次变化时一并分析。
- Resident 看不到任务的对话内容，只能看到任务状态和收件箱摘要；需要细节时让它委派一个任务去读。

## 实现位置

| 内容 | 位置 |
| --- | --- |
| 类型、IPC 通道、排序与状态映射 | `packages/shared/src/agent-inbox.ts` |
| 存储、去重、状态机、决策 | `apps/desktop/src/main/agent-inbox-service.ts` 的 `AgentInboxService` |
| 事件适配（审批、提问、回合结束、子代理、定时任务） | `apps/desktop/src/main/agent-inbox-adapter.ts` 的 `AgentInboxAdapter` |
| IPC 与参数校验 | `apps/desktop/src/main/agent-inbox-host.ts` 的 `AgentInboxHost` |
| 原子写入 | `apps/desktop/src/main/atomic-json.ts` 的 `writeJsonAtomic` |
| 装配与退出顺序 | `apps/desktop/src/main/index.ts` |
| 渲染层缓存与订阅 | `components/agent-inbox-store.ts`、`hooks/useAgentInbox.ts` |
| 视图过滤与排序 | `components/agent-inbox-model.ts` |
| 页面 | `components/AgentInboxPage.tsx`、`AgentInboxQuestionForm.tsx`、`agent-inbox.css` |
| Resident 共享类型、设置规整、状态推导、规则准入 | `packages/shared/src/resident-agent.ts` |
| Resident 协调工具与提示 | `packages/agent/src/resident-tools.ts`、`runtime-tools.ts`（`ToolLoadout` 的 resident 分支）、`runtime.ts`（`ensureResidentConversation`、`promptBackground`） |
| 任务账本、队列、超时、委派审批、电源与睡眠 | `apps/desktop/src/main/resident-agent-supervisor.ts` |
| 主动规则 | `apps/desktop/src/main/proactive-rules.ts` |
| 系统通知、菜单栏 | `apps/desktop/src/main/agent-inbox-notifier.ts`、`resident-tray.ts` |
| Resident IPC | `apps/desktop/src/main/resident-agent-host.ts` |
| Resident 页面 | `components/ResidentAgentView.tsx`、`ResidentSettingsPanel.tsx`、`ProactiveRulesPanel.tsx`、`AgentInboxContent.tsx`、`resident-agent-model.ts`、`hooks/useResidentAgent.ts` |

每个 IPC 处理函数先确认调用方是应用窗口的主框架（webview 等子框架被拒绝），再把参数当作 `unknown` 逐项校验。命名上用 `AgentInbox`，因为「Inbox」已经被 [Pull Request 中心](./pr-inbox.md)占用。

## 验证

```sh
pnpm --filter @vela/desktop test:agent-inbox
pnpm --filter @vela/desktop test:resident-agent
pnpm test
pnpm test:ui
pnpm build && pnpm test:smoke
```

`test:agent-inbox` 使用可控时钟和临时目录，并用真实的 `QuestionManager` 与 `SandboxPermissionManager` 覆盖：事项去重、版本冲突、两个同时提交只有一个成功、重复 `clientActionId`、Host 等待点消失、聊天与 Inbox 汇合、拒绝与超时区分、重启作废、存储损坏隔离、容量淘汰、IPC 主框架与参数校验、渲染层缓存的推送序号缺口。`agent-inbox-ui` 在真实 Electron 里检查页面：徽标与「需要处理」一致、审批与回答、过期提交的提示、归档不解除阻塞、窄窗口、明暗主题和五种语言。

`test:resident-agent` 用可控时钟、假运行时、假监听和假电源事件覆盖：空闲不触发任何运行时调用、重启后把未完成任务标为中断而不重放、关闭与暂停只阻止新工作、并发与排队、超时停止、取消、委派审批与批准后的二次检查、规则任务不使用完全访问、休眠与电池、通知的去重与静默时段与合并、菜单栏描述、规则的合并窗口、冷却、每日上限、退避与循环保护，以及 Resident 工具与 `ToolLoadout` 的授权边界。`agent-inbox-ui` 另外覆盖委派审批的展示、事项里的 Intelligent UI 提交到事项来源且不会批准请求、Resident 页面的模式、暂停、对话、任务、规则、设置和导航。

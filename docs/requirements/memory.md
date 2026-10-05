# 项目记忆与全局记忆实施计划

状态：P1（存储与契约）、P2（会话加载）、P3（自动与明确指令写入）、P4（记忆管理界面）、P5（集成验证与文档）均已实现。实现说明与验证记录见下方对应小节，功能说明见 [项目记忆与全局记忆](../memory.md)。

日期：2026-10-05。

范围：Vela 桌面端的文件记忆、会话加载、自动与明确指令写入、记忆管理。

## 1. 目标与第一版范围

让不同会话可以复用用户偏好和项目知识，同时允许用户直接检查、编辑和删除原始内容。

采用两个层级的 Markdown 文件。文件是唯一内容来源，不维护数据库副本；主代理在当前对话中提炼长期信息并调用工具保存。

| 名称 | 存储位置 | 用途 |
| --- | --- | --- |
| 全局记忆 | `<agentDir>/MEMORY.md` | 跨项目复用的个人偏好、长期工作习惯 |
| 项目记忆 | `<会话工作区根目录>/.vela/MEMORY.md` | 当前项目的约定、决策、已知问题 |
| 全部记忆 | 无单独文件 | 全局记忆及已登记工作区项目记忆的汇总管理视图 |

全局目录复用现有 `agentDir`：安装版默认 `~/.vela`，开发版默认 `~/.vela-dev`，遵循 `VELA_USER_DATA` 覆盖。开发版和安装版不自动同步全局记忆。

### 第一版交付

- 主会话、恢复会话和子代理在执行前加载适用的记忆。
- 主代理主动保存明确的长期偏好、项目约定和已确认决策，同时支持用户明确要求“记住”“更新记忆”“忘掉”。
- 设置提供“全部记忆 / 全局记忆 / 项目记忆”的查看与管理。
- 支持外部编辑、冲突检测、串行写入和原子替换。
- 明确处理无项目会话、worktree、只读模式、超长文件与读取失败。

后续再考虑分文件索引、搜索和检索。当前不引入向量数据库、云同步、后台总结或自动整理任务。

## 2. 目录与身份规则

### 项目定位

- 项目记忆绑定会话自己的工作区，使用 `entry.snapshot.cwd` 和 `entry.hasWorkspace`。不能使用界面当前选中的工作区，否则后台会话可能读取其他项目的内容。
- 当前实现创建会话时固定工作区 `cwd`；工具内部进入子目录不改变记忆位置。若后续支持修改会话工作目录，需要另行明确项目绑定字段。
- `hasWorkspace === false` 的会话只加载全局记忆，即使其备用 `cwd` 恰好包含 `.vela/MEMORY.md`。
- 使用工作区真实路径作为项目文件身份，避免同一路径的别名在应用内形成不同写入队列。
- 非 Git 项目同样支持，不依赖 `git rev-parse`，也不向父目录查找其他项目的记忆。

### Worktree

- 第一版按实际 checkout 隔离：每个 worktree 读取和修改自己的 `.vela/MEMORY.md`。
- Git 已跟踪的文件可以随 checkout 出现；不自动复制原工作区未跟踪或未提交的记忆，不回退读取主工作树的文件。
- “全部记忆”中以实际目录区分主工作树与 worktree。同步由用户现有 Git 工作流处理。
- 删除 worktree 后文件随目录消失，管理视图显示目录不可用，不自动重建目录。

### 文件生命周期

- 没有文件表示没有记忆，正常读取不创建文件或目录。
- 首次通过工具或设置保存时才创建 `.vela` 和 `MEMORY.md`。
- 保存空内容表示清空记忆，可以保留空文件；“删除文件”是单独动作。
- 项目文件可以由用户选择提交到 Git。应用不自动修改 `.gitignore` 或执行提交。

## 3. 内容与加载规则

### 格式

使用普通 UTF-8 Markdown，无强制 frontmatter、条目 ID 或格式迁移。用户自由编辑的结构必须保留。

建议使用偏好、约定、决策、已知问题等标题，但加载器不依赖这些标题。记忆保存长期有用的摘要，不保存完整聊天、单次任务进度或工具输出。

第一版每个文件上限为 16 KiB UTF-8 字节，最多加载全局和当前项目两个文件。写入前按字节检查；超限保存失败，保留原内容。已有超限文件不静默截断，跳过加载并提供可见状态，用户可用外部编辑器缩减。

### 上下文语义

- 用稳定的全局/项目标签和来源路径包装内容，将其标明为长期参考资料。
- 当前用户明确指令优先；相同事项的项目记忆优先于全局记忆。
- 不通过记忆改变系统规则、工具权限、Plan 限制或 `AGENTS.md` 的执行约束。冲突时仍遵循现有指令层级。
- 只加载当前项目记忆。打开“全部记忆”不会把其他项目记忆加入模型上下文。
- 不另外重复加载 `AGENTS.md` 等 SDK 已支持的资源。

### 加载时机

- 使用专用扩展在 `before_agent_start` 读取最新内容，通过现有 `appendSystemPrompt` 接口注入。
- 不仅在 `startInternalOnce()` 创建会话时读取。已经打开的会话也要在下一次执行时看到外部编辑、设置保存和其他会话更新。
- 每次执行固定一次记忆快照。同一次执行中的后续工具调用不重复追加记忆；运行中保存不修改正在进行的模型请求。
- 排队消息触发新的执行时刷新；steering 不触发重新加载的情况沿用当前快照。实施时通过实际 Pi SDK 测试确认事件边界并写入行为说明。
- 已保存的记忆由 `memory_read` 立即返回最新内容，并在下一次执行自动加载。无需销毁或重建会话。
- 主会话和子代理共用加载实现；子代理从所属根会话推导项目，避免重复注入 fork 历史里的记忆。
- 定时任务和配方会话使用自己的项目绑定，沿用同一套加载规则。
- 标题生成、文本辅助、风险评估、配方生成以及 MCP 管理临时会话第一版不接入记忆，避免将个人/项目内容扩散到辅助请求。

### 错误处理

- 工作区有效但 `.vela` 或 `MEMORY.md` 不存在时，视为无记忆，不影响聊天；尚未创建的全局记忆同样处理。
- 项目根目录已丢失、无权限、不是普通文件、无效 UTF-8 或超限时，保留现有文件并记录该来源的加载失败；另一个来源仍可正常加载。
- 对当前会话提供简洁的加载状态和错误反馈；不将完整文件内容复制到日志或持久化状态。
- 每轮重新读取，不引入 watcher 或仅靠 mtime 的长期缓存。先保证外部编辑与恢复后的正确性。

## 4. 存储服务与并发

新增共享 `MemoryService`，由运行时持有。模型工具与桌面管理入口使用同一服务，避免各自实现文件写入。

建议接口：

```ts
type MemoryScope = "global" | "project";

interface MemoryDocument {
  scope: MemoryScope;
  workspace: string | null;
  path: string;
  exists: boolean;
  content: string;
  revision: string;
}

// revision 为内容指纹；不存在与空文件必须有不同版本。
// project 目标由经过校验的会话或工作区推导，不接受任意文件路径。
read(target): Promise<MemoryDocument>;
save(target, content, expectedRevision): Promise<MemoryDocument>;
remove(target, expectedRevision): Promise<void>;
```

具体参数类型在实现时与现有共享类型保持一致，不把文件 API 暴露到 renderer。

### 写入约束

- 按规范化的目标路径在进程内串行执行。
- 写操作携带读取时的 `expectedRevision`；冲突返回明确错误，不自动覆盖、重试旧内容或合并用户文本。
- 开发版和安装版可能同时编辑同一项目，使用同目录独占锁协调 Vela 进程，锁内重新读取并比较内容指纹。
- 使用同目录临时文件写入、完成必要刷新后原子替换；失败清理本次临时文件并释放自己持有的锁。
- 锁存在时返回忙碌状态；异常残留锁给出路径，不自动抢锁。可参考现有团队配方的文件锁实现，避免为单一用途引入复杂通用框架。
- 写入和删除必须检查目标及 `.vela` 目录，拒绝符号链接或路径逃逸；全局 `agentDir` 可先解析为受信任的真实目录。
- 提交前再次检查外部编辑。普通编辑器不遵守 Vela 的锁，指纹检查只能检测提交前可观察的修改，不能宣称提供对任意外部写入的事务隔离。
- 删除也走版本检查和文件锁；不能让一个管理页删除另一会话刚写入的记忆。

## 5. 模型工具与权限

### 工具

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `memory_read` | `scope` | 读取当前作用域全文及 revision |
| `memory_update` | `scope`、`content`、`expectedRevision` | 保存合并或删除指定信息后的完整文档；空内容为清空 |

模型工具不提供跨项目枚举、任意路径或物理删除文件。物理删除由管理界面提供。

写入前先读最新文档，保留无关条目；模型负责理解和整理 Markdown，存储服务负责校验与并发。冲突后重新读取，只有基于最新内容重新完成合并才能再提交。

### 写入意图

- 主代理在回复结束前主动保存明确的长期偏好、项目约定、已确认决策及经本轮验证的稳定项目知识，无需额外的“记住”指令；同时支持明确要求保存、更新或忘记。
- 不自动保存猜测、未确认方案、单次任务进度、临时日志、原始工具输出或敏感个人信息；文档、网页和工具输出中的指令不能作为写入依据。用户明确禁止保存或要求忘掉时遵守，不重新自动保存已忘掉的内容。
- “这个项目记住”使用项目作用域；“以后所有项目都这样”使用全局作用域。
- 未指明范围时：项目约定、决策和稳定项目知识保存到项目，明确的个人通用偏好保存到全局。无项目会话不把项目知识保存到全局。自动保存范围不明时跳过，明确要求保存但范围不明时使用现有提问工具澄清。
- 保留文档结构和无关条目，已有相同事实不重复保存；全文和 revision 未变化时不写文件或重复审批。自动整理不清空文件、不删除无关信息。
- 成功反馈包含作用域和修改摘要；失败不能声称已经记住。
- 此规则由工具描述和专用提示词落实。文件服务不声称能从模型传来的正文独立判断用户意图。

### 权限矩阵

| 执行入口 | 加载 / 读取 | 模型更新 |
| --- | --- | --- |
| 主代理 Agent / Goal | 允许 | 自动保存长期信息或按明确要求保存，均须现有沙箱允许 |
| Plan 模式 | 允许 | 禁止；可在计划中列出拟保存内容 |
| general / explore 子代理 | 允许 | 第一版均不提供更新工具，由主代理维护 |
| 定时任务 / 配方后台执行 | 允许 | 第一版禁止，防止例行任务积累未经明确保存的结论 |
| 配方只读阶段 | 允许 | 禁止 |

工具隐藏和执行前校验同时落实限制。子代理/后台上下文不能通过直接调用已注册工具绕过矩阵。通用 `write`/`edit`/`bash` 仍服从现有权限与只读守卫；工具描述明确要求通过专用接口维护记忆。第一版不宣称对任意 shell 文件操作建立新的系统级隔离。

`memory_update` 复用现有 `SandboxPermissionManager` 的写权限判断，在产生副作用之前调用。全局文件一般位于工作区外，按现有 ask / smart / full 策略处理，不能因自定义工具而绕过。桌面上明确点击保存属于用户直接文件操作，不再转成模型工具审批。

## 6. 桌面管理与 IPC

在现有设置导航新增“记忆”，复用设置页排版、表单和中英文文案。第一版不另做独立文件编辑器。

- “全部记忆”：全局文件及已登记工作区的项目文件列表，显示作用域、项目名、路径和状态；点击进入对应编辑视图。
- 项目范围来自应用已登记的工作区，不扫描磁盘、不搜集任意历史目录。失效工作区保留不可用状态，单项读取错误不阻塞整个列表。
- “全局记忆”：查看/编辑当前 Vela profile 的文件。
- “项目记忆”：默认选中当前会话的实际项目，也可显式选择已登记工作区；无项目时不显示可保存的项目目标。
- 提供编辑、保存、取消、清空内容、删除文件、在文件管理器中定位；缺失文件显示空状态，显式保存后创建。
- 未保存草稿在切换作用域或关闭页面时沿用现有可适用的草稿处理模式，不能静默丢失。
- 保存时携带 revision；冲突保留草稿并提示重新加载，不自动覆盖。
- 加载失败、保存失败、文件超限、锁占用分别显示可操作错误。记忆正文按普通 Markdown/文本处理，不执行嵌入 HTML。

共享 `VelaApi.memory` 提供 `list`、`read`、`save`、`remove`；`IpcChannel` 注册对应通道。列表以来源元数据为主，选中后读取正文。

主进程校验 scope、项目登记、content 字节数和 revision 类型；项目访问以经过验证的工作区身份为准，不能直接使用 renderer 传来的任意路径。Agent 工具只能访问所属会话的项目；管理入口才允许用户选择其他已登记项目。

## 7. 代码接入位置

| 位置 | 改动 |
| --- | --- |
| `packages/agent/src/memory.ts`（新增） | 路径解析、读取、指纹、串行写入、文件锁与错误类型 |
| `packages/agent/src/memory-tools.ts`（新增） | read/update 工具、输入校验、执行上下文检查与写权限回调 |
| `packages/agent/src/memory-context.ts`（新增） | 内容包装、加载状态与 `before_agent_start` 扩展 |
| `packages/agent/src/runtime.ts` | 根会话/子代理接入、工具注册与激活、服务入口与状态事件 |
| `packages/agent/src/interaction.ts` | Plan 读取工具白名单、写工具拒绝规则与记忆使用提示 |
| `packages/agent/src/index.ts` | 仅导出桌面端需要的服务或类型 |
| `packages/shared/src/memory.ts`（新增） | Memory 类型、目标身份、加载状态与错误码 |
| `packages/shared/src/index.ts` | 统一导出记忆契约；IPC 通道及 `VelaApi.memory`（P4） |
| `apps/desktop/src/main/index.ts` | 注入权限回调及工作区查询，避免 agent 包依赖 workspace 包 |
| `apps/desktop/src/main/memory-host.ts`（新增） | 管理 IPC 请求校验（作用域、已登记工作区、字节数、revision）与 `MemoryService` 路由 |
| `apps/desktop/src/main/index.ts` | 注入已登记工作区集合，创建并释放 `MemoryHost` |
| `apps/desktop/src/preload/index.ts` | 暴露受限 memory API |
| `apps/desktop/src/renderer/components/MemorySettingsSection.tsx`（新增） | 列表、编辑、冲突和错误状态 |
| `SettingsView.tsx` / `settings-copy.ts` / `styles.css` | 设置入口、中英文与必要布局样式 |

文件边界以实际实现复杂度为准，不为每个简单函数强制创建模块。不能只向 `customTools` 加入工具：同时覆盖 `defaultTools`、`nativeToolNames`、`applyActiveTools`、MCP 刷新后的工具集合、模式切换和子代理集合。

## 8. 实施顺序

### P1：存储与契约（已实现）

- [x] 定义作用域、目标身份、revision、错误和加载状态。
- [x] 实现 profile / 项目路径解析、只读加载、文件大小与格式校验。
- [x] 实现带版本检查的保存/删除、跨 Vela 进程锁与原子替换。
- [x] 用定向测试覆盖缺失、空文件、外部编辑和并发写入。

实现落点：`packages/shared/src/memory.ts` 定义作用域、目标、revision、错误码与加载状态；`packages/agent/src/memory.ts` 提供 `MemoryService` 与 `MemoryError`；定向测试在 `packages/agent/test/memory.test.ts`，已接入 `@vela/agent` 的 `test` 脚本。revision 为文件 UTF-8 字节的 sha256，缺失文件固定使用 `absent`，因此不存在与空文件版本不同。

验收：可以通过服务读取和更新两个文件，冲突和失败不会损坏已有内容；不存在时读取无副作用。

### P2：会话加载（已实现）

- [x] 实现记忆扩展和来源包装，根会话与子代理共用。
- [x] 接入每次执行、新建、恢复、后台会话和 worktree。
- [x] 提供加载状态；确认排队/steering 的实际刷新边界。
- [x] 确认辅助生成不携带记忆，并检查 fork 不重复携带注入内容。

实现落点：`packages/agent/src/memory-context.ts` 提供目标推导、来源包装和 `before_agent_start` 扩展；`packages/agent/src/runtime.ts` 在根会话和子代理的 extension factories 中接入同一实现，并通过会话快照 `SessionSnapshot.memory` 与 `getMemoryStatus()` 提供不含正文的加载状态；`packages/shared/src/memory.ts` 增加 `MemoryLoadReport`。

定向测试：`packages/agent/test/memory-context.test.ts`（目标推导、来源包装、缺失/超限/无工作区）与 `packages/agent/test/memory-runtime.test.ts`（真实 Pi 会话加脚本化模型请求：新建/恢复/后台/worktree、外部编辑下一次执行生效、steer/queue 同轮沿用快照、fork 不重复注入、无工作区隔离、超限文件不阻塞聊天）。

行为确认：Pi 的 `before_agent_start` 每次执行只触发一次，执行内的工具调用、steering 和排队消息共享同一快照；执行结束后的下一条消息触发新执行并重新读取。标题生成、文本辅助、风险评估、配方生成走 `ModelRuntime.completeSimple` 独立请求，MCP 管理会话使用 `noExtensions: true`，都不经过记忆扩展。

验收：跨会话可复用；外部编辑下一次执行生效；切换界面项目不会污染后台会话；其他项目正文不进入当前上下文。

### P3：自动与明确指令写入

- [x] 实现 `memory_read` / `memory_update` 和使用提示。
- [x] 接入工具激活、模式切换、执行前权限和沙箱写入回调。
- [x] 验证 Plan、两类子代理和后台任务的读取/写入矩阵。
- [x] 确认模型成功/失败反馈，以及冲突后重新读取的行为。

实现落点：`packages/agent/src/memory-tools.ts` 提供 `memory_read` / `memory_update`、`memoryInstructions` / `memoryReadOnlyInstructions`、`MemoryWritePermission` 与 `allowUpdate` 执行前检查；`packages/agent/src/runtime.ts` 在主代理注册两个工具并按矩阵激活（Plan、配方只读阶段、配方/定时任务后台和子代理只激活 `memory_read`），`memory_update` 在副作用前经 `memoryPermission` 复用 `SandboxPermissionManager` 的写权限，`packages/agent/src/interaction.ts` 把 `memory_read` 加入 Plan 白名单并拒绝 Plan 写入；`apps/desktop/src/main/index.ts` 注入 `memoryPermission`，项目文件标记为工作区内、全局文件标记为工作区外，按 ask / smart / full 策略处理。

定向测试：`packages/agent/test/memory-tools.test.ts`（读取全文与 revision、缺失/超限/无工作区、冲突、拒绝、无权限入口失败关闭、`update=false` 只注册读取、空内容清空）与 `packages/agent/test/memory-tools-runtime.test.ts`（真实 Pi 会话里模型读取后按 revision 保存、冲突无副作用、Plan/explore/general/定时任务/配方执行的读写矩阵）。`pi-sdk-compatibility.test.ts` 的工具集合断言同步更新。

自动写入增量验证（2026-10-05）：新增 8 项测试，覆盖无需“记住”指令的项目/全局保存、无工作区全局保存、下一轮自动加载、审批拒绝、相同内容跳过存储与审批、缺失文件空内容保存、审批期间进入只读模式和外部修改。`pnpm --filter @vela/desktop test:memory` 70/70 通过；Plan、Goal、沙箱风险、子代理回归 52/52 及桌面审批回归 5/5 通过；agent 与 desktop 类型检查通过。未运行全仓回归，存储实现与共享契约未修改；未用真实模型验证信息选择质量。

行为确认：工具描述与提示词指导主代理在对话中自动保存明确的长期信息，仍支持用户明确指令；冲突在权限审批之前发现并返回 `conflict` 工具错误，原内容保留，重新读取后可提交；被拒绝、无权限入口、无工作区或超限时都没有文件副作用；成功反馈包含作用域、路径和 revision。相同内容不重复写入或审批，审批结束后再次检查只读限制，存储服务检查等待期间的并发修改。

验收：无需“记住”指令即可通过工具保存到正确作用域，下一轮自动加载；缺少新的长期信息时不保存；被拒绝、进入只读环境或冲突时没有文件副作用。自动信息选择由当前对话模型按系统提示执行，脚本模型测试覆盖工具、持久化与加载链路。

### P4：记忆管理界面

- [x] 接入 IPC 和 preload，校验用户选择的项目身份。
- [x] 新增设置入口、全部记忆列表、全局/项目编辑视图。
- [x] 完成草稿、缺失、失效路径、错误、冲突、清空和删除状态。
- [x] 检查中英文、键盘操作与当前设置容器的布局。

实现落点：`apps/desktop/src/main/memory-host.ts` 提供 `MemoryHost`，校验作用域、已登记工作区身份、内容字节数与 revision 类型后路由到 `AgentRuntime` 的 `MemoryService`；项目访问按路径或真实路径匹配已登记工作区，未登记路径返回 `invalid-target`，预期内的失败以结构化 `MemoryResult` 返回。`packages/shared/src/memory.ts` 增加 `MemoryApi`、`MemoryCatalog`、`MemoryProject`、`MemoryResult` 等契约，`packages/shared/src/index.ts` 注册 `memory:list/read/save/remove` 通道并暴露 `VelaApi.memory`；`apps/desktop/src/preload/index.ts` 暴露受限 API；`apps/desktop/src/main/index.ts` 把当前工作区、最近工作区和已有会话工作目录作为已登记工作区传入。`apps/desktop/src/renderer/components/MemorySettingsSection.tsx` 提供“全部记忆 / 全局记忆 / 项目记忆”三个视图与编辑、保存、取消、清空、删除、在文件中显示动作，`memory-settings-model.ts` 负责草稿存储、字节数与错误文案；草稿按目标保存在 `uiStorage`，切换作用域或关闭设置后恢复；冲突保留草稿并提供“重新加载”；中英文文案与布局见 `SettingsView.tsx`、`settings-copy.ts` 和 `styles.css`。

定向测试：`apps/desktop/test/memory-host.test.ts`（请求形状、通道释放、主框架校验、列表单项失败隔离、未登记/任意路径拒绝、超限无副作用、读写删与冲突）与 `apps/desktop/test/memory-settings.test.ts`（字节上限、目录推导、中英文状态与错误文案、草稿存取）。`apps/desktop/test/memory-settings-ui.mjs` 在真实 Electron 渲染层验证列表状态、按 revision 保存、冲突保留草稿与重新加载、跨视图草稿、清空保存、确认删除、Command/Ctrl + S、方向键切换标签和中英文渲染。

验收：用户可独立管理记忆，不需要通过模型发消息；全局和项目操作不会误写另一来源。

### P5：集成验证与文档

- [x] 完成下方验证矩阵并记录执行结果。
- [x] 在 README 或功能文档说明目录、作用域、刷新时机与 worktree 行为。
- [x] 根据实际交付更新本文状态，不提前标为已实现。

实现落点：新增专题文档 `docs/memory.md`（目录、作用域、加载与刷新时机、写入权限、设置页管理、worktree 行为与边界），并在 `docs/README.md` 与根 `README.md` 的功能列表中提供入口；本文状态与 P1–P5 小节按实际交付更新。

验证记录（2026-10-05，开发版工作目录）：

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 存储、上下文、权限、IPC 与设置模型 | `pnpm --filter @vela/desktop test:memory` | 62 项通过 |
| 渲染层记忆设置 | `pnpm --filter @vela/desktop test:memory:ui` | 10 项检查通过 |
| 类型检查 | `pnpm --filter @vela/shared typecheck`、`@vela/agent typecheck`、`@vela/desktop typecheck` | 通过 |
| 桌面构建 | `pnpm --filter @vela/desktop build` | 通过，main / preload 包含记忆通道与 API |
| 更广回归 | `packages/agent` 的 `plan`、`pi-sdk-compatibility`、`agent-control`、`subagent`、会话持久化、`mcp-runtime`、`scheduled-tasks`、`task-recipes`、`recipe-generator` 定向测试 | 120 项通过 |

矩阵逐项对照见下方“验证矩阵执行结果”。

## 9. 风险与验证

本文属于低风险文档变更，只检查 diff 和文档一致性，不运行回归测试。

功能实施属于高风险：涉及持久化、共享运行时、工具权限、子代理和跨进程写入。先做定向验证，再覆盖受影响系统，不默认运行整个仓库的回归。

| 系统 | 必须验证的行为 |
| --- | --- |
| 存储 | 缺失/空文件、UTF-8 字节上限、非普通文件、符号链接、目录丢失、写失败后原内容保留 |
| 并发 | 双会话/双服务写入、跨进程锁、同版本外部编辑、冲突草稿保留、残留锁、删除与保存竞争 |
| 上下文 | 全局+当前项目、无项目、其他项目隔离、下一次刷新、恢复、fork、worktree 独立文件 |
| 权限 | Plan 允许读而拒绝写、模式切换、子代理/后台拒绝写、沙箱拒绝与取消无副作用 |
| 运行时 | MCP 刷新后工具仍正确、排队/steering、会话恢复、定时任务/配方只读阶段 |
| IPC/UI | 任意路径拒绝、未登记项目拒绝、草稿保留、版本冲突、缺失及错误状态、中英文 |

### 验证矩阵执行结果

| 系统 | 覆盖与结果 |
| --- | --- |
| 存储 | `packages/agent/test/memory.test.ts`：缺失/空文件、UTF-8 字节上限、非普通文件、符号链接、目录丢失、写失败保留原内容；`test:memory` 通过。 |
| 并发 | `memory.test.ts`：同进程串行、其他进程锁、外部编辑后旧 revision 被拒、删除与保存竞争、删除幂等；`test:memory` 通过。 |
| 上下文 | `memory-context.test.ts` 与 `memory-runtime.test.ts`：全局+当前项目、无项目、其他项目隔离、下一次刷新、恢复、fork 不重复注入、worktree 独立文件；`test:memory` 通过。 |
| 权限 | `memory-tools.test.ts` 与 `memory-tools-runtime.test.ts`：Plan 允许读而拒绝写、模式切换、子代理/后台拒绝写、沙箱拒绝与取消无副作用；`test:memory` 通过。 |
| 运行时 | 更广回归覆盖 `plan`、`pi-sdk-compatibility`、`agent-control`、`subagent`、会话持久化、`mcp-runtime`、`scheduled-tasks`、`task-recipes` 与 `recipe-generator`，120 项通过；`pi-sdk-compatibility.test.ts` 断言模式切换后的记忆工具集合，`mcp-runtime.test.ts` 的 busy reload 用例断言 MCP 刷新重算激活集合后仍保留内置记忆工具。 |
| IPC/UI | `apps/desktop/test/memory-host.test.ts` 覆盖任意路径与未登记项目拒绝、超限无副作用、冲突；`memory-settings.test.ts` 覆盖中英文与草稿存储；`memory-settings-ui.mjs` 覆盖草稿保留、版本冲突、缺失及错误状态、中英文渲染与键盘操作。 |

新增测试建议集中在 `memory.test.ts`、`memory-runtime.test.ts`、`memory-tools.test.ts` 和桌面 `memory-host.test.ts`，沿用现有测试框架，并按包的现有方式接入测试命令。

完成相关阶段后执行受影响包的 typecheck；renderer / preload 集成后执行 desktop build。更广验证重点覆盖已有 `plan.test.ts`、`pi-sdk-compatibility.test.ts`、`agent-control.test.ts`、`subagent.test.ts`、会话持久化、MCP runtime 以及受影响的定时任务/配方测试。

只有工具策略影响范围难以界定、定向验证暴露跨系统问题，或发布/合并要求时才扩大到全量回归。无关失败单独记录，不顺带修复。

## 10. 最终验收场景

1. 项目 A 要求记住测试命令，创建 A 的 `.vela/MEMORY.md`；A 新会话能使用该命令，项目 B 不会获得该条目。
2. 用户要求所有项目默认中文回复，写入当前 profile 的 `MEMORY.md`；A、B 和无项目会话都可加载。
3. 项目记忆与个人偏好对同一事项冲突时采用项目值；本轮用户指定其他值时采用本轮指令。
4. 外部编辑项目记忆后，已打开会话下一次执行使用新内容；运行中的请求沿用已有快照。
5. 两个会话同时更新同一文件时，后提交的旧 revision 被拒绝，不丢失先提交的内容。
6. Plan 会话和 explore/general 子代理能读取，更新调用被拒绝；定时任务和配方执行不写入。
7. 全部记忆列表显示多个来源，但当前模型请求只有全局和所属项目的内容。
8. 保存失败、文件超限或目录不可用时，用户看到具体状态；原文件被保留，正常聊天可继续。

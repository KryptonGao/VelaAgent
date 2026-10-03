# 定时任务

左侧栏「新对话」上方的「定时任务」打开独立的定时任务页面，页面占据主区域，不与对话框或右侧 Workbench 并列。可以创建、编辑、暂停/恢复、删除、立即执行任务，并在执行记录中打开对应对话。

也可以在 Agent/Goal 对话里输入「每天晚上 10 点提醒我复习英语」。Agent 使用 `create_scheduled_task` 将明确的提醒或执行请求保存到当前对话工作区。`list_scheduled_tasks`、`update_scheduled_task`、`delete_scheduled_task` 提供查询、修改、暂停/恢复和删除；Plan 模式只开放查询。工具始终限制在调用对话的工作区，UI 则可管理全部工作区。

## 时间与执行

- 一次性：包含时区的 ISO 8601 时间。UI 的日期输入使用本机时区。
- 每日：HH:mm 与 IANA 时区，例如 `22:00`、`Asia/Taipei`。
- 每周：时间、时区与星期列表；0 为周日，6 为周六。
- Cron：五段表达式（分、时、日、月、星期），例如 `0 22 * * *`。使用 cron-parser 按保存的时区计算下一次时间，支持夏令时。

Electron Main Process 持有调度器。它使用最近截止时间的定时器，同时最多每 30 秒核对一次系统时间，并监听 `powerMonitor` 的 suspend/resume。渲染窗口关闭后，macOS 上只要应用仍在运行，调度继续；应用退出时停止。

每次实际执行都会在绑定工作区新建并持久化独立对话，通过 `AgentRuntime.runScheduledTask` 调用现有 `prompt` 执行。采用普通 Agent 模式。创建和编辑任务时可选择执行权限（每次询问、帮我批准、完全访问）、模型及推理强度；模型列表与对话共用，推理强度只显示所选模型支持的选项。三项也可分别选择「沿用应用设置」，执行时按现有新对话选择规则和全局权限取值，旧任务保持此行为。显式指定的模型不可用时记录失败，不回退到其他模型。任务设置持久化，适用于定时执行和立即执行，不改变当前对话或应用默认设置。权限传入该任务对话及其子代理的文件、终端、浏览器和 MCP 工具；帮我批准使用任务对话的模型判断风险，每次询问及风险操作可能等待用户确认。缺少模型、工作区不可用或执行失败都会进入记录。执行不会切换用户当时查看的对话或工作区。立即执行也创建新对话，不消耗下一次定时执行；暂停或已完成的任务仍可立即执行。

## 错过、并发与恢复

应用退出或电脑睡眠期间不会执行。恢复时，默认 `run-once` 将积压次数合并为一次补执行，然后从当前时间计算下次执行；`skip` 跳过迟到超过 60 秒的执行。一次性任务在触发或跳过后进入 completed。

同一任务最多有一个执行中的调用，重复「立即执行」会报错，定时周期到来时若上次仍未结束则记录 skipped 并推进周期。暂停只停止未来调度，当前执行继续；执行中的任务禁止删除，可以打开对话使用现有停止操作。恢复过期的一次性任务需要先编辑为未来的时间。

任务与记录保存于 Vela 数据目录的 `scheduled-tasks.json`（默认 `~/.vela`，可通过现有 `VELA_USER_DATA` 覆盖）。每次变更用临时文件原子替换；执行开始前先保存 running 记录与推进后的下次时间，再创建对话和执行 Prompt。每个任务保留最近 100 条已结束记录及执行中的记录。

应用只允许一个 Main Process 实例持有调度队列。正常退出时将执行中的记录标为 interrupted；意外退出遗留的 running 记录在重启时也转换为 interrupted，保留已创建的对话 ID，不自动重放原执行。对外部操作无法承诺严格的 exactly-once；该策略优先避免重启后重复操作。用户可以检查对应对话后选择立即执行。

## 实现与验证

共享类型与 IPC：`packages/shared/src/scheduled-tasks.ts`。时间解析、存储与调度：`apps/desktop/src/main/task-schedule.ts`、`scheduled-task-service.ts`。Electron 生命周期与 IPC：`scheduled-task-host.ts`。Agent 工具：`packages/agent/src/scheduled-task-tools.ts`。管理 UI：`ScheduledTasksPage.tsx`。

```sh
pnpm --filter @vela/desktop test:scheduled-tasks
pnpm typecheck
pnpm build
pnpm --filter @vela/desktop test:scheduled-tasks:electron
```

定向测试使用可控时钟和本地模型流覆盖自然语言对话的真实工具调用、权限/工作区隔离、后台对话、时区/夏令时、错过执行、并发、暂停恢复、存储失败和重启中断。Electron 测试使用隔离数据目录启动生产 Main/Preload/Renderer，再重启验证存储恢复，同时操作真实管理表单与按钮。

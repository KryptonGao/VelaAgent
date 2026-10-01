# Plan 模式

Plan 模式让 Agent 在不改动任何文件的前提下查阅代码、澄清需求，并输出一份可以直接交给实现 agent 的完整实施方案。方案以 revision 的形式保存，用户批准后可以选择沿用当前对话或换一个干净的执行上下文来实施。

本文描述界面上的行为、可用操作和限制。实现细节见 [plan-mode-architecture.md](./plan-mode-architecture.md)。

## 三种任务模式

模式决定系统提示词、可用工具和执行前检查。下表依据 `packages/agent/src/interaction.ts` 的 `toolNamesFor`：

| 模式 | 能否修改文件 | 可用工具 | 典型用途 |
| --- | --- | --- | --- |
| `Agent` | 能 | `read`、`bash`、`edit`、`write`，以及子代理等 agent 树工具、`ask_user_question`；有已批准的执行计划时额外提供 `update_plan` | 日常读写、执行任务 |
| `Plan` | 不能 | `read`、`bash`、`ask_user_question` | 调研并输出完整实施方案 |
| `Goal` | 能 | `read`、`bash`、`edit`、`write`、agent 树工具、`record_goal_validation`、`update_goal` | 多步目标，持续推进到完成 |

Plan 模式没有文件写入工具，也没有 `update_plan` 和子代理工具；`bash` 只放行只读命令（见「只读限制」）。

## 一次规划的流程

1. 在输入框上方的模式选择器里切到 `Plan`。
2. 用一句话描述目标。Agent 会先读代码，把相关模块、数据流、接口、持久化和现存问题查清楚；能自己查的不会反问。
3. 只有产品偏好、无法从代码推断的行为选择、tradeoff 或缺失需求，Agent 才会用 `ask_user_question` 在会话里提问，你可以点选项、自由输入或跳过。
4. 方案成型后，Agent 把完整 Markdown 方案放进 `<proposed_plan>` 块输出。界面会把这个块从聊天正文里剥离，替换成一张「计划」预览卡，显示标题、修订号和方案概要。
5. 方案开始生成时，右侧的 Plan Document 会自动打开并实时填入正文；生成过程中状态显示为「生成中」。
6. 方案生成结束后，在 Plan Document 底部选择「执行计划」并挑选执行方式，或者点「继续修改」回到 Plan 模式产出下一版。

Agent 在输出方案后不会再用 `ask_user_question` 请求确认，批准或修改都由界面上的操作完成。

## Plan Document

Plan Document 是阅读完整方案的宽版面板，与右侧子代理面板互斥：打开其中一个会关闭另一个。

### 打开方式

- 方案开始生成时自动打开当前对话最新的一版。
- 点击聊天里的「计划」预览卡，打开对应的 revision。
- 点击右侧 Context 面板里的「计划」引用卡，打开最新 revision。引用卡只显示标题、修订号、状态和执行进度，不放大段正文。

再次生成方案时，如果此前手动关掉了面板，会自动重新打开；方案生成完成后保持你手动关闭的选择。

### 面板组成

- 顶部：方案标题、状态徽标（生成中 / 草稿 / 已批准 / 已被取代）、复制 Markdown、修订菜单、关闭按钮。
- 正文：方案 Markdown，支持标题、列表、表格和代码块。
- 底部：执行进度（有执行清单时）和操作栏。执行进度显示已完成项数，以及当前处于进行中的条目。

### 修订菜单

修订菜单按从新到旧列出同一对话里的全部 revision，最新一版带「当前」标记。选择历史版本后正文进入只读查看，并出现「回到最新版本」按钮；历史版本不能执行，也不会被新方案覆盖。

### 面板宽度与阅读位置

拖动面板内缘可以调整宽度，宽度在重启后仍然保留（由窗口的栏宽设置统一管理）。在同一 revision 内滚动时，切走再切回会恢复上次的阅读位置；这个位置只在本次运行内记忆，不写进配置文件。

## Revision 规则

- 每次输出一份完整方案就产生一个新 revision，编号从 1 开始，在同一对话内单调递增。
- 新 revision 指向它的上一版，并把上一版标记为「已被取代」；旧版本正文原样保留，只读。
- 修改已有方案时，Agent 必须重新输出修订后的完整方案，而不是在原正文上打补丁。
- 生成中的内容属于草稿：此时不能执行、不能继续修改。中断回复时，未完成的草稿不会保存，也不会留下半个 revision。
- 每次持久化 revision 时，会把规划开始时你提出的原始目标记录为方案的 objective，供「换新上下文执行」使用。

## 批准与执行

在 Plan Document 底部点「执行计划」，会出现两条固定路径（标签与说明来自 `apps/desktop/src/renderer/plan-draft.ts` 的 `planExecutionChoices`）：

| 路径 | 行为 | 适合 |
| --- | --- | --- |
| 在当前上下文执行（`continue`） | 留在当前对话，沿用规划阶段的探索与推理，把已批准方案作为下一条系统指令发给 Agent | 规划上下文本身就是实现所需上下文 |
| 清空规划上下文执行（`fresh`） | 新开一个标题为「原对话标题 · 执行」的对话，只带原始目标和已批准方案，不继承规划阶段的搜索与推理 | 规划过程很长，想要干净的执行上下文 |

执行时会发生：

1. 最新 revision 的状态从「草稿」变为「已批准」，记录批准时间。
2. 对话切回 `Agent` 模式；如果批准前处于 `Goal` 模式，目标会先暂停。
3. 绑定一份执行清单（ExecutionPlan），并启用 `update_plan` 工具。
4. 系统代发的执行指令（`Implement the approved plan.` 或 `Implement this plan.`）不会出现在消息列表里，也不计入可见的对话活动统计。
5. Agent 开始实现；过程中用 `update_plan` 更新清单，最多一项处于 `in_progress`，可以按实际实现新增、调整或合并条目，但不能用它改写已批准的方案。

采用 `fresh` 时，原对话仍然保留这份已批准 revision 和批准记录，执行发生在新对话里。执行清单按 `sourcePlanId` 绑定 revision：同一 revision 再次以 `continue` 执行时会复用已有进度；批准新的 revision 会绑定一份新的执行清单，旧清单保留在会话数据里但不再激活。

### 执行进度

进度只来自执行清单，与方案正文无关。执行进度出现在三处：

- Plan Document 底部：已完成项数 / 总项数，以及当前进行中的条目。
- 右侧 Context 面板的「计划」引用卡：进度条和计数。
- Agent 回复中的 `update_plan` 工具卡片。

### 继续修改

点「继续修改」会把对话切回 Plan 模式，你可以直接说清要改什么；Agent 会输出一份新的完整方案，形成下一个 revision。重新规划期间旧执行清单仍在会话数据里，但界面进度以当前激活的那份为准。

## 只读限制

### 可用工具

Plan 模式只向模型提供 `read`、`bash` 和 `ask_user_question`，并在工具执行前再做一次检查：`edit`、`write`、`apply_patch` 以及子代理等工具一律拒绝，其余不在白名单内的工具也会被拒绝。

### Shell 白名单

`bash` 命令必须先通过只读检查，规则实现在 `packages/agent/src/plan-command.ts` 的 `isPlanSafeCommand`：

1. 命令按 `&&`、`||`、`;`、换行和 `|` 拆成多段，每一段都必须是安全命令，整条才放行。
2. 任一段命中破坏性模式就整体拒绝，包括：文件与目录改动（`rm`、`mv`、`cp`、`mkdir`、`touch`、`chmod`、`tee`、`dd` 等）、输出重定向（`>`、`>>`）、依赖安装与升级（`npm install`、`pnpm add`、`pip install`、`brew install` 等）、会改动仓库的 Git 命令（`git add`、`commit`、`push`、`checkout`、`reset`、`clone` 等）、提权与进程管理（`sudo`、`kill`、`reboot`、`systemctl` 等），以及交互式编辑器。
3. 余下命令必须命中只读白名单，例如：`cat`、`head`、`tail`、`ls`、`pwd`、`find`、`grep`、`rg`、`fd`、`wc`、`sort`、`diff`、`file`、`stat`、`du`、`df`、`tree`、`which`、`env`、`date`、`ps`、`jq`、`awk`、`sed -n`、`curl`，以及只读的 Git 子命令（`git status`、`git log`、`git diff`、`git show`、`git branch`（仅列出分支，`-d` / `-D` 会被拒绝）、`git remote`、`git rev-parse`、`git ls-*` 等）。

组合示例：`git status && git diff` 放行；`git status; rm -rf build` 因含 `rm` 整条拒绝；`cat file > out` 因重定向拒绝。

这套检查是执行前的字符串策略，不是操作系统级沙箱，也不能理解为对任意命令的安全保证。涉及写操作、网络副作用或超出工作区的动作，不要依赖 Plan 模式的拒绝规则来兜底。

## 持久化与恢复

- 会话元数据（包括全部 revision 和执行清单）保存在 `~/.vela/conversations.json`，写入按防抖合并，应用退出前会同步落盘。
- 消息正文保存在 `~/.vela/sessions` 下的会话文件里。方案正文不再重复出现在 assistant 消息文本中，历史重建时按内容把它对应回对应 revision。
- 应用重启后，历史消息里的「计划」预览卡仍然可以打开 Plan Document；当前激活的执行清单也会恢复，继续显示进度。
- 早期版本只有 `title` / `overview` / `steps` 的旧计划数据会在读取时自动迁移成第 1 版方案；如果当时已有勾选步骤或对话已切到 `Agent` 模式，还会一并生成执行清单。迁移细节见 [plan-mode-architecture.md](./plan-mode-architecture.md#持久化与迁移)。

## 常见问题

**为什么「执行计划」按钮是灰的？**
方案还在生成中，或当前对话正在回复。等生成结束、对话空闲后即可执行。

**历史版本可以执行吗？**
不可以。选中历史版本只能阅读和复制，请先「回到最新版本」。

**执行以后还能改方案吗？**
可以。点「继续修改」回到 Plan 模式，产出新 revision；批准后绑定新的执行清单。已完成的旧清单保留在会话数据里，方便回看。

**中断生成会留下半份方案吗？**
不会。中断时会丢弃未完成的草稿，只有完整输出的方案才会成为 revision。

**执行过程中为什么不能切换模式？**
回复进行中不允许切换模式，界面会提示「回复进行中，不能切换模式」。等这一轮结束再切。

**`fresh` 执行后原对话去哪了？**
仍在侧边栏。原对话保留已批准的 revision 和批准记录，执行发生在新的「· 执行」对话里。

**Plan 模式会用提问来要我做最终确认吗？**
不会。`ask_user_question` 只用于澄清设计和需求；批准或修改方案由 Plan Document 上的操作完成。

## 相关文档

- [Plan 模式实现架构](./plan-mode-architecture.md)
- [Vela README](../README.md)
- [文档索引](./README.md)

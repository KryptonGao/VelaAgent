# Intelligent UI（动态生成式交互界面）需求文档

状态：**P0 已实现，P1/P2 未实现。** 已实现行为见 [../intelligent-ui.md](../intelligent-ui.md)；P1/P2 仍是目标需求，不代表现有产品能力。  
日期：2026-10-10。  
范围：VelaHarness（Vela）桌面端 Agent 对话中的原生、流式、可交互回答。  
产品名称：**Intelligent UI**；内部模块代号：`Vela UI`。  
优先级：P0 → P1 → P2；任何阶段均不得削弱当前 Agent/Plan/Goal、工具审批或消息历史能力。

## 0. 来源与边界

2026-10-07，OpenAI 对 ChatGPT Intelligent UI 的公开描述是：模型根据问题组合文字、图像、图表、表单、按钮和交互式工具；底层使用**原生、可流式输出的组件库**及**边生成边解析的编译器**，不必等回复完整才展示页面。它既可以选择纯文本，也能生成比较视图、可探索的图解或即时计算器。

- 官方产品说明：https://openai.com/index/gpt-6-for-everyone/
- 可参考的公开设计原则：https://developers.openai.com/plugins/concepts/ui-guidelines
- 注意：OpenAI Apps SDK / MCP Apps 的 `iframe` 小部件机制属于**外部应用 UI**，并不等于 ChatGPT 原生 Intelligent UI 的内部实现。可借鉴其权限和状态管理理念，但**不得声称拿到了 ChatGPT 的私有 DSL、编译器、训练配方或组件源码**。
- 本文给出的是 Vela 的**可独立实现的等效产品设计**，不是逐行复刻 OpenAI 私有架构。
- 先前聊天里演示的“Intelligence”仪表盘仅用于说明状态驱动交互；其中任务时间预算、策略强度等均为演示数据，并不是 ChatGPT Intelligent UI 的必备功能，更不能照搬成真实模型指标。

## 1. 产品目标与非目标

### 1.1 产品目标

用户只需自然语言提问，Vela Agent 在同一条回答中按内容选择纯文本、结构化布局或交互式应用；**UI 是答案本身**，而不是额外打开一个网页、固定功能面板，或生成一张不可操作的截图。

核心体验：

1. **按需出现**：任务适合纯文本时保持纯文本；适合比较、计算、教学探索或选择时才生成 UI。
2. **渐进显示**：先生成的合法节点先出现，后续节点渐进接入，用户无需等待整个 JSON/回复输出完毕。
3. **本地即时交互**：滑块、筛选、页签、复选框、计算器在 Renderer 内立即反馈，不为每次改变重新请求模型。
4. **模型协作**：用户按下明确的“让 Agent 继续”等操作时，将结构化选择提交到原对话；保持原本工具权限和运行状态语义。
5. **可信、可恢复**：动态内容仍是会话消息的一部分，可复制、恢复、回退、分支和导出；出错时保持文本答案可读。

### 1.2 首批示例

| 场景 | 期望界面 | 无须重新调用模型的交互 |
| --- | --- | --- |
| “比较三种模型的费用与速度” | 对比表、可排序列、费用说明 | 排序、筛选、展开细节 |
| “给我一个旅行预算计算器” | 数字输入、滑块、计算结果 | 更新人数/预算后实时计算 |
| “解释全等三角形的判定” | 条件卡、步骤图、可展开证明 | 切换 SSS/SAS/ASA/AAS |
| “评估这次改动的风险” | 风险摘要、分组卡、证据引用 | 按严重程度筛选 |
| “只需要一句命令” | 普通代码块与简短文本 | **不生成 UI** |

### 1.3 非目标

- P0 **不执行模型生成的 JavaScript、HTML、React、JSX、Shell、SQL 或远程脚本**，也不将 Markdown 当成可信 HTML。
- 不引入第二个 Agent Runtime、独立对话数据库或额外的模型执行循环。
- 不重做 Chat 页面布局、不移除 Trace / SubAgents / 右侧工作面板。
- UI 交互本身不自动修改文件、执行命令、发送网络请求或提升权限。
- 不把演示数据、模型猜测值或无来源的来源标签伪装成实时且已验证的数据。
- 不强制所有回答包含视觉元素。

## 2. Vela 现有实现基线

根据当前仓库源码和开发文档，已有：

| 已有能力 | 当前代码位置 | 复用原则 |
| --- | --- | --- |
| Pi 会话、流事件、工具执行 | `packages/agent/src/runtime.ts` | UI 作为**新的答案表示层**，继续使用现有会话与模型调用 |
| 模型消息历史投影 | `packages/agent/src/transcript.ts` | UI 关联原 assistant 消息，历史恢复从持久化内容重建 |
| 共享事件、类型和 IPC | `packages/shared/src/index.ts` | 仅添加必要的 UI 协议类型 |
| 主进程桥接 | `apps/desktop/src/main/session-host.ts` | 仅主进程可参与 Agent 执行和权限校验 |
| Renderer 安全桥接 | `apps/desktop/src/preload/index.ts` | 暴露最小化、类型化的 UI 持久化/动作 IPC |
| 流式消息及切换会话 | `apps/desktop/src/renderer/hooks/useSession.ts` | 不打断目前的消息事件、Agent 子会话及 Plan 草稿 |
| Chat 内容展示 | `apps/desktop/src/renderer/components/SessionChatView.tsx` | 原消息内嵌 UI，不另起全屏或固定侧栏 |
| 桌面应用装配 | `apps/desktop/src/renderer/App.tsx` | 仅集成必要的 Provider/Renderer |
| Plan 格式与分支恢复 | `packages/agent/src/plan.ts`、`docs/plan-mode-architecture.md` | 新 UI 格式不得破坏 `<proposed_plan>` 解析 |
| 工具权限 | `apps/desktop/src/main/session-host.ts` 与现有 ToolPolicy | UI 不能绕过 Plan、沙箱、MCP 或执行审批 |

现有应用基于 Electron 44、React 19、TypeScript、Pi 1.0、pnpm workspace，包含简中、繁中、英文、日文、韩文与明暗主题。**新功能必须沿用它们**；组件与样式按项目现有约定组织。

## 3. 功能范围与分期

| 优先级 | 需求 ID | 内容 | 实施状态 |
| --- | --- | --- | --- |
| P0 | `IUI-01`—`IUI-05` | 自适应输出策略、声明式组件 DSL、增量解析、消息内渲染、本地状态 | 已实现 |
| P0 | `IUI-06`—`IUI-09` | 有限安全动作、会话恢复与回退、可访问性/降级、解析与安全测试 | 已实现 |
| P1 | `IUI-10`—`IUI-13` | 图表/可交互 SVG、可信异步数据绑定、导出/复用、UI 可观测性 | 未实现 |
| P2 | `IUI-14`—`IUI-16` | 隔离运行的微型应用、更丰富的空间/媒体 UI、跨工具协作 | 未实现 |

P0 完成前不应为了“像 ChatGPT”先上自由代码执行。P1/P2 不应作为 P0 的隐式依赖。

## 4. P0：UI 生成与选择

### IUI-01 自适应 UI 决策

Agent 根据任务输出类型而非关键词硬触发。

- 默认策略 `auto`：简单问答优先文本；多实体比较优先表格/卡片；参数探索优先控件+派生结果；空间关系/过程解释可使用可视结构。
- 提供用户级偏好 `auto` / `text_only` / `visual_first`。`visual_first` 也不得强制所有回答出图。
- 当前模型无法稳定输出合法 UI 时，自动**降级为普通 Markdown**，避免 UI 生成拖垮正文。
- 刻意限制首屏复杂度：一个回答可混排文字和若干 UI 块；不要用一个巨型“应用卡”替换整段回答。
- Agent 输出的 UI 文案要解释其用途、交互影响及关键假设；不使用虚构的“可信度 xx%”仪表盘。

### IUI-02 原生组件注册表

Vela 自有**版本化白名单组件注册表**。P0 至少包含：

| 类别 | 类型 | 要求 |
| --- | --- | --- |
| 文本 | `text`、`heading`、`caption`、`code` | 安全文本、Markdown 子集；禁止原样 HTML |
| 结构 | `column`、`row`、`grid`、`divider`、`card` | 自适应宽度，嵌套深度受限 |
| 数据 | `table`、`stat`、`progress`、`list` | 标注单位、格式、空值、来源和状态 |
| 选择 | `tabs`、`segmented`、`select`、`radio` | 数据集和稳定选项值 |
| 输入 | `input`、`number_input`、`slider`、`checkbox` | 类型、取值范围、精度、必填、禁用态 |
| 操作 | `button`、`collapsible` | 仅允许注册动作，不允许任意回调代码 |
| 反馈 | `loading`、`empty`、`error` | 明确加载/失败/内容不完整 |

P0 不需要复制 ChatGPT 组件名、CSS 或 DIL 语法；组件必须绑定 Vela 的主题 Token、字体、间距及现有键盘交互规范。

### IUI-03 版本化、安全的 UI Spec

定义 `VelaUiSpecV1`：数据描述界面，Renderer 负责实现；**模型不能注入自定义 React 组件或事件处理器**。

建议核心模型：

- `UiArtifact`：`schemaVersion`、`artifactId`、`conversationId`、`messageId`、`status`、`rootNodeId`、`nodes`、`stateDefinitions`、`createdAt`、`updatedAt`。
- `UiNode`：`id`、`type`、`parentId`、`props`、`childrenIds`；节点 ID 对同一块稳定。
- `UiValue`：string / finite number / boolean / null / string[]；明确单位和显示格式。
- `UiAction`：仅 `set_state`、`toggle`、`copy`、`submit_to_agent`、`open_external`（后两者必须由用户直接触发）。
- `UiExpression`：声明式纯计算 AST，例如 `add`、`subtract`、`multiply`、`divide`、`round`、`min`、`max`、`compare`、`if`、`format`；禁止 `eval`、`Function`、变量自由求值或用户代码注入。
- `UiBinding`：明确源状态、派生值和显示节点的引用关系；单向数据流，不允许循环依赖。
- 解析与渲染前对所有字段做运行时校验；未知版本/未知组件/无效参数直接拒绝或局部显示占位，不做危险的“尽力执行”。

#### 推荐数据流示例（纯数据，不是脚本）

用户问“5 个人平摊 240 元，每人多少钱？”时，Agent 可以产生一个名为 `bill-split` 的 UI：`number_input` 绑定 `amount = 240`、`number_input` 绑定 `people = 5`，`stat` 显示表达式 `round(divide(amount, people), 2)`，默认结果 `48.00 元`。用户修改人数后，由本地表达式求值器重算，不需要模型调用。人数下限为 1，分母为 0 时显示可读的输入错误而不是 `Infinity`。

### IUI-04 流式 UI 协议与编译器

首版建议模型在普通答案中输出**明确边界的 `vela-ui` 事件块**；消息正文仍可自然包含 Markdown。示例协议（示意，字段需以最终 schema 校验器为准）：

```vela-ui
{"op":"begin","id":"split-1","version":1}
{"op":"state","name":"amount","kind":"number","initial":240,"min":0}
{"op":"state","name":"people","kind":"number","initial":5,"min":1}
{"op":"node","id":"root","type":"column","props":{}}
{"op":"node","id":"amountInput","parent":"root","type":"number_input","props":{"label":"总额","bind":"amount"}}
{"op":"node","id":"peopleInput","parent":"root","type":"number_input","props":{"label":"人数","bind":"people"}}
{"op":"node","id":"total","parent":"root","type":"stat","props":{"label":"每人金额","unit":"元","derive":{"op":"round","args":[{"op":"divide","args":[{"ref":"amount"},{"ref":"people"}]},2]}}}
{"op":"commit"}
```

协议要求：

1. 独立增量解析器可跨任意 token/delta 边界解析开闭围栏、UTF-8、转义和 NDJSON 行；**仅接受完整 JSON 行**，不把半行传给组件。
2. `begin` 后即可显示骨架；合法 `node` 到达后增量挂载。`commit` 才标记为完整，并执行跨节点引用校验。
3. 模型在 `commit` 前中止、断流或格式错误：保留此前已验证的只读节点并标“生成未完成”，或退回 Markdown 文本；不能把危险片段强行解释为 UI。
4. 同条消息可以有多段正文、多块 UI；UI 块有稳定 ID，节点增量更新不能重置已填写的本地表单状态。
5. 单块设上限：建议原始协议 256 KiB、节点 200、深度 12、状态 50、选项总数 500、图表点数留待 P1 另定；超限停止解析并展示降级信息。
6. UI 输出语法不是模型能力的保证。实现可在运行时注入简短、版本化的系统能力说明与 few-shot 样例，并对低兼容模型关闭自动 UI。
7. 禁止把 UI 围栏误判为代码执行工具，也不得干扰 Plan 解析；建议在可见正文解析的**独立阶段**完成 UI AST 生成，复用已有事件链而不是改造 Pi 本身。
8. 后续可引入结构化的 `render_ui` 工具调用入口；它应**复用同一 schema/Renderer**，不得另起第二套 UI DSL。

### IUI-05 消息内原生渲染

- UI 直接嵌入 assistant 消息正文，和 Markdown 按产生顺序混排；默认最大宽度继承当前聊天内容容器。
- 使用 React 组件注册表渲染 AST；独立 `UiArtifactBoundary` 捕获渲染错误，单块出错不影响整页聊天。
- 组件先展示合法部分，后续增量更新避免容器上下大跳；增量渲染期间不夺取键盘焦点。
- 小宽度折行、横向表格滚动，不能把 Chat 与右侧面板挤出窗口；支持既有明暗主题和五种界面语言。
- 对话折叠、滚动离屏和切换后不要求每次重做完整模型请求。
- 始终可“查看原始文本/复制内容”；解析失败时正文可访问。

## 5. P0：状态、动作与会话生命周期

### IUI-06 本地状态与模型交互分层

区分三类状态：

| 类别 | 所属方 | 示例 | 保存规则 |
| --- | --- | --- | --- |
| 原始答案/UI 定义 | 会话消息/Agent | 节点、标签、初始值、内容依据 | 随消息持久化，可从历史重建 |
| 本地 UI 状态 | Renderer + 持久化快照 | 当前页签、滑块值、已勾选项 | 以对话/消息/组件唯一键保存；恢复后校验 |
| 权威业务/工具数据 | Main 进程/现有 Agent 工具 | 文件改动、命令执行、Git 结果 | 只以实际工具/工作区读取为准，模型 UI 不能覆写 |

- `state` 初始值只用于首次挂载；历史恢复优先加载已保存快照（并作 schema migration），不能因消息重渲染而归零。
- 一个 UI 块的本地状态不直接影响另一个块，除非未来显式声明受控共享状态。
- 用户本地改滑块时仅重算依赖节点；点击“提交给 Agent”才生成新的用户消息或现有会话的追加指令。
- Agent 不会自动得知用户每次拖动的中间值；需要时由按钮一次性提交当前参数快照。

### IUI-07 受控动作与权限

| 动作 | 处理 | 约束 |
| --- | --- | --- |
| `set_state` / `toggle` | Renderer 本地 | 通过类型和范围校验，不能触发副作用 |
| `copy` | 主动复制 | 明示复制内容，失败要反馈 |
| `open_external` | 复用现有外链安全策略 | URL 需为允许的协议；阻止 `javascript:` / `file:` 等 |
| `submit_to_agent` | 用户点击 → 现有消息提交接口 | 预览或清楚表述即将发送的文字/参数；保留 Agent/Plan/Goal 与排队/Steering 规则 |
| 未来 `request_tool` | **P0 禁止** | P1/P2 若开放，必须经过 Main 的工具注册、权限策略和用户审批 |

严格要求：模型给出的 JSON 只能**描述**动作，不能把 JSON 到达视为用户授权；任何涉及网络、磁盘、凭证、命令或 Git 的行为均使用现有受控工具链。Plan 的只读限制及需要确认的动作优先于 UI 的展示方式。

### IUI-08 历史、分支、回退与导出

- 以 `conversationId + messageId + artifactId` 作为稳定引用，避免多个会话/消息 ID 冲突。
- UI Spec 可以从 assistant 原始内容重建；不能依赖组件挂载后才存在的随机 ID。
- 本地 UI 状态写入 Vela 自有的轻量存储（具体存储位置由现有会话存储策略决定），使用节流保存并进行版本与大小控制；不存 token/密钥。
- 切换会话、重启、历史滚动回来，UI 恢复最后一份合法状态；异常版本自动降级，不让聊天打不开。
- 会话 branch 保留分支点之前的 UI Spec；本地 UI 状态按分支**复制快照但不共享可变引用**。
- rewind、编辑并重发或删除消息：同步移除不再可达的 UI 快照；不影响原有工作区 checkpoint 规则。
- Markdown/HTML 导出保留文字等价摘要、表格数据及交互组件的当前参数/结果；HTML 导出默认静态化，不携带可执行脚本。
- 不应因为界面交互再向历史写入虚假的 assistant 或 tool 消息。

### IUI-09 可访问性与失败降级

- 所有输入具可读 label、描述、校验提示；Tab/方向键/Enter/Space 可操作；焦点可见，支持屏幕阅读器。
- 颜色不是唯一信息表达方式；深色、浅色及高对比环境下可读。
- 尊重 reduced-motion；渐进渲染不要无限闪烁或自动滚动夺焦点。
- UI 输出受限、解析失败、缓存不兼容、组件崩溃、网络图片不可达时，**不丢失相应文本信息**。
- 带来源/引用的数据必须保留可访问引用或标记“未验证”；不得用模型生成的链接伪造已检索证据。
- 所有表单既要显示本地计算的结果，也要说明假设、单位、非法输入处理方式。

## 6. P1：提升到 ChatGPT 式多模态表现

### IUI-10 图表与可探索图解

- 增加 `bar_chart`、`line_chart`、`pie_chart`，可用已验证数据数组做 tooltip、筛选和局部高亮，空值与异常值有明确处理。
- 增加受限的 `svg_diagram` / `hotspot` 模型：只允许安全的 SVG 基础图元、坐标、文字标签和可点击区域，不允许 `foreignObject`、事件属性、脚本、外链资源。
- 实现复杂知识图示的选区讲解（如自行车部件、几何图形）；交互只切换已提供的内容，不伪造图中物理事实。
- 图表要支持表格型无障碍备选呈现及数据复制/导出。
- 图片与地图等外部媒体是**独立 Provider**；未设置来源服务时显示说明而非虚构内容。

### IUI-11 可信数据与异步状态

- 将模型编排和数据工具解耦：实际结果来自 Vela 的现有工具/Provider，UI 只展示带 `sourceId`、`fetchedAt`、`status` 的快照。
- 查询中的 `loading` / `stale` / `error` / `empty` 不得被渲染成“已更新”。
- 用户刷新需明确触发现有工具通道；不允许组件任意 `fetch` 外部地址。
- 同一 UI 可在只读结果到达时显示数据，写操作依旧遵循权限审批。

### IUI-12 图文导出与可复用卡片

- 支持将可交互结果复制为文本表格或导出静态图片；保留标题、单位和来源。
- 提供“使用当前设置继续提问”动作；参数快照进入实际聊天并可追溯。
- 以后可保存用户主动选定的 UI 模板，但不把每次模型生成的 UI 自动提升为可信插件。

### IUI-13 追踪与调试

- 本地可观察指标：UI 生成比例、首个合法节点可见耗时、commit 成功率、降级原因、组件渲染错误、节点/状态数。
- 仅写入现有诊断/Trace 管线允许的数据；默认不上传用户交互原始值，不记录密钥。
- 开发模式可以查看已验证的 AST、事件时间线、状态快照和拒绝原因，不显示模型私有思考内容。

## 7. P2：受隔离的自由应用能力

### IUI-14 自定义微型应用

部分任务（游戏、复杂模拟、画布工具）用声明式组件不够。P2 可提供**单独、默认关闭且明确标识的沙盒应用容器**：

- 模型生成代码必须在隔离 iframe/独立 origin 的沙盒运行，禁用 Node、Electron、Main 进程能力。
- 严格 CSP，默认禁止联网、文件系统、任意外部脚本和非授权资源；沙盒只经校验过的 `postMessage` 消息桥申请有限能力。
- 权限由 Main 发放一次性、有范围、可撤销的 capability；所有副作用仍走原有 ToolPolicy / 用户审批。
- 限制资源占用、渲染时长、大小与错误次数；关闭沙盒后不允许残留后台任务。
- 自由代码容器与 P0 原生 DSL 必须相互隔离，绝不能通过“兼容性”开关偷偷允许 P0 执行任意 JS。

### IUI-15 丰富视图

按真实数据源再扩展时间轴、可拖动图表、地图/行程视图、文件差异可视化和较复杂的学习交互；不得把仅有名称的地点当作真实坐标。

### IUI-16 Agent 工作流协作

UI 可以提出填参、审批、继续任务和工具建议，但真正实施须走原 Agent Runtime，保持与 Plan、SubAgents、Goal、Trace、MCP、Task Recipes 的现有权限和记录边界。不可由 UI 伪造工具运行记录。

## 8. 建议实现分层

```text
Pi Model / AgentSession
  └─ assistant text_delta + existing tool/status events
       └─ UI-aware stream demultiplexer (text / vela-ui NDJSON)
            ├─ Markdown text -> existing chat renderer
            └─ schema validation -> incremental UiArtifact AST
                   └─ UiArtifactRenderer (React registry)
                        ├─ useUiArtifactState (local)
                        ├─ deterministic expression evaluator
                        └─ UiActionDispatcher
                             ├─ local actions
                             └─ explicit user actions -> preload -> Main -> existing Agent Runtime
```

**建议代码边界（待实施路径，可按当前项目组织调整）：**

| 层 | 建议落点 | 责任 |
| --- | --- | --- |
| 共享协议 | `packages/shared/src/intelligent-ui.ts` | 版本、事件、节点、动作、上限与可序列化类型 |
| 纯解析器 | `packages/agent/src/intelligent-ui-parser.ts` 或独立纯 TS 模块 | 围栏识别、NDJSON 拆分、增量状态机；不引用 React/Electron |
| 运行时说明 | `packages/agent/src/interaction.ts` | 仅在允许的模型/模式下说明能力与安全格式 |
| 消息投影 | `packages/agent/src/transcript.ts` | UI 源文本随原消息恢复；兼容现有 Plan 块 |
| 主进程处理 | `apps/desktop/src/main/session-host.ts` | 严格校验授权动作、必要的状态 IPC |
| preload | `apps/desktop/src/preload/index.ts` | 最小暴露 typed API，绝不暴露 fs/Node |
| Renderer state | `apps/desktop/src/renderer/hooks/useSession.ts` | UI Artifact 与已有流式消息同步 |
| Render/registry | `apps/desktop/src/renderer/components/intelligent-ui/` | 组件库、ErrorBoundary、动作分发 |
| Chat 接入 | `apps/desktop/src/renderer/components/SessionChatView.tsx` | 原位渲染混合答案 |
| 测试 | `packages/agent/test/`、`apps/desktop/test/` | 协议、状态、UI、安全与恢复 |

**关键工程要求：** Parser、Validator、AST、表达式求值器必须可单测且独立于平台。Renderer 不能在 `useEffect` 等挂载生命周期里偷偷启动网络请求或 Agent 任务。新功能不接管已有终端、Git、Browser 或系统 IPC。

## 9. 状态机与异常约束

UI Artifact 状态建议：

- `receiving`：已见 `begin`，可显示骨架和已完成节点。
- `ready`：完成 `commit`，全量 schema/引用校验通过。
- `incomplete`：模型终止前没有 `commit`，保留安全的部分只读结果及“未完成”提示。
- `invalid`：非法结构/超限/不受支持的版本；隐藏危险节点并显示等价文本或错误提示。
- `disposed`：消息删除、分支截断或组件完全卸载；终止相关任务并释放状态订阅。

边界：乱序增量、重复 node ID、深度超限、循环绑定、计算溢出、除零、非有限数、未知 action、会话中止、Model 重试、线程切换、多个同时存在的 Agent 消息、旧历史不含 UI、原始代码块恰巧提及 `vela-ui`。尤其最后一项要正确区别**模型用于展示的代码示例**与真正的 UI 协议段，必要时通过明确边界标记或独立结构化消息通道解决，不能用全局正则碰运气。

## 10. 安全模型与安全验收

1. 所有模型内容和外部工具结果默认**不可信**；显示经过净化，绝不将 JSON 字段变为 DOM 属性事件、脚本或任意 CSS。
2. 不接受 HTML 注入、JS URL、SVG script、data URL 代码、外链字体/脚本、原型污染键（如 `__proto__` / `constructor`）及递归炸弹。
3. 不允许声明式公式读取环境、时间、文件、浏览器上下文、剪贴板、跨组件状态或外部网络。
4. 控件动作有主进程准入边界；UI 不能越权调用 `bash`、`write`、`edit`、`browser_repl`、MCP、Git 变更，也不能在 Plan 模式执行写操作。
5. 来自消息或网络的外链必须经过现有安全策略；不要因为“模型生成了漂亮按钮”降低提醒标准。
6. 旧会话、修改重发、回退和分支操作时不遗留可复用的旧权限授权。
7. 对极端长文本、多层嵌套、恶意 NDJSON、海量状态更新实施大小、深度及频率限制，保证聊天可用。
8. P2 代码沙盒须独立安全审查；P0/P1 禁止先行引入。

## 11. 可验证的验收标准

### 11.1 P0 功能验收

- [x] 简单问题仍以纯文本回答；默认不会无意义地生成大卡片。
- [x] 同一消息可以按顺序显示 `Markdown → UI → Markdown`，且历史恢复相同。
- [x] 人为将协议按任意字节/字符边界切开，解析结果仍一致（包含中文和 JSON 转义）。
- [x] 用户可在 `commit` 前看到已验证节点；完整输出后不重置已输入数值或焦点。
- [x] 账单平摊计算器：240 元/5 人 = 48 元；修改人数立即重算，除零和非有限数得到错误提示而非崩溃。
- [x] 交互式比较表支持排序、筛选、展开；布局在窄聊天列和明暗主题下可用。
- [x] 用户点击“继续交给 Agent”才产生新输入；普通筛选、点击页签绝不启动工具。
- [x] Plan 模式的 UI 无法越权执行写工具；与 `<proposed_plan>` 混排时现有 Plan 解析和批准流程不变。
- [x] 重启、切换聊天、branch、rewind、编辑重发、删除会话后 UI 定义/状态遵守 `IUI-08`。
- [x] 未支持的组件、损坏数据、非法动作、超大输入、XSS 样本都能隔离失败，不使 Vela 的聊天整页失效。
- [x] 仅使用键盘可完成表单填写/页签切换/提交；屏幕阅读器获得名称、状态、错误提示。
- [x] 关闭 UI 偏好后普通对话、Agent/Plan/Goal、SubAgents、Trace、右面板均无回归。

### 11.2 自动化测试与验证命令

- Parser/property tests：任意拆包、围栏转义、重入/重复事件、最大长度、结束/中止/恢复。
- Schema/AST tests：所有白名单节点、未知字段、循环依赖、类型不匹配、恶意对象键。
- Expression tests：边界数值、浮点舍入、0 分母、格式化和依赖图拓扑排序。
- Renderer UI tests：点击、键盘、明暗主题、跨消息作用域、错误边界、增量更新。
- Persistence tests：关闭/重开、branch 复制、rewind 截断、导出静态化。
- Security tests：XSS、任意执行、外链协议、权限绕过、资源耗尽。
- 回归：`pnpm typecheck`、`pnpm test`、`pnpm test:ui`、`pnpm build`；如涉及 Electron IPC/窗口生命周期，补充 `pnpm test:smoke`。

## 12. 实施顺序与完成定义

1. **基础协议**：`VelaUiSpecV1`、运行时校验器、纯表达式计算、测试；不修改现有对话 UI。
2. **流式解析**：单独 Parser + 增量 UiArtifact，和原 `text_delta` 合作；加损坏输入降级。
3. **原生 Renderer**：先实现结构 + number_input/slider/checkbox/stat/table/tabs + ErrorBoundary。
4. **安全交互**：本地动作、复制、明确的 Agent 提交；与现有权限政策端到端对齐。
5. **持久化/生命周期**：重启、历史、分支、编辑重发、回退、导出和状态迁移。
6. **产品打磨**：自适应选择、三档偏好、国际化、无障碍、暗亮主题、流式视觉稳定性。
7. **P1/P2 独立扩展**：图表、可信工具数据、可选沙盒微应用。

**P0 Done**：至少提供纯文本、参数计算器和多项比较三个可重复的端到端示例；上述 P0 验收全部通过，拒绝未知/恶意 UI 时仍能正常使用聊天；实现、测试、运行时行为和需求文档一致。**“生成了漂亮卡片”不等于完成 Intelligent UI。**

## 13. 开发边界和代码审查提示

- 不要在还没有可靠解析器与安全边界前做任意代码渲染。
- 不要为了 UI 重新设计已有 Pi Session / AgentRuntime / Trace / IPC。
- 不要将用户操作视作模型直接获得任意系统权限的许可。
- 不要以“模型自然语言说已完成”作为动作成功证据。
- 任何后续实现 PR 应更新本文件的状态标记，并增加对应测试与已实现行为文档。

## 14. P0 实施记录与与本文的差异

P0 已按 [../intelligent-ui.md](../intelligent-ui.md) 实现。与第 8 章建议相比有以下差异：

- 协议模块（解析器、表达式、组件规范化、状态与快照格式）放在 `packages/shared`，不是 `packages/agent/src/intelligent-ui-parser.ts`：Main 导出与 Renderer 渲染需要共用同一份实现。
- 在 `state` 之外增加了 `derive` 操作和节点级 `show` 表达式，用于派生值与页签面板的条件显示。
- UI 块的稳定位置是「第 n 条可能含界面的助手回复」（`u{n}`）加内容指纹，而不是聊天消息 id：实时与历史恢复的消息 id 不同。
- 本地状态存在渲染层现有的 `uiStorage`，不新增主进程存储，也没有新增 Main 侧动作 IPC；`submit_to_agent` 复用现有发送消息路径。
- 子代理面板中的回复仍是普通 Markdown，不渲染界面。
- 没有按模型能力自动关闭 UI 偏好；`IUI-13`（可观测指标）与全部 P1/P2 未实现。

# Intelligent UI

Agent 回答里可以嵌入原生交互界面：计算器、对比表、分步演示。界面是声明式数据，由 Vela 自己的组件渲染；模型输出的任何 HTML、脚本、JSX 都不会被执行。

需求与分期见 [requirements/intelligent-ui.md](./requirements/intelligent-ui.md)。本文只描述已经实现的 P0。

## 使用

- **设置**：设置 → 对话显示 →「交互式界面」，三个选项：
  - **自动**（默认）：只在界面明显比文字好用时生成。
  - **仅文字**：不再告诉模型可以生成界面。
  - **偏向可视化**：比较、计算、参数探索类问题优先用界面；简单问答、命令和代码仍然用文字。
- 偏好保存在当前 Profile 的 `intelligent-ui-settings.json`，只存模式，不存任何交互数据。
- 只有 **Agent 模式**会收到界面语法说明；Plan 与 Goal 不注入，保持纯 Markdown，`<proposed_plan>` 等现有流程不受影响。
- 界面里的筛选、排序、页签、滑块、勾选都只在本地即时生效，不会打扰 Agent。只有点击带 `submit_to_agent` 动作的按钮，并在界面内确认文字后，才会把当前参数作为一条新消息发给 Agent。
- 每个界面都有「查看原始文本」，可看到围栏里的 NDJSON；界面出错或未完成时会降级显示，正文仍可读。

## 协议

在回答里用 `vela-ui` 围栏，每行一个 JSON 对象（NDJSON）：

| op | 作用 |
| --- | --- |
| `begin` | 必须是第一行：`id`、`version`（当前为 1）、可选 `title`。第一行不是合法 `begin` 的围栏按普通代码块显示。 |
| `state` | 声明本地状态：`number`（`min`/`max`/`step`）、`string`（`maxLength`/`options`）、`boolean`。 |
| `derive` | 派生值，表达式可引用状态或其他派生值；`commit` 时拓扑排序，循环依赖被拒绝。 |
| `node` | 组件节点：`id`、`parent`、`type`、`props`。第一个节点是根，之后父节点必须已出现。 |
| `commit` | 最后一行。缺少 `commit` 的界面标为「未完成」。 |

组件白名单（`uiComponentTypes`）：`text` `heading` `caption` `code`；`column` `row` `grid` `divider` `card`；`table` `stat` `progress` `list`；`tabs` `segmented` `select` `radio`；`input` `number_input` `slider` `checkbox`；`button` `collapsible`；`loading` `empty` `error`。所有节点可带 `show` 表达式控制显示。属性经严格规范化，未知字段被丢弃；未知组件或非法属性只让该节点变成占位，结构性违规（超限、父节点不存在等）让整块无效。

表达式是纯数据 AST：`add` `subtract` `multiply` `divide` `round` `floor` `ceil` `abs` `min` `max` `compare` `if`（惰性）`and` `or` `not` `format` `concat`，以及 `{"ref":名字}`。求值错误（除零、非有限数、类型不符）作为值返回并在界面显示，不会抛异常。表达式不能读取时间、文件、网络或剪贴板。

动作（`parseAction`）：`set_state`、`toggle`、`copy`、`open_external`、`submit_to_agent`。后两者需要在界面内确认并显示将要发送的文字或打开的地址；外链只允许 `http`、`https`、`mailto`。P0 没有 `request_tool`，界面不能调用工具、改文件或执行命令。

限制（`uiLimits`）：原始协议 256 KiB、单行 48 KiB、节点 200、深度 12、状态 50、派生值 50、选项总数 500、表格 200 行 × 12 列、列表 100 项、单节点子节点 100。超限的块标为无效并降级。

## 流式解析

`UiStreamParser` 按行增量解析，任意拆包结果一致（包含中文和 JSON 转义）。尾部不完整的围栏行会被暂扣，避免 ```` ```vela-u ```` 先以代码块闪现。嵌套围栏、只是提到 `vela-ui` 的代码示例都不会被当作界面。同一条消息可以是 `Markdown → UI → Markdown` 的任意组合。

产物状态：`receiving` → `ready`；流意外结束为 `incomplete`；校验失败为 `invalid`；消息被删除或回退后为 `disposed`。`commit` 之前已验证的节点就会显示。

## 本地状态与生命周期

- 只保存**用户改动过的值**，叠加在界面定义的初始值之上，所以流式过程中 `commit` 到来不会重置已输入的内容。
- 快照写入渲染层的 `uiStorage`（与其他界面偏好同一存储），带节流，单个快照上限 16 KiB，每个会话最多 400 个。
- 键为 `vela.ui.state.<会话>.<u{n}>.<artifactId>`。`u{n}` 是「会话里第 n 条可能含界面的助手回复」：聊天里的消息 id 在实时和历史恢复时不同，这个序号两者一致。快照里带内容指纹（FNV-1a），同一位置的界面被改写（编辑重发）后，旧快照因指纹不符被丢弃。
- 重启、切换会话、历史恢复：读回最后一份合法快照；格式损坏或版本不符时退回初始值，不影响聊天打开。
- Branch：复制快照，两个会话互不共享。Rewind/编辑重发：清除已不存在位置的快照。删除会话：清除其全部快照。
- 一个界面的状态不影响另一个界面。

## 导出

对话导出（Markdown/HTML，见 [conversation-export.md](./conversation-export.md)）把每个 `vela-ui` 块写成纯文字等价物：标题、控件的当前值、统计、表格、列表，不含原始 JSON、脚本或可点击动作。读取的是用户最后保存的输入（指纹匹配时），否则用初始值；界面无法导出时写占位说明而不是泄露源码。

## 可访问性与安全

- 全部控件是原生元素，具备名称、状态和错误提示，仅用键盘即可填写、切换页签、排序、提交。
- 文本一律按文本渲染，没有 `dangerouslySetInnerHTML`；Markdown 内联仅支持有限的 `**粗体**`、`*斜体*`、`` `代码` ``；链接只在 `safeExternalUrl` 通过时可点。
- 每个界面外有错误边界，渲染异常只让该块显示降级信息。
- 状态名拒绝原型污染键（如 `__proto__`）。

## 实现位置

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/intelligent-ui*.ts` | 协议类型与限制、表达式、组件规范化、流式解析器、状态与快照格式。纯 TypeScript，不依赖 React/Electron，Main 与 Renderer 共用。 |
| `packages/agent/src/intelligent-ui-prompt.ts` 的 `intelligentUiInstructions` | 按偏好和模式生成系统提示附加说明。 |
| `packages/agent/src/intelligent-ui-settings.ts` 的 `IntelligentUiSettings` | 偏好持久化；损坏或未知值回到「自动」。 |
| `packages/agent/src/runtime.ts` | 隐藏的 Pi 扩展在 `before_agent_start` 注入说明；`session-host.ts` 与 preload 暴露偏好读写。 |
| `apps/desktop/src/renderer/components/intelligent-ui/` | `AssistantMarkdown`（替换助手正文的 Markdown）、`UiRuntime`（状态与动作）、`components`（各组件）、`ui-state-store`（快照存储）、`IntelligentUiSetting`（设置项）。 |
| `apps/desktop/src/main/intelligent-ui-export.ts` | 导出时把界面块转成文字。 |

## 验证

```bash
pnpm --filter @vela/desktop test:intelligent-ui   # 解析、表达式、状态、提示、渲染模型、导出
pnpm --filter @vela/desktop test:ui               # 含 intelligent-ui-ui：真实 Electron 的流式、计算器、持久化、表格、XSS、窄屏
```

## 已知限制与未实现

- P1/P2 未实现：图表与可交互 SVG、可信异步数据绑定、导出为图片/可复用卡片、UI 可观测性指标（`IUI-13`）、沙盒微应用、跨工具协作。
- 子代理面板里的回复仍按普通 Markdown 显示，不渲染界面。
- 没有按模型能力自动关闭：能否写出合法界面取决于模型，写不出时降级为原始文字。
- 导出是静态文字，没有交互；按位置序号匹配状态，因此回退并重新生成后不会误用旧输入（指纹不符即丢弃）。

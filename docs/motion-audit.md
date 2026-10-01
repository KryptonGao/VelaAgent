# 界面动效盘点与改进清单

本文对桌面端渲染层（`apps/desktop/src/renderer`）现有动效做一次完整盘点，并给出待补的动效清单与统一规范。基于当前开发分支源码整理。

> 阅读约定：第 2 节的「现状」描述的是已经实现的行为；第 3 节起全部是**待实现建议**，不代表当前已具备。所有引用不写行号，只写 `` `路径` 的 `符号名` `` 或 CSS 类名。

---

## 1. 现有动效基建

补动画时优先复用以下已有能力，不要另起一套。

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 动效 token | `styles.css` 的 `--transition-smooth`、`--transition-enter`、`--transition-sidebar` | 分别为 0.24s / 0.18s / 0.28s，前两者共用 `cubic-bezier(0.16, 1, 0.3, 1)` |
| 整屏进出场 | `components/Presence.tsx` 的 `Presence` | 退出时保持挂载、透明度过完再卸载；进入屏留在文档流，离开屏绝对定位盖在上面淡出 |
| 对话框进出场 | `components/Presence.tsx` 的 `SheetPresence` | 进场靠 CSS 动画，退场在动画结束前保持挂载；需要子节点带 `.sheet-backdrop` |
| 消息进场 | `styles.css` 的 `message-enter` / `message-in` | opacity 0 + `translateY(6px)`，由 `components/message-motion.ts` 的 `trackEnteredMessages` 决定哪些消息播放 |
| 高度展开动画 | `styles.css` 的 `approval-slot` | `grid-template-rows: 0fr ↔ 1fr` + `margin-bottom`，是项目里通用的高度过渡模式 |
| 浮层进场 | `styles.css` 的 `.dock-popover`、`.skill-menu` | `@starting-style` 提供 opacity + `translateY(6px)` 进场 |
| 完整进出场范式 | `components/ContextUsagePopover.tsx` | 唯一同时有进场 scale、退场 `is-closing`、动态 `transform-origin` 的浮层，可作为统一模板 |
| 减少动效兜底 | `styles.css` 的 `prefers-reduced-motion` 全局规则 | 把所有 animation/transition 压到 0.01ms、iteration=1、delay=0 |

另有两处值得注意的既有实现：

- `styles.css` 的 `.side-panel-swap` / `side-panel-in` 目前没有任何 TSX 引用，是可直接复用的面板淡入死代码。
- `styles.css` 的 `.tool-collapse`、`.time-spent-body` 已用 `grid-template-rows` 做展开折叠，说明高度过渡在本项目的既定做法是 grid 而非 `max-height`。

---

## 2. 现状盘点（按区域）

### 2.1 页面与外壳

| 场景 | 现状 | 备注 |
| --- | --- | --- |
| Onboarding → 主界面 | 无过渡 | `App.tsx` 在 onboarding 分支与主界面分支直接返回两棵不同的树，状态翻转即整屏换树 |
| 设置页开关 | 已有 | `App.tsx` 用两个 `Presence` 包裹聊天区与设置页，`styles.css` 的 `.main-stage-pane` 做 opacity 过渡 |
| 设置页内分区切换 | 硬切 | `SettingsView.tsx` 各分区用 `hidden` 控制，导航项无颜色过渡 |
| 工作区切换 | 无过渡 | 切换后只清理终端的标签页，聊天区内容原地替换 |
| 工作台面板开/关 | 瞬时 | `WorkbenchPanel.tsx` 的 `WorkbenchPanel` 在 `tabs.length === 0` 时直接 `return null`，挂载/卸载无动画；只有挂载后的宽度有过渡 |
| 标签内容切换 | 硬切 | `styles.css` 的 `.workbench-tabpanel[hidden]` 为 `display: none` |
| 标签增删 | 无进出场 | 标签宽度动画已有，但新增/关闭没有淡入淡出，也没有重排动画 |
| 左/右侧栏折叠 | 已有 | `styles.css` 用 `--transition-sidebar` 过渡宽度；拖拽期间通过 `data-resizing` 关闭过渡以保证跟手 |
| 侧栏会话列表 | 无过渡 | `Sidebar.tsx` 的新增/归档/排序瞬时；`.subchat-item` 的 hover/激活态无过渡，激活左条直接出现 |
| Onboarding 步骤切换 | 硬切 | `OnboardingView.tsx` 的内容容器按 `step` 换 key，remount 即切换，无方向感 |
| 起始标签页卡片 | 部分 | `.start-option` 已有 hover/active 过渡，但挂载时无入场 |
| 对话框 | 已有 | `.sheet-backdrop`、`.sheet-card` 有完整进出场关键帧，由 `SheetPresence` 驱动 |

### 2.2 对话流

| 场景 | 现状 | 备注 |
| --- | --- | --- |
| 消息出现 | 已有 | 仅新出现的消息播 `message-enter`，切换对话补历史时不播 |
| 流式文本 | 无动画 | `ChatView.tsx` 直接把整段 text 交给 `Markdown`，每个增量 chunk 整段重新解析渲染，delta 阶段没有任何过渡 |
| 工具卡片 | 部分 | `.tool-collapse` 有高度过渡、chevron 有旋转、running 有 `tool-spin`/`tool-pulse`；但卡片首次挂载无进场，`ToolCard.tsx` 的 `StatusMark`、`CompactStatus` 在状态切换时直接换 DOM 节点 |
| 思考块 | 部分 | `.time-spent-body` 有高度过渡、`.thinking-scroll-fade` 有渐隐过渡；总结文本从 pending 到完成只是替换文本，无过渡 |
| 自动滚动 | 瞬时 | `ChatView.tsx` 直接把 `scrollTop` 设为 `scrollHeight`，任何地方都没有 `scroll-behavior: smooth` |
| 回到底部按钮 | 不存在 | 整个 renderer 没有该元素的 DOM；属于功能缺口，不是动画缺口 |
| 轮次变更卡片 | 部分 | `.turn-changes-more` 的箭头有旋转过渡，统计数字无出现动画 |

### 2.3 输入区与浮层

| 场景 | 现状 | 备注 |
| --- | --- | --- |
| 浮层进场 | 已有 | `.dock-popover`、`.skill-menu` 等靠 `@starting-style` 淡入上移 |
| 浮层退场 | 缺失 | AttachMenu、SkillMenu、ModeChip、SandboxPill、WorkspaceChip、EnvironmentChip、BranchChip、ModelMenu、RepoCard 菜单均为条件挂载，关闭即卸载，瞬隐；只有 `ContextUsagePopover` 实现了退场 |
| 菜单行状态 | 无过渡 | `.menu-row`、`.mode-option`、`.sandbox-option`、`.attach-menu-row`、`.open-in-row`、`.environment-row`、`.branch-item` 等只有静态 hover 背景 |
| 键盘高亮滚动 | 瞬时 | `composer/SkillMenu.tsx` 直接赋值 `scrollTop` |
| chip 状态 | 部分 | `.composer-chip` 有背景/颜色过渡；`.mode-pill`、`.sandbox-pill` 在模式切换时语义色硬切，也没有 `:active` 反馈 |
| 审批横幅 | 部分 | `.approval-slot` 有展开动画，但横幅内容出现时无淡入，按钮无按压反馈 |
| Composer 高度 | 瞬时 | `Composer.tsx` 在输入变化时直接写 `style.height`，`.input-textarea` 无高度过渡 |
| 统计行 | 部分 | `ComposerStatsRow.tsx` 的 `.composer-stat-ring` 用 `strokeDashoffset` 表示用量，无过渡，数值刷新瞬跳 |
| 发送/停止按钮 | 瞬切 | `Composer.tsx` 按 `streaming` 条件渲染两个按钮，无交叉过渡 |
| 附件列表 | 无过渡 | 附件条件挂载，移除后剩余 chip 瞬跳 |

### 2.4 工作台面板

| 场景 | 现状 | 备注 |
| --- | --- | --- |
| 文件树展开 | 瞬时 | `preview/ExplorerPane.tsx` 的 `FileTree` 条件渲染子节点，展开标记变化即挂载/卸载子层 |
| 文件树选中 | 无过渡 | `.explorer-tree-item` 的激活态直接切换 |
| 文件预览 | 硬切 | `preview/CodePane.tsx` 的载入态是 `.code-state` 文案，数据到达后直接切到正文 |
| Diff 切换 | 硬切 | `ChangesView.tsx` 用 `key` 重挂 `DiffPane`；`DiffPane.tsx` 的 `DiffLine` 按索引渲染，无进场 |
| Diff 行高亮 | 无动画 | `.diff-line.add`、`.diff-line.del` 只有静态背景色 |
| 计划面板流式 | 无动画 | `PlanPanel.tsx` 的 `PlanDocumentPane` 把整段 markdown 交给 `Markdown`，每个 chunk 整段重渲染 |
| 计划版本切换 | 瞬切 | `.plan-revision-option` 的 hover/active 无过渡，版本菜单沿用 `.dock-popover`（有进场、无退场） |
| 子代理面板 | 无过渡 | `AgentPane.tsx` 步骤流式追加无进场 |
| Trace | 部分 | `.trace-bar.running`、`.trace-spinner` 已有动画并有 reduced-motion 专项兜底 |
| 终端 | 挂载即显示 | xterm 实例的显示/隐藏无过渡 |

---

## 3. 总优先级表

`M` 编号用于跨节引用。位置列的「组件」指 TSX 内的符号，「样式」指 `styles.css` 中的类名或变量。

| 编号 | 优先级 | 场景 | 位置 | 建议动效 |
| --- | --- | --- | --- | --- |
| M01 | P0 | Onboarding → 主界面 | `App.tsx` 两个 return 分支 | 根层 crossfade：旧屏 opacity→0 + `translateY(-4px)` 140ms，新屏 opacity 0→1 + `translateY(4px)→0` 240ms，重叠约 80ms |
| M02 | P0 | 工作台面板开/关 | `WorkbenchPanel.tsx` 的 `WorkbenchPanel` | 开：宽度 280ms `--transition-sidebar` + `translateX(8px)→0`/opacity 160ms；关：保持挂载 160ms 淡出后卸载 |
| M03 | P0 | 标签内容切换 | 样式 `.workbench-tabpanel[hidden]` | 120ms crossfade + `translateY(2px)`，可直接复用未引用的 `.side-panel-swap` |
| M04 | P0 | 浮层退场 | 9 处条件挂载浮层 | 抽共享 presence hook，退场 110ms `cubic-bezier(0.4,0,1,1)` + `scale(0.98)`；进场补 `scale(0.97→1)` 与 `transform-origin`，模板取 `ContextUsagePopover` |
| M05 | P1 | 会话/工作区切换 | `ChatView.tsx` 消息区 | 消息区按 `workspaceKey`/`conversationId` 换 key，入场 180ms `--transition-enter` fade + `translateY(6px)` |
| M06 | P1 | 侧栏会话列表 | `Sidebar.tsx`、样式 `.subchat-item` | 新行 160ms 进、删除 140ms 缩高淡出、重排用 FLIP；激活左条 `scaleY(0→1)` 160ms；归档按钮 140ms |
| M07 | P1 | Onboarding 步骤切换 | `OnboardingView.tsx` 内容容器 | 前进：旧屏 `translateX(-16px)` 140ms，新屏 `translateX(16px)→0` 200ms；后退反向 |
| M08 | P1 | 折叠区高度 | `ContextPanel.tsx` 的 `PanelDisclosure`、`ContextUsageCard` | 复用 `.approval-slot` 的 `grid-template-rows` 模式，220ms + 内容 opacity 120ms |
| M09 | P1 | Composer 高度 | `Composer.tsx` 写 `style.height` 处 | `.input-textarea` 加 `height 120ms`，写值前后临时关闭 transition 避免首帧异常 |
| M10 | P1 | 发送/停止按钮 | `Composer.tsx` 发送区 | 固定槽位叠放两按钮，`opacity 120ms` + `scale(0.86→1)` 160ms 交叉 |
| M11 | P1 | 上下文用量环 | 样式 `.composer-stat-ring` | `stroke-dashoffset 320ms` + high 状态变色 200ms |
| M12 | P1 | 文件预览载入 | `preview/CodePane.tsx` | 内容 120–160ms fade + `translateY(2px)`，或双缓冲保留旧内容 |
| M13 | P1 | Diff 切换与行高亮 | `DiffPane.tsx`、`ChangesView.tsx` | 切换 150ms fade；`.diff-line.add/.del` 背景 240ms 淡回 |
| M14 | P1 | 流式 Markdown | `Markdown.tsx`、`ChatView.tsx` | 先做块级 memo，仅对增量尾块做 opacity 120ms；不要对每个 chunk 加动画 |
| M15 | P1 | 计划面板 | `PlanPanel.tsx` 的 `PlanDocumentPane` | 正文同 M14；版本切换 150ms crossfade；`.plan-revision-option` 补 100ms 背景过渡 |
| M16 | P1 | 工具卡片 | `ToolCard.tsx` 的 `StatusMark`、`CompactStatus` | 状态图标 opacity + color 140ms 交叉；卡片首挂载 180ms 进场 |
| M17 | P1 | 附件列表 | `Composer.tsx` 附件区 | 进 160ms `scale(0.94)` + fade；移除 140ms 退场 + FLIP 160ms |
| M18 | P2 | 菜单行反馈 | 样式 `.menu-row` 等菜单类 | 统一 `background-color 100ms cubic-bezier(0.2,0,0,1)`，键盘高亮可短到 70ms；`SkillMenu` 滚动改 smooth |
| M19 | P2 | chip/pill 状态 | 样式 `.mode-pill`、`.sandbox-pill` | 语义色 180ms；所有 chip 补 `:active` 微缩（80ms） |
| M20 | P2 | 文件树展开/选中 | `preview/ExplorerPane.tsx` 的 `FileTree` | 子节点 120ms grid-rows 或 fade；选中背景 120ms |
| M21 | P2 | 起始卡片入场 | `StartView.tsx` 的 `StartOption` | `translateY(8px)` 180ms、30ms/张交错 |
| M22 | P2 | 思考总结文本 | `Thinking.tsx` | 总结出现 180ms fade + `translateY(2px)` |
| M23 | P2 | 对话框背景 | 样式 `.sheet-backdrop` | 加 `backdrop-filter: blur(2px)` 与 opacity 同帧 |
| M24 | P2 | Trace 入场 | `trace/TraceView.tsx` | 树与条 140ms stagger 进场 |
| M25 | P2 | 子代理步骤 | `AgentPane.tsx` | 流式追加 140ms fade 进场 |

---

## 4. 统一动效规范（建议）

1. **时长阶梯**：70–120ms 高频反馈（hover、键盘高亮）；140–180ms 小元素进出；240–280ms 面板与页面。单次动画不超过 320ms。
2. **缓动**：进入统一 `cubic-bezier(0.16, 1, 0.3, 1)`（复用现有 token）；退场用更快的 `cubic-bezier(0.4, 0, 1, 1)`，形成「慢进快出」的响应感。
3. **属性**：只动 `transform` / `opacity`；高度过渡沿用项目既有的 `grid-template-rows` 做法；不要使用 `transition: all`。
4. **退出动画**：保持挂载到结束再卸载。优先复用 `Presence` / `SheetPresence`，浮层建议抽一个共享 presence hook，避免九个组件各写一套。
5. **列表重排**：用 FLIP，不要逐项重挂。
6. **流式性能**：Markdown 目前每个 chunk 整段重解析，先做块级 memo 再谈动画；动画只作用于增量尾块。
7. **减少动效**：CSS 部分已被全局 `prefers-reduced-motion` 规则覆盖；JS 驱动的部分（FLIP、smooth scroll、延迟卸载、数字 tween）需要自行读取该偏好。
8. **语义色变化**（模式、沙箱状态）比几何动画略慢，让用户能读出状态切换。

---

## 5. 建议落地批次

| 批次 | 内容 | 对应编号 |
| --- | --- | --- |
| Batch 1（已实现） | 页面/面板/标签切换 + 共享浮层 presence | M01–M04 |
| Batch 2（已实现） | 日常高频交互：会话切换、列表增删、折叠区、Composer、载入过渡、Diff | M05–M13、M16、M17 |
| Batch 3（已实现） | 流式体验与打磨 | M14、M15；M18–M25 |

### Batch 1 落地说明

第 2 节保留实现前的盘点；Batch 1 当前已具备以下行为：

- M01：根层 `ScreenPresence` 保持引导页 140ms 退场，主界面延迟 60ms 后以 240ms 淡入，重叠约 80ms。
- M02：工作台开场宽度 280ms，透明度和水平位移 160ms；关闭最后一个标签时保持面板挂载，退场结束后卸载。
- M03：`WorkbenchTabPanel` 为标签内容提供 120ms 交叉淡入淡出和 2px 位移；非活动标签在退场后隐藏，组件状态继续保留。文件标签共享的预览实例切换时使用 120ms 淡入，不重挂预览组件。
- M04：`useMotionPresence` / `PopoverPresence` 统一浮层 110ms 退场，覆盖审计中的九类菜单，并用于思考强度菜单和已有的上下文用量浮层。关闭后立即设置 `inert`；重开取消旧的卸载计时器。Repo 原生浮层保持在 top layer 直到退场完成，按实际方向设置缩放原点。
- 减少动态效果：CSS 禁用位移；共享 hook 监听偏好变化，跳过延迟卸载。

验证：桌面构建、渲染层类型检查、消息动效/浮层定位/侧栏尺寸的相关测试，以及浏览器中的页面交叠、快速重开、标签状态保留、工作台退出、原生浮层和减少动态效果集成检查。

浏览器检查可运行 `pnpm --filter @vela/desktop test:trace:preview`，打开 `http://127.0.0.1:5179/test/motion-preview.html?checks=1`；不带 `checks` 参数可手动检查动效。

### Batch 2 落地说明

- M05：消息内容按工作区/会话身份重挂，以 180ms 淡入与 6px 上移切换；滚动容器和 Composer 保持挂载，历史消息仍由原有追踪器避免逐条入场。
- M06：`MotionList` 保留被移除的会话与工作区分组 140ms，退出内容立即 `inert`；新增行 160ms 入场、存量节点 160ms FLIP 重排。快速恢复同一项会取消卸载。激活左条与归档按钮加入过渡。
- M07：`ContentSwap` 保留上一引导步骤的 DOM，以 140ms 退场、200ms 进场；前进和后退使用相反方向。每步有独立滚动容器，新步骤从顶部开始，快速切换只保留一个退出层。
- M08：`PanelDisclosure` 和上下文用量明细采用 220ms grid 高度过渡、120ms 内容淡化；关闭区域立即从交互和可访问性树中排除，保留内容状态。
- M09–M11：输入区高度 120ms，测量临时禁用过渡，再从当前可见高度向新高度变化；宽度改变时重新测量并保留 140px 上限。发送/停止按钮叠放于固定槽位，120ms 淡化与 160ms 缩放交叉，仅当前操作可交互。用量环进度 320ms、高用量颜色 200ms。
- M12：文件读取完成后 150ms 淡入与 2px 上移；异步语法高亮不重复触发动效，编辑器和缓存滚动位置保持不变。
- M13：Diff 到达时 150ms 淡入，增删行用 240ms 透明度强调后回到原有语义背景。异步结果绑定文件身份，切换时展示读取状态，避免新文件标题下闪现旧 Diff。
- M16：工具卡片首挂载 180ms 入场，状态标记 140ms 交叉淡化，旧标记不可交互；紧凑行完成后退出标记不占布局间隙。
- M17：附件使用稳定身份，160ms 缩放淡入、140ms 退场，剩余节点用 FLIP 重排；退场期间排除交互，空列表不保留布局间隙。
- 减少动态效果：沿用全局 CSS 规则；JS 动画在偏好变化时取消，列表和状态退出跳过保留时长。

验证风险为**高风险、影响范围限于渲染层**（共享动效组件、多个界面模块）。桌面构建、渲染层类型检查、45 个相关单元测试、12 项 Batch 2 浏览器集成检查与 9 项 Batch 1 兼容性检查通过；完整聊天布局也做了视觉检查。未运行与这些改动无关的全仓回归。

浏览器检查沿用上述预览服务，打开 `http://127.0.0.1:5179/test/motion-batch2-preview.html?checks=1`。不带 `checks` 参数可手动操作实际组件；引导页由顶部的 Preview onboarding 按钮打开。

### Batch 3 落地说明

- M14：流式 Markdown 用 `unified` / `remark-parse` 的实际块边界划分内容，仅重解析可变尾部，已稳定前缀保留块对象并通过 memo 复用渲染。保留最后两个解析节点，以处理尚未完成的 Setext 标题、表格分隔符、列表和代码块；新尾块仅首次出现时淡入 120ms，chunk 追加不重播。流式完成后保留 DOM 与选择状态，静态文档仍只解析一次；文件引用与语言切换继续生效。
- Markdown 语义兜底：引用定义和脚注具有整篇作用域，检测到后使用整篇解析，禁用块入场，避免后置定义失效或重复脚注 ID。解析器沿用已有依赖树中的版本，没有升级依赖。
- M15：计划正文共用流式 Markdown；版本以 150ms crossfade 切换，退出层立即 `inert`，快速切换只保留一个旧版本，各版本阅读位置继续恢复。修订与执行菜单接入共享 `PopoverPresence`，菜单行补齐背景反馈。
- M18–M19：菜单行背景/颜色 100ms，Skill 高亮 70ms，滚动以 smooth 跟随并支持快速反向切换；减少动态效果时立即定位。模式与沙箱语义色 180ms，chip 按压 80ms 微缩。
- M20：文件树首次展开时才挂载子层，随后用 120ms grid 高度与 opacity 过渡，折叠后保留节点并立即排除交互；目录箭头旋转，选中背景过渡 120ms。
- M21–M23：起始卡片 180ms 入场、每张错开 30ms；思考总结的行内、标题和正文样式均有 180ms 淡入与 2px 位移；对话框背景同步加入 2px blur，并支持减少透明效果偏好。
- M24–M25：Trace 可见行与时间条 140ms 错开淡入，记录完整数据集身份，虚拟列表回滚和流式更新不重播历史。子代理的新消息、思考/正文步骤及工具卡片追加使用 140ms 淡入，保留原有滚动跟随。
- 减少动态效果：JS 入场取消进行中的动画，偏好恢复后不重播旧项目；CSS 清除交错延时，文件树直接达到开合状态，计划退出跳过保留。

验证风险为**高风险、影响范围限于渲染层**（共享 Markdown、列表入场和多个界面模块）。桌面构建、主进程/渲染层类型检查、108 个相关单元测试、10 项 Batch 3 浏览器检查，以及 12 项 Batch 2、9 项 Batch 1 兼容检查通过。未运行与这些改动无关的全仓回归。

浏览器检查沿用上述预览服务，打开 `http://127.0.0.1:5179/test/motion-batch3-preview.html?checks=1`；不带 `checks` 参数可手动追加段落、切换计划、展开文件树、生成总结和追加子代理步骤。

---

## 6. 附：盘点时的两个非动效发现

- **「回到底部」按钮不存在**：`Design/README.md` 的原型描述里有浮动滚动按钮，实际 renderer 没有任何相关 DOM。若要补，属功能开发；进出场可复用 `.dock-popover` 的 `@starting-style` 模式。
- **`.side-panel-swap` 是死代码**：只有 CSS 没有引用，可直接拿来做 M03 的标签内容切换。

# Pi 1.0 迁移记录

日期：2026-10-03。此记录对应当前开发分支；没有发布、部署或创建 PR，也没有提升 Vela 应用版本。

## 版本与基线

开始时工作区干净，没有发现额外的仓库或上级目录 AGENTS.md；按任务给出的 Validation Policy 将升级视为高风险依赖及运行时迁移。

实际依赖声明为 `^0.87.1`，pnpm 锁定为 `0.87.1`。检查 npm 元数据时，`pi-coding-agent`、`pi-agent-core`、`pi-ai` 的 `latest` 均为 `1.0.0`，没有已发布的稳定 `1.0.x` 补丁。选择精确 `1.0.0`，统一更新 `packages/agent`、`packages/workspace`、`apps/desktop` 中的所有直接 Pi 引用及 pnpm 锁文件。

核对了 [官方 v1.0.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.0.0)、[该版本的完整变更记录](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md)（包括 0.99.0–0.99.2 的中间变更）、[npm 发布元数据](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent)，并比较安装的 0.87.1 与 npm 发布的 1.0.0 源码及类型声明，没有用 main 分支代替已发布包推断接口。

升级前记录的检查：

| 检查 | 基线 |
| --- | --- |
| `pnpm typecheck` | 所有有 typecheck 脚本的 workspace 通过；含桌面主进程和渲染器 |
| `pnpm --filter @vela/agent test` | 201 项通过，0 失败 |
| 桌面会话、事件、持久化、Trace、统计、Browser Host/REPL 和沙箱权限定向测试 | 97 项通过，0 失败 |
| `pnpm build` | 生产构建通过 |

## 必要适配与兼容性核对

### 运行中指令

`packages/agent/src/runtime.ts` 的 `queueInstruction` 实际读取 `steer()` / `followUp()` 的 `queued` / `handled` 返回值。

- `PendingInstruction.queued` 只有收到入队确认后才置位。队列事件可能先于异步输入处理的返回值；尚未确认的输入不参与投递计数，返回后再对账。
- `handled` 直接移除待处理输入，不补发 `user_message`，不增加消息计数。
- 撤销指令时复制剩余列表并重置入队确认，逐条回放；扩展在回放时消费的输入也不会被误报为用户消息。
- 保留原始输入展示、技能/模板展开、图片参数、steering 与 follow-up 的交付边界、停止清队列及失败回滚。

新增测试覆盖被扩展消费的两种输入、返回前消费、输入处理期间消费先前消息、撤销回放及处理失败。实际 SDK 测试也验证了输入转换及两种队列的模型上下文顺序。

### 工具、模式、权限与扩展

Pi 1.0 的 `tools` 仍是注册表白名单，同时过滤内置和自定义工具；SDK 自定义工具仍在注册表中同名覆盖内置工具。保留 root/child 的显式白名单及 `setActiveToolsByName` 模式切换。

实际 SDK 测试验证 Agent/Plan/Goal 工具集合、Plan 的最终执行守卫、explore 只读 bash 拦截、同名沙箱工具覆盖与审批拒绝。现有 AgentControl 测试及本地 HTTP SDK 子代理测试覆盖派生、并发、回传、停止与历史恢复。真实 Electron 检查验证 Browser REPL、guest/CDP、utility worker、重置、中止、页面关闭和崩溃处理。

0.87.1 与 1.0.0 的 AgentSession 构造函数都会创建 extension runner 并绑定核心动作。Vela 的模式和 explore 扩展不需要额外调用 `bindExtensions()` 才能执行守卫。保留现有宿主订阅与 `detachEntry` / AgentControl / SDK `dispose` 路径，没有新增绑定或监听。Vela 原本没有显式触发 SDK `session_start` / `session_shutdown`；这次没有改变这个外部扩展生命周期约定，也没有注册需要这些事件的新内置扩展。任意第三方扩展自己的启动/退出资源行为不属于已执行的运行验收。

### 会话与结果

Pi 的会话格式仍为版本 3，但首次落盘已从等待 assistant 改为收到首条 user 或 assistant。Vela 仍在用户创建空对话时写 header 并重新打开，因为 Pi 的懒创建仍不能保证空会话恢复；只更新了该辅助函数的说明。

`packages/agent/test/fixtures/pi-0.87.1.jsonl` 由旧版 SessionManager 生成，使用合成消息和路径。测试覆盖该文件恢复、工具正文、分支、回退到用户消息、resetLeaf 和重新追加；现有运行时测试覆盖重启后的空会话、分支、回退、文件检查点、子代理历史与计时。

工具事件及现有 content/details 消费保持兼容。Pi 的 bash 非零退出会返回错误结果；实际执行 `exit 7` 验证只审批一次、保留输出、错误标记和工具计数。Trace 与上下文测试覆盖请求、工具错误、缓存/输出 token、分支与回退。没有接入新的 nested tool calls 或新的模型操作。

### 模型与认证

保留聊天模型读取接口、用户选择与 `models.json` 自定义模型，以及原有 auth.json API-key / `openai-codex` OAuth 凭据格式；合成旧凭据的读取不会改写认证文件。本地 HTTP 回归通过实际 SDK 的 OpenAI-compatible 路径，未使用真实账户。

Pi 新增的 `openai` ChatGPT OAuth 要求宿主提供稳定的设备 ID，旧 Vela 登录调用没有这一选项。`packages/agent/src/model-directory.ts` 隐藏并拒绝这个尚未接入的新登录方式，保留 OpenAI API Key 和既有 `openai-codex` 登录。没有迁移 provider 或替换用户选定模型。

聊天目录排除没有聊天模型的内置提供方，避免新增的 TypeSafe 分类器入口出现在 Vela 设置里；用户显式配置的自定义提供方仍保留。没有启用分类、虚拟模型路由或图像生成。

### 传递依赖与 Electron

锁文件新增 `pi-mcp@1.0.0`、`pi-codemode@1.0.0`、`quickjs-wasi@3.6.2`，OpenAI SDK 从 6.40.0 更新到 7.19.0；其他 Pi 家族依赖随发布包同步到 1.0.0。新增依赖存在于安装图和应用归档，不代表 Vela 注册了相应功能。

Pi 继续作为外部依赖进入生产包。现有 Electron 打包规则保留模块相对路径并解包 WASM，不需要修改 worker 打包配置。生产构建与 macOS arm64 应用目录打包通过；在 Electron 中加载 ASAR 的实际主进程、preload 和 renderer，验证三个核心包均为 1.0.0，依赖来自归档内部，QuickJS WASM 可读取/编译且位于解包目录，codemode worker 和 Vela browser worker 文件路径完整。没有启动 codemode VM 或把它注册为模型工具。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| 最小针对性测试：运行中指令、会话、Plan、子代理、Trace、上下文 | 64 项通过；随后新增实际 SDK / 旧 JSONL 覆盖 |
| `pnpm typecheck` | 通过 |
| `pnpm --filter @vela/agent test` | 215 项通过，0 失败 |
| 桌面与沙箱受影响系统回归 | 158 项通过，0 失败 |
| `pnpm build` | 生产 main/preload/renderer 构建通过 |
| `electron-builder --mac --arm64 --dir` | 应用目录与 ASAR 打包通过；没有签名或生成 DMG |
| `test:pi-sdk:electron`，生产构建及 ASAR 各执行一次 | 各自通过会话创建、模式切换、无模型选择与重启恢复 |
| `node apps/desktop/test/browser-use-electron-smoke.mjs` | 现有真实 Electron Browser Use 检查通过 |
| `git diff --check`、冻结锁文件一致性 | 通过 |

Agent 测试执行了全套，因为共享 SDK 影响该包的各项会话功能；桌面执行受影响的会话、工具、Plan、Trace、统计与浏览器回归。没有运行无关的 Git/GitHub 操作、图像查看器、动画或 README 视觉测试，也没有修复无关问题。

复验入口（从仓库根目录）：

```sh
pnpm typecheck
pnpm --filter @vela/agent test
pnpm build
pnpm --filter @vela/desktop test:pi-sdk:electron
node apps/desktop/test/browser-use-electron-smoke.mjs
```

桌面与沙箱的 158 项回归命令：

```sh
node --import ./packages/agent/test/register-ts.mjs \
  --experimental-transform-types --experimental-test-module-mocks --test \
  packages/workspace/test/sandbox-permission-manager.test.ts \
  apps/desktop/test/agent-stream.test.ts apps/desktop/test/message-store.test.ts \
  apps/desktop/test/trace-model.test.ts apps/desktop/test/composer-stats.test.ts \
  apps/desktop/test/usage-model.test.ts apps/desktop/test/session-create.test.ts \
  apps/desktop/test/persistence.test.ts apps/desktop/test/browser-host.test.ts \
  apps/desktop/test/browser-repl-manager.test.ts apps/desktop/test/browser-repl-worker.test.ts \
  apps/desktop/test/tool-sequence.test.ts apps/desktop/test/tool-duration.test.ts \
  apps/desktop/test/tool-diff.test.ts apps/desktop/test/tool-compact.test.ts \
  apps/desktop/test/plan-draft.test.ts apps/desktop/test/plan-document.test.ts \
  apps/desktop/test/chat-lane.test.ts
```

`VELA_PI_SMOKE_APP_ROOT=/absolute/path/to/app.asar` 可让 `test:pi-sdk:electron` 加载打包后的生产入口。检查使用临时 Vela 数据、Electron userData/sessionData 和临时工作区，退出后清理；不读取用户真实认证与聊天数据。

## 未验证与边界

- 未执行真实提供方登录、OAuth 刷新或在线模型请求；本地合成凭据和 HTTP fixture 通过不能替代这部分验证。
- 未安装/运行 DMG 或 zip 中的独立应用可执行文件，也未进行签名、公证、Windows/Linux 打包。ASAR 在开发 Electron 宿主中的生产入口运行已验证。
- 未运行任意第三方扩展的生命周期验收；codemode、分类和图像生成路径不在本记录范围，MCP 由后续接入单独验收（见 [MCP 服务器](./mcp.md)）。
- Browser Use fixture 包含预期失败导航，日志中的 `ERR_EMPTY_RESPONSE` 来自该负例；还出现 Chromium WidgetHost 拒收日志，但所有 fixture 的 PASS 标记及退出码均通过。

本次 Pi 迁移本身未新增 MCP 配置界面，未注册/启用 MCP、Codemode、tool_search、虚拟模型、分类器或图像生成产品功能；默认 read/bash/edit/write、Vela 自定义模式/agent/browser 工具及权限策略保留。随后落地的 MCP 接入在同一个 1.0.0 补丁上增加了 `agentDir` 与 MCP controller 结构化接口，行为、权限和验收见 [MCP 服务器](./mcp.md)。

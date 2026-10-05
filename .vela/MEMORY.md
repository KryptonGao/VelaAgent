# Vela 项目记忆

## 项目概况

- Vela：在本地代码仓库中工作的桌面 AI 编程助手，基于 [Pi Agent](https://github.com/earendil-works/pi) TypeScript SDK 嵌入 Electron 桌面应用。
- GitHub 仓库：`https://github.com/KryptonGao/VelaHarness`（2026-10 由 `VelaAgent` 更名并重新绑定，旧地址在 GitHub 侧自动重定向）；工作区目录与根包名同步为 `VelaHarness` / `vela-harness`，origin 使用 HTTPS。仓库地址硬编码在 `apps/desktop/src/main/menu.ts` 的 `repoUrl`。
- 技术栈：pnpm workspace（hoisted）；Electron 44 + electron-vite + React 19 + TypeScript；Pi 依赖 `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` 精确锁定 `1.0.0`，并通过 `pnpm-workspace.yaml` 的 `patchedDependencies` 打补丁。Node >= 22.19.0，pnpm 由 `packageManager` 固定为 11.24.0。
- 包结构：`apps/desktop`（Electron 主进程 / preload / React 渲染层）、`packages/agent`（Pi 会话运行时、交互模式、上下文统计）、`packages/workspace`（工作区、worktree、Git、PR、审批）、`packages/shared`（主进程与界面共享类型与 IPC 契约）、`packages/tools`（内置工具目录）。workspace 包均为 private、无构建产物（exports 指向 `src/index.ts`）。
- 会话在主进程通过 `createAgentSession()` 创建，不启动 Pi CLI。主进程处理 Agent / 文件系统 / Git，renderer 经 preload IPC 调用；窗口启用 `contextIsolation`、关闭 `nodeIntegration`。

## 常用命令

- `pnpm install`（postinstall 会品牌化 Electron 开发二进制并修复原生模块）、`pnpm dev`（Electron 开发环境）。
- `pnpm build`、`pnpm typecheck`（递归全仓库）。
- `pnpm test:center`：测试中心，统一运行 Node 单测与浏览器 UI 检查（网页看板）。
- 定向测试：`pnpm --filter @vela/desktop test:<feature>`（如 `test:memory`、`test:mcp`、`test:trace`）；Electron 冒烟为 `test:<feature>:electron`。根脚本另有 `test:plugins`、`test:mcp`。
- 示例数据预览：`pnpm --filter @vela/desktop test:trace:preview`（确定性 UI 页面，不调用模型）。

## 测试约定

- Node 测试用内置 test runner + `--experimental-transform-types`，并先 `--import packages/agent/test/register-ts.mjs`（为无后缀 TS 相对导入补 `.ts` 解析）。
- 测试文件命名与位置：Node 单测 `*.test.ts` 分布在 `packages/{agent,workspace}/test`、`apps/desktop/test`；浏览器 UI 检查为 `*.mjs`（如 `plugins-ui.mjs`、`memory-settings-ui.mjs`）；Electron 冒烟为 `*-electron-smoke.mjs`。
- 新增定向测试组要接进 `apps/desktop/package.json` 的 `test:*` 脚本；`apps/desktop/test-center/discovery.mjs` 会从这些脚本推导功能分组（纯文件系统扫描，不运行测试）。
- 渲染层测试偏好纯逻辑模型文件（如 `*-model.ts`）配 Node 单测，UI 检查另跑。

## 文档约定（docs/README.md）

- 正文简体中文；文件名、类型名、函数名、工具名、命令保持英文原文。
- 行为描述必须能在源码或测试中定位；引用写成 `` `路径` 的 `符号名` ``，不写行号。
- 只描述已实现能力，不把计划写成现状；`docs/requirements/` 必须标注实现状态，区分当前实现与目标行为。
- 文档之间、文档与根 README 用相对链接；与根 README 重复的内容只保留概览。
- 新增专题文档要在 `docs/README.md` 索引表补一行。根 README 为中文，`RELEASE_NOTES.md` 为英文。

## 发布与提交约定

- 版本号维护在 `apps/desktop/package.json` 的 `version` 与 `shortVersion`；当前线为 1.0.x。
- `RELEASE_NOTES.md` 记录各版本发布说明（New / Improved / Upgrade / Download / Validation 结构，英文）。
- 提交信息为 conventional commits（`feat:` / `fix:` / `docs:` / `test:`），发布提交以 `release X.Y.Z` 结尾。
- macOS 打包：`pnpm package:mac`、`pnpm --filter @vela/desktop dist:mac:signed`；发布包未公证，首次启动需 Open Anyway。

## 本地数据与配置

- 数据目录：安装版默认 `~/.vela`，开发版默认 `~/.vela-dev`，`VELA_USER_DATA` 可覆盖；同一数据目录单实例。开发版有「设置 → 开发工具 → 同步正式版会话」单向复制。
- 关键文件：界面状态 `ui-state.json`；会话 `sessions/*.jsonl`；轨迹 `~/.vela/traces`；MCP `mcp.json` / `mcp-auth.json` / `mcp-policy.json`（项目级 `.pi/mcp.json`）；定时任务 `scheduled-tasks.json`；任务配方 `task-recipes.json`（项目库 `.vela/task-recipes.json`、团队 `.vela/team-task-recipes.json`）。
- 执行权限三档：每次询问 / 帮我批准 / 完全访问；这是交互式审批策略，不是操作系统级沙箱。
- worktree 由本地 Git 创建在 `~/.vela/worktrees`，使用独立 `vela/wt-*` 分支。

## 领域约定

- 记忆功能：项目记忆为 `<工作区>/.vela/MEMORY.md`，全局记忆为 `<agentDir>/MEMORY.md`；revision 是内容 UTF-8 字节的 sha256（缺失固定为 `absent`），单文件上限 16 KiB，写入需完整文档合并并带 revision 防冲突。
- 模式：Agent / Plan / Goal。Plan 只读（禁编辑写入、只放行只读命令），产出 Plan Document 并在批准后执行。
- 界面默认紧凑模式收拢工具调用；`*-preview.tsx` 等预览页面复用真实组件、使用生成数据，不调用模型。
- 用户 Skill 加载顺序：`.pi/skills`、`.agents/skills`、`~/.agents/skills`、`~/.vela/skills`，项目内同名优先。

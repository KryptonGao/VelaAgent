# Vela

**在真实代码仓库里工作的桌面 AI 编程助手。**

用自然语言提出任务，让 Agent 在你选定的工作区中调查、编辑和运行代码；在同一个窗口里跟踪工具调用、Git 差异和执行权限。

## 你可以用 Vela 做什么

- **按任务选择模式：** Agent 模式处理日常开发；Plan 模式只读调研并整理步骤，确认后再执行；Goal 模式会持续推进目标，必要时可以暂停或继续。
- **直接在项目中工作：** 选择本地目录，或让 Vela 在独立的 Git worktree 中操作。
- **检查每一步改动：** 查看工具调用和文件差异，管理分支与暂存状态；查看或创建当前分支的 Pull Request。
- **保留工作上下文：** 会话会在应用重启后恢复；模型、思考强度、上下文用量和工具活动都能在界面中查看。
- **连接自己的模型：** 登录可用的模型提供方，或添加自定义模型接口。

## 快速开始

需要 **Node.js 22.19 或更高版本**，以及 **pnpm 11.24.0**（版本由仓库的 `packageManager` 字段固定）。在仓库根目录运行：

```sh
pnpm install
pnpm dev
```

首次启动后：

1. 在设置中的「模型与账号」登录一个提供方，或添加自定义模型。
2. 从输入框选择一个项目目录。
3. 选择 Agent、Plan 或 Goal 模式，描述要完成的任务。

## 本机资料与 Skill

对话、模型账号、工作区记录和执行权限保存在 `~/.vela`。在 macOS 上这就是 `/Users/<用户名>/.vela`。Electron 的缓存仍留在系统的应用支持目录。

用户 Skill 放在 `~/.vela/skills`。每个 Skill 是一个目录，里面有带 `name` 和 `description` 的 `SKILL.md`：

```markdown
---
name: pdf-tools
description: 从 PDF 提取文字和表格。在阅读、转换或检查 PDF 时使用。
---

# PDF tools

先阅读本目录里的说明，再处理文件。
```

当前工作区的 `.pi/skills`、`.agents/skills`，以及 `~/.agents/skills`，也会一并加载。同名时项目中的 Skill 优先。

新对话只把每个 Skill 的名称、描述和文件路径放进提示；需要时 Agent 再读取全文。在输入框发送 `/skill:名称` 可以直接展开该 Skill。设置里的 Agent 页会列出当前已加载的 Skill。

## 执行与权限

Vela 当前支持在**本地工作区**或**Git worktree**中运行。默认的「每次询问」模式会在执行终端命令前请求批准；写入所选工作区以外的位置也会请求批准。工作区内的文件读写可直接进行。

「完全访问」模式会跳过这些逐项确认。这里的权限设置是交互式审批策略，不是操作系统级沙箱。远程和隔离沙箱执行环境尚未实现。

## 开发命令

```sh
pnpm dev         # 启动 Electron 开发环境
pnpm build       # 编译桌面端代码
pnpm typecheck   # 检查 TypeScript 类型
```

应用快捷键：`⌘B` 折叠左侧栏，`⌘J` 折叠右侧栏，`⌘,` 打开或关闭设置。Windows 和 Linux 使用 `Ctrl` 替代 `⌘`。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | Electron 主进程、preload 与 React 界面 |
| `packages/agent` | 会话运行时、模型目录、交互模式和上下文统计 |
| `packages/workspace` | 工作区、worktree、Git、Pull Request 与权限审批 |
| `packages/shared` | 主进程与界面共享的类型和 IPC 定义 |
| `packages/tools` | Agent 内置工具目录 |

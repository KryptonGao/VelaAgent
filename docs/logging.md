# 日志与诊断包

Vela 把主进程、Agent 运行时和渲染层的日志统一写入本机文件，并可一键导出 ZIP 诊断包用于问题反馈。

## 日志位置与格式

- 目录：`<home>/logs`。正式版 `home` 为 `~/.vela`，源码构建为 `~/.vela-dev`，设置 `VELA_USER_DATA` 时以它为准（见 `apps/desktop/src/main/vela-home.ts` 的 `configureVelaProfile`）。
- 文件：每天一个 `vela-YYYY-MM-DD.log`（本地日期），JSON Lines，每行一条 `LogEntry`：

  ```json
  {"ts":"2026-10-07T03:12:45.120Z","level":"error","scope":"scheduler","msg":"task record write failed","err":{"name":"Error","message":"…","stack":"…"},"proc":"main"}
  ```

  `scope` 标明来源模块（如 `runtime`、`project`、`crash`、`renderer:app`）；`proc` 为 `main` 或 `renderer`；`data` 为附加的结构化字段，`err` 为序列化后的错误（含 `code` 与最多三层 `cause`）。
- 轮转与清理（`apps/desktop/src/main/log-service.ts` 的 `FileLogSink`）：单个文件将超过 10 MB 时改名为 `vela-YYYY-MM-DD.N.log`；启动和轮转时删除 14 天前的文件，并在总量超过 100 MB 时从最旧的文件开始删除，当天文件始终保留。
- 写入：普通日志每 250 ms 或累计 50 条批量追加；`error` 立即落盘。退出、未捕获异常和进程崩溃时同步 flush。写入失败只向 stderr 报告一次，不影响应用。

## 级别

`debug` < `info` < `warn` < `error`，默认 `info`，低于所选级别的日志不会生成。

- 在 设置 → 日志与诊断 中切换，保存在 `<home>/logging-settings.json`，渲染层同步使用同一级别。
- 设置环境变量 `VELA_DEBUG` 时强制为 `debug`，设置页显示为锁定。原先只在 `VELA_DEBUG` 下打印的调试信息现在都是 `debug` 级日志。
- 源码构建或 `VELA_DEBUG` 下，日志同时输出到终端 / DevTools 控制台。

## 隐私与脱敏

所有日志在生成时经过 `packages/shared/src/redaction.ts` 的 `redactSensitive`：遮蔽 `Bearer` 令牌、URL 中的 `user:pass@` 与 `token`/`code`/`api_key` 等查询参数、JSON 中的敏感键，以及对象里键名含 password、secret、token、api key、credential、cookie、authorization 的字符串值。写入文件时把用户主目录替换为 `~`。

## 未捕获错误

- 主进程（`apps/desktop/src/main/log-host.ts` 的 `installCrashHandlers`）：`uncaughtException`（记录后仍弹出 Electron 默认错误框）、`unhandledRejection`、`render-process-gone`、`child-process-gone`、页面无响应 / 恢复，以及启动流程 `start()` 的失败。
- 渲染层（`apps/desktop/src/renderer/logger.ts`）：`window` 的 `error` 与 `unhandledrejection`；React 渲染崩溃由 `components/ErrorBoundary.tsx` 记录并显示可重试的错误界面。
- 渲染层日志经 IPC 转发到主进程写入；主进程校验字段、截断过长内容（消息 4 KB、数据 16 KB），每秒最多接收 50 条，超出部分在下一秒汇总为一条 `warn`。

## 导出诊断包

入口：设置 → 日志与诊断 →「导出诊断包…」，或菜单 帮助 →「导出诊断日志…」。选择保存位置后生成 `vela-diagnostics-YYYYMMDD-HHmmss.zip` 并在访达中显示。ZIP 内容（`apps/desktop/src/main/log-export.ts` 的 `buildDiagnosticsBundle`）：

| 文件 | 内容 |
| --- | --- |
| `logs/*.log` | 全部保留中的日志文件（导出前先 flush）。 |
| `system-info.json` | 应用版本、是否打包、语言；Electron / Node / Chrome 版本；系统类型、版本、架构；CPU 型号与核数；内存；运行时长。 |
| `git-operations.json` | `<home>/git-operations.json` 的 Git 操作记录，经脱敏。 |
| `settings-summary.json` | `vela-settings.json`、`memory-settings.json`、`scheduled-tasks.json`、`logging-settings.json`、`workspaces.json` 的脱敏内容，以及当前工作区的 MCP 服务器目录（与设置页看到的脱敏视图相同）。 |
| `trace/<会话 ID>.jsonl` | 仅在设置页勾选「包含当前会话 Trace」时加入，逐行脱敏。Trace 可能包含提示词、文件内容和工具输出，默认不包含；菜单导出始终不包含。 |
| `manifest.json` | 导出时间、是否含 Trace，以及每一项是否成功；缺失或读取失败的项记录原因，不影响其余内容。 |

`integrations-auth.enc.json` 等凭证文件、会话消息和记忆内容不会被导出。

## 在代码中记录日志

```ts
import { createLogger } from "@vela/shared"; // 渲染层从 "./logger" 导入

const log = createLogger("my-module");
log.info("workspace opened", { path });
log.error("save failed", error); // 传入 Error 时自动序列化到 err
log.child("sync").debug("retrying");
```

主进程在 `apps/desktop/src/main/index.ts` 最早期创建 `LogService` 并安装文件 sink；在此之前产生的日志会缓冲（最多 500 条）后补写。不要在应用代码中直接调用 `console.*`。

## 验证

```bash
pnpm --filter @vela/desktop test:logging
```

覆盖级别过滤、错误序列化、缓冲补写、脱敏、文件轮转与清理、级别持久化、诊断包内容与脱敏、缺失项记录、导出取消，以及渲染层日志的校验、截断与限流。

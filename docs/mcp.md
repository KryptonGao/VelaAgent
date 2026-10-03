# MCP 服务器

Vela 通过 Pi 1.0 的 MCP 扩展接入 Model Context Protocol 服务器，并在主进程侧实现配置、信任、只读授权和会话生命周期。协议、OAuth 与连接管理复用 Pi；Vela 负责桌面宿主适配。首版支持 stdio 与 Streamable HTTP，不包含 Codemode、旧 SSE、MCP Apps、提示词工作流和插件市场。

## 配置

- 全局配置为资料目录下的 `mcp.json`，默认 `~/.vela/mcp.json`；设置 `VELA_USER_DATA` 时使用该目录。
- 项目配置沿用 `<workspace>/.pi/mcp.json`，同名项目项覆盖全局项；删除项目项后恢复对应全局项。
- 文件格式为 Pi 的 `mcpServers`。服务器字段（`command`、`args`、`env`、`url`、`headers`、`oauth` 等）沿用 Pi 的校验规则。
- OAuth 凭据保存在 `~/.vela/mcp-auth.json`，日志写入 `~/.vela/mcp.log`，项目信任与只读授权保存在 `~/.vela/mcp-policy.json`。Vela 不读取或迁移本机 Pi 配置。
- 保存采用原子写入并保留未编辑的字段和顶层内容；无效服务器单独报告，其他有效服务器继续使用。

## 项目信任

项目配置在首次启用前，需要在设置页确认服务器、命令和地址。信任记录绑定工作区真实路径与项目文件内容，文件变化后需要重新确认。未信任时项目服务器不会启动；撤销信任会同时撤销该工作区的只读授权，重新信任不会恢复旧授权。

## 工具曝光

- `deferred`（默认）：工具不直接进入模型工具列表，通过 `tool_search` 发现后再调用。
- `direct`：工具始终可用。
- `hidden`：工具不提供给 Agent，执行前也会被拒绝。
- 未指定曝光，或配置了 Pi 的 `codemode` / `codemode-deferred` 的项按 `deferred` 处理；Vela 不启用 Codemode。
- 模式切换保留仍然获准的已发现工具；服务撤回、禁用或失去权限的工具立即不可执行。

## 权限与只读

- 用户可以在设置页把具体工具确认为只读；服务器的 `readOnlyHint` 只作为提示，不作为授权依据。
- 授权绑定工作区、服务器有效配置摘要和原始工具定义摘要；配置或工具定义变化后授权失效。
- Plan 和 explore 只提供明确授权的只读 MCP 工具，以及资源列表、资源模板列表和资源读取工具。其他 MCP 工具在发现时隐藏，并在执行前再次拒绝。
- Agent、Goal 和 general 中，已确认只读的工具自动放行；其他调用沿用「每次询问 / 帮我批准 / 完全访问」。审批展示服务器、工具和脱敏参数，停止任务时取消。
- 「帮我批准」的判定包含工具描述和参数；MCP 判定不复用跨调用的风险缓存，判断失败时请求审批。
- 非只读 MCP 调用使 Goal 验证失效，并计入 general 子代理的潜在改动记录。
- 工具调用失败不自动重试，避免重复外部操作。

## 会话与设置

- root、general、explore 会话各自持有独立的 MCP 扩展实例，OAuth 凭据共享；没有聊天会话时，设置页使用独立管理会话检查连接。
- 服务器在后台连接，单个服务器失败不会阻止聊天。
- 空闲会话在配置修改后立即重载；运行中的会话显示待应用，并在本轮结束后重载。禁用、删除、撤销信任或只读授权立即阻止后续调用，并取消相关在途操作。
- 设置页的 MCP 分区支持表单与 JSON 导入、配置来源与覆盖关系、连接状态、工具数量、工具详情和脱敏诊断；OAuth 使用系统浏览器，可以取消和重试。
- MCP 调用进入现有工具卡片、Trace、历史和计数，并显示服务器标识。

## 实现与验收

- Pi 适配补丁为 `patches/@earendil-works__pi-coding-agent@1.0.0.patch`，由 `pnpm-workspace.yaml` 的 `patchedDependencies` 绑定精确 `1.0.0`。补丁为 MCP 扩展增加 `agentDir` 参数，以及 controller 的状态快照、订阅、重连、登录、取消登录、退出登录、工具曝光刷新和关闭等结构化接口；升级 Pi 时需要重新验收。
- Vela 侧实现位于 `packages/agent` 的 `McpConfigService`、`McpSessionBridge`，以及 `apps/desktop` 的 `McpHost` 与 `McpSettingsSection`。
- 定向测试：
  - `pnpm --filter @vela/agent test:mcp`：配置、策略、补丁接口与真实运行时（stdio、HTTP、OAuth fixture、发现、资源读取、认证刷新、取消、意外断连与重连、请求超时、关闭）。
  - `pnpm --filter @vela/desktop test:mcp`：IPC 输入校验、设置模型与审批横幅。
  - `pnpm --filter @vela/desktop test:mcp:ui`：真实 Electron 渲染行为检查。
  - `pnpm --filter @vela/desktop test:mcp:electron`：生产入口的 Electron smoke；设置 `VELA_MCP_SMOKE_APP_ROOT` 指向 `app.asar` 可检查打包后的依赖。

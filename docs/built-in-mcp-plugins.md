# Built-in MCP Plugin System

设置 → Integrations（集成）显示内置应用。Notion 卡片提供 Connect、连接中 Cancel、连接后 Disconnect，以及可重试的错误状态。用户无需填写 URL、Token 或 JSON。连接为当前 Vela 配置目录中的全局个人连接；所有工作区、现有与未来的 Agent 会话使用同一账号。

## 架构与文件

内置插件是预配置的 MCP Server，没有专用 Tool Adapter。现有 `createMcpExtension` 继续负责 Streamable HTTP、initialize、tools/list、工具注册、资源和执行管线。

| 文件 | 职责 |
| --- | --- |
| `packages/shared/src/plugin.ts` | 不含凭证的插件配置、状态与 IPC 类型。 |
| `packages/agent/src/mcp/plugin-registry.ts` | `PluginRegistry`、Notion 声明、启用状态、与用户 MCP Server 的合并。 |
| `packages/agent/src/mcp/manager.ts` | `PluginMCPManager`：连接、取消、断开、重复点击合并与状态。 |
| `packages/agent/src/mcp/oauth.ts` | `OAuthMCPManager`：复用 Pi OAuth discovery / PKCE / DCR / localhost callback，统一登录与 refresh 锁。 |
| `packages/agent/src/mcp/credentials.ts` | `CredentialStore` abstraction、非桌面内存存储、共享凭证路由、刷新串行化与撤销保护。 |
| `packages/agent/src/mcp-config.ts` | 合并虚拟内置服务器，生成配置摘要及授权 digest，预留并保护 `builtin_` 命名空间。 |
| `packages/agent/src/mcp-session.ts` | 为现有 MCP 扩展注入共享凭证存储；安全脱敏仍由现有桥接层完成。 |
| `packages/agent/src/runtime.ts` | 通用插件生命周期入口与现有 MCP 会话 reload / suspend 的衔接。 |
| `packages/agent/src/index.ts`、`packages/shared/src/index.ts`、`packages/shared/src/mcp.ts` | 导出接口，MCP 服务器摘要附加 `pluginId`。 |
| `apps/desktop/src/main/plugin-credentials.ts` | Electron `safeStorage` 加密与带锁文件存储。 |
| `apps/desktop/src/main/index.ts`、`mcp-host.ts`、`apps/desktop/src/preload/index.ts` | 主进程注入安全存储、校验 IPC、桥接无凭证的方法和事件。 |
| `apps/desktop/src/renderer/components/IntegrationsSection.tsx` | 通用插件卡片及 disconnected / connecting / connected / error 状态。 |
| `SettingsView.tsx`、`settings-copy.ts`、`McpSettingsSection.tsx`、`apps/desktop/src/renderer/styles.css` | 集成导航、中英文界面与现有设置样式；用户 MCP 页面只显示用户条目。 |
| `packages/agent/test/plugin-system.test.ts` | OAuth/MCP 端到端与生命周期、权限、并发刷新测试。 |
| `apps/desktop/test/plugin-credentials.test.ts`、`mcp-host.test.ts`、`plugins-ui.mjs` | 安全存储、IPC、真实 Electron 交互与系统加密验证。 |
| 根目录、Agent 和桌面 `package.json` | 新增 `test:plugins`，桌面新增 `test:plugins:ui`。 |

## 数据结构

`BuiltInPlugin` 包含 `id`、`name`、`description`、`icon`、`mcpUrl`、`transport`、`authType`。可选 `oauth` 提供公开 client ID、scope、metadata URL、localhost callback 配置；不允许 client secret 出现在插件公开配置中。`toolPolicy` 预留审批策略与访问类别扩展结构，当前继续使用现有 MCP policy；该字段不会自动授予工具权限。

`PluginSnapshot` 追加 `serverName`、`status`、`toolCount` 和固定安全错误文字。`PluginCatalog` 包含当前工作区、插件摘要与 `pendingApply`。`PluginTarget` 只接收工作区、可选对话 ID 和插件 ID；Renderer 无权改变内置 endpoint 或传入凭证。`PluginStatusEvent` 只广播插件 ID、状态与安全错误文字。

`CredentialStore` 采用 Pi 的同步/异步带锁读改写契约。它与 Electron 无关，可替换为其他主进程存储实现。`PluginCredentialStore` 根据插件服务器身份路由到安全存储，所有会话共享同一实例。

## OAuth 与连接流程

1. 点击 Connect，IPC 校验调用方为桌面窗口主 frame，并校验工作区、对话归属和插件 ID；注册表只允许已声明插件。
2. 将插件 ID 写入 `integrations.json`，合并为 `builtin_<id>` MCP Server。用户 `mcp.json` 不被改写。闲置会话 reload；忙碌会话等待本轮结束。管理会话单独负责授权，因此连接操作无需等待模型生成。
3. 使用现有 Streamable HTTP transport 尝试 initialize。若服务要求授权，Pi 从 `WWW-Authenticate` 的 protected resource metadata 开始 discovery，再读取 authorization server metadata。
4. 有预配置公开 client ID 时复用；否则服务公布 registration endpoint 时执行 Dynamic Client Registration。OAuth 使用 authorization code、PKCE S256、随机 state 和 issuer 检查，回调监听 localhost loopback 地址。用户只在系统浏览器中登录及确认授权。
5. code exchange、client registration、access / refresh token 与 PKCE 状态仅在主进程存储。登录等待上限为五分钟，取消会中断请求并关闭回调监听。
6. 授权完成，现有 MCP connection 自动 reconnect，执行 initialize / tools/list，将工具注册为 `mcp__builtin_<id>__<tool>`。默认 `deferred` 曝光，Agent 使用现有 `tool_search` 找到并调用工具。
7. access token 临近过期或 HTTP 401 时，现有 OAuth provider 自动 refresh。连接内部合并 refresh；共享存储再提供跨会话队列及跨进程文件锁。读取旧 token、refresh 与写入轮换 token 在同一锁内，后续请求看到新 token 后不重复 refresh。显式登录可能使用 refresh grant，因此也共享该锁。
8. Disconnect 先取消正在进行的登录，将插件禁用以立即收回工具权限，再关闭所有会话连接、等待 refresh 结束并删除凭证。旧 store handle 无法在撤销后重新写回 token。

## 凭证与权限

桌面内置插件凭证写入 `<Vela home>/integrations-auth.enc.json`，文件只包含版本及加密 envelope。Electron `safeStorage` 使用系统安全存储支持的密钥；文件沿用 Pi 的原子写入与权限管理。系统加密不可用、Linux 退化为 `basic_text`、文件损坏或无法解密时失败，不退回明文。`integrations.json` 只保存启用的插件 ID。

手动配置 MCP Server 的现有凭证路径与格式保持兼容，不自动迁移其 `mcp-auth.json`。非桌面宿主不注入安全存储时，内置插件只在主进程内存保存凭证，进程退出后需要重新授权。

所有工具仍走 `McpSessionBridge` 的现有工具调用链、MCP 审批和 Plan/explore 只读过滤。服务端 `readOnlyHint` 仅是提示；只有与工作区、服务器 config digest 和原始工具 digest 绑定的明确授权才被当作只读。Notion 的名称和工具名不参与 Runtime 特殊分支。服务端回显的凭证也会在进入 Renderer 前脱敏。

## Notion 注册与第二个插件

`packages/agent/src/mcp/plugin-registry.ts` 的 `builtInPlugins` 声明 Notion：

```ts
{
  id: "notion",
  name: "Notion",
  description: "Search, read and edit your Notion workspace",
  icon: "notion",
  mcpUrl: "https://mcp.notion.com/mcp",
  transport: "streamable-http",
  authType: "oauth2",
  toolPolicy: { approval: "existing-mcp-policy", access: "read-write" },
}
```

Pi 内部把 Streamable HTTP 称为 `type: "http"`，注册表负责这个配置映射，未创建新的 transport。Endpoint 与 [Notion 官方连接文档](https://developers.notion.com/guides/mcp/get-started-with-mcp) 一致。

新增第二个 OAuth MCP 插件时，在同一数组追加配置：

```ts
{
  id: "second_service",
  name: "Second Service",
  description: "Search and manage your workspace",
  icon: "second_service",
  mcpUrl: "https://your-provider.example/mcp",
  transport: "streamable-http",
  authType: "oauth2",
  // 如果服务不支持 DCR，需由产品预配置已注册的公开 desktop client：
  // oauth: { clientId: "public-client-id", scope: "required scopes" },
}
```

注册表、OAuth、状态页和 Tool Registry 接入均自动复用；只需按实际服务增加图标映射和提供商测试。自定义宿主可以在 `AgentRuntimeOptions.builtInPlugins` 注入注册定义，并通过 `pluginCredentialStore` 注入安全后端。`id` 使用小写字母、数字和下划线，以字母开头。

## 验证与边界

`pnpm test:plugins` 包含本地完整 OAuth/MCP provider 测试、两会话轮换 refresh、过期自动 refresh、工具审批拒绝与允许、断开后调用拒绝、取消授权、安全存储和 Renderer 交互。UI smoke 在隔离 Electron profile 中验证真实系统加密，支持 `VELA_PLUGIN_UI_CAPTURE` 导出状态截图；图像需等待实际绘制完成。

本次还验证了现有 Agent/桌面 MCP 测试、受影响的会话与权限检查、类型检查、桌面 build 和 MCP Electron smoke。Notion metadata 的只读探测确认了 OAuth endpoints、DCR 和 PKCE S256；未用用户真实 Notion 账号完成授权或读写工作区内容。连接页面按现有设置风格实现，主 Agent 检查了明暗主题、中英文及 200% 缩放；遵照任务要求未运行子代理或独立视觉评审。

当前边界：

- 每个插件、每个 Vela 配置目录只支持一个全局账号，尚无多账号或项目级插件授权。
- 内置插件页面当前只管理连接；Plan/explore 所需的明确只读授权可使用现有 `setMcpToolReadOnly` API，尚未增加插件工具权限编辑 UI。
- Disconnect 撤销本地访问并删除本地凭证，没有调用提供商 token revocation endpoint；远端授权需在提供商后台撤销。
- 依赖提供商 OAuth metadata 与桌面 loopback redirect 支持；没有 DCR 的服务需产品预注册公开 OAuth client。要求 confidential secret 的提供商还需主进程 credential provisioning 或可信后端，不能把 secret 嵌入 Renderer。
- 当前只声明 Streamable HTTP 内置插件；其他传输或自定义协议回调需要扩展声明和宿主配置。
- 启用状态文件采用原子替换，但不提供多个独立 Vela 进程并发编辑启用状态的合并；refresh 与 token 写入已有跨进程锁。
- 已在生成工具调用之前开始执行的远端写操作无法由本地 Disconnect 回滚；本地取消会关闭传输并拒绝后续调用。
- 真实 Notion OAuth 及不同提供商的兼容性仍需账号级联调；本次没有创建 Notion OAuth client、登录用户账号或修改远端数据。

协议参考：[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)。

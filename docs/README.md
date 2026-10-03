# Vela 文档

本目录存放 Vela 的专题文档。文档以当前开发分支的源码与测试为准，可能描述尚未随版本发布的能力；已发布版本的产品行为以根目录 [README](../README.md) 和 [RELEASE_NOTES](../RELEASE_NOTES.md) 为准。

## 写作约定

- 正文用简体中文；文件名、类型名、函数名、工具名和命令保持英文原文。
- 行为描述必须能在源码或测试中定位。引用统一写成 `` `路径` 的 `符号名` ``，不写行号，避免代码变动后引用失效。
- 只描述已经实现的能力，不把计划中的功能写成现状。
- 文档之间、文档与根 README 之间使用相对链接。
- 与根 README 重复的内容只保留概览，细节放在本目录。

需求文档存放于 `requirements/`，必须明确标注实现状态，并将当前实现与目标行为分开；未实现的级别不作为已实现功能的使用说明。

## 文档索引

| 文档 | 受众 | 内容 |
| --- | --- | --- |
| [pi-1.0-migration.md](./pi-1.0-migration.md) | 开发者 | Pi 1.0 精确版本迁移、接口适配、依赖与打包检查、验证结果和未验证项。 |
| [mcp.md](./mcp.md) | 使用者与开发者 | MCP 服务器的配置、项目信任、工具曝光、只读授权、会话生命周期与定向验收。 |
| [built-in-mcp-plugins.md](./built-in-mcp-plugins.md) | 使用者与开发者 | Notion 内置插件、通用 OAuth、安全凭证、插件扩展与验证边界。 |
| [scheduled-tasks.md](./scheduled-tasks.md) | 使用者与开发者 | 定时任务的时间格式、执行与权限、错过与并发策略、存储与恢复、实现与验证。 |
| [requirements/version-control.md](./requirements/version-control.md) | 产品与开发者 | 版本控制需求：Git/GH CLI 分工、Commit 与同步、提交关系图、PR、AI 文案辅助及验收标准；P0–P2 已实现，P3 尚未实现。 |
| [plan-mode.md](./plan-mode.md) | 使用者 | Plan 模式的工作方式：规划流程、Plan Document、revision、批准与执行、只读限制和常见问题。 |
| [plan-mode-architecture.md](./plan-mode-architecture.md) | 开发者 | Plan 模式的实现：数据模型、流式解析、运行时编排、持久化与迁移、界面状态和测试。 |
| [motion-audit.md](./motion-audit.md) | 开发者 | 桌面端动效盘点：现有基建、各区域缺口、总优先级表、统一动效规范与落地批次。 |
| [motion-audit.md](./motion-audit.md) | 开发者 | 界面动效现状盘点与补全建议：已有基建、按区域缺口清单、统一参数规范与落地批次。 |

## 新增文档

新建专题文档时沿用上面的写作约定，并在索引表补一行。

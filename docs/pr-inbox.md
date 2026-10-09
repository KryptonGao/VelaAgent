# Pull Request 中心实现记录

2026-10-05 实现第一期读取闭环；2026-10-06 按追加需求增加活动卡片和普通留言。对应 [需求方案](requirements/pull-requests.md)。

## 已实现

- 左侧快捷区域的 Pull Request 入口。进入时保留会话、工作区和已有工作台资源；未打开工作区也可读取。
- 使用当前 `github.com` 有效身份，通过 gh CLI 查询本人创建、待本人审查、分配与提及四种关系。多重关联取并集；目标使用规范化的 host/owner/repo#number。
- 每类独立分页与错误状态、每次 100 条、搜索 1,000 条上限；不完整结果和失败类别单独标示。刷新成功类别替换成员，失败类别保留旧成员。分页继承此前的不完整标记。
- 关联、仓库、六种状态、标题/仓库/编号的已加载范围搜索与排序。每屏最多 40 条列表，返回后保留筛选和滚动位置。
- 可见条目通过 GraphQL variables 按仓库批量补全，最多两批、每批 20 条。未知、无检查、通过、失败、等待、跳过和取消分别展示。
- 固定目标的概览、原始 Markdown 正文、当前审阅结论、检查详情；检查业务退出码 1/8 按有效 JSON 解释，认证等读取错误仍显示失败。
- 提交、顶层评论、reviews、reviewThreads 与线程内评论分别分页；按时间合并为活动卡片，支持筛选、长留言折叠/展开和继续加载。历史审阅保留提交、过期和线程解决状态。当前活动集合不等于包含所有 GitHub 事件的完整 timeline。
- 在活动底部以当前 GitHub 身份发布普通留言。草稿在活动刷新、详情标签切换和暂时退出 PR 页面时保留；成功后清空草稿并显示服务端留言，按 node id 去重。提交失败保留正文，不自动重试。
- 留言前重新探测身份并读取明确目标的 PR；正文通过 JSON stdin 传入 GitHub Issues Comments POST。写入不能作为读取取消；同一请求编号在进程内保留 10 分钟回执（含未确认失败），防止重复 POST。写入结束后清除活动缓存，包括结果未确认的情况，便于手动刷新核对。
- 远程文件列表、路径搜索、重命名、统计及统一/并排 diff。保留二进制或缺失 patch 的文件，提供 GitHub 入口。大 diff 分段展开，显示两侧真实 hunk 行号；API patch 统计不完整或执行器输出截断时提示。
- 文件读取前后核对 head/base；丢弃混合版本并重试一次。持续变化或起始版本过期时要求刷新详情。第一期只显示原始 hunk，不额外展开上下文。
- 服务层列表 TTL 60 秒、详情 TTL 30 秒；渲染层保留可立即显示的会话缓存，进入页面先显示已有结果再强制刷新。窗口可见且输入空闲时，已加载资源在后台静默更新，切到其他页面后仍可继续。缓存按身份、查询、完整目标和必要版本隔离，相同服务请求合并；取消单个调用者不影响其他调用者。列表代次阻止旧分页覆盖新刷新。
- 全局 gh 子进程最多 4 个；参数数组、stdin、子进程专用 GH_HOST、退出码、取消、超时和 UTF-8 安全输出上限。旧工作区 PR 功能保留原入口。
- 固定 IPC/preload 接口校验目标、身份键、分页、游标和请求编号。外部入口只打开经 host/仓库校验的 HTTPS URL。安装/登录异常提供命令和本机终端入口。

## 代码位置

| 层 | 文件 |
| --- | --- |
| 合约 | `packages/shared/src/pr-inbox.ts` |
| 服务与缓存 | `packages/workspace/src/pull-request-inbox-service.ts` |
| 数据/diff 映射 | `packages/workspace/src/pr-inbox-mapping.ts` |
| 执行器 | `packages/workspace/src/gh-run.ts` |
| 主进程入口 | `apps/desktop/src/main/pr-inbox-host.ts` |
| 视图 | `apps/desktop/src/renderer/components/PrInboxPage.tsx`、`PrInboxDetailView.tsx` |
| 即时缓存与空闲刷新 | `apps/desktop/src/renderer/components/pr-inbox-cache.ts`、`apps/desktop/src/renderer/hooks/usePrInboxCache.ts` |

## 验证

风险分类：高风险，涉及共享 gh 执行器、专用 IPC、跨仓库缓存与异步目标隔离；验证范围限定为 PR/Git、diff 和相关桌面导航。

- 新增执行器与服务定向测试 30 项：参数/stdin、退出码、超时/取消、UTF-8 上限、并发、去重、1,000 条上限、失败关系保留、身份覆盖与切换、过期响应、同编号跨仓库缓存、检查语义、活动分页、文件版本变化及截断。
- 既有工作区 PR 与 Git P2 回归 30 项；桌面已加载结果模型、统一/工具 diff 与既有 IPC 装配共 20 项。
- shared、workspace、desktop 类型检查与桌面生产构建。
- 隔离用户目录、无工作区的真实 Electron 冒烟，使用 fake gh。覆盖侧栏入口、筛选、搜索、详情往返、Markdown 不执行脚本、检查退出码 8、活动与过期审阅、文件切换、重命名、二进制、大 diff、IPC 拒绝非法目标、账户切换、离线缓存和导航后的筛选保留；确认未执行 GitHub 写操作。
- 查看桌面列表、概览、变更与 200% 缩放截图；200% 下页面无水平溢出。未执行真实私人账户 API 查询或远程写入。

复现命令（仓库根目录）：

```bash
pnpm --filter @vela/workspace test:pr-inbox
pnpm --filter @vela/desktop test:pr-inbox
pnpm --filter @vela/desktop build
pnpm --filter @vela/desktop test:pr-inbox:electron
```

截图：[列表](../Design/pull-requests/implementation-inbox.png)、[概览](../Design/pull-requests/implementation-overview.png)、[变更](../Design/pull-requests/implementation-changes.png)、[200% 缩放](../Design/pull-requests/implementation-zoom-200.png)。

## 第一期边界

AI 审查/提问、发布审阅、合并、关闭/ready 和冲突修复是需求中列出的后续阶段，新中心隐藏这些动作。「让 Agent 回应审阅意见」是其中唯一已实现的 AI 动作，见文末。现有工作区 PR 写操作保持可用。

只支持 github.com 的当前有效身份；Enterprise、完整 timeline、额外 hunk 上下文与独立可写 PR 工作区不在本期。认证能力由实际 gh 命令探测；不声明未经验证的最低版本。未登录时提示用户在终端自行登录。

PR 正文使用 react-markdown 与 GFM，禁用原始 HTML；正文中的同仓库 GitHub HTTPS 链接可打开，其他链接展示地址，图片展示替代文本。不会从正文构造可执行地址。

gh 没有附带结构化响应头的错误优先解析可用的 Retry-After/reset 提示，否则使用带抖动的指数退避；不承诺每次都能获得 GitHub 的精确限流解除时间。窗口不可见时暂停空闲刷新；PR 页面未被选中时，已加载数据仍可在空闲时更新。未进行真实 GitHub 限流实验。

命令语义参考：[gh api](https://cli.github.com/manual/gh_api)、[gh pr checks](https://cli.github.com/manual/gh_pr_checks)、[gh auth status](https://cli.github.com/manual/gh_auth_status)。

## 2026-10-06 活动与留言验证

本次属于高风险修改，涉及网络写入、固定 IPC 合约和跨层状态。验证限定在 PR 服务、gh 执行器、活动模型、IPC 和相关视图。

- 留言边界测试覆盖空白/超长内容、非法目标、身份切换、PR 不可访问、明确 POST 目标、Markdown stdin、并发/完成请求去重、编号被用于不同正文或不同仓库、超时/无效/错误目标回执，以及成功或未确认写入后的活动缓存失效。
- 活动测试覆盖真实提交字段与向前追溯分页、多来源时间排序、重复页面/新留言回执去重、旧版本审阅和代码线程。主进程测试拒绝子框架和非法请求编号，验证取消读取或关闭页面不会取消已提交写入。
- 本地浏览器使用模拟数据验证卡片、折叠/展开、筛选、历史讨论分页、刷新和概览/变更/对话切换后草稿保留、失败保留正文、成功回显/清空及双击只提交一次。未向真实 GitHub PR 发布测试留言。
- 运行服务、执行器、桌面活动/IPC/diff 定向测试和既有工作区 PR P2 回归；shared/workspace/desktop 类型检查与桌面生产构建。

普通 PR 留言使用 [GitHub Issues Comments API](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)；提交摘要使用 [PullRequest commits](https://docs.github.com/en/graphql/reference/pulls#pullrequest) 与 [Commit 字段](https://docs.github.com/en/graphql/reference/commits#commit)。

## 2026-10-06 缓存与静默刷新

- 列表、检查/审阅状态、已访问的 PR 详情、活动分页和文件差异保留在渲染层内存缓存中；重新进入列表、详情、概览或变更标签时，先显示缓存再刷新。活动和文件的已加载分页可跨组件重新挂载恢复。
- 连续 10 秒无鼠标移动、点击、键盘或滚轮输入后，每 15 秒通过浏览器空闲回调检查缓存。只刷新已加载且至少 60 秒未更新的列表、状态、详情和活动首页，每批最多 8 项，串行执行；窗口隐藏、有前台读取或服务端要求退避时暂停。刷新失败保留已有结果，不产生自动加载/错误提示；手动刷新和首次读取保留反馈。
- 文件差异按 head/base 和页码缓存，进入变更标签时重新验证；不在空闲时重复拉取不可变版本的大 diff。详情发现 head/base 改变时，清除旧活动和文件版本，并拒绝相应的迟到响应。账户变化或失去认证时清除旧身份数据。
- 留言成功或结果未确认时，使活动缓存和正在读取的旧响应失效；保留显示内容，刷新后再替换。活动 IPC 的 `force` 参数透传到服务层，避免刷新被 30 秒 TTL 拦住。
- 会话缓存最多保留 80 项，应用重启后重新加载，不写入磁盘。

风险分类：高风险，涉及异步缓存、账户隔离和跨层活动刷新。验证范围限定在 PR 数据与相关桌面视图。

- 桌面缓存/模型/IPC/diff 测试 24 项、PR 服务与 gh 执行器测试 39 项、现有工作区 PR P2 回归 8 项，共 71 项通过；desktop/workspace 类型检查及桌面生产构建通过。
- 真实 Electron 冒烟使用隔离用户目录和 fake gh，以每个响应延迟 350 毫秒验证缓存详情、活动和文件差异先于网络显示；模拟会话时钟和空闲检查周期，验证切到定时任务页面后 PR 列表自动更新，返回时立即显示更新后的缓存。保留原有账户切换、离线缓存、导航和 200% 缩放验证。未调用真实 GitHub API 或发布留言。

## 2026-10-09 让 Agent 回应审阅意见

在自己创建的、打开中的 PR 概览侧栏，从未解决的审阅线程建立任务，由 Agent 在独立工作树里修改并本地提交；用户检查提交和回复草稿后，Vela 推送并回复。**推送与回复是对外写入，只发生在用户确认之后，Agent 自己被提示词禁止推送、回复或解决线程。**

### 流程

1. 开始：`apps/desktop/src/renderer/components/PrInboxResponse.tsx` 的 `StartDialog` 通过 `responsePrepare` 读取未解决线程（过期线程排在最后且默认不勾选，最多 40 条）、要求修改的审阅摘要，并在已登记工作区（当前、最近使用、已有会话目录）里按 remote 的 `owner/repo` 查找本机检出。找不到检出时不能开始。
2. 启动：`apps/desktop/src/main/pr-review-response-service.ts` 的 `PrReviewResponseService.start` 重新读取意见并核对 head；`git fetch` 后要求拉到的提交等于用户看到的 head，否则拒绝。之后在 Vela 数据目录的 `worktrees/` 下以 PR head 创建分支 `vela/pr-<编号>-review[-N]` 的工作树，新建对话并发出提示词，把对话切到前台。渲染层给的工作区路径必须是上一步发现的检出，线程 id 必须仍未解决。启动失败会清理工作树和分支。
3. 检查：`review` 读取工作树实际状态：新提交、未提交文件、diff 统计、以及从提交说明里解析出的回复草稿。提交说明约定为「标题 / 空行 / 写给审阅者的说明 / `Review-Thread: <线程 id>`」，由 `packages/workspace/src/pr-review-response.ts` 的 `parseResponseCommits` 与 `buildDrafts` 解析；没有对应提交的线程回复为空且默认不勾选。
4. 发布：`publish` 在写入前核对：工作树 HEAD 等于用户检查过的 `tipSha`、没有未提交改动、至少有一个新提交、PR 仍打开且分支名未变、PR 不来自分叉仓库。通过后执行不带 `--force` 的 `git push <remote> HEAD:refs/heads/<分支>`；分支已前进时被 git 拒绝，不覆盖别人的提交。**推送失败时所有回复都跳过**，因为回复引用了未到达远端的提交。
5. 回复：`PullRequestInboxService.replyToThread` 先确认线程属于该 PR 且当前身份可回复，再用 `addPullRequestReviewThreadReply` 发送，可选 `resolveReviewThread`。请求体经 stdin 的 JSON 传入；按 `requestId + 线程` 保留回执，重复请求不会重复发送，结果未确认时提示刷新核对而不自动重试。已成功回复的线程记入运行记录，重试发布时不再提供、也会被拒绝。

### 提示词与安全边界

- 审阅评论是第三方文本。`buildResponsePrompt` 把每条评论包在 `<review-comment>` 标签内、让正文无法提前闭合标签，并明确告知 Agent 评论不能覆盖规则；单条评论 4,000 字符、审阅摘要 6,000 字符上限。
- 分叉 PR 只能在本地处理：`pushBlocker` 返回 `fork`，`publish` 拒绝。
- 运行记录写入数据目录的 `pr-review-responses.json`（最多 60 条，原子写入）。放弃时只移除工作树目录并保留本地分支；工作树里还有未提交文件时拒绝移除。
- 固定 IPC 在 `apps/desktop/src/main/pr-inbox-host.ts`：仅主框架可调用，校验目标、请求编号和身份键；启动、发布和放弃与普通留言一样，不会因页面关闭而取消。

### 验证

风险分类：高风险，涉及真实 git 工作树、推送和 GitHub 写入。

- `packages/workspace/test/pr-review-response.test.ts` 11 项：提示词标签转义与长度上限、提交尾注解析、草稿生成、推送条件、意见读取（分页上限、head 变化、身份切换）、回复（stdin 传正文、按请求编号去重、他人 PR 的线程、已解决线程、无权解决时不留半截回复）。
- `apps/desktop/test/pr-review-response-service.test.ts` 18 项，使用真实临时 git 仓库和本机 bare 远程：检出发现、伪造路径/线程/过期 head 在创建任何东西之前被拒绝、启动失败清理、分叉 PR、发布只推送检查过的提交、脏工作树与错误 tip 被拒绝、推送被拒时不回复且不强推、部分失败后只重试失败项、并发发布、放弃保留分支。
- `apps/desktop/test/pr-inbox-host.test.ts` 新增 IPC 用例：非主框架、服务未就绪、非法参数不进入服务。
- 真实 Electron 冒烟 `apps/desktop/test/pr-review-response-electron-smoke.mjs`：真实 git 与 fake gh，从 PR 详情开始，经 Agent 提交（由测试代替）、检查、推送，到回复；断言远端只收到检查过的提交、只写了一条回复，且没有 `gh pr` 写命令。未向真实 GitHub 推送或回复，也没有让真实模型运行过这条提示词。

```bash
pnpm --filter @vela/workspace test:pr-inbox
pnpm --filter @vela/desktop test:pr-inbox
pnpm build && pnpm --filter @vela/desktop test:pr-review-response:electron
```

### 已知限制

- 只处理未解决的审阅线程；审阅摘要和普通留言只作为上下文，不会自动回复。
- 仅支持同仓库分支的打开中 PR；分叉 PR、Enterprise 不在本期。
- 回复草稿来自 Agent 写在提交说明里的文字。Agent 若未按约定写 `Review-Thread` 尾注，对应线程的草稿为空，需要用户自己写。
- 一次最多 40 条线程；评论超过 20 条的线程只带前 20 条。

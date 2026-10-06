# Pull Request 中心：GH CLI 实现方案

状态：第一期读取闭环已实现；AI 与远程写入动作留待后续阶段。2026-10-05 更新。

实现与验证记录：[Pull Request 中心实现记录](../pr-inbox.md)。下文“当前实现”与“待实现”描述保留方案编写时的基线；实际交付范围以实现记录为准。

设计参考：[HTML 设计稿](../../Design/pull-requests-preview.html)、[设计与验证记录](../../Design/pull-requests/README.md)。现有工作区 PR 能力见 [版本控制需求](./version-control.md)。

## 1. 目标与技术约束

在 Vela 左侧栏增加 `Pull Request` 入口，集中查看当前 GitHub 身份关联的跨仓库 PR。用户无需切换项目、检出分支或克隆仓库，就能查看说明、检查结果和远程代码变更。

GitHub 数据与远程操作全部经过已安装的 `gh` CLI。常规能力使用 `gh search prs`、`gh pr view`、`gh pr diff` 等命令；需要分页、响应元信息或审阅线程时使用 `gh api`。这里的“只用 gh CLI”包含 `gh api`：API 请求和认证仍由 gh 执行，Vela 不直接使用 HTTP 客户端、GitHub SDK、独立 OAuth 或自行保存 Token。

本地修改、测试与提交继续使用已有 Git / 工作区能力。“只用 gh”约束 GitHub 访问方式，不要求用 gh 替代本地 Git。第一期支持 `github.com` 当前有效身份；数据模型保留 host，Enterprise 的完整支持属于后续范围。

## 2. 当前实现与需要新增的能力

| 能力 | 当前情况 | 本方案要求 |
| --- | --- | --- |
| gh 执行 | `packages/workspace/src/gh-run.ts` 的 `runGh` 使用参数数组、关闭交互并支持超时与 stdin | 复用执行路径，补充退出码、取消、输出上限与可选子进程环境参数 |
| 桌面 PATH | `apps/desktop/src/main/shell-path.ts` 的 `ensureLoginShellPath` 补齐 macOS 登录 shell PATH | 沿用现有启动流程，避免桌面启动后找不到 gh |
| 当前分支 PR | `packages/workspace/src/pull-request-service.ts` 的 `getForCurrentBranch` / `getDetail` 基于当前工作区和分支查询 | 保留；新增不依赖工作区的跨仓库查询入口 |
| 检查与审阅 | `PullRequestService` 已有检查解析、审阅线程、评论、审阅与线程解决能力 | 提取可复用映射；新入口接受显式 PR 目标 |
| 合并 | `PullRequestService.getMergePreview` / `merge` 已核对 head 与合并条件 | 后续复用规则，不能把当前工作区操作直接用于其他仓库 |
| 侧栏、全局列表与远程 diff | 目前只有独立 HTML 设计稿 | 新增正式视图、全局服务、IPC 与缓存 |

现有 `PullRequestService` 通过 `getSnapshot` / `cwdProvider` 获取目标；部分方法只接收 PR 编号，内部仍从当前工作区确定仓库。新中心的操作必须固定 `host + owner + repo + number`。不同仓库的相同编号、当前项目切换和异步请求返回都不能改变目标。

现有 `getDetail()` 不能直接承担“任意 PR 详情”。本方案建议增加独立的 `PullRequestInboxService`，共用 gh 执行器和数据映射；涉及远程写入时，将现有逻辑重构为接受显式目标的内部方法，同时保留当前工作区入口。

## 3. “与我关联”的范围

| 关系 | 查询条件 | 产品含义 |
| --- | --- | --- |
| 我创建的 | `author:<LOGIN>` | GitHub 搜索返回的本人创建 PR |
| 待我审查 | `review-requested:<LOGIN>` | 当前仍请求本人审查，包括 GitHub 搜索匹配的团队审查请求 |
| 分配给我 | `assignee:<LOGIN>` | PR 的 assignee 包含本人 |
| 提及我 | `mentions:<LOGIN>` | PR 或讨论内容中提及本人；不等于未读通知 |
| 全部关联 | 四个查询结果的并集 | 去重后的 PR 集合 |

同一 PR 可以同时具有多个关系。列表只显示一次，`relations` 保留全部关系；每个关系筛选均能找到它。关系数量可以重叠，“全部关联”的数量不能由四个分类相加得到。

`involves` 包含作者、分配、提及和评论参与者，与上述四类不完全一致，不能代替四类并集。`review-requested` 也不等于 `reviewed-by`；完成审阅后，待审查关系可能消失。如果用户只通过这个关系关联该 PR，它可以从默认列表消失，但当前打开的详情保持可读，并说明关联已变化。[GitHub 搜索语义](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)

团队审查结果首期使用统一的“待我审查”标签。只有拿到明确的团队请求与成员信息后才显示“通过某团队请求”，不凭仓库组织名推断。已经审阅、仅发表评论、关注仓库和 Vela 会话附件不自动纳入四类；如需扩展，应增加独立关系。

默认显示打开 PR，包含草稿；状态筛选支持仅打开、仅草稿、已合并、已关闭和全部。GitHub 的 closed 查询包含已关闭与已合并，必须使用合并限定条件或详情中的 `mergedAt` 区分。

| 状态筛选 | 追加的搜索条件 |
| --- | --- |
| 打开与草稿 | `is:open` |
| 仅打开 | `is:open draft:false` |
| 仅草稿 | `is:open draft:true` |
| 已合并 | `is:merged` |
| 已关闭 | `is:closed is:unmerged` |
| 全部状态 | 不追加状态条件 |

## 4. 身份探测与命令执行

主进程先检查 gh 可执行文件及版本，再探测当前身份：

```bash
gh --version
gh auth status --hostname github.com --active --json hosts
gh api --hostname github.com user
```

`gh api user` 的响应用于确定实际生效的 login；环境中的 `GH_TOKEN` 等变量可能覆盖 gh 已保存账户。不能只读取 git author，或把界面名称当成 GitHub login。

`gh auth status --json` 在某些认证失败情况下仍返回零退出码，必须解析认证状态；最终以实际读取请求能否成功为准。只保存 login、host 和状态，不读取或记录 Token，不使用 `--show-token`。[gh auth status](https://cli.github.com/manual/gh_auth_status)

主进程执行规则：

- 使用 `spawn('gh', args, options)`，`shell: false`；正文和 GraphQL JSON 请求体通过 stdin 传递。
- 沿用 `GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`，禁用分页器并要求结构化 JSON；diff 显式 `--color never`。
- `gh api` 显式传入 `--hostname`；`gh pr` 显式传入 `--repo [HOST/]OWNER/REPO`。搜索命令的 host 通过子进程 `GH_HOST` 固定，不修改全局环境。首期固定 github.com。
- 全局读取传入 `cwd: null`，不从当前目录推导仓库；需要本地工作区的操作另行绑定路径。
- 执行器返回 exitCode、stdout、stderr、timeout、cancelled、spawnError、outputTruncated；当前 `GhResult` 尚未包含全部字段，属于待实现扩展。
- Renderer 通过固定 IPC 操作传入结构化参数，不能提交任意 gh 参数或 Shell 字符串。主进程校验目标、状态、分页参数及查询长度。
- 用户自行安装 / 登录 gh；界面提供命令说明和打开终端入口，不在隐藏进程里发起交互式登录或自动切换账户。

每轮刷新固定身份与 generation。账户变化后隔离缓存并使旧请求失效；跨账户结果不能混合。每次手动刷新重新确认有效身份，前台定时刷新按缓存周期复查；远程写入前再次核对身份与目标。

## 5. 列表查询、分页与数据补全

### 5.1 查询方式

四类关联可以直接用常规命令查询。下列命令中的 `<LOGIN>` 为身份探测结果，`--json` 字段均来自本机 gh 2.96.0 的帮助信息：

```bash
gh search prs --author '<LOGIN>' --state open --sort updated --order desc --limit 100 --json number,title,url,state,isDraft,author,repository,updatedAt
gh search prs --review-requested '<LOGIN>' --state open --sort updated --order desc --limit 100 --json number,title,url,state,isDraft,author,repository,updatedAt
gh search prs --assignee '<LOGIN>' --state open --sort updated --order desc --limit 100 --json number,title,url,state,isDraft,author,repository,updatedAt
gh search prs --mentions '<LOGIN>' --state open --sort updated --order desc --limit 100 --json number,title,url,state,isDraft,author,repository,updatedAt
```

`gh search prs` 的 JSON 不包含完整检查结果、合并能力或当前 head。不要向它传入 `statusCheckRollup`、`mergeable` 等仅在其他命令里支持的字段。查询限定词作为独立 argv 传入，避免把整个多词查询当成单个搜索关键词。[gh search prs](https://cli.github.com/manual/gh_search_prs)

正式列表需要明确分页和完整性，建议使用以下 `gh api` 形式作为主要读取路径；四类只替换 `q` 中的关系条件：

```bash
gh api --hostname github.com --method GET search/issues \
  -f 'q=is:pr is:open author:<LOGIN>' \
  -f sort=updated -f order=desc -F per_page=100 -F page=1
```

这里必须显式 GET；`gh api` 添加字段参数时默认方法可能改变。响应中的 `items`、`total_count`、`incomplete_results` 和当前页一起进入分页状态。REST 结果字段与 `gh search prs` 的 JSON 格式不同，应使用不同适配器：例如 REST 使用 `html_url` / `user`，不能直接按搜索 CLI 的 `url` / `author` 解析。[gh api](https://cli.github.com/manual/gh_api)

### 5.2 分页和计数

每类保存独立的 page、hasMore、loadedCount、reportedTotal 和 complete。首轮并发执行四类的第一页，合并去重后显示；“加载更多”推进各类尚未完成的分页，最终按更新时间和稳定 key 排序。允许某类失败，其余成功结果仍显示，但必须标记“部分结果读取失败”。

GitHub 搜索有单次查询最多 1,000 条结果及不完整响应的限制。超过范围时提示缩小仓库或时间区间，不无限递增 page。不能把达到 `--limit` 的数组长度当成真实总数，也不能把去重后的当前页并集称为所有关联 PR。[搜索限制](https://docs.github.com/en/rest/search/search#about-search)

首期计数采用“已加载数量”：未完成时显示 `100+` 或“已加载 100 条”，关系标签也使用相同口径；只有四类查询完整且没有失败时，才能显示确定的并集总数。仓库选择器默认列出已加载结果中的仓库，并标明这个范围；指定仓库时向四类服务端查询追加相同 `repo:owner/repo` 条件，重新开始分页。

页面搜索沿设计稿支持标题、仓库和 PR 编号：首期过滤已加载集合，搜索框旁显示“搜索已加载 PR”。不把本地未匹配结果描述为整个 GitHub 无结果。“全部状态”与合并状态也必须重新查询，不能只过滤尚未加载的历史记录。

### 5.3 检查、审阅和合并状态补全

基础列表先出现标题、仓库、关系、状态与更新时间；检查和审阅状态可显示“正在读取”。对当前可见条目批量补全 head SHA、`reviewDecision`、`mergeable`、`mergeStateStatus`、检查汇总。

补全通过 `gh api graphql --input -`，在主进程生成请求体。按仓库分组，使用 `repository(owner, name)` 下的多个 `pullRequest(number)` 别名；仓库名和编号走 GraphQL variables，别名由内部序号生成。每批建议 20 条、并发最多 2 批，不为整个列表的每一条启动独立 `gh pr view`。

状态补全独立于关系分页。补全失败时保留基础列表，将具体状态显示为“未知 / 读取失败”；不要把没有拿到的检查数据显示成“全部通过”。“需要关注”可以在补全后更新，避免刚看到的条目因多次响应持续跳动；只在一批完成或刷新完成时统一重排。

## 6. 建议数据模型

以下为待实现的结构，不代表现有 shared 类型：

```ts
type PrRelation = 'authored' | 'reviewRequested' | 'assigned' | 'mentioned';

interface PrTarget {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

interface PrInboxItem {
  key: string; // host/owner/repo#number；比较时规范化大小写
  target: PrTarget;
  url: string;
  title: string;
  author: { login: string; avatarUrl: string | null } | null;
  state: 'open' | 'draft' | 'merged' | 'closed';
  relations: PrRelation[];
  updatedAt: string;
  headSha: string | null;
  enrichment: 'idle' | 'loading' | 'ready' | 'error';
  attentionReasons: Array<'reviewRequested' | 'conflict' | 'checksFailed' | 'changesRequested'>;
}

interface PrRelationPage {
  relation: PrRelation;
  nextPage: number | null;
  loadedCount: number;
  reportedTotal: number | null;
  complete: boolean;
  incompleteResults: boolean;
  error: string | null;
}
```

详情和文件数据另按 `PrTarget` 组织；复用现有检查 / 审阅类型时保留 unknown、过期和权限限制。缓存 key 包含有效身份、host、PR 目标、查询条件及必要的 head/base 版本信息，不能只用 PR number。

## 7. PR 详情与概览

选择条目后固定目标，使用：

```bash
gh pr view '<NUMBER>' --repo 'github.com/<OWNER>/<REPO>' --json number,title,url,state,isDraft,author,body,createdAt,updatedAt,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,additions,deletions,changedFiles,mergeable,mergeStateStatus,reviewDecision,reviewRequests,statusCheckRollup
gh pr checks '<NUMBER>' --repo 'github.com/<OWNER>/<REPO>' --json name,state,bucket,link,description,workflow,startedAt,completedAt
```

详情主体使用原始 Markdown。Summary / Test plan 是 PR 正文中的内容，不要求每个仓库遵守模板，也不自动编写测试通过声明。正文缺失时显示“没有描述”。用户内容按项目现有 Markdown 策略渲染，不能执行内嵌脚本。

状态映射优先顺序为 merged、closed、draft、open；`isDraft=true` 不能覆盖已经合并 / 关闭的状态。合并未知、规则阻塞、检查失败、运行中、无检查、跳过和取消分别展示。

`gh pr checks` 的非零退出码可能表示检查未通过或仍在等待；官方另有 pending 退出码 8。先判断是否拿到合法的检查 JSON，再解释业务状态。无效 JSON、认证错误、超时和取消仍作为读取失败，不能一概忽略退出码。没有检查不是通过。[gh pr checks](https://cli.github.com/manual/gh_pr_checks)

审阅线程通过 `gh api graphql` 获取，沿用现有线程映射。顶层评论、reviews、reviewThreads 及线程内 comments 分开分页；一次 `first:100` 不代表完整活动。首期只提供分页的近期活动，不承诺完整 GitHub timeline。审阅结论使用当前 `reviewDecision`，历史批准同时显示对应提交；新 head 不能继续使用旧 head 的审阅缓存。

## 8. 变更视图与文件列表

```bash
gh pr diff '<NUMBER>' --repo 'github.com/<OWNER>/<REPO>' --color never
gh api --hostname github.com --method GET \
  'repos/<OWNER>/<REPO>/pulls/<NUMBER>/files?per_page=100&page=1'
```

默认使用 PR 的合并比较 diff，不使用工作区未提交变化，也不以 `--patch` 返回的各提交 patch 代替最终比较。文件 API 提供 filename、previous_filename、status、additions、deletions 和可选 patch；用于文件树与逐文件加载。[gh pr diff](https://cli.github.com/manual/gh_pr_diff)

文件分页逐页读取，最多受 GitHub 文件 API 的 3,000 文件上限约束；文件数与 `changedFiles` 不一致、超出上限或读取失败时，界面显示当前范围及限制。二进制、超大文件或缺少 patch 时保留文件与统计，显示“此文件没有可用的文本差异”，提供 GitHub 查看入口。[PR 文件 API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)

统一 diff 解析器必须处理多 hunk、新增 / 删除、重命名、带空格或转义的路径、无末尾换行与二进制标记。文件树以文件 API 的完整路径为准；无法可靠配对的 diff 不应挂到错误文件。原始 diff 不完整或执行器达到输出上限时必须标记截断，不能无提示丢弃后半部分。

需要展示 hunk 外的代码上下文时，通过 `gh api repos/<OWNER>/<REPO>/contents/<PATH>?ref=<SHA>` 读取；路径分段编码。新增侧固定 head SHA，旧侧固定比较范围的 merge-base SHA，不能直接用目标分支 tip 作为 PR diff 的旧侧。merge-base 可以通过 gh 调用 compare API 取得 `merge_base_commit.sha`，读取前核对 head/base 版本；无法确认比较基线时，首期只展示原始 hunk，不展开额外上下文。[比较提交 API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)

fork 的新增侧内容来自实际 head 仓库，旧侧来自 base 仓库；重命名旧侧使用 previous_filename。首期无需为只读 diff 执行 checkout。

远程文件列表与 diff 查询按 PR 查询，不是天然绑定不可变 SHA。开始读取前保存 head/base，完成后再读取版本；若期间变化则丢弃混合结果并重试一次，仍变化时提示刷新。缓存包括 head/base 版本，不能只凭 `updatedAt` 判断内容一致。

## 9. 导航、状态与同步

侧栏入口位于快捷操作区域，与现有定时任务、任务配方同级。点击后进入全局列表，保留当前会话和工作区；返回会话不触发仓库切换。首次无工作区时也能读取 PR。

列表保留关联、仓库、状态、关键词、排序和滚动位置。详情返回恢复这些状态。内部导航使用结构化 PR target；打开外部网页使用 gh 返回的 HTTPS URL，校验目标 host，不从不可信正文拼接网页地址。

| 状态 | 界面行为 |
| --- | --- |
| gh 未安装 | 显示安装指引，保留其他 Vela 功能 |
| 未登录 / 登录失效 | 提示 `gh auth login`，提供终端入口 |
| 首次读取 | 显示列表骨架，不伪造数字和同步时间 |
| 成功且完整为空 | 显示没有关联 PR |
| 部分查询失败 | 展示成功部分、失败分类与重试入口 |
| 离线 / 限流 / 刷新失败 | 保留旧结果，标记缓存及最后成功时间 |
| 详情无访问权限或不存在 | 显示不可访问，不等价于“没有 PR” |
| 正在搜索 / 分页未完成 | 使用已加载计数，空结果说明搜索范围 |

建议初始参数：列表缓存 TTL 60 秒，详情 30 秒；页面前台且可见时，列表每 60 秒、打开的开放 PR 详情每 30 秒刷新。页面隐藏后停止常规轮询，恢复时按 TTL 刷新。手动刷新绕过数据 TTL；相同目标请求合并，全局 gh 读取并发上限 4。

这些时间是实现起点，可按实际请求量调整。搜索 API 有独立限流，分页和四类查询会增加消耗；遇到限流按响应指示退避，否则使用带抖动的指数退避，不持续刷新。列表页运行时不启动 `gh pr checks --watch` 的长期进程。

搜索和筛选变化增加 request generation，取消旧进程或丢弃旧响应；详情切换与页面卸载同样处理。每类成功查询独立替换关系成员，不能把失败查询当空集合清除关联；失效条目在四类均不再关联后移除。页面顶部同步时间只有成功读取后更新，缓存重绘不算同步。

## 10. 审查、提问与远程写入

第一期完成读取闭环：列表、概览、检查、活动、文件树、diff、手动刷新和 GitHub 入口。HTML 中的“使用 Vela 审查”、提问、解决冲突与合并属于后续动作；尚未实现时隐藏或显示明确禁用原因，不保留无反馈的假按钮。

| 动作 | 实现方式与边界 |
| --- | --- |
| AI 审查 / 提问 | 使用 Vela 已配置模型，输入固定 PR target、head/base 与选定文件；先输出本地结果，不自动写入 GitHub |
| 发布评论 / 审阅 | 用户查看并提交后，使用 `gh pr comment` / `gh pr review`，正文经 stdin；行内评论使用 `gh api` 并绑定 commit 与 diff 行位置 |
| 解决审阅线程 | `gh api graphql` mutation；使用远程线程 id，核对当前权限 |
| 合并 | 先预览规则与方法，再 `gh pr merge --match-head-commit <SHA>`；成功后读取实际状态 |
| 关闭 / 转为 ready | 复用现有业务规则，经 `gh pr close` / `gh pr ready` 操作显式目标 |
| 修复合并冲突 | 进入已绑定目标的本地工作区 / worktree，通过已有 Git 与 agent 能力修改；不能把 `gh pr update-branch` 等同于解决代码冲突 |

合并必须核对 state、Draft、head、权限、仓库规则、检查和当前审阅结果；“无冲突”或“检查全绿”不足以证明能合并。默认不使用 `--admin`、不删除远程分支。要求 merge queue 的仓库单独展示排队 / 自动合并流程；gh 命令成功不意味着已经 merged。[gh pr merge](https://cli.github.com/manual/gh_pr_merge)

读取列表或生成审查结果本身不代表用户同意发布。写入只从明确的提交动作触发。超时或进程被取消后，写入结果可能已发生；先查询评论、审阅或合并状态再决定重试，避免重复提交。

## 11. 落地分工与顺序

下表为建议新增 / 调整位置，不表示文件已经存在：

| 层 | 建议职责 |
| --- | --- |
| `packages/shared` | PrTarget、关系、分页、详情 / 文件结果类型与专用 IPC 合约 |
| `packages/workspace` | PullRequestInboxService、分页与去重、gh 适配、远程 diff；提取现有 PR 状态映射 |
| 桌面 main | 初始化全局服务、固定身份与参数校验、缓存、取消与并发调度 |
| preload | 仅暴露读取列表 / 详情 / 文件与刷新等固定接口 |
| renderer | 侧栏入口、列表与详情、筛选状态、缓存标记与文件导航 |
| agent | 后续的审查 / 提问输入、模型调用和结果；远程写入单独提交 |

推荐顺序：

1. 身份探测、执行器扩展、四类搜索分页与去重；先验证跨仓库读取不依赖当前 cwd。
2. 侧栏与真实列表，补齐空、失败、限流、缓存和部分结果状态。
3. 批量状态补全、概览、检查与分页活动；再接入远程文件和 diff。
4. 刷新、取消、身份切换、长列表与大 diff 的性能验证。
5. 独立接入 AI 审查 / 提问与远程提交；合并和冲突修复继续遵守现有版本控制约束。

不预先新增 gh 插件、守护进程、Webhook 服务、Token 配置页或 GitHub SDK。版本兼容通过实际命令能力探测；本机 2.96.0 只是文档核验环境，不作为未经验证的最低支持版本。

## 12. 验收与验证策略

| 场景 | 验收结果 |
| --- | --- |
| 无本地项目或当前项目不是 GitHub 仓库 | 仍可读取账户关联 PR |
| 一条 PR 同时由本人创建并提及本人 | 全部列表只有一条，两类筛选均可见 |
| 两个仓库都存在 #128 | 分别显示与缓存，详情 / 写入不串仓库 |
| 团队请求本人审查 | 待审查列表包含搜索匹配结果；完成审阅后重新查询关系 |
| 搜索分页未结束 / 超过 1,000 条 / incomplete_results | 计数与搜索范围明确，不声称完整 |
| 任一关系查询失败 | 保留其他结果与旧的失败关系，不清空整个列表 |
| gh 不可用、401、403、404、限流、离线、超时 | 区分状态，保留可用缓存和筛选 |
| 检查失败或退出码 8 但有有效 JSON | 显示失败 / 等待，避免报告成整页读取失败 |
| 无检查、跳过、取消、未知 | 各有状态，均不伪装成检查通过 |
| 快速切换仓库、PR 或账户 | 旧响应不覆盖新页面或跨账户缓存 |
| 大 diff、二进制、重命名、patch 缺失、文件数超限 | 文件对应正确，截断和不可展示原因明确 |
| 读取过程中 PR head 或 base 改变 | 不展示混合版本，重新读取或提示刷新 |
| 页面隐藏后恢复 | 轮询停止并按 TTL 刷新，无长期 watch 进程 |
| 合并进入队列 / 写入超时 / head 变化 | 核对实际状态，不误报已合并，不盲目重复写入 |

实现时按风险分阶段验证：映射、分页、去重和 diff 解析先使用 fake gh / 固定响应做定向测试；IPC、跨仓库目标隔离和执行器修改再覆盖相关现有工作区 PR、检查与合并测试。只在共用执行器影响难以限定或发布门禁要求时扩大回归范围。真实 gh 冒烟先限定只读；远程写入使用明确的测试仓库与具体操作范围。

原方案编写时仅撰写文档：核对当前源码、本机 `gh --help` 与官方手册；不查询私人 PR、不执行远程写入、不运行构建或回归测试。当时未随文档实现服务、IPC 或缓存；后续第一期实现与验证见上述实现记录。

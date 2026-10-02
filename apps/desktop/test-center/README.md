# Vela 测试中心

把仓库里的 Node 单测和浏览器 UI 检查收进同一个本地看板:一条命令启动服务,浏览器里运行、观察和重跑,失败直接展开看错误与输出。

- **Node 单测**:`packages/agent/test`、`packages/workspace/test`、`apps/desktop/test` 下的全部 `*.test.ts`,一个 `node --test` 批次运行,按文件实时汇报。
- **浏览器 UI 检查**:`apps/desktop/test` 里带 `?checks=1` 的预览页,由 Electron 驱动隐藏窗口逐个运行,自动收集 PASS/FAIL。
- 运行结果落盘到 `.runs/last-run.json`,刷新页面或重启服务后仍能看到上次结果。

## 快速开始

```sh
pnpm test:center
```

终端会打印看板地址(默认 `http://127.0.0.1:5190/`),用浏览器打开即可。看板支持:

- `运行全部` / `运行选中` / `重跑失败` / `停止`
- 按包/层或按功能分组(功能分组由 `apps/desktop/package.json` 的 `test:*` 脚本自动推导)
- 搜索、只看失败、展开单个任务看子测试、错误堆栈和输出
- 浏览器检查任务提供「预览」链接,可直接打开对应 fixture 页面

## 无头模式(冒烟 / CI)

```sh
node apps/desktop/test-center/server.mjs --list                 # 列出全部任务(JSON)
node apps/desktop/test-center/server.mjs --run all              # 运行全部
node apps/desktop/test-center/server.mjs --run failed           # 只重跑上次失败的任务
node apps/desktop/test-center/server.mjs --run node:apps/desktop/test/shell-path.test.ts
```

`--run` 把 SSE 消息以 NDJSON 写到 stdout,摘要写到 stderr;有失败或运行未正常结束时退出码为 1。选中浏览器检查时会自动把看板服务一起拉起。

## 任务模型

| 分组 | 内容 |
| --- | --- |
| Agent 运行时 | `packages/agent/test/*.test.ts` |
| Workspace 与 Git | `packages/workspace/test/*.test.ts` |
| 桌面 · 渲染层 | 引用 `src/renderer` 的桌面测试 |
| 桌面 · 主进程 | 引用 `src/main` 的桌面测试 |
| 桌面 · 跨层 | 同时涉及主进程与渲染层的测试(如 IPC 装配检查) |
| 桌面 · 其他 | 不引用应用源码的桌面测试 |
| 浏览器 UI 检查 | `fixtures.mjs` 登记的预览页检查 |

任务 id 形如 `node:<仓库相对路径>` 或 `ui:<fixture 名>`。

## 新增浏览器检查

1. 在 `apps/desktop/test` 下准备预览页和检查脚本(参考 `motion-batch3-checks.ts`)。
2. 检查脚本把结果写进一个结果元素,结束时设置状态:

   ```ts
   const output = document.createElement("pre");
   output.id = "my-check-results";
   document.body.append(output);
   // ...
   output.dataset.status = "passed"; // 失败时 "failed"
   ```

3. 在 `test-center/fixtures.mjs` 登记:`id`、`title`、`page`(带 `?checks=1`)、`resultSelector`、`timeoutMs`。

运行器只认 `data-status`;没有标记时,只有出现以 `FAIL` 开头的行才会判失败,成功会一直等到超时(避免页面刚写出第一行 PASS 就提前收工)。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `VELA_TEST_CENTER_PORT` | 固定端口(默认 5190;未设置时端口占用会自动向后尝试) |
| `VELA_TEST_CONCURRENCY` | `node --test` 并发数(默认交给 Node) |
| `VELA_TEST_TIMEOUT_MS` | Node 批次超时,默认 600000(10 分钟) |
| `VELA_TEST_CENTER_SHOW` | 设为 `1` 时显示浏览器检查窗口,便于调试 fixture |

## 文件说明

```
server.mjs           入口:HTTP + Vite middleware + API/SSE,--list / --run 无头模式
discovery.mjs        任务发现与分组(包/层、test:* 脚本推导的功能分组)
protocol.mjs         纯逻辑:reporter 事件归约、fixture 判定、flag 探测、输出截断
runner.mjs           RunManager:Node 批次与 Electron 批次、超时、取消、落盘
ndjson-reporter.mjs  node:test 自定义 reporter(逐行 JSON)
ui-checks-runner.mjs Electron 主进程:加载 fixture 并轮询结果元素
fixtures.mjs         浏览器检查清单
dashboard.*          看板页面(React + TSX,由 Vite 实时转译)
.runs/               运行结果(已 gitignore)
```

看板与预览页共用同一台 Vite dev server(root 为 `apps/desktop`),所以 fixture 页面也能直接在浏览器里手动打开调试。API 只绑定 `127.0.0.1`,不做鉴权,属于本地开发工具。

## 排障

- **端口占用**:不设 `VELA_TEST_CENTER_PORT` 时会自动尝试后续端口,以终端打印的地址为准;显式指定时占用会直接报错。
- **浏览器检查全部失败**:确认 `node_modules/.bin/electron` 可用;macOS 上首次运行可能需要在系统设置里允许。
- **浏览器检查超时**:用 `VELA_TEST_CENTER_SHOW=1 pnpm test:center` 打开窗口复现,或先点任务行的「预览」手动打开页面。
- **Node 测试超时**:调大 `VELA_TEST_TIMEOUT_MS`;超时后未完成的文件会标记为失败并保留已收集的输出。

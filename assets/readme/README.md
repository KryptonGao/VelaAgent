# README 示例截图

三张主打功能截图复用真实 renderer 组件，由浏览器渲染后截图；示例项目、对话、工具返回与运行指标均为生成数据，不会调用模型、执行示例命令或读取用户的会话与账号。

- 数据源：`apps/desktop/test/readme-preview-data.ts`
- 页面：`apps/desktop/test/readme-preview.tsx` 与 `readme-preview.html`
- 输出：`vela-compact.png`、`vela-subagents.png`、`vela-trace.png`

在仓库根目录运行 `pnpm --filter @vela/desktop test:trace:preview`，打开以下页面。若 5179 已占用，使用 Vite 输出的实际端口。

| 截图 | 页面 | 截图前的操作 |
| --- | --- | --- |
| 紧凑模式 | <http://127.0.0.1:5179/test/readme-preview.html?scene=compact> | 展开「用时」，再展开「已读取 3 个文件」与「已编辑 3 个文件」 |
| SubAgents | <http://127.0.0.1:5179/test/readme-preview.html?scene=subagents> | 展开主对话的「用时」，展开右侧 auth 面板中的测试命令 |
| 轨迹界面 | <http://127.0.0.1:5179/test/readme-preview.html?scene=trace> | 切换「轨迹」，选中测试命令的 bash 调用，打开详情中的「结果」 |

截图使用 1440 × 960 CSS 像素、2× 像素密度、浅色外观、简体中文与 Asia/Shanghai 时区。先等待动画结束，再截取视口；图片为 2880 × 1920 PNG，可直接替换相应素材。

模型与账号、外观设置的旧截图保留在主 README 的折叠区；`vela-desktop.png`、`vela-task-review.png` 保留作为历史素材。

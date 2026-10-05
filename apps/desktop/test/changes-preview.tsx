/** Deterministic browser fixture for the changes review pane. Not imported by production. */
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { GitFileChange, GitRepoInfo, GitStatusSnapshot, VelaApi, WorkspaceFileContent } from "@vela/shared";
import { ChangesView } from "../src/renderer/components/ChangesView";
import type { ProjectApi } from "../src/renderer/hooks/useProject";
import "../src/renderer/styles.css";

const README = `# Vela

Vela 是一个 **Agent Trace Viewer**，用来观察 agent 的每一步。

## 工作方式

- \`Agent\` 负责读写与执行
- \`Plan\` 只读查阅并输出计划
- \`Goal\` 记录多步目标

\`\`\`ts
const answer = await agent.run({
  prompt: "hello",
  model: "gpt-5",
});
\`\`\`

| 面板 | 作用 |
| --- | --- |
| 变更 | 审查工作区差异 |
| 轨迹 | 查看工具调用 |

> 引用块

图片：![shot](./assets/shot.png)
`;

const readmeDiff = [
  "diff --git a/README.md b/README.md",
  "index 03ce1a3..1344b9c 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -12,8 +12,9 @@",
  " ## 工作方式",
  " ",
  " -- **按任务选择模式: ** 工作。",
  " -- 新的一行。",
  "++ **按任务选择模式: ** 继续工作。",
  "+",
  "+新增一段说明：顶层目录决定 `Agent` 的文件范围、`Shell` 目录。",
  " - 保留的行",
  " - 最后一行",
].join("\n");

const tsDiff = [
  "diff --git a/apps/desktop/src/index.ts b/apps/desktop/src/index.ts",
  "index 1aa88c4..f2f0d3a 100644",
  "--- a/apps/desktop/src/index.ts",
  "+++ b/apps/desktop/src/index.ts",
  "@@ -1,8 +1,11 @@",
  " import { app } from \"electron\";",
  " ",
  " const template = `",
  "-  old ${app.name}",
  "+  new ${app.name}",
  "+  ${app.getVersion()}",
  " `;",
  " ",
  " // 一段注释",
  "-function start() {",
  "+function start(options: { port: number }) {",
  "+  const { port } = options;",
  "   return port;",
  " }",
  "+",
  "+export const version = app.getVersion();",
].join("\n");

const files: GitFileChange[] = [
  { path: "README.md", oldPath: null, status: "modified", indexStatus: null, worktreeStatus: "modified", addedLines: 2, deletedLines: 1, indexAddedLines: 0, indexDeletedLines: 0, worktreeAddedLines: 2, worktreeDeletedLines: 1 },
  { path: "apps/desktop/src/index.ts", oldPath: null, status: "modified", indexStatus: null, worktreeStatus: "modified", addedLines: 3, deletedLines: 2, indexAddedLines: 0, indexDeletedLines: 0, worktreeAddedLines: 3, worktreeDeletedLines: 2 },
];

const repo: GitRepoInfo = { root: "/tmp/vela-fixture", name: "VelaHarness", remoteUrl: null, subdir: null, empty: false };
const git: GitStatusSnapshot = {
  repo,
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  files,
  addedLines: 5,
  deletedLines: 3,
  lastFetchAt: null,
  operation: null,
  identity: { name: "Fixture", email: "fixture@example.com", configured: true },
  remotes: [],
};

const project = {
  git,
  fileDiff: (path: string) => Promise.resolve(path === "README.md" ? readmeDiff : tsDiff),
  stageFiles: () => Promise.resolve(true),
  unstageFiles: () => Promise.resolve(true),
  discardFiles: () => Promise.resolve(true),
  openFile: () => Promise.resolve(true),
} as unknown as ProjectApi;

const api = {
  readWorkspaceFile: (path: string): Promise<WorkspaceFileContent> => {
    const content = path === "README.md" ? README : `import { app } from "electron";\n`;
    return Promise.resolve({
      path,
      absolutePath: `/tmp/vela-fixture/${path}`,
      kind: "text",
      content,
      size: content.length,
      truncated: false,
    });
  },
} as unknown as VelaApi;
(window as unknown as { vela: VelaApi }).vela = api;

function Fixture({ path, autoPreview }: { path: string; autoPreview: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoPreview) return;
    const timer = window.setTimeout(() => {
      const buttons = ref.current?.querySelectorAll<HTMLButtonElement>(".preview-view-toggle button");
      buttons?.[1]?.click();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [autoPreview]);
  return (
    <div className="fixture" ref={ref}>
      <ChangesView
        project={project}
        initialPath={path}
        initialPathRequestKey={1}
        onClose={() => undefined}
      />
    </div>
  );
}

const autoPreview = new URLSearchParams(location.search).get("mode") === "preview";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture path="README.md" autoPreview={autoPreview} />
    <Fixture path="apps/desktop/src/index.ts" autoPreview={autoPreview} />
  </React.StrictMode>,
);

/**
 * 测试发现:扫描三个测试根目录,按包/层分组,并从 apps/desktop 的 test:* 脚本
 * 推导跨包功能分组。纯文件系统读取,不做任何运行。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { browserFixtures, previewPage } from "./fixtures.mjs";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const desktopDir = join(repoRoot, "apps/desktop");
export const nodeTestRoots = ["packages/agent/test", "packages/workspace/test", "apps/desktop/test"];

/** test:* 脚本后缀到界面标签;未列出的用原始后缀。 */
const featureTitles = {
  trace: "轨迹",
  memory: "记忆",
  "thinking-summary": "思考总结",
  persistence: "持久化",
  "ui-storage": "界面存储",
  plan: "方案",
  diff: "差异",
  "turn-review": "变更审查",
  "version-control": "版本控制",
  conversations: "会话",
  "session-create": "新建会话",
  "image-viewer": "图片查看",
};

const groupOrder = [
  { id: "agent", title: "Agent 运行时" },
  { id: "workspace", title: "Workspace 与 Git" },
  { id: "desktop-renderer", title: "桌面 · 渲染层" },
  { id: "desktop-main", title: "桌面 · 主进程" },
  { id: "desktop-cross", title: "桌面 · 跨层" },
  { id: "desktop-other", title: "桌面 · 其他" },
  { id: "ui", title: "浏览器 UI 检查" },
];

/**
 * 桌面测试按引用源码分层:同时涉及主进程和渲染层算跨层。
 * 只扫描 import 头部(到第一个 describe/it 之前),避免把测试体里内嵌的示例源码当成引用。
 */
export function classifyTestFile(source) {
  const header = String(source).split(/\n(?:describe|it|test)\s*\(/)[0] ?? "";
  const specifiers = [...header.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]);
  const usesMain = specifiers.some((specifier) => specifier.includes("src/main"));
  const usesRenderer = specifiers.some((specifier) => specifier.includes("src/renderer"));
  if (usesMain && usesRenderer) return "cross";
  if (usesMain) return "main";
  if (usesRenderer) return "renderer";
  return "other";
}

/** 源码级扫描测试没有 src import,单独声明它覆盖的层。 */
const layerOverrides = new Map([
  ["apps/desktop/test/version-control-p2.test.ts", "cross"],
]);

function layerGroupId(task) {
  if (task.kind === "ui") return "ui";
  if (task.package === "agent") return "agent";
  if (task.package === "workspace") return "workspace";
  return `desktop-${task.layer}`;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function packageOf(path) {
  if (path.startsWith("packages/agent/")) return "agent";
  if (path.startsWith("packages/workspace/")) return "workspace";
  return "desktop";
}

function listTestFiles(relativeRoot) {
  const absoluteRoot = join(repoRoot, relativeRoot);
  let entries;
  try {
    entries = readdirSync(absoluteRoot);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".test.ts")).sort();
}

function nodeTasks() {
  const tasks = [];
  for (const root of nodeTestRoots) {
    for (const name of listTestFiles(root)) {
      const absolute = join(repoRoot, root, name);
      const path = toPosix(relative(repoRoot, absolute));
      const source = readFileSync(absolute, "utf8").slice(0, 8192);
      const pkg = packageOf(path);
      const layer = pkg === "desktop" ? layerOverrides.get(path) ?? classifyTestFile(source) : pkg;
      tasks.push({
        id: `node:${path}`,
        kind: "node",
        title: basename(name, ".test.ts"),
        path,
        package: pkg,
        layer,
        feature: null,
      });
    }
  }
  return tasks;
}

function uiTasks() {
  return browserFixtures.map((fixture) => ({
    id: fixture.id,
    kind: "ui",
    title: fixture.title,
    path: previewPage(fixture),
    package: "desktop",
    layer: "ui",
    feature: null,
  }));
}

/**
 * 解析 apps/desktop/package.json 里的 test:* 脚本,得到「功能 → 文件」映射。
 * 这样功能分组会自动跟随现有定向测试脚本,不需要维护第二份清单。
 */
export function parseFeatureGroups(packageJsonText, tasks) {
  let scripts;
  try {
    scripts = JSON.parse(packageJsonText).scripts ?? {};
  } catch {
    return [];
  }
  const taskByPath = new Map(tasks.filter((task) => task.kind === "node").map((task) => [task.path, task]));
  const features = [];
  for (const [key, command] of Object.entries(scripts)) {
    if (!key.startsWith("test:") || key === "test:trace:preview" || key === "test:center") continue;
    const matches = String(command).match(/[\w./-]+\.test\.ts/g) ?? [];
    const taskIds = [];
    for (const raw of matches) {
      const path = toPosix(relative(repoRoot, resolve(desktopDir, raw)));
      const task = taskByPath.get(path);
      if (task) taskIds.push(task.id);
    }
    if (taskIds.length === 0) continue;
    const id = key.slice("test:".length);
    features.push({ id, title: featureTitles[id] ?? id, taskIds: [...new Set(taskIds)] });
  }
  return features;
}

function buildGroups(tasks) {
  const groups = [];
  for (const definition of groupOrder) {
    const taskIds = tasks.filter((task) => layerGroupId(task) === definition.id).map((task) => task.id);
    if (taskIds.length > 0) groups.push({ ...definition, taskIds });
  }
  return groups;
}

export function discoverTasks() {
  const tasks = [...nodeTasks(), ...uiTasks()];
  const packageJsonText = readFileSync(join(desktopDir, "package.json"), "utf8");
  const features = parseFeatureGroups(packageJsonText, tasks);
  for (const fixture of browserFixtures) {
    const feature = features.find((entry) => entry.id === fixture.feature);
    if (feature) feature.taskIds.push(fixture.id);
  }
  for (const task of tasks) {
    const feature = features.find((entry) => entry.taskIds.includes(task.id));
    task.feature = feature ? feature.id : null;
  }
  return { tasks, groups: buildGroups(tasks), features };
}

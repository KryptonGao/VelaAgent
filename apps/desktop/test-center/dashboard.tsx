/** Vela 测试中心看板:订阅 SSE,展示任务、运行进度与失败详情。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/renderer/styles.css";
import "./dashboard.css";
import {
  GroupSidebar,
  LogDrawer,
  SummaryBar,
  TaskRow,
  Toolbar,
  type RunState,
  type SubtestResult,
  type TaskResult,
  type TestFeature,
  type TestGroup,
  type TestTask,
} from "./dashboard-view";

const themeKey = "vela.testCenter.theme";
const maxClientOutput = 256 * 1024;

interface Environment {
  node: string;
  electron: string | null;
  platform: string;
}

interface Snapshot {
  tasks: TestTask[];
  groups: TestGroup[];
  features: TestFeature[];
  run: RunState | null;
  running: boolean;
  env: Environment | null;
}

type ServerMessage =
  | ({ type: "snapshot" } & Snapshot)
  | { type: "run:start"; run: RunState }
  | { type: "run:phase"; phase: "node" | "ui" }
  | { type: "run:end"; run: RunState }
  | { type: "task:update"; taskId: string; patch: Partial<TaskResult> }
  | { type: "subtest:update"; taskId: string; subtest: SubtestResult }
  | { type: "task:output"; taskId: string; stream: string; chunk: string }
  | { type: "run:log"; line: string };

const themeLabels: Record<string, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

function App() {
  const [tasks, setTasks] = useState<TestTask[]>([]);
  const [groups, setGroups] = useState<TestGroup[]>([]);
  const [features, setFeatures] = useState<TestFeature[]>([]);
  const [run, setRun] = useState<RunState | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [activeGroup, setActiveGroup] = useState("all");
  const [groupMode, setGroupMode] = useState<"layer" | "feature">("layer");
  const [search, setSearch] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [logOpen, setLogOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem(themeKey) ?? "system");

  const applyMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case "snapshot": {
        setTasks(message.tasks);
        setGroups(message.groups);
        setFeatures(message.features);
        setRun(message.run);
        setEnv(message.env ?? null);
        break;
      }
      case "run:start": {
        setRun(message.run);
        setNotice(null);
        break;
      }
      case "run:phase": {
        setRun((current) => (current ? { ...current, phase: message.phase } : current));
        break;
      }
      case "run:end": {
        setRun(message.run);
        break;
      }
      case "task:update": {
        setRun((current) => {
          if (!current) return current;
          const result = current.results[message.taskId];
          if (!result) return current;
          return {
            ...current,
            results: { ...current.results, [message.taskId]: { ...result, ...message.patch } },
          };
        });
        break;
      }
      case "subtest:update": {
        setRun((current) => {
          if (!current) return current;
          const result = current.results[message.taskId];
          if (!result) return current;
          const exists = result.subtests.some((subtest) => subtest.testId === message.subtest.testId);
          const subtests = exists
            ? result.subtests.map((subtest) =>
                subtest.testId === message.subtest.testId ? { ...subtest, ...message.subtest } : subtest,
              )
            : [...result.subtests, message.subtest];
          return {
            ...current,
            results: { ...current.results, [message.taskId]: { ...result, subtests } },
          };
        });
        break;
      }
      case "task:output": {
        setRun((current) => {
          if (!current) return current;
          const result = current.results[message.taskId];
          if (!result) return current;
          let output = result.output + message.chunk;
          if (output.length > maxClientOutput) output = output.slice(-maxClientOutput);
          return {
            ...current,
            results: { ...current.results, [message.taskId]: { ...result, output } },
          };
        });
        break;
      }
      case "run:log": {
        setRun((current) => (current ? { ...current, log: [...current.log, message.line].slice(-500) } : current));
        break;
      }
      default:
        break;
    }
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      try {
        applyMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        // 忽略无法解析的消息。
      }
    };
    return () => source.close();
  }, [applyMessage]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const scheme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.scheme = scheme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(themeKey, theme);
  }, [theme]);

  const running = run?.status === "running";
  const phase = run?.phase ?? null;

  const post = useCallback(async (path: string, body?: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setNotice(payload?.error ?? `请求失败(${response.status})`);
    }
  }, []);

  const runAll = useCallback(() => {
    void post("/api/run", { taskIds: tasks.map((task) => task.id) });
  }, [post, tasks]);

  const runSelected = useCallback(() => {
    void post("/api/run", { taskIds: [...selection] });
  }, [post, selection]);

  const rerunFailed = useCallback(() => {
    const ids = Object.entries(run?.results ?? {})
      .filter(([, result]) => result.status === "failed")
      .map(([id]) => id);
    if (ids.length > 0) void post("/api/run", { taskIds: ids });
  }, [post, run]);

  const stop = useCallback(() => {
    void post("/api/stop");
  }, [post]);

  const toggleSelect = useCallback((id: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const groupTaskIds = useMemo(() => {
    if (activeGroup === "all") return null;
    const source = groupMode === "layer" ? groups : features;
    const entry = source.find((item) => item.id === activeGroup);
    if (entry) return new Set(entry.taskIds);
    if (activeGroup === "ungrouped") return new Set(tasks.filter((task) => !task.feature).map((task) => task.id));
    return null;
  }, [activeGroup, groupMode, groups, features, tasks]);

  const visibleTasks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (groupTaskIds && !groupTaskIds.has(task.id)) return false;
      if (needle && !`${task.title} ${task.path}`.toLowerCase().includes(needle)) return false;
      if (onlyFailed && run?.results[task.id]?.status !== "failed") return false;
      return true;
    });
  }, [tasks, groupTaskIds, search, onlyFailed, run]);

  const cycleTheme = () => {
    setTheme((current) => (current === "system" ? "light" : current === "light" ? "dark" : "system"));
  };

  const failedCount = Object.values(run?.results ?? {}).filter((result) => result.status === "failed").length;

  return (
    <div className="tc-app">
      <header className="tc-header">
        <div className="tc-brand">
          <span className="tc-brand-mark">V</span>
          <div>
            <h1>Vela 测试中心</h1>
            <p>
              {env ? `Node ${env.node} · Electron ${env.electron ?? "未安装"} · ${tasks.length} 个任务` : "正在加载任务清单…"}
              {failedCount > 0 ? ` · ${failedCount} 个失败` : ""}
            </p>
          </div>
        </div>
        <div className="tc-header-actions">
          <button className="tc-icon-button" onClick={cycleTheme} title="切换主题">
            {themeLabels[theme] ?? theme}
          </button>
        </div>
      </header>
      {notice ? (
        <button className="tc-notice" onClick={() => setNotice(null)}>
          {notice} · 点击关闭
        </button>
      ) : null}
      <Toolbar
        run={run}
        running={running}
        connected={connected}
        selectedCount={selection.size}
        visibleCount={visibleTasks.length}
        totalCount={tasks.length}
        phase={phase}
        onRunAll={runAll}
        onRunSelected={runSelected}
        onRerunFailed={rerunFailed}
        onStop={stop}
        search={search}
        onSearch={setSearch}
        onlyFailed={onlyFailed}
        onOnlyFailed={setOnlyFailed}
        groupMode={groupMode}
        onGroupMode={(mode) => {
          setGroupMode(mode);
          setActiveGroup("all");
        }}
      />
      <div className="tc-body">
        <GroupSidebar
          mode={groupMode}
          groups={groups}
          features={features}
          active={activeGroup}
          onSelect={setActiveGroup}
          tasks={tasks}
          run={run}
        />
        <main className="tc-main">
          {tasks.length === 0 ? (
            <p className="tc-empty">正在加载任务清单…</p>
          ) : visibleTasks.length === 0 ? (
            <p className="tc-empty">没有符合当前筛选条件的任务。</p>
          ) : (
            <div className="tc-list">
              {visibleTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  result={run?.results[task.id] ?? null}
                  selected={selection.has(task.id)}
                  expanded={expanded.has(task.id)}
                  onToggleSelect={() => toggleSelect(task.id)}
                  onToggleExpand={() => toggleExpand(task.id)}
                />
              ))}
            </div>
          )}
        </main>
      </div>
      <SummaryBar
        run={run}
        running={running}
        phase={phase}
        selectedCount={selection.size}
        visibleCount={visibleTasks.length}
        totalCount={tasks.length}
      />
      <LogDrawer log={run?.log ?? []} open={logOpen} onToggle={() => setLogOpen((value) => !value)} />
    </div>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);

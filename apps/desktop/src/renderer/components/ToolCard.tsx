import type { AskUserQuestionRequest, ToolActivity, ToolTrace } from "@vela/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { useFilePreview } from "./preview/FilePreviewContext";
import { QuestionCard } from "./QuestionCard";
import { CheckIcon, EyeIcon, FilePlusIcon, PencilIcon, StackIcon, TerminalIcon } from "./icons";

type ToolKind = "bash" | "read" | "edit" | "write" | "other";

const kindLabels: Record<ToolKind, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  other: "Tool",
};

/** 同一段里连续工具达到该数量才折叠成一组。 */
const RUN_MIN = 3;

/** 按 toolCallId 查找待回答的问题;ask_user_question 卡片用。 */
export type QuestionLookup = (toolCallId: string) => AskUserQuestionRequest | null;

/**
 * 消息工具列表入口:连续 RUN_MIN 个及以上 bash/read/edit/write 折叠成一组,
 * 其余工具(计划、目标、提问等)照常逐张展示,并打断连续区间。
 */
export function ToolList({
  tools,
  getQuestion,
  onReplyQuestion,
}: {
  tools: ToolTrace[];
  getQuestion?: QuestionLookup;
  onReplyQuestion?: (id: string, answer: string | null) => void;
}) {
  const segments = useMemo(() => splitToolRuns(tools), [tools]);
  return (
    <div className="tool-card-list">
      {segments.map((segment) =>
        segment.length >= RUN_MIN ? (
          <ToolRunGroup key={segment[0].id} tools={segment} />
        ) : (
          segment.map((tool) => (
            <ToolCard key={tool.id} tool={tool} getQuestion={getQuestion} onReplyQuestion={onReplyQuestion} />
          ))
        ),
      )}
    </div>
  );
}

/** 按连续的可折叠工具切段;非折叠类工具自成一段。 */
function splitToolRuns(tools: ToolTrace[]): ToolTrace[][] {
  const segments: ToolTrace[][] = [];
  let run: ToolTrace[] = [];
  for (const tool of tools) {
    if (toolKind(tool.name) === "other") {
      if (run.length > 0) segments.push(run);
      run = [];
      segments.push([tool]);
    } else {
      run.push(tool);
    }
  }
  if (run.length > 0) segments.push(run);
  return segments;
}

interface ToolCardProps {
  tool: ToolTrace;
  getQuestion?: QuestionLookup;
  onReplyQuestion?: (id: string, answer: string | null) => void;
}

/** 入口分发:提问和子代理各自有卡片,其余走通用折叠卡片。 */
export function ToolCard(props: ToolCardProps) {
  if (props.tool.name === "ask_user_question") {
    return (
      <QuestionCard
        tool={props.tool}
        request={props.getQuestion?.(props.tool.id) ?? null}
        onReply={props.onReplyQuestion ?? (() => undefined)}
      />
    );
  }
  if (props.tool.name === "task") return <TaskCard tool={props.tool} />;
  return <GenericToolCard {...props} />;
}

function useExpandSettle(open: boolean) {
  const [settled, setSettled] = useState(open);
  const initial = useRef(true);

  useEffect(() => {
    if (!open) {
      setSettled(false);
      initial.current = false;
      return;
    }
    if (initial.current) {
      initial.current = false;
      setSettled(true);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), 280);
    return () => window.clearTimeout(timer);
  }, [open]);

  function onTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== "grid-template-rows") return;
    if (open) setSettled(true);
  }

  return { settled: open && settled, onTransitionEnd };
}

function ToolCollapse({
  open,
  onTransitionEnd,
  children,
}: {
  open: boolean;
  onTransitionEnd?: (event: TransitionEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className="tool-collapse" onTransitionEnd={onTransitionEnd}>
      <div className="tool-collapse-inner" inert={open ? undefined : true}>
        {children}
      </div>
    </div>
  );
}

const stepLabels: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
};

function TaskCard({ tool }: { tool: ToolTrace }) {
  const [open, setOpen] = useState(tool.status === "running");
  const [full, setFull] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { settled, onTransitionEnd } = useExpandSettle(open);
  const activity = tool.activity ?? {};
  const title = taskTitle(activity.body);
  const report = taskReport(activity.body);
  const steps = activity.steps ?? [];
  const label = activity.agent === "general" ? "执行" : "查阅";

  useLayoutEffect(() => {
    if (!settled || full) return;
    const node = sheetRef.current;
    if (!node) return;
    const measure = () => {
      if (node.clientHeight < 1) {
        setOverflows(false);
        return;
      }
      setOverflows(node.scrollHeight - node.clientHeight > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [settled, full, report, activity.steps, tool.status]);

  return (
    <article className={`tool-card tool-kind-other is-task is-${tool.status}${open ? " open" : ""}`}>
      <button
        className="tool-card-head"
        type="button"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-card-icon" aria-hidden="true">
          <StackIcon size={13} />
        </span>
        <span className="tool-kind-label">{label}</span>
        <span className="tool-card-main">
          <span className="tool-card-name grow">{title}</span>
        </span>
        <StatusMark status={tool.status} />
        <svg className="tool-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <ToolCollapse open={open} onTransitionEnd={onTransitionEnd}>
        <div className="tool-card-body">
          <div ref={sheetRef} className={`tool-clip${full ? " full" : ""}`}>
            {steps.length > 0 ? (
              <ul className="task-steps">
                {steps.map((step) => (
                  <li key={step.id} className={`task-step is-${step.status}`}>
                    <span className="task-step-name">{stepLabels[step.name] ?? step.name}</span>
                    <span className="task-step-summary">{step.summary || step.name}</span>
                  </li>
                ))}
              </ul>
            ) : tool.status === "running" ? (
              <p className="tool-wait">正在启动</p>
            ) : null}
            {report ? <pre className="tool-note task-report">{report}</pre> : null}
          </div>
          {(settled && overflows) || full ? (
            <button className="tool-expand" type="button" onClick={() => setFull((value) => !value)}>
              {full ? "收起" : "展开全部"}
            </button>
          ) : null}
        </div>
      </ToolCollapse>
    </article>
  );
}

function taskTitle(body: string | undefined): string {
  const line = body?.split("\n").find((item) => item.trim())?.replace(/\s+/g, " ").trim();
  return line || "子代理";
}

function taskReport(body: string | undefined): string {
  if (!body) return "";
  const split = body.indexOf("\n");
  if (split < 0) return "";
  return body.slice(split + 1).trim();
}

function GenericToolCard({ tool }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { settled, onTransitionEnd } = useExpandSettle(open);
  const preview = useFilePreview();
  const kind = toolKind(tool.name);
  const activity = tool.activity ?? {};
  const subject = subjectOf(kind, activity, tool.name);
  const stat = diffStat(activity.diff);
  const lines = kind === "read" ? readLineCount(activity.body) : null;
  const previewPath = kind === "bash" ? null : activity.path?.trim() || null;
  const canPreview = Boolean(preview && previewPath);

  useLayoutEffect(() => {
    if (!settled || full) return;
    const node = sheetRef.current;
    if (!node) return;
    const measure = () => {
      if (node.clientHeight < 1) {
        setOverflows(false);
        return;
      }
      setOverflows(node.scrollHeight - node.clientHeight > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [settled, full, activity.body, activity.diff, activity.command, tool.status]);

  return (
    <article className={`tool-card tool-kind-${kind} is-${tool.status}${open ? " open" : ""}`}>
      <div className="tool-card-top">
        <button
          className="tool-card-head"
          type="button"
          aria-expanded={open}
          title={activity.command || activity.path || kindLabels[kind]}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tool-card-icon" aria-hidden="true">
            <KindIcon kind={kind} />
          </span>
          <span className="tool-kind-label">{toolLabel(tool.name, kind)}</span>
          <span className="tool-card-main">
            <span className={`tool-card-name${subject.dir ? "" : " grow"}`}>{subject.name}</span>
            {subject.dir ? <span className="tool-card-dir">{subject.dir}</span> : null}
          </span>
          {stat ? (
            <span className="tool-stat">
              {stat.added > 0 ? <span className="tool-stat-add">+{stat.added}</span> : null}
              {stat.removed > 0 ? <span className="tool-stat-del">−{stat.removed}</span> : null}
            </span>
          ) : lines !== null ? (
            <span className="tool-lines">{lines} 行</span>
          ) : null}
          <StatusMark status={tool.status} />
          <svg className="tool-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {canPreview ? (
          <button
            className="tool-card-open"
            type="button"
            title="在侧栏预览"
            aria-label={`预览 ${subject.name}`}
            onClick={() => preview?.openFile(previewPath ?? "")}
          >
            <EyeIcon size={12} />
          </button>
        ) : null}
      </div>
      <ToolCollapse open={open} onTransitionEnd={onTransitionEnd}>
        <div className="tool-card-body">
          <div ref={sheetRef} className={`tool-clip${full ? " full" : ""}`}>
            <ToolBody kind={kind} activity={activity} status={tool.status} />
          </div>
          {(settled && overflows) || full ? (
            <button className="tool-expand" type="button" onClick={() => setFull((value) => !value)}>
              {full ? "收起" : "展开全部"}
            </button>
          ) : null}
        </div>
      </ToolCollapse>
    </article>
  );
}

/** 一组连续工具的折叠卡片,展开后内部还是原来的 ToolCard。 */
function ToolRunGroup({ tools }: { tools: ToolTrace[] }) {
  const [open, setOpen] = useState(false);
  // 折叠时跟踪最新一个还在跑(或最后一个)的工具,让标题行保持实时。
  const current =
    [...tools].reverse().find((tool) => tool.status === "running") ?? tools[tools.length - 1];
  const activity = current.activity ?? {};
  const kindCounts = new Map<ToolKind, number>();
  for (const tool of tools) {
    const kind = toolKind(tool.name);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const uniform = kindCounts.size === 1 ? [...kindCounts.keys()][0] : null;
  const failed = tools.filter((tool) => tool.status === "error").length;
  const stat = totalDiffStat(tools);
  const subject = subjectOf(toolKind(current.name), activity, current.name);
  const detail = activity.command?.trim() || activity.path?.trim() || "";
  const breakdown = [...kindCounts].map(([kind, count]) => `${kindLabels[kind]} ×${count}`).join(" · ");

  return (
    <article
      className={`tool-run tool-kind-${uniform ?? "other"}${open ? " open" : ""}${
        current.status === "running" ? " is-running" : ""
      }`}
    >
      <button
        className="tool-run-head"
        type="button"
        aria-expanded={open}
        title={detail ? `${breakdown}\n${detail}` : breakdown}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-card-icon" aria-hidden="true">
          {uniform ? <KindIcon kind={uniform} /> : <StackIcon />}
        </span>
        <span className="tool-kind-label">{uniform ? kindLabels[uniform] : "工具"}</span>
        <span className="tool-run-count">×{tools.length}</span>
        <span className="tool-run-subject">{subject.name}</span>
        {failed > 0 ? <span className="tool-run-failed">{failed} 失败</span> : null}
        {stat ? (
          <span className="tool-stat">
            {stat.added > 0 ? <span className="tool-stat-add">+{stat.added}</span> : null}
            {stat.removed > 0 ? <span className="tool-stat-del">−{stat.removed}</span> : null}
          </span>
        ) : null}
        <StatusMark status={current.status === "running" ? "running" : failed > 0 ? "error" : "done"} />
        <svg
          className="tool-run-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <ToolCollapse open={open}>
        <div className="tool-run-body">
          {tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      </ToolCollapse>
    </article>
  );
}

function ToolBody({
  kind,
  activity,
  status,
}: {
  kind: ToolKind;
  activity: ToolActivity;
  status: ToolTrace["status"];
}) {
  if (kind === "bash") {
    return (
      <BashView
        command={activity.command}
        output={activity.body}
        running={status === "running"}
        failed={status === "error"}
      />
    );
  }
  if (status === "error") {
    return <pre className="tool-error">{activity.body || "执行失败"}</pre>;
  }
  if (kind === "read") return <ReadView body={activity.body} running={status === "running"} />;
  if (kind === "edit" || kind === "write") {
    return (
      <>
        {activity.body && activity.diff ? <p className="tool-note">{activity.body}</p> : null}
        {activity.diff ? (
          <DiffView diff={activity.diff} />
        ) : activity.body ? (
          <p className="tool-note">{activity.body}</p>
        ) : status === "running" ? (
          <p className="tool-wait">{kind === "edit" ? "正在修改" : "正在写入"}</p>
        ) : (
          <p className="tool-wait">没有差异</p>
        )}
      </>
    );
  }
  if (activity.body) return <pre className="tool-note">{activity.body}</pre>;
  if (status === "running") return <p className="tool-wait">正在执行</p>;
  return null;
}

function BashView({
  command,
  output,
  running,
  failed,
}: {
  command?: string;
  output?: string;
  running: boolean;
  failed: boolean;
}) {
  return (
    <div className={`tool-terminal${failed ? " failed" : ""}`}>
      {command ? (
        <div className="tool-terminal-cmd">
          <span className="tool-terminal-prompt">$</span>
          <span>{command}</span>
        </div>
      ) : null}
      {output ? (
        <pre className="tool-terminal-out">{output}</pre>
      ) : (
        <div className="tool-terminal-wait">{running ? "运行中" : "无输出"}</div>
      )}
    </div>
  );
}

function ReadView({ body, running }: { body?: string; running: boolean }) {
  if (!body) return <p className="tool-wait">{running ? "正在读取" : "文件是空的"}</p>;
  if (body.startsWith("Read image file")) return <pre className="tool-note">{body}</pre>;
  const presented = presentRead(body);
  if (presented.lines.length === 0) return <p className="tool-wait">文件是空的</p>;
  return (
    <div className="tool-sheet">
      {presented.lines.map((line, index) => (
        <div className="tool-code-line" key={index}>
          <span className="tool-gutter">{presented.start + index}</span>
          <span className="tool-code-text">{line || " "}</span>
        </div>
      ))}
      {presented.notice ? <div className="tool-sheet-note">{presented.notice}</div> : null}
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const rows = parseDiff(diff);
  if (rows.length === 0) return <p className="tool-wait">没有差异</p>;
  return (
    <div className="tool-sheet">
      {rows.map((row, index) =>
        row.kind === "gap" ? (
          <div className="tool-diff-gap" key={index}>
            {row.text}
          </div>
        ) : (
          <div className={`tool-code-line tool-diff-line ${row.kind}`} key={index}>
            <span className="tool-gutter">
              <span className="tool-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</span>
              {row.gutter}
            </span>
            <span className="tool-code-text">{row.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}

function StatusMark({ status }: { status: ToolTrace["status"] }) {
  if (status === "running") return <span className="tool-spinner" role="status" aria-label="运行中" />;
  if (status === "error") {
    return (
      <span className="tool-status-mark error" role="img" aria-label="失败">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    );
  }
  return (
    <span className="tool-status-mark done" role="img" aria-label="完成">
      <CheckIcon size={12} />
    </span>
  );
}

function KindIcon({ kind }: { kind: ToolKind }): ReactNode {
  if (kind === "bash") return <TerminalIcon size={13} />;
  if (kind === "read") return <EyeIcon size={13} />;
  if (kind === "edit") return <PencilIcon size={13} />;
  if (kind === "write") return <FilePlusIcon size={13} />;
  return <TerminalIcon size={13} />;
}

function toolLabel(name: string, kind: ToolKind): string {
  if (name === "submit_plan") return "计划";
  if (name === "record_goal_validation") return "验证";
  if (name === "update_goal") return "目标";
  if (name === "complete_step") return "步骤";
  return kindLabels[kind];
}

function toolKind(name: string): ToolKind {
  if (name === "bash" || name === "read" || name === "edit" || name === "write") return name;
  return "other";
}

function subjectOf(kind: ToolKind, activity: ToolActivity, name: string): { name: string; dir: string } {
  if (kind === "bash") {
    const command = activity.command?.replace(/\s+/g, " ").trim();
    return { name: command || "命令", dir: "" };
  }
  const path = activity.path?.trim();
  if (!path) {
    if (
      name === "submit_plan" ||
      name === "record_goal_validation" ||
      name === "update_goal" ||
      name === "complete_step"
    ) {
      const line = activity.body?.split("\n").find((item) => item.trim())?.trim();
      return { name: line || name, dir: "" };
    }
    return { name, dir: "" };
  }
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return { name: path, dir: "" };
  return { name: normalized.slice(index + 1), dir: normalized.slice(0, index) };
}

function diffStat(diff: string | undefined): { added: number; removed: number } | null {
  if (!diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  if (added === 0 && removed === 0) return null;
  return { added, removed };
}

/** 汇总一组工具的 diff 增删行数,全部为空时返回 null。 */
function totalDiffStat(tools: ToolTrace[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  for (const tool of tools) {
    const stat = diffStat(tool.activity?.diff);
    if (stat) {
      added += stat.added;
      removed += stat.removed;
    }
  }
  if (added === 0 && removed === 0) return null;
  return { added, removed };
}

function readLineCount(body: string | undefined): number | null {
  if (!body || body.startsWith("Read image file")) return null;
  const presented = presentRead(body);
  return presented.lines.length;
}

interface PresentedRead {
  lines: string[];
  notice: string | null;
  start: number;
}

function presentRead(body: string): PresentedRead {
  const matched = body.match(
    /\n\n\[(Showing lines (\d+)-\d+ of \d+[\s\S]*?|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/,
  );
  if (!matched || matched.index === undefined) {
    return { lines: splitLines(body), notice: null, start: 1 };
  }
  const start = matched[2] ? Number(matched[2]) : 1;
  return { lines: splitLines(body.slice(0, matched.index)), notice: matched[1] ?? null, start };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface DiffRow {
  kind: "add" | "del" | "ctx" | "gap";
  gutter: string;
  text: string;
}

/** Pi 的展示 diff 形如 `+ 12 new line`；中间省略的上下文是一行 `...`。 */
function parseDiff(diff: string): DiffRow[] {
  return diff
    .split("\n")
    .filter((line, index, all) => line.length > 0 || index < all.length - 1)
    .map((line) => {
      if (line.trim() === "..." || line.trim() === "…") return { kind: "gap", gutter: "", text: "…" };
      if (line.startsWith("…")) return { kind: "gap", gutter: "", text: line };
      const matched = /^([+\- ]) *(\d+) (.*)$/.exec(line);
      if (matched) {
        const sign = matched[1];
        const kind = sign === "+" ? "add" : sign === "-" ? "del" : "ctx";
        return { kind, gutter: matched[2] ?? "", text: matched[3] ?? "" };
      }
      if (line.startsWith("@@")) return { kind: "gap", gutter: "", text: line };
      if (line.startsWith("+") && !line.startsWith("+++")) return { kind: "add", gutter: "", text: line.slice(1) };
      if (line.startsWith("-") && !line.startsWith("---")) return { kind: "del", gutter: "", text: line.slice(1) };
      if (line.startsWith(" ")) return { kind: "ctx", gutter: "", text: line.slice(1) };
      return { kind: "ctx", gutter: "", text: line };
    });
}

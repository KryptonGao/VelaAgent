import type { SubagentKind, ToolActivity, ToolStep } from "@vela/shared";

const maxChars = 80_000;

/** 工具开始时能确定的内容：命令或路径。文件正文和 diff 要等执行结束。 */
export function activityFromCall(toolName: string, args: unknown): ToolActivity {
  if (toolName === "task") return taskCallActivity(args);
  const command = readString(args, "command");
  const path = readString(args, "path") ?? readString(args, "file_path");
  if (toolName === "bash") return command ? { command } : {};
  if (toolName === "read" || toolName === "edit" || toolName === "write") return path ? { path } : {};
  const summary = modeToolSummary(toolName, args);
  if (summary) return { body: summary };
  if (command) return { command };
  if (path) return { path };
  return {};
}

/** bash 执行过程中的增量输出，或 task 子代理的步骤快照。没有可展示内容时不发事件。 */
export function activityFromOutput(result: unknown, toolName?: string): ToolActivity | null {
  if (toolName === "task") return taskProgressActivity(result);
  const text = textOf(result);
  if (!text) return null;
  return { body: clip(text) };
}

/** 工具结束后的完整展示：命令、输出、diff 或文件正文。 */
export function activityFromExecution(
  toolName: string,
  args: unknown,
  result: unknown,
  isError: boolean,
): ToolActivity {
  if (toolName === "task") return taskExecutionActivity(args, result, isError);
  const call = activityFromCall(toolName, args);
  const text = textOf(result);
  if (isError) {
    return { command: call.command, path: call.path, body: clip(text) || "执行失败" };
  }
  if (toolName === "bash") return { command: call.command, body: clip(text) };
  if (toolName === "read") return { path: call.path, body: clip(text) };
  if (toolName === "ask_user_question") {
    const summary = modeToolSummary(toolName, args);
    const answer = readAnswer(detailsOf(result));
    const lines = [summary ?? ""];
    if (answer !== undefined) {
      lines.push(answer === null ? "用户没有回答" : `用户回答：${answer}`);
    } else if (text) {
      lines.push(text);
    }
    return { body: clip(lines.filter((line) => line.length > 0).join("\n")) || "等待用户回答" };
  }
  if (toolName === "submit_plan") {
    return { body: planSummary(args) || clip(text) || "已提交计划" };
  }
  const summary = modeToolSummary(toolName, args);
  if (summary) {
    return { body: clip(text) || summary };
  }
  if (toolName === "edit" || toolName === "write") {
    const details = detailsOf(result);
    const stored = readDiff(details);
    const note = readNote(details);
    const diff = stored !== null ? clip(stored) : toolName === "write" ? addedDiff(readString(args, "content") ?? "") : "";
    const shown = diff || undefined;
    return {
      path: call.path,
      diff: shown,
      body: note ?? (shown ? undefined : text ? clip(text) : undefined),
    };
  }
  return { command: call.command, path: call.path, body: text ? clip(text) : undefined };
}

const maxTaskSteps = 40;

function taskCallActivity(args: unknown): ToolActivity {
  const agent = readAgent(args);
  return {
    ...(agent ? { agent } : {}),
    body: oneLine(readString(args, "task") ?? ""),
  };
}

/** 进行中的更新只带步骤，避免盖掉标题行上的任务摘要。 */
function taskProgressActivity(result: unknown): ToolActivity | null {
  const details = detailsOf(result);
  const agent = readAgent(details);
  const steps = readSteps(details);
  if (!agent && !steps) return null;
  const mutated = readMutated(details);
  return {
    ...(agent ? { agent } : {}),
    ...(steps ? { steps } : {}),
    ...(mutated ? { mutated } : {}),
  };
}

function taskExecutionActivity(args: unknown, result: unknown, isError: boolean): ToolActivity {
  const details = detailsOf(result);
  const agent = readAgent(args) ?? readAgent(details);
  const steps = readSteps(details);
  const mutated = readMutated(details);
  const title = oneLine(readString(args, "task") ?? "");
  const text = textOf(result);
  const summary = isError ? text || "执行失败" : text;
  const body = summary && summary !== title ? `${title}\n\n${clip(summary)}` : title;
  return {
    ...(agent ? { agent } : {}),
    ...(steps ? { steps } : {}),
    ...(mutated ? { mutated } : {}),
    body,
  };
}

function oneLine(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (!single) return "子代理";
  return single.length > 500 ? `${single.slice(0, 500)}…` : single;
}

function readAgent(source: unknown): SubagentKind | undefined {
  if (!source || typeof source !== "object") return undefined;
  const agent = (source as { agent?: unknown }).agent;
  return agent === "explore" || agent === "general" ? agent : undefined;
}

function readSteps(details: unknown): ToolStep[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as { steps?: unknown }).steps;
  if (!Array.isArray(value)) return undefined;
  const steps: ToolStep[] = [];
  for (const item of value) {
    const step = readStep(item);
    if (step) steps.push(step);
  }
  return steps.slice(-maxTaskSteps);
}

function readStep(value: unknown): ToolStep | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; name?: unknown; summary?: unknown; status?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const summary = typeof record.summary === "string" ? record.summary : "";
  const status = record.status === "running" || record.status === "done" || record.status === "error"
    ? record.status
    : null;
  if (!id || !name || !status) return null;
  return { id, name, summary, status };
}

function readMutated(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  return (details as { mutated?: unknown }).mutated === true;
}

function addedDiff(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const limited = normalized.length > maxChars;
  const source = limited ? normalized.slice(0, maxChars) : normalized;
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return "";
  const width = String(lines.length).length;
  const diff = lines.map((line, index) => `+${String(index + 1).padStart(width, " ")} ${line}`).join("\n");
  return limited ? `${diff}\n… 内容过长，已截断` : diff;
}

function clip(text: string): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… 内容过长，已截断`;
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function detailsOf(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  return (result as { details?: unknown }).details;
}

function readDiff(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : null;
}

function readNote(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const note = (details as { note?: unknown }).note;
  return typeof note === "string" && note.trim() ? note.trim() : undefined;
}

/** ask_user_question 工具 details 里的用户答案;missing 为 undefined,跳过为 null。 */
function readAnswer(details: unknown): string | null | undefined {
  if (!details || typeof details !== "object") return undefined;
  const answer = (details as { answer?: unknown }).answer;
  if (answer === null) return null;
  return typeof answer === "string" && answer.trim() ? answer : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function modeToolSummary(toolName: string, args: unknown): string | null {
  if (toolName === "ask_user_question") {
    const question = readString(args, "question")?.trim();
    if (!question) return null;
    return [question, ...readOptionLabels(args, "options").map((label) => `· ${label}`)].join("\n");
  }
  if (toolName === "submit_plan") return planSummary(args);
  if (toolName === "record_goal_validation") {
    const risk = readString(args, "risk");
    const counts = (key: string) => {
      if (!args || typeof args !== "object") return 0;
      const value = (args as Record<string, unknown>)[key];
      return Array.isArray(value) ? value.length : 0;
    };
    const riskLabel = risk === "high" ? "高风险" : risk === "medium" ? "中风险" : "低风险";
    return `${riskLabel} · 检查 ${counts("checks")} 项 · 跳过 ${counts("skipped")} 项 · 已知问题 ${counts("knownIssues")} 项`;
  }
  if (toolName === "update_goal") {
    const status = readString(args, "status");
    const label = status === "complete" ? "完成" : status === "active" ? "进行中" : status;
    const note = readString(args, "note")?.trim();
    const lines = [label, note].filter((line): line is string => Boolean(line));
    return lines.length > 0 ? lines.join("\n") : null;
  }
  if (toolName === "complete_step") {
    const id = readString(args, "id")?.trim();
    return id ? `完成步骤 ${id}` : "完成步骤";
  }
  return null;
}

/** 计划卡片只展示概括：标题、概述、每步一句。 */
function planSummary(args: unknown): string | null {
  const title = singleLine(readString(args, "title") ?? "");
  const overview = singleLine(readString(args, "overview") ?? "");
  const steps = readStrings(args, "steps").map(singleLine).filter((step) => step.length > 0);
  const lines = [title, overview, ...steps.map((step, index) => `${index + 1}. ${step}`)].filter(
    (line) => line.length > 0,
  );
  return lines.length > 0 ? lines.join("\n") : null;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readStrings(source: unknown, key: string): string[] {
  if (!source || typeof source !== "object") return [];
  const value = (source as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

/** 读取选项数组里每项的 label,用于提问卡片的展示摘要。 */
function readOptionLabels(source: unknown, key: string): string[] {
  if (!source || typeof source !== "object") return [];
  const value = (source as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === "object" ? readString(item, "label")?.trim() : undefined))
    .filter((item): item is string => Boolean(item));
}

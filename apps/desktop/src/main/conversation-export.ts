import {
  localizeZh,
  redactSensitive,
  type AppLocale,
  type CheckpointTimeline,
  type ConversationExportOptions,
  type TraceNode,
  type TraceSnapshot,
  type TranscriptMessage,
  type TranscriptTool,
} from "@vela/shared";
import { homedir } from "node:os";
import { exportAssistantText, UiExportNumbering, type UiStateReader } from "./intelligent-ui-export";

export interface ConversationExportInput {
  conversation: { id: string; title: string; cwd: string; createdAt: number; updatedAt: number };
  messages: readonly TranscriptMessage[];
  /** Null when the trace is excluded or unavailable. */
  trace: TraceSnapshot | null;
  /** Full text of failed trace nodes, by node id. */
  failureDetails?: ReadonlyMap<string, string>;
  /** Null when the workspace has no file checkpoints. */
  checkpoints: CheckpointTimeline | null;
  locale: AppLocale;
  appVersion: string;
  /** Reads the renderer's saved Intelligent UI state so exported UI shows the user's last inputs. */
  readUiState?: UiStateReader;
  exportedAt?: Date;
  homeDir?: string;
}

/** Renderer input is untrusted: only the known flags survive. */
export function parseExportOptions(raw: unknown): ConversationExportOptions {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (input.format !== "markdown" && input.format !== "html") throw new Error("导出格式不正确");
  return {
    format: input.format,
    includeTrace: input.includeTrace === true,
    includeThinking: input.includeThinking === true,
    includeDiffs: input.includeDiffs === true,
  };
}

/** What the exporter reads: the options plus nothing else, so the renderer cannot widen the output. */
export type ConversationExportSettings = ConversationExportOptions;

type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { t: "text"; text: string }
  | { t: "quote"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; items: string[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "details"; summary: string; blocks: Block[] };

const bodyLimit = 4000;
const compactBodyLimit = 1200;
const failureLimit = 2000;
const timelineLimit = 1000;
const noBodyTools = new Set(["read", "update_plan"]);

const pad = (value: number) => String(value).padStart(2, "0");

/** UTC, so a postmortem reads the same on every machine. */
export function exportTimestamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
}

function clip(text: string, limit: number, label: (omitted: number) => string): string {
  return text.length > limit ? `${text.slice(0, limit)}\n${label(text.length - limit)}` : text;
}

function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^\+(?!\+\+)\s*\d+ /.test(line)) added += 1;
    else if (/^-(?!--)\s*\d+ /.test(line)) removed += 1;
  }
  return { added, removed };
}

function relativePath(path: string, cwd: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

interface FileTotals { path: string; added: number; removed: number; edits: number }

interface Turn {
  index: number;
  user: TranscriptMessage | null;
  assistants: TranscriptMessage[];
}

/** One turn per visible user message; assistant messages before the first user message form turn 0. */
function splitTurns(messages: readonly TranscriptMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ index: turns.length, user: message, assistants: [] });
    else {
      if (turns.length === 0) turns.push({ index: 0, user: null, assistants: [] });
      turns.at(-1)!.assistants.push(message);
    }
  }
  return turns;
}

function toolHeadline(tool: TranscriptTool): string {
  const { activity } = tool;
  const name = activity.mcp ? `${activity.mcp.server}/${activity.mcp.tool}` : tool.name;
  const subject = activity.command?.split("\n")[0] ?? activity.path ?? "";
  return subject ? `${name} · ${subject.length > 160 ? `${subject.slice(0, 160)}…` : subject}` : name;
}

/** Builds the document model once; both formats render the same blocks. */
function buildBlocks(input: ConversationExportInput, settings: ConversationExportSettings): Block[] {
  const t = (zh: string, en: string, ...args: unknown[]): string =>
    localizeZh(input.locale, zh, en).replace(/\{(\d+)\}/g, (match, index: string) => (args[Number(index)] === undefined ? match : String(args[Number(index)])));
  const clipLabel = (omitted: number) => `… ${t("输出已截断,省略 {0} 个字符", "output truncated, {0} characters omitted", omitted)}`;
  const turns = splitTurns(input.messages);
  const checkpointTurns = input.checkpoints?.turns ?? [];
  const blocks: Block[] = [];

  // Aggregate first: the overview and the per-file table need the totals before the turns are written.
  const files = new Map<string, FileTotals>();
  let toolCalls = 0;
  const failedTools: { turn: number; tool: TranscriptTool }[] = [];
  for (const turn of turns) {
    for (const message of turn.assistants) {
      for (const tool of message.tools) {
        toolCalls += 1;
        if (tool.status === "error") failedTools.push({ turn: turn.index, tool });
        if (tool.status !== "done" || (tool.name !== "edit" && tool.name !== "write") || !tool.activity.path) continue;
        const path = relativePath(tool.activity.path, input.conversation.cwd);
        const totals = files.get(path) ?? { path, added: 0, removed: 0, edits: 0 };
        const counts = tool.activity.diff ? diffCounts(tool.activity.diff) : { added: 0, removed: 0 };
        totals.added += counts.added;
        totals.removed += counts.removed;
        totals.edits += 1;
        files.set(path, totals);
      }
    }
  }
  const fileList = [...files.values()];
  const added = fileList.reduce((sum, file) => sum + file.added, 0);
  const removed = fileList.reduce((sum, file) => sum + file.removed, 0);
  const trace = input.trace;
  const failedNodes = trace?.nodes.filter(node => node.status === "Failed" || node.status === "Interrupted") ?? [];

  blocks.push({ t: "heading", level: 1, text: input.conversation.title.trim() || t("未命名对话", "Untitled chat") });
  blocks.push({
    t: "table",
    head: [t("项目", "Item"), t("内容", "Value")],
    rows: [
      [t("导出时间", "Exported"), exportTimestamp((input.exportedAt ?? new Date()).getTime())],
      [t("对话 ID", "Conversation ID"), input.conversation.id],
      [t("工作区", "Workspace"), input.conversation.cwd],
      [t("创建时间", "Created"), exportTimestamp(input.conversation.createdAt)],
      [t("更新时间", "Updated"), exportTimestamp(input.conversation.updatedAt)],
      ["Vela", input.appVersion],
    ],
  });

  const overview: string[][] = [
    [t("对话轮数", "Turns"), String(turns.filter(turn => turn.user).length)],
    [t("工具调用", "Tool calls"), String(toolCalls)],
    [t("失败的工具调用", "Failed tool calls"), String(failedTools.length)],
    [t("修改的文件", "Files changed"), String(fileList.length)],
    [t("新增 / 删除行", "Lines added / removed"), `+${added} / −${removed}`],
  ];
  if (trace) {
    const tokens = trace.requests.reduce((sum, request) => sum + (request.usage?.totalTokens ?? 0), 0);
    const spent = trace.requests.reduce((sum, request) => sum + (request.durationMs ?? 0), 0);
    overview.push([t("模型请求", "Model requests"), `${trace.requests.length} · ${duration(spent)}`]);
    overview.push([t("总 token", "Total tokens"), tokens.toLocaleString("en-US")]);
  }
  blocks.push({ t: "heading", level: 2, text: t("概览", "Overview") });
  blocks.push({ t: "table", head: [t("项目", "Item"), t("内容", "Value")], rows: overview });

  if (failedTools.length > 0 || failedNodes.length > 0) {
    blocks.push({ t: "heading", level: 2, text: t("失败与中断", "Failures") });
    if (failedTools.length > 0) {
      blocks.push({
        t: "list",
        items: failedTools.map(({ turn, tool }) => {
          const reason = (tool.activity.body ?? "").replace(/\s+/g, " ").trim();
          return `${t("第 {0} 轮", "Turn {0}", turn + 1)} · ${toolHeadline(tool)}${reason ? ` — ${reason.length > 240 ? `${reason.slice(0, 240)}…` : reason}` : ""}`;
        }),
      });
    }
    for (const node of failedNodes) {
      const text = input.failureDetails?.get(node.id) ?? node.summary;
      blocks.push({
        t: "details",
        summary: `${t("第 {0} 轮", "Turn {0}", node.turn)} · ${node.kind}${node.toolName ? ` · ${node.toolName}` : ""} · ${node.status}`,
        blocks: [{ t: "code", lang: "", text: clip(text, failureLimit, clipLabel) }],
      });
    }
  }

  if (fileList.length > 0) {
    blocks.push({ t: "heading", level: 2, text: t("文件变更", "File changes") });
    blocks.push({
      t: "table",
      head: [t("文件", "File"), "+", "−", t("编辑次数", "Edits")],
      rows: fileList.map(file => [file.path, String(file.added), String(file.removed), String(file.edits)]),
    });
  }

  blocks.push({ t: "heading", level: 2, text: t("对话记录", "Conversation") });
  const uiNumbering = new UiExportNumbering();
  const uiContext = {
    conversationId: input.conversation.id,
    readUiState: input.readUiState,
    label: t("交互界面（静态文字版）", "Interactive UI (static text)"),
    omitted: t("[交互界面无法导出]", "[Interactive UI could not be exported]"),
  };
  for (const turn of turns) {
    blocks.push({ t: "heading", level: 3, text: t("第 {0} 轮", "Turn {0}", turn.index + 1) });
    if (turn.user) {
      const stamp = turn.user.timestamp === null ? "" : ` · ${exportTimestamp(turn.user.timestamp)}`;
      blocks.push({ t: "text", text: `**${t("用户", "User")}**${stamp}` });
      if (turn.user.text.trim()) blocks.push({ t: "quote", text: turn.user.text });
      const images = turn.user.images?.length ?? 0;
      if (images > 0) blocks.push({ t: "text", text: t("[{0} 张图片已省略]", "[{0} image(s) omitted]", images) });
    }
    for (const message of turn.assistants) {
      const stamp = message.timestamp === null ? "" : ` · ${exportTimestamp(message.timestamp)}`;
      const uiMessageId = uiNumbering.next(message.text);
      if (settings.includeThinking && message.thinking.trim()) {
        blocks.push({ t: "details", summary: t("思考过程", "Thinking"), blocks: [{ t: "text", text: message.thinking }] });
      }
      if (message.text.trim()) {
        blocks.push({ t: "text", text: `**${t("助手", "Assistant")}**${stamp}` });
        blocks.push({ t: "text", text: exportAssistantText(message.text, uiMessageId, uiContext) });
      }
      for (const tool of message.tools) blocks.push(...toolBlocks(tool, input.conversation.cwd, settings, clipLabel));
    }
    const checkpoint = checkpointTurns[turn.index];
    if (checkpoint?.changedFiles && checkpoint.changedFiles.length > 0) {
      blocks.push({ t: "text", text: `**${t("本轮检查点记录的文件改动", "Files changed in this turn (checkpoint)")}**` });
      blocks.push({ t: "list", items: checkpoint.changedFiles });
    }
  }

  if (trace && settings.includeTrace) blocks.push(...traceBlocks(trace, t));
  return blocks;
}

function toolBlocks(
  tool: TranscriptTool,
  cwd: string,
  settings: ConversationExportSettings,
  clipLabel: (omitted: number) => string,
): Block[] {
  const { activity } = tool;
  const mark = tool.status === "error" ? "✗" : "✓";
  const summary = `${mark} ${toolHeadline(tool)}`;
  const inner: Block[] = [];
  if (activity.command && activity.command.includes("\n")) inner.push({ t: "code", lang: "bash", text: activity.command });
  if (settings.includeDiffs && activity.diff && (tool.name === "edit" || tool.name === "write")) {
    const path = activity.path ? relativePath(activity.path, cwd) : "";
    const counts = diffCounts(activity.diff);
    inner.push({ t: "text", text: `${path ? `\`${path}\` ` : ""}(+${counts.added} −${counts.removed})` });
    inner.push({ t: "code", lang: "diff", text: activity.diff });
  } else if (activity.body && !noBodyTools.has(tool.name)) {
    const limit = tool.name === "bash" || tool.status === "error" ? bodyLimit : compactBodyLimit;
    inner.push({ t: "code", lang: "", text: clip(activity.body, limit, clipLabel) });
  }
  return inner.length > 0 ? [{ t: "details", summary, blocks: inner }] : [{ t: "list", items: [summary] }];
}

function traceBlocks(trace: TraceSnapshot, t: (zh: string, en: string, ...args: unknown[]) => string): Block[] {
  const blocks: Block[] = [{ t: "heading", level: 2, text: t("轨迹", "Trace") }];
  if (trace.warning) blocks.push({ t: "text", text: trace.warning });
  if (trace.requests.length > 0) {
    blocks.push({ t: "heading", level: 3, text: t("模型请求", "Model requests") });
    blocks.push({
      t: "table",
      head: ["#", t("轮", "Turn"), t("模型", "Model"), t("状态", "Status"), t("耗时", "Duration"), t("首 token", "First token"), t("输入", "Input"), t("输出", "Output"), t("缓存读取", "Cache read")],
      rows: trace.requests.map(request => [
        String(request.number), String(request.turn), request.model, request.status, duration(request.durationMs), duration(request.firstTokenMs),
        request.usage ? String(request.usage.input) : "–", request.usage ? String(request.usage.output) : "–", request.usage ? String(request.usage.cacheRead) : "–",
      ]),
    });
  }
  const nodes: TraceNode[] = trace.nodes.filter(node => node.kind !== "state" || node.status !== "Completed");
  if (nodes.length > 0) {
    blocks.push({ t: "heading", level: 3, text: t("时间线", "Timeline") });
    if (nodes.length > timelineLimit) blocks.push({ t: "text", text: t("时间线过长,仅列出前 {0} 条", "Timeline truncated to the first {0} entries", timelineLimit) });
    blocks.push({
      t: "table",
      head: ["#", t("轮", "Turn"), t("类型", "Kind"), t("工具", "Tool"), t("状态", "Status"), t("耗时", "Duration"), t("摘要", "Summary")],
      rows: nodes.slice(0, timelineLimit).map(node => [
        String(node.sequence), String(node.turn), node.kind,
        node.mcp ? `${node.mcp.server}/${node.mcp.tool}` : (node.toolName ?? ""),
        node.status, duration(node.durationMs), node.summary.length > 160 ? `${node.summary.slice(0, 160)}…` : node.summary,
      ]),
    });
  }
  return blocks;
}

// ── Markdown ────────────────────────────────────────────────────────────────

/** A fence longer than any backtick run in the content, so output containing ``` cannot close it early. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  return "`".repeat(longest + 1);
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function markdownBlock(block: Block): string {
  switch (block.t) {
    case "heading": return `${"#".repeat(block.level)} ${block.text.replace(/\s+/g, " ")}`;
    case "text": return block.text;
    case "quote": return block.text.split("\n").map(line => `> ${line}`.trimEnd()).join("\n");
    case "code": { const f = fence(block.text); return `${f}${block.lang}\n${block.text}\n${f}`; }
    case "list": return block.items.map(item => `- ${item.replace(/\n/g, " ")}`).join("\n");
    case "table":
      return [`| ${block.head.map(cell).join(" | ")} |`, `| ${block.head.map(() => "---").join(" | ")} |`, ...block.rows.map(row => `| ${row.map(cell).join(" | ")} |`)].join("\n");
    case "details":
      return `<details>\n<summary>${escapeHtml(block.summary)}</summary>\n\n${block.blocks.map(markdownBlock).join("\n\n")}\n\n</details>`;
  }
}

// ── HTML ────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineHtml(text: string): string {
  return escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/** Assistant and thinking text is Markdown; fenced code is kept as code, the rest keeps its line breaks. */
function proseHtml(text: string): string {
  const parts = text.split(/^(```[^\n]*\n[\s\S]*?\n```)[ \t]*$/m);
  return parts.map(part => {
    const code = /^```([^\n]*)\n([\s\S]*?)\n```$/.exec(part);
    if (code) return `<pre><code>${escapeHtml(code[2] ?? "")}</code></pre>`;
    return part.trim() ? `<div class="prose">${inlineHtml(part.trim())}</div>` : "";
  }).join("");
}

function diffHtml(text: string): string {
  const lines = text.split("\n").map(line => {
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    return `<span class="${kind}">${escapeHtml(line)}</span>`;
  });
  // Each span is display:block; a newline between them would render as an extra blank line inside <pre>.
  return `<pre class="diff"><code>${lines.join("")}</code></pre>`;
}

function htmlBlock(block: Block): string {
  switch (block.t) {
    case "heading": return `<h${block.level}>${escapeHtml(block.text.replace(/\s+/g, " "))}</h${block.level}>`;
    case "text": return proseHtml(block.text);
    case "quote": return `<blockquote>${escapeHtml(block.text)}</blockquote>`;
    case "code": return block.lang === "diff" ? diffHtml(block.text) : `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    case "list": return `<ul>${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    case "table":
      return `<div class="table"><table><thead><tr>${block.head.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    case "details":
      return `<details><summary>${escapeHtml(block.summary)}</summary>${block.blocks.map(htmlBlock).join("")}</details>`;
  }
}

const htmlStyle = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e3e3e8;--panel:#f5f5f7;--add:#e6f6ea;--add-fg:#1a7f37;--del:#fdecec;--del-fg:#c62828}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--muted:#98989f;--line:#38383a;--panel:#2c2c2e;--add:#12301d;--add-fg:#6fd68c;--del:#3a1b1b;--del-fg:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:26px;margin:0 0 16px}h2{font-size:20px;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:24px 0 8px}h4{font-size:14px;margin:16px 0 6px}
.table{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:5px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
code,pre{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:var(--panel);padding:1px 5px;border-radius:4px}
pre{background:var(--panel);padding:10px 12px;border-radius:8px;overflow-x:auto;margin:8px 0}pre code{background:none;padding:0}
.diff .add{display:block;background:var(--add);color:var(--add-fg)}.diff .del{display:block;background:var(--del);color:var(--del-fg)}.diff .ctx{display:block}
blockquote{margin:8px 0;padding:8px 14px;border-left:3px solid var(--line);background:var(--panel);border-radius:0 8px 8px 0;white-space:pre-wrap}
.prose{white-space:pre-wrap;margin:6px 0}details{margin:6px 0;border:1px solid var(--line);border-radius:8px;padding:6px 12px}
summary{cursor:pointer;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}ul{margin:6px 0;padding-left:22px}li{margin:2px 0}
footer{margin-top:48px;color:var(--muted);font-size:12px}
@media print{details{border:none}details>*{display:block}}
`;

/**
 * redactSensitive covers JSON keys, bearer headers and URL parameters. Exports also carry shell output and pasted
 * environments, so `NAME=value` assignments to secret-looking names and well-known token shapes are masked too.
 * The key must *end* in the secret word, so `max_tokens: 4096` survives.
 */
const assignedSecret = /\b([\w.-]*(?:token|secret|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key))(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi;
const knownTokens = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g;

function rewrite(text: string, input: ConversationExportInput): string {
  const home = input.homeDir ?? homedir();
  const redacted = (redactSensitive(text) as string)
    .replace(assignedSecret, (_match, key: string, separator: string) => `${key}${separator}••••••••`)
    .replace(knownTokens, "••••••••");
  return home.length > 1 ? redacted.split(home).join("~") : redacted;
}

/** Renders the conversation, its tool diffs and (optionally) the trace. Secrets and the home directory are scrubbed from the result. */
export function buildConversationExport(input: ConversationExportInput, settings: ConversationExportSettings): string {
  const blocks = buildBlocks(input, settings);
  const footer = localizeZh(input.locale, "由 Vela {0} 导出。导出内容经过自动脱敏,分享前请自行检查。", "Exported by Vela {0}. Content is redacted automatically; review it before sharing.").replace("{0}", input.appVersion);
  if (settings.format === "markdown") {
    return rewrite(`${blocks.map(markdownBlock).join("\n\n")}\n\n---\n\n*${footer}*\n`, input);
  }
  const title = blocks[0]?.t === "heading" ? blocks[0].text : "Vela";
  const lang = input.locale === "zh-CN" ? "zh-CN" : input.locale;
  return rewrite(
    `<!doctype html>\n<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<style>${htmlStyle}</style>\n</head>\n<body>\n<main>\n${blocks.map(htmlBlock).join("\n")}\n<footer>${escapeHtml(footer)}</footer>\n</main>\n</body>\n</html>\n`,
    input,
  );
}

/** `<title>-<UTC date>.md|html`, with characters that are unsafe in file names replaced. */
export function conversationExportFileName(title: string, format: ConversationExportSettings["format"], date = new Date()): string {
  const slug = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim() || "chat";
  return `${slug}-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.${format === "markdown" ? "md" : "html"}`;
}

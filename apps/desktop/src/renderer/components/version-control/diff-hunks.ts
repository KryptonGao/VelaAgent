/**
 * 渲染层的单文件差异解析:文件头 + 代码块分组。
 * 与 packages/workspace 的 diff-hunks 语义一致,但只服务展示与补丁拼装;
 * 服务端仍会用最新 Diff 重新校验,选择过期时拒绝执行。
 */

export interface RenderHunk {
  index: number;
  /** `@@ -a,b +c,d @@` 行 */
  header: string;
  /** 代码块正文行(含 +/-/空格前缀与 `\ No newline` 提示) */
  lines: string[];
}

export interface RenderPatch {
  header: string[];
  hunks: RenderHunk[];
}

export function parseRenderPatch(diff: string): RenderPatch {
  const lines = splitLines(diff);
  const header: string[] = [];
  const hunks: RenderHunk[] = [];
  let current: RenderHunk | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { index: hunks.length, header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  return { header, hunks };
}

/** 用选中代码块拼出单文件补丁,供 stage/unstage/discard 使用。 */
export function buildHunkPatch(patch: RenderPatch, indexes: number[]): string {
  const selected = new Set(indexes);
  const lines = [...patch.header];
  for (const hunk of patch.hunks) {
    if (!selected.has(hunk.index)) continue;
    lines.push(hunk.header, ...hunk.lines);
  }
  return `${lines.join("\n")}\n`;
}

/** 代码块摘要,用于列表里的简短说明。 */
export function hunkLabel(hunk: RenderHunk): string {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
  if (!match) return hunk.header;
  const start = match[1];
  const count = match[2] ? Number(match[2]) : 1;
  return `+${start},${count}`;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 单文件 unified diff 的代码块解析与子集校验。
 *
 * 渲染层把选中的代码块拼成补丁发给主进程;主进程重新读取该文件的最新 Diff,
 * 确认补丁里的每个代码块都仍然存在后才执行,防止把基于旧内容的选择应用到新状态。
 */

export interface PatchHunk {
  /** `@@ -a,b +c,d @@` 行(含可选的函数名提示) */
  header: string;
  /** 代码块正文(上下文、增删行与 `\ No newline at end of file` 提示) */
  lines: string[];
}

export interface PatchFileSection {
  /** 文件级头部:`diff --git`、`index`、`---`/`+++`、模式与重命名信息 */
  header: string[];
  hunks: PatchHunk[];
}

/** 一个 hunk 的指纹:头部与正文逐行一致才算同一个代码块。 */
export function hunkKey(hunk: PatchHunk): string {
  return [hunk.header, ...hunk.lines].join("\n");
}

/**
 * 解析单文件补丁。传入的 diff 可能含多个文件段(diff -M 的重命名场景),
 * 优先选择 newPath 命中的段,只有一个段时直接使用。
 */
export function parsePatchSection(diff: string, path: string): PatchFileSection | null {
  const lines = splitLines(diff);
  const sections = splitFileSections(lines);
  if (sections.length === 0) return null;
  const matched =
    sections.find((section) => sectionMatchesPath(section, path)) ??
    (sections.length === 1 ? sections[0] : undefined);
  if (!matched) return null;

  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const line of matched) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  return { header, hunks };
}

/** 按代码块序号拼出补丁;index 越界时忽略。 */
export function buildPatch(section: PatchFileSection, indexes: number[]): string {
  const selected = indexes
    .filter((index) => index >= 0 && index < section.hunks.length)
    .map((index) => section.hunks[index]!);
  return buildPatchFromHunks(section.header, selected);
}

export function buildPatchFromHunks(header: string[], hunks: PatchHunk[]): string {
  const lines = [...header];
  for (const hunk of hunks) {
    lines.push(hunk.header, ...hunk.lines);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 校验给定补丁的代码块全部包含在最新 Diff 中。
 * 返回缺失代码块的序号;补丁本身无法解析时返回 null。
 */
export function missingHunkIndexes(patch: string, current: PatchFileSection): number[] | null {
  const section = parsePatchSection(patch, "");
  if (!section || section.hunks.length === 0) return null;
  const available = new Set(current.hunks.map(hunkKey));
  const missing: number[] = [];
  section.hunks.forEach((hunk, index) => {
    if (!available.has(hunkKey(hunk))) missing.push(index);
  });
  return missing;
}

function splitFileSections(lines: string[]): string[][] {
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = [line];
      sections.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  return sections;
}

function sectionMatchesPath(section: string[], path: string): boolean {
  const target = `b/${path}`;
  const source = `a/${path}`;
  for (const line of section) {
    if (!line.startsWith("diff --git ")) continue;
    const rest = line.slice("diff --git ".length);
    const bIndex = rest.lastIndexOf(" b/");
    const aPart = bIndex > 0 ? rest.slice(0, bIndex) : rest;
    const bPart = bIndex > 0 ? rest.slice(bIndex + 1) : "";
    if (bPart === target || bPart === source || aPart === source || aPart === target) return true;
    // 带引号的路径(含空格/非 ASCII 时 git 会加引号)。
    if (unquote(bPart) === path || unquote(aPart) === path) return true;
  }
  return false;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  // diff 输出以换行结尾,末尾空元素不属于补丁内容。
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const markdownExtensions = new Set(["md", "markdown", "mdx"]);

export type MarkdownHref =
  | { kind: "external"; href: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string; anchor: string | null }
  | { kind: "ignore" };

/** 侧栏里按渲染视图打开的 Markdown 文件。 */
export function isMarkdownPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return markdownExtensions.has(name.slice(dot + 1).toLowerCase());
}

/** 把标题文本收成稳定的锚点,重复标题由调用方加序号。 */
export function headingSlug(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

/**
 * 按源码行号预计算标题锚点,渲染时只读取。
 * 覆盖 ATX(`#`)与单行 Setext 标题,并跳过围栏代码块。
 */
export function headingIdsByLine(markdown: string): Map<number, string> {
  const ids = new Map<number, string>();
  const counts = new Map<string, number>();
  const lines = markdown.split("\n");
  let fence: string | null = null;

  const assign = (lineNumber: number, raw: string) => {
    const base = headingSlug(headingPlain(raw));
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    ids.set(lineNumber, seen === 0 ? base : `${base}-${seen}`);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2]?.[0] ?? "";
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;

    const atx = /^( {0,3})(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
    if (atx?.[3]) {
      assign(index + 1, atx[3]);
      continue;
    }

    const next = lines[index + 1];
    if (next && line.trim() && /^( {0,3})(=+|-+)[ \t]*$/.test(next) && !isSetextBlocked(line)) {
      assign(index + 1, line.trim());
    }
  }

  return ids;
}

/** 把 Markdown 链接或图片地址解析成外链、页内锚点或工作区文件。 */
export function classifyMarkdownHref(documentPath: string, href: string): MarkdownHref {
  const value = href.trim();
  if (!value || value.includes("\0")) return { kind: "ignore" };

  if (value.startsWith("#")) {
    const id = anchorId(value.slice(1));
    return id ? { kind: "anchor", id } : { kind: "ignore" };
  }

  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (protocol) {
    const scheme = protocol[1]?.toLowerCase() ?? "";
    if (scheme === "http" || scheme === "https" || scheme === "mailto") {
      return { kind: "external", href: value };
    }
    if (scheme === "data" && /^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) {
      return { kind: "external", href: value };
    }
    return { kind: "ignore" };
  }

  const hash = value.indexOf("#");
  const rawPath = (hash >= 0 ? value.slice(0, hash) : value).split("?")[0] ?? "";
  const anchor = hash >= 0 ? anchorId(value.slice(hash + 1).split("?")[0] ?? "") : null;
  if (!rawPath) return anchor ? { kind: "anchor", id: anchor } : { kind: "ignore" };

  const resolved = resolveRelativePath(documentDir(documentPath), rawPath);
  if (!resolved) return { kind: "ignore" };
  return { kind: "file", path: resolved, anchor };
}

function documentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function resolveRelativePath(baseDir: string, raw: string): string | null {
  const target = raw.trim().replaceAll("\\", "/");
  if (!target) return null;
  const fromRoot = target.startsWith("/");
  const parts = fromRoot ? [] : baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    const decoded = decodeSafe(segment);
    if (!decoded || decoded === "." || decoded.includes("/") || decoded.includes("\0")) return null;
    if (decoded === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(decoded);
  }
  if (parts.length === 0) return null;
  // 绝对路径文档(工作区外)的链接解析结果保持绝对形式。
  return (baseDir.startsWith("/") ? "/" : "") + parts.join("/");
}

function headingPlain(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`]/g, "")
    .trim();
}

function isSetextBlocked(line: string): boolean {
  return /^( {0,3})(#|>|[-+*]|[0-9]+[.)])(\s|$)/.test(line);
}

function anchorId(raw: string): string | null {
  const decoded = decodeSafe(raw);
  if (!decoded) return null;
  return headingSlug(decoded);
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  classifyMarkdownHref,
  headingIdsByLine,
  headingSlug,
} from "./markdown-path";
import { highlightSnippet, languageForFence, type ThemedToken } from "./highlighter";
import { useFilePreview } from "./FilePreviewContext";

const remarkPlugins = [remarkGfm, remarkBreaks];
const fontStyleMask = { italic: 1, bold: 2 } as const;

interface PreviewMarkdownContextValue {
  documentPath: string;
  headingIds: Map<number, string>;
  revision: number;
}

const PreviewMarkdownContext = createContext<PreviewMarkdownContextValue | null>(null);

const previewComponents: Components = {
  a: PreviewLink,
  img: PreviewImage,
  code: PreviewCode,
  pre: PreviewPre,
  table: PreviewTable,
  h1: PreviewHeading(1),
  h2: PreviewHeading(2),
  h3: PreviewHeading(3),
  h4: PreviewHeading(4),
  h5: PreviewHeading(5),
  h6: PreviewHeading(6),
};

function previewUrlTransform(url: string): string {
  const value = url.trim();
  if (!value) return "";
  const separator = value.indexOf(":");
  if (separator <= 0) return value;
  const protocol = value.slice(0, separator).toLowerCase();
  if (protocol === "http" || protocol === "https" || protocol === "mailto") return value;
  if (protocol === "data" && /^data:image\//i.test(value)) return value;
  return "";
}

/** 右侧栏里的 Markdown 渲染视图:标题锚点、工作区图片与代码高亮。 */
export function MarkdownPane({
  text,
  documentPath,
  truncated,
  revision,
}: {
  text: string;
  documentPath: string;
  truncated: boolean;
  revision: number;
}) {
  const preview = useFilePreview();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingIds = useMemo(() => headingIdsByLine(text), [text]);
  const scrollKey = `${documentPath}::markdown`;
  const context = useMemo<PreviewMarkdownContextValue>(
    () => ({ documentPath, headingIds, revision }),
    [documentPath, headingIds, revision],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = preview?.getTabScroll(scrollKey) ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  return (
    <PreviewMarkdownContext.Provider value={context}>
      <div
        ref={scrollRef}
        className="preview-markdown-scroll"
        onScroll={(event) => preview?.setTabScroll(scrollKey, event.currentTarget.scrollTop)}
      >
        <div className="md-content">
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            urlTransform={previewUrlTransform}
            components={previewComponents}
          >
            {text}
          </ReactMarkdown>
        </div>
        {truncated ? <p className="preview-markdown-note">文件超过 1 MB,仅显示开头部分。</p> : null}
      </div>
    </PreviewMarkdownContext.Provider>
  );
}

function PreviewHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  return function Heading({
    children,
    node,
  }: {
    children?: ReactNode;
    node?: { position?: { start?: { line?: number } } };
  }) {
    const ctx = useContext(PreviewMarkdownContext);
    const line = node?.position?.start?.line;
    const slug = (line ? ctx?.headingIds.get(line) : undefined) ?? headingSlug(flattenText(children));
    const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return <Tag id={`md-${slug}`}>{children}</Tag>;
  };
}

function PreviewLink({ href, children }: { href?: string; children?: ReactNode }) {
  const preview = useFilePreview();
  const ctx = useContext(PreviewMarkdownContext);
  if (!href || !ctx) return <span>{children}</span>;
  const classified = classifyMarkdownHref(ctx.documentPath, href);
  if (classified.kind === "external") {
    return (
      <a href={classified.href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  if (classified.kind === "anchor") {
    return (
      <a href={`#md-${classified.id}`} onClick={(event) => scrollToHeading(event, classified.id)}>
        {children}
      </a>
    );
  }
  if (classified.kind === "file") {
    const sameFile = classified.path === ctx.documentPath;
    return (
      <a
        href={classified.path}
        onClick={(event) => {
          event.preventDefault();
          if (sameFile) {
            if (classified.anchor) scrollToHeading(event, classified.anchor);
            return;
          }
          preview?.openFile(classified.path);
        }}
      >
        {children}
      </a>
    );
  }
  return <span>{children}</span>;
}

type ImageState = { status: "loading" } | { status: "ready"; src: string } | { status: "missing" };

function PreviewImage({ src, alt }: { src?: string; alt?: string }) {
  const ctx = useContext(PreviewMarkdownContext);
  const documentPath = ctx?.documentPath ?? "";
  const revision = ctx?.revision ?? 0;
  const [resolved, setResolved] = useState<ImageState>({ status: "loading" });

  useEffect(() => {
    if (!src) return;
    const classified = classifyMarkdownHref(documentPath, src);
    if (classified.kind === "external") {
      if (/^(https?:|data:image\/)/i.test(classified.href)) setResolved({ status: "ready", src: classified.href });
      else setResolved({ status: "missing" });
      return;
    }
    if (classified.kind !== "file") {
      setResolved({ status: "missing" });
      return;
    }
    const api = window.vela;
    if (!api) {
      setResolved({ status: "missing" });
      return;
    }
    let active = true;
    setResolved({ status: "loading" });
    api
      .readWorkspaceFile(classified.path)
      .then((content) => {
        if (!active) return;
        if (content.kind === "image" && content.content) setResolved({ status: "ready", src: content.content });
        else setResolved({ status: "missing" });
      })
      .catch(() => {
        if (active) setResolved({ status: "missing" });
      });
    return () => {
      active = false;
    };
  }, [src, documentPath, revision]);

  if (!src) return null;
  if (resolved.status === "loading") {
    return <span className="md-image-pending" role="img" aria-busy="true" aria-label={alt || "正在加载图片"} />;
  }
  if (resolved.status === "ready") return <img src={resolved.src} alt={alt ?? ""} />;
  return <span className="md-image-fallback">{alt || "图片无法显示"}</span>;
}

function PreviewPre({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function PreviewCode({
  className,
  children,
  node,
}: {
  className?: string;
  children?: ReactNode;
  node?: { position?: { start?: { line?: number }; end?: { line?: number } } };
}) {
  const text = flattenText(children).replace(/\n$/, "");
  const start = node?.position?.start?.line;
  const end = node?.position?.end?.line;
  const isBlock = Boolean(className) || text.includes("\n") || (start != null && end != null && end > start);
  if (isBlock) {
    const info = languageName(className);
    return <FencedCode info={info} code={text} />;
  }
  return <InlineCode>{children}</InlineCode>;
}

function InlineCode({ children }: { children?: ReactNode }) {
  const preview = useFilePreview();
  const text = flattenText(children);
  if (!preview || !isLikelyPath(text)) return <code>{children}</code>;
  const filePath = preview.resolveFilePath(text);
  if (!filePath) return <code>{children}</code>;
  return (
    <code
      className="code-file-ref"
      role="button"
      tabIndex={0}
      title={`打开 ${filePath}`}
      onClick={() => preview.openFile(filePath)}
      onKeyDown={(event) => {
        if (event.key === "Enter") preview.openFile(filePath);
      }}
    >
      {children}
    </code>
  );
}

function FencedCode({ info, code }: { info: string; code: string }) {
  const lang = languageForFence(info);
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    if (!lang) return;
    let active = true;
    setLines(null);
    void highlightSnippet(lang, code).then((tokens) => {
      if (active) setLines(tokens);
    });
    return () => {
      active = false;
    };
  }, [lang, code]);

  return (
    <pre className="md-code-block">
      <code>{lines ? <TokenLines lines={lines} /> : code}</code>
    </pre>
  );
}

function TokenLines({ lines }: { lines: ThemedToken[][] }) {
  return lines.map((tokens, index) => (
    <span key={index}>
      {index > 0 ? "\n" : null}
      {tokens.map((token, tokenIndex) => (
        <span key={tokenIndex} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </span>
  ));
}

function PreviewTable({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table-scroll">
      <table>{children}</table>
    </div>
  );
}

function scrollToHeading(event: MouseEvent<HTMLAnchorElement>, slug: string) {
  event.preventDefault();
  const root = event.currentTarget.closest(".preview-markdown-scroll");
  if (!root) return;
  const id = `md-${slug}`;
  for (const node of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (node.id === id && node instanceof HTMLElement) {
      node.scrollIntoView({ block: "start" });
      return;
    }
  }
}

function languageName(className: string | undefined): string {
  if (!className) return "";
  const match = /language-([^\s]+)/.exec(className);
  return match?.[1] ?? "";
}

function tokenStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.fontStyle && token.fontStyle & fontStyleMask.italic) style.fontStyle = "italic";
  if (token.fontStyle && token.fontStyle & fontStyleMask.bold) style.fontWeight = 600;
  return style;
}

function flattenText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flattenText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return flattenText((children as { props: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function isLikelyPath(text: string): boolean {
  const value = text.trim();
  if (value.length < 3 || value.length > 260) return false;
  if (/\s/.test(value)) return false;
  return /\.[A-Za-z0-9]+$/.test(value) || value.includes("/");
}

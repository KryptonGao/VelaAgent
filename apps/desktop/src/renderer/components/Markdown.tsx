import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { memo, useMemo, type ReactNode } from "react";
import { useFilePreview, type FilePreviewContextValue } from "./preview/FilePreviewContext";
import { tr, useAppLocale } from "../locale";

const remarkPlugins = [remarkGfm, remarkBreaks];

const baseComponents: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  table: MarkdownTable,
};

/** 有预览上下文时,内联代码若是工作区里的真实文件路径就变成可点击引用。 */
function withFileReference(preview: FilePreviewContextValue): Components {
  return {
    ...baseComponents,
    code: MarkdownCodeFactory(preview),
  };
}

function MarkdownCodeFactory(preview: FilePreviewContextValue) {
  return function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
    // 代码块(带 language- 前缀或含换行)保持原样。
    if (className || isBlockCode(children)) {
      return (
        <code className={className}>
          {children}
        </code>
      );
    }
    const text = flattenText(children);
    if (!isLikelyPath(text)) return <code>{children}</code>;
    const filePath = preview.resolveFilePath(text);
    if (!filePath) return <code>{children}</code>;
    return (
      <code
        className="code-file-ref"
        role="button"
        tabIndex={0}
        title={`${tr("打开", "Open")} ${filePath}`}
        onClick={() => preview.openFile(filePath)}
        onKeyDown={(event) => {
          if (event.key === "Enter") preview.openFile(filePath);
        }}
      >
        {children}
      </code>
    );
  };
}

function isBlockCode(children: ReactNode): boolean {
  if (Array.isArray(children)) return children.some((child) => typeof child === "string" && child.includes("\n"));
  return typeof children === "string" && children.includes("\n");
}

function flattenText(children: ReactNode): string {
  if (typeof children === "string") return children;
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

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  return <img src={src} alt={alt ?? ""} />;
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table-scroll">
      <table>{children}</table>
    </div>
  );
}

function safeUrl(url: string): string {
  const value = url.trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return "";
  const protocol = value.slice(0, separator).toLowerCase();
  if (protocol === "https" || protocol === "http" || protocol === "mailto") return value;
  return "";
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  useAppLocale();
  const preview = useFilePreview();
  const components = useMemo(
    () => (preview ? withFileReference(preview) : baseComponents),
    [preview],
  );
  return (
    <div className="md-content">
      <ReactMarkdown remarkPlugins={remarkPlugins} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

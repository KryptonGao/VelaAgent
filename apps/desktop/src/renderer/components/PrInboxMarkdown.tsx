import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PrTarget } from '@vela/shared';
import { tr } from '../locale';
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function PrMarkdown({ text, target }: { text: string; target: PrTarget }) {
  const [error, setError] = useState<string | null>(null);
  return <div className="pr-inbox-markdown">{error && <p role="alert">{error}</p>}<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => {
      let safe = false;
      try { const url = new URL(href ?? ''); safe = url.protocol === 'https:' && url.hostname === target.host && url.pathname.toLowerCase().startsWith(`/${target.owner}/${target.repo}/`.toLowerCase()); } catch {}
      return safe ? <a href={href} onClick={e => { e.preventDefault(); void window.vela!.prInbox.open(target, href!).catch(e => setError(message(e))); }}>{children}</a> : <span>{children}{href && <span className="pr-inbox-link-url"> ({href})</span>}</span>;
    },
    img: ({ alt }) => <span>{alt || tr('图片', 'Image')}</span>,
  }}>{text}</ReactMarkdown></div>;
}


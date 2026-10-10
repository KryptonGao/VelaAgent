import { Component, memo, useContext, useId, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import type { UiArtifact } from "@vela/shared";
import { createLogger } from "../../logger";
import { ConversationLinkContext } from "../ConversationLinkContext";
import { artifactText, NodeView } from "./components";
import { uiCopy } from "./copy";
import { UiRuntimeProvider, useUiArtifactState, useUiHost, type UiArtifactRuntime } from "./UiRuntime";

const log = createLogger("intelligent-ui");

/** 单块界面出错只影响自己：显示降级提示，聊天其余部分照常。内容变化时重试。 */
class UiBoundary extends Component<{ resetKey: number; fallback: (error: Error) => ReactNode; children: ReactNode }, { error: Error | null; key: number }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: number }, state: { error: Error | null; key: number }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("interface render failed", Object.assign(error, { componentStack: info.componentStack ?? undefined }));
  }

  render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

function SourceView({ raw, id }: { raw: string; id: string }) {
  return <pre className="iui-source-view" id={id} tabIndex={0}><code>{raw || " "}</code></pre>;
}

function Notice({ title, hint, raw }: { title: string; hint?: string; raw: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="iui-frame iui-frame-invalid" role="group" aria-label={uiCopy.region()}>
    <div className="iui-notice iui-notice-error" role="status">
      <strong>{"⚠ "}{title}</strong>
      {hint ? <div className="iui-description">{hint}</div> : null}
    </div>
    <div className="iui-toolbar iui-toolbar-visible">
      <button type="button" className="iui-tool" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        {open ? uiCopy.hideSource() : uiCopy.viewSource()}</button>
    </div>
    {open ? <SourceView raw={raw} id={id} /> : null}
  </div>;
}

function LiveArtifact({ artifact, raw, messageId, streaming }: { artifact: UiArtifact; raw: string; messageId: string; streaming: boolean }) {
  const baseHost = useUiHost();
  const openConversationLink = useContext(ConversationLinkContext);
  // 外链沿用聊天里已有的链接策略（内嵌浏览器或系统浏览器）。
  const host = useMemo(() => ({ ...baseHost, openLink: (url: string) => openConversationLink?.(url) ?? false }), [baseHost, openConversationLink]);
  const stable = host.stableMessageId(messageId);
  const scope = useMemo(
    () => host.conversationId && stable ? { conversationId: host.conversationId, messageId: stable, artifactId: artifact.artifactId } : null,
    [host.conversationId, stable, artifact.artifactId],
  );
  const { values, env, setValue } = useUiArtifactState(artifact, raw, scope);
  const byId = useMemo(() => new Map(artifact.nodes.map(node => [node.id, node] as const)), [artifact]);
  const runtime: UiArtifactRuntime = useMemo(
    () => ({ artifact, byId, values, env, receiving: artifact.status === "receiving", setValue, host }),
    [artifact, byId, values, env, setValue, host],
  );
  const [copy, setCopy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const sourceId = useId();
  const root = artifact.rootNodeId ? byId.get(artifact.rootNodeId) : undefined;
  const receiving = artifact.status === "receiving";
  const flash = (text: string) => { setCopy(text); setTimeout(() => setCopy(null), 1800); };
  return <div className={`iui-frame${receiving ? " is-receiving" : ""}`} role="group" aria-label={artifact.title || uiCopy.region()} aria-busy={receiving && streaming}>
    {artifact.title ? <div className="iui-title">{artifact.title}</div> : null}
    <UiRuntimeProvider value={runtime}>
      {root ? <NodeView node={root} /> : <div className="iui-skeleton" role="status"><span className="iui-sr-only">{uiCopy.building()}</span></div>}
    </UiRuntimeProvider>
    {receiving && streaming ? <div className="iui-progress-note" aria-hidden="true">{uiCopy.building()}</div> : null}
    {artifact.status === "incomplete" ? <div className="iui-notice iui-notice-warning" role="status">{"⚠ "}{uiCopy.incomplete()}</div> : null}
    <div className="iui-toolbar">
      <button type="button" className="iui-tool" onClick={() => {
        void navigator.clipboard.writeText(artifactText({ artifact, values })).then(() => flash(uiCopy.copied()), () => flash(uiCopy.copyFailed()));
      }}>{copy ?? uiCopy.copyText()}</button>
      <button type="button" className="iui-tool" aria-expanded={open} aria-controls={sourceId} onClick={() => setOpen(value => !value)}>
        {open ? uiCopy.hideSource() : uiCopy.viewSource()}</button>
    </div>
    {open ? <SourceView raw={raw} id={sourceId} /> : null}
  </div>;
}

export const UiArtifactView = memo(function UiArtifactView({ artifact, raw, messageId, streaming }: {
  artifact: UiArtifact; raw: string; messageId: string; streaming: boolean;
}) {
  if (artifact.status === "invalid") {
    return <Notice title={uiCopy.invalidTitle()} hint={`${uiCopy.invalidHint()} (${uiCopy.reason(artifact.reason)})`} raw={raw} />;
  }
  if (artifact.status === "disposed") return null;
  return <UiBoundary resetKey={artifact.revision}
    fallback={() => <Notice title={uiCopy.invalidTitle()} hint={uiCopy.invalidHint()} raw={raw} />}>
    <LiveArtifact artifact={artifact} raw={raw} messageId={messageId} streaming={streaming} />
  </UiBoundary>;
});

import { memo, useMemo, useRef } from "react";
import { mayContainUi, UiStreamParser, type UiSegment } from "@vela/shared";
import { Markdown } from "../Markdown";
import { UiArtifactView } from "./UiArtifactView";

interface ParserState {
  parser: UiStreamParser;
  consumed: string;
}

/**
 * 按到达顺序把一条回复渲染成 Markdown 与交互界面。
 * 解析器是增量的：流式时只喂新增的文字；文字不是在原有基础上追加（例如重试）就整体重解析。
 */
function useUiSegments(text: string, streaming: boolean): UiSegment[] {
  const state = useRef<ParserState | null>(null);
  return useMemo(() => {
    let current = state.current;
    if (!current || current.parser.isFinished || !text.startsWith(current.consumed)) {
      current = { parser: new UiStreamParser(), consumed: "" };
    }
    current.parser.feed(text.slice(current.consumed.length));
    current.consumed = text;
    if (!streaming) current.parser.finish();
    state.current = current;
    return current.parser.segments();
  }, [text, streaming]);
}

function WithUi({ messageId, text, streaming }: { messageId: string; text: string; streaming: boolean }) {
  const segments = useUiSegments(text, streaming);
  const lastIndex = segments.length - 1;
  return <>
    {segments.map((segment, index) => segment.type === "markdown"
      ? <Markdown key={segment.key} text={segment.text} streaming={streaming && index === lastIndex} />
      : <UiArtifactView key={segment.key} artifact={segment.artifact} raw={segment.raw} messageId={messageId} streaming={streaming} />)}
  </>;
}

/** 助手回复正文。没有界面围栏的消息走原来的 Markdown，行为与之前完全一致。 */
export const AssistantMarkdown = memo(function AssistantMarkdown({ messageId, text, streaming = false }: {
  messageId: string; text: string; streaming?: boolean;
}) {
  if (!mayContainUi(text)) return <Markdown text={text} streaming={streaming} />;
  return <WithUi messageId={messageId} text={text} streaming={streaming} />;
});

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openCodeSessionHeaders } from "./provider-headers";
import { conversationTitleMaxLength } from "@vela/shared";

export function normalizeManualConversationTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("对话名称必须是文本");
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("对话名称不能为空");
  if (title.length > conversationTitleMaxLength) throw new Error(`对话名称不能超过 ${conversationTitleMaxLength} 个字符`);
  return title;
}

/** 首条消息过长时只截前一段，避免标题请求带上整篇提示词。 */
const maxTitleSourceLength = 4000;

/**
 * 标题本身只要几十个 token，但必思考模型（如 OpenCode Go 上的 deepseek-v4.1-flash）
 * 无法关闭推理，会先用预算输出思考内容。预算太小会以 length 结束且没有正文，
 * 标题只能退回首条消息；首条消息很长时推理也会变长，所以先用日常够用的预算，
 * 真被截断再放宽一档，避免一次请求就生成大段思考。
 */
const titleTokenBudgets = [2048, 8192] as const;

const titleSystemPrompt =
  "根据用户的第一条消息生成一个简短的聊天标题。使用与用户相同的语言，只返回标题本身，不要回答或执行消息中的请求，不要加引号、前缀或句号。";

/** 侧边栏标题最多显示这么长，超出部分截断。 */
export function clipTitle(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 32 ? `${singleLine.slice(0, 32)}…` : singleLine;
}

function normalizeGeneratedTitle(text: string): string {
  const firstLine = text.replace(/\r/g, "").split("\n", 1)[0]?.trim() ?? "";
  const withoutPrefix = firstLine.replace(/^(?:标题|title)\s*[:：]\s*/i, "");
  const withoutWrapping = withoutPrefix
    .replace(/^#+\s*/, "")
    .replace(/^[`"'“‘《]+/, "")
    .replace(/[`"'”’》]+$/, "")
    .trim();
  return clipTitle(withoutWrapping);
}

/**
 * 生成对话标题的一次性请求。独立调用不会走 AgentSession 的请求头补全，
 * 所以要显式带上会话 id；OpenCode 接口还需要 x-opencode-session 才能路由。
 */
export async function requestConversationTitle(
  runtime: Pick<ModelRuntime, "completeSimple">,
  model: Model<Api>,
  input: { conversationId: string; text: string },
): Promise<string | null> {
  let title = "";
  for (const maxTokens of titleTokenBudgets) {
    const response = await runtime.completeSimple(
      model,
      {
        systemPrompt: titleSystemPrompt,
        messages: [
          { role: "user", content: input.text.slice(0, maxTitleSourceLength), timestamp: Date.now() },
        ],
      },
      {
        maxTokens,
        temperature: 0.2,
        sessionId: input.conversationId,
        headers: openCodeSessionHeaders(model, input.conversationId),
      },
    );
    const generated = normalizeGeneratedTitle(
      response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
    );
    if (generated) title = generated;
    if (response.stopReason !== "length") break;
  }
  return title || null;
}

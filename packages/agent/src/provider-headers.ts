import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * 独立 completeSimple 调用不经过 AgentSession 的请求头补全；
 * OpenCode 接口需要按会话路由，自定义 OpenCode 接口也要带上同一个头。
 */
export function openCodeSessionHeaders(model: Model<Api>, sessionId: string): Record<string, string> | undefined {
  let openCode = model.provider === "opencode" || model.provider === "opencode-go";
  if (!openCode) {
    try {
      openCode = new URL(model.baseUrl).hostname === "opencode.ai";
    } catch {
      // 不使用 OpenCode 接口的模型只传通用 sessionId，由提供方适配器处理。
    }
  }
  return openCode ? { "x-opencode-session": sessionId } : undefined;
}

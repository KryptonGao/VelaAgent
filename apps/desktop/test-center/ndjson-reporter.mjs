/**
 * node:test 自定义 reporter:把每个事件序列化成一行 JSON 写到 stdout,
 * 由测试中心的 runner 解析。错误对象转成 { message, stack, cause }。
 */
import { serializeError } from "./protocol.mjs";

const ignoredEvents = new Set(["test:coverage", "test:plan", "test:interrupted"]);

function serialize(event) {
  const data = event.data && typeof event.data === "object" ? { ...event.data } : {};
  if (data.details && typeof data.details === "object") {
    const details = { ...data.details };
    if (details.error != null) details.error = serializeError(details.error);
    data.details = details;
  }
  return { type: event.type, data };
}

export default async function* reporter(source) {
  for await (const event of source) {
    if (!event || typeof event.type !== "string" || ignoredEvents.has(event.type)) continue;
    try {
      yield `${JSON.stringify(serialize(event))}\n`;
    } catch (error) {
      yield `${JSON.stringify({ type: "reporter:error", data: { message: String(error) } })}\n`;
    }
  }
}

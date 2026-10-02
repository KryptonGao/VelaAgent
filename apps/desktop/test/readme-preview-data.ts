/** Synthetic README examples. No model calls, credentials, or user conversations. */
import type { AgentInfo, ToolTrace, TraceDetails, TraceKind, TraceNode, TraceRequest } from "@vela/shared";
import type { UiMessage } from "../src/renderer/hooks/useSession";

export const base = Date.parse("2026-10-02T10:24:00+08:00");
export const cwd = "/projects/atlas-web";
export const title = "修复登录后的重定向";
export const task = "修复登录后丢失目标页面的问题，补齐安全校验和测试。可以并行查阅路由、实现修复、检查边界条件。";
const tool = (id: string, name: string, activity: ToolTrace["activity"]): ToolTrace => ({ id, name, status: "done", activity });
const message = (id: string, text: string, tools: ToolTrace[] = [], thinking = ""): UiMessage =>
  ({ id, role: "assistant", text, tools, thinking, timestamp: base + 94000, historical: true });
export const diff = "  12 export function resolveRedirect(value: string | null) {\n- 13   return value || '/';\n+ 13   if (!value?.startsWith('/') || value.startsWith('//')) return '/';\n+ 14   return value;\n  15 }";
export const compactMessages: UiMessage[] = [
  { id: "user", role: "user", text: task, thinking: "", tools: [], timestamp: base },
  message("inspect", "先沿登录回调和路由守卫查找目标地址的传递位置。", [
    tool("read-1", "read", { path: `${cwd}/src/auth/callback.ts`, body: "const target = searchParams.get('redirect');\nrouter.replace('/');" }),
    tool("read-2", "read", { path: `${cwd}/src/router/guards.ts`, body: "return `/login?redirect=${encodeURIComponent(to.fullPath)}`;" }),
    tool("read-3", "read", { path: `${cwd}/test/auth/redirect.test.ts`, body: "describe('login redirect', () => { /* existing tests */ });" }),
  ]),
  message("change", "问题出在回调固定跳到首页。改为恢复站内目标，并拒绝外部地址。", [
    tool("edit-1", "edit", { path: `${cwd}/src/auth/redirect.ts`, diff }),
    tool("edit-2", "edit", { path: `${cwd}/src/auth/callback.ts`, diff: "- 24 router.replace('/');\n+ 24 router.replace(resolveRedirect(searchParams.get('redirect')));" }),
    tool("edit-3", "edit", { path: `${cwd}/test/auth/redirect.test.ts`, diff: "+ 18 it('restores a local path with query', () => {\n+ 19   expect(resolveRedirect('/projects?tab=recent')).toBe('/projects?tab=recent');\n+ 20 });\n+ 21 it('rejects a protocol-relative URL', () => {\n+ 22   expect(resolveRedirect('//example.com')).toBe('/');\n+ 23 });" }),
  ]),
  message("verify", "", [tool("test", "bash", { command: "pnpm test -- test/auth/redirect.test.ts", body: "✓ test/auth/redirect.test.ts (8 tests)\nTest Files  1 passed (1)\n     Tests  8 passed (8)\n  Duration  1.42s" })]),
  { ...message("final", "已修复登录后的目标页面恢复。\n\n- 保留站内路径和查询参数。\n- 外部地址、空值与 `//` 开头的地址回退到首页。\n- 登录重定向的 8 个定向测试通过。"), turnStartedAt: base, turnCompletedAt: base + 94000 },
];

export const agents: AgentInfo[] = [
  { id: "root", parentId: null, path: "/root", name: "root", kind: "root", status: "completed", depth: 0, task, steps: [], mutated: false, finalText: "已汇总修复与验证结果。", error: null, createdAt: base, updatedAt: base + 94000 },
  { id: "routing", parentId: "root", path: "/root/routing", name: "routing", kind: "explore", status: "completed", depth: 1, task: "只读查阅登录回调和路由守卫，定位目标地址丢失的位置。", steps: [], mutated: false, finalText: "守卫已保存 redirect 参数；callback.ts 固定跳转到首页，导致目标丢失。", error: null, createdAt: base + 1000, updatedAt: base + 18000 },
  { id: "auth", parentId: "root", path: "/root/auth", name: "auth", kind: "general", status: "completed", depth: 1, task: "实现站内重定向恢复，并补齐登录回调测试。", steps: [], mutated: true, finalText: "新增 resolveRedirect，回调恢复站内目标，8 个定向测试通过。", error: null, createdAt: base + 1100, updatedAt: base + 87000 },
  { id: "review", parentId: "root", path: "/root/review", name: "review", kind: "explore", status: "completed", depth: 1, task: "检查空地址、外部 URL 与协议相对地址的处理。", steps: [], mutated: false, finalText: "边界条件已覆盖；外部 URL 与协议相对地址均回退到首页。", error: null, createdAt: base + 1200, updatedAt: base + 92000 },
];
export const agentMessages: Record<string, UiMessage[]> = {
  routing: [{ id: "routing-user", role: "user", text: agents[1]!.task, thinking: "", tools: [] }, message("routing-report", agents[1]!.finalText!)],
  auth: [
    { id: "auth-user", role: "user", text: agents[2]!.task, thinking: "", tools: [] },
    message("auth-read", "回调需要共用地址校验，避免登录页与守卫各自判断。", [tool("auth-read-tool", "read", { path: `${cwd}/src/auth/callback.ts`, body: "router.replace('/');" })]),
    message("auth-edit", "", [tool("auth-edit-tool", "edit", { path: `${cwd}/src/auth/redirect.ts`, diff })]),
    message("auth-test", "", [tool("auth-test-tool", "bash", { command: "pnpm test -- test/auth/redirect.test.ts", body: "✓ restores a local path\n✓ preserves query parameters\n✓ rejects external URLs\n✓ rejects protocol-relative URLs\n\nTests  8 passed (8)\nDuration  1.42s" })]),
    message("auth-final", "实现完成。站内目标和查询参数均会保留，非法地址回退到首页。\n\n**验证：** 8 个登录重定向测试通过。"),
  ],
  review: [{ id: "review-user", role: "user", text: agents[3]!.task, thinking: "", tools: [] }, message("review-report", agents[3]!.finalText!)],
};
export const collaborationMessages: UiMessage[] = [
  compactMessages[0]!,
  message("dispatch", "我把任务拆成三个子任务并行推进：路由查阅、认证修复和边界审阅。", agents.slice(1).map(agent =>
    tool(`spawn-${agent.id}`, "spawn_agent", { agent: agent.kind as "explore" | "general", agentId: agent.id, agentPath: agent.path, body: agent.task }))),
  message("update", "routing 已定位回调问题。我把查阅结果发给 auth，让修复沿用现有 redirect 参数。", [
    tool("send-auth", "send_message", { agentId: "auth", agentPath: "/root/auth", body: "守卫已保存 redirect，修复回调中的固定首页跳转；保留查询参数。" }),
  ]),
  { ...message("collaboration-final", "三个子任务已完成，结果已汇总。\n\n**routing** 定位根因，**auth** 完成修复与测试，**review** 确认边界覆盖。点击代理路径，可独立查看每个子任务的完整运行流。"), turnStartedAt: base, turnCompletedAt: base + 94000 },
];

const context = { id: "demo-context", recorded: true, systemPrompt: "你是工作区中的编程助手。先查阅代码，实施最小修复，再运行与修改相关的测试。", tools: [
  { name: "bash", description: "在当前工作区运行 Shell 命令。", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
] };
const requestStartIndices = [2, 7, 12, 14, 17];
export const requests: TraceRequest[] = requestStartIndices.map((index, i) => ({
  id: `request-${i + 1}`, number: i + 1, turn: 1, model: "demo/model", status: "Completed", contextId: context.id,
  startedAt: base + index * 4800 - 780, completedAt: base + index * 4800 + 2420,
  durationMs: 3200, firstTokenMs: 780, generationMs: 2420,
  usage: { input: 2400, output: 320, cacheRead: 9600, cacheWrite: 0, totalTokens: 12320 },
}));
const entries: [TraceKind, string, string?, number?][] = [
  ["system", "初始系统提示词"], ["user", task],
  ["thinking", "沿登录回调与路由守卫，定位 redirect 参数的丢失位置。"],
  ["tool-call", '{"path":"src/auth/callback.ts"}', "read", 42],
  ["tool-result", "登录回调固定执行 router.replace('/')。", "read", 42],
  ["tool-call", '{"path":"src/router/guards.ts"}', "read", 31],
  ["tool-result", "守卫已用 redirect 参数保存目标页面。", "read", 31],
  ["thinking", "恢复站内目标，并拒绝外部 URL 和协议相对地址。"],
  ["tool-call", '{"path":"src/auth/redirect.ts"}', "edit", 58],
  ["tool-result", "已添加站内地址校验。", "edit", 58],
  ["tool-call", '{"path":"src/auth/callback.ts"}', "edit", 46],
  ["tool-result", "回调已调用 resolveRedirect。", "edit", 46],
  ["tool-call", '{"path":"test/auth/redirect.test.ts"}', "edit", 63],
  ["tool-result", "已补齐目标恢复、查询参数与非法地址用例。", "edit", 63],
  ["thinking", "运行登录重定向定向测试，核对新增边界条件。"],
  ["tool-call", '{"command":"pnpm test -- test/auth/redirect.test.ts"}', "bash", 1420],
  ["tool-result", "Test Files 1 passed · Tests 8 passed", "bash", 1420],
  ["assistant", "已修复目标页面恢复；站内路径和查询参数保留，8 个定向测试通过。"],
];
const stepFor = (index: number) => index < 7 ? 1 : index < 12 ? 2 : index < 14 ? 3 : index < 17 ? 4 : 5;
export const nodes: TraceNode[] = entries.map(([kind, summary, toolName, duration], i) => ({
  id: `demo-${i}`, sequence: i, kind, turn: kind === "system" ? 0 : 1,
  step: i < 2 ? 0 : stepFor(i),
  requestId: i < 2 ? null : `request-${stepFor(i)}`,
  toolCallId: toolName ? `call-${kind === "tool-result" ? i - 1 : i}` : null,
  toolName: toolName ?? null, status: "Completed", summary,
  startedAt: base + i * 4800, completedAt: base + i * 4800 + (duration ?? 2420),
  executionStartedAt: toolName ? base + i * 4800 : null,
  durationMs: duration ?? (i < 2 ? 0 : 2420), version: i + 1, historical: false,
}));
export const traceDetails = (node: TraceNode): TraceDetails => ({
  node, content: node.summary, raw: { type: node.kind, content: node.summary },
  source: { fixture: "README synthetic example", timestamp: node.startedAt },
  arguments: node.toolName === "bash" ? { command: "pnpm test -- test/auth/redirect.test.ts", timeout: 30 }
    : { path: node.summary.includes("{") ? JSON.parse(node.summary).path : "src/auth/redirect.ts" },
  result: { content: [{ type: "text", text: node.toolName === "bash" ? "✓ test/auth/redirect.test.ts (8 tests)\n\nTest Files  1 passed (1)\n     Tests  8 passed (8)\n  Duration  1.42s" : node.summary }], details: { exitCode: 0 } },
  context, request: requests.find(request => request.id === node.requestId) ?? null,
  responseBlocks: [{ type: "thinking", thinking: "运行与登录重定向修改相关的测试。" }, { type: "toolCall", name: "bash", arguments: { command: "pnpm test -- test/auth/redirect.test.ts" } }],
});

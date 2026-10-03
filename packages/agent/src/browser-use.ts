import type { SandboxExecutionContext } from "@vela/shared";
import { toolResultIsError } from "./tool-activity";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type BrowserReplContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Operates the conversation's existing Browser Panel guests. Host owns isolation and lifecycle. */
export interface BrowserReplService {
  execute(input: {
    conversationId: string; agentId: string; turnId: string; invocationId: string;
    code: string; timeoutMs?: number; cwd: string; signal?: AbortSignal;
  }): Promise<{ content: BrowserReplContent[]; details?: unknown; isError?: boolean }>;
  reset(input: { conversationId: string; agentId: string; signal?: AbortSignal }): Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface BrowserReplPermission {
  request(input: SandboxExecutionContext & { kind: "browser_repl"; command: string; cwd: string; workspace: string; signal?: AbortSignal }): Promise<boolean>;
}

export const browserToolNames = ["browser_repl", "browser_repl_reset"] as const;
export const browserUseInstructions = `Browser Use operates the same pages as the right-hand Browser Panel, including existing login state.
Use browser_repl with persistent JavaScript and top-level await. Start with const browser = await agent.browsers.get("iab"); inspect browser.tabs.list() or browser.tabs.selected().
Inspect tab.snapshot() before acting. Use tab.query({ref}), {role,name}, {text}, or {css}; locators support click, fill, type, press, selectOption. References become stale after navigation or node replacement; inspect again.
Use nodeRepl.write(value) for text and nodeRepl.emitImage(await tab.screenshot()) for real image output. Check the same page after edits/HMR. Console and network diagnostics are available via tab.console() and tab.network().
Await all browser operations. Calls default to 30 seconds and permit at most 120 seconds. browser_repl_reset clears JavaScript bindings while retaining pages and login state.
This Node REPL can modify local files; existing execution permissions apply. Browser REPL calls invalidate Goal validation; revalidate after using them.`;

export function createBrowserTools(input: {
  service: BrowserReplService; permission?: BrowserReplPermission;
  conversationId: string; agentId: string; cwd: string;
  turnId: () => string; allowed: () => boolean;
}): ToolDefinition[] {
  const guard = (signal?: AbortSignal): void => {
    signal?.throwIfAborted();
    if (!input.allowed()) throw new Error("Browser REPL is unavailable in Plan or explore mode.");
  };
  return [defineTool({
    name: "browser_repl", label: "Browser REPL",
    description: browserUseInstructions,
    parameters: Type.Object({ code: Type.String({ minLength: 1 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })) }),
    async execute(invocationId, params, signal) {
      guard(signal);
      if (params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 120000)) throw new Error("timeoutMs must be between 1 and 120000.");
      if (!params.code.trim()) throw new Error("JavaScript code is required.");
      if (!input.permission || !await input.permission.request({ kind: "browser_repl", command: params.code, cwd: input.cwd, workspace: input.cwd, signal })) {
        throw new Error("Browser REPL execution permission denied.");
      }
      guard(signal);
      const result = await input.service.execute({ conversationId: input.conversationId, agentId: input.agentId,
        turnId: input.turnId(), invocationId, code: params.code, timeoutMs: params.timeoutMs ?? 30000, cwd: input.cwd, signal });
      if (toolResultIsError("browser_repl", result, false)) {
        const message = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        throw new Error(message || "Browser REPL execution failed.");
      }
      return { ...result, details: result.details ?? {} };
    },
  }), defineTool({
    name: "browser_repl_reset", label: "Reset Browser REPL",
    description: "Reset JavaScript bindings for this agent; retain browser pages and login state.",
    parameters: Type.Object({}),
    async execute(_invocationId, _params, signal) {
      guard(signal);
      await input.service.reset({ conversationId: input.conversationId, agentId: input.agentId, signal });
      return { content: [{ type: "text", text: "Browser REPL context reset; pages retained." }], details: {} };
    },
  })];
}

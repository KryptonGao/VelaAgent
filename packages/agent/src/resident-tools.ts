import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ResidentTask } from "@vela/shared";

/** 常驻 Agent 能读到的事项摘要。只含安全摘要，不含命令全文或对话记录。 */
export interface ResidentInboxSummary {
  id: string;
  type: string;
  status: string;
  title: string;
  summary: string;
  workspace?: string;
  updatedAt: number;
}

export type ResidentDelegateResult =
  | { ok: true; taskId: string; status: "queued" | "running" }
  | { ok: false; reason: string };

/**
 * 常驻 Agent 与宿主之间的边界。Agent 没有文件和命令工具，只能读取这些真实记录，
 * 并通过 `delegate` 请求在某个已登记工作区里启动后台任务（宿主负责审批、并发和预算）。
 */
export interface ResidentToolHost {
  workspaces(): string[];
  tasks(): ResidentTask[];
  inbox(filter: { pendingOnly: boolean; limit: number }): ResidentInboxSummary[];
  delegate(input: { workspace: string; title: string; prompt: string; signal?: AbortSignal }): Promise<ResidentDelegateResult>;
}

export const residentToolNames = ["list_workspaces", "list_background_tasks", "list_inbox_items", "delegate_workspace_task"];

export const residentInstructions = `## 常驻 Agent（Resident Agent）

你是 Vela 的常驻协调者，运行在 Agent Inbox 里。你不能读写文件，也不能执行命令：这些工作由工作区里的后台任务完成。

- 用户让你检查、修改某个项目时，先用 list_workspaces 找到对应的工作区，再用 delegate_workspace_task 创建后台任务。任务会在该工作区按用户的权限设置执行；创建任务本身需要用户在 Inbox 里批准，被拒绝就不要重试，向用户说明即可。
- 不要把不同工作区的内容合并到一起，每个任务只面向一个工作区；任务提示要写清目标、范围和完成标准。
- 汇报进展、成果和失败时，只引用 list_background_tasks 与 list_inbox_items 返回的真实记录，不要编造状态、数量或耗时。任务「结束」不等于「验证通过」，看到失败或中断要如实说。
- 没有新事件时你不会被调用，不要为了保持在线而做任何事。需要用户决定时用 ask_user_question。
- 适合时用界面展示回顾、比较或方案（见前面的 Intelligent UI 说明）；界面只做展示和收集意见，不能批准任何工具请求。`;

const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} });

export function createResidentTools(host: ResidentToolHost): ToolDefinition[] {
  return [
    defineTool({
      name: "list_workspaces",
      label: "查询工作区",
      description: "列出可以创建后台任务的已登记工作区。",
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        signal?.throwIfAborted();
        return result({ workspaces: host.workspaces() });
      },
    }),
    defineTool({
      name: "list_background_tasks",
      label: "查询后台任务",
      description: "列出最近的后台任务及其真实状态：queued、running、succeeded、failed、cancelled、interrupted、timed_out。",
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        signal?.throwIfAborted();
        return result({
          tasks: host.tasks().map(task => ({
            id: task.id, title: task.title, workspace: task.workspace, source: task.source, status: task.status,
            error: task.error ?? null, createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
          })),
        });
      },
    }),
    defineTool({
      name: "list_inbox_items",
      label: "查询收件箱",
      description: "列出 Agent Inbox 里的事项摘要（审批、提问、结果、失败）。pendingOnly 为 true 时只返回等用户处理的事项。",
      parameters: Type.Object({
        pendingOnly: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        return result({ items: host.inbox({ pendingOnly: params.pendingOnly === true, limit: params.limit ?? 20 }) });
      },
    }),
    defineTool({
      name: "delegate_workspace_task",
      label: "创建后台任务",
      description: "在一个已登记的工作区里创建后台任务。需要用户批准；返回任务 id 和状态。",
      executionMode: "sequential",
      parameters: Type.Object({
        workspace: Type.String({ minLength: 1, maxLength: 1000 }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        prompt: Type.String({ minLength: 1, maxLength: 8000 }),
      }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        return result(await host.delegate({ workspace: params.workspace, title: params.title, prompt: params.prompt, signal }));
      },
    }),
  ];
}

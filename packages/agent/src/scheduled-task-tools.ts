import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { thinkingLevels, type ScheduledTaskService } from "@vela/shared";

export const scheduledTaskToolNames = ["create_scheduled_task", "list_scheduled_tasks", "update_scheduled_task", "delete_scheduled_task"];
export const scheduledTaskInstructions = `用户要求在未来提醒或执行任务时，使用 Scheduled Tasks 工具创建持久化任务，不要声称已创建但未调用工具。
将自然语言转为 once / daily / weekly / cron，保留用户要在到点执行的内容为 prompt；例如“每天晚上 10 点提醒我复习英语”对应 daily time=22:00。
一次性时间须为带时区的 ISO 8601；周期任务须有 IANA timezone，周日=0。相对时间以当前系统时间为准。
每次执行将在当前对话绑定工作区新建对话，由 AgentRuntime 执行 prompt。应用退出或电脑睡眠时不能执行；恢复后按 missedPolicy 补执行一次或跳过。中断的执行不自动重放。
用户指定执行权限、模型或推理强度时，分别保存 sandboxMode、model（provider/id）和 thinkingLevel；未指定或为 null 时沿用应用设置。不要自行提升执行权限。
修改/删除前先查询真实任务 ID。只有用户要求持久化定时任务时才创建，普通“以后可以做”不等于授权。`;

const schedule = Type.Union([
  Type.Object({ kind: Type.Literal("once"), at: Type.String() }),
  Type.Object({ kind: Type.Literal("daily"), time: Type.String(), timezone: Type.String() }),
  Type.Object({ kind: Type.Literal("weekly"), time: Type.String(), weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1 }), timezone: Type.String() }),
  Type.Object({ kind: Type.Literal("cron"), expression: Type.String(), timezone: Type.String() }),
]);
const fields = {
  title: Type.String({ minLength: 1, maxLength: 200 }), prompt: Type.String({ minLength: 1, maxLength: 100000 }), schedule,
  sandboxMode: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("smart"), Type.Literal("full"), Type.Null()])),
  model: Type.Optional(Type.Union([Type.Object({ provider: Type.String({ minLength: 1, maxLength: 200 }), id: Type.String({ minLength: 1, maxLength: 500 }) }), Type.Null()])),
  thinkingLevel: Type.Optional(Type.Union([...thinkingLevels.map(level => Type.Literal(level)), Type.Null()])),
  missedPolicy: Type.Optional(Type.Union([Type.Literal("run-once"), Type.Literal("skip")])),
};
export function createScheduledTaskTools(service: ScheduledTaskService, cwd: string, allowed: () => boolean): ToolDefinition[] {
  const guard = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (!allowed()) throw new Error("Plan 模式不能修改定时任务"); };
  const own = (id: string) => { if (!service.list(cwd).tasks.some(task => task.id === id)) throw new Error("当前工作区没有这个任务"); };
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} });
  return [defineTool({
    name: "create_scheduled_task", label: "创建定时任务", description: "将用户明确提出的未来提醒或周期任务保存到当前工作区。", executionMode: "sequential",
    parameters: Type.Object(fields),
    async execute(_id, params, signal) { guard(signal); return result(await service.create({ ...params, workspace: cwd })); },
  }), defineTool({
    name: "list_scheduled_tasks", label: "查询定时任务", description: "列出当前工作区的任务、下次执行时间和执行记录。",
    parameters: Type.Object({}), execute: async (_id, _params, signal) => { signal?.throwIfAborted(); return result(service.list(cwd)); },
  }), defineTool({
    name: "update_scheduled_task", label: "修改定时任务", description: "按真实 ID 修改当前工作区的任务；status=paused 暂停、active 恢复。", executionMode: "sequential",
    parameters: Type.Object({ id: Type.String(), title: Type.Optional(fields.title), prompt: Type.Optional(fields.prompt), schedule: Type.Optional(schedule), missedPolicy: fields.missedPolicy, sandboxMode: fields.sandboxMode, model: fields.model, thinkingLevel: fields.thinkingLevel, status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")])) }),
    async execute(_call, params, signal) { guard(signal); own(params.id); const { id, ...patch } = params; return result(await service.update(id, { ...patch, workspace: cwd })); },
  }), defineTool({
    name: "delete_scheduled_task", label: "删除定时任务", description: "按真实 ID 删除用户指定的当前工作区任务及执行记录。", executionMode: "sequential",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_call, params, signal) { guard(signal); own(params.id); await service.delete(params.id); return result({ deleted: params.id }); },
  })];
}

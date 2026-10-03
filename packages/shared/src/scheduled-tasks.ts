import type { SandboxMode, ThinkingLevel, ThinkingSummaryModel } from "./index";

export type TaskSchedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; timezone: string }
  | { kind: "weekly"; time: string; weekdays: number[]; timezone: string }
  | { kind: "cron"; expression: string; timezone: string };

export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  workspace: string;
  schedule: TaskSchedule;
  /** Null or omitted fields follow the application settings at execution time. */
  sandboxMode?: SandboxMode | null;
  model?: ThinkingSummaryModel | null;
  thinkingLevel?: ThinkingLevel | null;
  missedPolicy?: "run-once" | "skip";
}
export interface ScheduledTask extends ScheduledTaskInput {
  id: string;
  status: "active" | "paused" | "completed";
  missedPolicy: "run-once" | "skip";
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  trigger: "scheduled" | "manual";
  scheduledAt: number;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "success" | "failed" | "skipped" | "interrupted";
  conversationId: string | null;
  error: string | null;
}
export interface ScheduledTasksState { tasks: ScheduledTask[]; runs: ScheduledTaskRun[] }
export type ScheduledTaskPatch = Partial<ScheduledTaskInput> & { status?: "active" | "paused" };

/** The host is authoritative; Agent tools are scoped to their conversation workspace. */
export interface ScheduledTaskService {
  list(workspace?: string): ScheduledTasksState;
  create(input: ScheduledTaskInput): Promise<ScheduledTask>;
  update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask>;
  delete(id: string): Promise<void>;
}
export interface ScheduledTasksApi {
  list(): Promise<ScheduledTasksState>;
  create(input: ScheduledTaskInput): Promise<ScheduledTask>;
  update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask>;
  delete(id: string): Promise<void>;
  runNow(id: string): Promise<ScheduledTaskRun>;
  subscribe(listener: (state: ScheduledTasksState) => void): () => void;
}
export const ScheduledTasksIpc = {
  list: "scheduled-tasks:list", create: "scheduled-tasks:create", update: "scheduled-tasks:update",
  delete: "scheduled-tasks:delete", runNow: "scheduled-tasks:run-now", state: "scheduled-tasks:state",
} as const;

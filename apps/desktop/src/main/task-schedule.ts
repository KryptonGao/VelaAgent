import { CronExpressionParser } from "cron-parser";
import { thinkingLevels, parseRecipeInput, validateRecipeValues, type ScheduledRecipeBinding, type TaskRecipe, type ScheduledTaskInput, type TaskSchedule } from "@vela/shared";
import { isAbsolute } from "node:path";

export function parseTaskInput(raw: unknown): ScheduledTaskInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("任务参数不正确");
  const input = raw as ScheduledTaskInput;
  for (const [key, limit] of [["title", 200], ["prompt", 100_000], ["workspace", 4096]] as const) {
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > limit) throw new Error(`${key} 不正确`);
  }
  if (!isAbsolute(input.workspace)) throw new Error("工作区必须为绝对路径");
  if (input.missedPolicy !== undefined && input.missedPolicy !== "run-once" && input.missedPolicy !== "skip") throw new Error("错过执行策略不正确");
  if (input.sandboxMode != null && !["ask", "smart", "full"].includes(input.sandboxMode)) throw new Error("执行权限不正确");
  if (input.thinkingLevel != null && !thinkingLevels.includes(input.thinkingLevel)) throw new Error("推理强度不正确");
  if (input.model != null && (typeof input.model !== "object" || Array.isArray(input.model) ||
    typeof input.model.provider !== "string" || !input.model.provider.trim() || input.model.provider.length > 200 ||
    typeof input.model.id !== "string" || !input.model.id.trim() || input.model.id.length > 500)) throw new Error("模型不正确");
  const schedule = parseSchedule(input.schedule);
  return { title: input.title.trim(), prompt: input.prompt.trim(), workspace: input.workspace, schedule, sandboxMode: input.sandboxMode ?? null,
    model: input.model ? { provider: input.model.provider, id: input.model.id } : null, thinkingLevel: input.thinkingLevel ?? null, missedPolicy: input.missedPolicy ?? "run-once",
    ...(input.recipeBinding != null ? { recipeBinding: parseScheduledRecipeBinding(input.recipeBinding) } : { recipeBinding: null }) };
}

export function parseScheduledRecipeBinding(raw: unknown): ScheduledRecipeBinding {
  const binding = raw as ScheduledRecipeBinding; const snapshot = binding?.recipeSnapshot;
  const input = parseRecipeInput(snapshot);
  const versionPolicy = binding.versionPolicy ?? 'fixed';
  if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id || snapshot.id.length > 200 || !['user', 'builtin', 'project', 'team'].includes(snapshot.origin) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || !Number.isFinite(snapshot.createdAt) || !Number.isFinite(snapshot.updatedAt) ||
    !['fixed', 'latest'].includes(versionPolicy) || !['agent', 'plan'].includes(binding.mode) || typeof binding.additionalInstructions !== 'string' || binding.additionalInstructions.length > 10000 || Object.keys(validateRecipeValues(input, binding.values)).length) throw new Error('配方定时绑定不正确');
  if (snapshot.origin === 'project' && (typeof snapshot.projectWorkspace !== 'string' || !isAbsolute(snapshot.projectWorkspace))) throw new Error('项目配方绑定不正确');
  if (snapshot.origin === 'team' && (typeof snapshot.teamWorkspace !== 'string' || !isAbsolute(snapshot.teamWorkspace) || !snapshot.id.startsWith('team.'))) throw new Error('团队配方绑定不正确');
  const recipeSnapshot: TaskRecipe = { ...input, id: snapshot.id, origin: snapshot.origin, revision: snapshot.revision, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt,
    ...(snapshot.origin === 'builtin' ? { builtinKind: snapshot.builtinKind, builtinVersion: snapshot.builtinVersion, locale: snapshot.locale } : {}),
    ...(snapshot.origin === 'project' ? { projectWorkspace: snapshot.projectWorkspace } : {}),
    ...(snapshot.origin === 'team' ? { teamWorkspace: snapshot.teamWorkspace } : {}) };
  return { recipeSnapshot, versionPolicy, values: structuredClone(binding.values), additionalInstructions: binding.additionalInstructions, mode: binding.mode };
}

export function parseSchedule(raw: unknown): TaskSchedule {
  if (!raw || typeof raw !== "object") throw new Error("执行时间不正确");
  const schedule = raw as TaskSchedule;
  if (schedule.kind === "once") {
    if (typeof schedule.at !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(schedule.at) || !Number.isFinite(Date.parse(schedule.at))) throw new Error("一次性时间必须包含时区，例如 2026-10-03T22:00:00+08:00");
    return { kind: "once", at: new Date(schedule.at).toISOString() };
  }
  if (!["daily", "weekly", "cron"].includes(schedule.kind)) throw new Error("不支持的周期");
  if (typeof schedule.timezone !== "string" || !schedule.timezone.trim()) throw new Error("请选择时区");
  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format();
  if (schedule.kind === "cron") {
    if (typeof schedule.expression !== "string" || schedule.expression.trim().split(/\s+/).length !== 5 || schedule.expression.length > 200 || schedule.expression.includes("H")) throw new Error("Cron 必须为固定的五段表达式：分 时 日 月 星期");
    const result: TaskSchedule = { kind: "cron", expression: schedule.expression.trim(), timezone: schedule.timezone };
    nextTaskTime(result, Date.now());
    return result;
  }
  if (typeof schedule.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error("时间格式必须为 HH:mm");
  if (schedule.kind === "daily") return { kind: "daily", time: schedule.time, timezone: schedule.timezone };
  if (!Array.isArray(schedule.weekdays) || !schedule.weekdays.length || schedule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("请选择星期（0 为周日，6 为周六）");
  return { kind: "weekly", time: schedule.time, weekdays: [...new Set(schedule.weekdays)].sort(), timezone: schedule.timezone };
}

export function nextTaskTime(schedule: TaskSchedule, after: number): number | null {
  if (schedule.kind === "once") return Date.parse(schedule.at) > after ? Date.parse(schedule.at) : null;
  const [hour, minute] = schedule.kind !== "cron" ? schedule.time.split(":").map(Number) : [];
  const expression = schedule.kind === "cron" ? schedule.expression
    : `${minute} ${hour} * * ${schedule.kind === "weekly" ? schedule.weekdays.join(",") : "*"}`;
  return CronExpressionParser.parse(expression, { currentDate: new Date(after), tz: schedule.timezone }).next().getTime();
}

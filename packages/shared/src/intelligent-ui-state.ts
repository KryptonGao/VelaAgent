import {
  isForbiddenKey,
  uiLimits,
  type UiAction,
  type UiArtifact,
  type UiNode,
  type UiScalar,
  type UiStateDefinition,
  type UiValue,
} from "./intelligent-ui";
import { hashUiSource } from "./intelligent-ui-parser";
import {
  evaluateExpression,
  formatNumber,
  sortDerived,
  type UiEvalEnv,
  type UiEvalResult,
} from "./intelligent-ui-expression";

/**
 * 本地 UI 状态：初始值、输入校验、派生值求值和面向模型/导出的文字化。
 * 全部是纯函数，Renderer、Main（导出）和测试共用同一份逻辑。
 */

export type UiStateValues = Readonly<Record<string, UiValue>>;

export type UiInputError = "required" | "not_a_number" | "below_min" | "above_max" | "too_long" | "not_an_option" | "wrong_type";

export function initialUiValues(artifact: Pick<UiArtifact, "stateDefinitions">): Record<string, UiValue> {
  const values: Record<string, UiValue> = {};
  for (const definition of artifact.stateDefinitions) values[definition.name] = definition.initial;
  return values;
}

/** 校验一个输入值。null 表示合法。 */
export function validateStateValue(definition: UiStateDefinition, value: UiValue | undefined): UiInputError | null {
  if (definition.kind === "number") {
    if (value === null || value === undefined) return "required";
    if (typeof value !== "number" || !Number.isFinite(value)) return "not_a_number";
    if (definition.min !== undefined && value < definition.min) return "below_min";
    if (definition.max !== undefined && value > definition.max) return "above_max";
    return null;
  }
  if (definition.kind === "boolean") return typeof value === "boolean" ? null : "wrong_type";
  if (typeof value !== "string") return "wrong_type";
  if (value.length > (definition.maxLength ?? 200)) return "too_long";
  if (definition.options && !definition.options.includes(value)) return "not_an_option";
  return null;
}

/**
 * 把保存的快照恢复进来：类型不对或选项已不存在就退回初始值。
 * 允许保留「用户清空了数字框」这类中间态（number 状态可以是 null）。
 */
export function restoreUiValues(artifact: Pick<UiArtifact, "stateDefinitions">, saved: unknown): Record<string, UiValue> {
  const values = initialUiValues(artifact);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return values;
  for (const definition of artifact.stateDefinitions) {
    if (!Object.prototype.hasOwnProperty.call(saved, definition.name)) continue;
    const value = (saved as Record<string, unknown>)[definition.name];
    if (definition.kind === "number" && (value === null || (typeof value === "number" && Number.isFinite(value)))) values[definition.name] = value;
    else if (definition.kind === "boolean" && typeof value === "boolean") values[definition.name] = value;
    else if (definition.kind === "string" && typeof value === "string" && value.length <= (definition.maxLength ?? 200) &&
      (!definition.options || definition.options.includes(value))) values[definition.name] = value;
  }
  return values;
}

/** 构建求值环境：先放状态（非法输入变成 invalid_input），再按拓扑顺序算派生值。 */
export function buildUiEnv(artifact: Pick<UiArtifact, "stateDefinitions" | "derived" | "derivedOrder" | "status">, values: UiStateValues): UiEvalEnv {
  const env = new Map<string, UiEvalResult>();
  for (const definition of artifact.stateDefinitions) {
    const value = values[definition.name];
    if (validateStateValue(definition, value) !== null) env.set(definition.name, { ok: false, error: "invalid_input" });
    else env.set(definition.name, { ok: true, value: value as UiScalar });
  }
  const receiving = artifact.status === "receiving";
  let order = artifact.derivedOrder;
  if (order.length !== artifact.derived.length) {
    // commit 之前依赖可能还没到齐：尽力排序，排不出来就先标记为等待中。
    const known = new Set(artifact.stateDefinitions.map(definition => definition.name));
    const sorted = sortDerived(known, artifact.derived);
    order = sorted.ok ? sorted.order : [];
  }
  const byName = new Map(artifact.derived.map(item => [item.name, item] as const));
  for (const name of order) {
    const result = evaluateExpression(byName.get(name)!.expression, env);
    env.set(name, receiving && !result.ok && result.error === "unknown_ref" ? { ok: false, error: "pending_ref" } : result);
  }
  for (const item of artifact.derived) {
    if (!env.has(item.name)) env.set(item.name, { ok: false, error: receiving ? "pending_ref" : "unknown_ref" });
  }
  return env;
}

/** 字面量原样返回，表达式求值。 */
export function resolveUiValue(value: unknown, env: UiEvalEnv, receiving = false): UiEvalResult {
  if (value === undefined) return { ok: false, error: "bad_arguments" };
  if (value === null || typeof value !== "object") return { ok: true, value: value as UiScalar };
  const result = evaluateExpression(value as Parameters<typeof evaluateExpression>[0], env);
  return receiving && !result.ok && result.error === "unknown_ref" ? { ok: false, error: "pending_ref" } : result;
}

/** show 条件：没有条件即显示；条件必须算出 true，出错一律隐藏。 */
export function isUiNodeVisible(node: Pick<UiNode, "show">, env: UiEvalEnv): boolean {
  if (node.show === undefined) return true;
  const result = evaluateExpression(node.show, env);
  return result.ok && result.value === true;
}

/** 显示用的数字格式：给了 digits 就固定位数，否则最多 6 位小数并去掉多余的 0。 */
export function formatUiNumber(value: number, digits?: number): string {
  if (digits !== undefined) {
    const formatted = formatNumber(value, digits, "number");
    return formatted.ok ? String(formatted.value) : String(value);
  }
  const formatted = formatNumber(value, 6, "number");
  if (!formatted.ok) return String(value);
  const text = String(formatted.value);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

export function formatUiScalar(value: UiScalar, digits?: number): string {
  if (value === null) return "";
  if (typeof value === "number") return formatUiNumber(value, digits);
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

// ---------- 文字化：提交给 Agent 与导出 ----------

function labelFor(artifact: UiArtifact, name: string): string {
  for (const node of artifact.nodes) {
    if (node.props.bind === name && typeof node.props.label === "string") return node.props.label;
  }
  return name;
}

function describeValue(artifact: UiArtifact, name: string, values: UiStateValues): string {
  const definition = artifact.stateDefinitions.find(item => item.name === name);
  const value = values[name];
  if (!definition) return "";
  if (definition.kind === "boolean") return value === true ? "yes" : "no";
  if (value === null || value === undefined) return "(empty)";
  if (definition.kind === "string") {
    // 选项类状态给出显示标签，比内部值更容易被模型读懂。
    for (const node of artifact.nodes) {
      if (node.props.bind !== name || !Array.isArray(node.props.options)) continue;
      const option = (node.props.options as Array<{ value: string; label: string }>).find(item => item.value === value);
      if (option && option.label !== option.value) return `${option.label} (${option.value})`;
    }
  }
  return formatUiScalar(value as UiScalar);
}

/**
 * 「继续交给 Agent」要发送的完整文字。预览与实际发送用同一个函数，所以用户看到的就是发出去的。
 * include 缺省表示全部状态。
 */
export function composeUiSubmission(
  artifact: UiArtifact,
  action: Extract<UiAction, { type: "submit_to_agent" }>,
  values: UiStateValues,
): string {
  const names = (action.include ?? artifact.stateDefinitions.map(item => item.name))
    .filter(name => artifact.stateDefinitions.some(item => item.name === name));
  const lines = names.map(name => `- ${labelFor(artifact, name)} (${name}): ${describeValue(artifact, name, values)}`);
  const header = artifact.title ? `[${artifact.title}]` : "";
  const body = lines.length ? `${action.text}\n\nCurrent parameters${header ? ` ${header}` : ""}:\n${lines.join("\n")}` : action.text;
  return body.slice(0, uiLimits.textLength);
}

function plainText(value: unknown, env: UiEvalEnv): string {
  const result = resolveUiValue(value, env);
  return result.ok ? formatUiScalar(result.value) : "";
}

/** 交互 UI 的纯文字等价物：导出和「查看文字」使用，不含任何可执行内容。 */
export function summarizeUiArtifact(artifact: UiArtifact, values: UiStateValues = initialUiValues(artifact)): string {
  if (artifact.status === "invalid" || artifact.status === "disposed" || !artifact.rootNodeId) return "";
  const env = buildUiEnv(artifact, values);
  const byId = new Map(artifact.nodes.map(node => [node.id, node] as const));
  const lines: string[] = [];
  if (artifact.title) lines.push(`**${artifact.title}**`);
  const walk = (node: UiNode): void => {
    if (node.invalid || !isUiNodeVisible(node, env)) return;
    const props = node.props;
    const visit = () => node.childrenIds.forEach(id => { const child = byId.get(id); if (child) walk(child); });
    switch (node.type) {
      case "heading": lines.push(`### ${plainText(props.text, env)}`); break;
      case "text": case "caption": lines.push(plainText(props.text, env)); break;
      case "code": lines.push("```", String(props.code ?? ""), "```"); break;
      case "card": if (props.title) lines.push(`**${String(props.title)}**`); visit(); break;
      case "collapsible": lines.push(`**${String(props.title ?? "")}**`); visit(); break;
      case "stat": {
        const result = resolveUiValue(props.value, env);
        const value = result.ok ? formatUiScalar(result.value, props.digits as number | undefined) : "(unavailable)";
        lines.push(`${String(props.label)}: ${props.prefix ?? ""}${value}${props.unit ? ` ${String(props.unit)}` : ""}`);
        break;
      }
      case "progress": {
        const result = resolveUiValue(props.value, env);
        lines.push(`${String(props.label)}: ${result.ok ? formatUiScalar(result.value) : "(unavailable)"} / ${String(props.max)}${props.unit ? ` ${String(props.unit)}` : ""}`);
        break;
      }
      case "list": {
        const items = (props.items as Array<{ text: string; detail: string | null }>) ?? [];
        items.forEach((item, index) => lines.push(`${props.ordered ? `${index + 1}.` : "-"} ${item.text}${item.detail ? ` — ${item.detail}` : ""}`));
        break;
      }
      case "table": {
        const columns = props.columns as Array<{ key: string; label: string }>;
        const rows = props.rows as Array<{ cells: Record<string, UiScalar> }>;
        const cell = (value: UiScalar) => formatUiScalar(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
        if (props.caption) lines.push(`*${String(props.caption)}*`);
        lines.push(`| ${columns.map(column => cell(column.label)).join(" | ")} |`);
        lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
        for (const row of rows) lines.push(`| ${columns.map(column => cell(row.cells[column.key] ?? null)).join(" | ")} |`);
        break;
      }
      case "tabs": case "segmented": case "select": case "radio": case "input": case "number_input": case "slider": case "checkbox": {
        const name = String(props.bind);
        lines.push(`${String(props.label)}: ${describeValue(artifact, name, values)}${props.unit ? ` ${String(props.unit)}` : ""}`);
        if (node.type === "tabs") visit();
        break;
      }
      case "empty": case "error": lines.push(`${String(props.title)}${props.description ? ` — ${String(props.description)}` : ""}`); break;
      case "column": case "row": case "grid": visit(); break;
      default: break;
    }
  };
  const root = byId.get(artifact.rootNodeId);
  if (root) walk(root);
  if (artifact.status !== "ready") lines.push("(incomplete)");
  return lines.join("\n");
}

// ---------- 本地状态快照：键与格式（Renderer 写入，导出等 Main 侧功能读取） ----------

export const uiStateVersion = 1;

/** conversationId + 稳定消息位置（u0、u1…）+ artifactId。 */
export interface UiStateScope {
  conversationId: string;
  messageId: string;
  artifactId: string;
}

export const uiStateKeyPrefix = "vela.ui";

export function uiStateStorageKey(scope: UiStateScope): string {
  return `${uiStateKeyPrefix}.state.${scope.conversationId}.${scope.messageId}.${scope.artifactId}`;
}

/** 内容指纹：同一位置的界面被改写后，旧快照因指纹不符被丢弃。 */
export function uiSourceFingerprint(artifactId: string, raw: string): string {
  return hashUiSource(`${artifactId}\n${raw}`);
}

/** 解析保存的快照；版本、指纹或结构不符返回 null，并剔除原型污染键。 */
export function parseUiStateSnapshot(raw: string | null | undefined, fingerprint: string): Record<string, UiValue> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as { v?: unknown; hash?: unknown; values?: unknown };
    if (record.v !== uiStateVersion || record.hash !== fingerprint) return null;
    if (!record.values || typeof record.values !== "object" || Array.isArray(record.values)) return null;
    return Object.fromEntries(Object.entries(record.values as Record<string, unknown>).filter(([key]) => !isForbiddenKey(key))) as Record<string, UiValue>;
  } catch {
    return null;
  }
}

export function serializeUiStateSnapshot(fingerprint: string, values: Record<string, UiValue>): string {
  return JSON.stringify({ v: uiStateVersion, hash: fingerprint, values });
}

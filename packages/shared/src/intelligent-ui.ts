/**
 * Intelligent UI（内部代号 Vela UI）共享协议：版本、上限、类型和通用校验。
 *
 * 模型只能「描述」界面：这里的一切都是纯数据，不含 React、Electron 或任何可执行内容。
 * 解析器（intelligent-ui-parser）、表达式求值器（intelligent-ui-expression）和组件注册表
 * （intelligent-ui-components）都只依赖本文件，保证可以脱离平台单测。
 */

export const uiSchemaVersion = 1;
/** 模型输出里的围栏信息串。 */
export const uiFenceInfo = "vela-ui";

/** 用户级偏好：auto 由模型按内容决定；visual_first 倾向可视化但不强制；text_only 完全关闭。 */
export type UiPreference = "auto" | "text_only" | "visual_first";
export const uiPreferences: readonly UiPreference[] = ["auto", "text_only", "visual_first"];
export const defaultUiPreference: UiPreference = "auto";

export function isUiPreference(value: unknown): value is UiPreference {
  return value === "auto" || value === "text_only" || value === "visual_first";
}

/** 单块 UI 的硬上限；超限即停止解析并降级。 */
export const uiLimits = {
  /** 原始协议字节数（UTF-8）。 */
  rawBytes: 256 * 1024,
  /** 单行 NDJSON 的字节数。 */
  lineBytes: 48 * 1024,
  nodes: 200,
  depth: 12,
  states: 50,
  derived: 50,
  /** 所有选项（select/radio/tabs/segmented 与 table 行）的总数。 */
  options: 500,
  tableRows: 200,
  tableColumns: 12,
  listItems: 100,
  children: 100,
  stringLength: 2_000,
  textLength: 8_000,
  codeLength: 8_000,
  expressionDepth: 8,
  expressionNodes: 64,
  expressionArgs: 16,
  /** 表达式字符串字面量。 */
  expressionString: 500,
} as const;

// ---------- 值与表达式 ----------

export type UiScalar = string | number | boolean | null;
/** 状态与表格单元格可以持有的值。 */
export type UiValue = string | number | boolean | null | string[];

export const uiExpressionOps = [
  "add", "subtract", "multiply", "divide", "round", "floor", "ceil", "abs", "min", "max",
  "compare", "if", "and", "or", "not", "format", "concat",
] as const;
export type UiExpressionOp = typeof uiExpressionOps[number];
export const uiCompareOps = ["lt", "lte", "gt", "gte", "eq", "neq"] as const;
export type UiCompareOp = typeof uiCompareOps[number];
export const uiFormatStyles = ["number", "fixed", "percent"] as const;
export type UiFormatStyle = typeof uiFormatStyles[number];

/** 声明式纯计算 AST：引用状态/派生值，或对子表达式应用白名单运算。 */
export type UiExpression =
  | UiScalar
  | { ref: string }
  | { op: UiExpressionOp; args: UiExpression[] };

/** 允许写成字面量或表达式的属性。 */
export type UiDynamic<T extends UiScalar = UiScalar> = T | { ref: string } | { op: UiExpressionOp; args: UiExpression[] };

// ---------- 状态与派生值 ----------

export type UiStateKind = "number" | "string" | "boolean";

export interface UiStateDefinition {
  name: string;
  kind: UiStateKind;
  initial: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** string 类状态的最大长度。 */
  maxLength?: number;
  /** 限定 string 状态只能取这些值（选择类控件）。 */
  options?: string[];
}

export interface UiDerivedDefinition {
  name: string;
  expression: UiExpression;
}

// ---------- 动作 ----------

/**
 * 动作只描述意图，不是授权。JSON 到达不执行任何东西，只有用户在界面上点击才会触发；
 * `submit_to_agent` 与 `open_external` 额外要求一次可见的确认。
 */
export type UiAction =
  | { type: "set_state"; name: string; value: UiScalar }
  | { type: "toggle"; name: string }
  | { type: "copy"; text: UiDynamic<string> }
  | { type: "submit_to_agent"; text: string; include?: string[] }
  | { type: "open_external"; url: string };

export const uiActionTypes = ["set_state", "toggle", "copy", "submit_to_agent", "open_external"] as const;

// ---------- 数据状态标注 ----------

export type UiDataStatus = "ok" | "loading" | "stale" | "error" | "empty";
export const uiDataStatuses: readonly UiDataStatus[] = ["ok", "loading", "stale", "error", "empty"];

/** 模型给出的来源说明。Vela 无法验证它，渲染时一律标「未验证」。 */
export interface UiSourceNote {
  label: string;
  url?: string;
}

// ---------- 节点 ----------

export const uiComponentTypes = [
  "text", "heading", "caption", "code",
  "column", "row", "grid", "divider", "card",
  "table", "stat", "progress", "list",
  "tabs", "segmented", "select", "radio",
  "input", "number_input", "slider", "checkbox",
  "button", "collapsible",
  "loading", "empty", "error",
] as const;
export type UiComponentType = typeof uiComponentTypes[number];

export function isUiComponentType(value: unknown): value is UiComponentType {
  return typeof value === "string" && (uiComponentTypes as readonly string[]).includes(value);
}

/** 容器类组件，其余为叶子。 */
export const uiContainerTypes: ReadonlySet<string> = new Set(["column", "row", "grid", "card", "tabs", "collapsible"]);

/** 经注册表校验和规整后的属性；渲染层只读取这里，不碰模型原始 JSON。 */
export type UiProps = Readonly<Record<string, unknown>>;

export interface UiNode {
  id: string;
  /** 未被注册表识别的类型保留原文，由渲染层显示占位。 */
  type: string;
  parentId: string | null;
  props: UiProps;
  childrenIds: string[];
  /** 属性校验失败或类型未知时的原因；渲染层显示占位而不是尽力执行。 */
  invalid?: string;
  /** 校验后的显示条件；为假时整个节点不渲染。 */
  show?: UiExpression;
}

export type UiArtifactStatus = "receiving" | "ready" | "incomplete" | "invalid" | "disposed";

export type UiRejectReason =
  | "bad_json"
  | "bad_op"
  | "unknown_op"
  | "unsupported_version"
  | "forbidden_key"
  | "duplicate_id"
  | "missing_parent"
  | "second_root"
  | "root_required"
  | "limit_nodes"
  | "limit_depth"
  | "limit_states"
  | "limit_derived"
  | "limit_options"
  | "limit_bytes"
  | "limit_line"
  | "bad_state"
  | "bad_derive"
  | "bad_reference"
  | "cyclic_reference"
  | "bad_binding"
  | "not_container"
  | "empty_artifact";

export interface UiDiagnostic {
  /** 出问题的 NDJSON 行号（从 1 开始，围栏之后第一行为 1）。 */
  line: number;
  code: UiRejectReason | "node_rejected" | "op_after_commit";
  message: string;
}

/** 一块 UI 的解析结果。与会话的关联（conversationId/messageId）由 UiArtifactRef 在边界处补全。 */
export interface UiArtifact {
  schemaVersion: typeof uiSchemaVersion;
  artifactId: string;
  title: string | null;
  status: UiArtifactStatus;
  rootNodeId: string | null;
  /** 按到达顺序排列；父节点总在子节点之前。 */
  nodes: UiNode[];
  stateDefinitions: UiStateDefinition[];
  derived: UiDerivedDefinition[];
  /** 派生值的拓扑顺序；commit 后才有。 */
  derivedOrder: string[];
  /** status 为 invalid 时的原因。 */
  reason: UiRejectReason | null;
  diagnostics: UiDiagnostic[];
  /** 每次内容变化递增，渲染层用它判断是否需要重绘。 */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** 本地状态和持久化使用的稳定引用。 */
export interface UiArtifactRef {
  conversationId: string;
  messageId: string;
  artifactId: string;
}

export function uiArtifactKey(ref: UiArtifactRef): string {
  return `${ref.conversationId}/${ref.messageId}/${ref.artifactId}`;
}

// ---------- 通用校验 ----------

const forbiddenKeys: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isForbiddenKey(key: string): boolean {
  return forbiddenKeys.has(key);
}

/** 标识符：状态名、派生值名、列 key。 */
export const uiNameRe = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** 节点与 artifact id。 */
export const uiIdRe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isUiName(value: unknown): value is string {
  return typeof value === "string" && uiNameRe.test(value) && !isForbiddenKey(value);
}

export function isUiId(value: unknown): value is string {
  return typeof value === "string" && uiIdRe.test(value) && !isForbiddenKey(value);
}

/**
 * 递归检查原型污染键。深度和宽度同时受限，所以恶意嵌套不会拖垮校验本身。
 * 返回 true 表示发现禁止的键或结构过深。
 */
export function hasForbiddenStructure(value: unknown, depth = 0, budget = { nodes: 5_000 }): boolean {
  if (depth > 32) return true;
  if (value === null || typeof value !== "object") return false;
  if (--budget.nodes < 0) return true;
  if (Array.isArray(value)) return value.some(item => hasForbiddenStructure(item, depth + 1, budget));
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) return true;
    if (hasForbiddenStructure((value as Record<string, unknown>)[key], depth + 1, budget)) return true;
  }
  return false;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** UTF-8 字节数，不依赖 Buffer，Renderer 与 Node 都能用。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** 链接协议白名单：UI 里出现的外链只允许 http(s) 与 mailto。 */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const value = url.trim();
  if (!value || value.length > 2_000 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (!match) return null;
  const protocol = match[1].toLowerCase();
  if (protocol !== "https" && protocol !== "http" && protocol !== "mailto") return null;
  return value;
}

import {
  collectRefs,
  parseExpression,
} from "./intelligent-ui-expression";
import {
  isPlainObject,
  isUiName,
  safeExternalUrl,
  uiDataStatuses,
  uiLimits,
  type UiAction,
  type UiDataStatus,
  type UiDynamic,
  type UiExpression,
  type UiProps,
  type UiScalar,
  type UiSourceNote,
  type UiStateKind,
} from "./intelligent-ui";

/**
 * 版本化组件白名单注册表（v1）。
 * 每个组件的校验函数把模型给的原始 props 规整成渲染层可直接使用的结构：
 * 未知字段被丢弃，数值被限幅，字符串被截断检查，动作被限制在注册动作里。
 * 渲染层永远不接触模型的原始 JSON。
 */

export interface UiComponentBinding {
  name: string;
  /** 该控件要求绑定的状态类型。 */
  kind: UiStateKind;
}

export interface UiValidatedProps {
  props: UiProps;
  show?: UiExpression;
  /** 表达式、动作和 bind 引用的名称，commit 时必须都已定义。 */
  refs: string[];
  /** 控件绑定，commit 时检查状态类型。 */
  bindings: UiComponentBinding[];
  /** 计入 options 总上限的条目数（选项、表格行、列表项）。 */
  optionCount: number;
}

export type UiPropsResult =
  | { ok: true; value: UiValidatedProps }
  | { ok: false; reason: string };

class PropError extends Error {}

function reject(message: string): never {
  throw new PropError(message);
}

interface Collector {
  refs: Set<string>;
  bindings: UiComponentBinding[];
  optionCount: number;
}

type Raw = Record<string, unknown>;

// ---------- 字段读取工具 ----------

function text(raw: Raw, key: string, options: { max?: number; required?: boolean; fallback?: string } = {}): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (options.required) reject(`${key} is required`);
    return options.fallback;
  }
  if (typeof value !== "string") reject(`${key} must be a string`);
  if (options.required && !value.trim()) reject(`${key} must not be empty`);
  if (value.length > (options.max ?? uiLimits.stringLength)) reject(`${key} is too long`);
  return value;
}

function number(raw: Raw, key: string, options: { min?: number; max?: number; integer?: boolean; fallback?: number; required?: boolean } = {}): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (options.required) reject(`${key} is required`);
    return options.fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) reject(`${key} must be a finite number`);
  if (options.integer && !Number.isInteger(value)) reject(`${key} must be an integer`);
  if (options.min !== undefined && value < options.min) reject(`${key} is below ${options.min}`);
  if (options.max !== undefined && value > options.max) reject(`${key} is above ${options.max}`);
  return value;
}

function bool(raw: Raw, key: string, fallback = false): boolean {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") reject(`${key} must be a boolean`);
  return value;
}

function choice<T extends string>(raw: Raw, key: string, allowed: readonly T[], fallback: T): T {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) reject(`${key} must be one of ${allowed.join("|")}`);
  return value as T;
}

function expression(value: unknown, collector: Collector, label: string): UiExpression {
  const parsed = parseExpression(value);
  if (!parsed.ok) reject(`${label}: ${parsed.reason}`);
  for (const ref of collectRefs(parsed.expression)) collector.refs.add(ref);
  return parsed.expression;
}

/** 字符串属性：字面量或表达式。 */
function dynText(raw: Raw, key: string, collector: Collector, options: { max?: number; required?: boolean } = {}): UiDynamic<string> | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (options.required) reject(`${key} is required`);
    return undefined;
  }
  if (typeof value === "string") {
    if (value.length > (options.max ?? uiLimits.textLength)) reject(`${key} is too long`);
    return value;
  }
  if (!isPlainObject(value)) reject(`${key} must be a string or an expression`);
  return expression(value, collector, key) as UiDynamic<string>;
}

/** 数值/标量属性：字面量或表达式。 */
function dynScalar(raw: Raw, key: string, collector: Collector, options: { required?: boolean } = {}): UiDynamic | undefined {
  const value = raw[key];
  if (value === undefined) {
    if (options.required) reject(`${key} is required`);
    return undefined;
  }
  if (typeof value === "string" && value.length > uiLimits.stringLength) reject(`${key} is too long`);
  if (value === null || typeof value !== "object") return value as UiScalar;
  return expression(value, collector, key) as UiDynamic;
}

function bind(raw: Raw, collector: Collector, kind: UiStateKind): string {
  const name = raw.bind;
  if (!isUiName(name)) reject("bind must name a state");
  collector.refs.add(name);
  collector.bindings.push({ name, kind });
  return name;
}

function source(raw: Raw): UiSourceNote | undefined {
  const value = raw.source;
  if (value === undefined || value === null) return undefined;
  const note = typeof value === "string" ? { label: value } : value;
  if (!isPlainObject(note)) reject("source must be a string or object");
  const label = text(note, "label", { max: 200, required: true })!;
  const url = note.url === undefined || note.url === null ? undefined : safeExternalUrl(note.url);
  if (note.url !== undefined && note.url !== null && !url) reject("source url must be http(s)");
  return url ? { label, url } : { label };
}

function status(raw: Raw): UiDataStatus | undefined {
  const value = raw.status;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(uiDataStatuses as readonly string[]).includes(value)) reject("status is not supported");
  return value as UiDataStatus;
}

function options(raw: Raw, key: string, collector: Collector, max: number): Array<{ value: string; label: string; description?: string }> {
  const value = raw[key];
  if (!Array.isArray(value) || value.length === 0) reject(`${key} must be a non-empty array`);
  if (value.length > max) reject(`${key} has too many entries`);
  const seen = new Set<string>();
  const result = value.map((item): { value: string; label: string; description?: string } => {
    const entry = typeof item === "string" ? { value: item, label: item } : item;
    if (!isPlainObject(entry)) reject(`${key} entries must be strings or objects`);
    const optionValue = text(entry, "value", { max: 100, required: true })!;
    const label = text(entry, "label", { max: 200, fallback: optionValue })!;
    const description = text(entry, "description", { max: 500 });
    if (seen.has(optionValue)) reject(`${key} has duplicate value ${optionValue.slice(0, 20)}`);
    seen.add(optionValue);
    return description ? { value: optionValue, label, description } : { value: optionValue, label };
  });
  collector.optionCount += result.length;
  return result;
}

function names(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value)) reject(`${label} must be an array`);
  if (value.length > max) reject(`${label} has too many entries`);
  return value.map(item => {
    if (!isUiName(item)) reject(`${label} entries must be state names`);
    return item;
  });
}

/** 动作只描述意图；外链协议、名称与长度在这里就被收紧。 */
export function parseAction(value: unknown, collector: { refs: Set<string> }): UiAction {
  if (!isPlainObject(value)) reject("action must be an object");
  const type = value.type;
  const withCollector = collector as Collector;
  switch (type) {
    case "set_state": {
      if (!isUiName(value.name)) reject("action.name must be a state name");
      const scalar = value.value;
      if (scalar !== null && typeof scalar !== "string" && typeof scalar !== "number" && typeof scalar !== "boolean") reject("action.value must be a scalar");
      if (typeof scalar === "number" && !Number.isFinite(scalar)) reject("action.value must be finite");
      if (typeof scalar === "string" && scalar.length > uiLimits.stringLength) reject("action.value is too long");
      collector.refs.add(value.name);
      return { type, name: value.name, value: scalar };
    }
    case "toggle": {
      if (!isUiName(value.name)) reject("action.name must be a state name");
      collector.refs.add(value.name);
      return { type, name: value.name };
    }
    case "copy": {
      const textValue = dynText(value, "text", withCollector, { max: uiLimits.textLength, required: true })!;
      return { type, text: textValue };
    }
    case "submit_to_agent": {
      const message = text(value, "text", { max: 2_000, required: true })!;
      if (value.include === undefined) return { type, text: message };
      const include = names(value.include, "action.include", 20);
      for (const name of include) collector.refs.add(name);
      return { type, text: message, include };
    }
    case "open_external": {
      const url = safeExternalUrl(value.url);
      if (!url) reject("action.url must be an http(s) or mailto link");
      return { type, url };
    }
    default:
      reject("unknown action type");
  }
}

function children(node: Raw): void {
  if ("children" in node) reject("children are declared with parent, not props");
}

// ---------- 各组件 ----------

const gaps = ["sm", "md", "lg"] as const;
const tones = ["default", "muted", "success", "warning", "danger"] as const;

type Validator = (raw: Raw, collector: Collector) => UiProps;

const validators: Record<string, Validator> = {
  text: (raw, c) => ({
    text: dynText(raw, "text", c, { required: true }),
    tone: choice(raw, "tone", tones, "default"),
  }),
  heading: (raw, c) => ({
    text: dynText(raw, "text", c, { max: 300, required: true }),
    level: number(raw, "level", { min: 1, max: 3, integer: true, fallback: 2 }),
  }),
  caption: (raw, c) => ({ text: dynText(raw, "text", c, { max: 1_000, required: true }) }),
  code: (raw) => ({
    code: text(raw, "code", { max: uiLimits.codeLength, required: true }),
    language: text(raw, "language", { max: 32 }),
  }),
  column: (raw) => ({ gap: choice(raw, "gap", gaps, "md") }),
  row: (raw) => ({ gap: choice(raw, "gap", gaps, "md"), wrap: bool(raw, "wrap", true) }),
  grid: (raw) => ({
    gap: choice(raw, "gap", gaps, "md"),
    columns: number(raw, "columns", { min: 1, max: 6, integer: true, fallback: 2 }),
  }),
  divider: () => ({}),
  card: (raw) => ({
    title: text(raw, "title", { max: 200 }),
    description: text(raw, "description", { max: 1_000 }),
    tone: choice(raw, "tone", tones, "default"),
  }),
  table: (raw, c) => {
    const columnsRaw = raw.columns;
    if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) reject("columns must be a non-empty array");
    if (columnsRaw.length > uiLimits.tableColumns) reject("too many columns");
    const keys = new Set<string>();
    const columns = columnsRaw.map(item => {
      if (!isPlainObject(item)) reject("columns must be objects");
      if (!isUiName(item.key)) reject("column key must be an identifier");
      if (keys.has(item.key)) reject("duplicate column key");
      keys.add(item.key);
      return {
        key: item.key,
        label: text(item, "label", { max: 100, fallback: item.key })!,
        align: choice(item, "align", ["left", "right", "center"] as const, "left"),
        sortable: bool(item, "sortable", false),
        unit: text(item, "unit", { max: 20 }),
        prefix: text(item, "prefix", { max: 10 }),
        digits: number(item, "digits", { min: 0, max: 6, integer: true }),
      };
    });
    const rowsRaw = raw.rows ?? [];
    if (!Array.isArray(rowsRaw)) reject("rows must be an array");
    if (rowsRaw.length > uiLimits.tableRows) reject("too many rows");
    const rows = rowsRaw.map(row => {
      if (!isPlainObject(row)) reject("rows must be objects");
      const cells: Record<string, UiScalar> = {};
      for (const key of keys) {
        const cell = row[key];
        if (cell === undefined || cell === null) cells[key] = null;
        else if (typeof cell === "string") {
          if (cell.length > uiLimits.stringLength) reject("cell is too long");
          cells[key] = cell;
        } else if (typeof cell === "number" && Number.isFinite(cell)) cells[key] = cell;
        else if (typeof cell === "boolean") cells[key] = cell;
        else reject("cells must be scalar values");
      }
      const detail = text(row, "detail", { max: 2_000 });
      return { cells, detail: detail ?? null };
    });
    c.optionCount += rows.length;
    let filter: { bind: string; column: string; allValue: string } | undefined;
    if (raw.filter !== undefined && raw.filter !== null) {
      if (!isPlainObject(raw.filter)) reject("filter must be an object");
      const name = bind(raw.filter, c, "string");
      const column = raw.filter.column;
      if (typeof column !== "string" || !keys.has(column)) reject("filter.column must be a column key");
      filter = { bind: name, column, allValue: text(raw.filter, "allValue", { max: 100, fallback: "all" })! };
    }
    let defaultSort: { column: string; direction: "asc" | "desc" } | undefined;
    if (raw.defaultSort !== undefined && raw.defaultSort !== null) {
      if (!isPlainObject(raw.defaultSort)) reject("defaultSort must be an object");
      const column = raw.defaultSort.column;
      if (typeof column !== "string" || !keys.has(column)) reject("defaultSort.column must be a column key");
      defaultSort = { column, direction: choice(raw.defaultSort, "direction", ["asc", "desc"] as const, "asc") };
    }
    return {
      caption: text(raw, "caption", { max: 300 }),
      columns,
      rows,
      searchable: bool(raw, "searchable", false),
      filter,
      defaultSort,
      emptyText: text(raw, "emptyText", { max: 300 }),
      source: source(raw),
      status: status(raw),
    };
  },
  stat: (raw, c) => {
    const valueKey = raw.derive !== undefined ? "derive" : "value";
    return {
      label: text(raw, "label", { max: 200, required: true }),
      value: dynScalar(raw, valueKey, c, { required: true }),
      unit: text(raw, "unit", { max: 20 }),
      prefix: text(raw, "prefix", { max: 10 }),
      digits: number(raw, "digits", { min: 0, max: 10, integer: true }),
      description: text(raw, "description", { max: 500 }),
      emptyText: text(raw, "emptyText", { max: 200 }),
      source: source(raw),
      status: status(raw),
    };
  },
  progress: (raw, c) => ({
    label: text(raw, "label", { max: 200, required: true }),
    value: dynScalar(raw, "value", c, { required: true }),
    max: number(raw, "max", { min: Number.MIN_VALUE, fallback: 100 }),
    unit: text(raw, "unit", { max: 20 }),
    source: source(raw),
    status: status(raw),
  }),
  list: (raw, c) => {
    const items = raw.items;
    if (!Array.isArray(items)) reject("items must be an array");
    if (items.length > uiLimits.listItems) reject("too many items");
    const normalized = items.map(item => {
      if (typeof item === "string") {
        if (item.length > 500) reject("item is too long");
        return { text: item, detail: null as string | null };
      }
      if (!isPlainObject(item)) reject("items must be strings or objects");
      return { text: text(item, "text", { max: 500, required: true })!, detail: text(item, "detail", { max: 1_000 }) ?? null };
    });
    c.optionCount += normalized.length;
    return {
      items: normalized,
      ordered: bool(raw, "ordered", false),
      emptyText: text(raw, "emptyText", { max: 200 }),
      source: source(raw),
      status: status(raw),
    };
  },
  tabs: (raw, c) => ({
    bind: bind(raw, c, "string"),
    label: text(raw, "label", { max: 200, required: true }),
    options: options(raw, "options", c, 12),
  }),
  segmented: (raw, c) => ({
    bind: bind(raw, c, "string"),
    label: text(raw, "label", { max: 200, required: true }),
    description: text(raw, "description", { max: 500 }),
    options: options(raw, "options", c, 8),
  }),
  select: (raw, c) => ({
    bind: bind(raw, c, "string"),
    label: text(raw, "label", { max: 200, required: true }),
    description: text(raw, "description", { max: 500 }),
    options: options(raw, "options", c, 100),
  }),
  radio: (raw, c) => ({
    bind: bind(raw, c, "string"),
    label: text(raw, "label", { max: 200, required: true }),
    description: text(raw, "description", { max: 500 }),
    options: options(raw, "options", c, 20),
  }),
  input: (raw, c) => ({
    bind: bind(raw, c, "string"),
    label: text(raw, "label", { max: 200, required: true }),
    description: text(raw, "description", { max: 500 }),
    placeholder: text(raw, "placeholder", { max: 200 }),
    required: bool(raw, "required", false),
    disabled: bool(raw, "disabled", false),
  }),
  number_input: (raw, c) => ({
    bind: bind(raw, c, "number"),
    label: text(raw, "label", { max: 200, required: true }),
    description: text(raw, "description", { max: 500 }),
    unit: text(raw, "unit", { max: 20 }),
    required: bool(raw, "required", true),
    disabled: bool(raw, "disabled", false),
  }),
  slider: (raw, c) => ({
    bind: bind(raw, c, "number"),
    label: text(raw, "label", { max: 200, required: true }),
    description: text(raw, "description", { max: 500 }),
    unit: text(raw, "unit", { max: 20 }),
    disabled: bool(raw, "disabled", false),
  }),
  checkbox: (raw, c) => ({
    bind: bind(raw, c, "boolean"),
    label: text(raw, "label", { max: 200, required: true }),
    description: text(raw, "description", { max: 500 }),
    disabled: bool(raw, "disabled", false),
  }),
  button: (raw, c) => ({
    label: text(raw, "label", { max: 100, required: true }),
    variant: choice(raw, "variant", ["primary", "secondary"] as const, "secondary"),
    disabled: raw.disabled === undefined || raw.disabled === null || typeof raw.disabled === "boolean"
      ? bool(raw, "disabled", false)
      : expression(raw.disabled, c, "disabled"),
    action: parseAction(raw.action, c),
  }),
  collapsible: (raw) => ({
    title: text(raw, "title", { max: 200, required: true }),
    defaultOpen: bool(raw, "defaultOpen", false),
  }),
  loading: (raw) => ({ label: text(raw, "label", { max: 200 }) }),
  empty: (raw) => ({ title: text(raw, "title", { max: 200, required: true }), description: text(raw, "description", { max: 500 }) }),
  error: (raw) => ({ title: text(raw, "title", { max: 200, required: true }), description: text(raw, "description", { max: 500 }) }),
};

/** 注册表里有这个组件吗。 */
export function hasComponent(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(validators, type);
}

/**
 * 校验一个节点的 props。未知字段会被丢弃，因为输出只包含各组件显式读取的字段。
 * `show` 是所有组件共有的显示条件表达式。
 */
export function validateNodeProps(type: string, rawProps: unknown): UiPropsResult {
  if (!hasComponent(type)) return { ok: false, reason: `unsupported component ${type.slice(0, 40)}` };
  const raw = rawProps === undefined || rawProps === null ? {} : rawProps;
  if (!isPlainObject(raw)) return { ok: false, reason: "props must be an object" };
  const collector: Collector = { refs: new Set(), bindings: [], optionCount: 0 };
  try {
    children(raw);
    const props = validators[type](raw, collector);
    const show = raw.show === undefined || raw.show === null ? undefined : expression(raw.show, collector, "show");
    // 去掉值为 undefined 的键，保证规整结果可序列化且稳定。
    const normalized = Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined));
    return {
      ok: true,
      value: { props: normalized, show, refs: [...collector.refs], bindings: collector.bindings, optionCount: collector.optionCount },
    };
  } catch (error) {
    if (error instanceof PropError) return { ok: false, reason: error.message };
    throw error;
  }
}

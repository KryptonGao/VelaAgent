import {
  isForbiddenKey,
  isPlainObject,
  isUiName,
  uiCompareOps,
  uiExpressionOps,
  uiFormatStyles,
  uiLimits,
  type UiCompareOp,
  type UiExpression,
  type UiExpressionOp,
  type UiFormatStyle,
  type UiScalar,
} from "./intelligent-ui";

/**
 * 声明式表达式：校验 + 求值。没有 eval、Function、变量自由求值，也读不到环境、时间或文件。
 * 求值失败是普通的返回值（EvalError code），不抛异常，调用方据此显示可读的输入错误。
 */

export type UiEvalErrorCode =
  | "division_by_zero"
  | "not_finite"
  | "type_mismatch"
  | "unknown_ref"
  | "pending_ref"
  | "invalid_input"
  | "bad_arguments"
  | "too_deep"
  | "too_large";

export type UiEvalResult =
  | { ok: true; value: UiScalar }
  | { ok: false; error: UiEvalErrorCode };

/** 求值环境：状态与已算出的派生值。只读 Map，名称查不到就是 unknown_ref。 */
export type UiEvalEnv = ReadonlyMap<string, UiEvalResult>;

const opArity: Record<UiExpressionOp, { min: number; max: number }> = {
  add: { min: 2, max: uiLimits.expressionArgs },
  subtract: { min: 2, max: 2 },
  multiply: { min: 2, max: uiLimits.expressionArgs },
  divide: { min: 2, max: 2 },
  round: { min: 1, max: 2 },
  floor: { min: 1, max: 2 },
  ceil: { min: 1, max: 2 },
  abs: { min: 1, max: 1 },
  min: { min: 1, max: uiLimits.expressionArgs },
  max: { min: 1, max: uiLimits.expressionArgs },
  compare: { min: 3, max: 3 },
  if: { min: 3, max: 3 },
  and: { min: 2, max: uiLimits.expressionArgs },
  or: { min: 2, max: uiLimits.expressionArgs },
  not: { min: 1, max: 1 },
  format: { min: 1, max: 3 },
  concat: { min: 1, max: uiLimits.expressionArgs },
};

const opSet: ReadonlySet<string> = new Set(uiExpressionOps);

export type UiExpressionParse =
  | { ok: true; expression: UiExpression }
  | { ok: false; reason: string };

/** 把模型给出的 JSON 规整成 UiExpression；任何越界、未知运算或额外字段都会拒绝。 */
export function parseExpression(raw: unknown): UiExpressionParse {
  const budget = { nodes: 0 };
  const reason = check(raw, 0, budget);
  return reason ? { ok: false, reason } : { ok: true, expression: clone(raw) };
}

function check(raw: unknown, depth: number, budget: { nodes: number }): string | null {
  if (depth > uiLimits.expressionDepth) return "expression too deep";
  if (++budget.nodes > uiLimits.expressionNodes) return "expression too large";
  if (raw === null || typeof raw === "boolean") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? null : "non-finite literal";
  if (typeof raw === "string") return raw.length <= uiLimits.expressionString ? null : "string literal too long";
  if (!isPlainObject(raw)) return "unsupported expression value";
  const keys = Object.keys(raw);
  if (keys.some(isForbiddenKey)) return "forbidden key";
  if ("ref" in raw) {
    if (keys.length !== 1) return "ref takes no other fields";
    return isUiName(raw.ref) ? null : "invalid ref name";
  }
  if (keys.some(key => key !== "op" && key !== "args")) return "unknown expression field";
  const op = raw.op;
  if (typeof op !== "string" || !opSet.has(op)) return `unknown op ${typeof op === "string" ? op.slice(0, 32) : ""}`.trim();
  if (!Array.isArray(raw.args)) return "args must be an array";
  const arity = opArity[op as UiExpressionOp];
  if (raw.args.length < arity.min || raw.args.length > arity.max) return `wrong argument count for ${op}`;
  for (const arg of raw.args) {
    const reason = check(arg, depth + 1, budget);
    if (reason) return reason;
  }
  return null;
}

function clone(raw: unknown): UiExpression {
  if (raw === null || typeof raw !== "object") return raw as UiScalar;
  const value = raw as { ref?: string; op?: UiExpressionOp; args?: unknown[] };
  if (typeof value.ref === "string") return { ref: value.ref };
  return { op: value.op!, args: value.args!.map(clone) };
}

/** 收集表达式引用的所有名称，用于 commit 时的跨节点引用校验与依赖图。 */
export function collectRefs(expression: UiExpression | undefined, into: Set<string> = new Set()): Set<string> {
  if (expression === undefined || expression === null || typeof expression !== "object") return into;
  if ("ref" in expression) {
    into.add(expression.ref);
    return into;
  }
  for (const arg of expression.args) collectRefs(arg, into);
  return into;
}

/** 求值。branch 惰性：`if` 只算被选中的分支，所以守卫式写法不会误报除零。 */
export function evaluateExpression(expression: UiExpression | undefined, env: UiEvalEnv): UiEvalResult {
  if (expression === undefined) return { ok: false, error: "bad_arguments" };
  return evaluate(expression, env, 0);
}

function fail(error: UiEvalErrorCode): UiEvalResult {
  return { ok: false, error };
}

function ok(value: UiScalar): UiEvalResult {
  return { ok: true, value };
}

function finite(value: number): UiEvalResult {
  return Number.isFinite(value) ? ok(value) : fail("not_finite");
}

function evaluate(expression: UiExpression, env: UiEvalEnv, depth: number): UiEvalResult {
  if (depth > uiLimits.expressionDepth) return fail("too_deep");
  if (expression === null || typeof expression !== "object") return ok(expression);
  if ("ref" in expression) {
    const found = env.get(expression.ref);
    return found ?? fail("unknown_ref");
  }
  const { op, args } = expression;
  if (op === "if") {
    const condition = evaluate(args[0], env, depth + 1);
    if (!condition.ok) return condition;
    if (typeof condition.value !== "boolean") return fail("type_mismatch");
    return evaluate(condition.value ? args[1] : args[2], env, depth + 1);
  }
  if (op === "and" || op === "or") {
    // 短路求值，同样只在需要时才计算后续参数。
    for (const arg of args) {
      const result = evaluate(arg, env, depth + 1);
      if (!result.ok) return result;
      if (typeof result.value !== "boolean") return fail("type_mismatch");
      if (op === "and" && !result.value) return ok(false);
      if (op === "or" && result.value) return ok(true);
    }
    return ok(op === "and");
  }
  const values: UiScalar[] = [];
  for (const arg of args) {
    const result = evaluate(arg, env, depth + 1);
    if (!result.ok) return result;
    values.push(result.value);
  }
  return apply(op, values);
}

function numbers(values: UiScalar[]): number[] | null {
  const output: number[] = [];
  for (const value of values) {
    if (typeof value !== "number") return null;
    output.push(value);
  }
  return output;
}

function apply(op: UiExpressionOp, values: UiScalar[]): UiEvalResult {
  switch (op) {
    case "add": case "multiply": case "subtract": case "divide": case "min": case "max": case "abs": {
      const operands = numbers(values);
      if (!operands) return fail("type_mismatch");
      if (op === "add") return finite(operands.reduce((sum, value) => sum + value, 0));
      if (op === "multiply") return finite(operands.reduce((product, value) => product * value, 1));
      if (op === "subtract") return finite(operands[0] - operands[1]);
      if (op === "divide") return operands[1] === 0 ? fail("division_by_zero") : finite(operands[0] / operands[1]);
      if (op === "min") return finite(Math.min(...operands));
      if (op === "max") return finite(Math.max(...operands));
      return finite(Math.abs(operands[0]));
    }
    case "round": case "floor": case "ceil": {
      const [value, digits = 0] = values;
      if (typeof value !== "number" || typeof digits !== "number") return fail("type_mismatch");
      if (!Number.isInteger(digits) || digits < 0 || digits > 10) return fail("bad_arguments");
      return roundTo(value, digits, op);
    }
    case "compare": {
      const [left, operator, right] = values;
      if (typeof operator !== "string" || !(uiCompareOps as readonly string[]).includes(operator)) return fail("bad_arguments");
      return compare(left, operator as UiCompareOp, right);
    }
    case "not":
      return typeof values[0] === "boolean" ? ok(!values[0]) : fail("type_mismatch");
    case "format": {
      const [value, digits = 2, style = "number"] = values;
      if (typeof value !== "number" || typeof digits !== "number") return fail("type_mismatch");
      if (!Number.isInteger(digits) || digits < 0 || digits > 10) return fail("bad_arguments");
      if (typeof style !== "string" || !(uiFormatStyles as readonly string[]).includes(style)) return fail("bad_arguments");
      return formatNumber(value, digits, style as UiFormatStyle);
    }
    case "concat": {
      let text = "";
      for (const value of values) {
        if (value === null) continue;
        if (typeof value === "number" && !Number.isFinite(value)) return fail("not_finite");
        text += String(value);
        if (text.length > uiLimits.stringLength) return fail("too_large");
      }
      return ok(text);
    }
    default:
      // if / and / or 已在 evaluate 里处理。
      return fail("bad_arguments");
  }
}

/**
 * 小数舍入：用指数记法避开 1.005 * 100 = 100.49999 之类的二进制误差。
 * 默认按「远离零」四舍五入，所以 -1.005 → -1.01，与账单直觉一致。
 */
export function roundTo(value: number, digits: number, mode: "round" | "floor" | "ceil" = "round"): UiEvalResult {
  if (!Number.isFinite(value)) return fail("not_finite");
  const shift = (amount: number, places: number): number => {
    const [mantissa, exponent = "0"] = String(amount).split("e");
    return Number(`${mantissa}e${Number(exponent) + places}`);
  };
  const scaled = shift(Math.abs(value), digits);
  const sign = value < 0 ? -1 : 1;
  let integer: number;
  if (!Number.isFinite(scaled)) return finite(value);
  if (mode === "round") integer = Math.round(scaled);
  else if (mode === "floor") integer = sign < 0 ? Math.ceil(scaled) : Math.floor(scaled);
  else integer = sign < 0 ? Math.floor(scaled) : Math.ceil(scaled);
  const result = sign * shift(integer, -digits);
  return finite(Object.is(result, -0) ? 0 : result);
}

function compare(left: UiScalar, op: UiCompareOp, right: UiScalar): UiEvalResult {
  if (op === "eq") return ok(left === right);
  if (op === "neq") return ok(left !== right);
  if (typeof left === "number" && typeof right === "number") {
    if (op === "lt") return ok(left < right);
    if (op === "lte") return ok(left <= right);
    if (op === "gt") return ok(left > right);
    return ok(left >= right);
  }
  if (typeof left === "string" && typeof right === "string") {
    if (op === "lt") return ok(left < right);
    if (op === "lte") return ok(left <= right);
    if (op === "gt") return ok(left > right);
    return ok(left >= right);
  }
  return fail("type_mismatch");
}

/** 固定为 en-US 的千分位，保证测试和导出结果与系统区域无关。 */
export function formatNumber(value: number, digits: number, style: UiFormatStyle): UiEvalResult {
  if (!Number.isFinite(value)) return fail("not_finite");
  const scaled = style === "percent" ? value * 100 : value;
  const rounded = roundTo(scaled, digits);
  if (!rounded.ok) return rounded;
  const number = rounded.value as number;
  const magnitude = Math.abs(number);
  // toFixed 在 1e21 以上会退回科学记数法；整数部分用 BigInt 保持完整数字。
  const fixed = magnitude >= 1e21 ? `${BigInt(magnitude)}${digits > 0 ? `.${"0".repeat(digits)}` : ""}` : magnitude.toFixed(digits);
  const [integer, fraction] = fixed.split(".");
  const grouped = style === "fixed" ? integer : integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  const negative = number < 0 && Number(fixed) !== 0;
  return ok(`${negative ? "-" : ""}${body}${style === "percent" ? "%" : ""}`);
}

/**
 * 派生值依赖图的拓扑排序（Kahn）。states 是图的叶子；derived 之间不允许成环。
 * 返回排好序的派生名，或检测到环/未知引用时返回错误。
 */
export function sortDerived(
  stateNames: ReadonlySet<string>,
  derived: ReadonlyArray<{ name: string; expression: UiExpression }>,
): { ok: true; order: string[] } | { ok: false; reason: "cyclic_reference" | "bad_reference"; name: string } {
  const names = new Set(derived.map(item => item.name));
  const dependencies = new Map<string, Set<string>>();
  for (const item of derived) {
    const refs = collectRefs(item.expression);
    for (const ref of refs) {
      if (!stateNames.has(ref) && !names.has(ref)) return { ok: false, reason: "bad_reference", name: ref };
    }
    dependencies.set(item.name, new Set([...refs].filter(ref => names.has(ref))));
  }
  const remaining = new Map(dependencies);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => [...deps].every(dep => !remaining.has(dep)));
    if (ready.length === 0) return { ok: false, reason: "cyclic_reference", name: [...remaining.keys()][0] };
    // 与声明顺序保持稳定：同一层按声明顺序输出。
    for (const [name] of ready) {
      order.push(name);
      remaining.delete(name);
    }
  }
  return { ok: true, order };
}

import {
  hasForbiddenStructure,
  isPlainObject,
  isUiId,
  isUiName,
  uiFenceInfo,
  uiLimits,
  uiContainerTypes,
  uiSchemaVersion,
  utf8ByteLength,
  type UiArtifact,
  type UiDerivedDefinition,
  type UiDiagnostic,
  type UiNode,
  type UiRejectReason,
  type UiStateDefinition,
} from "./intelligent-ui";
import { hasComponent, validateNodeProps } from "./intelligent-ui-components";
import { collectRefs, parseExpression, sortDerived } from "./intelligent-ui-expression";

/**
 * `vela-ui` 事件块的增量编译器。
 *
 * 两层结构：
 * - UiArtifactBuilder：一行一行接收 NDJSON，校验后增量构建 UiArtifact；
 * - UiStreamParser：识别消息正文里的围栏，把正文切成 Markdown 与 UI 段，可任意切分输入。
 *
 * 只处理完整的行：半行永远不会传给组件。输入如何切分不影响结果（见测试）。
 */

const maxDiagnostics = 20;

interface BuilderOptions {
  now?: () => number;
}

export class UiArtifactBuilder {
  private status: UiArtifact["status"] = "receiving";
  private reason: UiRejectReason | null = null;
  private rootNodeId: string | null = null;
  private readonly nodes: UiNode[] = [];
  private readonly nodeIndex = new Map<string, UiNode>();
  private readonly depths = new Map<string, number>();
  private readonly states: UiStateDefinition[] = [];
  private readonly derived: UiDerivedDefinition[] = [];
  private derivedOrder: string[] = [];
  private readonly names = new Set<string>();
  private readonly diagnostics: UiDiagnostic[] = [];
  /** 每个节点校验出的引用与绑定，commit 时统一检查。 */
  private readonly pending: Array<{ nodeId: string; refs: string[]; bindings: Array<{ name: string; kind: string }> }> = [];
  private optionCount = 0;
  private revision = 0;
  private cached: UiArtifact | null = null;
  private readonly createdAt: number;
  private updatedAt: number;
  private readonly now: () => number;

  constructor(readonly artifactId: string, private title: string | null, options: BuilderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createdAt = this.updatedAt = this.now();
  }

  get isOpen(): boolean {
    return this.status === "receiving";
  }

  /** 直接标记为拒绝，用于 begin 阶段就已不合法的块。 */
  reject(reason: UiRejectReason, message: string, line = 1): void {
    this.fail(reason, message, line);
  }

  /** 应用一行 NDJSON。无效行使整块失效，后续行被忽略。 */
  applyLine(rawLine: string, line: number): void {
    if (this.status === "invalid" || this.status === "disposed") return;
    if (this.status === "ready" || this.status === "incomplete") {
      this.note({ line, code: "op_after_commit", message: "ignored data after commit" });
      return;
    }
    if (utf8ByteLength(rawLine) > uiLimits.lineBytes) return this.fail("limit_line", "line is too long", line);
    let value: unknown;
    try {
      value = JSON.parse(rawLine);
    } catch {
      return this.fail("bad_json", "line is not valid JSON", line);
    }
    if (!isPlainObject(value)) return this.fail("bad_op", "line is not an object", line);
    if (hasForbiddenStructure(value)) return this.fail("forbidden_key", "forbidden key in data", line);
    switch (value.op) {
      case "state": return this.applyState(value, line);
      case "derive": return this.applyDerive(value, line);
      case "node": return this.applyNode(value, line);
      case "commit": return this.commit(line);
      case "begin": return this.fail("bad_op", "begin appears twice", line);
      default: return this.fail("unknown_op", "unknown op", line);
    }
  }

  /** 输入结束：未 commit 的块标记为 incomplete，保留已验证的节点。 */
  finish(): void {
    if (this.status !== "receiving") return;
    this.status = "incomplete";
    this.touch();
  }

  /** 消息被删除或分支截断：释放内容。 */
  dispose(): void {
    this.status = "disposed";
    this.nodes.length = 0;
    this.nodeIndex.clear();
    this.touch();
  }

  snapshot(): UiArtifact {
    if (this.cached) return this.cached;
    this.cached = {
      schemaVersion: uiSchemaVersion,
      artifactId: this.artifactId,
      title: this.title,
      status: this.status,
      rootNodeId: this.rootNodeId,
      nodes: this.nodes.map(node => ({ ...node, childrenIds: [...node.childrenIds] })),
      stateDefinitions: [...this.states],
      derived: [...this.derived],
      derivedOrder: [...this.derivedOrder],
      reason: this.reason,
      diagnostics: [...this.diagnostics],
      revision: this.revision,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    return this.cached;
  }

  private touch(): void {
    this.revision += 1;
    this.updatedAt = this.now();
    this.cached = null;
  }

  private note(diagnostic: UiDiagnostic): void {
    if (this.diagnostics.length < maxDiagnostics) this.diagnostics.push(diagnostic);
    this.touch();
  }

  private fail(reason: UiRejectReason, message: string, line: number): void {
    this.status = "invalid";
    this.reason = reason;
    this.note({ line, code: reason, message });
  }

  private claimName(name: string, line: number): boolean {
    if (this.names.has(name)) {
      this.fail("duplicate_id", `name ${name} is already defined`, line);
      return false;
    }
    this.names.add(name);
    return true;
  }

  private applyState(op: Record<string, unknown>, line: number): void {
    if (this.states.length >= uiLimits.states) return this.fail("limit_states", "too many states", line);
    const { name, kind, initial } = op;
    if (!isUiName(name)) return this.fail("bad_state", "state name is not an identifier", line);
    const definition: UiStateDefinition = { name, kind: "string", initial: "" };
    if (kind === "number") {
      if (typeof initial !== "number" || !Number.isFinite(initial)) return this.fail("bad_state", "number state needs a finite initial value", line);
      const min = optionalFinite(op.min);
      const max = optionalFinite(op.max);
      const step = optionalFinite(op.step);
      if (min === false || max === false || step === false) return this.fail("bad_state", "min/max/step must be finite numbers", line);
      if (step !== undefined && step <= 0) return this.fail("bad_state", "step must be positive", line);
      if (min !== undefined && max !== undefined && min > max) return this.fail("bad_state", "min is above max", line);
      if ((min !== undefined && initial < min) || (max !== undefined && initial > max)) return this.fail("bad_state", "initial is outside min/max", line);
      Object.assign(definition, { kind, initial });
      if (min !== undefined) definition.min = min;
      if (max !== undefined) definition.max = max;
      if (step !== undefined) definition.step = step;
    } else if (kind === "boolean") {
      if (typeof initial !== "boolean") return this.fail("bad_state", "boolean state needs a boolean initial value", line);
      Object.assign(definition, { kind, initial });
    } else if (kind === "string") {
      if (typeof initial !== "string") return this.fail("bad_state", "string state needs a string initial value", line);
      const maxLength = op.maxLength === undefined ? 200 : op.maxLength;
      if (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 2_000) return this.fail("bad_state", "maxLength is out of range", line);
      if (initial.length > maxLength) return this.fail("bad_state", "initial is longer than maxLength", line);
      Object.assign(definition, { kind, initial, maxLength });
      if (op.options !== undefined) {
        if (!Array.isArray(op.options) || op.options.length === 0 || op.options.length > 50 || op.options.some(item => typeof item !== "string" || item.length > 100)) {
          return this.fail("bad_state", "options must be a short list of strings", line);
        }
        const unique = [...new Set(op.options as string[])];
        if (!unique.includes(initial)) return this.fail("bad_state", "initial is not one of options", line);
        definition.options = unique;
        this.optionCount += unique.length;
        if (this.optionCount > uiLimits.options) return this.fail("limit_options", "too many options", line);
      }
    } else {
      return this.fail("bad_state", "state kind must be number, string or boolean", line);
    }
    if (!this.claimName(name, line)) return;
    this.states.push(definition);
    this.touch();
  }

  private applyDerive(op: Record<string, unknown>, line: number): void {
    if (this.derived.length >= uiLimits.derived) return this.fail("limit_derived", "too many derived values", line);
    if (!isUiName(op.name)) return this.fail("bad_derive", "derived name is not an identifier", line);
    const parsed = parseExpression(op.expr);
    if (!parsed.ok) return this.fail("bad_derive", parsed.reason, line);
    if (!this.claimName(op.name, line)) return;
    this.derived.push({ name: op.name, expression: parsed.expression });
    this.touch();
  }

  private applyNode(op: Record<string, unknown>, line: number): void {
    if (this.nodes.length >= uiLimits.nodes) return this.fail("limit_nodes", "too many nodes", line);
    const { id, type } = op;
    if (!isUiId(id) || typeof type !== "string" || type.length === 0 || type.length > 40) return this.fail("bad_op", "node needs a valid id and type", line);
    if (this.nodeIndex.has(id)) return this.fail("duplicate_id", `node ${id} appears twice`, line);
    const parentId = op.parent === undefined || op.parent === null ? null : op.parent;
    let depth = 1;
    if (parentId === null) {
      if (this.rootNodeId !== null) return this.fail("second_root", "an artifact has one root node", line);
    } else {
      if (typeof parentId !== "string") return this.fail("bad_op", "parent must be a node id", line);
      const parent = this.nodeIndex.get(parentId);
      if (!parent) return this.fail("missing_parent", `parent ${parentId.slice(0, 40)} has not been declared`, line);
      if (!uiContainerTypes.has(parent.type) || parent.invalid) return this.fail("not_container", `parent ${parentId} cannot hold children`, line);
      if (parent.childrenIds.length >= uiLimits.children) return this.fail("limit_nodes", "too many children", line);
      depth = (this.depths.get(parentId) ?? 1) + 1;
      if (depth > uiLimits.depth) return this.fail("limit_depth", "nesting is too deep", line);
    }
    const node: UiNode = { id, type, parentId, props: {}, childrenIds: [] };
    const validated = hasComponent(type) ? validateNodeProps(type, op.props) : null;
    if (!validated) {
      node.invalid = `unsupported component ${type.slice(0, 40)}`;
    } else if (!validated.ok) {
      node.invalid = validated.reason;
    } else {
      node.props = validated.value.props;
      if (validated.value.show !== undefined) node.show = validated.value.show;
      this.optionCount += validated.value.optionCount;
      if (this.optionCount > uiLimits.options) return this.fail("limit_options", "too many options", line);
      this.pending.push({ nodeId: id, refs: validated.value.refs, bindings: validated.value.bindings });
    }
    if (node.invalid) this.note({ line, code: "node_rejected", message: `${id}: ${node.invalid}` });
    this.nodes.push(node);
    this.nodeIndex.set(id, node);
    this.depths.set(id, depth);
    if (parentId === null) this.rootNodeId = id;
    else this.nodeIndex.get(parentId)!.childrenIds.push(id);
    this.touch();
  }

  /** commit：整体校验引用、绑定类型与派生值依赖图，通过后才标记 ready。 */
  private commit(line: number): void {
    if (this.rootNodeId === null) return this.fail("empty_artifact", "no root node", line);
    const stateKinds = new Map(this.states.map(state => [state.name, state.kind] as const));
    const stateNames = new Set(stateKinds.keys());
    const sorted = sortDerived(stateNames, this.derived);
    if (!sorted.ok) return this.fail(sorted.reason, `reference problem at ${sorted.name}`, line);
    const known = new Set([...stateNames, ...this.derived.map(item => item.name)]);
    for (const { nodeId, refs, bindings } of this.pending) {
      for (const ref of refs) {
        if (!known.has(ref)) return this.fail("bad_reference", `${nodeId} refers to unknown ${ref}`, line);
      }
      for (const binding of bindings) {
        if (stateKinds.get(binding.name) !== binding.kind) return this.fail("bad_binding", `${nodeId} cannot bind ${binding.name}`, line);
      }
    }
    for (const node of this.nodes) {
      if (node.show) for (const ref of collectRefs(node.show)) if (!known.has(ref)) return this.fail("bad_reference", `${node.id} show refers to unknown ${ref}`, line);
    }
    this.derivedOrder = sorted.order;
    this.status = "ready";
    this.touch();
  }
}

function optionalFinite(value: unknown): number | undefined | false {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

// ---------- 围栏识别与分段 ----------

export type UiSegment =
  | { type: "markdown"; key: string; text: string }
  | { type: "ui"; key: string; artifact: UiArtifact; /** 围栏内的原始 NDJSON，用于「查看原始文本」。 */ raw: string; closed: boolean };

interface Fence {
  char: "`" | "~";
  length: number;
}

interface MarkdownPart {
  kind: "markdown";
  lines: string[];
  version: number;
}

interface UiPart {
  kind: "ui";
  /** 围栏开始行，被降级为普通代码块时原样放回 Markdown。 */
  openLine: string;
  fence: Fence;
  rawLines: string[];
  rawBytes: number;
  builder: UiArtifactBuilder | null;
  closed: boolean;
  /** 围栏后的 NDJSON 行号。 */
  lineNo: number;
}

type Part = MarkdownPart | UiPart;

const openRe = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const holdBackRe = /^ {0,3}(`{1,2}|~{1,2}|`{3,}[^`]*|~{3,}.*)$/;

function parseOpen(line: string): { fence: Fence; info: string; rest: string } | null {
  const match = openRe.exec(line);
  if (!match) return null;
  const marker = match[1];
  const rest = match[2];
  // 反引号围栏的信息串里不能再有反引号，否则那是行内代码。
  if (marker[0] === "`" && rest.includes("`")) return null;
  const info = rest.trim();
  return { fence: { char: marker[0] as "`" | "~", length: marker.length }, info, rest };
}

function closes(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.length);
}

export interface UiStreamParserOptions {
  now?: () => number;
}

export class UiStreamParser {
  private partial = "";
  private readonly parts: Part[] = [];
  private otherFence: Fence | null = null;
  private finished = false;
  private readonly ids = new Map<string, number>();
  private readonly options: UiStreamParserOptions;
  private readonly viewCache = new WeakMap<Part, { version: string; segment: UiSegment }>();

  constructor(options: UiStreamParserOptions = {}) {
    this.options = options;
  }

  /** 追加一段文本；可以在任意字符边界切开。 */
  feed(chunk: string): void {
    if (this.finished || !chunk) return;
    this.partial += chunk;
    let newline = this.partial.indexOf("\n");
    while (newline !== -1) {
      const line = this.partial.slice(0, newline).replace(/\r$/, "");
      this.partial = this.partial.slice(newline + 1);
      this.processLine(line);
      newline = this.partial.indexOf("\n");
    }
  }

  /** 流结束（正常、中止或断流）。未完成的 UI 块变为 incomplete，伪装成 UI 的未识别块还原成代码块。 */
  finish(): void {
    if (this.finished) return;
    if (this.partial) {
      const line = this.partial.replace(/\r$/, "");
      this.partial = "";
      this.processLine(line);
    }
    this.finished = true;
    const last = this.parts.at(-1);
    if (last?.kind === "ui" && !last.closed) {
      if (last.builder) last.builder.finish();
      else this.demote(last);
    }
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** 释放全部 UI 块（消息被删除或分支截断）。 */
  dispose(): void {
    for (const part of this.parts) if (part.kind === "ui") part.builder?.dispose();
    this.finished = true;
  }

  /** 当前可显示的分段。已完成部分的对象在没有变化时保持同一引用。 */
  segments(): UiSegment[] {
    const output: UiSegment[] = [];
    const tail = this.finished ? "" : this.visiblePartial();
    const lastIndex = this.parts.length - 1;
    this.parts.forEach((part, index) => {
      if (part.kind === "markdown") {
        const suffix = index === lastIndex ? tail : "";
        const version = `${index}|${part.version}|${suffix}`;
        const cached = this.viewCache.get(part);
        let segment = cached?.version === version ? cached.segment : undefined;
        if (!segment) {
          const text = part.lines.map(line => `${line}\n`).join("") + suffix;
          segment = { type: "markdown", key: `md-${index}`, text };
          this.viewCache.set(part, { version, segment });
        }
        if (segment.type === "markdown" && segment.text.trim()) output.push(segment);
        return;
      }
      if (!part.builder) return; // 还没见到 begin：先不显示，既可能是 UI 也可能是代码示例。
      const artifact = part.builder.snapshot();
      const version = `${artifact.revision}|${part.closed}`;
      const cached = this.viewCache.get(part);
      let segment = cached?.version === version ? cached.segment : undefined;
      if (!segment) {
        segment = { type: "ui", key: `ui-${artifact.artifactId}`, artifact, raw: part.rawLines.join("\n"), closed: part.closed };
        this.viewCache.set(part, { version, segment });
      }
      output.push(segment);
    });
    // 正文的半行出现在 UI 块之后（或还没有任何分段）时，它属于一个尚未建立的 Markdown 段。
    if (tail.trim() && this.parts.at(-1)?.kind !== "markdown") {
      output.push({ type: "markdown", key: `md-${this.parts.length}`, text: tail });
    }
    return output;
  }

  /** 末尾半行里可能是围栏的前缀，等它写完再决定，避免闪现 ```vela-u。 */
  private visiblePartial(): string {
    if (!this.partial) return "";
    if (!this.otherFence && this.currentIsMarkdown() && holdBackRe.test(this.partial)) return "";
    return this.currentIsMarkdown() ? this.partial : "";
  }

  private currentIsMarkdown(): boolean {
    const last = this.parts.at(-1);
    return !last || last.kind === "markdown" || last.closed;
  }

  private markdown(): MarkdownPart {
    const last = this.parts.at(-1);
    if (last?.kind === "markdown") return last;
    const part: MarkdownPart = { kind: "markdown", lines: [], version: 0 };
    this.parts.push(part);
    return part;
  }

  private appendMarkdown(line: string): void {
    const part = this.markdown();
    part.lines.push(line);
    part.version += 1;
  }

  private uniqueId(id: string): string {
    const count = this.ids.get(id) ?? 0;
    this.ids.set(id, count + 1);
    return count === 0 ? id : `${id}-${count + 1}`;
  }

  private processLine(line: string): void {
    const last = this.parts.at(-1);
    if (last?.kind === "ui" && !last.closed) return this.processUiLine(last, line);
    if (this.otherFence) {
      this.appendMarkdown(line);
      if (closes(line, this.otherFence)) this.otherFence = null;
      return;
    }
    const open = parseOpen(line);
    if (!open) return this.appendMarkdown(line);
    // 只有信息串恰好是 vela-ui 的顶层围栏才进入 UI 解析；其它围栏（包括 4 反引号包起来展示用的）一律是代码。
    if (open.info === uiFenceInfo) {
      this.parts.push({ kind: "ui", openLine: line, fence: open.fence, rawLines: [], rawBytes: 0, builder: null, closed: false, lineNo: 0 });
      return;
    }
    this.otherFence = open.fence;
    this.appendMarkdown(line);
  }

  private processUiLine(part: UiPart, line: string): void {
    if (closes(line, part.fence)) {
      part.closed = true;
      // 围栏里没有任何内容：不是 UI，按原样还给 Markdown。
      if (!part.builder) this.demote(part, line);
      // 模型关闭围栏却没有 commit：块已经结束，保留已验证的节点并标 incomplete。
      else part.builder.finish();
      return;
    }
    part.rawLines.push(line);
    part.rawBytes += utf8ByteLength(line) + 1;
    if (!line.trim()) return;
    part.lineNo += 1;
    if (!part.builder) return this.begin(part, line);
    if (part.rawBytes > uiLimits.rawBytes) {
      part.builder.reject("limit_bytes", "block is too large", part.lineNo);
      // 超限后不再保存原文，避免继续吃内存。
      part.rawLines.length = 0;
      return;
    }
    part.builder.applyLine(line, part.lineNo);
  }

  /** 围栏里的第一行必须是合法的 begin；否则它只是一个提到 vela-ui 的代码块。 */
  private begin(part: UiPart, line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { value = null; }
    if (!isPlainObject(value) || value.op !== "begin" || !isUiId(value.id) || hasForbiddenStructure(value)) {
      return this.demote(part, line, true);
    }
    const id = this.uniqueId(value.id);
    const title = typeof value.title === "string" && value.title.length <= 200 ? value.title : null;
    const builder = new UiArtifactBuilder(id, title, this.options);
    part.builder = builder;
    if (value.version !== 1) builder.reject("unsupported_version", "unsupported schema version", 1);
  }

  /** 把一个没能成为 UI 的块还原为 Markdown 代码块，保证原文可见。 */
  private demote(part: UiPart, closingOrLine?: string, stillOpen = false): void {
    const index = this.parts.indexOf(part);
    if (index === -1) return;
    const lines = [part.openLine, ...part.rawLines];
    if (!stillOpen && closingOrLine !== undefined) lines.push(closingOrLine);
    const markdown: MarkdownPart = { kind: "markdown", lines, version: 1 };
    this.parts[index] = markdown;
    // 还没读到结束围栏时，后续行仍属于这个代码块。
    this.otherFence = stillOpen || (!part.closed) ? part.fence : null;
    // 合并相邻的 Markdown，保持分段稳定。
    const previous = this.parts[index - 1];
    if (previous?.kind === "markdown") {
      previous.lines.push(...markdown.lines);
      previous.version += 1;
      this.parts.splice(index, 1);
    }
  }
}

/** 一次性解析整条消息（历史恢复、导出）。 */
export function parseUiMessage(text: string, options: UiStreamParserOptions & { final?: boolean } = {}): UiSegment[] {
  const parser = new UiStreamParser(options);
  parser.feed(text);
  if (options.final !== false) parser.finish();
  return parser.segments();
}

/**
 * 快速判断：这条消息是否可能含有（或正在流入）UI 块。
 * 不含 vela-ui 的消息不必走解析；末尾半行像 ```vela-u 时也要走，避免围栏先以代码块闪现。
 */
export function mayContainUi(text: string): boolean {
  if (text.includes(uiFenceInfo)) return true;
  const tail = text.slice(text.lastIndexOf("\n") + 1);
  const match = /^ {0,3}(?:`{3,}|~{3,})\s*(\S*)$/.exec(tail);
  return Boolean(match && match[1].length > 0 && uiFenceInfo.startsWith(match[1]));
}

/** FNV-1a 32 位哈希：给 UI 块内容生成短指纹，用来校验保存的本地状态是否仍属于同一份定义。 */
export function hashUiSource(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

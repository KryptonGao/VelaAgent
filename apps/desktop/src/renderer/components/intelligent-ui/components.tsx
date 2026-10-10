import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  composeUiSubmission,
  formatUiNumber,
  formatUiScalar,
  isUiNodeVisible,
  resolveUiValue,
  safeExternalUrl,
  summarizeUiArtifact,
  validateStateValue,
  type UiAction,
  type UiDataStatus,
  type UiNode,
  type UiScalar,
  type UiSourceNote,
  type UiStateDefinition,
  type UiValue,
} from "@vela/shared";
import { uiCopy } from "./copy";
import { tokenizeInline } from "./inline-text";
import { formatCell, nextSort, visibleRowIndexes, type TableColumn, type TableRow, type TableView } from "./table-model";
import { useUiRuntime } from "./UiRuntime";

type Props = Record<string, unknown>;
interface Option { value: string; label: string; description?: string }

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 渲染文字：Markdown 子集 → React 元素，永远不经过 HTML。 */
export function InlineText({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeInline(text), [text]);
  const { host } = useUiRuntime();
  return <>{tokens.map((token, index) => {
    switch (token.type) {
      case "bold": return <strong key={index}>{token.text}</strong>;
      case "italic": return <em key={index}>{token.text}</em>;
      case "code": return <code key={index}>{token.text}</code>;
      case "link": return <a key={index} href={token.href} target="_blank" rel="noreferrer noopener"
        onClick={event => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (host.openLink(token.href)) event.preventDefault();
        }}>{token.text}</a>;
      default: return <Fragment key={index}>{token.text}</Fragment>;
    }
  })}</>;
}

function stateOf(name: unknown, definitions: readonly UiStateDefinition[]): UiStateDefinition | undefined {
  return definitions.find(definition => definition.name === name);
}

/** 动态文字：字面量直接显示，表达式求值，出错时显示可读的原因。 */
function useResolved(value: unknown) {
  const { env, receiving } = useUiRuntime();
  return resolveUiValue(value, env, receiving);
}

function ResolvedText({ value, digits }: { value: unknown; digits?: number }) {
  const result = useResolved(value);
  if (!result.ok) return <span className="iui-error-text" role="status">{"⚠ "}{uiCopy.evalError(result.error)}</span>;
  return <>{typeof result.value === "number" ? formatUiNumber(result.value, digits) : formatUiScalar(result.value)}</>;
}

// ---------- 数据状态与来源 ----------

function DataMeta({ status, source }: { status?: UiDataStatus; source?: UiSourceNote }) {
  const label = status === "loading" ? uiCopy.statusLoading() : status === "stale" ? uiCopy.statusStale()
    : status === "error" ? uiCopy.statusError() : status === "empty" ? uiCopy.statusEmpty() : null;
  if (!label && !source) return null;
  return <div className="iui-meta">
    {label ? <span className={`iui-badge iui-badge-${status}`}>{label}</span> : null}
    {/* 来源由模型提供，Vela 无法验证：始终标注「未验证」，链接只允许 http(s)。 */}
    {source ? <span className="iui-source">
      {uiCopy.source()}{": "}
      {source.url && safeExternalUrl(source.url) ? <a href={source.url} target="_blank" rel="noreferrer noopener">{source.label}</a> : source.label}
      {" · "}<span className="iui-unverified">{uiCopy.unverified()}</span>
    </span> : null}
  </div>;
}

// ---------- 输入类 ----------

function FieldFrame({ id, label, description, error, children, inline = false }: {
  id: string; label: string; description?: string; error?: string | null; children: ReactNode; inline?: boolean;
}) {
  return <div className={`iui-field${inline ? " iui-field-inline" : ""}`}>
    <label className="iui-label" htmlFor={id}>{label}</label>
    {children}
    {description ? <div className="iui-description" id={`${id}-d`}>{description}</div> : null}
    {error ? <div className="iui-field-error" id={`${id}-e`} role="alert">{"⚠ "}{error}</div> : null}
  </div>;
}

function describedBy(id: string, description: unknown, error: unknown): string | undefined {
  const parts = [description ? `${id}-d` : "", error ? `${id}-e` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function inputErrorFor(definition: UiStateDefinition | undefined, value: UiValue | undefined): string | null {
  if (!definition) return null;
  const code = validateStateValue(definition, value);
  if (!code) return null;
  return uiCopy.inputError(code, code === "below_min" ? definition.min : definition.max);
}

function NumberInput({ props }: { props: Props }) {
  const { artifact, values, setValue } = useUiRuntime();
  const id = useId();
  const name = str(props.bind);
  const definition = stateOf(name, artifact.stateDefinitions);
  const value = values[name];
  const [draft, setDraft] = useState(() => typeof value === "number" ? String(value) : "");
  const [badText, setBadText] = useState(false);
  // 外部改了值（例如按钮 set_state）时同步文本，但不打断正在输入的中间态。
  useEffect(() => {
    const parsed = draft.trim() === "" ? null : Number(draft);
    if (value !== parsed && !(value === null && badText)) setDraft(typeof value === "number" ? String(value) : "");
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const error = badText ? uiCopy.inputError("not_a_number", undefined) : inputErrorFor(definition, value);
  return <FieldFrame id={id} label={str(props.label)} description={str(props.description) || undefined} error={error}>
    <div className="iui-input-wrap">
      <input id={id} className="iui-input iui-number" type="number" inputMode="decimal" value={draft}
        min={definition?.min} max={definition?.max} step={definition?.step ?? "any"}
        disabled={props.disabled === true} required={props.required !== false}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, props.description, error)}
        onChange={event => {
          const text = event.target.value;
          setDraft(text);
          // type=number 对无法解析的输入返回空串：用 validity 区分「清空」和「写了无效字符」。
          const bad = text === "" && event.target.validity.badInput;
          setBadText(bad);
          const parsed = text.trim() === "" ? null : Number(text);
          setValue(name, parsed !== null && Number.isFinite(parsed) ? parsed : null);
        }} />
      {props.unit ? <span className="iui-unit">{str(props.unit)}</span> : null}
    </div>
  </FieldFrame>;
}

function TextInput({ props }: { props: Props }) {
  const { artifact, values, setValue } = useUiRuntime();
  const id = useId();
  const name = str(props.bind);
  const definition = stateOf(name, artifact.stateDefinitions);
  const value = typeof values[name] === "string" ? values[name] as string : "";
  const error = props.required === true && value.trim() === "" ? uiCopy.inputError("required", undefined) : inputErrorFor(definition, value);
  return <FieldFrame id={id} label={str(props.label)} description={str(props.description) || undefined} error={error}>
    <input id={id} className="iui-input" type="text" value={value} maxLength={definition?.maxLength ?? 200}
      placeholder={str(props.placeholder) || undefined} disabled={props.disabled === true} required={props.required === true}
      aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, props.description, error)}
      onChange={event => setValue(name, event.target.value)} />
  </FieldFrame>;
}

function Slider({ props }: { props: Props }) {
  const { artifact, values, setValue } = useUiRuntime();
  const id = useId();
  const name = str(props.bind);
  const definition = stateOf(name, artifact.stateDefinitions);
  const min = definition?.min ?? 0;
  const max = definition?.max ?? Math.max(min + 100, 100);
  const raw = values[name];
  const value = typeof raw === "number" ? Math.min(Math.max(raw, min), max) : min;
  return <FieldFrame id={id} label={str(props.label)} description={str(props.description) || undefined}>
    <div className="iui-slider-row">
      <input id={id} className="iui-slider" type="range" min={min} max={max} step={definition?.step ?? 1} value={value}
        disabled={props.disabled === true} aria-describedby={describedBy(id, props.description, null)}
        aria-valuetext={`${formatUiNumber(value)}${props.unit ? ` ${str(props.unit)}` : ""}`}
        onChange={event => setValue(name, Number(event.target.value))} />
      <output className="iui-slider-value" htmlFor={id}>{formatUiNumber(value)}{props.unit ? ` ${str(props.unit)}` : ""}</output>
    </div>
  </FieldFrame>;
}

function Checkbox({ props }: { props: Props }) {
  const { values, setValue } = useUiRuntime();
  const id = useId();
  const name = str(props.bind);
  return <div className="iui-field iui-check">
    <input id={id} type="checkbox" checked={values[name] === true} disabled={props.disabled === true}
      aria-describedby={describedBy(id, props.description, null)}
      onChange={event => setValue(name, event.target.checked)} />
    <label htmlFor={id}>{str(props.label)}</label>
    {props.description ? <div className="iui-description" id={`${id}-d`}>{str(props.description)}</div> : null}
  </div>;
}

function Select({ props }: { props: Props }) {
  const { values, setValue } = useUiRuntime();
  const id = useId();
  const name = str(props.bind);
  const options = props.options as Option[];
  const current = typeof values[name] === "string" ? values[name] as string : "";
  return <FieldFrame id={id} label={str(props.label)} description={str(props.description) || undefined}>
    <select id={id} className="iui-input iui-select" value={current} aria-describedby={describedBy(id, props.description, null)}
      onChange={event => setValue(name, event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </FieldFrame>;
}

function Radio({ props }: { props: Props }) {
  const { values, setValue } = useUiRuntime();
  const id = useId();
  const name = str(props.bind);
  const options = props.options as Option[];
  const current = values[name];
  return <fieldset className="iui-fieldset" aria-describedby={props.description ? `${id}-d` : undefined}>
    <legend className="iui-label">{str(props.label)}</legend>
    {props.description ? <div className="iui-description" id={`${id}-d`}>{str(props.description)}</div> : null}
    {options.map(option => <label key={option.value} className="iui-radio">
      <input type="radio" name={id} value={option.value} checked={current === option.value} onChange={() => setValue(name, option.value)} />
      <span>{option.label}{option.description ? <span className="iui-description">{option.description}</span> : null}</span>
    </label>)}
  </fieldset>;
}

/** 分段与页签共用：roving tabindex + 方向键。 */
function Segmented({ props, kind, children }: { props: Props; kind: "tabs" | "segmented"; children?: ReactNode }) {
  const { values, setValue } = useUiRuntime();
  const id = useId();
  const name = str(props.bind);
  const options = props.options as Option[];
  const current = typeof values[name] === "string" && options.some(option => option.value === values[name]) ? values[name] as string : options[0]?.value;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (index: number, delta: number) => {
    const next = (index + delta + options.length) % options.length;
    setValue(name, options[next].value);
    refs.current[next]?.focus();
  };
  const isTabs = kind === "tabs";
  return <div className={`iui-${kind}`}>
    {isTabs ? null : <span className="iui-label" id={`${id}-l`}>{str(props.label)}</span>}
    <div className="iui-segment-list" role={isTabs ? "tablist" : "radiogroup"} aria-label={isTabs ? str(props.label) : undefined}
      aria-labelledby={isTabs ? undefined : `${id}-l`}>
      {options.map((option, index) => {
        const selected = option.value === current;
        return <button key={option.value} type="button" ref={element => { refs.current[index] = element; }}
          id={`${id}-t-${index}`} className={`iui-segment${selected ? " is-selected" : ""}`}
          role={isTabs ? "tab" : "radio"} aria-selected={isTabs ? selected : undefined} aria-checked={isTabs ? undefined : selected}
          aria-controls={isTabs ? `${id}-p` : undefined} tabIndex={selected ? 0 : -1} title={option.description}
          onClick={() => setValue(name, option.value)}
          onKeyDown={event => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(index, 1); }
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(index, -1); }
            else if (event.key === "Home") { event.preventDefault(); move(index, -index); }
            else if (event.key === "End") { event.preventDefault(); move(index, options.length - 1 - index); }
          }}>{option.label}</button>;
      })}
    </div>
    {isTabs ? <div className="iui-tabpanel" id={`${id}-p`} role="tabpanel" aria-labelledby={`${id}-t-${Math.max(0, options.findIndex(option => option.value === current))}`}>{children}</div> : null}
  </div>;
}

// ---------- 数据展示 ----------

function Table({ props, id }: { props: Props; id: string }) {
  const { values } = useUiRuntime();
  const columns = props.columns as TableColumn[];
  const rows = props.rows as TableRow[];
  const filterSpec = props.filter as { bind: string; column: string; allValue: string } | undefined;
  const defaultSort = props.defaultSort as { column: string; direction: "asc" | "desc" } | undefined;
  const [sort, setSort] = useState<TableView["sort"]>(defaultSort ?? null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const searchId = useId();
  const filterValue = filterSpec ? (typeof values[filterSpec.bind] === "string" ? values[filterSpec.bind] as string : null) : null;
  const indexes = useMemo(
    () => visibleRowIndexes(rows, columns, { sort, search, filter: filterSpec ? { column: filterSpec.column, value: filterValue, allValue: filterSpec.allValue } : null }),
    [rows, columns, sort, search, filterSpec, filterValue],
  );
  const expandable = rows.some(row => row.detail);
  const caption = str(props.caption);
  const labels = { yes: uiCopy.yes(), no: uiCopy.no() };
  return <div className="iui-table-block">
    {props.searchable === true ? <div className="iui-table-tools">
      <label className="iui-label" htmlFor={searchId}>{uiCopy.search()}</label>
      <input id={searchId} className="iui-input" type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} />
    </div> : null}
    <div className="iui-table-scroll" role="region" aria-label={caption || undefined} tabIndex={0}>
      <table className="iui-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead><tr>
          {expandable ? <th scope="col" className="iui-th-toggle"><span className="iui-sr-only">{uiCopy.expand()}</span></th> : null}
          {columns.map(column => {
            const direction = sort?.column === column.key ? sort.direction : null;
            return <th key={column.key} scope="col" className={`iui-align-${column.align}`}
              aria-sort={direction ? (direction === "asc" ? "ascending" : "descending") : column.sortable ? "none" : undefined}>
              {column.sortable
                ? <button type="button" className="iui-sort" onClick={() => setSort(nextSort(sort, column.key))} title={uiCopy.sortBy(column.label)}>
                    {column.label}<span aria-hidden="true">{direction === "asc" ? " ↑" : direction === "desc" ? " ↓" : " ↕"}</span>
                    {direction ? <span className="iui-sr-only">{direction === "asc" ? uiCopy.sortedAsc() : uiCopy.sortedDesc()}</span> : null}
                  </button>
                : column.label}
            </th>;
          })}
        </tr></thead>
        <tbody>
          {indexes.length === 0 ? <tr><td colSpan={columns.length + (expandable ? 1 : 0)} className="iui-empty-row">{str(props.emptyText) || uiCopy.noRows()}</td></tr> : null}
          {indexes.map(index => {
            const row = rows[index];
            const isOpen = open.has(index);
            const detailId = `${id}-r${index}`;
            return <Fragment key={index}>
              <tr>
                {expandable ? <td className="iui-td-toggle">{row.detail ? <button type="button" className="iui-expand" aria-expanded={isOpen} aria-controls={detailId}
                  aria-label={isOpen ? uiCopy.collapse() : uiCopy.expand()}
                  onClick={() => setOpen(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}>
                  <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span></button> : null}</td> : null}
                {columns.map(column => <td key={column.key} className={`iui-align-${column.align}${typeof row.cells[column.key] === "number" ? " iui-num" : ""}`}>
                  {formatCell(row.cells[column.key], column, labels)}</td>)}
              </tr>
              {row.detail && isOpen ? <tr className="iui-detail-row"><td id={detailId} colSpan={columns.length + 1}><InlineText text={row.detail} /></td></tr> : null}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
    <DataMeta status={props.status as UiDataStatus | undefined} source={props.source as UiSourceNote | undefined} />
  </div>;
}

function Stat({ props }: { props: Props }) {
  const status = props.status as UiDataStatus | undefined;
  const result = useResolved(props.value);
  const empty = result.ok && (result.value === null || result.value === "");
  return <div className="iui-stat">
    <div className="iui-stat-label">{str(props.label)}</div>
    <div className="iui-stat-value" aria-live="polite" aria-atomic="true">
      {status === "loading" ? <span className="iui-muted">{uiCopy.statusLoading()}</span>
        : empty ? <span className="iui-muted">{str(props.emptyText) || "—"}</span>
        : <>{result.ok ? <>{str(props.prefix)}</> : null}<ResolvedText value={props.value} digits={props.digits as number | undefined} />
          {result.ok && props.unit ? <span className="iui-stat-unit">{" "}{str(props.unit)}</span> : null}</>}
    </div>
    {props.description ? <div className="iui-description">{str(props.description)}</div> : null}
    <DataMeta status={status === "loading" ? undefined : status} source={props.source as UiSourceNote | undefined} />
  </div>;
}

function Progress({ props }: { props: Props }) {
  const result = useResolved(props.value);
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
  const value = result.ok && typeof result.value === "number" ? Math.min(Math.max(result.value, 0), max) : null;
  const label = str(props.label);
  const unit = props.unit ? ` ${str(props.unit)}` : "";
  return <div className="iui-progress">
    <div className="iui-progress-head"><span>{label}</span>
      <span>{result.ok && value !== null ? uiCopy.progress(`${formatUiNumber(value)}${unit}`, `${formatUiNumber(max)}${unit}`)
        : <span className="iui-error-text">{"⚠ "}{uiCopy.evalError(result.ok ? "type_mismatch" : result.error)}</span>}</span></div>
    <div className="iui-progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? undefined}>
      <div className="iui-progress-fill" style={{ width: `${value === null ? 0 : (value / max) * 100}%` }} />
    </div>
    <DataMeta status={props.status as UiDataStatus | undefined} source={props.source as UiSourceNote | undefined} />
  </div>;
}

function List({ props }: { props: Props }) {
  const items = props.items as Array<{ text: string; detail: string | null }>;
  const Tag = props.ordered === true ? "ol" : "ul";
  return <div className="iui-list-block">
    {items.length === 0 ? <div className="iui-muted">{str(props.emptyText) || uiCopy.noData()}</div> : <Tag className="iui-list">
      {items.map((item, index) => <li key={index}><InlineText text={item.text} />{item.detail ? <div className="iui-description"><InlineText text={item.detail} /></div> : null}</li>)}
    </Tag>}
    <DataMeta status={props.status as UiDataStatus | undefined} source={props.source as UiSourceNote | undefined} />
  </div>;
}

// ---------- 按钮与受控动作 ----------

type Pending = { kind: "submit"; text: string } | { kind: "link"; url: string };

function Button({ props }: { props: Props }) {
  const runtime = useUiRuntime();
  const { artifact, values, setValue, host } = runtime;
  const action = props.action as UiAction;
  const disabledResult = useResolved(props.disabled);
  const disabled = disabledResult.ok ? disabledResult.value === true : true;
  const [pending, setPending] = useState<Pending | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = (text: string) => {
    setFeedback(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(null), 1800);
  };
  const copyResolved = action.type === "copy" ? resolveUiValue(action.text, runtime.env, runtime.receiving) : null;
  const run = () => {
    switch (action.type) {
      case "set_state": {
        const definition = stateOf(action.name, artifact.stateDefinitions);
        if (definition && validateStateValue(definition, action.value as UiValue) === null) setValue(action.name, action.value as UiValue);
        break;
      }
      case "toggle":
        if (typeof values[action.name] === "boolean") setValue(action.name, !values[action.name]);
        break;
      case "copy": {
        if (!copyResolved?.ok) { flash(uiCopy.copyFailed()); break; }
        const text = formatUiScalar(copyResolved.value);
        void navigator.clipboard.writeText(text).then(() => flash(uiCopy.copied()), () => flash(uiCopy.copyFailed()));
        break;
      }
      // 这两种有外部效果：先显示将要发生什么，由用户再确认一次。
      case "submit_to_agent": setPending({ kind: "submit", text: composeUiSubmission(artifact, action, values) }); break;
      case "open_external": {
        const url = safeExternalUrl(action.url);
        if (url) setPending({ kind: "link", url });
        break;
      }
    }
  };
  const confirmId = useId();
  return <div className="iui-action">
    <button type="button" className={`iui-button iui-button-${str(props.variant) || "secondary"}`} disabled={disabled}
      aria-expanded={pending ? true : undefined} aria-controls={pending ? confirmId : undefined} onClick={run}>
      {feedback ?? str(props.label)}
    </button>
    {pending ? <div className="iui-confirm" id={confirmId} role="group" aria-label={pending.kind === "submit" ? uiCopy.sendToAgent() : uiCopy.open()}>
      {pending.kind === "submit" ? <>
        <div className="iui-confirm-title">{uiCopy.willSend()}</div>
        <pre className="iui-confirm-text">{pending.text}</pre>
        {host.agentBusy ? <div className="iui-description">{uiCopy.queueNote()}</div> : null}
        {!host.canSubmit ? <div className="iui-field-error" role="alert">{"⚠ "}{uiCopy.unavailable()}</div> : null}
        <div className="iui-confirm-actions">
          <button type="button" className="iui-button iui-button-primary" disabled={!host.canSubmit}
            onClick={() => { setPending(null); void host.submit(pending.text); }}>{uiCopy.send()}</button>
          <button type="button" className="iui-button iui-button-secondary" onClick={() => setPending(null)}>{uiCopy.cancel()}</button>
        </div>
      </> : <>
        <div className="iui-confirm-title">{uiCopy.openLink(pending.url)}</div>
        <div className="iui-confirm-actions">
          <a className="iui-button iui-button-primary" href={pending.url} target="_blank" rel="noreferrer noopener"
            onClick={event => { if (host.openLink(pending.url)) event.preventDefault(); setPending(null); }}>{uiCopy.open()}</a>
          <button type="button" className="iui-button iui-button-secondary" onClick={() => setPending(null)}>{uiCopy.cancel()}</button>
        </div>
      </>}
    </div> : null}
  </div>;
}

// ---------- 递归渲染 ----------

function Placeholder({ node }: { node: UiNode }) {
  const known = node.invalid?.startsWith("unsupported component");
  return <div className="iui-placeholder" role="note" title={node.invalid}>
    {"⚠ "}{known ? `${uiCopy.unsupported()}: ${node.type}` : uiCopy.cannotShow()}
  </div>;
}

function Children({ node }: { node: UiNode }) {
  const { byId } = useUiRuntime();
  return <>{node.childrenIds.map(id => {
    const child = byId.get(id);
    return child ? <NodeView key={id} node={child} /> : null;
  })}</>;
}

function Body({ node }: { node: UiNode }) {
  const props = node.props as Props;
  switch (node.type) {
    case "text": return <p className={`iui-text iui-tone-${str(props.tone) || "default"}`}>
      {typeof props.text === "string" ? <InlineText text={props.text} /> : <ResolvedText value={props.text} />}</p>;
    case "heading": {
      const Tag = (["h3", "h4", "h5"] as const)[Math.min(Math.max(Number(props.level) || 2, 1), 3) - 1];
      return <Tag className="iui-heading">{typeof props.text === "string" ? props.text : <ResolvedText value={props.text} />}</Tag>;
    }
    case "caption": return <p className="iui-caption">{typeof props.text === "string" ? <InlineText text={props.text} /> : <ResolvedText value={props.text} />}</p>;
    case "code": return <pre className="iui-code"><code>{str(props.code)}</code></pre>;
    case "column": return <div className={`iui-column iui-gap-${str(props.gap) || "md"}`}><Children node={node} /></div>;
    case "row": return <div className={`iui-row iui-gap-${str(props.gap) || "md"}`}><Children node={node} /></div>;
    case "grid": return <div className={`iui-grid iui-gap-${str(props.gap) || "md"}`} style={{ ["--iui-cols" as string]: Number(props.columns) || 2 }}><Children node={node} /></div>;
    case "divider": return <hr className="iui-divider" />;
    case "card": return <section className={`iui-card iui-tone-${str(props.tone) || "default"}`}>
      {props.title ? <h4 className="iui-card-title">{str(props.title)}</h4> : null}
      {props.description ? <div className="iui-description">{str(props.description)}</div> : null}
      <Children node={node} /></section>;
    case "table": return <Table props={props} id={node.id} />;
    case "stat": return <Stat props={props} />;
    case "progress": return <Progress props={props} />;
    case "list": return <List props={props} />;
    case "tabs": return <Segmented props={props} kind="tabs"><Children node={node} /></Segmented>;
    case "segmented": return <Segmented props={props} kind="segmented" />;
    case "select": return <Select props={props} />;
    case "radio": return <Radio props={props} />;
    case "input": return <TextInput props={props} />;
    case "number_input": return <NumberInput props={props} />;
    case "slider": return <Slider props={props} />;
    case "checkbox": return <Checkbox props={props} />;
    case "button": return <Button props={props} />;
    case "collapsible": return <details className="iui-collapsible" open={props.defaultOpen === true}>
      <summary>{str(props.title)}</summary><div className="iui-collapsible-body"><Children node={node} /></div></details>;
    case "loading": return <div className="iui-skeleton" role="status"><span className="iui-sr-only">{str(props.label) || uiCopy.building()}</span></div>;
    case "empty": return <div className="iui-notice" role="status"><strong>{str(props.title)}</strong>{props.description ? <div className="iui-description">{str(props.description)}</div> : null}</div>;
    case "error": return <div className="iui-notice iui-notice-error" role="alert"><strong>{"⚠ "}{str(props.title)}</strong>{props.description ? <div className="iui-description">{str(props.description)}</div> : null}</div>;
    default: return <Placeholder node={node} />;
  }
}

export function NodeView({ node }: { node: UiNode }) {
  const { env } = useUiRuntime();
  if (node.invalid) return <Placeholder node={node} />;
  if (!isUiNodeVisible(node, env)) return null;
  return <Body node={node} />;
}

/** 复制用的纯文字等价物。 */
export function artifactText(runtime: Pick<ReturnType<typeof useUiRuntime>, "artifact" | "values">): string {
  return summarizeUiArtifact(runtime.artifact, runtime.values);
}

export type { UiScalar };

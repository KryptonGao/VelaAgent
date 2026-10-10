import type { UiScalar } from "@vela/shared";
import { formatUiNumber } from "@vela/shared";

export interface TableColumn {
  key: string;
  label: string;
  align: "left" | "right" | "center";
  sortable: boolean;
  unit?: string;
  prefix?: string;
  digits?: number;
}

export interface TableRow {
  cells: Record<string, UiScalar>;
  detail: string | null;
}

export interface TableView {
  sort: { column: string; direction: "asc" | "desc" } | null;
  search: string;
  /** 绑定状态当前的值；等于 allValue 或为 null 时不筛选。 */
  filter: { column: string; value: string | null; allValue: string } | null;
}

/** 排序、搜索、筛选都在本地完成。返回原始行的下标，展开状态据此保持稳定。 */
export function visibleRowIndexes(rows: readonly TableRow[], columns: readonly TableColumn[], view: TableView): number[] {
  const needle = view.search.trim().toLocaleLowerCase();
  let indexes = rows.map((_, index) => index);
  if (view.filter && view.filter.value !== null && view.filter.value !== view.filter.allValue) {
    const { column, value } = view.filter;
    indexes = indexes.filter(index => String(rows[index].cells[column] ?? "") === value);
  }
  if (needle) {
    indexes = indexes.filter(index => columns.some(column => String(rows[index].cells[column.key] ?? "").toLocaleLowerCase().includes(needle)));
  }
  if (view.sort) {
    const { column, direction } = view.sort;
    const sign = direction === "asc" ? 1 : -1;
    indexes = [...indexes].sort((left, right) => {
      const a = rows[left].cells[column];
      const b = rows[right].cells[column];
      // 空值始终排在最后，不随方向翻转。
      if (a === null || a === undefined) return b === null || b === undefined ? left - right : 1;
      if (b === null || b === undefined) return -1;
      let order: number;
      if (typeof a === "number" && typeof b === "number") order = a - b;
      else if (typeof a === "boolean" && typeof b === "boolean") order = Number(a) - Number(b);
      else order = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return order === 0 ? left - right : order * sign;
    });
  }
  return indexes;
}

export function formatCell(value: UiScalar | undefined, column: TableColumn, labels: { yes: string; no: string }): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? labels.yes : labels.no;
  if (typeof value === "number") return `${column.prefix ?? ""}${formatUiNumber(value, column.digits)}${column.unit ? ` ${column.unit}` : ""}`;
  return `${column.prefix ?? ""}${value}${column.unit ? ` ${column.unit}` : ""}`;
}

/** 点击表头：未排序 → 升序 → 降序 → 取消。 */
export function nextSort(current: TableView["sort"], column: string): TableView["sort"] {
  if (!current || current.column !== column) return { column, direction: "asc" };
  return current.direction === "asc" ? { column, direction: "desc" } : null;
}

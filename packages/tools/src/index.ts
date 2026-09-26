/** Built-in Pi tools enabled for the first session. Execution stays inside Pi. */
export const defaultToolNames = ["read", "bash", "edit", "write"] as const;

export type DefaultToolName = (typeof defaultToolNames)[number];

export interface ToolCatalogEntry {
  name: DefaultToolName;
  description: string;
}

export const defaultToolCatalog: readonly ToolCatalogEntry[] = [
  { name: "read", description: "读取工作目录中的文件" },
  { name: "bash", description: "在工作目录中运行命令" },
  { name: "edit", description: "编辑已有文件" },
  { name: "write", description: "写入文件" },
];

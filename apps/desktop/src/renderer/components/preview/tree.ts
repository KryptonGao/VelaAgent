/** 文件树构建与文件名筛选(纯函数,供 ExplorerPane 使用)。 */

export interface FileTreeNode {
  name: string;
  /** 从根开始的完整相对路径;目录不带尾部斜杠 */
  path: string;
  type: "dir" | "file";
  children: FileTreeNode[] | null;
}

interface MutableNode extends Omit<FileTreeNode, "children"> {
  children: Map<string, MutableNode> | null;
}

/** 由扁平路径列表构建目录树:目录在前、按名称排序。 */
export function buildFileTree(files: string[]): FileTreeNode[] {
  const rootChildren: Map<string, MutableNode> = new Map();
  for (const file of files) {
    const segments = file.split("/").filter(Boolean);
    let children = rootChildren;
    let prefix = "";
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      if (!name) break;
      prefix = prefix ? `${prefix}/${name}` : name;
      const isLeaf = index === segments.length - 1;
      const existing = children.get(name);
      if (isLeaf) {
        // 路径里既出现同名文件又出现同名目录时,保留目录语义。
        if (!existing) {
          children.set(name, { name, path: prefix, type: "file", children: null });
        }
        break;
      }
      if (existing?.children) {
        children = existing.children;
        continue;
      }
      const created: MutableNode = { name, path: prefix, type: "dir", children: new Map() };
      children.set(name, created);
      const nextChildren = created.children;
      if (!nextChildren) break;
      children = nextChildren;
    }
  }
  return materialize(rootChildren);
}

function materialize(children: Map<string, MutableNode>): FileTreeNode[] {
  const nodes = [...children.values()].map((node) => ({
    name: node.name,
    path: node.path,
    type: node.type,
    children: node.children ? materialize(node.children) : null,
  }));
  return sortNodes(nodes);
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 大小写不敏感的子串筛选,命中完整路径即保留。 */
export function filterFilePaths(files: string[], query: string, limit = 200): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: string[] = [];
  for (const file of files) {
    if (file.toLowerCase().includes(needle)) {
      results.push(file);
      if (results.length >= limit) break;
    }
  }
  return results;
}

/** 展开某个文件所需的全部祖先目录路径。 */
export function ancestorsOf(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  const dirs: string[] = [];
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    dirs.push(prefix);
  }
  return dirs;
}

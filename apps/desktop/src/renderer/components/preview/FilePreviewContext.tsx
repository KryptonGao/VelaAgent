import type { WorkspaceFileContent, WorkspaceFileList, WorkspaceSearchResult } from "@vela/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface PreviewTab {
  /** 规范化路径(工作区内为相对路径,工作区外为绝对路径),作为标签唯一标识 */
  id: string;
  name: string;
  dir: string;
  /** 请求跳转的行号(代码搜索/引用跳转),消费后置回 null */
  jumpLine: number | null;
}

/** 宿主工作面板使用的文件标签身份；path 与规范化后的 id 一致。 */
export interface PreviewFileDescriptor {
  id: string;
  path: string;
  name: string;
  dir: string;
}

export interface FilePreviewContextValue {
  open: boolean;
  tabs: PreviewTab[];
  activeTab: PreviewTab | null;
  activeContent: WorkspaceFileContent | null;
  contentLoading: boolean;
  contentError: string | null;
  /** 内容版本号:git 变更后自增,触发重新读取 */
  revision: number;
  fileList: WorkspaceFileList | null;
  fileSet: Set<string> | null;
  openFile(path: string, options?: { line?: number }): void;
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  closePreview(): void;
  consumeJump(): void;
  setTabScroll(id: string, scrollTop: number): void;
  getTabScroll(id: string): number;
  ensureFileList(): void;
  reloadActive(): void;
  searchCode(query: string): Promise<WorkspaceSearchResult>;
  /** 把聊天里的内联文本解析成工作区文件路径;不唯一或不存在时返回 null。 */
  resolveFilePath(text: string): string | null;
}

const FilePreviewContext = createContext<FilePreviewContextValue | null>(null);

export function useFilePreview(): FilePreviewContextValue | null {
  return useContext(FilePreviewContext);
}

/** 识别 / 或盘符开头的绝对路径,与主进程 isAbsolute 的判断保持一致。 */
export function isAbsolutePathLike(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:\//.test(path);
}

/** 两次读取结果一致时沿用旧对象身份,让 React 跳过重渲染,避免无关的 git 事件引起预览闪动。 */
function sameFileContent(current: WorkspaceFileContent | null, next: WorkspaceFileContent): boolean {
  return (
    current !== null &&
    current.path === next.path &&
    current.absolutePath === next.absolutePath &&
    current.kind === next.kind &&
    current.content === next.content &&
    current.size === next.size &&
    current.truncated === next.truncated
  );
}

function splitTabPath(path: string): { id: string; name: string; dir: string } {
  const segments = path.split("/").filter(Boolean);
  const name = segments.pop() ?? path;
  return { id: segments.length > 0 ? `${segments.join("/")}/${name}` : name, name, dir: segments.join("/") };
}

/** 把任意输入路径收成标签 id:工作区内归一为相对路径,工作区外保留绝对路径。 */
export function normalizeTabPath(
  rawPath: string,
  workspaceRoot: string | null,
): { id: string; name: string; dir: string } {
  const normalized = rawPath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!isAbsolutePathLike(normalized)) return splitTabPath(normalized);
  // 工作区内的绝对路径归一为相对路径,与文件树/搜索打开的标签共用一个 id。
  const root = workspaceRoot ? workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "") : null;
  if (root && root !== "/" && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return splitTabPath(normalized.slice(root.length + 1));
  }
  // 工作区外的绝对路径保留原样,交给主进程判定并返回 outside-root。
  const segments = normalized.split("/").filter(Boolean);
  const name = segments.pop() ?? normalized;
  return { id: normalized, name, dir: segments.join("/") };
}

/**
 * 文件预览的多标签状态:标签、内容缓存、工作区文件列表与代码搜索。
 * 打开文件会通知宿主激活对应标签;git 变更时自动重读激活文件。
 */
export function FilePreviewProvider({
  children,
  onOpenFile,
  onCloseFileTab,
  onCloseAllFileTabs,
}: {
  children: ReactNode;
  /** 文件打开或重新激活时通知宿主，并提供规范化路径身份。 */
  onOpenFile?: (file: PreviewFileDescriptor) => void;
  /** 关闭单个文件标签时同步通知宿主。 */
  onCloseFileTab?: (id: string) => void;
  /** 关闭预览或工作区切换清空文件标签时同步通知宿主。 */
  onCloseAllFileTabs?: (ids: string[]) => void;
}) {
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [fileList, setFileList] = useState<WorkspaceFileList | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [activeContent, setActiveContent] = useState<WorkspaceFileContent | null>(null);
  /** activeContent 归属的标签;与 activeTabId 不同时对外不可见,避免切换标签闪出上一个文件。 */
  const [contentTabId, setContentTabId] = useState<string | null>(null);

  const contentCache = useRef(new Map<string, WorkspaceFileContent>());
  const contentTabIdRef = useRef<string | null>(contentTabId);
  contentTabIdRef.current = contentTabId;
  const scrollPositions = useRef(new Map<string, number>());
  const fileListRequested = useRef(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onCloseFileTabRef = useRef(onCloseFileTab);
  onCloseFileTabRef.current = onCloseFileTab;
  const onCloseAllFileTabsRef = useRef(onCloseAllFileTabs);
  onCloseAllFileTabsRef.current = onCloseAllFileTabs;

  const openFile = useCallback(
    (path: string, options?: { line?: number }) => {
      if (!path) return;
      const normalized = normalizeTabPath(path, fileList?.root ?? null);
      setTabs((current) => {
        const existing = current.find((tab) => tab.id === normalized.id);
        if (!existing) {
          return [...current, { ...normalized, jumpLine: options?.line ?? null }];
        }
        if (options?.line != null && existing.jumpLine !== options.line) {
          return current.map((tab) =>
            tab.id === normalized.id ? { ...tab, jumpLine: options.line ?? null } : tab,
          );
        }
        return current;
      });
      setActiveTabId(normalized.id);
      setContentError(null);
      onOpenFileRef.current?.({
        id: normalized.id,
        path: normalized.id,
        name: normalized.name,
        dir: normalized.dir,
      });
    },
    [fileList],
  );

  const closeTab = useCallback((id: string) => {
    if (!tabsRef.current.some((tab) => tab.id === id)) return;
    onCloseFileTabRef.current?.(id);
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.id !== id);
      contentCache.current.delete(id);
      scrollPositions.current.delete(id);
      setActiveTabId((active) => {
        if (active !== id) return active;
        const neighbor = next[Math.min(index, next.length - 1)];
        return neighbor?.id ?? null;
      });
      return next;
    });
  }, []);

  const setActiveTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const closePreview = useCallback(() => {
    const ids = tabsRef.current.map((tab) => tab.id);
    onCloseAllFileTabsRef.current?.(ids);
    setTabs([]);
    setActiveTabId(null);
    contentCache.current.clear();
    scrollPositions.current.clear();
  }, []);

  const consumeJump = useCallback(() => {
    setTabs((current) =>
      current.map((tab) => (tab.jumpLine != null ? { ...tab, jumpLine: null } : tab)),
    );
  }, []);

  const setTabScroll = useCallback((id: string, scrollTop: number) => {
    scrollPositions.current.set(id, scrollTop);
  }, []);

  const getTabScroll = useCallback((id: string) => scrollPositions.current.get(id) ?? 0, []);

  const refreshFileList = useCallback(() => {
    if (!window.vela) return;
    window.vela
      .listWorkspaceFiles()
      .then(setFileList)
      .catch(() => undefined);
  }, []);

  const ensureFileList = useCallback(() => {
    if (fileListRequested.current || !window.vela) return;
    fileListRequested.current = true;
    refreshFileList();
  }, [refreshFileList]);

  const reloadActive = useCallback(() => {
    contentCache.current.clear();
    setRevision((value) => value + 1);
    refreshFileList();
  }, [refreshFileList]);

  const searchCode = useCallback((query: string) => {
    const api = window.vela;
    if (!api) return Promise.reject(new Error("Vela API 不可用"));
    return api.searchWorkspaceCode(query);
  }, []);

  // 激活标签内容:命中缓存时在绘制前同步换上,切换回读过的标签不会闪一帧「读取中」。
  useLayoutEffect(() => {
    if (!activeTabId) {
      setActiveContent(null);
      setContentTabId(null);
      setContentError(null);
      setContentLoading(false);
      return;
    }
    const cached = contentCache.current.get(activeTabId);
    if (!cached) return;
    setActiveContent(cached);
    setContentTabId(activeTabId);
    setContentError(null);
    setContentLoading(false);
  }, [activeTabId, revision]);

  // 缓存未命中时经 IPC 读取。重读(git 变更、手动刷新)期间保留旧内容继续显示,读完原地替换,
  // 避免预览整块换成「读取中」导致滚动位置被浏览器夹回顶部。
  useEffect(() => {
    const api = window.vela;
    if (!api || !activeTabId) return;
    if (contentCache.current.has(activeTabId)) return;
    let active = true;
    setContentLoading(true);
    setContentError(null);
    api
      .readWorkspaceFile(activeTabId)
      .then((content) => {
        if (!active) return;
        contentCache.current.set(activeTabId, content);
        // 内容没变就沿用旧对象,React 直接跳过重渲染,预览不会因为无关的 git 事件闪动。
        setActiveContent((current) => (sameFileContent(current, content) ? current : content));
        setContentTabId(activeTabId);
      })
      .catch((error) => {
        if (!active) return;
        setContentError(error instanceof Error ? error.message : "读取失败");
        // 同一标签重读失败保留旧内容;新标签失败清掉内容归属,让错误信息显示出来。
        setActiveContent((current) => (contentTabIdRef.current === activeTabId ? current : null));
        setContentTabId(activeTabId);
      })
      .finally(() => {
        if (active) setContentLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeTabId, revision]);

  // 事件订阅:git 变更重读打开中的文件;切换工作区时清空预览。
  useEffect(() => {
    const api = window.vela;
    if (!api) return;
    const offGit = api.onGitEvent(() => {
      if (tabsRef.current.length === 0) return;
      contentCache.current.clear();
      setRevision((value) => value + 1);
      refreshFileList();
    });
    const offWorkspace = api.onWorkspaceEvent(() => {
      const ids = tabsRef.current.map((tab) => tab.id);
      onCloseAllFileTabsRef.current?.(ids);
      contentCache.current.clear();
      scrollPositions.current.clear();
      fileListRequested.current = false;
      setFileList(null);
      setTabs([]);
      setActiveTabId(null);
    });
    return () => {
      offGit();
      offWorkspace();
    };
  }, [refreshFileList]);

  const fileSet = useMemo(() => (fileList ? new Set(fileList.files) : null), [fileList]);

  const basenameIndex = useMemo(() => {
    const index = new Map<string, string[]>();
    if (!fileList) return index;
    for (const path of fileList.files) {
      const name = path.split("/").pop() ?? path;
      const bucket = index.get(name);
      if (bucket) bucket.push(path);
      else index.set(name, [path]);
    }
    return index;
  }, [fileList]);

  const resolveFilePath = useCallback(
    (text: string): string | null => {
      if (!fileSet) return null;
      const candidate = text.trim().replaceAll("\\", "/");
      if (!candidate || candidate.includes("\0") || candidate.includes("..") || candidate.length > 300) {
        return null;
      }
      if (fileSet.has(candidate)) return candidate;
      // 目录后缀匹配:src/App.tsx → packages/app/src/App.tsx
      const suffixMatches = fileList!.files.filter((path) => path.endsWith(`/${candidate}`));
      if (suffixMatches.length === 1) return suffixMatches[0];
      if (!candidate.includes("/")) {
        const byName = basenameIndex.get(candidate);
        if (byName?.length === 1) return byName[0];
      }
      return null;
    },
    [fileSet, fileList, basenameIndex],
  );

  // 内容与加载态都按标签归属过滤:切到新标签时不会闪出上一个文件的内容或空状态。
  const visibleContent = activeTabId != null && contentTabId === activeTabId ? activeContent : null;
  const visibleLoading =
    activeTabId != null && visibleContent == null && (contentTabId !== activeTabId || contentLoading);

  const value = useMemo<FilePreviewContextValue>(
    () => ({
      open: tabs.length > 0,
      tabs,
      activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
      activeContent: visibleContent,
      contentLoading: visibleLoading,
      contentError,
      revision,
      fileList,
      fileSet,
      openFile,
      closeTab,
      setActiveTab,
      closePreview,
      consumeJump,
      setTabScroll,
      getTabScroll,
      ensureFileList,
      reloadActive,
      searchCode,
      resolveFilePath,
    }),
    [
      tabs,
      activeTabId,
      visibleContent,
      visibleLoading,
      contentError,
      revision,
      fileList,
      fileSet,
      openFile,
      closeTab,
      setActiveTab,
      closePreview,
      consumeJump,
      setTabScroll,
      getTabScroll,
      ensureFileList,
      reloadActive,
      searchCode,
      resolveFilePath,
    ],
  );

  return <FilePreviewContext.Provider value={value}>{children}</FilePreviewContext.Provider>;
}

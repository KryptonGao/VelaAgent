/**
 * 应用内更新：主进程从 GitHub Release 检查、下载并校验新版本，渲染层只展示状态。
 * 状态由主进程持有，渲染层通过 `getState` 取初值、`subscribe` 接收变化。
 */
export const updateStatuses = [
  "idle",
  "checking",
  "up-to-date",
  /** 发现新版本但不会自动下载（自动更新已关闭，或这份安装无法自动替换）。 */
  "available",
  "downloading",
  /** 已下载并通过签名校验，重启后生效。 */
  "ready",
  "error",
] as const;
export type UpdateStatus = (typeof updateStatuses)[number];

export const updateErrorCodes = [
  "network",
  "rate-limited",
  "no-release",
  /** Release 缺少 SHA256SUMS 或签名文件。 */
  "unsigned",
  /** 签名无法用内置公钥验证。 */
  "signature",
  "hash",
  "extract",
  /** 解压出的应用与 Release 声明的标识或版本不符。 */
  "mismatch",
  "unknown",
] as const;
export type UpdateErrorCode = (typeof updateErrorCodes)[number];

export interface UpdateProgress {
  receivedBytes: number;
  totalBytes: number;
}

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  /** 自动检查并下载更新；关闭后只在手动检查时才联网。 */
  autoUpdate: boolean;
  /** 新版本号（不带 v 前缀）。 */
  version?: string;
  /** Release 说明（Markdown）。 */
  notes?: string;
  publishedAt?: string;
  releaseUrl?: string;
  progress?: UpdateProgress;
  /** 这份安装能否被自动替换；DMG 中运行、目录不可写或开发版为 false，只能到 Release 页下载。 */
  installable: boolean;
  checkedAt?: number;
  error?: { code: UpdateErrorCode; message: string };
}

export interface UpdatesApi {
  getState(): Promise<UpdateState>;
  subscribe(listener: (state: UpdateState) => void): () => void;
  check(): Promise<UpdateState>;
  /** 手动下载（自动更新关闭时）。 */
  download(): Promise<UpdateState>;
  /** 退出并安装，完成后自动重新打开。 */
  restart(): Promise<void>;
  setAutoUpdate(enabled: boolean): Promise<UpdateState>;
  openReleasePage(): Promise<void>;
}

export const UpdatesIpc = {
  getState: "updates:get-state",
  state: "updates:state",
  check: "updates:check",
  download: "updates:download",
  restart: "updates:restart",
  setAutoUpdate: "updates:set-auto-update",
  openReleasePage: "updates:open-release-page",
} as const;

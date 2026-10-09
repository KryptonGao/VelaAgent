import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger, type UpdateErrorCode, type UpdateState } from "@vela/shared";
import type { InstallPlan } from "./update-installer";
import { compareVersions, normalizeVersion, parseChecksums, verifySignature } from "./update-verify";

const log = createLogger("updates");

const maxZipBytes = 1024 * 1024 * 1024;
const maxTextBytes = 256 * 1024;
const defaultCheckDelayMs = 20_000;
const defaultCheckIntervalMs = 4 * 60 * 60 * 1000;
const progressIntervalMs = 200;

export class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpdateError";
  }
}

export interface BundleInfo {
  id: string;
  version: string;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  owner: string;
  repo: string;
  /** 期望的应用标识；解压出的包不符就拒绝安装。 */
  bundleId: string;
  /** 压缩包文件名里的架构，如 arm64。 */
  arch: string;
  publicKeys: readonly string[];
  /** 下载与解压的暂存目录，每次下载前清空。 */
  stagingDir: string;
  /** 保存「自动更新」开关的 JSON 文件。 */
  settingsFile: string;
  logFile: string;
  fetch: typeof fetch;
  /** 返回可被自动替换的 .app 路径；不可替换时返回 null。 */
  installTarget(): Promise<string | null>;
  /** 把 zip 解压到目录（需保留符号链接和权限）。 */
  extract(zip: string, destination: string): Promise<void>;
  readBundleInfo(app: string): Promise<BundleInfo>;
  spawnInstaller(plan: InstallPlan): void;
  quit(): void;
  apiBase?: string;
  checkDelayMs?: number;
  checkIntervalMs?: number;
  now?: () => number;
}

interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
}

interface ReleaseInfo {
  version: string;
  notes: string;
  publishedAt?: string;
  pageUrl: string;
  assets: Map<string, ReleaseAsset>;
}

export class UpdateService {
  private state: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private release: ReleaseInfo | null = null;
  private plan: Omit<InstallPlan, "relaunch"> | null = null;
  private relaunch = false;
  private installerSpawned = false;
  private running: Promise<void> | null = null;
  private abort = new AbortController();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private lastProgressAt = 0;

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = {
      status: "idle",
      currentVersion: options.currentVersion,
      autoUpdate: this.loadAutoUpdate(),
      installable: false,
    };
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 启动后延迟做第一次检查，之后定期检查。关闭自动更新时不会联网。 */
  start(): void {
    const first = setTimeout(() => void this.autoCheck(), this.options.checkDelayMs ?? defaultCheckDelayMs);
    const interval = setInterval(() => void this.autoCheck(), this.options.checkIntervalMs ?? defaultCheckIntervalMs);
    first.unref();
    interval.unref();
    this.timers.push(first, interval);
  }

  dispose(): void {
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
    this.abort.abort();
    this.listeners.clear();
  }

  setAutoUpdate(enabled: boolean): UpdateState {
    this.persistAutoUpdate(enabled);
    this.update({ autoUpdate: enabled });
    // 刚打开且已发现可装的新版本时，立即开始下载。
    this.downloadIfAutomatic();
    return this.getState();
  }

  /** 手动检查：无论自动更新是否开启都会联网；发现新版本后是否自动下载取决于开关。 */
  check(): Promise<UpdateState> {
    return this.exclusive(() => this.runCheck()).then(() => {
      // 检查结果先返回，下载在后台进行，进度通过状态订阅推送。
      this.downloadIfAutomatic();
      return this.getState();
    });
  }

  /** 手动下载已发现的新版本。 */
  download(): Promise<UpdateState> {
    return this.exclusive(() => this.runDownload()).then(() => this.getState());
  }

  /** 「立即重启」：退出应用，由安装脚本换上新版本并重新打开。 */
  restart(): void {
    if (this.state.status !== "ready" || !this.plan) return;
    this.relaunch = true;
    log.info("restarting to install update", { version: this.state.version });
    this.options.quit();
  }

  /** 应用退出时调用：已下载好的更新随这次退出安装，没有就什么都不做。 */
  onWillQuit(): void {
    if (this.installerSpawned || this.state.status !== "ready" || !this.plan) return;
    this.installerSpawned = true;
    try {
      this.options.spawnInstaller({ ...this.plan, relaunch: this.relaunch });
      log.info("installer started", { version: this.state.version, relaunch: this.relaunch });
    } catch (error) {
      log.error("failed to start installer", error);
    }
  }

  private downloadIfAutomatic(): void {
    if (this.state.autoUpdate && this.state.status === "available" && this.state.installable) void this.download();
  }

  private async autoCheck(): Promise<void> {
    if (!this.state.autoUpdate || this.state.status === "ready") return;
    await this.check();
  }

  private exclusive(task: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    const run = task().finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return run;
  }

  private async runCheck(): Promise<void> {
    if (this.state.status === "ready") return;
    this.update({ status: "checking", error: undefined, progress: undefined });
    try {
      const release = await this.fetchLatestRelease();
      const installable = (await this.options.installTarget()) !== null;
      if (compareVersions(release.version, this.options.currentVersion) > 0) {
        this.release = release;
        this.update({
          status: "available",
          version: release.version,
          notes: release.notes,
          publishedAt: release.publishedAt,
          releaseUrl: release.pageUrl,
          installable,
          checkedAt: this.now(),
        });
        log.info("update available", { version: release.version, installable });
      } else {
        this.release = null;
        this.update({
          status: "up-to-date",
          version: undefined, notes: undefined, publishedAt: undefined, releaseUrl: release.pageUrl,
          installable, checkedAt: this.now(),
        });
        log.info("already up to date", { latest: release.version });
      }
    } catch (error) {
      this.fail(error, "update check failed");
    }
  }

  private async runDownload(): Promise<void> {
    const release = this.release;
    if (!release || (this.state.status !== "available" && this.state.status !== "error")) return;
    const target = await this.options.installTarget();
    if (!target) {
      this.update({ status: "available", installable: false, error: undefined });
      return;
    }
    this.update({ status: "downloading", installable: true, error: undefined, progress: { receivedBytes: 0, totalBytes: 0 } });
    try {
      this.plan = await this.fetchAndStage(release, target);
      this.update({ status: "ready", progress: undefined, error: undefined });
      log.info("update ready", { version: release.version });
    } catch (error) {
      this.plan = null;
      await rm(this.options.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      this.fail(error, "update download failed", release);
    }
  }

  private async fetchAndStage(release: ReleaseInfo, target: string): Promise<Omit<InstallPlan, "relaunch">> {
    const { version } = release;
    const zipName = `Vela-${version}-${this.options.arch}.zip`;
    const zip = release.assets.get(zipName);
    const sums = release.assets.get("SHA256SUMS.txt");
    const signature = release.assets.get("SHA256SUMS.txt.sig");
    if (!zip || !sums || !signature) {
      throw new UpdateError("unsigned", `Release v${version} is missing ${[!zip && zipName, !sums && "SHA256SUMS.txt", !signature && "SHA256SUMS.txt.sig"].filter(Boolean).join(", ")}`);
    }

    // 先验签再下载大文件：校验和未经签名就不可信。
    const sumsBytes = await this.fetchSmall(sums.url);
    const signatureText = (await this.fetchSmall(signature.url)).toString("utf8");
    if (!verifySignature(sumsBytes, signatureText, this.options.publicKeys)) {
      throw new UpdateError("signature", "SHA256SUMS.txt signature does not match any trusted public key");
    }
    const expectedHash = parseChecksums(sumsBytes.toString("utf8")).get(zipName);
    if (!expectedHash) throw new UpdateError("signature", `${zipName} is not listed in the signed SHA256SUMS.txt`);

    await rm(this.options.stagingDir, { recursive: true, force: true });
    await mkdir(this.options.stagingDir, { recursive: true });
    const zipPath = join(this.options.stagingDir, zipName);
    const partial = `${zipPath}.part`;
    const actualHash = await this.downloadFile(zip, partial);
    if (actualHash !== expectedHash) throw new UpdateError("hash", `${zipName} does not match the signed checksum`);
    await rename(partial, zipPath);

    const extracted = join(this.options.stagingDir, "extracted");
    await mkdir(extracted, { recursive: true });
    try {
      await this.options.extract(zipPath, extracted);
    } catch (error) {
      throw new UpdateError("extract", "Could not unpack the update", { cause: error });
    }
    const apps = (await readdir(extracted)).filter(name => name.endsWith(".app"));
    if (apps.length !== 1) throw new UpdateError("extract", `Expected exactly one .app in the update, found ${apps.length}`);
    const stagedApp = join(extracted, apps[0]);
    const info = await this.options.readBundleInfo(stagedApp).catch((error: unknown) => {
      throw new UpdateError("extract", "Could not read the update's Info.plist", { cause: error });
    });
    if (info.id !== this.options.bundleId || normalizeVersion(info.version) !== version) {
      throw new UpdateError("mismatch", `Update bundle is ${info.id} ${info.version}, expected ${this.options.bundleId} ${version}`);
    }
    // 压缩包已无用，装完前只保留解压后的应用。
    await rm(zipPath, { force: true });
    return { stagedApp, target, workDir: this.options.stagingDir, logFile: this.options.logFile };
  }

  private async fetchLatestRelease(): Promise<ReleaseInfo> {
    const { owner, repo } = this.options;
    const url = `${this.options.apiBase ?? "https://api.github.com"}/repos/${owner}/${repo}/releases/latest`;
    const response = await this.request(url, { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
    if (response.status === 404) throw new UpdateError("no-release", "The repository has no published release");
    if (response.status === 403 || response.status === 429) {
      throw new UpdateError("rate-limited", `GitHub rejected the request (HTTP ${response.status})`);
    }
    if (!response.ok) throw new UpdateError("network", `GitHub returned HTTP ${response.status}`);
    const json: unknown = await response.json().catch(() => null);
    return this.parseRelease(json);
  }

  private parseRelease(json: unknown): ReleaseInfo {
    const data = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const version = typeof data.tag_name === "string" ? normalizeVersion(data.tag_name) : null;
    if (!version) throw new UpdateError("no-release", "The latest release tag is not a version number");
    const downloadPrefix = `https://github.com/${this.options.owner}/${this.options.repo}/releases/download/`;
    const assets = new Map<string, ReleaseAsset>();
    for (const raw of Array.isArray(data.assets) ? data.assets : []) {
      const asset = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const { name, size, browser_download_url: url } = asset;
      if (typeof name !== "string" || typeof url !== "string" || !url.startsWith(downloadPrefix)) continue;
      assets.set(name, { name, size: typeof size === "number" ? size : 0, url });
    }
    const pageUrl = typeof data.html_url === "string" && data.html_url.startsWith("https://github.com/")
      ? data.html_url
      : `https://github.com/${this.options.owner}/${this.options.repo}/releases/latest`;
    return {
      version,
      notes: typeof data.body === "string" ? data.body : "",
      publishedAt: typeof data.published_at === "string" ? data.published_at : undefined,
      pageUrl,
      assets,
    };
  }

  private async request(url: string, headers: Record<string, string> = {}): Promise<Response> {
    try {
      return await this.options.fetch(url, {
        headers: { "User-Agent": `Vela/${this.options.currentVersion}`, ...headers },
        signal: this.abort.signal,
      });
    } catch (error) {
      throw new UpdateError("network", error instanceof Error ? error.message : "Network request failed", { cause: error });
    }
  }

  private async fetchSmall(url: string): Promise<Buffer> {
    const response = await this.request(url);
    if (!response.ok) throw new UpdateError("network", `Download failed (HTTP ${response.status}): ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxTextBytes) throw new UpdateError("network", "Unexpectedly large checksum file");
    return bytes;
  }

  /** 流式写盘并同时计算 SHA-256，返回小写十六进制摘要。 */
  private async downloadFile(asset: ReleaseAsset, destination: string): Promise<string> {
    const response = await this.request(asset.url);
    if (!response.ok || !response.body) throw new UpdateError("network", `Download failed (HTTP ${response.status})`);
    const totalBytes = Number(response.headers.get("content-length")) || asset.size;
    const hash = createHash("sha256");
    let receivedBytes = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxZipBytes) return callback(new UpdateError("network", "The update is larger than the allowed size"));
        hash.update(chunk);
        this.reportProgress(receivedBytes, totalBytes);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(destination), { signal: this.abort.signal });
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      throw new UpdateError("network", error instanceof Error ? error.message : "Download interrupted", { cause: error });
    }
    this.update({ progress: { receivedBytes, totalBytes: totalBytes || receivedBytes } });
    return hash.digest("hex");
  }

  private reportProgress(receivedBytes: number, totalBytes: number): void {
    const now = this.now();
    if (now - this.lastProgressAt < progressIntervalMs) return;
    this.lastProgressAt = now;
    this.update({ progress: { receivedBytes, totalBytes } });
  }

  private fail(error: unknown, message: string, release?: ReleaseInfo): void {
    const known = error instanceof UpdateError ? error : new UpdateError("unknown", error instanceof Error ? error.message : String(error), { cause: error });
    log.warn(message, { code: known.code, error: known.message });
    this.update({
      status: "error",
      progress: undefined,
      checkedAt: this.now(),
      error: { code: known.code, message: known.message },
      ...(release ? { version: release.version, notes: release.notes, publishedAt: release.publishedAt, releaseUrl: release.pageUrl } : {}),
    });
  }

  private update(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (error) { log.error("update listener failed", error); }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private loadAutoUpdate(): boolean {
    try {
      const parsed = JSON.parse(readFileSync(this.options.settingsFile, "utf8")) as { autoUpdate?: unknown };
      return typeof parsed.autoUpdate === "boolean" ? parsed.autoUpdate : true;
    } catch {
      return true;
    }
  }

  private persistAutoUpdate(enabled: boolean): void {
    writeFile(this.options.settingsFile, `${JSON.stringify({ autoUpdate: enabled }, null, 2)}\n`, "utf8")
      .catch(error => log.warn("could not save the auto-update setting", { error: String(error) }));
  }
}

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * P2 IPC 装配检查:每个 IpcChannel 都必须同时有主进程处理入口和 preload 绑定。
 * 这类漏接线在类型检查里发现不了(通道名是字符串),所以单独用源码级检查兜住。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sharedPath = join(repoRoot, "packages/shared/src/index.ts");
const mainDir = join(repoRoot, "apps/desktop/src/main");
const preloadPath = join(repoRoot, "apps/desktop/src/preload/index.ts");

async function readSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readSources(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(await readFile(full, "utf8"));
    }
  }
  return files;
}

function parseChannels(source: string): Map<string, string> {
  const block = /export const IpcChannel = \{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
  const channels = new Map<string, string>();
  for (const match of block.matchAll(/(\w+):\s*"([^"]+)"/g)) {
    // 只取 `domain:action` 形式的真实 IPC 通道。
    if (match[2]!.includes(":")) channels.set(match[1]!, match[2]!);
  }
  return channels;
}

function referencedChannels(source: string): Set<string> {
  return new Set([...source.matchAll(/IpcChannel\.(\w+)/g)].map((match) => match[1]!));
}

describe("P2 IPC 装配", () => {
  it("每个 IpcChannel 都有主进程入口与 preload 绑定", async () => {
    const channels = parseChannels(await readFile(sharedPath, "utf8"));
    assert.ok(channels.size > 100, `IpcChannel 数量异常: ${channels.size}`);
    const mainRefs = new Set<string>();
    for (const source of await readSources(mainDir)) {
      for (const name of referencedChannels(source)) mainRefs.add(name);
    }
    const preloadRefs = referencedChannels(await readFile(preloadPath, "utf8"));

    const missingMain = [...channels.keys()].filter((name) => !mainRefs.has(name));
    const missingPreload = [...channels.keys()].filter((name) => !preloadRefs.has(name));
    assert.deepEqual(missingMain, [], `主进程缺少处理入口: ${missingMain.join(", ")}`);
    assert.deepEqual(missingPreload, [], `preload 缺少绑定: ${missingPreload.join(", ")}`);
  });

  it("P2 通道分别接到对应的服务方法与 VelaApi 绑定", async () => {
    const mainSource = (await readSources(mainDir)).join("\n");
    const preloadSource = await readFile(preloadPath, "utf8");
    const expectations: Array<{ channel: string; main: RegExp; preload: RegExp }> = [
      { channel: "gitCreateBranchAt", main: /createBranchAt/, preload: /createBranchAt:/ },
      { channel: "gitHistoryOpPreview", main: /previewHistoryOp/, preload: /previewHistoryOp:/ },
      { channel: "gitHistoryOp", main: /runHistoryOp/, preload: /runHistoryOp:/ },
      { channel: "gitRewritePreview", main: /previewRewrite/, preload: /previewRewrite:/ },
      { channel: "gitRewrite", main: /runRewrite/, preload: /runRewrite:/ },
      { channel: "gitReflog", main: /reflog\(/, preload: /getReflog:/ },
      { channel: "gitRecoveryPreview", main: /previewRecovery/, preload: /previewRecovery:/ },
      { channel: "gitRecovery", main: /runRecovery/, preload: /runRecovery:/ },
      { channel: "gitPullWithStrategy", main: /pullWithStrategy/, preload: /pullWithStrategy:/ },
      { channel: "gitForcePush", main: /forcePush/, preload: /forcePushBranch:/ },
      { channel: "gitTagList", main: /\.tags\(\)/, preload: /listTags:/ },
      { channel: "gitTagCreate", main: /tagCreate/, preload: /createTag:/ },
      { channel: "gitTagDelete", main: /tagDelete/, preload: /deleteTag:/ },
      { channel: "gitReleaseList", main: /\.releases\(\)/, preload: /listReleases:/ },
      { channel: "gitReleaseCreate", main: /releaseCreate/, preload: /createRelease:/ },
      { channel: "gitReleaseScope", main: /releaseNotesScope/, preload: /getReleaseNotesScope:/ },
      { channel: "prReviewThreads", main: /getReviewThreads/, preload: /getPullRequestReviewThreads:/ },
      { channel: "prComment", main: /\.comment\(/, preload: /commentPullRequest:/ },
      { channel: "prReview", main: /\.review\(/, preload: /reviewPullRequest:/ },
      { channel: "prResolveThread", main: /resolveThread/, preload: /resolvePullRequestThread:/ },
      { channel: "prMergePreview", main: /getMergePreview/, preload: /getPullRequestMergePreview:/ },
      { channel: "prMerge", main: /\.merge\(/, preload: /mergePullRequest:/ },
      { channel: "prClose", main: /\.close\(/, preload: /closePullRequest:/ },
    ];
    for (const item of expectations) {
      assert.match(mainSource, item.main, `${item.channel} 的主进程处理未接入服务方法`);
      assert.match(preloadSource, item.preload, `${item.channel} 的 preload 绑定缺失`);
      assert.match(preloadSource, new RegExp(`IpcChannel\\.${item.channel}\\b`), `${item.channel} 未被 preload 使用`);
      assert.match(mainSource, new RegExp(`IpcChannel\\.${item.channel}\\b`), `${item.channel} 未被主进程注册`);
    }
  });

  it("P2 写操作在 preload 与 VelaApi 上保持同名", async () => {
    const api = await readFile(sharedPath, "utf8");
    const block = /export interface VelaApi \{([\s\S]*?)\n\}/.exec(api)?.[1] ?? "";
    for (const name of [
      "createBranchAt",
      "previewHistoryOp",
      "runHistoryOp",
      "previewRewrite",
      "runRewrite",
      "getReflog",
      "previewRecovery",
      "runRecovery",
      "pullWithStrategy",
      "previewForcePush",
      "forcePushBranch",
      "listTags",
      "createTag",
      "deleteTag",
      "listReleases",
      "createRelease",
      "getReleaseNotesScope",
      "getPullRequestReviewThreads",
      "commentPullRequest",
      "reviewPullRequest",
      "resolvePullRequestThread",
      "getPullRequestMergePreview",
      "mergePullRequest",
      "closePullRequest",
    ]) {
      assert.match(block, new RegExp(`\\b${name}\\(`), `VelaApi 缺少 ${name}`);
    }
  });
});

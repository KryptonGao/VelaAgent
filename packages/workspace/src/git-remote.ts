import type { GitRemote, GitRemoteChange, GitRemoteInput } from "@vela/shared";
import { assertRemoteUrl, assertSafeName, gitMutate, gitQuery } from "./git-run";
import { githubSlug } from "./github-url";

/**
 * 远程配置的读写与增删改。所有写操作只改当前仓库的 remote 配置,
 * 不触碰其他 Git 配置;删除时会说明它会一并移除对应的远程跟踪引用。
 */
export async function readRemotes(cwd: string): Promise<GitRemote[]> {
  let stdout: string;
  try {
    stdout = await gitQuery(cwd, ["remote", "-v"]);
  } catch {
    return [];
  }
  const byName = new Map<string, GitRemote>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line);
    if (!match) continue;
    const [, name, url, kind] = match;
    const remote = byName.get(name) ?? { name, fetchUrl: "", pushUrl: "", slug: null };
    if (kind === "fetch") remote.fetchUrl = url;
    else remote.pushUrl = url;
    byName.set(name, remote);
  }
  return [...byName.values()].map((remote) => ({
    ...remote,
    slug: githubSlug(remote.fetchUrl || remote.pushUrl),
  }));
}

/** 当前分支名 → 远程名 的跟踪关系,用于判断各远程在 fork 场景中的角色。 */
export async function readBranchUpstreamRemote(cwd: string, branch: string | null): Promise<string | null> {
  if (!branch) return null;
  try {
    const stdout = await gitQuery(cwd, [
      "for-each-ref",
      "--format=%(upstream:short)",
      `refs/heads/${branch}`,
    ]);
    const upstream = stdout.trim();
    if (!upstream) return null;
    const remotes = await readRemoteNames(cwd);
    return matchRemotePrefix(upstream, remotes);
  } catch {
    return null;
  }
}

export async function readRemoteNames(cwd: string): Promise<string[]> {
  try {
    const stdout = await gitQuery(cwd, ["remote"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 远程名可能自身含斜杠,取最长匹配前缀。 */
export function matchRemotePrefix(value: string, remotes: string[]): string | null {
  const matched = remotes.filter((name) => value === name || value.startsWith(`${name}/`));
  if (matched.length === 0) return null;
  return matched.sort((a, b) => b.length - a.length)[0] ?? null;
}

export async function remoteAdd(cwd: string, input: GitRemoteInput): Promise<void> {
  const name = assertSafeName(input.name.trim(), "远程名");
  const url = assertRemoteUrl(input.url);
  if (await remoteExists(cwd, name)) throw new Error(`远程 ${name} 已存在`);
  await gitMutate(cwd, ["remote", "add", name, url]);
  if (input.pushUrl?.trim()) {
    await gitMutate(cwd, ["remote", "set-url", "--push", name, assertRemoteUrl(input.pushUrl)]);
  }
}

export async function remoteSetUrl(
  cwd: string,
  name: string,
  url: string,
  pushUrl?: string | null,
): Promise<void> {
  const remote = assertSafeName(name.trim(), "远程名");
  if (!(await remoteExists(cwd, remote))) throw new Error(`远程 ${remote} 不存在`);
  await gitMutate(cwd, ["remote", "set-url", remote, assertRemoteUrl(url)]);
  // 修改 fetch URL 后,已有 push URL 会继续沿用旧值;显式传入时一并更新。
  if (pushUrl !== undefined && pushUrl !== null && pushUrl.trim()) {
    await gitMutate(cwd, ["remote", "set-url", "--push", remote, assertRemoteUrl(pushUrl)]);
  }
}

export async function remoteRemove(cwd: string, name: string): Promise<void> {
  const remote = assertSafeName(name.trim(), "远程名");
  if (!(await remoteExists(cwd, remote))) throw new Error(`远程 ${remote} 不存在`);
  await gitMutate(cwd, ["remote", "remove", remote]);
}

export async function remoteRename(cwd: string, name: string, nextName: string): Promise<void> {
  const remote = assertSafeName(name.trim(), "远程名");
  const next = assertSafeName(nextName.trim(), "远程名");
  if (remote === next) throw new Error("新远程名与原名相同");
  if (!(await remoteExists(cwd, remote))) throw new Error(`远程 ${remote} 不存在`);
  if (await remoteExists(cwd, next)) throw new Error(`远程 ${next} 已存在`);
  await gitMutate(cwd, ["remote", "rename", remote, next]);
}

export async function remoteExists(cwd: string, name: string): Promise<boolean> {
  const names = await readRemoteNames(cwd);
  return names.includes(name);
}

/** 执行写操作后统一返回最新远程列表,便于界面立刻刷新。 */
export async function remoteChange(cwd: string, message: string): Promise<GitRemoteChange> {
  return { ok: true, message, remotes: await readRemotes(cwd) };
}

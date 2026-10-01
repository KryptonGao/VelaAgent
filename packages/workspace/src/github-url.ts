/** GitHub 远程地址解析;gh 与 PR 相关逻辑共用,避免各处重复正则。 */

/** git@github.com:owner/repo.git、https://github.com/owner/repo.git、ssh://git@github.com/owner/repo → owner/repo */
export function parseGithubSlug(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  const ssh = /^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) return ssh[1];
  const https = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (https) return https[1];
  const sshUrl = /^ssh:\/\/git@[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshUrl) return sshUrl[1];
  return null;
}

/** 仅接受 github.com 远程;Enterprise 主机不在当前支持范围。 */
export function githubSlug(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  const isGithub =
    /^git@github\.com:/i.test(trimmed) ||
    /^https?:\/\/(?:www\.)?github\.com\//i.test(trimmed) ||
    /^ssh:\/\/git@github\.com\//i.test(trimmed);
  return isGithub ? parseGithubSlug(trimmed) : null;
}

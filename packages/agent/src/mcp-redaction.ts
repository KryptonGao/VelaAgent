/** Scrub credential-bearing parameters and diagnostics before IPC, approvals and Trace display. */
const sensitive = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)/i;
export function redactMcpDisplay(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("••••••••");
    return text.replace(/("(?:authorization|cookie|password|passwd|secret|(?:access_|refresh_)?token|api[_-]?key|clientSecret)"\s*:\s*")[^"\\]*(?:\\.[^"\\]*)*"/gi, '$1••••••••"')
      .replace(/(Bearer\s+)[^\s"']+/gi, "$1••••••••")
      .replace(/([?&](?:code|token|access_token|refresh_token|api_key|secret|password)=)[^&\s"']*/gi, "$1••••••••")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1••••••••@");
  }
  if (Array.isArray(value)) return value.map(item => redactMcpDisplay(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) && typeof item === "string" ? "••••••••" : redactMcpDisplay(item, secrets)]));
  return value;
}
export function mcpConfiguredSecrets(configs: readonly unknown[]): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, secret = false): void => {
    if (typeof value === "string" && secret && !value.startsWith("!")) {
      const resolved = value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string, plain: string) => match === "$$" ? "$" : match === "$!" ? "!" : process.env[braced ?? plain] ?? "");
      if (resolved) values.add(resolved);
      if (/^Bearer /i.test(resolved)) values.add(resolved.slice(7));
    } else if (Array.isArray(value)) value.forEach(item => visit(item, secret));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) visit(item, secret || key === "env" || key === "headers" || sensitive.test(key));
  };
  configs.forEach(value => visit(value));
  return [...values];
}

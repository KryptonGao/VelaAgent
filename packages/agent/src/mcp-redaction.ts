import { redactSensitive } from "@vela/shared";

/** Scrub credential-bearing parameters and diagnostics before IPC, approvals and Trace display. */
export const redactMcpDisplay = redactSensitive;
const sensitive = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)/i;
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

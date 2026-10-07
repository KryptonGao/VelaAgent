/** Scrub credential-bearing values before IPC, Trace display, log files and diagnostic exports. */
export const REDACTED = "••••••••";
const sensitive = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)/i;
export function redactSensitive(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join(REDACTED);
    return text.replace(/("(?:authorization|cookie|password|passwd|secret|(?:access_|refresh_)?token|api[_-]?key|clientSecret)"\s*:\s*")[^"\\]*(?:\\.[^"\\]*)*"/gi, `$1${REDACTED}"`)
      .replace(/(Bearer\s+)[^\s"']+/gi, `$1${REDACTED}`)
      .replace(/([?&](?:code|token|access_token|refresh_token|api_key|secret|password)=)[^&\s"']*/gi, `$1${REDACTED}`)
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  }
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) && typeof item === "string" ? REDACTED : redactSensitive(item, secrets)]));
  return value;
}

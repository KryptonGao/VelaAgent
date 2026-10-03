export interface McpSearchResult {
  title: string;
  url?: string;
  id?: string;
  type?: string;
  highlight?: string;
  timestamp?: string;
}

export type McpResultView =
  | { kind: "search"; results: McpSearchResult[] }
  | { kind: "json"; value: unknown }
  | { kind: "text"; text: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only promote a complete, recognizable search response; keep everything else readable. */
export function presentMcpResult(body: string): McpResultView {
  const source = body.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  let value: unknown;
  try { value = JSON.parse(source); } catch { return { kind: "text", text: body }; }
  const results = record(value) ? value.results : Array.isArray(value) ? value : undefined;
  if (Array.isArray(results) && results.every(item => record(item) && typeof item.title === "string" && item.title.trim())) {
    return { kind: "search", results: results.map(item => ({
      title: item.title as string,
      ...Object.fromEntries(["url", "id", "type", "highlight", "timestamp"]
        .filter(key => typeof item[key] === "string").map(key => [key, item[key]])),
    })) };
  }
  return { kind: "json", value };
}

export function formatMcpResponse(body: string): string {
  const source = body.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  try { return JSON.stringify(JSON.parse(source), null, 2); } catch { return body; }
}

export function mcpResultUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch { return null; }
}

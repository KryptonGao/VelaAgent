/** User browsing has its own cookies/storage and never shares the app or Agent session. */
export const UI_BROWSER_PARTITION = "persist:vela-ui-browser";
export const UI_BROWSER_BLANK_URL = "about:blank";

export function isUiBrowserUrl(value: string): boolean {
  if (value === UI_BROWSER_BLANK_URL) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Bare hosts default to HTTPS; local development servers default to HTTP. */
export function normalizeBrowserAddress(value: string): string | null {
  const address = value.trim();
  if (!address || /\s/.test(address)) return null;
  if (address === UI_BROWSER_BLANK_URL) return address;
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/]|$)/i.test(address);
  const hostWithPort = /^(?:[^/:]+|\[[\da-f:]+\]):\d+(?:[/?#]|$)/i.test(address);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address) && !hostWithPort;
  try {
    const url = new URL(hasScheme ? address : `${local ? "http" : "https"}://${address}`);
    return isUiBrowserUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

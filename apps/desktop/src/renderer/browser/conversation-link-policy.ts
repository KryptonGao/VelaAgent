export type ConversationLinkTarget = "embedded" | "external";

export function isConversationLinkTarget(value: unknown): value is ConversationLinkTarget {
  return value === "embedded" || value === "external";
}

/** Only explicit user activation of HTTP(S) links can open a manual UI tab. */
export function routeConversationLink(
  href: string,
  target: ConversationLinkTarget,
  openEmbedded: (url: string) => void,
): boolean {
  if (target !== "embedded") return false;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    openEmbedded(url.href);
    return true;
  } catch {
    return false;
  }
}

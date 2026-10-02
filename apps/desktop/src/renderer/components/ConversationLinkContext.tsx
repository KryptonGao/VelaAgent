import { createContext } from "react";

/** Scoped to conversation content. Returning false preserves native link handling. */
export const ConversationLinkContext = createContext<((url: string) => boolean) | null>(null);

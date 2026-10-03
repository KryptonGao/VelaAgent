/** CSS viewport coordinates reported by the trusted browser input adapter. */
export interface BrowserAgentAction {
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  kind: 'click' | 'type' | 'press' | 'select' | 'scroll';
}
export interface BrowserAgentCursor extends BrowserAgentAction {
  sequence: number;
  /** False while idle; the pointer stays mounted at its last position. */
  active?: boolean;
}
/** Trusted host state projected into the local application renderer. */
export interface BrowserTabState {
  id: string;
  conversationId: string | null;
  url: string;
  title: string;
  loading: boolean;
  ready: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { code: string; detail?: string } | null;
  width: number;
  height: number;
  agentCursor?: BrowserAgentCursor | null;
}
export interface BrowserWindowState {
  tabs: BrowserTabState[];
  selected: Record<string, string>;
  activeConversationId: string | null;
  operating: string[];
  /** Incremented only for a foreground Agent open/select request. */
  focusRequest: { tabId: string; nonce: number } | null;
}
export type BrowserUiCommand =
  | { type: 'state' }
  | { type: 'activate'; conversationId: string | null }
  | { type: 'open'; id?: string; url?: string }
  | { type: 'bind'; tabId: string; guestId: number }
  | { type: 'select' | 'close' | 'back' | 'forward' | 'reload' | 'stop'; tabId: string }
  | { type: 'goto'; tabId: string; url: string }
  | { type: 'viewport'; tabId: string; width: number; height: number };
export interface BrowserPanelApi {
  command(command: BrowserUiCommand): Promise<BrowserWindowState>;
  subscribe(listener: (state: BrowserWindowState) => void): () => void;
}
export const BrowserIpc = { command: 'browser:command', state: 'browser:state' } as const;

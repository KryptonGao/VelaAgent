/** Future Agent browsers are provider-owned sessions. Never adapt the manual UI webview. */
export type BrowserUseCapability = "snapshot" | "screenshot" | "actions";

export interface BrowserUseSessionOptions {
  /** Logical ownership for cleanup and concurrency isolation. */
  ownerId: string;
  /** Provider-specific profile; must not refer to the manual UI browser partition. */
  profileId?: string;
  initialUrl?: string;
  signal?: AbortSignal;
}

export interface BrowserUseTarget {
  /** A reference from a provider's latest snapshot, or a provider-supported selector. */
  ref?: string;
  selector?: string;
}

export type BrowserUseAction =
  | { type: "click"; target: BrowserUseTarget }
  | { type: "fill"; target: BrowserUseTarget; value: string }
  | { type: "press"; key: string; target?: BrowserUseTarget }
  | { type: "scroll"; x: number; y: number; target?: BrowserUseTarget };

export interface BrowserUseSnapshot {
  url: string;
  title: string;
  /** Provider-neutral text / accessibility representation, with action references. */
  content: string;
}

export interface BrowserUseScreenshot {
  data: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

/** Playwright/CDP implementations own their transport and browser resources. */
export interface BrowserUseSession {
  readonly id: string;
  readonly providerId: string;
  readonly ownerId: string;
  readonly capabilities: readonly BrowserUseCapability[];
  navigate(url: string, signal?: AbortSignal): Promise<void>;
  snapshot(signal?: AbortSignal): Promise<BrowserUseSnapshot>;
  screenshot(signal?: AbortSignal): Promise<BrowserUseScreenshot>;
  perform(action: BrowserUseAction, signal?: AbortSignal): Promise<void>;
  /** Idempotent; releases only this session's provider-owned resources. */
  close(): Promise<void>;
}

export interface BrowserUseProvider {
  readonly id: string;
  readonly capabilities: readonly BrowserUseCapability[];
  createSession(options: BrowserUseSessionOptions): Promise<BrowserUseSession>;
}

/** Registry/lifecycle contract only; not instantiated or registered as an Agent tool yet. */
export interface BrowserUseManager {
  registerProvider(provider: BrowserUseProvider): void;
  createSession(providerId: string, options: BrowserUseSessionOptions): Promise<BrowserUseSession>;
  getSession(sessionId: string): BrowserUseSession | undefined;
  listSessions(ownerId?: string): readonly BrowserUseSession[];
  closeSession(sessionId: string): Promise<void>;
  closeOwnerSessions(ownerId: string): Promise<void>;
  dispose(): Promise<void>;
}

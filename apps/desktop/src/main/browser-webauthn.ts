import { execFileSync } from "node:child_process";
import type { App, BrowserWindow, MessageBoxOptions, MessageBoxReturnValue, Session, WebContents, WebFrameMain } from "electron";
import { isUiBrowserContents } from "./browser-security";

/** Read the actual signature, rather than advertising an authenticator without its entitlement. */
export function readWebAuthnAccessGroup(executable = process.execPath): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const plist = execFileSync("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", executable],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
    const entitlements = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"],
      { input: plist, encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }));
    const groups: unknown = entitlements["keychain-access-groups"];
    return Array.isArray(groups) ? groups.find((group: unknown) =>
      typeof group === "string" && /^[A-Z0-9]{10}\.com\.vela\.desktop\.webauthn$/.test(group)) ?? null : null;
  } catch { return null; }
}

export function configureBrowserPlatformAuthenticator(app: Pick<App, "configureWebAuthn">,
  platform: NodeJS.Platform, accessGroup: string | null): boolean {
  if (platform !== "darwin" || !accessGroup) return false;
  app.configureWebAuthn({ touchID: { keychainAccessGroup: accessGroup, promptReason: "sign in to $1" } });
  return true;
}

interface AccountPicker {
  selectionTimeoutMs?: number;
  contentsFromFrame(frame: WebFrameMain): WebContents | undefined;
  parentForContents(contents: WebContents): BrowserWindow | null;
  showMessageBox(parent: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
}

/** WebAuthn is handled by Chromium/OS, not a page preload or a broad device permission grant. */
export function registerBrowserWebAuthn(browserSession: Session, picker: AccountPicker): () => void {
  const pending = new Map<WebFrameMain, () => void>();
  const select = (_event: unknown, details: Electron.SelectWebauthnAccountDetails,
    callback: (id?: string | null) => void) => {
    const frame = details.frame;
    const contents = frame && !frame.isDestroyed() ? picker.contentsFromFrame(frame) : undefined;
    const parent = contents && isUiBrowserContents(contents) && contents.session === browserSession
      ? picker.parentForContents(contents) : null;
    if (!frame || !contents || !parent || parent.isDestroyed() || !details.accounts.length) { callback(); return; }
    pending.get(frame)?.();
    const requestingUrl = frame.url;
    const origin = frame.origin;
    const abort = new AbortController();
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (credentialId?: string) => {
      if (settled) return;
      settled = true; pending.delete(frame); clearTimeout(deadline);
      contents.removeListener("destroyed", cancel);
      contents.removeListener("render-process-gone", cancel);
      contents.removeListener("did-start-navigation", navigate);
      abort.abort(); callback(credentialId);
    };
    const cancel = () => finish();
    const navigate = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (!event.isSameDocument && (event.isMainFrame || event.frame === frame)) cancel();
    };
    pending.set(frame, cancel);
    contents.once("destroyed", cancel);
    contents.once("render-process-gone", cancel);
    contents.on("did-start-navigation", navigate);
    // Electron 44 gives no event when the page aborts its credential request.
    // Bound stale dialogs and replace a previous request from the same frame.
    deadline = setTimeout(cancel, picker.selectionTimeoutMs ?? 60_000);
    deadline.unref();
    const label = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
    const accounts = details.accounts.map(account => ({ ...account }));
    const options: MessageBoxOptions = {
      type: "question", title: "Vela · Passkey", message: `Sign in to ${label(details.relyingPartyId)}`,
      detail: `Choose a passkey account.\n${requestingUrl}`,
      buttons: ["Cancel", ...accounts.map((account, index) =>
        label([account.name, account.displayName].filter(Boolean).join(" — ")) || `Account ${index + 1}`)],
      defaultId: 0, cancelId: 0, noLink: true, signal: abort.signal,
    };
    void (async () => {
      try {
        const result = await picker.showMessageBox(parent, options);
        const account = accounts[result.response - 1];
        finish(!frame.isDestroyed() && frame.origin === origin && account ? account.credentialId : undefined);
      } catch { finish(); }
    })();
  };
  browserSession.on("select-webauthn-account", select);
  return () => {
    browserSession.removeListener("select-webauthn-account", select);
    for (const cancel of pending.values()) cancel();
  };
}

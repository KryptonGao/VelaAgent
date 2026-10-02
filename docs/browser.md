# Browser Panel and future Browser Use

The workbench's **New tab → Browser** opens a manual Electron `<webview>` at
the same level as file, terminal, plan and change tabs. Each tab owns a
`BrowserController` and `BrowserStore`. The React `BrowserPanel` renders
snapshots and binds the guest element; guest events and commands stay in the
controller. Bare hosts use HTTPS; localhost/loopback development URLs use HTTP.

Web links clicked in the main conversation flow open in a new manual browser tab
by default and expand the workbench. **Settings → Appearance & shortcuts →
Conversation links** can select the system browser instead. The choice is saved
in `vela.conversationLinkTarget` and applies immediately to existing messages.
Modified clicks retain native handling. Mail links, sign-in controls and Markdown
outside the conversation flow keep their existing behavior. Rendering a link
never opens a browser automatically.

Inactive tabs and a folded workbench keep their guest elements mounted. Folding
hides the workbench completely; its expand button lives in the chat header.
Closing a tab releases that guest. Browser tabs are window-scoped and survive switching
workspaces/conversations or opening Settings. Restarting the app does not restore live pages/history;
the dedicated `persist:vela-ui-browser` partition retains cookies/site storage.

`browser-security.ts` enforces sandboxing, context isolation, web security,
disabled Node integration and no preload. Only HTTP(S) and the initial blank page
are accepted. Popup destinations open in the existing isolated guest. The guest
session denies permission requests. No browser control IPC, preload API, Agent
tool, DOM scripting API or remote debugging endpoint is added.

`@vela/agent` exports the independent `BrowserUseProvider`, `BrowserUseSession`
and `BrowserUseManager` contracts from `browser-use.ts`. There is no provider
implementation or runtime registration yet. A future Playwright/CDP provider
must own its browser context, transport and profile; it must never reuse the UI
guest, its session partition or `BrowserController`. The manager owns provider
selection and session cleanup per Agent owner. Snapshot/action/screenshot types
are independent of Electron and React. A provider reports its supported
capabilities; callers must check them before invoking optional operations.

Targeted validation:

```sh
pnpm --filter @vela/desktop test:browser
pnpm --filter @vela/desktop typecheck
pnpm --filter @vela/agent typecheck
pnpm --filter @vela/desktop build
node_modules/.bin/electron apps/desktop/test/browser-electron-smoke.mjs
```

# Browser Panel and Browser Use

Browser Use operates the same Electron `<webview>` pages as the right-hand
Browser Panel. Browser Host owns tab identity, conversation ownership, window
routing and CDP lifecycle; the Panel projects that state. Conversations have
separate tabs but share cookies and site storage in `persist:vela-ui-browser`.
Switching conversations, opening Settings, folding the Panel and selecting
another tab keep guests alive. Closing a tab releases its guest. Restarting the
app does not restore live pages or history.

Conversation links open a Panel tab by default. Settings → Appearance &
shortcuts → Conversation links can select the system browser. Modified clicks
retain native handling. Rendering a link does not open a browser.

## Persistent Node REPL

Execution-mode agents use `browser_repl({code, timeoutMs?})` and
`browser_repl_reset()`, subject to the existing ask/smart/full execution policy.
The REPL has local Node machine access. Plan and read-only agents should not
receive these tools. Each `(conversationId, agentId)` has its own persistent
utility process, variables, functions and top-level await. Entire invocations
are serialized per conversation, including across agents; other conversations
can run concurrently. The default timeout is 30 seconds, capped at 120 seconds.

The worker entry is packaged as `out/main/browser-repl-worker.mjs`. Its imported
Browser Client and built-in skill text are bundled with it; no external Node
installation or new runtime dependency is required. The first invocation
returns the API/workflow documentation. Node 24 evaluator callbacks, domain
errors and REPL error output settle failures; console output has a separate
stream. Output is limited to 100 content items, 64 KiB per text item and 8 MiB
per invocation. Screenshots are image content, not local paths.

```js
var browser = await agent.browsers.get("iab");
await browser.tabs.list();
var tab = await browser.tabs.open("http://localhost:3000");
nodeRepl.write(await tab.snapshot());
// Use a fresh snapshot reference or an unambiguous semantic locator.
await tab.query({ role: "textbox", name: "Name" }).fill("Ada");
nodeRepl.write(await tab.snapshot());
nodeRepl.emitImage(await tab.screenshot());
```

Tabs expose `list`, `open(url)`, `get(id)`, `selected()`, `select(id)` and
`close(id)`. A tab exposes `url`, `title`, `goto`, `back`, `forward`, `reload`,
`snapshot`, `query`, `frame`, `press`, `scroll`, `screenshot`, `evaluate`,
`console` and `network`. `query({ref}|{role,name}|{text}|{css})` returns a locator
with `click`, `fill`, `type`, `press` and `selectOption`. `frame(frameId)` returns
the DOM interface scoped to that frame. Console/network accept `{since,limit}`;
collection is bounded and does not automatically capture response bodies.
Always inspect before acting and verify afterward. Await browser operations.

## Ownership and lifecycle

`BrowserSessionRegistry` and `BrowserHost` hold authoritative tab state. The
renderer projects Host snapshots through `BrowserController`/`BrowserStore`.
Manual navigation and agent navigation both operate the same guest WebContents.
Host validates the local main-frame IPC sender, guest embedder, persistent
session identity, unique binding, conversation ownership and window ownership.
Agents receive logical tab IDs, never WebContents IDs. Unowned manual pages are
listed for discovery and claimed on first reference.

`BrowserViewHost` stays mounted independently of the current conversation,
Settings and workbench presence. Hidden guests retain their viewport; new
background guests use the window's last browser size, or 1024×768. Showing a
guest updates its size from the actual Panel. Foreground agent open/select
requests expand the Panel; background requests update only their own tabs.
The Panel shows browser operation status and can stop the conversation.

Agent inputs also show an app-owned mouse pointer without a text label, with
click, typing, key, selection or scrolling feedback. Its coordinates come from
the actual CDP input target, with iframe positions mapped into the root CSS
viewport. Scrolling indicates the center of the operated frame. Each page starts
with an idle pointer, which stays at its last position between actions, after
completion/cancellation and through navigation. Only action feedback expires;
subsequent targets move the same mounted pointer with an interruptible 320ms
transition. Tab closure removes it; hidden tabs do not display it. The overlay does
not intercept manual input or appear in the page DOM or Agent screenshots,
and respects the system's reduced-motion preference.

Each invocation binds trusted window/conversation/agent/turn/invocation identity
to a dedicated MessagePort. Completion revokes that invocation. Abort, timeout
or worker failure revokes before cancelling RPC and ending the worker. Later
execution reports that the Node context was rebuilt. Reset preserves pages and
login state. Leftover callbacks cannot use the browser during later calls.
Local Node callbacks can still run until termination: this is an execution
permission boundary. Tab closure immediately rejects its pending operations.
Window closure and runtime disposal clean up workers, guests, CDP and listeners.

Snapshot references retain actual node identity and a page generation; navigation
and node replacement invalidate them. Locators require one match, visibility,
enabled controls, and stable layout. Open Shadow DOM and same-origin/cross-origin
frames are supported; OOPIFs use CDP child sessions. Clicks, typing and keys use
CDP input. Hidden-page keyboard input uses focus emulation without focusing the
user's window. Public `evaluate` executes in the page's main world so application
globals are accessible; reference bookkeeping uses an isolated world.
Accessibility text is a DOM-derived approximation. Affine iframe transforms are
mapped through content quads; perspective transforms fail explicitly.

Console/network records include a collection start timestamp, bounded records
and cursors. Network reports method, URL, status, type, duration and failure;
it does not fetch response bodies. Screenshots contain actual PNG dimensions
and return model image content, with previews retained in tool cards/history.
REPL evaluator errors carry structured metadata and mark failed tool results.

Guest security retains sandboxing, context isolation, web security, disabled
Node integration, no Vela preload and HTTP(S) navigation. Popup destinations
retain the existing in-place policy. Arbitrary CDP forwarding and a remote
debugging port are not exposed. Native view migration, window.opener-dependent
authorization and upload/download orchestration remain outside this release.

Browser tools register only when a browser service is injected. Execution-mode
main/general agents share the conversation's pages with separate REPL bindings;
Plan/explore agents cannot use them. Existing ask/smart/full permissions display
and assess JavaScript code. No additional site approval is applied. Browser
executions count as potential workspace mutations for Git refresh, subagent
mutation tracking and Goal validation invalidation.

## Build and validation

The worker, Browser Client and embedded API guide are bundled into the main
output; the built-in skill source ships at `out/main/skills/browser-use/SKILL.md`.
The runtime uses Electron's embedded Node and `utilityProcess.fork` with
MessageChannelMain. No user-installed Node is needed. See the
[Electron utility process API](https://www.electronjs.org/docs/latest/api/utility-process)
and [public browser workflow](https://learn.chatgpt.com/docs/browser?surface=app).

```sh
pnpm --filter @vela/desktop test:browser
pnpm --filter @vela/desktop test:browser-repl
pnpm --filter @vela/agent test
pnpm typecheck
pnpm --filter @vela/desktop build
node_modules/.bin/electron apps/desktop/test/browser-electron-smoke.mjs
node apps/desktop/test/browser-use-electron-smoke.mjs
```

The first Electron smoke uses the real App/Panel and checks navigation, storage,
conversation ownership and page retention through tabs, folding and Settings.
The second uses real guests, CDP and the bundled utility worker for login reuse,
forms, frames, Shadow DOM, stale references, failures, context recovery,
concurrency and code-edit/HMR/screenshot on the same page. Its fixture avoids
model/network dependencies outside local HTTP servers.

For packaged-artifact checks, build a macOS directory with
`pnpm --filter @vela/desktop exec electron-builder --mac --arm64 --dir` and set
`VELA_SMOKE_WORKER` to the packaged `app.asar/out/main/browser-repl-worker.mjs`
for the Browser Use runner. The Panel smoke accepts `VELA_BROWSER_SMOKE_APP_PATH`
pointing to the packaged `app.asar/out/main/index.mjs`.

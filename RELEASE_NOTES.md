# Vela 0.1.5

This release lets execution-mode agents drive the same pages as the built-in Browser Panel through a persistent JavaScript REPL, adds an on-panel agent pointer, and moves browser tabs, guests, and CDP state to a host-owned lifecycle, with browser permission prompts that can be stopped and a test center that can run real-app checks.

## New

- **Browser Use**: execution-mode agents can inspect and operate the Browser Panel through two tools, `browser_repl({code, timeoutMs?})` and `browser_repl_reset()`. The first invocation returns the API and workflow documentation. Agents can list, open, select, and close tabs; navigate back, forward, reload, and to URLs; take snapshots; query elements by reference, role and name, text, or CSS; click, fill, type, press keys, and select options; scroll, evaluate page JavaScript and read application globals, and read console and network records. Screenshots are returned as real model images with their PNG dimensions and remain visible in tool cards and restored transcripts.
  - Each `(conversation, agent)` keeps its own persistent JavaScript context with variables, functions, and top-level await. Calls default to 30 seconds and allow at most 120 seconds; `browser_repl_reset` clears bindings while keeping pages and login state. Entire invocations are serialized per conversation, including across agents, while other conversations run concurrently.
  - Agents reuse the conversation's existing pages, including manual logins and cookies. Snapshot references bind to a page generation and fail on stale or ambiguous targets instead of guessing; open Shadow DOM, same-origin frames, and cross-origin frames (OOPIFs) are supported. Closed Shadow DOM, perspective-transformed iframes, response bodies, popup authorization, and upload/download orchestration are not covered in this release.
- **Browser REPL permissions**: `browser_repl` runs in a dedicated Electron utility process with local Node access, so it follows the existing Ask / Smart / Full policy and adds a dedicated approval kind. Ask mode always prompts even for in-workspace code; Smart mode sends the code to the risk model without caching, because persistent bindings can change what identical code does; Full mode runs without prompting. The approval banner shows the code as **Run JavaScript / 运行 JavaScript**. Plan agents and `explore` subagents cannot use the tools, and every execution counts as a potential workspace mutation for Git refresh, subagent mutation tracking, and Goal validation invalidation.
- **On-panel agent pointer**: while an agent operates a page, the panel shows an app-owned pointer without a text label, with distinct click, typing, key, selection, and scrolling feedback. Coordinates come from the actual CDP input target, and iframe positions are mapped into the root viewport. The pointer stays at its last position while idle, after completion or cancellation, and through navigation, moves with an interruptible 320 ms transition, is hidden for hidden tabs, does not intercept manual input, is not injected into the page DOM or included in agent screenshots, and respects the system's reduced-motion preference.
- **Host-owned browser sessions**: `BrowserHost` now owns tab identity, conversation ownership, window routing, and CDP lifecycle, and the panel renders that state. Each conversation keeps its own tabs while sharing cookies and site storage in `persist:vela-ui-browser`; switching conversations, opening Settings, folding the workbench, or selecting another tab keeps guests alive with their form input, scroll position, and history. Background agent tabs keep their own viewport (the window's last browser size, or 1024×768). Agents receive logical tab IDs, never WebContents IDs, and unowned manual pages can be discovered and claimed.
- **Browser operation status**: when an agent is using a conversation's browser, the panel shows **Agent is using this conversation's browser / Agent 正在操作此对话的浏览器** with a **Stop** button. A foreground agent open or select request expands a folded panel and closes Settings; background requests only update their own tabs.
- **Built-in `browser-use` skill** documents the workflow of inspecting before acting, choosing stable locators, and verifying with a screenshot and the console or network log.

## Improved

- The test center can now register real Electron application checks as script fixtures with success markers, per-check timeouts, captured output, and process-group cleanup, and can assign UI checks to existing feature groups. Two new checks cover the agent pointer and the real App/CDP/webview smoke, and browser coverage now runs Host, CDP, controller, security, and conversation-link tests in one `test:browser` task.

## Fixed

- Stopping a task also cancels a pending Browser REPL permission request or Smart-mode risk evaluation instead of waiting for it, and the tool reports that the Node context was rebuilt.
- Navigation failures from stopped or superseded loads no longer overwrite the current page state or a newer navigation result.
- Keyboard input into hidden background guests uses focus emulation and verifies the applied text; OOPIF input is dispatched through the frame's own CDP session, and same-process iframe geometry is mapped through content quads.
- CDP and debugger disposal is idempotent and tolerates a guest that is already destroyed, removing a main-process native-object error.
- Browser REPL failures are reported as failed tool results even when the underlying error flag is omitted, and tab closure rejects its pending operations immediately.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Browser cookies and site storage, including logins, persist across restarts in `persist:vela-ui-browser`; live pages and history do not.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.5-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.5-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `0.1.5`. macOS bundle and download version: `0.1.5`.

## Validation

- All workspace type checks passed.
- 201 agent tests passed across 28 files, including 9 new Browser Use tests.
- 406 desktop test cases passed across 47 files, including new coverage for Browser Host (11 tests), Browser CDP (19 tests), the Browser REPL manager (6 tests) and worker (9 tests), browser controller, browser security, conversation links, and test-center script fixtures (5 tests).
- 99 workspace tests passed.
- All 90 test-center tasks passed in one headless run, including 9 Electron UI checks.
- Electron checks passed against real guests, CDP sessions, and the bundled utility worker: Browser Panel smoke (10 checks), the agent pointer UI checks, and the Browser Use smoke covering login reuse, forms, Shadow DOM, frames and OOPIFs, app globals, console and network records, stale references, failures, cancellation, concurrency, and code-edit/HMR verification on the same page.
- Production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

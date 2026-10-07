# Vela 1.0.2

Vela 1.0.2 adds **logging and diagnostics**. The main process, the agent runtime, and the renderer now write to one set of local log files with levels, rotation, and secret redaction; uncaught errors and process crashes are recorded instead of lost; and a one-click **diagnostics bundle** (a ZIP) can be exported from Settings or the Help menu to attach to a bug report. Sensitive-value redaction moves into a shared module that the MCP display layer now reuses.

## New

- **Unified application logs**: logs from the main process, the agent runtime, and the renderer are written to `<home>/logs` (`~/.vela` for the packaged app, `~/.vela-dev` for source builds, or the directory given by `VELA_USER_DATA`). Each day gets one `vela-YYYY-MM-DD.log` in JSON Lines, with timestamp, level, scope, process, message, structured data, and a serialized error (including `code` and up to three `cause` levels).
  - **Rotation and cleanup**: a file that would exceed 10 MB rolls over to `vela-YYYY-MM-DD.N.log`; files older than 14 days are removed at startup and on rotation, and the oldest files are dropped first once the total passes 100 MB. Today's file is always kept.
  - **Writing**: entries are appended in batches (every 250 ms or 50 entries), `error` entries are flushed immediately, and quit, uncaught exceptions, and crashes flush synchronously. A write failure is reported to stderr once and never affects the app. Logs produced before the sink is ready are buffered (up to 500 entries) and written afterwards.
  - **Levels**: `debug`, `info`, `warn`, `error`, defaulting to `info`. Settings gains a **Logs & diagnostics** section to switch the level, stored in `<home>/logging-settings.json` and shared with the renderer. Setting `VELA_DEBUG` forces `debug` and locks the control; the debug output that used to appear only under `VELA_DEBUG` is now ordinary `debug` entries. Source builds and `VELA_DEBUG` also mirror logs to the terminal / DevTools console.
  - **Privacy**: every entry passes through `redactSensitive` before it is written: bearer tokens, `user:pass@` in URLs, sensitive query parameters (`token`, `code`, `api_key`, ...), sensitive JSON keys, and string values under keys such as password, secret, token, credential, cookie, and authorization are masked, and the home directory is written as `~`.
- **Crash and uncaught-error capture**: the main process records `uncaughtException` (the default Electron error box still appears), `unhandledRejection`, renderer and child process crashes, unresponsive / responsive pages, and startup failures. The renderer records `window` errors and unhandled rejections, and a new React `ErrorBoundary` logs render crashes and shows a retryable error screen. Renderer logs reach the main process over a validated IPC channel: fields are checked, long content is truncated (4 KB messages, 16 KB data), and at most 50 entries per second are accepted, with the overflow summarized as one `warn` in the next second.
- **Diagnostics bundle export**: **Settings → Logs & diagnostics → Export diagnostics…** or **Help → Export Diagnostic Logs…** creates `vela-diagnostics-YYYYMMDD-HHmmss.zip` at a location you choose and reveals it in Finder. **Help → Open Logs Folder** and a matching button in Settings open the log directory.
  - **Contents**: all retained log files, `system-info.json` (app, Electron, Node, and Chrome versions, OS, CPU, memory, uptime), a redacted `git-operations.json`, a redacted `settings-summary.json` (model, memory, scheduled-task, logging, and workspace settings plus the workspace's MCP server catalog), and a `manifest.json` recording the export time and whether each item succeeded. A missing or unreadable item is recorded with its reason without blocking the rest.
  - **Trace is opt-in**: the current conversation's Trace is included line by line, redacted, only when you tick the checkbox in Settings, because it can contain prompts, file contents, and tool output. The menu export never includes it. Credential files, conversation messages, and memory contents are never exported.

## Improved

- **Shared redaction**: `redactSensitive` now lives in `@vela/shared`, and the MCP display redaction (`redactMcpDisplay`) reuses it, so logs, diagnostics, and MCP parameter / error display scrub secrets the same way.
- **Consistent logging in application code**: direct `console.*` calls in the main process, runtime, persistence, scheduler, task recipes, browser tabs, and UI storage hooks are replaced with scoped loggers (`createLogger`), so previously console-only failures now reach the log files.
- **Documentation**: [the logging guide](docs/logging.md) covers file location and format, levels, rotation, redaction, crash capture, bundle contents, and how to log from code; `docs/README.md` links it.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, and the Pull Request Inbox continue to work.

A `logs` folder and `logging-settings.json` are created inside that directory on first launch; nothing is uploaded, and a diagnostics bundle is only created when you export one.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.2-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.2-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `1.0.2`. macOS bundle and download version: `1.0.2`.

## Validation

- All workspace type checks passed.
- The logging tests (`pnpm --filter @vela/desktop test:logging`) cover level filtering, error serialization, buffered replay, redaction, file rotation and cleanup, level persistence, bundle contents and redaction, missing-item records, export cancellation, and renderer log validation, truncation, and rate limiting; the UI storage and MCP tests still pass with the shared redaction.
- The production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

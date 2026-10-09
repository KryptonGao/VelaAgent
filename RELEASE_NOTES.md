# Vela 1.0.7

Vela 1.0.7 adds **conversation export**: save any chat as Markdown or a single self-contained HTML file, with tool calls, file diffs and the trace attached, so it is ready for a postmortem or for sharing with a teammate.

## New

- **Export a conversation**: the "More chat actions" menu in the chat header now has **Export as Markdown…** and **Export as HTML…**. Pick where to save (the Documents folder by default); Vela writes the file and reveals it in Finder. Both items are disabled until the chat has a message, and a failed export shows its reason in the menu.
  - **What is included**: title and metadata (chat ID, workspace, UTC timestamps, Vela version), an overview (turns, tool calls and failures, files changed, lines added and removed, and model requests, duration and tokens when a trace exists), failed and interrupted steps, a per-file change summary, the full transcript turn by turn with `edit` / `write` diffs and `bash` commands and output, the files each turn's checkpoint recorded as changed (which also covers files changed indirectly by `bash`), and the model-request table and node timeline from the trace. Thinking is not exported.
  - **HTML export**: one file with no scripts or external links. It follows the system light or dark appearance, collapses tool output and diffs by default, and opens or prints in any browser.
  - **Redaction**: the whole document is redacted before it is written. API keys and tokens, `Authorization: Bearer` headers, sensitive URL parameters and credentials in URLs, and `NAME=value` secrets are masked, and your home directory is shown as `~`. Redaction is best effort, so check the file before sharing it, especially `bash` output.
  - Long content is truncated with the number of omitted characters, and headings follow the app language (Simplified and Traditional Chinese, English, Japanese, Korean).

## Improved

- **Chat actions menu**: arrow keys, `Home` and `End` now move between all menu items.
- New interface text for the export actions in Traditional Chinese, Japanese, and Korean.

## Upgrade

Installed copies of Vela 1.0.6 receive this update automatically: Vela downloads it in the background and prompts you to restart. Versions 1.0.5 and earlier cannot update themselves, so install this version manually once: quit Vela completely, replace the application with this version, and reopen it.

Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, the Pull Request Inbox, checkpoints, and logs continue to work.

The macOS build is not notarized and uses an ad-hoc signature. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security. Because the code signature differs between versions, macOS may ask you to confirm privacy or keychain access again after an update.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.7-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.7-arm64.zip` | macOS Apple Silicon application bundle (`.app`); also the package used by in-app updates |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |
| `SHA256SUMS.txt.sig` | Ed25519 signature of `SHA256SUMS.txt`, verified by the in-app updater |

Package version: `1.0.7`. macOS bundle and download version: `1.0.7`.

## Validation

- Type checks and unit tests for all workspace packages (`pnpm test`) passed: 166 workspace, 414 agent, and 687 desktop tests, including the conversation export tests.
- The in-app update tests (`test:updates`, 29 tests) passed.
- The production build succeeded, and 11 of 13 real-Electron smoke suites passed. The Task Recipes and Pull Request Inbox smoke suites still fail: their scripts were not updated for the 1.0.5 interface redesign and are not related to this release.
- In the real-Electron renderer checks (`test:ui`), the chat actions menu (including the export items), plugins, memory settings, and update UI checks passed. The MCP settings check fails with or without this release's style changes.

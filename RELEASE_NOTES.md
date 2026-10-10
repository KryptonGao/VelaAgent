# Vela 1.1.0

Vela 1.1.0 adds **Intelligent UI** and the **Agent Inbox**. Answers can now contain interactive native interfaces, and a new sidebar page gathers every approval, question and background result in one place, backed by an optional Resident Agent that works in the background.

## New

- **Intelligent UI**: the agent can embed calculators, comparison tables and step-by-step walkthroughs directly in a reply.
  - Interfaces are declarative data rendered with Vela's own components. HTML, scripts and JSX from the model are never executed.
  - Filters, sorting, tabs, sliders and checkboxes work instantly and locally. A button can send the current values back to the agent as a new message, but only after you confirm the text shown in the interface.
  - Every interface has **View source**, and an unfinished or invalid interface falls back to readable text.
  - Choose the behavior in **Settings → Conversation display → Interactive UI**: Auto (default), Text only, or Prefer visual. Only Agent mode is told about it; Plan and Goal stay plain Markdown.
  - Interfaces are included when you export a conversation.
- **Agent Inbox**: a new top-level sidebar page that collects tool approvals, agent questions, failed turns and subagents, plans waiting for review, scheduled-task results and agent suggestions from all your chats.
  - Approve or deny a request, or answer a question, without opening its chat. The decision goes through the same path as in the chat, so answering in either place gives the same result; if the original request is already gone, the item is marked invalid instead of claiming it was approved.
  - Archiving only hides an item. It never approves, denies or unblocks anything, and the badge counts only items that still need you.
  - Pending approvals and questions cannot survive a restart, so they are marked invalid when Vela starts again.
  - Search, filter by type, a narrow-window layout, light and dark themes, and Traditional Chinese, Japanese and Korean text. The page can be hidden from the sidebar options.
- **Resident Agent**: an always-on coordinator with its own persistent conversation. It has no file, command, browser or MCP tools; it can only list workspaces, tasks and inbox items, and delegate a background task to one registered workspace.
  - Every delegation asks for your approval first, even in the "approve for me" mode, and shows the target workspace and the task.
  - Modes: Off, Standby (default, never calls the model without a task) and Proactive.
  - Background tasks have a concurrency limit, a maximum run time and a queue. Tasks that were queued or running when Vela quit are shown as interrupted and are never replayed.
- **Proactive rules** (Proactive mode only): run an analysis when an inbox item fails, when Git changes, or when workspace files change. Rules are read-only by default, never use Full access, are debounced and rate-limited with a per-day cap, and show why a rule did not fire. Each trigger calls the model and incurs cost.
- **Background running**: closing the window keeps Vela running on macOS (configurable), with an optional menu bar icon, system notifications (once per item, quiet hours, grouped bursts, optional hidden content) and an option to start at login (installed build only).

## Improved

- Approval and question requests now report whether the original wait still exists, so a late reply is detected instead of being silently accepted.
- Interface text for the new features in Traditional Chinese, Japanese, and Korean.

## Upgrade

Installed copies of Vela 1.0.6 and later receive this update automatically: Vela downloads it in the background and prompts you to restart. Versions 1.0.5 and earlier cannot update themselves, so install this version manually once: quit Vela completely, replace the application with this version, and reopen it.

Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, the Pull Request Inbox, checkpoints, and logs continue to work. The Agent Inbox and Resident Agent create new files (`agent-inbox.json`, `resident-agent.json`) in that directory.

The macOS build is not notarized and uses an ad-hoc signature. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security. Because the code signature differs between versions, macOS may ask you to confirm privacy or keychain access again after an update.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.1.0-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.1.0-arm64.zip` | macOS Apple Silicon application bundle (`.app`); also the package used by in-app updates |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |
| `SHA256SUMS.txt.sig` | Ed25519 signature of `SHA256SUMS.txt`, verified by the in-app updater |

Package version: `1.1.0`. macOS bundle and download version: `1.1.0`.

## Validation

- Type checks and unit tests for all workspace packages (`pnpm test`) passed: 169 workspace, 487 agent, and 822 desktop tests, including the new Agent Inbox, Resident Agent and Intelligent UI tests.
- The in-app update tests (`test:updates`, 29 tests) passed.
- The production build succeeded, and 9 of 13 real-Electron smoke suites passed. The Task Recipes, Pull Request Inbox, Settings and Thinking blur smoke suites still fail. Task Recipes and Pull Request Inbox scripts were not updated for the 1.0.5 interface redesign; the Settings (scrollbar fade timing) and Thinking blur (animation value) checks fail identically on the 1.0.8 code, so none of the four is caused by this release.
- The production DMG and ZIP builds, bundle and packaged version metadata, DMG mounting, archive integrity, and the signed SHA-256 checksums were verified.

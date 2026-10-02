# Vela 0.1.3

This release adds a cross-workspace activity view and usage statistics, lets the thinking-summary model be chosen independently of the current chat, and keeps empty drafts out of the conversation list.

## New

- **Activity view**: the sidebar now has an Activity / Workspaces switch and opens on Activity. It aggregates conversations across every workspace into Priority, Today, Yesterday, and Earlier groups, ordered by most recent activity within each group.
  - Star a conversation to pin it to the Priority group; the mark survives restarts.
  - Conversations waiting on you (questions or approvals), finishing with an error, or actively replying or starting are moved to the top with a Waiting answer / Error / Replying status label.
- **Usage statistics** (Settings → Usage statistics): aggregates model requests and token usage across all conversations, archived ones included.
  - Filter by provider and by range (all available history, 30 days, 7 days, or a custom start and end date), refresh manually, and see which dates are missing or failed to load.
  - A daily activity heatmap covers the last year, darker for more requests, and expands to per-day request and token details.
- **Per-conversation usage tab**: conversation tabs now include Usage statistics with the current chat's overview, per-model and per-provider usage, cache hit rate, coverage detail, and separate usage for the thinking-summary model.
- **Separate thinking-summary model** (Settings → Appearance → Thinking summaries): default to the current chat's model or pick any configured model, including custom models from Models & accounts. The choice survives restarts and only affects newly generated summaries.
- **New chat per workspace**: each workspace group in the sidebar has a new-chat button that creates the conversation in that workspace; without a workspace it still uses the current one.
- **Shared sliding tab indicator**: the conversation tabs and the version-control tabs now use the same underline that slides between tabs and stretches on hover.
- **Background model catalog refresh**: providers with configured credentials fetch the remote Pi model catalog in the background and update the model lists without a restart. `PI_OFFLINE` disables all network access.

## Improved

- The execution trace always fits the timeline to the visible width, so a long trace no longer overflows horizontally. The scale control reads **Fit width, show the whole process**, and resetting zoom returns to the left edge and fits the width.
- The workspace, environment, and branch chips appear only before the first turn starts and collapse once the conversation is under way; error notices are still shown. The composer's minimum height is larger.
- New **Composer option backgrounds** appearance toggle (off by default) controls whether the attachment, chat mode, permissions, reasoning effort, and model controls get capsule backgrounds.
- Tool durations moved to the right of the expand arrow and are right-aligned.
- The sidebar scrollbar appears while scrolling and fades out about a second after you stop.
- Expanding a file diff preview no longer collapses the tool group rail.
- Code blocks and diffs wrap and can break anywhere, avoiding horizontal overflow at narrow widths.
- Usage is counted more accurately: history copied into a branch is counted once, archived conversations are included in the settings totals, and missing usage is no longer shown as zero.

## Fixed

- New conversations that have not sent a message no longer appear in the sidebar or search, even after creating several, renaming, or restarting. They are listed as soon as the first message is sent, including image-only messages, and branched conversations appear immediately because they already carry history.
- A chosen thinking-summary model no longer follows the chat's model or changes the chat's model selection, and summaries can use the dedicated model even when the current chat has no available model.
- Thinking-summary requests are recorded in usage statistics separately, with their own token usage, instead of being mixed with normal requests.
- Added localized errors for an invalid thinking-summary model selection, and the summary button now describes using the configured summary model.
- Fixed trace timeline rendering in narrow windows, where zoomed bars were squashed into squares or overflowed the container and ruler labels overflowed.
- Unified the version-control sub-tab styling, which previously mixed a border with a background.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Usage statistics are computed from existing conversation data, and the thinking-summary model defaults to following the current chat.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.3-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.3-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `0.1.3`. macOS bundle and download version: `0.1.3`.

## Validation

- All workspace type checks passed.
- 184 agent tests passed, including new coverage for the dedicated thinking-summary model, per-request summary usage, and retained usage after reopening and rewinding.
- 304 desktop tests passed, including 23 new cases for activity grouping, empty-conversation listing, per-workspace session creation, and usage statistics.
- 95 workspace tests passed.
- Production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

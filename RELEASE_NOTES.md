# Vela 0.1.2

This release turns the inline "Review" toggle into a full change-review workspace and adds optional process durations and fold memory to compact tool rows. It also fixes plan attachment for plan-only turns and a plan-stream flush order that could drop the completed revision.

## New

- **Turn change review**: the Review button on a turn's change summary now opens a dedicated workbench tab instead of expanding inline. The panel reads the edit records saved by that turn's tool calls, so the review is independent of later Git workspace edits.
  - Split before/after diff with line numbers, grouped by file edit when a file was changed more than once.
  - File tree sidebar with filter, per-file added/removed stats, collapsible directories, sticky file headers, and a highlight that follows scrolling.
  - In a narrow panel the file list becomes an overlay drawer; `Esc` closes the drawer first and the tab second.
  - The review snapshot is frozen when the button is clicked and is isolated per workspace and conversation.
- **Process durations & fold memory** (Settings → Appearance, off by default): in compact tool display, each finished call shows its duration and the turn trigger shows the turn total, taken from the existing execution trace. Expanded or collapsed rows and tool groups are remembered per conversation across restarts. Chats with no recorded timing simply show no label; malformed or unavailable local storage falls back to in-memory state for the session.

## Improved

- Plan cards now distinguish **Writing a plan** from **Plan submitted**, and show an explicit **Overview** heading above the summary.
- The floating environment card shows the current plan with its title; clicking it opens the plan document. The plan preview is no longer capped at 560px.
- Split diffs can display file line numbers, and omitted unchanged lines are labeled instead of appearing blank.

## Fixed

- A turn whose only output is a plan no longer attaches that plan to the previous turn's reply; plan-only turns create their own assistant message, and an empty assistant block that already carries plan IDs is not reused.
- Plan streaming now flushes and persists the final revision before clearing the pending stream, so the completed plan is emitted for tags that are unclosed, split across deltas, or completed normally. Stopping a turn still discards the unfinished draft.
- The execution trace panel no longer briefly renders the previous chat's trace while switching conversations.
- The workbench panel divider is no longer covered by the panel body background.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Process durations and fold memory remain off until enabled in Settings → Appearance.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.2-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.2-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `0.1.2`. macOS bundle and download version: `0.1.2`.

## Validation

- All workspace type checks passed.
- 176 agent tests passed, including new plan-stream coverage for unclosed, split-close, and stopped plan output.
- 113 targeted desktop tests passed: 55 for turn review, tool diff, tool duration, and fold state; 33 for the execution trace; 25 for persistence and UI storage.
- Production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

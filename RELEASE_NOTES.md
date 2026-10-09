# Vela 1.0.8

Vela 1.0.8 adds **subagent controls**: pause, resume or cancel any single subagent from the Agents panel, and see how many tokens and how much active run time each one has used.

## New

- **Pause, resume and cancel a subagent**: each subagent row in the Agents panel and in its own pane now has control buttons.
  - **Pause** takes effect before the subagent's next tool call, so a step already in flight finishes first. Until then the row shows **Pausing**; you can cancel the request with the same button.
  - **Resume** continues a paused subagent from where it stopped.
  - **Cancel** stops the subagent together with any subagents it spawned.
  - A paused subagent still counts as running: the chat cannot be edited or branched, a workspace-wide operation waits, and a recipe or scheduled run is not started while one is paused. Cancel it or resume it to finish.
- **Subagent usage**: every subagent shows its accumulated tokens and active run time (paused and queued time is not counted). Hover the token count for the input, output, cache-read and cache-write breakdown. The panel header also shows the total tokens of all subagents and how many are still in progress.

## Improved

- **MCP and Integrations settings for detached chats**: when the selected chat's folder no longer matches the current workspace, these pages now manage the workspace directly instead of binding to that chat, which the main process used to reject.
- Subagent history saved before this version loads normally. A subagent that was running or paused when Vela quit is shown as aborted.
- New interface text for the subagent controls in Traditional Chinese, Japanese, and Korean.

## Upgrade

Installed copies of Vela 1.0.6 and 1.0.7 receive this update automatically: Vela downloads it in the background and prompts you to restart. Versions 1.0.5 and earlier cannot update themselves, so install this version manually once: quit Vela completely, replace the application with this version, and reopen it.

Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, the Pull Request Inbox, checkpoints, and logs continue to work.

The macOS build is not notarized and uses an ad-hoc signature. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security. Because the code signature differs between versions, macOS may ask you to confirm privacy or keychain access again after an update.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.8-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.8-arm64.zip` | macOS Apple Silicon application bundle (`.app`); also the package used by in-app updates |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |
| `SHA256SUMS.txt.sig` | Ed25519 signature of `SHA256SUMS.txt`, verified by the in-app updater |

Package version: `1.0.8`. macOS bundle and download version: `1.0.8`.

## Validation

- Type checks and unit tests for all workspace packages (`pnpm test`) passed: 166 workspace, 421 agent, and 687 desktop tests, including the new subagent control tests.
- The in-app update tests (`test:updates`, 29 tests) passed.
- The production build succeeded, and 11 of 13 real-Electron smoke suites passed. The Task Recipes and Pull Request Inbox smoke suites still fail: their scripts were not updated for the 1.0.5 interface redesign and are not related to this release.
- The production DMG and ZIP builds, bundle and packaged version metadata, DMG mounting, archive integrity, and the signed SHA-256 checksums were verified.

# Vela 1.0.3

Vela 1.0.3 adds a **checkpoint timeline**. A new dialog lists every turn of a chat with the files it changed, previews whether you can safely return to it, and lets you either rewind the chat and its workspace files to the end of any turn or fork a new chat from there, optionally with the files restored. This release also splits the agent runtime into smaller modules and adds automated test runs on GitHub.

## New

- **Checkpoint timeline**: open it from the clock-arrow button in the chat header or from the **Checkpoint** action under any reply. The dialog shows the start of the chat and the end of every turn, marks the current position, and lists the files each turn changed. A turn that was queued while the previous one was running shows that it shares the previous checkpoint.
  - **Return here**: removes every later turn from the chat and restores the files those turns changed. Use *Start of chat* to go back before the first message. A confirmation step shows how many turns will be removed and which files will be restored.
  - **Safe by default**: before offering a return, Vela dry-runs the restore against the real workspace and nothing is written until you confirm. If a file was edited by hand after the turn, another chat changed the workspace during it, or the turn has no complete file checkpoint, the point is marked unavailable and the reason (including the conflicting path) is shown instead of overwriting your work.
  - **Fork from here**: keeps the chat up to that turn and continues in a new chat; the original is untouched. Tick **Also restore workspace files to this point** to undo the later turns' file changes as well. The fork carries its own copy of the checkpoints for the turns it kept, so it can be rewound again, including back to its start. Checkpoint file contents are hard-linked rather than duplicated where the file system allows.
  - Restoring and forking are disabled while a reply is streaming, and every message is available in Chinese and English.

## Improved

- **Structured recipe stages**: when a task recipe stage runs, the browser tool and the sub-agent tools stay out of the loadout and the tool guard even if an MCP server connects or changes mid-stage, and they come back once the stage ends.
- **Runtime structure**: the agent runtime's tool selection, skills handling, tracing, and recipe-stage logic moved out of the large `runtime.ts` into `runtime-tools.ts`, `runtime-skills.ts`, `runtime-tracing.ts`, and `recipe-stage.ts`. Behaviour is unchanged.
- **Automated tests**: `pnpm test` now runs the type checks plus every unit test in the agent, workspace, and desktop packages (each package runs all of its `test/*.test.*` files instead of a hand-kept list), and `pnpm test:ui` and `pnpm test:smoke` run the real-Electron UI checks and smoke tests. Two existing Electron checks were hardened: the Scheduled Tasks smoke test finds sidebar shortcuts by name instead of position, and the profile-lock test bundles its helper so it resolves workspace packages.
- **GitHub Actions**: a `CI` workflow runs the type check and unit tests on every pull request and push to `main`; an `Electron smoke` workflow runs the UI and smoke tests nightly, on version tags, and on demand.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, the Pull Request Inbox, and logs continue to work.

Turns recorded without a complete file checkpoint, such as those from older chats, are shown as unavailable for file restore rather than being restored incorrectly.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.3-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.3-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `1.0.3`. macOS bundle and download version: `1.0.3`.

## Validation

- Type checks and unit tests for all workspace packages (`pnpm test`) passed; new tests cover checkpoint previews and conflict reporting, returning to a turn or the chat start, forking with and without file restore, and the browser and sub-agent tools staying out of recipe stages.
- The production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

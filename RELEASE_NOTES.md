# Vela 1.0.6

Vela 1.0.6 adds **in-app updates**: installed copies now check GitHub Releases in the background, download and verify new versions, and prompt you to restart. It also lets an **Agent respond to pull request review comments** from the Pull Request Inbox, and **bounds the disk used by file checkpoints**.

## New

- **In-app updates**: Vela checks the latest GitHub Release about 20 seconds after launch and every 4 hours after that, downloads the update automatically, and shows a "Restart now / Later" prompt when it is ready. Choosing "Later" installs the update when you quit Vela.
  - **Signed and verified**: each release ships a `SHA256SUMS.txt` signed with an Ed25519 key built into the app. Vela verifies the signature first, then checks the SHA-256 of the downloaded package, the bundle identifier, and the bundle version before installing. Anything that fails verification is rejected.
  - **Settings → About & Updates**: shows progress and release notes, has a switch for automatic updates, and a manual "Check for updates" button. The application and Help menus also have "Check for Updates…".
  - **Safe replacement**: the new version is copied next to the current one and swapped in, and the old copy is restored if any step fails. When Vela runs from a disk image, from a quarantined location, or from a folder you cannot write to, it tells you about the new version and links to the release page instead.
  - Development builds (`pnpm dev`) never check in the background.
- **Respond to review comments with an Agent**: on your own open pull request, pick unresolved review threads and Vela creates a dedicated worktree and a new conversation to address them with local commits. You review the commits and the reply drafts, and only then does Vela push and reply. The Agent itself is not allowed to push, reply, or resolve threads; fork pull requests stay local-only, and pushes are never forced.
- **Checkpoint storage in Settings**: Settings → Storage shows how much disk the file checkpoints use and has a clean-up button.

## Improved

- **Smaller checkpoints**: file contents are now stored once in a shared pool and shared between conversations, unchanged files are not re-read between turns, and large files are hashed as a stream. Each conversation keeps its latest 50 turns, with a 4 GiB cap across all conversations; older checkpoints are pruned automatically and a clean-up also runs shortly after launch.
- **Pull Request Inbox**: refinements to the detail view and styling, and new interface text in Traditional Chinese, Japanese, and Korean.

## Upgrade

**This is the first version with in-app updates. Versions 1.0.5 and earlier cannot update themselves, so install 1.0.6 manually once**: quit Vela completely, replace the application with this version, and reopen it. From 1.0.6 on, updates arrive automatically.

Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, the Pull Request Inbox, checkpoints, and logs continue to work.

The macOS build is not notarized and uses an ad-hoc signature. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security. Because the code signature differs between versions, macOS may ask you to confirm privacy or keychain access again after an update.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.6-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.6-arm64.zip` | macOS Apple Silicon application bundle (`.app`); also the package used by in-app updates |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |
| `SHA256SUMS.txt.sig` | Ed25519 signature of `SHA256SUMS.txt`, verified by the in-app updater |

Package version: `1.0.6`. macOS bundle and download version: `1.0.6`.

## Validation

- Type checks and unit tests for all workspace packages (`pnpm test`) passed: 166 workspace, 414 agent, and 669 desktop tests.
- The in-app update tests (`test:updates`, 29 tests) passed, covering signature verification, tampered or unsigned packages, foreign download URLs, bundle identifier and version checks, the installer script, and the update UI in real Electron (`test:updates:ui`).
- The Pull Request Inbox tests (`test:pr-inbox`, 46 tests) and the real-Electron review-response flow (`test:pr-review-response:electron`, with a real git repository and a fake `gh`) passed.
- The production build succeeded, and 11 of 13 real-Electron smoke suites passed. The Task Recipes and Pull Request Inbox smoke suites still fail: their scripts were not updated for the 1.0.5 interface redesign (icon-only recipe buttons, `aria-selected` relation tabs) and are not related to this release.
- The production DMG and ZIP builds, bundle and packaged version metadata, DMG mounting, archive integrity, and the signed SHA-256 checksums were verified.

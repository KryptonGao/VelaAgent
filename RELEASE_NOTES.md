# Vela 1.0.4

Vela 1.0.4 adds **three more interface languages** (Traditional Chinese, Japanese, Korean) and a **redesigned Settings page** with search. The development build gains a fuller **sync from the installed app** with preview and one-click undo, plus a Developer tools page.

## New

- **More languages**: the interface now supports Simplified Chinese, Traditional Chinese (Taiwan), English, Japanese, and Korean. Pick one in **Settings → Interface → Language**; it applies to menus, dialogs, dates and numbers, and the text Vela asks models to write for you (commit messages, pull request descriptions, thinking summaries) follows the same language. Each language shows its own name in the picker.
- **Settings redesign**: settings are now grouped by purpose in a left navigation (General, Agent, Models & extensions, Data & workspace, and Development in the development build) instead of one long page.
  - **Search**: type in the search box at the top of the navigation to find any setting by name, hint, or keyword in either Chinese or English. Use the arrow keys and Enter to pick a result; Vela jumps to the page, scrolls to the setting, and briefly highlights it.
  - **Smaller pages**: Appearance, Interface, Shortcuts, Agent defaults, Conversation display, Skills, Models, Workspace, Archived chats, and Logs each have their own page. Some paths changed, for example tool-call display is now under **Settings → Conversation display** and the language under **Settings → Interface**.
  - Scrollbars in the settings navigation and pages appear only while scrolling.
- **Sync from the installed app (development build)**: **Settings → Developer tools → Sync production data** can now copy more than chats, and you choose what to import:
  - **Chats** (messages, plans, sub-agent history, traces, file checkpoints), **settings** (sandbox mode, thinking effort, global instructions), **models and accounts** (default model and custom endpoint structure; API keys and OAuth tokens are never copied), **Skills** (including disabled state), **MCP configuration** (secret values in environment variables and headers are cleared and servers missing them are disabled), and **memory**.
  - **Preview** shows how many items each category will import and writes nothing.
  - Each sync is a batch recorded under the profile folder. **Sync history** can undo a whole batch: it removes the imported chats, Skills, and memory and restores changed settings, leaving settings you edited afterwards alone. A chat that is open or still running must be left first.
  - Set `VELA_PRODUCTION_HOME` if your installed app uses a custom `VELA_USER_DATA`.
- **Developer tools (development build)**: open the Renderer DevTools, reload the window, or restart the main process, and copy the Vela, commit, Electron, Chromium, Node, and V8 versions for an issue report.

## Improved

- **Shared translation layer**: all text now goes through one lookup, so remaining Chinese-or-English-only strings in menus, file pickers, error messages, the version-control panels, usage, task recipes, and the checkpoint timeline follow the selected language, with consistent date, time and number formats.
- **Development restart**: restarting the main process under `pnpm dev` waits for the old process to release the single-instance lock instead of failing to start, and the old process now exits reliably.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, the Pull Request Inbox, checkpoints, and logs continue to work.

Your language choice is kept; the default is still Simplified Chinese. Settings you had changed keep their values; only their location in the Settings page is different.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.4-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.4-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `1.0.4`. macOS bundle and download version: `1.0.4`.

## Validation

- Type checks and unit tests for all workspace packages (`pnpm test`) passed; new tests cover production sync preview, import, and undo, the Developer tools, and that every settings-search entry points at a real setting.
- The production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

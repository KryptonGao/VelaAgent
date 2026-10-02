# Vela 0.1.4

This release adds a built-in browser for conversation links and manual browsing, lets you queue or steer messages while a reply is streaming, plays optional task sounds, and folds the workbench out of the way, with softer thinking-block edges and more reliable conversation titles.

## New

- **Built-in browser**: open web pages in a workbench tab on the right from the tab bar, from the new **Browser** entry on the start page, or by clicking a conversation link. The panel has Back, Forward, Reload (Stop while loading), and an address bar; the tab label follows the live page title, with clear loading, loaded, and load-failure states. Only `http:` and `https:` are accepted; a bare host becomes `https://`, while `localhost`, `127.x.x.x`, and `[::1]` stay `http://`.
  - The browser runs in its own isolated session (`persist:vela-ui-browser`) with no Node integration, no preload, and no IPC or Agent bridge, and permission requests are denied. `target="_blank"` and `window.open` stay in the same tab.
  - Hidden or folded tabs keep the page alive: form input, scroll position, and history survive switching tabs, folding the workbench, and opening Settings. Cookies and site storage persist across restarts; live pages do not.
- **Conversation links** (Settings → Appearance & shortcuts → **Conversation links**): open web links clicked in a conversation in the **Built-in browser** (default) or the **System browser**. Only plain left clicks are routed, ⌘/Ctrl, Shift, and Alt clicks keep the native behavior, and links other than `http:`/`https:` are left alone.
- **Queue and steer while replying**: the composer stays active during a reply. Enter queues a message that runs when the current task finishes naturally, and ⌘Enter / Ctrl+Enter steers the current task at the next model boundary. A steer button appears beside Send, and pending instructions are shown above the composer as removable **Queued** / **Steering** chips; stopping clears them. Attachments can also be added while a reply is streaming, and a queued instruction counts as a message only once the model consumes it. Pending instructions live in memory only, so restarting or rewinding clears them.
- **Task sounds** (Settings → Appearance & shortcuts → Appearance → **Task sounds**, on by default): short synthesized cues for **Error**, **Complete**, **Question**, and **Permission**, including background chats. **Preview sounds** buttons play each cue, previews work while sounds are muted, and same-kind cues within 900 ms are coalesced. No sound assets or network access are involved.
- **Collapsible workbench**: fold the right workbench with the arrow in the tab bar and expand it again from the chat header. Browser, terminal, file, and agent tabs stay mounted while folded, so returning does not reload them.

## Improved

- Thinking blocks now blur and fade their content at the top and bottom edges when expanded and scrollable, with the strength following the scroll position over the last 24 px instead of switching on and off. The same three-stage edge treatment is shared by the chat pane and agent panes, and sub-agent summaries and conclusions use the new scroll-fade shell.
- Prose thinking summaries render their trailing chevron at the end of the last paragraph, and clicking a link or button inside a summary no longer toggles the block.
- Markdown headings scale relative to the surrounding text, compact process cards clamp them, and document previews use larger headings.
- Conversation auto-titles are more reliable: the generation budget is raised from 48 to 2048 tokens, with one retry at 8192 when reasoning models stop on the token limit, so titles no longer fall back to the first message.
- New local test center for development (`pnpm test:center`): a dashboard on `127.0.0.1:5190` runs every Node test file plus the Electron browser UI checks, with run-all, failed-only, search, and per-test output, plus a headless `--run` mode. It is a development tool and is not part of the packaged app.

## Fixed

- A stopped turn no longer leaves queued or steering instructions behind for the next message.
- Usage is counted when a queued instruction is actually consumed instead of when it is submitted, and a failed submit no longer inflates the message count.
- A queued instruction that cannot be delivered is removed from the pending list and reports the error instead of staying stuck.
- Browser navigation errors no longer overwrite address edits or leak stale load results into a newer navigation.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Task sounds are on by default and conversation links open in the built-in browser by default; both can be changed in Settings → Appearance & shortcuts.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.4-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.4-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `0.1.4`. macOS bundle and download version: `0.1.4`.

## Validation

- All workspace type checks passed.
- 191 agent tests passed, including new coverage for runtime instructions and conversation-title retries.
- 347 desktop test cases passed across 42 files, including new coverage for the browser controller, browser security, conversation links, notification sounds, and thinking edges.
- 95 workspace tests passed.
- All 82 test-center tasks passed in one headless run, including 7 Electron browser UI checks.
- Electron smoke checks passed: 8 browser checks, 4 task-sound checks, and 5 thinking-blur checks.
- Production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

# Vela 0.0.4

Vela 0.0.4 replaces one-shot subagents with a persistent agent tree you can watch and steer, adds a model-based **Smart approval** permission mode, and makes it easier to move between Vela and the rest of your tools.

## What's new

- **Persistent subagents:** The one-shot `task` tool becomes an agent tree. `spawn_agent` starts an explore or general subagent and returns an id and path immediately; `followup_task` waits for a result; `send_message` adds instructions to an agent that is already running. Subagents can spawn their own children (up to three levels deep, 16 agents per conversation, four running at once), and their conclusions come back to the main conversation automatically.
- **Subagent pane:** A chat-header button shows how many subagents are running. Click a subagent card — or that button — to open the right-hand pane with that agent's own live stream: messages, thinking, tool calls, status, and final report. Switch between agents from the roster menu; the main chat and the pane keep independent scroll positions. Cards from earlier sessions still open the pane after a restart.
- **Smart approval:** Alongside "Ask every time" and "Full access", execution permissions gain **Smart approval**: the model selected for the current conversation reviews each command and file operation first, and only risky actions (or failed checks) ask you. Verdicts are cached per command and per path, and a check that times out falls back to asking you instead of blocking.
- **Open in app:** An **Open in …** split button in the chat header lists installed editors (VS Code, Cursor, Zed, Windsurf, Sublime Text, Nova, JetBrains IDEs, and more), terminals (Terminal, iTerm, Ghostty, Warp, WezTerm, kitty, Alacritty, Hyper), and Finder, showing their real icons. The split button remembers your last pick and opens the workspace there.
- **Skill management:** Each skill can be enabled or disabled on its own (tracked in `~/.vela/skill-preferences.json`), and skills that live in Vela's own skills folder can be deleted with a confirmation step. Disabled skills disappear from new conversations and from `/skill:` completion; open conversations reload before the next message. Project and `~/.agents` skills can only be disabled here.
- **Model list visibility:** Settings → Models & accounts can hide models from the composer's model list. The model currently in use stays visible, the menu shows how many are hidden, and one button brings them all back.
- **New conversation model choice:** Settings → Agent gains a "What new conversations start with" option: use the configured default model and reasoning effort, or reuse the model and thinking level from your most recent conversation (falling back to the default when it is unavailable).
- **Tool grouping:** A new "Tool grouping" setting under Settings → Appearance — **By assistant message** or **By position** — controls whether consecutive tool calls from adjacent assistant messages fold into one summary run. Thinking blocks now render with their own assistant step and follow it through the turn.
- **Image attachments:** Pasted screenshots are normalized before sending: unsupported formats are transcoded to PNG (falling back to JPEG when large), oversized images are scaled down, duplicates are removed, and up to six images are accepted. Attachments are sent to the model as real image input and render as thumbnails in your own message instead of a `[Image ×n]` placeholder. A malformed attachment is skipped rather than failing the whole message.

## Improvements

- All four panels — the left sidebar, right inspector, file preview, and subagent pane — are resizable by dragging their inner edge. Widths are remembered between launches, re-clamped when the window changes size, adjustable with the arrow keys (Shift for larger steps), and reset by double-clicking the handle.
- On macOS, Vela now reads `PATH` from your login shell at startup, so commands run by the agent can find Homebrew-installed tools such as `gh`, `pnpm`, and `node` instead of reporting them missing.
- Subagent tool cards summarize the agent's task and outcome in a scrollable panel with soft edge fades, and link straight to that agent's pane.
- Runs of tool calls fold into a single summary line that expands on click, with per-tool status and output.
- The README documents the three permission modes and per-skill enablement.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.0.4-arm64.dmg` | macOS (Apple Silicon) |

The macOS build is not notarized. If macOS blocks the app on first launch, use **Open Anyway** in System Settings → Privacy & Security, or run `xattr -cr /Applications/Vela.app` after moving it to Applications.

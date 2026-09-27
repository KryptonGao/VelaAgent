# Vela 0.0.1

The second Vela release builds on the initial [v0.0.0 release](https://github.com/KryptonGao/VelaAgent/releases/tag/v0.0.0) with clearer visibility into agent work and faster review of code changes.

## What's new

- **Turn-by-turn change summaries:** See the files edited in each turn, added and removed line counts, and diffs. Open the workspace changes panel to review or revert changes.
- **Session usage stats:** View turn and agent-step counts, output speed, cumulative token usage, cache hit rate, and context-window usage in the composer and context panel.
- **Collapsible assistant process:** Keep completed replies easy to scan, with thinking and tool activity available on demand alongside the turn's elapsed time.
- **Automatic conversation titles:** New conversations get a concise title based on the first message, with the message text used as a fallback.
- **Refined macOS interface:** The sidebar uses native macOS translucency, with updates to the chat, composer, and context panel.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.0.1-arm64.dmg` | macOS (Apple Silicon) |

This macOS build is not notarized. If macOS blocks the app on first launch, use **Open Anyway** in System Settings → Privacy & Security, or run `xattr -cr /Applications/Vela.app` after moving it to Applications.

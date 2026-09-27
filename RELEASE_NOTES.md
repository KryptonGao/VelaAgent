# Vela 0.0.3

Vela 0.0.3 adds a first-launch setup flow and a compact way to read tool calls, alongside a broad round of interface polish.

## What's new

- **First-launch setup:** A five-step onboarding flow walks through language and theme, tool call display, migrating existing Skills, connecting a provider, and choosing a default model and reasoning strength. Every step is saved as you go, the Skills step can be skipped, and all choices remain available later in Settings.
- **Compact tool calls:** A new **Compact** display mode (now the default) renders one line per tool call and folds repeated calls into a single summary line. Click a file name to preview it in the inspector, or a command to expand its output. The original expandable card view is still available under Settings → Appearance → Tool call display.
- **Reworked thinking blocks:** Thinking expands while the model is working and collapses automatically when it finishes, with a scrollable region, soft edge fades, and a subtle activity indicator.
- **File icons:** File previews, the explorer, and tool calls now show file-type icons. Choose between **Devicon** and **Material Icon Theme** under Settings → Appearance → File icons.

## Improvements

- The right inspector starts collapsed to keep focus on the conversation, and slides in as an overlay on narrow windows.
- Redesigned floating composer and side panels, with disclosures for context, tools, and usage.
- Chat now follows new content while pinned to the bottom, including expanded thinking and diffs.
- Question history renders in a compact form, and the chat header shows the current workspace and branch.
- Switching conversations no longer reorders the sidebar or re-touches the entry.
- Bundled third-party icon licenses are included in the app (`THIRD_PARTY_LICENSES.md`).

## Download

| File | Platform |
| --- | --- |
| `Vela-0.0.3-arm64.dmg` | macOS (Apple Silicon) |

The macOS build is not notarized. If macOS blocks the app on first launch, use **Open Anyway** in System Settings → Privacy & Security, or run `xattr -cr /Applications/Vela.app` after moving it to Applications.

# Vela 0.1.0

Vela 0.1.0 turns the right-hand pane into a workbench and Plan mode into a document you review before anything runs. Plan mode now writes a complete, versioned implementation plan you can revise and approve; the workbench adds an integrated terminal, file browsing and preview tabs next to Changes; and every conversation gains a **Trace** view with per-request timing, token and cache metrics. Automatic thinking summaries and chat titles keep long sessions readable.

## What's new

- **Plan documents:** In Plan mode the agent investigates the code, asks only about preferences it cannot infer, and writes a complete Markdown implementation plan in a `<proposed_plan>` block. The plan streams into the Plan Document panel while it is being written, and the chat keeps a compact plan card. Every rewrite becomes a new revision: earlier revisions stay available read-only from the revision menu, their scroll position is remembered, and an interrupted draft is never saved. **Continue editing** returns to Plan mode for the next revision, and **Execute plan** approves the current one.
  - Execution offers two paths: continue in the current conversation, reusing the research and reasoning that produced the plan, or clear the planning context and start a fresh conversation titled `原标题 · 执行` that carries only the original objective and the approved plan.
  - An approved plan enables an `update_plan` checklist. Progress appears in the Plan Document, on the plan card in the Context panel and in the `update_plan` tool card, and it is bound to the revision — re-executing resumes the existing checklist, while approving a new revision starts a new one.
  - Plan mode is enforced, not just prompted: only `read`, `bash` and `ask_user_question` are offered, and shell commands must pass a per-segment read-only whitelist. Destructive commands, output redirection, dependency installs, repository-modifying Git operations, privilege escalation and interactive editors are rejected.
  - Plans persist with the conversation in `~/.vela`. Plans saved by earlier versions (title/overview/steps) are migrated to revision 1 on load, together with their execution checklist when one existed.
- **Workbench tabs:** The right pane is now a tabbed workbench instead of a single view. `⌘T` (Ctrl+T) or the `+` button opens a start page that offers **Changes**, **Terminal** and **File preview**; plan documents, subagent streams, files opened from the tree and Changes all open as their own tabs. Tabs can be navigated with the arrow/Home/End keys and closed individually.
- **Integrated terminal:** A real PTY terminal (node-pty and xterm.js) runs in the workspace directory inside a workbench tab. Several terminals can be open at once (`Terminal 1`, `Terminal 2`, …), each keeps its state while you switch tabs, and URLs in the output are clickable.
- **Trace view:** Each conversation has **Conversation** and **Trace** tabs. Trace lays out every event in order — input, model requests, tool calls and results, errors and system state — on a timeline that can switch between equal-width events and true elapsed time, with a draggable scale and zoom. Selecting a node opens an inspector with the full content plus timing: time to first token, generation duration, throughput, tool duration, token counts and cache hits. A running turn shows live duration with a stop action; metrics that were not recorded in older sessions are labeled **Not recorded**. Trace snapshots are written locally under `~/.vela/traces`, and recording has no separate toggle.
- **Thinking summaries:** Settings → Appearance & shortcuts → Thinking summaries (off by default) automatically summarizes newly completed thinking with the model selected for the current chat, in the interface language. Summaries can appear after the Thinking label, replace it as a heading, or render in reply style; thinking from past turns can be summarized manually with one click. Summaries are cached locally by thinking content and are not added to the conversation context — each one is an extra model request.
- **Floating information layout:** Settings → Appearance adds an information-layout choice. Keep the translucent fixed sidebar, or float the environment card over the top-right of the conversation; in the floating layout the context ring below the composer opens a usage popover with the details.
- **Automatic chat titles:** A new conversation is named from its first message by the model selected for that chat, in the same language as your message. If the request fails, the first-message title is kept.
- **Branch to new chat:** Any reply offers **Branch to new chat**, which keeps that reply and everything before it and continues the work in a new conversation.
- **Sessions that survive a crash:** New conversations are written to disk as soon as they are created, so an empty conversation is no longer lost on a force-quit, and your message is saved the moment you send it instead of when the reply finishes.
- **Diff and file preview:** The Changes tab can toggle each file between **Diff** and **Preview**, with syntax-highlighted diffs, and the Files tab browses the workspace tree and opens files into their own preview tabs. Files that are too large or cannot be previewed now say so instead of failing silently.
- **Motion and polish:** Panels, popovers, tabs, list items and message surfaces enter and exit with short animations, and reduced-motion preferences are respected throughout.

## Improvements

- Subagent sessions are persisted with the conversation: an agent started in an earlier session stays in the roster and opens its own workbench tab after a restart. Reopened historical agent sessions show the task, a summary of tool steps and the final conclusion, and state explicitly that thinking and full tool output were not saved.
- Markdown that has finished streaming stays mounted, so settling content no longer re-renders or drops a text selection when a reply completes.
- The composer grows from its natural height with a short animation and re-measures line wrapping when the window or side panels resize.
- Tool runs keep their per-tool status and output while expanding and collapsing with the new motion language.
- New `docs/` pages document Plan mode for users and developers (`docs/plan-mode.md`, `docs/plan-mode-architecture.md`).

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.0-arm64.dmg` | macOS (Apple Silicon) |
| `Vela-0.1.0-arm64.zip` | macOS (Apple Silicon, application bundle) |

The macOS build is not notarized. If macOS blocks the app on first launch, use **Open Anyway** in System Settings → Privacy & Security, or run `xattr -cr /Applications/Vela.app` after moving it to Applications.

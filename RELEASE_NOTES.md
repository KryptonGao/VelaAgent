# Vela 0.1.0.1

This emergency update fixes thinking summaries, preferences and reply durations being lost after restarting Vela, and makes conversation archive changes more reliable. Users running 0.1.0 are encouraged to update.

## Fixes

- **Persistent thinking summaries and preferences:** Completed summaries, automatic-summary settings, summary styles, theme, language, information layout, tool display, hidden models, sidebar width and the default application for opening workspaces are now saved in `ui-state.json` in the Vela data directory. Existing localStorage values are migrated when they are available to the current application origin.
- **Reply durations survive restarts:** Turn start and completion times are recorded with the conversation and preserved when branching to a new chat. Conversations that finish in the background retain their actual completion time instead of including the time spent away from the chat.
- **More reliable archive changes:** Archiving and unarchiving immediately attempt to save the conversation index before returning. Failed saves remain pending for a later change or shutdown to retry, and a corrupted index is preserved instead of being overwritten with defaults.
- **Fewer stale-state overwrites:** Index saves merge fields that actually changed, reducing the risk of an older application instance overwriting archive status, titles or newly created conversations.
- **Persistent panel preferences:** Left and right panels, the floating information card and workspace groups remember their collapsed state.
- **No automatic re-summarization on restart:** Restoring historical timing data does not trigger another automatic thinking-summary request.

## Conversation improvements

- Search conversations and rename them manually. Manually chosen names are preserved when automatic title generation finishes.
- User messages show their send time and offer copy and edit actions. Editing and resending rewinds the current conversation and restores workspace files from the turn checkpoint, including changes that already existed before that turn.
- Open message images in a full-screen viewer with wheel zoom, drag-to-pan, double-click zoom and arrow-key navigation between images.
- See live elapsed time while a reply is running, with improved conversation scrollbars and related interface styling.
- Rewinding an edited message also removes abandoned later events from Trace.

## Upgrade notes and limitations

- Quit Vela and replace the application. Keep your existing `~/.vela` directory, or the directory specified by `VELA_USER_DATA`; no data-directory reset is required.
- Durations cannot be reconstructed for older turns that did not record timing information. The thinking-summary cache continues to retain up to 500 completed summaries.
- Unsent drafts, open file and terminal tabs, scroll positions and temporary detail-expansion states are not restored after a restart.
- File checkpoints are recorded starting with this version. Older messages without checkpoints cannot restore workspace files. Rewind is blocked when conflicting later file changes or concurrent conversation activity are detected. It does not restore Git staging or commits, ignored dependency and build directories, files outside the workspace, or external-service actions.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.0.1-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.0.1-arm64.zip` | macOS Apple Silicon application bundle |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

The macOS build is not notarized. If macOS blocks the app on first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Validation

- All 385 repository tests passed, with no failures or skipped tests.
- Workspace type checks and the production build passed.
- Release checks cover packaged application startup, bundle version metadata and package integrity. Persistence recovery was also verified across application restarts.

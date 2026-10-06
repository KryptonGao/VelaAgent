# Vela 1.0.1

Vela 1.0.1 adds the **Pull Request Inbox**: a left-sidebar entry that reads and searches the pull requests connected to your GitHub identity across repositories, without switching projects or checking out branches. Lists, overview, checks, reviews, activity, and remote diffs come together on one page, and plain comments can be posted as the current identity. GitHub access stays on the installed `gh` CLI. The sidebar shortcuts become configurable, remote diffs show real hunk line numbers, and the shared gh executor gains cancellation, output, and concurrency limits.

## New

- **Pull Request Inbox**: the sidebar's **Pull Request** shortcut opens a dedicated page that keeps the current conversation, workspace, and workbench resources, and reads without an open workspace. It uses the current valid `github.com` identity from `gh` and queries the four relations **authored**, **review requested**, **assigned**, and **mentioned**, showing their deduplicated union while keeping every relation on each item; targets are normalized as `host/owner/repo#number`.
  - **Lists and filters**: each relation pages independently at 100 items with its own error state, inherits the incomplete-results marker, and stops at GitHub's 1,000-result search cap. A successful refresh replaces that relation's items, while a failed one keeps its previous items and marks the results as partial. Filters cover relation, repository, six states (open and draft by default), and title / repository / number search within loaded items, with attention, repository, and update-time sorting. A screen shows at most 40 rows, and returning from a detail restores the previous filter and scroll position.
  - **Status enrichment**: visible items are enriched per repository with batched GraphQL variables (two batches of at most 20), covering the check state (unknown, none, passing, failing, pending, skipped, cancelled), the review decision, mergeability, and the attention reasons review requested, conflict, failing checks, and changes requested.
  - **Overview**: the detail page shows status, title, author, branches, the original Markdown body, the review decision, and check details. The body renders through react-markdown with GFM and raw HTML disabled; same-repository GitHub HTTPS links open, other links display their address, and images fall back to their alternative text. Check commands that exit with 1 or 8 but return valid JSON are treated as normal check results, while authentication and read failures stay failures.
  - **Activity**: commits, top-level comments, reviews, review threads, and in-thread comments page separately and merge chronologically into activity cards, with filtering, long-comment collapse and expand, and continue-loading. Historical reviews keep their commit, outdated status, and thread resolution state. This view is not the full GitHub timeline.
  - **Comments**: a plain comment can be posted at the bottom of the activity view as the current identity. Drafts survive activity refreshes, detail-tab switches, and leaving the page; a success clears the draft and shows the server comment deduplicated by node id, while a failure keeps the text and never retries automatically. A write re-probes the identity and re-reads the target first, sends the body as JSON over stdin to the GitHub Issues Comments endpoint, and cannot be cancelled as a read. One request id keeps a ten-minute in-process receipt, including unconfirmed failures, to prevent duplicate posts; the activity cache is invalidated after a write so a manual refresh can confirm the result.
  - **Remote diffs**: the changes tab lists files with renames, additions, and deletions, supports path search, and renders unified or split views; binary files and missing patches are kept with a GitHub entry. Large diffs page with real line numbers on both sides, and incomplete patch statistics or a truncated executor output are flagged. Reads verify the head and base SHAs before and after fetching, discard mixed versions and retry once, ask for a refresh when the starting version is stale, and only show the raw hunks in this release.
  - **Cache and refresh**: service TTLs are 60 seconds for lists and 30 seconds for details; the renderer keeps an in-memory session cache for the list, check / review status, visited details, activity pages, and file diffs, shows it immediately, and then revalidates. After ten seconds without mouse, keyboard, click, or scroll input, the page checks every 15 seconds and silently refreshes at most eight loaded, expired resources serially; hidden windows and foreground reads pause the work, and failures keep existing results. Caches are isolated by identity, query, complete target, and version; identical service requests merge, cancelling one caller does not cancel the others, and list generations stop older pages from overwriting a refresh. An identity change or lost authentication clears the previous identity's data, and the session cache holds at most 80 entries without writing to disk.
  - **IPC and links**: fixed IPC and preload methods validate the target, identity key, pagination, cursor, and request ids, so the renderer cannot pass arbitrary `gh` arguments. External navigation only accepts validated HTTPS GitHub URLs. Missing-`gh` and unauthenticated states show the command to run plus an entry to open a terminal, and Vela never starts an interactive login itself.
  - The first phase reads only: AI review and questions, submitting reviews, resolving threads, merging, closing / ready, and conflict fixes are hidden in the new center, while the existing workspace PR actions keep working. Enterprise hosts, the full timeline, extra hunk context, and separate writable PR workspaces are out of scope. See [the Pull Request inbox implementation record](docs/pr-inbox.md).
- **Sidebar shortcuts setting**: Settings gains a **Sidebar tabs** section that chooses which of Pull Requests, Scheduled Tasks, New chat, and Task Recipes appear in the sidebar's quick actions. The choice is stored with the other UI state (`vela.sidebarItems`) and defaults to all visible; the shortcut group disappears when every item is off.
- **Remote diff line numbers**: the unified diff parser tracks the old and new line numbers from every hunk header and advances them per row, and the diff views display both numbers. Coordinates stay correct across hunk gaps and when a changed line itself looks like a diff header.

## Improved

- **Shared gh executor**: `runGh` now supports cancellation and per-call environment overrides, serializes execution through a global queue capped at four concurrent reads, keeps stdout and stderr within a UTF-8-safe byte cap without splitting multi-byte characters, and reports the exit code, cancellation, and truncation to callers. The pager is disabled and color output is turned off. Existing workspace PR and Git flows use the same executor.
- **Documentation and design**: [the Pull Request center plan](docs/requirements/pull-requests.md), [the implementation record](docs/pr-inbox.md), the design guide, and the standalone HTML preview document the implemented first phase, its boundaries, and its verification; `docs/README.md` and `Design/README.md` link them.
- **Landing page**: `webPages/` contains a self-contained bilingual (Traditional Chinese / English) product page that reuses the app screenshots and the repository link.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, and task recipes continue to work.

The Pull Request Inbox needs the `gh` CLI installed and logged in for `github.com` (`gh auth login`); missing-`gh` and authentication errors are shown in the page with the command to run and an entry to open a terminal. Vela does not store GitHub tokens and does not run its own OAuth. The sidebar preference is stored in `ui-state.json`, and the inbox keeps its cache in memory only.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.1-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.1-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `1.0.1`. macOS bundle and download version: `1.0.1`.

## Validation

- All workspace type checks passed.
- All 126 test-center tasks passed in one headless run: 117 Node test files plus all 9 Electron browser UI checks.
- 1126 Node tests passed across 117 test files: 397 agent tests across 42 files, 574 desktop tests across 67 files, and 155 workspace tests across 8 files. New coverage includes the gh executor's arguments, stdin, exit codes, timeouts, cancellation, UTF-8 output cap, concurrency, and identity handling; inbox pagination, deduplication, the 1,000-result cap, failure retention, identity switching, stale responses, cross-repository targets, check semantics, activity pagination, file-version changes, and truncation; and the renderer cache, idle refresh, account isolation, activity model, IPC validation, comment writes, and diff line numbers.
- The production Electron Pull Request smoke passed with an isolated user directory and a fake `gh`: sidebar entry, filters, search, detail round-trip, Markdown without script execution, check exit code 8, activity and outdated reviews, file switching, renames, binary files, large diffs, invalid-target IPC rejection, account switching, offline caching, and filter retention across navigation.
- The production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

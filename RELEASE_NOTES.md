# Vela 0.1.1

This release adds a complete version control workspace: review and stage changes, commit, sync, browse history, create pull requests and manage tags and releases without leaving Vela. It also brings AI-assisted commit messages, PR descriptions and release notes, and smoother streaming in long conversations.

## Version control workspace

A new **Version Control** tab sits beside Conversation and Trace and always reflects the live Git state of the workspace used by the current chat. Local Git features work without a GitHub login or a configured model; GitHub operations run through the `gh` CLI. The right-side Changes panel shares the same state, so staging in one place updates the other.

### Reviewing and committing

- Change lists group staged and unstaged files, distinguish added, modified, deleted, renamed, untracked and conflicted entries, and support file/path filtering.
- Stage, unstage and discard whole files, selected files or everything. Discarding separates working-tree changes from untracked-file deletion.
- Partial staging works on individual hunks; patches are re-validated against the latest diff before applying, so stale hunks are rejected instead of staged incorrectly.
- Diff view switches between unified and side-by-side layouts and can ignore whitespace. Whitespace options affect display only, never what gets committed.
- The commit form shows the author identity, staged file count and diff statistics, plus two actions: **Commit** and **Commit & Push**, with their results reported separately. A failed push keeps the local commit and offers a retry that does not re-commit.
- Amend the latest commit, or undo the most recent unpushed commit while keeping its changes in the index or working tree. Pushed commits are flagged as needing a separate sync instead of being rewritten silently.
- Commit message drafts are stored per worktree and branch and restored after a restart.

### History and recovery

- The commit graph draws real parent relationships with branch lanes, HEAD/branch/remote/tag refs and merge edges. History loads in pages, preserves topological order, and supports searching titles, SHAs and authors across the selected range rather than only loaded rows.
- Commit details show full message, author and committer times, parents and refs, and per-file diffs against each parent. Root commits diff against the empty tree.
- History actions include creating a branch at a commit, reverting a commit (with an explicit parent choice for merges), cherry-picking, and fixup/squash for linear, unpushed history — each with a preview of its range and effect. Reflog browsing offers reference-preserving recovery options before any reset.
- Branch management covers search, creation, switching, rename and deletion, reporting merge status, worktree usage and unpushed commits before anything is removed. Branches or arbitrary commits can be compared with a fixed base → head direction and a visible merge base.

### Syncing

- Fetch reports the selected remote, progress and last successful time, and keeps previous data marked as stale on failure.
- Pull explicitly chooses fast-forward-only, merge or rebase. Merge and rebase conflicts enter the conflict workflow instead of leaving the repository in an unexplained state.
- Push shows the target remote and commits, sets up an upstream when publishing a branch for the first time, and distinguishes network, authentication, permission and protection failures.
- Force pushing requires an explicit preview: Vela re-reads the remote reference, lists the commits that would be overwritten, and refuses with `--force-with-lease` when the remote has changed since the preview. Remotes and upstream tracking can be managed, including fork workflows that keep the push remote and the PR base/head repositories distinct.

### Pull requests

- Create pull requests with the repository template, an option for draft or ready, and a base/head repository and branch preview that matches GitHub's comparison semantics.
- Edit an existing PR's title and description (AI suggestions remain candidates until explicitly applied), mark a draft ready, and manage reviewers, labels and linked issues.
- Review threads load from GitHub with review comments, approvals and change requests; outdated reviews are marked when the PR head has moved. Comments, approvals and thread resolution are available in the app.
- Merging requires the expected head SHA recorded at read time, shows mergeable state, review state, allowed merge methods and blocking rules, and refuses to merge when the head or repository rules changed. Closing a PR does not touch the local branch.

### Conflicts, stashes and worktrees

- The conflict editor loads all three sides (`base`, `ours`, `theirs`) and the current result, marks resolved files, and continues or aborts an in-progress merge, rebase or cherry-pick.
- Stashes can be named, include untracked files, be previewed, applied, popped or deleted; failed or conflicting applies keep the stash entry recoverable.
- Worktrees can be listed, created from a branch and removed, with checks for unsaved changes and cleanup for missing directories.
- Every Git and GitHub action is recorded in an operation log that can be filtered by target, type, result and time, and that links back to the related commit, pull request or recovery entry.

### Tags and releases

- List tags with their push state compared against the remote, and create or delete tags locally and remotely as separate choices.
- View existing releases and create new ones for a tag; release notes can be generated for a version range from the actual commits, merged pull requests and file statistics, then edited before publishing.

## AI writing assist

- Commit messages, PR titles and descriptions, and release notes can be generated, polished and regenerated with the model selected in the current chat, or the configured default when no chat is active.
- Suggestions are always editable drafts. They never create tags, releases, commits or pull requests on their own, and nothing is written back to GitHub until you confirm the action.

## Smoother conversations

- Streaming messages are published once per animation frame and only the streams that actually changed re-render, so a long reply no longer redraws the entire transcript on every token.
- Heavy views mount when first opened; hidden agent panes release their content and subscriptions; scroll and layout updates across the conversation are merged into a single frame task, keeping scrolling responsive while the Agent is running.
- Thinking blocks fade content at the scroll edges instead of clipping it, and turn summaries are cached per turn to avoid recomputation during streaming.
- Thinking-summary cache keys carry a new version so summaries produced under older prompts are not reused.

## Upgrade notes and limitations

- Quit Vela and replace the application. Keep your existing `~/.vela` directory, or the directory specified by `VELA_USER_DATA`; no data-directory reset is required.
- Local Git operations require the `git` command-line tool; GitHub features require a logged-in `gh`. Vela reports authentication and remote errors with recovery guidance rather than falling back to the website.
- Interactive rebase, submodules and Git LFS workflows, GitHub Enterprise hosts and a repository-level PR workbench are not part of this release. Vela shows the applicable state and points to manual or terminal handling for those cases.
- The commit graph, diffs and operation log load incrementally; very large repositories may still take a moment on first open.
- The macOS build is not notarized. If macOS blocks the app on first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.1-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.1-arm64.zip` | macOS Apple Silicon application bundle |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

The unpacked `Vela.app` is also available in the release archive.

## Validation

- All 510 repository tests passed, with no failures or skipped tests.
- Workspace type checks and the production build passed.
- Release checks cover packaged application startup, bundle version metadata and package integrity.

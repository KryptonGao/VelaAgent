# Vela 1.0.5

Vela 1.0.5 makes the **Pull Request Inbox feel instant** by refreshing and preloading pull requests in the background from app start, and gives the **Pull Request Inbox, Scheduled Tasks, and Task Recipes pages a cleaner redesign**.

## New

- **Pull Request Inbox opens from cache**: Vela now warms the default list and the status of the newest pull requests shortly after launch, whichever page you are on, so the first open no longer starts from a loading skeleton.
  - **Background preloading**: pull requests you have not opened yet get their details and first activity pages (commits, comments, reviews, threads) loaded a few at a time, those needing your attention first and then the newest, so clicking one renders immediately while staying within GitHub's rate budget.
  - **Always fresh**: refreshing no longer waits for you to stop typing; only a hidden window pauses it, and returning to the window refreshes right away. Pull requests you viewed refresh every minute; preloaded ones you have not opened refresh every five minutes.
  - The in-memory cache holds more entries, and whatever is on screen is kept even when background refreshes touch many other pull requests.
- **Clearer checks in pull request details**: failing, running, and cancelled checks are listed first with a summary count (for example "12 passed · 1 failed"), and passing checks are tucked into a collapsible group.
- **Relative update times**: the inbox shows "3 days ago" style times for recent updates and a short date for anything older than a week, in the selected language, with the exact time on hover.

## Improved

- **Pull Request Inbox layout**: a sliding indicator on the relationship tabs, a tidier header and filters, and refined list and detail styling.
- **Scheduled Tasks redesign**: two-column task cards with a status badge, a schedule / next run / latest run / workspace summary, a count of tasks, a friendlier empty state, and the task editor now opens as a modal dialog with focus on its first field.
- **Task Recipes redesign**: a search box with source chips showing counts (All, Built-in, Mine, Project, Team), a history toggle, icon buttons, recipe cards with mode and source badges and tags, and clearer error, warning, and success banners, including a dedicated message when project recipes cannot be read.
- **Styling polish**: small spacing fixes in the Usage page and the version-control panels.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. Existing sessions, model accounts, workspaces, browser cookies and site storage, MCP servers, scheduled tasks, task recipes, the Pull Request Inbox, checkpoints, and logs continue to work.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-1.0.5-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-1.0.5-arm64.zip` | macOS Apple Silicon application bundle (`.app`) |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `1.0.5`. macOS bundle and download version: `1.0.5`.

## Validation

- Type checks and unit tests for all workspace packages (`pnpm test`) passed, including new tests for cache eviction of on-screen entries, background warming with failure backoff, and attention-first preloading with the slower refresh cadence.
- The production DMG and ZIP builds, packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

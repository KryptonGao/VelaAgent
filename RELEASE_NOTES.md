# Vela 0.1.1.1 (0.1.1+1)

Emergency hotfix for thinking summaries disappearing after upgrading to 0.1.1. The previous release changed the summary storage key without importing existing records. Saved summaries remained on disk, but the app stopped displaying them.

## Fixed

- Recover saved thinking summaries from both 0.1.0.x and 0.1.1 on first launch. When both versions saved a summary for the same passage, keep the newer summary.
- Save summaries under a stable storage key so future prompt changes do not hide previously saved content.
- Keep the original records during migration. If saving the migration fails, display the recovered summaries for the current session and retry on the next launch.
- Restore existing summaries without sending model requests to regenerate historical content.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); recovery happens automatically for summaries still present in the saved data. No data reset is needed.

The existing 500-summary storage limit remains in place. This hotfix cannot recover summaries that were already removed by that limit or by deleting application data.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.1.1-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.1.1-arm64.zip` | macOS Apple Silicon application bundle |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `0.1.1+1`. macOS bundle and download version: `0.1.1.1`.

## Validation

- All 46 targeted thinking-summary and persistence tests passed, including upgrade recovery, newer-record precedence, restart persistence, malformed legacy data, and migration write failures.
- Desktop and agent type checks passed.
- Production packaging, packaged application startup, macOS bundle metadata, and archive integrity were checked before publication.

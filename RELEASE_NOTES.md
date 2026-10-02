# Vela 0.1.1.2 (0.1.1+2)

Emergency hotfix for missing horizontal spacing in the floating environment layout. At affected window sizes, the conversation column filled the entire space between the sidebar and environment card, leaving messages, change summaries, and the composer pressed against their boundaries.

## Fixed

- Reserve equal horizontal gutters when moving the conversation column around the floating environment card: 24px in the standard layout and 16px in the compact layout.
- Include both gutters in the column width calculation so shrinking the column no longer removes its spacing. The existing limit on card-driven narrowing remains; gutter space is reserved separately.
- Apply the same column placement to messages, file-change summaries, and the composer.
- Account for scrollbar width when positioning the composer, keeping its left and right edges aligned with the conversation column.
- Preserve fractional layout measurements so rounding cannot reduce the minimum gutter.

## Documentation

- Refresh the README around compact tool output, SubAgents, and the execution trace interface.
- Add three screenshots rendered with real Vela components and clearly labeled example data.
- Include the preview fixtures and screenshot reproduction instructions.

## Upgrade

Quit Vela completely, replace the application with this version, and reopen it. Keep your existing `~/.vela` directory (or the directory specified by `VELA_USER_DATA`); no data reset is needed. This release includes the thinking-summary recovery fix from 0.1.1.1.

The macOS build is not notarized. If macOS blocks first launch, use **Open Anyway** in System Settings → Privacy & Security.

## Download

| File | Platform |
| --- | --- |
| `Vela-0.1.1.2-arm64.dmg` | macOS Apple Silicon installer |
| `Vela-0.1.1.2-arm64.zip` | macOS Apple Silicon application bundle |
| `SHA256SUMS.txt` | SHA-256 checksums for both packages |

Package version: `0.1.1+2`. macOS bundle and download version: `0.1.1.2`.

## Validation

- All 23 targeted tests passed: nine conversation-layout cases plus scrolling, message entry, and turn-change summaries.
- A renderer preview confirms 24px gaps on both sides of messages and the composer at the affected desktop width.
- All workspace type checks passed, and the README preview fixtures passed an additional type check.
- Production DMG and ZIP builds, isolated packaged-app startup, bundle and packaged version metadata, DMG mounting, archive integrity, and SHA-256 checksums were verified.

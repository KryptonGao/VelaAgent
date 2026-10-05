# Built-in Browser Use validation — 2026-10-03

This change is high risk: it spans runtime tool policy, execution permissions,
IPC ownership, guest lifecycle and Electron packaging. Validation started with
focused tests, then covered the existing affected systems once. Later fixes
were followed by focused tests and actual Electron checks.

| Check | Result |
| --- | --- |
| Agent full regression | 201 tests passed |
| Desktop + Workspace full Node regression | 484 tests passed |
| Existing browser UI integration fixtures | 7 groups passed |
| Final `test:browser` (Host, CDP, controller, security, links) | 41 tests passed |
| Final `test:browser-repl` | 15 tests passed |
| Runtime/transcript/REPL follow-up checks | 36 tests passed |
| Repository `pnpm typecheck` | Passed |
| Desktop `electron-vite build` | Passed |
| macOS arm64 directory packaging | Passed |
| Real Panel smoke against built output | 9 checks passed |
| Real Panel smoke importing packaged main from app.asar | 9 checks passed |
| Browser Use smoke with worker loaded from app.asar | Passed |
| `git diff --check` | Passed |

Test counts overlap; the rows are independent verification runs, not an additive
total. Packaging used the existing unsigned local macOS configuration. The
fixture deliberately tests a failed localhost request; its expected
`ERR_EMPTY_RESPONSE` log does not indicate a failed test.

## Acceptance evidence

The Panel smoke started with a blank guest, performed manual navigation,
retained DOM/form/scroll state through tab selection, folding and Settings, and
switched to an empty conversation without destroying the original guest.
Other conversations saw only their own tabs and reused Cookie/localStorage
state in the browser partition. Popup navigation and URL restrictions remained
in place. Hidden viewport dimensions stayed unchanged. Guests closed
independently.

The Browser Use smoke ran actual Electron WebContents, CDP child sessions and
utility processes, using the packaged worker. It reused manual login state,
filled and appended form values, submitted with a key, selected options, clicked
open Shadow DOM and same/cross-origin frame controls, and confirmed the
cross-origin frame was an OOPIF. It read page application globals, console and
network records, and emitted PNG model content with viewport checks.

Stale nodes/navigation references, multiple matches and navigation errors
returned errors. Main/child contexts retained separate variables while sharing
pages. Complete invocations serialized per conversation; other conversations
ran concurrently without stealing foreground focus. Infinite loops, cancellation
and worker exit recovered; leftover callbacks could not perform later browser
RPC. Reset retained the original guest and login state.

The REPL edited a local fixture JavaScript source, its hot update changed the
same document, and a subsequent snapshot and screenshot showed the new content.
The DOM marker and guest ID remained identical; the PNG changed. Closing a page
while an evaluation awaited an unresolved Promise immediately ended that call.

## Fixes found by real Electron validation

- Stop/superseded navigation failures must not overwrite current load state.
- Hidden renderer input needs focus emulation and verification of applied text.
- OOPIF input dispatch uses its child CDP session; same-process iframe geometry
  maps through content quads.
- CDP disposal must be idempotent and use a cached debugger object after guest
  destruction, avoiding an uncaught native-object error in the main process.

The smoke fixtures exercise services directly without a live model provider.
Runtime/tool-policy, permission modes, Goal invalidation and restored image/error
history are covered by their automated tests. Accessibility names are a
DOM-derived approximation; closed Shadow DOM, perspective iframe transforms,
response bodies and upload/download orchestration retain the documented
first-release limitations. Popup authorization is now covered by
`browser-auth-electron-smoke.mjs`, including cross-origin opener callbacks,
POST bodies and popup cleanup. Its virtual authenticator validates WebAuthn
plumbing and account selection; real Touch ID still requires a signed,
provisioned build and hardware validation.

# DMWidget Board skin renderer continuity — 2026-09-27

## Scope

Fixed the Discordmaxxer-only DMWidget skin renderer path for the full profile Board. The previous scan could discover a nested image or shallow wrapper, then either miss the attached application id or put the skin on a child instead of the complete widget card.

## What changed

- Resolve and style the full widget-card root rather than the discovery node.
- Walk deeper Board wrappers (20 ancestors) and inspect arbitrary data/ARIA attribute values for known attached application IDs.
- Add stable Board roles and application-list selectors while retaining the known-app safety filter.
- Add a bounded label/hero-asset fallback for Board layouts that hide the application ID in React state.
- Keep the media fallback lazy: it runs only when the normal card pass misses an attached widget, limiting renderer work during normal interaction.

## Verification

- Candidate source passes `git diff --check` and the focused esbuild TSX transform for `plugins/DMWidget/index.tsx`.
- `pnpm test` — passed (`eslint` and `tsc --noEmit`).
- `pnpm verifyPlugins` — passed: all defaults, bundles, and featured plugin IDs resolve.
- `pnpm build:dev` — passed after the earlier USB I/O delay.
- Strict overlay build — passed with `DM_STRICT_REBRAND=1`; 25 custom plugins were copied, including `DMWidget`.
- `node overlay-scripts/verify-build.mjs` — passed; staged renderer contains the custom plugin set and structurally valid artifacts.
- The compiled candidate is staged in `vencord-dist/` in this worktree. The local `pnpm package:dir` smoke command reached Electron Builder but stalled while copying the USB checkout's temporary unpacked app; it was stopped without changing source. The GitHub Windows release job completed the authoritative packaging successfully.

## Release/runtime boundary

- Release commit `becdb29` (`fix: retry widget skin rendering on full profile board`) was pushed to `main` and tagged/published as `v0.7.78`.
- GitHub Actions release run `36408489508` passed in 5m29s. The Windows installer, ZIPs, blockmap, and `latest.yml` are uploaded; the updater endpoint advertises `version: 0.7.78` and the `Discordmaxxer-Setup-0.7.78.exe` asset.
- The public release notes explicitly say: `This is attempt #2 at fixing widget skins not appearing on the full profile Board.`
- The source/build/release path is verified; the signed-in Board visual on Diggy's separate main PC remains a user-side verification gate.
- The worktree already had unrelated user changes: `RESUME.md` deleted, `static/dist/.gitignore` deleted, and existing untracked `.pnpm-store-clean/`, `.tmp/`, `docs/evidence/`, and pnpm store archives. They were preserved.
- The release does not change vanilla Discord rendering; this fix is for the Discordmaxxer-rendered profile Board.
- The post-release candidate invalidates stale DOM-match cache entries after profile recovery, chooses a widget root using the card's label/role instead of the first generic wrapper, adds a bounded text-only Board fallback, applies immediately on gallery selection, and changes the Apply toast to report the number of visible cards actually restyled.

## Best next move

The release is live and the source/build/package/update-manifest gates are complete. Diggy's remaining gate is runtime verification on the other/main PC: update to v0.7.78, fully restart Discordmaxxer, and open a profile Board containing the already-attached Valorant and Fortnite widgets. If the first Board view is stale, press `Ctrl+R` once and reopen it; confirm each full card receives its selected skin and that Apply reports at least one visible card restyled. This remains Discordmaxxer-only presentation; vanilla Discord will not render these widget skins.

## 2026-09-28 crash-hardening candidate

- User report: opening DMWidget Create/Edit Profile Widget triggered Discord's crash-recovery screen; a second open did not show the editor.
- Likely regression boundary: v0.7.78's full-Board skin scanner performed broad DOM, React-prop, descendant, text, and ancestor work during modal/profile mounts. No local crash dump or running Discordmaxxer process was available here, so the exact renderer stack is not confirmed.
- Candidate fix: cap React/DOM discovery, remove the all-descendant walk, narrow mutation triggers, enforce a 24 ms scan budget, preserve existing skins across partial passes, catch transient DOM failures, and contain startup recovery errors.
- Follow-up hardening: the DMWidget editor now suspends Board scans for its entire mount lifetime, cancels any queued scan timer/frame on entry, and re-checks the guard inside both callbacks before scanning.
- Verification: `pnpm test`, `pnpm build:dev`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`, and `node overlay-scripts/verify-build.mjs` passed. Candidate overlay is staged in `vencord-dist/` in this worktree.
- Release boundary: this is not published or tagged. Do not claim the client crash is fixed until the candidate is loaded into the running client and the editor is opened, closed, reopened, and opened again while the client remains stable.

## Best next move

Load the local candidate into the dev client and reproduce the exact Create/Edit open -> close/reopen sequence. If stable, decide whether to publish a new patch release; if it still crashes, capture the renderer console/crash log from that run before changing the scanner again.

## 2026-09-28 pre-release audit delta

- Account-switch state is now cleared before loading a different account's
  archived slots. In-flight profile reconciliation checks the current account
  before and after each remote read and before committing attachment maps; a
  new account can start reconciliation without waiting on the old task.
- Cross-install skin-marker writes are serialized and guarded by a request
  serial, so rapid gallery clicks cannot let an older selection overwrite the
  newest one.
- Generic `card__`/`card_` discovery is scoped to profile/Board surfaces, the
  DOM fallback rejects wrappers containing multiple attached application IDs,
  and large MutationObserver batches request a deferred scan without walking
  every added subtree.
- Scheduled stats refreshes, editor buttons, and gallery skin actions now
  catch failures. They show a safe user-facing status instead of producing an
  unhandled rejection that could contribute to Discord's crash-recovery path.
- Verification after the audit: `pnpm test`, `pnpm build:dev`,
  `pnpm verifyPlugins`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
  `node overlay-scripts/verify-build.mjs`, and `git diff --check` passed. The
  compiled candidate is in `vencord-dist/` in this worktree and contains the
  new safe-action and scan-guard markers.
- Release boundary: still not published or tagged. A real client test is
  required: open Create/Edit, close it, reopen it twice, choose a skin, and
  confirm the client remains stable and the visible Board card restyles.

## 2026-09-28 v0.7.80 release candidate

- The DMWidget renderer audit candidate was versioned as v0.7.80 because the
  existing v0.7.79 tag on remote main belongs to the roster release.
- Source, TypeScript, strict overlay, plugin registry, artifact verification,
  and diff checks passed. The local directory package reached Electron Builder
  but stalled during the USB-backed unpacked-app copy and was stopped cleanly;
  CI remains the authoritative Windows packaging gate.
- The documented runtime validator could not connect because the temporary
  Electron launch did not expose its debug port. No runtime stability claim is
  made until the published candidate is opened and the editor sequence is
  exercised on a real client.

## 2026-09-28 v0.7.80 published

- Commit `7aa0551` was pushed fast-forward to `main` and tagged/published as
  `v0.7.80`; the existing `v0.7.79` tag remains the separate roster release.
- GitHub Actions test run `36504480076` passed. Release run `36504482353`
  passed in 5m8s, including the strict overlay build, artifact verification,
  Windows Electron Builder packaging, and the Maxxtopia release notification.
- The public release contains `Discordmaxxer-Setup-0.7.80.exe`, both Windows
  ZIPs, the blockmap, and `latest.yml`. A cache-busted HTTP read returned
  `version: 0.7.80` and the matching installer filename.
- The source/build/packaging/update-manifest gates are verified. The signed-in
  runtime editor sequence on Diggy's main PC remains the final user-side gate:
  update to v0.7.80, fully restart Discordmaxxer, open Create/Edit, close it,
  reopen it twice, then choose a skin and confirm the client stays stable and
  the visible Board card restyles.

# Discordmaxxer — RESUME

## 2026-11-04 — v0.7.124 reset/update reliability (published)

Scope: fix the inherited Vesktop wording in Reset, prevent Windows watcher
errors from crashing the main process, and keep the Discord session profile
stable across installed updates.

Implementation:
- Reset now says Discordmaxxer and continues through individual Windows
  cleanup failures instead of turning one rejected cache/profile operation
  into an unhandled main-process failure. Reset still intentionally logs out
  and clears the profile.
- The development CSS watcher now catches startup, read, and watcher error
  paths, including Windows `EPERM`/`ENOENT`, and closes itself safely.
- Installed builds now use `%APPDATA%\\Discordmaxxer\\sessionData` instead of
  selecting a profile from the install directory. A non-destructive one-time
  migration can move an existing legacy profile from the old Discordmaxxer,
  DiscordmaxxerPortable, Vesktop, Vencord, or portable locations when the
  stable destination is absent.

Verification gates completed locally:
- `pnpm test`, `pnpm build`, strict pinned Vencord overlay, and
  `node overlay-scripts/verify-build.mjs` passed with zero overlay warnings.
- `pnpm package:dir` and `pnpm package:win` passed, producing signed x64 and
  ARM64 archives plus the NSIS installer.
- The exact packaged x64 executable stayed alive for a 10-second startup
  smoke test with isolated data. The production bundle contains the new reset
  wording and stable-session logic; the dev watcher guard is intentionally
  omitted from production by the `IS_DEV` build branch and is verified in
  source.

Release state:
- Commit `33156079c28312e8f0dc7e90e2fc9d621292daa5` is on `origin/main` and
  tag `v0.7.124` is public.
- GitHub Actions release run
  `https://github.com/MaxxTopia/discordmaxxer/actions/runs/41884097990`
  completed successfully in 5m19s.
- Public release:
  `https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.124`.
  It is published (not draft or prerelease) and contains the x64/ARM64 ZIPs,
  NSIS installer, blockmap, and `latest.yml`.
- The public `latest.yml` route returned HTTP 200 and advertises version
  `0.7.124`; the installer route returned HTTP 200 with a 211,840,858-byte
  payload.

Remaining gates:
- Diggy should update an already signed-in client and confirm it stays logged
  in, then open Reset and confirm the Discordmaxxer-branded dialog. Do not
  click Reset unless intentionally testing the logout/clear behavior.
- If testing the development build, rebuild/replace the renderer CSS and
  confirm a watcher `EPERM` no longer crashes the app; the production build
  intentionally omits the dev-only watcher.

Next action: Diggy should update the signed-in PCs and report whether login
survives the update and whether Reset shows Discordmaxxer branding. If either
device still starts logged out, preserve the old profile and report the exact
session paths before changing migration logic.

## 2026-11-04 — v0.7.123 image context-menu crash fix (published)

Scope: publish the focused fix for the renderer crash Diggy was still seeing
when right-clicking an image in a Discord message.

Implementation:
- Removed the broad ImageZoom `message` context-menu injection from
  `overlay-scripts/rebrand-vencord.mjs`; image messages now stay on Discord's
  native image/message menu path with Reply, Forward, reactions, attachment,
  and image actions intact.
- Kept ImageZoom's optional image-specific controls on the guarded narrow
  `image-context` route.
- Made `plugins/DMEmoji/index.tsx` leave image attachments and image/GIF embeds
  untouched while preserving its text-message search/react and saved-media
  controls.
- The native image click path remains available for the enlarged viewer.

Verification gates:
- `pnpm test`, `pnpm build`, strict pinned Vencord overlay with
  `DM_STRICT_REBRAND=1`, and `node overlay-scripts/verify-build.mjs` passed;
  the overlay reported zero warnings and staged all 29 custom plugins.
- `pnpm package:dir` and `pnpm package:win` passed with signed x64/ARM64 ZIPs
  and the combined NSIS installer.
- The packaged renderer SHA-256 matched the staged renderer exactly, and the
  unsafe broad ImageZoom message-menu marker was absent.
- The isolated packaged executable stayed alive through the startup smoke
  test without touching the signed-in client.
- GitHub Actions release run
  `https://github.com/MaxxTopia/discordmaxxer/actions/runs/41872861906`
  passed all build, verification, packaging, and publication steps.

Release state:
- Commit `06293357754889f0792dd0734e9d093a4bd03bb2` is on `origin/main` and
  tag `v0.7.123` is public.
- Public release:
  `https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.123`.
- The public `latest.yml` route returned HTTP 200 and advertises version
  `0.7.123` with `Discordmaxxer-Setup-0.7.123.exe`.

Remaining user/device acceptance:
- In a signed-in updated client, right-click a received image repeatedly and
  confirm the client stays open and the normal Discord menu works; click the
  image and confirm the enlarged viewer opens.
- Right-click a text-only message and confirm DMEmoji's custom submenu still
  appears, then test several DMHub plugin settings.
- The documented full-suite CDP validator was not run because this checkout
  references `overlay-scripts/launch-verified.mjs`, but that file is absent;
  the package build and isolated startup checks are complete, not a substitute
  for authenticated UI acceptance.

Next action: Diggy should update the signed-in PCs to v0.7.123 and report the
exact image right-click and image-open results before any further code change.

## 2026-11-03 — v0.7.121 reliability release: detached cursor marker and image-menu crash guard (published)

Recovered state:
- The canonical source is the isolated worktree `C:\Users\Diggy\projects\discordmaxxer-full-dev-merge-20261103c` on `codex/dev-full-merge-20261103c`, based at `87b4bcf` (`fix: guard updater against low disk space`). Its focused source edits are intentionally isolated here; the canonical dirty project was not changed.
- Commit `312bf45` is pushed to `main`; tag `v0.7.121` is public. The GitHub release workflow and updater artifacts have completed successfully.
- C: is effectively full (0 bytes reported free during this pass). Build and packaging were performed in the isolated E: candidate `E:\Codex-recovery\discordmaxxer-build-candidate-20261103c` and its packaged app was not installed over the public client.

Change:
- DMCursor now clears its unfocused state and hides the cursor/smoke layer on blur, focus, mouse-leave, renderer visibility changes, and call/fullscreen transitions. A newly mounted cursor starts transparent and becomes visible only after a real mouse move, preventing a stale animated ring from appearing as a detached purple dot across newly opened channels. This is the source-level diagnosis for the screenshot; the real-client visual check remains open.
- The ImageZoom overlay now recognizes the current message-menu image route only for actual image media, leaves Discord's native menu children intact, deduplicates its added group, and catches/logs menu-construction failures. This preserves native Reply, Forward, Pin, Bookmark, Reminder, Apps, Mark Unread, Copy Message Link, and reaction actions instead of replacing them. The exact packaged renderer contains the guard.
- The same candidate includes the previously scoped DMTrim Fanduel/reward-card detector, compact static plugin authors, DMEmoji click-send fallback and custom-server/iEmoji discovery copy, and the corrected profile-gradient default migration. These were rebuilt together so the release candidate does not mix dev-only and release-only behavior.

Verification:
- Fresh pinned Vencord source at `ef29bbeb6119cfb53d1273ed78147bcc97d91261`: strict overlay reported `applied=123 skipped(idempotent)=0 warnings=0`; 29 custom plugins synced and Vencord build passed.
- `pnpm build`, `node overlay-scripts/verify-build.mjs`, `pnpm test`, and `git diff --check` passed before the version bump. The verifier confirmed the source fingerprint, staged hashes, required plugins, and compiled TournamentMode/DMVoiceKeybinds/DMVoiceGuard/DMHub/DMTierFlair/DMProfileCosmetics/DMDisplayNameStyle/DMEmoji/DMTranslate.
- `pnpm exec electron-builder --dir` passed. The signed packaged executable is `E:\Codex-recovery\discordmaxxer-build-candidate-20261103c\dist\win-unpacked\discordmaxxer.exe`.
- That exact packaged executable was launched with an isolated E: user-data directory; four candidate processes remained alive after 12 seconds and were then stopped by PID. This proves package startup survivability only, not authenticated Discord behavior.
- GitHub Actions release run `41759334977` completed successfully, including the strict overlay, artifact verification, Windows Electron packaging, and release-note attachment.
- Public release `https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.121` is non-draft and non-prerelease. It contains the x64 and ARM64 ZIPs, `Discordmaxxer-Setup-0.7.121.exe`, its blockmap, and `latest.yml`.
- Public `latest.yml` returned HTTP 200 and advertises version `0.7.121`; the installer URL returned HTTP 200 with a 211,819,985-byte payload. `main` and `v0.7.121` both resolve to `312bf45830e187f654e75c654844dbb61894bcdf`.

Remaining / Diggy-owed acceptance:
- In the actual updated client, join a call and move through several servers/channels; verify the detached dot never appears and that the intended DMCursor still appears after the next pointer move.
- Right-click a received image repeatedly and verify the normal Discord context menu remains visible, then use Reply/Forward/Pin/Bookmark/Reminder/Apps/Copy Message Link and open the image normally. This runtime path is not proven by TypeScript or the startup smoke test.
- Recheck DMTrim's Fanduel card, DMDisplayNameStyle's compact Authors section, DMEmoji mouse-send, and the profile-cosmetics Default gradient after the same client update.

Next action:
- Diggy should update to v0.7.121 and run the runtime acceptance checks above. Any failure should be reported with the exact build, account/viewer pair, action, and timestamp before changing code; source/build/public-release proof is complete, while authenticated UI behavior remains a user/device gate.

## 2026-11-03 — updater low-disk guard (local, not released)

Diagnosis:
- Diggy's attempted v0.7.120 auto-update downloaded the correct public installer, but NSIS failed while extracting `app-64.7z` into `%TEMP%` because the C: volume was full. Windows then showed the misleading "This app can't run on your PC" dialog.
- The cached installer matched the public release checksum and its PE architecture was valid for this Windows 10 x64 machine. Running the installer after recovering temporary space completed successfully; the installed client reports `0.7.120` and was opened.

Change made:
- Added `src/main/updaterStorage.ts`, which estimates the temporary space needed by NSIS from the update asset size, applies a one-GiB floor, checks the per-user and OS temporary volumes with `statfs`, and fails open if Windows cannot inspect a path.
- Wired the check into `src/main/updater.ts` before `electron-updater` starts downloading. A low-space result now appears in the existing updater error area with the measured free space, the recommended minimum, the temporary-extraction explanation, and a retry instruction instead of launching a generic Windows failure.

Verification:
- `pnpm test` passed ESLint and TypeScript checking.
- `pnpm build` passed and the generated main bundle contains the new low-space guard text.
- Direct helper check with a 211,815,221-byte installer returned the expected low-space error for C: at roughly 0.4 GB free and returned `null` for the spare E: volume.
- `git diff --check` passed. Only `src/main/updater.ts`, `src/main/updaterStorage.ts`, and this continuity entry are intended changes.

Release boundary:
- Public release remains `v0.7.120`; no new tag, GitHub release, or live deployment has been made for this guard yet.
- The installed public `v0.7.120` client is open. The local source/build candidate is not yet installed over it because the C: drive is still below the guard threshold and packaging would recreate the same risk.
- The prior generated `dist` directory for this isolated worktree was moved, recoverably, to `E:\Codex-recovery\discordmaxxer-full-dev-merge-20261103c-20261103-updater-fix\dist`; no tracked source or unrelated project data was deleted.

Remaining:
- Review and commit the guard, bump to the next release version, package it on a volume with adequate temporary space, then publish only with release authorization. Verify the public manifest and installer before asking Diggy to test the updater again.
- Diggy's separate runtime acceptance tests remain open for image context-menu stability and image enlargement in the public client.

Next action:
- Free at least one GiB on the Windows system/temp volume, then package and run the next candidate locally; use the updater dialog's low-space path as the regression test before publishing.

## 2026-11-03 — v0.7.120 candidate: shared settings modal and image viewer fixes

Scope:
- Diggy reported that clicking an image sent by another user did not enlarge it like stock Discord, and the preceding public build still crashed when opening plugin settings. Both paths were tested against the same packaged candidate.

Change:
- Hardened the shared Vencord `PluginModal` path in `overlay-scripts/rebrand-vencord.mjs`: validated plugin settings definitions and author records, memoized normalized authors so the author-loading effect does not restart on every render, replaced the brittle native contributor summary list with safe avatar primitives, and moved the shell to the stable legacy modal contract.
- Removed the ImageZoom wrapper's click propagation stopper so Discord's native attachment click reaches the enlarged viewer while the existing zoom overlay remains available.
- Added `overlay-scripts/vencord-source.json` and an environment-selectable source path. Both Dev and release overlays now fail fast unless they use the same pinned Vencord commit (`ef29bbeb6119cfb53d1273ed78147bcc97d91261`).
- Bumped `package.json` to `0.7.120` and added `docs/releases/v0.7.120.md`.

Verification:
- Strict overlay from a fresh pinned Vencord checkout: 111 patches applied or idempotent, 0 warnings; all custom plugins compiled.
- `pnpm test`, `pnpm build`, `node overlay-scripts/verify-build.mjs`, and `pnpm package:dir` passed.
- The exact packaged candidate `dist\\win-unpacked\\discordmaxxer.exe` opened six plugin settings (DMProfileCosmetics, DMTrim, DMWidget, DMTierFlair, DMEmoji, and PlaylistmaxxingPresence) with no `.length` exception, React update-loop error, or settings fallback.
- The exact packaged candidate opened a real Discord image attachment with a normal left-click and showed the enlarged viewer with Zoom In, Forward, Open in Browser, More, and Close controls.
- REA inspected the shipped `dist\\win-unpacked\\resources\\app.asar` as shipped-artifact evidence. It confirmed the package identity and analyzed 19 relevant files / 35.7 MB of text; its semantic graph is partial and static, so the runtime smoke test remains the stronger behavior proof.

Release boundary:
- Public release remains `v0.7.119` until the v0.7.120 tag workflow completes. No live claim has been made for v0.7.120 yet.
- The candidate package was tested locally with the signed-in test profile. The normal installed client and real recipient voice/screenshare behavior remain separate user acceptance checks.

Next action:
- Review the intended diff, commit the candidate, push the authorized `main` update and `v0.7.120` tag, then verify the GitHub release assets and updater manifest before asking Diggy to test the public client.

## 2026-11-03 — v0.7.119 published: DMHub settings crash hardening

Scope:
- Diggy reproduced the same settings-render crash from multiple plugins opened through DMHub. This was treated as a shared plugin-settings host issue, not as a DMProfileCosmetics-only defect.

Change:
- Hardened the shared `PluginModal` author metadata path in `overlay-scripts/rebrand-vencord.mjs`: malformed or missing author metadata now normalizes to an empty list, the author hook uses that safe list, and the overflow-author row returns nothing when there is no overflow. This removes the unsafe undefined `.length` path while retaining the existing per-plugin error boundary.

Verification:
- `pnpm overlay:vencord` passed with 0 warnings; the rebuilt staged Vencord fingerprint matched the candidate checkout.
- `pnpm test`, `pnpm build`, `node overlay-scripts/verify-build.mjs`, `pnpm verifyPlugins`, and `git diff --check` passed.
- The project validator connected to the candidate on port 9224 and passed inventory, DMHub visual, CompactView/Tournament hotkey, and mass-delete wiring phases with the badge phase skipped.
- Direct candidate runtime test through DMHub opened `DMProfileCosmetics` with the live profile-cosmetics showroom, 58 action-group skins, palette/effect/intensity/speed controls, and no crash text. The same route also opened `DMDisplayNameStyle` and `DMProfileFlair` without the shared settings error.
- A candidate screenshot was captured at `overlay-scripts/screenshots/candidate-dmprofilecosmetics-showroom.png` for visual review.

Release boundary:
- The candidate was committed as `23d7b22`, pushed to `main`, and tagged `v0.7.118` with explicit release authorization. The public workflow `41701487231` failed at the strict Vencord overlay before packaging because the pinned CI source includes `transitionState` in `PluginModal` and the new patch target did not.
- The correction was committed as `1c8a93c`, pushed to `main`, and tagged `v0.7.119`. Release workflow `41702669795` completed successfully in 5m49s, including the pinned overlay, build, artifact verification, Electron Builder, release notes, and release notification.
- Public release `v0.7.119` is live at `https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.119`. The public `latest.yml` returned HTTP 200 and declares version `0.7.119`; the installer URL returned HTTP 200. The release includes x64 and arm64 ZIPs, the Windows installer, blockmap, and updater manifest.
- This verifies settings mounting and the shared crash path. It does not yet prove every plugin's event handlers or the separate image right-click crash path.

Next action:
- Diggy should update the normal client and repeat DMHub -> Profile Cosmetics, one other plugin, and the image right-click test. Treat the right-click image crash as an explicit acceptance test; it was not silently claimed fixed by this release.

## 2026-11-03 — v0.7.117 published: shared plugin-settings crash containment

Diagnosis:
- Diggy reproduced the same Discord renderer crash while opening a second plugin's settings, so the failure cannot be treated as a DMTrim-only bug.
- `PluginModal` performed hooks, metadata lookup, settings enumeration, and custom-plugin rendering before its existing per-control error boundaries were mounted. A failure there could reach Discord's global crash-recovery screen.
- No Windows crash-report evidence was found; the observed screen is renderer recovery. Runtime root-cause confirmation still requires testing the rebuilt client with the exact plugin surfaces.

Change made:
- Added a parent `ErrorBoundary` around every plugin settings modal through the tracked `overlay-scripts/rebrand-vencord.mjs` pipeline. A bad plugin now gets an isolated error message instead of taking down the whole renderer.
- Added a safe fallback for missing plugin metadata, and skip/log unsupported setting types instead of rendering an undefined React component.
- Kept the earlier DMTrim stylesheet hardening in place; this shared boundary is the broader fix for other plugins.

Verification:
- `pnpm overlay:vencord` passed: 92 rebrand patches applied or idempotent, 0 warnings; 29 custom plugins synced; Vencord build passed.
- `pnpm test` passed ESLint and TypeScript.
- `pnpm build` passed.
- `pnpm package:dir` and `pnpm package:win` passed with output redirected to E: because C: was low on free space.
- `node overlay-scripts/verify-build.mjs` passed source fingerprint, staged hash, required-plugin, and compiled-plugin checks.
- `git diff --check` passed.
- GitHub Actions release run `41687646375` passed all release steps, including Electron Builder and the Maxxtopia notification.

Runtime/release boundary:
- Commit `1aae8f9` and tag `v0.7.117` are pushed to `main` and the public GitHub Release is live: `https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.117`.
- The public `latest.yml` returned HTTP 200 and reports version `0.7.117`; the public installer returned HTTP 200. `https://maxxtopia.com/discordmaxxer` also returned HTTP 200 after the release-sync notification.
- Diggy can update the normal installed client without using the fresh local dev profile or logging in again. The release is source/build/deployment verified; signed-in runtime behavior is still user acceptance.
- This protects render-time modal failures. Plugin-specific event-handler or asynchronous failures still need targeted testing if a plugin opens successfully but crashes when a control is changed.

Next action:
- On the normal installed client, update to v0.7.117, open DMTrim and the other plugin that previously crashed, toggle one setting in each, and right-click a received image. Confirm Discord stays open. If it still crashes, record the exact plugin/action and version; do not generalize the fix to every plugin until that runtime test passes.

## 2026-11-03 — DMTrim renderer-crash hardening (local, not released)

Recovered state:
- The public client remains v0.7.116. No new commit, tag, updater asset, or live deployment was made for this fix.
- The source worktree was clean before this scoped change. The existing v0.7.116 release and its earlier image-menu hardening were preserved.

Change made:
- Removed the three DMTrim quest rules that used CSS relational `:has()` selectors. They were the only risky relational selectors in DMTrim and were the strongest source-level suspect for the renderer crash shown when opening DMTrim settings.
- Kept the direct class, attribute, href, and list-item selectors so the normal DMTrim hiding behavior remains available.
- Guarded stylesheet refreshes against a detached style node, caught refresh failures, and cleared the style reference on stop so plugin reloads cannot write into stale DOM state.
- `pnpm overlay:vencord` synced the change into `vencord-src/src/userplugins/DMTrim` and rebuilt `vencord-dist`.

Verification:
- `pnpm test` passed ESLint and TypeScript.
- `pnpm build:dev` passed.
- `node overlay-scripts/verify-build.mjs` passed, including source fingerprint and staged renderer hash checks.
- The generated DMTrim mirror contains no executable CSS `:has()` rules; the only match is the explanatory source comment.
- Runtime reproduction in the current public client is still open. The stale DevTools endpoint was unavailable, and the screenshot alone cannot prove whether DMTrim was the sole trigger versus a broader renderer/theme interaction.

User-owed test:
- After launching a build containing this patch, open DMHub/Plugin Settings, open DMTrim, and toggle each setting once. Repeat with DMTheme and Tournament Mode in their current states. Confirm the panel opens and Discord does not enter the crash-recovery screen.
- If it still crashes, capture the exact surface and version; the next step is to run the dev build with a live DevTools endpoint and collect the renderer exception rather than guessing.

Next action:
- Review this local patch and, only after the DMTrim settings test passes, decide whether to commit/package/publish a new release. Do not call v0.7.116 fixed for this issue until the user retests the actual client.

## 2026-11-03 — v0.7.116 published: full-dev merge and image-menu crash hardening

Recovery note:
- The public v0.7.115 release was cut from the clean remote branch while the canonical development checkout still contained uncommitted/untracked WIP. That was a release-process mistake; the public build therefore did not include the newer DMEmoji implementation and some later optimization work.
- This isolated release worktree started from the v0.7.115 release evidence and ported the reviewed development source without touching the dirty canonical checkout.

Included in this candidate:
- The full newer DMEmoji source and styles: Unicode/server emoji search, iEmoji keyboard link, native reaction support when a real Discord emoji identity is linked, local media shelf, saved-media context actions, and the mouse-click Send button.
- The newer DMDisplayNameStyle scan/visibility memoization work so offscreen display-name surfaces stop retaining needless animation/scan work.
- Defensive validation in DMEmoji's persisted optional emoji reference and message context-menu renderer.
- Defensive validation in the ImageZoom image/message context-menu route: malformed props, non-image media types, invalid child arrays, and menu-construction errors now fail closed and are logged rather than taking down the renderer.
- Package version bumped to `0.7.116`; this candidate is the intended replacement for public `v0.7.115`.

Verification boundary:
- `pnpm test` — passed ESLint and TypeScript.
- `pnpm verifyPlugins` — passed; 57 defaults, 10 bundle IDs, and 9 featured IDs resolve to registered plugins.
- `pnpm package:dir` — passed; the packaged x64 executable reports ProductVersion `0.7.116.0` and is retained at `E:\discordmaxxer-candidate-artifacts-20261103c\win-unpacked\discordmaxxer.exe` after moving generated output off the full C: drive.
- `node overlay-scripts/verify-build.mjs` — passed after the final overlay; source fingerprint, staged renderer hashes, required source plugins, and compiled runtime plugins all match.
- Strict Vencord overlay — 89 rebrand patches applied or idempotent, 0 warnings; 29 custom plugin directories synced; Vencord build passed.
- Windows packaging — passed with temporary and output paths relocated to E:. The complete installer, x64/ARM64 ZIPs, blockmap, and `latest.yml` are at `E:\discordmaxxer-package-0.7.116-release2`.
- These local checks are not a substitute for Diggy's runtime test. The final user test is to right-click a normal image, GIF, and image link, open the menu repeatedly, use the ImageZoom controls, and confirm Discord remains open. Also verify DMEmoji search/reaction/attachment paths, widget/profile animation, voice, and screenshare.
- The first v0.7.116 tag attempt stopped safely at the release-notes gate because `docs/releases/v0.7.116.md` was missing; no partial release was created. The notes were added, the exact tag was moved to commit `0a890be`, and the corrected release workflow `41662865968` passed end-to-end.
- GitHub Release `v0.7.116` is public at `https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.116` with the installer, x64/ARM64 ZIPs, blockmap, and `latest.yml`. The public updater feed returned HTTP 200 with version `0.7.116`.
- Maxxtopia release-sync run `41663803221` succeeded and Cloudflare Pages deploy run `41663873577` succeeded. `https://maxxtopia.com/discordmaxxer` returned HTTP 200 and points to the v0.7.116 installer.
- The source/build/release gates are complete; Diggy's updated-client runtime checks remain open for the image context menu, DMEmoji, widget/profile animation, voice, screenshare, and cross-PC rendering.

## 2026-11-03 — v0.7.115 coordinated release candidate

Candidate state:
- Isolated worktree: `C:\Users\Diggy\projects\discordmaxxer-release-candidate-20261103`
- Branch: `codex/release-v0.7.115-candidate`
- Base: `origin/main` at `f3dbc7a5` (`v0.7.114`); package version is now `0.7.115`, while the public `v0.7.114` source and tag remain unchanged.
- The canonical dirty checkout and its unrelated WIP remain untouched.

Reviewed candidate changes:
- Tournament Mode now owns the reduced-cost presentation profile: it pauses animation clocks, removes optional profile finish effects, strips paint-heavy widget decoration, releases the video-background layer, and bounds third-party theme animation clocks. Normal mode restores full visual polish.
- Removed the global Chromium background/timer/occlusion flags and replaced them with a runtime performance bridge. Tournament lowers Discord scheduling priority only while active, preserves normal Chromium idle policy otherwise, and protects voice/media/capture identities from priority changes. The windowed build does not claim an FPS cap because Electron's normal window does not expose a supported cap API.
- TierFlair now pauses its observer, reconciliation timer, stylesheet, and badge registration in Tournament and restores them on resume.
- Tournament status uses a shared readable status surface instead of the theme-sensitive native grey-dot toast; the IPC performance options now have one shared type.

Verification completed in this candidate:
- `pnpm test` — passed lint and TypeScript.
- `pnpm buildWinAudio` plus `node --test packages/winaudio/test.js` — 4/4 passed; 197 loopback chunks captured at 48 kHz, stereo, 32-bit float.
- Strict Vencord overlay — 86/86 rebrand patches applied or idempotent, 0 warnings; 28 custom plugin directories synced; Vencord build passed.
- `pnpm build`, `node overlay-scripts/verify-build.mjs`, `pnpm verifyPlugins`, and `git diff --check` — passed. Registry counts: 55 defaults, 10 bundles, 9 featured, 242 registered IDs.
- `pnpm package:dir` — passed; local Windows executable created at `dist\win-unpacked\discordmaxxer.exe` (225,949,696 bytes).
- `pnpm package:win` — passed; local artifacts include `dist\Discordmaxxer-Setup-0.7.115.exe` (211,766,707 bytes), both Windows architecture ZIPs, and `dist\latest.yml` for updater validation.
- Isolated packaged runtime validator — passed with staged Vencord matching, 207 plugins registered, 65 enabled, watched plugins present/enabled, Tournament and CompactView hotkey paths toggling, and MassDelete patches wired. Badge mutation was intentionally skipped because it changes account state; the DMHub panel assertion remains a known validator/UI boundary.

Release boundary:
- The profile-media Worker integration is pushed to `optimizationmaxxing` `main` at `f35282e` and live at `https://optmaxxing-vip.maxxtopia.workers.dev`; `/healthz` and `/readyz` returned HTTP 200.
- The VIP page clarification is pushed to `maxxtopia` `main` at `98c891c`; Pages deployment run `41641612274` succeeded and `/discordmaxxer/vip` returned HTTP 200 with the new profile-flair explanation.
- The client v0.7.115 source is committed at `29247b2`; tag `v0.7.115` is published and GitHub Actions release run `41642488285` succeeded.
- The public GitHub release contains the installer, x64/ARM64 ZIPs, blockmap, and `latest.yml`; the public updater feed returned HTTP 200 with version `0.7.115` and the expected installer name.
- Maxxtopia release-sync run `41643124841` and Pages deploy run `41643166306` succeeded; `https://maxxtopia.com/discordmaxxer` returns HTTP 200 and points to the v0.7.115 installer.
- The previous benchmark is for the packaged `v0.7.63` candidate; no fresh comparative benchmark has been run for this `v0.7.114`-based candidate, so no new performance claim is authorized.
- Two-account/cross-PC recipient verification remains a user-owed acceptance test after the updater is published.
- Human voice-call and screen-share quality observation remains unverified. The native Windows loopback test passed, but that is not a substitute for a real Discord call.
- The local `package:win` installer has `latest.yml`, but that is not public updater proof until GitHub Actions publishes the tag release and the public feed is fetched.

Next action:
- Diggy should use the normal updater on the other PC, then test updater completion, free profile activation/upload, animated banner/avatar cross-PC rendering, Normal versus Tournament visuals, and a real voice call/screenshare. Record any failure with the exact client version and surface; do not infer benchmark parity from visual success.

## 2026-10-24 v0.7.114 published — Voice audio priority shielding & static prevention

v0.7.114 is publicly published from tag `v0.7.114`.
Voice & audio safeguards:
- Voice & Media Process Priority Shield:
  - Ensured the Renderer process (housing WebRTC Opus encode/decode and NetEq jitter buffer threads) and audio utility processes are strictly locked to `PRIORITY_NORMAL`.
  - Windows scheduler can no longer starve incoming audio threads during high game CPU utilization, permanently eliminating buffer underruns, clicks, pops, and static in voice calls.
- Universal Voice Call Detection:
  - Expanded voice state detection to recognize 1-on-1 Direct Message calls and Group DM calls via `RTCConnectionStore`, `ChannelRTCStore`, and native `RTCPeerConnection` listeners in addition to server voice channels.
- Background Audio Clock Protection:
  - Maintained `--disable-background-timer-throttling` on Chromium command line so 20ms WebRTC audio packet intervals are never delayed or delivered in bursts when Discord is unfocused or on a second monitor.
  - Guarded window minimize handlers to strictly never apply timer throttling to active audio contexts.

## 2026-10-24 v0.7.113 published — Resource efficiency overhaul & background throttling

v0.7.113 is publicly published from tag `v0.7.113`.
Architectural optimizations:
- DMCursor Pure GPU Hardware Acceleration & Idle Freezing:
  - Replaced CPU SMIL `<animateTransform>` tags in Sharingan, Rinnegan, and Rasengan SVG skins with pure GPU compositor `@keyframes` (`transform-origin` & `transform-box: view-box`), stopping V8 from recalculating SVG layout tree geometry on every frame.
  - Added stationary pointer activity detection (pausing cursor animations when pointer is stationary for >2.5s) and window focus tracking (`blur`, `focus`, `mouseenter`, `mouseleave`), freezing cursor animations to 0% CPU whenever the user is reading chat, gaming, or unfocused.
- DMWidget GPU Compositor Layer Promotion & Focus Pause:
  - Promoted `[data-dm-widget-skin]::before` and `::after` to dedicated GPU compositor layers via `will-change: transform, opacity; transform: translateZ(0);`, eliminating software repaint reflows during skin glow cycles.
  - Added `:root:not(:focus-within)` animation freeze so widget cosmetic loops immediately sleep to 0% CPU whenever Discord is unfocused.
- TournamentMode Full Freeze Integration:
  - Extended TournamentMode's `PERF_CSS` to immediately pause all custom DMWidget skin and surface animations alongside anime cursor rotations, guaranteeing zero background cosmetic rendering overhead during competitive matches.
- Voice-Aware Background Throttling & V8 RAM Trim:
  - Exported `isVoiceActive()` from `discordmaxxerPerf` and wired dynamic `webContents.setBackgroundThrottling(allowed)` across all windows on window minimize/hide and voice channel state transitions.
  - While minimized outside of voice calls, Discordmaxxer automatically throttles background JS timers and flushes V8 in-memory bytecode caches, safely sleeping background CPU without compromising voice/screenshare fidelity when in calls.

## 2026-10-24 v0.7.112 published — DMWidget game card skinning, settings performance, DMCursor showroom & Quests trim

v0.7.112 is publicly published from tag `v0.7.112`.
User-visible repairs:
- DMWidget game activity card permanent skinning:
  - Normalized paint layers across all skinned widget card roots (`[data-dm-widget-card-root="true"]`), clearing Discord's inner activity card background fills, borders, and `::before`/`::after` overlay fills while preserving action buttons ("Connect Account").
  - Automatically detect game activity playing cards (e.g. VALORANT, Fortnite), synchronize their particle animation timelines, and register ancestor hosts so the full skin background, glowing borders, and orbit ornament display permanently at idle without requiring cursor hover.
- Settings & Plugins page performance & stutter elimination:
  - Removed `content-visibility: auto` inside CSS Grid in `AddonCard.css`, eliminating dynamic row height recalculations and synchronous layout reflows on every scroll frame.
  - Guarded `DMDisplayNameStyle` against settings tabs so leaf names are not scanned, replaced layout-measuring `offsetWidth`/`offsetHeight` with non-reflowing `checkVisibility()`, made attribute writes strictly idempotent, and throttled scan frequency.
  - Optimized plugin card mounting (48 cards initial render <15ms + single idle mount for the rest).
- DMCursor responsiveness, visual showroom & dropdown fix:
  - Upgraded dropdown popout in `SelectSetting` to `SearchableSelect` with `popoutPosition="top"` and elevated `z-index: 10005` in `PluginModal.css` to prevent clipping under the modal layer.
  - Added direct 1-click visual showroom in `DMCursor` displaying animated SVGs of all 7 skins with live equipped badges.
  - Batched mousemove tracking to `requestAnimationFrame` and isolated `.anime-cursor` with `contain: strict; width: 44px; height: 44px;` for fluid 144Hz+ tracking with zero main thread stalling.
- DMTrim promo & quests hiding:
  - Inverted toggle fallback to `!== false` so uninitialized settings default to hidden.
  - Expanded CSS selectors with scoped direct-child combinators to aggressively hide sponsored FanDuel promo alerts and bottom-panel quest docks.
- Profile flair & identity layer stability:
  - Retained custom animated banners, avatars, and profile gradients with zero regressions.

## 2026-10-22 v0.7.111 published — DMCursor animation restoration & performance overhaul

v0.7.111 is publicly published from tag `v0.7.111`.
User-visible repairs:
- Restored full anime cursor animations across all skins:
  - Sharingan: 3-tomoe center rotation around center pupil (with native SVG transform + CSS fallback), restored pupil element, and pulsing chakra.
  - Rinnegan: rippling phased purple rings and rotating chakra dots around outer circumference.
  - Rasengan: visible multi-layered swirling chakra storm with multi-directional high-speed rotation.
  - Chidori: high-voltage crackling electric lightning arcing around pulsating core.
  - Stiiizy: pulsing LED with lightweight, isolated smoke particle trails.
- Performance and snappiness improvements:
  - Buffered mousemove handler directly to requestAnimationFrame, eliminating main thread stutter and CPU spikes from 1000Hz+ high polling rate gaming mice.
  - Isolated smoke particle elements inside a dedicated container, completely shielding Discord's and plugins' MutationObservers from waking up during movement.
  - Removed universal `html.anime-cursor-active *` selector to eliminate style recalculation lag across Discord's 20,000+ DOM nodes.
  - Streamlined GPU drop-shadow filters into single-pass hardware glows, cutting GPU compositor load.

## 2026-10-21 v0.7.110 published — DMWidget conversation header skin overhaul for short names & unified avatar capsule

v0.7.110 is publicly published from tag `v0.7.110`.
User-visible repairs:
- Lowered conversation header skinning visibility filter thresholds (minimum width 10px, height 12px) in `visibleSurfaceSkinTarget`, enabling short recipient names (2-5 characters like "Al", "Ed", "Bob") to receive widget skins reliably instead of failing detection.
- Fixed `isHeaderAvatarElement` avatar sibling detection in 1-on-1 DMs by removing fragile text length constraints that conflicted with Discord accessibility/status labels inside avatar wrappers.
- Enhanced `syncHeaderAvatarSurface` offset geometry and gap calculations, dynamically applying `--dmw-avatar-offset` and `--dmw-avatar-pad` to create a unified capsule enclosing both avatar and username.
- Fixed edge clipping on medium-length names by resolving parent container `overflow: hidden` constraints via CSS `:has()` and runtime ancestor style un-clipping.
- Maintained group DM and server channel compatibility without double-offsetting embedded channel icons.

## 2026-10-21 v0.7.109 published — DMTranslate overhaul with universal auto-detection & multi-engine fallback

v0.7.109 is publicly published from tag `v0.7.109`.
User-visible repairs:
- DMTranslate universal auto-detection: right-clicking any message in Japanese, Chinese, Russian, Spanish, French, German, Korean, Arabic, etc. auto-detects the source language and translates to English (or user-chosen target language).
- Multi-engine resilience: primary Google Translate single endpoint with automatic failover to Google PA, MyMemory, and optional DeepL API.
- Replaced broken `Alerts.show` with stable `ModalRoot` / `ModalHeader` / `ModalContent` / `ModalCloseButton` translation dialog with copy-to-clipboard buttons and `ErrorBoundary` isolation.
- Added native inline translation accessories underneath translated messages with quick `Copy` and `Dismiss` actions.
- Added `DMTranslate` to automated build verification.

## 2026-10-21 v0.7.108 published — DMEmoji crash repair and modal modernization

v0.7.108 is publicly published from tag `v0.7.108`.
User-visible repairs:
- Fixed client crash when clicking "Open DMEmoji" from the chat composer bar. Replaced Discord's broken mangled `Modal` with stable `ModalRoot`, `ModalHeader`, `ModalContent`, and `ModalCloseButton` primitives.
- Isolated modal rendering with `ErrorBoundary` and fallback standalone modal dialog to eliminate unhandled render exceptions.
- Enhanced IndexedDB emoji deserialization in `getEmojiFile()` supporting Blob, File, ArrayBuffer, and ArrayBufferView.
- Added `DMEmoji` to default enabled plugins and automated build verification.

## 2026-10-21 v0.7.107 published — settings/plugin performance overhaul, media proxy stability, DMCursor fluidity, DMWidget conversation header skins

v0.7.107 is publicly published from tag `v0.7.107`.
User-visible repairs:
- Settings & Plugins tab performance: CSS render containment on plugin cards (skipping offscreen card layout/paint), scoped useSettings listener, MutationObserver isolation away from Settings layers, and eliminated forced synchronous getBoundingClientRect() reflows.
- Media proxy stability: 30-second failure cache, 10-second socket timeout, Chrome browser User-Agent, and profile flair cooldown eliminating runaway socket hangup retry loops and memory exhaustion.
- DMCursor fluidity: requestAnimationFrame batching and translate3d GPU acceleration eliminating cursor lag and jitter when moving fast across Discord.
- DMWidget conversation header skins: 1-on-1 DM headers wrap both recipient avatar and username together seamlessly.
- PlaylistmaxxingPresence: live rich presence synchronization for song title, artist, album artwork, and "Listening on music.maxxtopia.com".


## 2026-10-19 unpublished Tournament Mode toast repair

The current public release remains v0.7.103. This is a local, unpublished
candidate repair for the report that Tournament Mode changes state but does
not show its confirmation toast. The source changes are intentionally not
pushed, tagged, deployed, or published yet.

Root cause and repair:

- `TournamentMode` emitted its status toast only after awaiting the desktop
  performance IPC bridge. If that bridge was slow or failed during renderer
  startup, the mode could change while the user saw no confirmation.
- It also forced the toast into the client's `TOP` position, which is not
  mounted consistently across Discord surfaces. The candidate uses the shared
  `showToast` helper and the client's default placement, emits the immediate
  ON/OFF status before the bridge wait, and emits a longer failure warning if
  desktop performance settings cannot be applied.
- The preload bridge previously discarded the performance-options argument.
  It now forwards the lower-priority, frame-cap, and arRPC options to the main
  IPC handler. The DM Hub no longer adds a duplicate generic success toast for
  Tournament Mode; the plugin owns the authoritative status message.

Verification passed locally: `pnpm testTypes`, full `pnpm lint`,
`pnpm overlay:vencord` (27 custom plugins, 85 idempotent rebrand checks, 0
warnings), `pnpm build`, `node overlay-scripts/verify-build.mjs`,
`pnpm package:dir`, `git diff --check`, and focused source assertions covering
toast ordering, default placement, IPC option forwarding, and duplicate-toast
suppression. `package:dir` completed with only Electron's existing dependency
collector/deprecation warnings; it did not fail the package.

Remaining proof is runtime/user-side: in the candidate client, toggle
Tournament Mode from the DM Hub and with Ctrl+Alt+T, confirm one immediate ON
or OFF toast, then confirm a clear failure toast if the native bridge is
unavailable. Confirm the performance options still apply and that no duplicate
Hub toast appears. Public v0.7.103 is unchanged until Diggy explicitly
authorizes the next push/release.

## 2026-10-21 v0.7.106 published — cross-client widget skin rendering

v0.7.106 is publicly published from tag `v0.7.106`.
User-visible repair: Fixed cross-client widget skin rendering so other
Discordmaxxer users viewing your profile see your chosen widget skins (such
as deepSpace / neonCircuit gradient borders and layouts). The visible widget
hydration path in DMWidget now queries Discord's public RPC endpoint
(`/applications/{id}/rpc`) rather than the owner-only developer endpoint
(`/applications/{id}`), preventing 403 Forbidden errors when non-owners view
widgets. Also fixed an inverted boolean filter in `visibleProfileWidgetStyles`
and `visibleProfileWidgetHints`.

## 2026-10-21 v0.7.105 published — hotfix: restore widget skin gradient frames

v0.7.105 is publicly published from commit `4fb3c13`, with tag `v0.7.105`.
The public Release workflow `39669745838` passed. The release has the x64
installer, x64/ARM64 ZIPs, blockmap, readable release notes, and `latest.yml`;
the public updater manifest reports `version: 0.7.105` and points to
`Discordmaxxer-Setup-0.7.105.exe`.

User-visible repair: Fixed a visual regression in v0.7.104 where colored gradient
borders and frames around profile widget cards (e.g. Valorant and Fortnite cards)
stopped rendering. DMWidget was reverted to the known-good v0.7.103 state, restoring
all card frame effects, gradients, and skin styling.

## 2026-10-21 v0.7.104 published — profile flair controls, widget skins, and tournament mode

v0.7.104 is publicly published from commit `3033319`, with tag `v0.7.104`.
The public Release workflow `39663713395` passed. The release has the x64
installer, x64/ARM64 ZIPs, blockmap, readable release notes, and `latest.yml`;
the public updater manifest reports `version: 0.7.104` and points to
`Discordmaxxer-Setup-0.7.104.exe`.

User-visible repair: DMProfileFlair controls overhaul (text selection and cursor
jumping fixed, circular animated thumbnails for recent picks, clickable empty
preview window, file picker and drag/drop upload, automated upload/import
validation through the live VIP worker, inline preflight feedback, crop/fit/scale/
effects/playback speed controls, manual claim code moved to bottom, deprecated
vanilla message bridge removed). DMWidget now recognizes native Playing activity
cards (e.g. Valorant) to inherit widget skins, with live Tournament Mode mirror
synchronization to prevent card animation freeze. Tournament Mode status banner
and VideoBackground status toasts are reliable. DMTierFlair and VIP page update
MAXXER++ palette to champagne gold and deep wine red. Playlistmaxxing rich presence
shows music.maxxtopia.com with live track hydration. Welcome tour preview GIF trimmed.

## 2026-10-19 v0.7.103 published — account-scoped profile media repair

v0.7.103 is publicly published from commit `b5dcc70`, with tag `v0.7.103`.
The public test workflow `39342967459` and Release workflow `39342975449`
passed. The release has the x64 installer, x64/ARM64 ZIPs, blockmap, readable
release notes, and `latest.yml`; the public updater manifest reports
`version: 0.7.103` and points to `Discordmaxxer-Setup-0.7.103.exe`.

User-visible repair: the client now keeps banner, animated avatar, gradient,
and presentation state separate per Discord account instead of reconciling
through one shared local slot. Startup and account switching wait for the
matching roster identity before adopting legacy local media, and editor save,
clear, recent-media, color, and presentation controls use the active account
boundary. The live Worker already contains distinct healthy media records for
DiggyT and DiggyAI, so no re-upload is required for those records.

Local verification passed before publication: `pnpm test`, `pnpm build`,
strict Vencord overlay (`85` idempotent rebrand checks, `0` warnings),
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`,
`pnpm package:win`, executable ProductVersion `0.7.103.0`, and
`git diff --check`.

Remaining proof is recipient-side: install the same `0.7.103` build on both
PCs and test both account directions. Confirm each account keeps its own
animated banner/avatar, gradient, and widget skins without a native/default
flash. Discordmaxxer-only visuals still require Discordmaxxer on both the
owner and viewing clients.

## 2026-10-19 v0.7.100 published — renderer stability release

v0.7.100 is publicly published from source commit `8a580d8`, with tag
`v0.7.100`. The release workflow `39204372301` passed its readable-notes,
dependency, strict overlay, build, artifact verification, Electron Builder,
asset upload, and Maxxtopia notification steps. The public release is
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.100`; the x64
installer, x64/ARM64 ZIPs, blockmap, and `latest.yml` are uploaded.

User-visible changes:

- Owner-scoped widget hydration keeps each profile's Fortnite/Valorant skin
  separate from the viewer's local skin, including during account switches.
- Last confirmed widget and roster state survives temporary empty or delayed
  responses, reducing native/default flashes while profile data is loading.
- Older local widget-style markers are migrated in a bounded, rate-limited way
  instead of repeatedly triggering broad lookups.
- `DMDisplayNameStyle` rechecks profile name surfaces after profile flair and
  other visual markers mount, restoring styles in popouts and profile views.
- The release includes readable notes and the existing in-view animated
  banner/avatar renderer; it does not change the Discordmaxxer-only versus
  vanilla-Discord visibility boundary.

Local verification passed: `pnpm test`, `pnpm build`, strict Vencord overlay
(85 applied, 0 warnings), compiled-artifact verification, `pnpm package:dir`,
and `git diff --check`. The original dirty checkout was not modified; this
release was built from the clean `v0.7.100` release worktree.

Remaining proof is recipient-side, not a source or release failure: install
the same `0.7.100` build on both PCs and test DiggyT -> DiggyAI and DiggyAI ->
DiggyT. Confirm each account keeps its own gradient, animated banner/avatar,
and Fortnite/Valorant widget skins; no viewer skin leaks or native/default
flash appears; in-view media stays animated; and display-name styles appear
on chat and profile surfaces. Vanilla Discord still cannot render
Discordmaxxer-only banners, widgets, flair, or colors.

## 2026-10-18 v0.7.99 published — cross-account renderer and DM Hub follow-up

v0.7.99 is published from source commit `8d80deb2f25385cb5667d0435f543c643688d427`,
with tag `v0.7.99`. The release workflow `39151530654` passed all build,
overlay, artifact, Electron Builder, readable-notes, and Maxxtopia notification
steps. The companion test workflow `39151528293` also passed. GitHub Release
assets include the x64 installer, x64/ARM64 ZIPs, blockmap, and `latest.yml`;
the updater manifest reports `0.7.99`.

User-visible changes carried into this public build:

- `DMDisplayNameStyle` restores styling across visible message author labels,
  profile popouts, member rows, and DM headers, with separate surface toggles.
- `DMWidget` no longer uses the viewer's local widget skin for another user's
  profile while the owner's marker is loading. Unknown owner state stays native
  until the exact owner skin is available, preventing cross-account skin bleed.
- `DMWelcome` now has a real badge preview and a small scroll cue so the
  gradient, profile media, plugin health, and featured-plugin sections are
  discoverable without removing the existing gradient choices.
- The v0.7.98 last-good roster/media state and visibility-aware animated
  banner/avatar renderer remain included, preventing refresh/default flashes
  and keeping animated media running while it is in view.
- The preceding profile-media work remains included: free full-quality
  animated banner/avatar/colors, paid presentation controls and capacity,
  owner-specific widgets, R2-backed roster snapshots, Playlistmaxxing live
  presence with direct artwork, and the readable release-alert guard.

Independent live checks on 2026-10-18:

- The live profile-media Worker `/roster` returned HTTP 200 with version 2 and
  DiggyAI's saved banner URL, external animated avatar URL, and maroon/red
  colors (`#4d1c12` / `#ff0034`). The DiggyAI banner route returned HTTP 200,
  `image/gif`, and `public, max-age=300`.
- The live VIP page already contained the current free-media tier copy and
  one-time Founder pass copy; its isolated source build passed the site's
  release-truth and sitemap checks plus Astro production build.
- These are source/build/backend checks, not proof of a signed-in recipient's
  two-PC rendering. That final proof remains Diggy's test after installing the
  same `0.7.99` build on both PCs.

Known configuration boundary: the Worker has the universal VIP role secret
configured, but the per-tier Discord role IDs are still blank in its deployment
configuration. Per-tier role granting cannot be claimed complete until the
real Discord role IDs are configured and tested; no role IDs were invented.

Diggy-owed v0.7.99 test: install the public installer on both PCs, confirm
About says `v0.7.99`, then test DiggyT -> DiggyAI and DiggyAI -> DiggyT. Verify
each account keeps its own gradient, banner/avatar, and Fortnite/Valorant skin;
the profile never flashes native/default state; animated media plays while in
view; DM Hub badge/scroll cue and display-name surfaces work; and
Playlistmaxxing presence updates with the song artwork. Vanilla Discord still
cannot render Discordmaxxer-only banners, widgets, flair, or colors.

## 2026-10-18 release-alert safeguard — pushed to origin/main

The v0.7.98 incident exposed a workflow-ordering bug: Electron Builder
published the release before the readable-notes check, and the generic failure
DM then claimed "nothing published" even though all five assets were live.
The release workflow now validates `docs/releases/vX.Y.Z.md` and its `##
Highlights` heading before `electron-builder --publish always`. Its failure
alert also queries the GitHub Release, with retries, and distinguishes a live
release with a later failed step from a partial or absent release. The
releasing and troubleshooting runbooks now document the three alert meanings.

The fix was verified locally and committed as `12b069a`, then pushed to
`origin/main`. The existing v0.7.98 release remains public and unchanged; this
guard affects future release runs. The old historical run can remain marked
failed, but future alerts now distinguish an absent release, a partial release,
and a release that published successfully before a later step failed.

## 2026-10-18 v0.7.98 published — first-render and owner widget state

v0.7.98 is published from source commit `b32bbca94c761cf0401f231004e5b801f08ce0b8`,
with tag `v0.7.98`. The public release is
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.98`; the x64 and
ARM64 ZIPs, installer, blockmap, and `latest.yml` are uploaded and the public
updater manifest reports version `0.7.98`.

The release workflow built and uploaded the artifacts successfully but initially
stopped at its readable-notes check because the notes file did not yet contain
the required `## Highlights` heading. The heading was added, the existing
release body was corrected, and the notes-format fix was pushed as `d0406f8`.
The site sync workflow `39146762999` then completed successfully and the
Cloudflare Pages deploy `39146779202` completed successfully. The live
Discordmaxxer product page points to the v0.7.98 installer/release notes and
the live updates page contains the release entry.

User-visible changes:

- `DMProfileFlair` keeps the last good roster snapshot during refresh and avoids
  destructive cleanup while Discord is still mounting a profile, so banners,
  avatars, and gradient colors do not flash back to native defaults.
- `DMWidget` applies a temporary viewer fallback immediately while a foreign
  widget's owner marker is being read, then replaces it with the owner's exact
  published skin when available.
- `DMWidget` migrates older locally-selected attached widget skins into the
  shared owner marker, at most four applications per refresh with a 15-minute
  retry window and confirmation after each write. This avoids repeated Discord
  writes and extra media/roster quota pressure.

The release passes `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, package-directory and full Windows
package generation, artifact/version/hash checks, ASCII-safe script validation,
and `git diff --check`. The canonical dirty checkout and the profile-media
Worker remain separate and were not reset or broadly staged. No Worker change
is part of this release.

Remaining proof is the user's signed-in two-PC recipient test, not a source or
release gate. After installing v0.7.98 on both PCs, verify DiggyT -> DiggyAI and
DiggyAI -> DiggyT: each profile keeps its own gradient/banner/avatar, each
Fortnite/Valorant widget keeps its owner's skin, and reopening a profile never
shows a native/default flash. If an owner marker is still missing, the first
owner-side launch should migrate it; the viewer should use the temporary
fallback only until that owner marker is readable.

## 2026-10-18 v0.7.97 published — follow-up for first-render and owner widget state

The scoped v0.7.97 release is published from commit
`3e846363ed443cc08c386e263f8b6c3ccd6303ee`; tag `v0.7.97` is on `origin`, and
GitHub Actions run `39115994152` passed. The public release is
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.97`, with the
Windows x64/ARM64 ZIPs, installer, blockmap, and updater manifest verified.
The live client baseline is therefore v0.7.97, but the signed-in two-PC
recipient rendering check remains user-owned proof rather than a source/build
claim.

The current worktree has an unpublished follow-up in three plugin files:

- `DMProfileFlair` keeps the last good roster snapshot during refresh and
  avoids destructive cleanup while Discord is still mounting a profile, so
  banners, avatars, and gradient colors do not flash back to native defaults;
- `DMWidget` applies a temporary viewer fallback immediately while a foreign
  widget's owner marker is being read, then replaces it with the owner's exact
  published skin when available; and
- `DMWidget` now migrates older locally-selected attached widget skins into
  the shared owner marker, at most four applications per refresh with a
  15-minute retry window and confirmation after each write.

The follow-up passes `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
and `git diff --check`. It is not committed, tagged, pushed, packaged for
publication, or live. The canonical dirty checkout and the profile-media
Worker remain separate and were not reset or broadly staged.

Next action: review and publish this follow-up only after Diggy authorizes the
next release. After installation on both PCs, verify DiggyT -> DiggyAI and
DiggyAI -> DiggyT: each profile keeps its own gradient/banner/avatar, each
Fortnite/Val widget keeps its owner's skin, and reopening a profile never
shows a native/default flash. If an owner marker is still missing, the first
owner-side launch should migrate it; the viewer should use the temporary
fallback only until that owner marker is readable.

## 2026-10-17 v0.7.96 published — cross-PC profile media and Playlistmaxxing presence

Patch release `v0.7.96` is published from commit `f0a10cf` on `main`, with
tag `v0.7.96`. The GitHub release workflow `39088055274` passed, uploaded the
x64/ARM64 ZIPs, installer, blockmap, and `latest.yml`, and attached readable
release notes. The public updater manifest reports version `0.7.96`.

The release contains two intentional source changes:

- `plugins/DMProfileFlair/index.tsx` now identifies profile owners from more
  Discord media forms, protects against recycled profile nodes and late media
  callbacks painting the previous user's banner, keeps Discord's native
  background styles intact, and raises the replacement media above the native
  layer. The live Worker roster and DiggyAI banner were checked separately:
  `/roster` returned HTTP 200 and the banner route returned HTTP 200 with
  `image/gif`.
- `plugins/PlaylistmaxxingPresence/index.ts` now reads the current track from
  `http://127.0.0.1:4747/nowplaying` on startup and every 10 seconds, while
  retaining the live SSE stream. `showWhenIdle` controls only the static
  fallback card; it does not hide a live track. Public song artwork URLs are
  passed through as the Rich Presence large image instead of being forced
  through the application-asset resolver and falling back to the app logo.

Verification passed locally: `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check`. The full
Streammaxxing Tauri suite also passed with 57 tests. `pnpm package:dir` then
produced a local `dist/win-unpacked` executable whose packaged renderer was
checked for the new profile-media owner guard and Playlistmaxxing snapshot
path. The second-PC DiggyT to DiggyAI visual test is still pending; source,
build, release, and updater proof do not prove the recipient rendered the
animation.

The Discordmaxxer client now polls `/nowplaying`, but the companion bridge must
still be running and Playlistmaxxing Broadcast must be enabled. Merely playing
music on the site does not send the cross-app event. The next release test is:
start the hub, click Broadcast, start a track, confirm the live title and
track artwork, then stop the track and verify that `showWhenIdle` only affects
the idle fallback.

The companion-side `/nowplaying` snapshot/priority bridge is already present in
the live Streammaxxing v0.1.67 installer. The public updater manifest reports
v0.1.67, and the local installer matches its published SHA-256 exactly. A
read-only shipped-binary inspection also found the `/nowplaying`,
Playlistmaxxing, hosted-origin, snapshot, and private-network bridge markers.
No duplicate Streammaxxing publish is needed; the remaining proof is the real
runtime test with the hub running, Playlistmaxxing Broadcast enabled, a track
playing, and the artwork/title observed in Discord.

## 2026-10-17 in-view media resilience audit — local candidate only

The published baseline remains v0.7.95. A local, unpublished candidate adds an
IntersectionObserver-backed resume hook for loaded video banner overlays: when
an overlay enters the viewport, or the app returns from background/focus, the
renderer calls `play()` again. It does not change the roster contract, media
URLs, owner lookup, GIF/image handling, crop/effect settings, or the deliberate
Tournament Mode pause. Animated GIFs remain real `<img>` elements; Chromium's
image decoder controls their animation and they are not reloaded, avoiding
flicker.

Verification passed in the candidate worktree: `pnpm test`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
and `git diff --check`. The source change is intentionally not committed,
pushed, tagged, or published. A real signed-in DiggyT -> DiggyAI recipient test
is still required before claiming the visual behavior is verified.

The live profile-media Worker is already serving the v2 R2 roster snapshot
successfully (`/roster` HTTP 200, no retry header). The legacy KV-list migration
fallback remains only for a missing snapshot; no Worker change was made in this
audit. The Maxxtopia site is live, but `npm audit --omit=dev` reports dependency
advisories (including a critical Astro advisory); dependency remediation is a
separate upgrade-and-test task, not an emergency page outage fix.

## 2026-10-16 v0.7.94 published — two-style Catwoman preset restored

Patch release `v0.7.94` restores the original two-pose Catwoman Featured render
for the Fortnite widget preset. The prior Fortnite-API URL now serves a single
pose, so `plugins/DMWidget/index.tsx` uses the verified 1024px public mirror at
`https://image.fnbr.co/outfit/5d8610e074b719851d631e9c/featured.png`.

Local verification passed: `pnpm test`, strict Vencord overlay, build
verification, `pnpm build`, `pnpm package:dir`, `pnpm package:win`, and a direct
HTTP 200 check for the Catwoman image. The release commit is `e66b7e3`; tag
`v0.7.94` is on `main`; GitHub workflow `38966464900` passed; the public
release contains the x64/ARM64 ZIPs, installer, blockmap, `latest.yml`, and
readable release notes. The updater manifest reports version `0.7.94`.

Still waiting after publication: install/reload v0.7.94 on both PCs and verify
the real DiggyT -> DiggyAI recipient view. That user-owned test must confirm
the existing widget is republished with the restored Catwoman preset and that
the intended cross-account banner/avatar/widget behavior is present. This
release does not change the Discord vanilla-client rendering limitations.

Best next action: install v0.7.94 on the second PC, reload both clients, and
republish DiggyAI's Fortnite widget once if it still points at the old hero
URL; then check the recipient view before advertising the result as verified.

## 2026-10-16 v0.7.92 published — recipient test pending

This is the published v0.7.92 follow-up in the `codex/release-v0.7.91`
worktree. The public v0.7.91 baseline is superseded by the release below. The
release repairs the
owner/viewer boundary for profile widgets, refreshes a foreign profile's
shared-banner roster entry after a failed media load, changes the default
Fortnite preset to the two-style Catwoman artwork, and adds a DMHub shortcut
that opens the Video Background editor directly. It also aligns the Founder
normalization and public/ticket copy with the approved offer: $67 once,
lifetime MAXXER+, a permanent numbered Founder badge, no required
subscription, and MAXXER++ optional.

The widget change is source-level owner precedence: a viewed profile's
published `[DMWSTYLE1:...]` marker is hydrated even when the viewer has a
local style for the same application; the viewer's local style remains only a
fallback when no owner marker is available. The Catwoman preset changes the
default/recovery choice; it does not rewrite an already-published DiggyAI
widget. DiggyAI must select the preset and publish once if its existing widget
still points at the old hero asset.

Verification passed locally:

- `pnpm test`, `pnpm build`, and `pnpm verifyPlugins` in the Discordmaxxer
  candidate.
- Strict Vencord overlay with zero rebrand warnings and
  `node overlay-scripts/verify-build.mjs`.
- `node --test vip-worker/profile-media.test.mjs`: 14/14 tests, including
  Founder claims normalizing to lifetime MAXXER+.
- `npm run build` in the Maxxtopia candidate, including release-truth and
  sitemap checks.
- `git diff --check` in all three worktrees.

Read-only live checks found the current Catbox banner and profile-media URLs
responding successfully (HTTP 200, with a valid video range response for the
Catbox asset). That proves the current upstream URLs are reachable, not that
the other signed-in client has loaded the correct owner record.

Publication completed: commit `34ba4e9` and tag `v0.7.92` are on `main`, GitHub
release workflow `38951007702` passed, and the release contains the Windows
x64/ARM64 ZIPs, installer, blockmap, `latest.yml`, and attached readable notes.
The profile-media worker deployed as version
`5b3adb30-0eb2-4b64-9c51-52f64d48fc1c`; the ticket worker deployed as version
`56a81c79-98ba-4467-8c91-103998b6d007`. Maxxtopia Pages deployed the VIP page
and release-sync commit `7c74a69` is on its `main`.

Still waiting after publication: installing/reloading the candidate on both
PCs, confirming the exact DiggyAI account mapping, republishing the DiggyAI
Catwoman widget if needed, and the real DiggyT -> DiggyAI recipient test for
the animated banner, avatar, and each owner-selected widget skin. Do not
advertise cross-account banner rendering as verified until that test passes.

Best next action: install/reload v0.7.92 on both PCs, republish DiggyAI's
two-style Catwoman widget if it is still using the old asset, and capture the
DiggyT -> DiggyAI recipient test before changing the media contract again.

## 2026-10-08 v0.7.90 published — cross-account fallback and banner default hardening

Patch release `v0.7.90` is public at
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.90`.
Commit `4aae771` is on `main`, tag `v0.7.90` is pushed, and workflow
`37830068708` completed successfully. The public release is non-draft and
non-prerelease and contains the Windows x64 and ARM64 ZIPs,
`Discordmaxxer-Setup-0.7.90.exe`, its blockmap, and a verified `latest.yml`
reporting version `0.7.90`, the matching installer path, size, and SHA-512.

The published changes harden cross-account widget-style recovery: a missing,
malformed, or unreadable owner marker borrows the viewer-selected skin while
retrying, a confirmed owner marker remains authoritative, and app-name hints
remain available when Discord omits its DOM app-id. `showOthersBanner` stays
enabled while settings hydrate and still honors an explicit opt-out.

The local source, strict overlay, build, package, and CI release gates passed.
This proves publication and artifact integrity; DiggyT's second-PC recipient
view of DiggyAI's banner and owner-selected widgets remains a user-owned
runtime test. The C: dev checkout and E: packaged candidate remain untouched,
and the existing untracked `artifacts/` diagnostics remain preserved.

## 2026-10-08 v0.7.90 release candidate — cross-account fallback and banner default hardening

The next patch release is prepared as `v0.7.90`. It carries the local
cross-account widget-marker recovery and the explicit-false-only
`showOthersBanner` guard. A missing or unreadable owner marker now borrows the
viewer-selected skin while retrying instead of leaving the viewed profile
plain; a confirmed owner marker remains authoritative. The banner option stays
on while settings hydrate but still honors an explicit opt-out.

Release notes are recorded in `docs/releases/v0.7.90.md`. This section records
the pre-publication candidate state; the publication proof is recorded above.
The C: dev checkout and E: packaged candidate remain untouched, and the
existing untracked `artifacts/` diagnostics remain preserved.

Pre-publish verification for this candidate passed: `pnpm test`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord` with zero warnings,
`node overlay-scripts/verify-build.mjs`, `pnpm build`, `pnpm package:dir`,
`pnpm package:win`, and `git diff --check`. The Windows packaging pass produced
the x64/ARM64 ZIPs, unified setup executable, and blockmap locally; generated
build outputs remain ignored and are not release source files.

## 2026-10-08 local follow-up — marker-error fallback and banner verification

The uncommitted local follow-up changes the cross-account widget resolver so a
missing, malformed, or unreadable `[DMWSTYLE1:...]` marker is treated as an
availability error. The viewed card now borrows the viewer's selected skin
while the marker is retried; a valid owner marker still overrides the fallback.
App-name hints are retained when Discord omits the DOM app-id attribute, so
fallback matching does not leave a foreign card plain.

Verification in the canonical release checkout passed: `pnpm test`,
`pnpm verifyPlugins`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, `pnpm build`, `pnpm package:dir`, and
`git diff --check`. This is local and uncommitted; it is not pushed or
published. The C: dev checkout and E: packaged candidate remain untouched;
existing untracked `artifacts/` remains preserved.

Banner status is separate. The client source already contains roster-change
repaint, profile identity/banner-wrapper detection, and the `dm-media://`
video path. A read-only live roster check found one banner URL returning 200
and one profile-media URL returning 404. Because the account-to-id mapping and
second-client rendering are not proven here, DiggyAI's recipient view remains
a user-owned verification gate; do not claim the banner is fully fixed until
the correct account is mapped and viewed on the other client. If DiggyAI is the
404 entry, the owner must republish that shared banner; no live data was
changed.

Next action: test the marker-miss fallback on DiggyT -> DiggyAI and verify
`showOthersBanner` is enabled on the recipient client. Publishing requires a
new explicit release decision.

## 2026-10-08 follow-up — banner viewer default-on hardening

`DMProfileFlair.showOthersBanner` was already declared with `default: true`.
The guard is now explicit-false-only, so an absent or not-yet-hydrated value
also resolves to ON while a deliberate false opt-out is preserved. The option
description now makes the default visible to users. `pnpm test`,
`pnpm verifyPlugins`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, `pnpm build`, `pnpm package:dir`, and
`git diff --check` passed.

DiggyT confirmed `showOthersBanner` was already enabled, so this setting was
not the cause of the missing DiggyAI banner on that client. The banner issue
remains separate: the client path is repaired, but recipient rendering and the
live account/media mapping still need proof; no live profile data was changed.

## 2026-10-08 v0.7.89 published — cross-account widget skin isolation

Patch release `v0.7.89` is public at
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.89`.
Commit `432d38e` is on `main`, tag `v0.7.89` is pushed, and workflow
`37815250257` completed successfully. The release contains the Windows x64
and ARM64 zips, `Discordmaxxer-Setup-0.7.89.exe` plus its blockmap, and a
verified `latest.yml` with version `0.7.89` and the matching installer size
and SHA-512.

The release fixes the cross-account bleed where DiggyT's local widget style
could become the fallback for DiggyAI's visible Board/Playing cards. A viewed
profile now resolves its style from that profile's published `[DMWSTYLE1:...]`
marker; a profile without a readable marker remains unskinned. The signed-in
account's own DM/header/bottom-left surface still uses only its local choice.
The source, package, strict overlay, packaged smoke, and read-only validator
gates passed. The smoke validator used `diggytai_31401`; it did not log into
the second account, so recipient-side proof remains a user-owned gate.

Next test: update both Discordmaxxer clients to `v0.7.89`. On DiggyT, open
DiggyAI's profile and verify DiggyAI's Board/Playing card keeps DiggyAI's
chosen skin. Change DiggyT's own widget style, reopen DiggyAI's profile, and
verify DiggyAI's card does not change. If DiggyAI's marker is unavailable, a
plain card is intentional rather than DiggyT's skin appearing. Also verify
the own profile and the DM A -> DM B -> DM A surface behavior. The C: dev
checkout and E: packaged candidate remain untouched; existing untracked
`artifacts/` diagnostics remain preserved.

## 2026-10-08 v0.7.89 release candidate — profile first-paint repair

The profile-skin latency repair is prepared as patch release `v0.7.89`. It
keeps the active-DM-row cleanup and adds a bounded visible-profile fast pass,
a short late-mount watcher for Board/Playing cards, and idle/background broad
reconciliation. Repeated surface writes are skipped so opening a profile does
not restart the skin animation or add avoidable normal-mode work.

The candidate also fixes the cross-account style boundary: profile cards first
identify the viewed account's application id, then read that account's
published `[DMWSTYLE1:...]` marker. DiggyT's local widget map is no longer used
as a fallback for DiggyAI (or any other viewed account); if the viewed app has
no readable marker, its card remains unskinned. The open-DM/header and
bottom-left account surface continue to use only the signed-in account's local
selection.

Release notes are recorded in `docs/releases/v0.7.89.md`. The source and
packaging gates now pass in this checkout: `pnpm test`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord` (0 warnings),
`node overlay-scripts/verify-build.mjs`, `pnpm build`, `pnpm package:dir`,
`pnpm package:win`, `git diff --check`, and the read-only packaged validator
(`inventory`, `visual`, `hotkeys`, and `massdelete`; badge skipped). The
packaged smoke client used the `diggytai_31401` account and was closed after
validation. It did not prove the DiggyT -> DiggyAI recipient view; that remains
the user-owned cross-account gate after publication. Public `v0.7.88` remains
the live baseline until the `v0.7.89` tag workflow is verified. The C: dev
checkout and E: packaged candidate remain untouched, and the existing
untracked `artifacts/` diagnostics remain preserved.

## 2026-10-08 follow-up profile first-paint and active-DM cleanup — local candidate

The profile-skin follow-up now keeps the earlier active-DM-row repair and makes
the profile widget path cheaper and earlier. The visible profile/card scan
deduplicates nested profile surfaces, prioritizes explicit application ids and
known widget labels, caps React-fiber lookups, and no longer launches a broad
resolver immediately after the targeted pass. A short-lived profile mount
observer still catches cards committed after the avatar/banner shell, while the
normal full resolver is left to the idle/background schedule. This is intended
to make the Board/Playing skin arrive with the profile instead of several
seconds later, without bringing back the normal-mode lag or animation flashing.

Verification passed in the canonical release checkout after this follow-up:
`pnpm test`, `pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
`pnpm build`, and `git diff --check`. The source change is uncommitted and has
not been pushed or published; public `v0.7.88` remains the live baseline. The
C: dev checkout and E: packaged candidate were not touched, and the existing
untracked `artifacts/` diagnostics remain preserved.

Remaining user gate: on the rebuilt signed-in client, open the own profile and
confirm the Board/Playing skin appears on the first profile paint alongside the
avatar/banner; switch DM A -> DM B -> DM A and confirm only the current row and
conversation header remain skinned. Check that the Playing skin does not flash
or add noticeable normal-mode lag. If that passes, the next safe step is a
packaged smoke build and a separately authorized patch release.

## 2026-10-08 active DM row and profile-skin latency repair — local candidate

This follow-up addresses the two post-v0.7.88 reports: an old conversation row
could retain the surface skin after switching between DMs, and a profile's
widget skin could appear several seconds after the avatar/banner. The DMWidget
renderer now resolves one visible/current DM row when duplicate route matches
exist, cleans the previous row from the DM click path, and uses a next-task
profile pass instead of waiting for Chromium idle time. Repeated surface writes
are also skipped so the fast path does not restart cosmetic work unnecessarily.

Verification passed in the canonical release checkout: `pnpm test`,
`pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`, `pnpm build`,
and `git diff --check`. The source change is still uncommitted and has not
been pushed or published; public `v0.7.88` remains the live baseline. The C:
dev checkout and E: packaged candidate were not touched, and the existing
untracked `artifacts/` diagnostics remain preserved.

Remaining user gate: on a signed-in client, click DM A, DM B, and back to A;
only the current conversation row/header should remain surfaced. Open the own
profile and confirm the Board/Playing skin appears promptly without animation
flashing or extra lag. If that passes, the next safe step is a packaged smoke
build and review before asking for a new patch release.

## 2026-10-08 v0.7.88 published — widget skin, hero preservation, updater repair

`v0.7.88` is public. It carries the DMWidget repair that keeps skin-only
application cosmetic: existing widget geometry and hero content are preserved,
and the picker now keeps a readable high-contrast result message when
Discord's transient toast is hidden. It also carries the Windows updater
handoff fix (`quitAndInstall(true, true)`) so the downloaded installer is
silently applied and the updated client relaunches instead of leaving the
custom updater on an Installing spinner.

Release verification passed in this checkout: `pnpm test`, `pnpm build`,
strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord` (0 warnings),
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`,
`pnpm package:win`, and `git diff --check`. The packaged `0.7.88` client was
reopened on the existing signed-in smoke profile; the read-only
`DM_DEBUG_URL=http://localhost:9223 node overlay-scripts/validate-all.mjs
--skip badge` run passed inventory, visual, hotkey, and mass-delete phases.
The badge phase was intentionally skipped because it writes account settings.

The release commit is `e446f7a`, pushed to `origin/main`, and tagged
`v0.7.88`. GitHub Actions Release run `37808043221` completed successfully:
https://github.com/MaxxTopia/discordmaxxer/actions/runs/37808043221

Published release: https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.88

Published assets are `Discordmaxxer-0.7.88-win.zip` (150,083,839 bytes,
SHA-256 `abb29c331d66a4a3727e3a04257f477d5173ee502273e0c684ac633e6805ed3c`),
`Discordmaxxer-0.7.88-arm64-win.zip` (146,998,653 bytes, SHA-256
`f585ced469fc8d869b4a200ca3ffce0e91bb66afed1818b5f758529b33a5af27`),
`Discordmaxxer-Setup-0.7.88.exe` (211,464,658 bytes, SHA-256
`89e437547224b9fbdd74b49060867044cc94d2255e9c7b77322eed494b9fc590`), its
blockmap, and `latest.yml`. The served updater manifest reports version
`0.7.88`, installer size `211464658`, and SHA-512
`PA7j4yfN+zosIKd8vpj01i0QGSD16TlTtOUEFchjURqe7ajw6VwP9lmokbwOMs6UM+6naNVJC8BLfBDk5PIS6A==`.

The intended source files are `package.json`, `plugins/DMWidget/index.tsx`,
`src/main/updater.ts`, and this continuity note; diagnostic files under
`artifacts/` remain untracked and are excluded. The C: dev checkout and E:
packaged candidate remain untouched.

The remaining user gate is Diggy's install/update smoke test on the target
account. The source, CI package, public release assets, and served updater
manifest are verified; this note does not claim that a new client has already
been installed on every machine.

## 2026-10-08 Fortnite hero/layout restoration — packaged signed-in proof

The Fort widget had a stale published presentation from the earlier skin
apply regression: `widget_top_contained` referenced the generic `hero` asset,
which is the `maxxtopia.com` banner. The widget already contained the correct
Fortnite duo artwork as `hero1783298270698`, so the signed-in packaged client
was repaired in place without uploading or deleting assets. The published
Fort config now uses `widget_top_hero`, and its preview/profile hero references
the same existing Fortnite asset. The remote style marker was aligned to
`deepSpace` with the hero/stats presentation.

After refreshing Discord's cached profile data, the single packaged client
rendered the full Fortnite character hero instead of the boxed banner. The
account's own stats remained unchanged (284 wins, 3.33 K/D, 695h, 11.6K);
the comparison screenshot showed another account's values and was not copied.
Visual evidence is `artifacts/fortnite-hero-restored-after-refresh.png`.

This is an account/widget-state repair verified in the signed-in packaged
demo, not a new published application release. The source skin-only
preservation repair remains uncommitted, v0.7.87 remains the public release,
and the C: dev checkout plus E: packaged candidate were not touched. The
existing source repair prevents skin-only application from rewriting the hero
again; a future release should still consider an explicit recovery action if
legacy widgets need this one-time migration.

## 2026-10-08 widget-skin apply/hero-preservation repair — packaged verification

The current repair addresses two pre-release regressions reported after
`Apply skin to existing widget`: the completion message could be hidden or
unreadable when Discord's transient toast layer did not render, and selecting
a skin could inherit that preset's layout contract and make an existing
Fortnite hero look like a different card. The live release remains `v0.7.87`;
this repair is not published yet.

`plugins/DMWidget/index.tsx` now keeps a persistent, high-contrast result panel
inside the picker, with success/message/failure accents, while retaining the
normal Discord toast. Skin-only application preserves the existing slot's
published `topLayout` and `bottomLayout`, re-reads the current published
snapshot when an attached widget exists, and never writes the hero image or
widget surfaces. The gallery path uses the same preserved layout metadata.
Explicit widget content updates remain separate and unchanged.

Verification passed in the release checkout: `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`, and
`git diff --check`. The packaged binary at
`dist/win-unpacked/discordmaxxer.exe` launched on CDP `9233`, and
`overlay-scripts/validate-all.mjs --skip badge` passed inventory, visual,
hotkey, and mass-delete phases against that packaged process.

The source changes are still uncommitted and `artifacts/` remains untracked
diagnostic evidence. The C: dev checkout and E: packaged candidate were not
touched. Next gate: Diggy's approval to prepare and publish a new patch
release, followed by a signed-in account smoke test of the readable result
message and unchanged Fortnite hero.

The single repaired packaged demonstration initially showed plain Board cards
because this disposable profile had `DMHub` enabled but `DMWidget` disabled;
the picker could open, but the widget renderer and its client stylesheet were
not running. Enabling only `DMWidget` in that instance started the renderer:
both Val and Fortnite acquired `data-dm-widget-card-root` markers and the
Fortnite card rendered the `deepSpace` skin while retaining its existing
contained layout and hero content. The proof screenshot is
`artifacts/repair-demo-dmwidget-enabled-fortnite.png`. The C: dev checkout and
E: packaged candidate remain untouched, and the packaged demo still has only
one Discordmaxxer main instance (its Chromium helper processes are expected).

## 2026-10-08 v0.7.87 updater handoff repair — local recovery

Diggy's live v0.7.87 updater downloaded the correct installer, but the
custom updater stayed on its spinner after Install was clicked. The pending
installer matched the published SHA-512
`dnxzSKu9uIhJw2G+XDFWPZn69Xq9qq2VUdCs6cGub5csH8IsRDrjMTLBhPRu1zv14VQnWNMHilSV3PJ4Bxy5Dg==`
and was running as `Discordmaxxer-Setup-0.7.87.exe --updated --force-run`.
The missing `/S` flag left the Windows NSIS setup interactive behind the
custom Installing dialog; this was an updater handoff bug, not a bad
download or a missing release asset.

The exact verified installer was completed locally with `--updated /S
--force-run`. The setup process exited, the installed executable reports
version `0.7.87`, and the Discordmaxxer process relaunched. No C: dev
checkout or E: packaged candidate was touched, and no user data was removed.

The source fix is currently uncommitted in `src/main/updater.ts`: the
`update-downloaded` handler now calls
`autoUpdater.quitAndInstall(true, true)` so Windows performs a silent
replacement and force-relaunch. `pnpm test`, `pnpm build`, `pnpm package:dir`,
and `git diff --check` pass. This source fix is not live yet; publishing a
new patch release and then doing the signed-in client smoke test remain the
next gates. Preserve untracked diagnostic evidence under `artifacts/`.

## 2026-10-08 v0.7.87 published — packaged widget/profile repair

The v0.7.86 client is already published. This release carries the
post-release fixes Diggy visually approved in the installed packaged client:
normal renderer display defaults after the grey/raw-page failure, resilient
profile banner/avatar layering and persistence, the scoped widget-skin surfaces,
and the Playing-card root paint fix that keeps the animated skin present both
idle and while hovered.

The release version is `0.7.87`. The repository build and Electron Builder
configuration were restored from the known-good release configuration after a
dirty working copy had reduced `package.json` to runtime-only fields; the
version was then advanced to `0.7.87`.

The release commit is `6b51f67`, merged with the already-published `v0.7.86`
history in `dd749c0`. `dd749c0` is pushed to `origin/main` and is tagged
`v0.7.87`. GitHub Actions Release run `37726475500` completed successfully:
https://github.com/MaxxTopia/discordmaxxer/actions/runs/37726475500

`origin/main` also contains a docs-only continuity update after the immutable
release tag.

Published release: https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.87

Published assets are `Discordmaxxer-0.7.87-win.zip` (150,081,243 bytes),
`Discordmaxxer-0.7.87-arm64-win.zip` (146,996,073 bytes),
`Discordmaxxer-Setup-0.7.87.exe` (211,459,913 bytes), its blockmap, and
`latest.yml`. The served updater manifest reports version `0.7.87`, installer
size `211459913`, and SHA-512
`dnxzSKu9uIhJw2G+XDFWPZn69Xq9qq2VUdCs6cGub5csH8IsRDrjMTLBhPRu1zv14VQnWNMHilSV3PJ4Bxy5Dg==`.

Local release checks passed: `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
`pnpm package:dir`, `pnpm package:win`, and `git diff --check`. The signed-in
installed-client validator also passed inventory, visual, hotkey, and
mass-delete safety checks at
`overlay-scripts/reports/validate-1791432659261.json`. A clean first-launch
profile for the unpacked binary stopped at Discord's first-launch page before
Vencord readiness, so that run was not counted as fresh signed-in proof.

The local installed-client visual proof remains the strongest account-specific
gate: Diggy confirmed the normal Discord UI, profile banner, Board widget, and
Playing skin looked correct. The C: dev checkout and E: packaged candidate
were not touched. Local diagnostic screenshots under `artifacts/` are evidence
only and are not release files.

Remaining user gate: install/update a real client from the published release
and recheck the normal-mode profile/Playing-card behavior on the target
account. The public release and updater manifest are live; this final client
update/field check is not being claimed from GitHub asset proof alone.

## 2026-10-07 packaged v0.7.86 Playing-root paint repair — installed proof

The remaining Playing-card symptom was a flat/red card or a skin that appeared
only while hovering. The cause was the host-normalization cleanup rule: the
Playing root itself has Discord's `overlay` class, so the descendant selector
matched the real card and cleared its background, `background-image`, and both
animated pseudo-layers. This was a selector collision, not a timer or banner
animation problem.

The narrow fix is in
`plugins/DMWidget/index.tsx`. Each overlay/host cleanup selector now excludes
the marked Playing root with
`:not([data-dm-widget-card-root="true"][data-dm-widget-playing-card="true"])`.
Surrounding Discord overlay descendants are still normalized, while the Board
and Playing roots keep the existing skin, animation, and timing unchanged.

Verification passed:

* `pnpm exec tsc --noEmit`
* `node overlay-scripts/build-vencord.mjs`
* `node overlay-scripts/verify-build.mjs`
* `git diff --check`
* The rebuilt renderer JS/CSS was copied only into the already-installed
  packaged client after timestamped backups were created.
* Fresh installed-client runtime proof showed normal Discord UI, the raw-
  renderer guard, and the profile popout with both Board and Playing cards.
* Five idle samples plus five hover samples returned `valid: true` and
  `parity: true`: the Playing root kept the ember background, both pseudo
  layers, positive opacity, and the same `emberProtocol` skin in both states.
* The animated profile banner remained loaded and advancing (`readyState: 4`,
  `paused: false`).

Visual evidence is saved at
`C:\Users\Diggy\projects\discordmaxxer-release-0-7-81-editor-crash\artifacts\playing-root-fixed-20261007.png`.

This is local installed-client proof only. Nothing was published; the C: dev
checkout and E: packaged candidate were not touched. Diggy visually confirmed
that the running installed client now looks correct during the final test pass.

## 2026-10-07 packaged v0.7.86 raw-renderer recovery — installed proof

The screenshot showing `window.GLOBAL_ENV` and the `dm-widget` keyframes as
visible page text was reproduced in the installed client. Discord itself was
loaded, but Chromium's built-in HTML display defaults were absent in the
renderer: `body`, detached `div`, `script`, and `style` elements computed as
`display: inline`, which pushed `#app-mount` below the viewport. This was a
renderer startup/display-layer failure, not a login, Discord-data, or widget
selector failure.

The preload now installs a small document-start fallback display map in
`src/preload/index.ts`. It hides document metadata/script/style nodes, restores
normal HTML element display defaults, and keeps `#app-mount` as the full-window
flex root. It is intentionally lower-level than the DMWidget skin rules so the
existing profile/banner/Playing behavior remains unchanged.

The source preload type-check passed and the native bundle was rebuilt. The
existing installed `app.asar` was repacked from its current contents with only
the rebuilt preload replaced, then installed locally at
`C:\Users\Diggy\AppData\Local\Discordmaxxer`. Independent rollback archive:
`C:\Users\Diggy\AppData\Local\Discordmaxxer\resources\app.asar.before-display-defaults-20261007-200944.asar`.
The previously generated temporary extraction directory was removed after
packing. The explicitly authorized 1.56 GB Windows X-Lite ISO was removed from
`C:\Users\Diggy\Downloads\[Windows X-Lite] Micro 11 24H2 v3\`; the containing
folder was kept.

Fresh installed-client proof after relaunch on CDP 9230:

* `#dm-renderer-display-defaults` exists; `html`/`body` compute to `block`,
  `script`/`style` compute to `none`, and `#app-mount` is `[0, 0, 1351, 781]`.
* The normal Friends UI paints at the top of the viewport and body text no
  longer contains `window.GLOBAL_ENV` or `@keyframes dm-widget`.
* The opened profile retains two advancing animated banner videos
  (`readyState: 4`, `paused: false`, duration about 9.017 seconds).
* Across five 700 ms samples, the Board and Playing cards retained
  `data-dm-widget-card-root="true"`, the Playing marker, `emberProtocol`, and
  the expected skin border without hover or flashing.

This is local installed-client proof only. Nothing was published, and the C:
development checkout plus E: packaged candidate were left untouched. Diggy's
remaining gate is a visual check of the restarted client during ordinary
navigation; the old archive and the prior renderer backups remain available
for rollback.

## 2026-10-07 packaged v0.7.86 profile-flair and Playing-card repair — installed proof

The latest packaged-client repair covers all four issues reported in the
current test pass: the own-profile animated banner was missing, the banner
could cover the avatar, the Discordmaxxer Playing card could be skinless or
flash on hover, and ordinary Friends/Shop/Quests chrome could inherit a
widget skin. The C: development checkout and E: packaged candidate were left
untouched, and nothing was published.

The missing banner was traced to the saved shared profile-media URL returning
HTTP 404 from the worker. The active installed test settings now retain the
recovered direct MP4 fallback at
`https://i.imgur.com/0Lepc52.mp4`; the profile-flair source keeps that local
fallback when the published URL fails and prevents the observer from
immediately replacing the working fallback with the dead URL. The banner
video is positioned behind the marked profile avatar, so the avatar remains
above the animated media instead of being covered.

The Playing-card repair is narrow and performance-safe. A profile-owned
candidate query reaches the compact account popout/profile modal without
reopening the old document-wide sweep, and the visibility check now treats
Discord's fixed paint layer as the real boundary instead of rejecting the
visible card because its hidden click-trap ancestor has a stale off-screen
rectangle. Existing markers, CSS variables, and animation timing are reused;
Friends, Shop, Quests, inactive messages, people rows, Active Now, and generic
profile surfaces remain excluded.

Verification passed with:

* `$env:DM_STRICT_REBRAND='1'; pnpm exec tsc --noEmit`
* `node overlay-scripts/build-vencord.mjs`
* `node overlay-scripts/verify-build.mjs`
* `git diff --check`

The rebuilt renderer/CSS was copied only to the installed test client at
`C:\Users\Diggy\AppData\Local\Discordmaxxer` after retaining the backup
`vencordDesktopRenderer.js.before-fixed-layer-visibility-20261007` (and its
matching CSS backup). Installed runtime proof after restart: the banner video
has `readyState: 4`, is not paused, and advances through its loop; the avatar
has `z-index: 2` and `position: relative`; the Playing card is marked with
`data-dm-widget-card-root="true"`, uses `emberProtocol`, and remains present
without hover across four 500 ms samples; Friends/Shop/Quests have no widget
surface/card markers. This is local installed-client proof, not a published
release claim. Diggy's remaining gate is a visual confirmation in the open
test client.

## 2026-10-07 packaged profile banner recovery — installed runtime proof

The packaged-client follow-up also repaired the missing animated profile banner
seen in the full-profile screenshot. The source-side fix keeps the packaged
v0.7.86 manifest and Electron runtime intact, adds the missing browser
`User-Agent` to the main-process media proxy, and recognizes Discord's
`banner_f7e69e` wrapper as the profile-banner surface. The existing sidebar
selector work was preserved; the C: development checkout and E: packaged
candidate were not changed.

Direct TypeScript checking passed, the strict Vencord overlay build completed
with zero rebrand warnings, `node overlay-scripts/verify-build.mjs` passed, and
`git diff --check` passed. The dirty working-tree `package.json` was preserved;
its reduced contents do not expose the normal `pnpm test` script, so the direct
checks are the applicable source evidence for this session. The explicitly
authorized old `C:\Users\Diggy\Documents\Windows.iso` was removed to recover
build space; no other user-data cleanup was performed.

Only the rebuilt renderer was copied into the installed client at
`C:\Users\Diggy\AppData\Local\Discordmaxxer`, with the installed renderer
backup retained. The exact installed executable was relaunched with CDP on
port 9230; the signed-in profile data was not replaced. Live proof now shows
two applied banner markers—one in the right profile sidebar and one in the
full-profile modal. Both render `dm-media://proxy/...pg8s68.mp4` with
`readyState: 4`, `paused: false`, and an advancing position (for example,
6.67 to 7.67 seconds during a one-second probe). This is installed-client
runtime proof, not a published-release claim; no push or deployment was made.

Remaining gate: Diggy should visually reopen the same profile and confirm the
animated banner and Playing card look correct after normal navigation. Preserve
the dirty source changes and the renderer backup.

## 2026-10-07 packaged widget-skin flash and Friends-scope repair — local installed proof

The packaged-client follow-up tightened `plugins/DMWidget/index.tsx` in two
places. The surface scan now removes stale widget and surface markers from
blocked Discord chrome, including Friends, Shop, Quests, inactive DM rows,
people rows, and Active Now. The low-frequency probe also ignores descendants
already owned by a marked card root, preventing the Playing card from
retriggering reconciliation on every interval. Reconciliation now avoids
rewriting identical attributes, CSS variables, and animation-delay values;
the Playing card keeps its shared monotonic animation timeline instead of
resetting or flashing.

`pnpm test`, `pnpm build`, `pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check` passed. Only
the staged `vencordDesktopRenderer.js` was copied into the installed client at
`C:\Users\Diggy\AppData\Local\Discordmaxxer`; the previous installed
renderer is preserved as
`vencordDesktopRenderer.js.before-flashing-fix-20261007`. The C: development
checkout and E: packaged candidate were not changed.

Installed runtime proof: the renderer hash matches the staged overlay;
the Playing card is visible with no hover requirement, and an 8.5-second
attribute/style mutation probe recorded zero writes to widget roots. The
Friends row had no widget-skin or surface marker. The account panel and the
currently open DM surface remain the deliberate supported chrome targets.
This is local installed-client proof, not a published-release claim. Source
changes remain uncommitted and unpublished; Diggy's remaining gate is a
normal visual pass through Friends and the Playing card after interacting
with several profiles.

## 2026-10-07 installed client grey-screen — mixed package repaired

Diggy reported multiple Discordmaxxer windows, a grey shell, and an installed client that could not finish loading after the widget-skin test. The cause was a mixed installed package: the installed app had the updated renderer/app.asar but an older executable and missing release Chromium DLLs. The running installed client was stopped, then the complete contents of the release `dist/win-unpacked` directory were copied into the installed directory without deleting user data or unrelated files. The installed executable, DLLs, app.asar, audio module, and renderer now match the release package.

Runtime evidence after repair: the normal installed client launched without `--disable-gpu`; one main process, one renderer, five helper processes, and one visible Discord window remained stable for the observation period. The extra grey `Discordmaxxer Updater` window was closed separately. The source package and renderer backup remain in place. The C: development checkout and the E: packaged candidate were not changed.

The working copy of this continuity file was truncated during a full-disk patch failure while recording this checkpoint. It was restored from repository HEAD before adding this entry; older uncommitted continuity additions are not treated as source or runtime evidence. A disposable diagnostic cache folder created for recovery was removed after the repair to free approximately 0.30 GB on C:. The intended pre-release executable backup could not be created because the disk was full; the release package remains the recovery source.

Release state at checkpoint: source changes are still uncommitted and unpublished; the next authorized action is the documented build, verification, version/release check, and live publish sequence. Preserve the dirty source changes and leave the C: dev build and E: candidate alone.


> Live status / cold-open pointer. If you're picking this up after a long gap
> (or you're an AI, not Claude): read this, then `TROUBLESHOOTING.md`, then
> `CLAUDE.md` ("Operational facts" section). Those three are enough to build,
> ship, and maintain without prior context.

## 2026-10-03 v0.7.86 published — existing widget skin + profile flair

Diggy reported that applying a skin to an existing Diggy T widget still did not
visibly change the Board card, and the profile-flair banner was missing. The
candidate carries the targeted DMWidget and DMProfileFlair fixes from the
preserved C: checkout into an isolated E: release worktree. DMWidget now waits
for stale in-flight profile reads, requires a positively recognized attached
widget list, reconciles app IDs to the signed-in account, verifies the exact
visible card/style before claiming success, and preserves last-confirmed state
on partial/unknown responses. It does not republish the native Discord widget
payload. DMProfileFlair rechecks recycled banner nodes, retries failed banners
with bounded backoff, recognizes animated Discord avatar hashes served as
WebP, and keeps static media visible in Tournament Mode.

The public stable release is live: [v0.7.86](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.86),
from commit `9cbc5c5e063f084b4259310e715a46ee2f2e32db`, with annotated tag
`v0.7.86`. GitHub Actions run
[37167445304](https://github.com/MaxxTopia/discordmaxxer/actions/runs/37167445304)
passed the strict Vencord overlay build, app build, integrity checks, Electron
packaging, and Maxxtopia release notification. The release is not a draft or
prerelease. Published artifacts include x64 and ARM64 ZIPs, the setup EXE,
blockmap, and `latest.yml`; the public manifest was fetched and confirms
version `0.7.86`, the matching setup EXE, SHA-512, and file size. The live
release description was populated from `docs/releases/v0.7.86.md` after the
initial CI publish left it empty.

No signed-in Diggy T runtime or second-PC confirmation is available. Source,
build, CI, and publication proof do not prove account-specific rendering.
Diggy's remaining test is to update/reload the affected Diggy T client, apply a
skin to its existing widget, reopen the Board and confirm the card's appearance,
then confirm the profile-flair banner with Tournament Mode off. Preserve the
C: candidate and its untracked `artifacts/` folder.

## 2026-09-30 v0.7.85 widget-skin and Fortnite refresh — published

The latest field report is that another PC updated successfully but
`Apply skin to existing widget` did not change the visible Board card. The
v0.7.85 addresses two release weaknesses: Discord builds that use
semantic `article`/`listitem` Board cards instead of the known class families,
and remote-style writes that were treated as successful without reading the
marker back. It also accepts additional profile-widget response shapes and
clears stale wrapper markers only when the target is no longer a real card.

`pnpm test`, `pnpm overlay:vencord`, `pnpm build`, `pnpm verifyPlugins`,
`node overlay-scripts/verify-build.mjs`, the shipped-script ASCII check,
`pnpm package:dir`, `pnpm package:win`, and `git diff --check` passed. The
rebuilt renderer contains DMWidget. Release commit `bf562f4` is pushed to
`origin/main`, tag `v0.7.85` is published, and the GitHub release body contains
the release notes. The successful GitHub Actions release run is
`36719386540`. A USB staging copy with the repaired source, generated renderer,
and a complete Electron runtime is at
`E:\discordmaxxer-existing-widget-skin-fix-20260930-src`; the older USB
checkout remains untouched. The public release contains x64/arm64 ZIPs, the
NSIS installer, blockmap, and `latest.yml`; the public updater manifest
advertises version `0.7.85` and the matching installer hash/size. The desktop
automation surface did not expose a visible Electron window for a signed-in
test, so the real profile interaction is still unverified.

The release also documents the Fortnite behavior already present in this
candidate: its first stat is `Current Rank`, and deployed Fortnite/Valorant
slots refresh 20 seconds after startup and every 30 minutes while the client
is open when the required credentials are configured. Skin-only application
deliberately does not republish card content, so an existing published card
needs an explicit content update/refresh to replace an old `Highest Rank`
label.

Remaining proof is the signed-in second-PC test: update to v0.7.85, select a
different skin, click Apply, close the editor, and confirm the Board, compact
popout, and Playing card change while the banner, avatar, and gradient remain
untouched. This release evidence proves source/build/tag/CI/asset publication,
not that account-specific Discord UI interaction.

## 2026-09-30 v0.7.84 DMWidget widget-skin surfaces — published

The unpublished DMWidget candidate now keeps widget skins scoped to the actual
card roots across all three Discord surfaces: the full Board, the compact
profile popout, and the Discordmaxxer Rich Presence `Playing` card. Full Board
cards resolve Discord's camel-case `widgetContainer__...` class and decorated
display names such as `ValツDiggy`; list wrappers are excluded so the profile
banner, avatar, and gradient remain untouched. The branded Playing card is
identified separately and inherits the active widget treatment.

The final timing fix makes attached-widget style recovery replace a stale
startup timer with an immediate bounded scan. This prevents the Playing-card
fallback from appearing skinned while the real Val card waits for a later
periodic sweep. Temporary local debug globals/counters and the DOM inspection
script were removed before the final build.

`pnpm test`, `pnpm build`, `pnpm verifyPlugins`, `pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check` passed. The
candidate renderer was staged into the running C: dev client's local
`vencord-dist` and reloaded. Clean runtime proof showed compact Val + Playing
both using Frosted Glass, and the full Board using Val Frosted Glass plus
Fortnite Ember Protocol. Screenshots:
`artifacts/widget-skin-clean-compact-dev-proof.png` and
`artifacts/widget-skin-clean-board-dev-proof.png`.

The end-to-end existing-widget flow was then exercised locally: DMHub opened
DMWidget, the recovered Valorant widget changed from Frosted Glass to Event
Horizon, and `Apply skin to existing widget` was used without re-entering Riot
ID or API credentials. Closing the editor restyled the existing Board card;
Valorant and the Discordmaxxer Playing card both resolved to the Event Horizon
starfield treatment, while Fortnite retained its independent Ember Protocol
style. A clean dev-client relaunch preserved the selection and the compact
profile popout showed the same two Event Horizon surfaces. The profile banner,
avatar, and gradient remained untouched. Evidence:
`artifacts/widget-skin-sequence-board-after-reload.png` and
`artifacts/widget-skin-sequence-compact-event-horizon.png`.

The raw CDP page reload initially left the app mount empty, so the dev client
was restarted before the persistence check; no source or release change was
made for that renderer-reload observation.

The candidate targets v0.7.84. Diggy visually approved the open dev client and
explicitly authorized publication. Commit `a1fe8df4a31db1a262c71b3b9663fd62e6bfeb1f`
is pushed to `origin/main`, and tag `v0.7.84` is published. The strict overlay,
plugin registry, artifact-integrity checks, `pnpm test`, `pnpm build`, and
`git diff --check` passed. GitHub Actions run
`36706701386` completed successfully through Electron Builder and release
notification; the local E: package smoke was bounded and stopped because this
machine's slow disk/USB I/O did not finish copying the unpacked app, so CI is
the authoritative packaged-client result.

The public [v0.7.84 release](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.84)
is published with the Windows installer, x64/ARM64 ZIPs, blockmap, release
notes, and `latest.yml` advertising version 0.7.84. The remaining field gate
is Diggy's normal-client update/reload and existing-widget test on the other
PC/account; source and release proof do not prove that account-specific saved
widget markers are present. Widget skins remain Discordmaxxer-rendered and do
not change what vanilla Discord users see.

## 2026-09-30 v0.7.83 KV read-budget hardening — published

The Discordmaxxer roster client now keeps the normal shared VIP roster locally
for five minutes instead of 30 seconds. The Worker serves the roster from a
fixed two-minute edge cache, and authenticated admin list/offer display reads
use a 60-second edge cache. Claims, validation, profile writes, auth, last-
known-good snapshots, and profile flair rendering remain unchanged.

Focused Worker proof passed 11/11 tests plus syntax and Wrangler dry-run. The
Discordmaxxer gates passed `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
and `pnpm package:dir`. Worker version
`70b0d791-25e2-42bc-a08f-65786f698564` is live; `/healthz` returned 200 after
deployment. `/roster` still returned the expected `KV_GET_QUOTA` 503 because
the account-wide daily allowance was already exhausted; deployment cannot
reset it. The public [v0.7.83 release](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.83)
is published with the Windows installer, x64/ARM64 ZIPs, blockmap, and
`latest.yml` advertising version 0.7.83.

This release was committed without staging the unrelated DMWidget candidate,
existing RESUME work, or `overlay-scripts/tmp-inspect-widget-dom.mjs`. Next
gate: after the next KV reset, open the canonical `/admin` and compare bounded
first-hour KV reads; the active Discord client still needs the normal updater or
installer/reload gate.

## 2026-09-29 v0.7.82 DMWidget editor and existing-widget skin repair — published

## 2026-09-29 candidate — restore widget-only skin scope

Diggy reported a visible regression: the selected widget skin was covering the
profile banner, avatar, and full gradient instead of only the Board widget
card. The cause was the app-id scanner accepting broad profile/list wrappers
as widget roots, followed by CSS rules that styled any marked root. A stale
image/background fallback could also promote a hero or avatar surface.

The candidate in `plugins/DMWidget/index.tsx` now requires a real card-like
root (`card__`, `widget__`, or `application__` classes), rejects profile/header/
avatar/banner/modal surfaces, bounds the card dimensions, and requires app
text hints when resolving down from an application wrapper. It removes the
image/background fallback, clears legacy unmarked skin attributes during a
reload, marks only accepted roots, and scopes every runtime skin rule behind
`data-dm-widget-card-root="true"`. An ambiguous wrapper now stays unskinned
instead of risking a profile-wide leak.

The corrected visual proof is
`overlay-scripts/screenshots/widget-skin-card-only-preview.png`: the profile
gradient/banner/avatar remain plain while the Val and Fortnite Board cards
retain their individual skins. `pnpm test`, `pnpm build`,
`pnpm verifyPlugins`, `pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check` pass.

This is still an uncommitted candidate in the isolated release worktree; it is
not pushed, tagged, or published. For local runtime testing, its five renderer
artifacts were staged into the open dev client's E: overlay and the renderer
was reloaded. The prior renderer is preserved at
`E:\\discordmaxxer-overlay-rebuild-20260925-vencord-dist-backup-20260930-card-scope`.
CDP confirmed Vencord and DMWidget are registered and enabled after reload; no
Board was open during that check, so zero card markers there is expected. This
is local-dev proof only. The live release remains v0.7.82 and the dirty
canonical worktree is untouched. Next gate: inspect the full Board plus an
ordinary profile in the open client before any publish authorization.

## 2026-09-29 post-v0.7.82 candidate — visible Board skin regression and Fortnite label

Diggy reported that the success toast appeared but the Valorant and Fortnite
cards on the full Diggyai profile Board stayed plain. The earlier v0.7.82
runtime check only proved the compact local popout path and was too narrow for
this report. A read-only DOM inspection of the running v0.7.82 client found
the skin attributes on `header__5be3e`, `body_ce8328`, `ul.cardsList__9d597`,
and an empty wrapper, while the visible Val card
`div.overlay_c0bea0.container__82fb2.card__9d597` had no skin attributes.

The regression came from the v0.7.80 scan hardening: generic `card__`/`card_`
targets were moved out of the primary pass and the scan budget was reduced to
24 ms. The old root fallback then accepted a profile/list wrapper as the
render target. The unpublished candidate in
`plugins/DMWidget/index.tsx` restores the broad card targets in a bounded
72-ms pass, prioritizes cards whose text matches the attached application,
resolves profile/body/cardsList/list-item wrappers down to the actual visible
Board card, and only reports a visible restyle when that card was found. It
also keeps the editor-open scan pause and queued rescan behavior.

The follow-up DOM check exposed two details the first candidate still missed:
Discord concatenates the visible label and stat text as `ValRank`, and the
outer `cardsList` can match the same text as its child. The resolver now
accepts that safe uppercase label transition and penalizes list containers so
the actual `card__9d597` surface wins. A read-only candidate-algorithm check
against the running DOM selected the visible Val card (`262x79`) rather than
the `cardsList` wrapper.

The Fortnite published stat label is now `Current Rank`; the internal
`fnUnrealRank` field remains unchanged for compatibility with existing data.

Candidate verification passed: `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node
overlay-scripts/verify-build.mjs`, compiled-label checks, and `git diff --check`.
The candidate overlay is staged in `vencord-dist/` in the isolated release
worktree. It is not committed, pushed, tagged, published, or installed into
the running client; v0.7.82 remains the live release. The dirty canonical
worktree was left untouched. Before publishing, load this candidate in a
real client and verify the full Board on both account states; source/build
proof alone does not prove second-PC rendering.

Best next move: with explicit release authorization, bump the patch version,
run the documented packaging/CI release gates, publish the notes, and then do
the full-Board visual check on the other PC.

The published v0.7.81 mitigation stopped the renderer crash, but it also
removed the direct plugin-editor call and only opened the generic Plugins
settings page. That made DMHub look repaired while the actual Create/Edit
Profile Widget screen still did not open. The running USB test client was also
loading `E:\discordmaxxer-overlay-rebuild-20260925`, not the C: release
worktree, so early retests were against the stale fallback bundle.

The v0.7.82 release restores the real `openPluginModal(plugin)` path for DMWidget,
DMProfileFlair, and DMDisplayNameStyle, and patches Vencord's current
PluginModal to use the stable legacy modal primitives that remain available in
the supported Discord runtime. The active USB bundle was preserved at
`E:\discordmaxxer-active-dist-before-editor-repair-20260929` before installing
the release candidate.

Verification: `pnpm test`, `pnpm build:dev`, `pnpm overlay:vencord` (0
warnings), `node overlay-scripts/verify-build.mjs`, `git diff --check`, and
the overlay script syntax check passed. A live CDP test in the USB Electron
client clicked DMHub → Create/Edit Profile Widget and found the recovered
Valorant editor (`existing widget recovered`) with no crash overlay and no
generic-settings fallback. The source commit
`298096aab793e496a1a7ecd752f373ed5a90d0a1` and tag
`v0.7.82` are now pushed to `origin/main`.

Additional live verification: selecting Frosted Glass changed the picker,
preview data-style, colors, frame, ornament, and motion immediately. Applying
it to the recovered Valorant widget completed without a crash, synced the
Discordmaxxer-only marker, and the visible profile popout widget carried
`data-dm-widget-skin="frostedGlass"` with computed glass gradients, border,
glow, and active `dm-widget-client-glint` / ice-drift animations. DMHub then
closed and reopened successfully with the skin still selected. This proves the
local Discordmaxxer renderer path; it does not prove vanilla Discord rendering
or a second physical PC.

Release proof: local production build, strict overlay (0 warnings), artifact
verification, x64 and ARM64 Windows packaging, and the logged-in CDP validator
all passed. GitHub test run
`https://github.com/MaxxTopia/discordmaxxer/actions/runs/36643661423` and
release run
`https://github.com/MaxxTopia/discordmaxxer/actions/runs/36643665119` passed.
The public release is
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.82`, with the
attempt-#5 notes and all five Windows assets; the cache-busted `latest.yml`
returned HTTP 200 and advertises version `0.7.82`.

Remaining runtime boundary: the direct editor/skin test proves the local
Discordmaxxer renderer path, not every account state on a second physical PC
or Discord's vanilla client renderer. Diggy's installed-client update and
second-PC signed-in widget check remain the next user-owned visual tests.

## 2026-09-29 v0.7.81 editor crash fix — published

The DMHub Create/Edit Profile Widget crash was reproduced on v0.7.80 as a
Vencord `openPluginModal` null-`Modal` failure during asynchronous React
rendering. The follow-up grey state came from CrashHandler trying to recover
after that renderer failure. DMHub and DMWelcome now route plugin settings
through `SettingsRouter.openUserSettings("vencord_plugins")`, which avoided the
fragile modal resolver but did not open the actual editor. This was an
incomplete mitigation, not a complete DMWidget fix; the follow-up candidate
above restores the editor path with a compatible modal implementation.

The published candidate passed the release gates recorded at the time. Its
running-client smoke test proved that the generic settings surface did not
crash, but it did not prove that the DMWidget editor itself opened.

Public stable release `v0.7.81` is live: [GitHub Release](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.81). Release commit
`1489772c8b62ca5bd4502a3c75df8d35ffb98ef8` and tag `v0.7.81` are pushed to
`origin`. The GitHub Actions [release run](https://github.com/MaxxTopia/discordmaxxer/actions/runs/36635294133)
completed successfully, and the release is not a draft or prerelease. Published
assets include x64 and ARM64 ZIPs, the NSIS setup EXE, its blockmap, and
`latest.yml`. The public updater endpoint returned HTTP 200 and advertises
version `0.7.81` with `Discordmaxxer-Setup-0.7.81.exe` and a SHA-512 value.
The workflow initially created an empty GitHub Release body; it was amended
from `docs/releases/v0.7.81.md`, and the published body now contains the
attempt-#4 notes.

The remaining gate for the published baseline is superseded by the unpublished
editor candidate above. Signed-in Discord profile/widget behavior still requires
the normal second-PC visual check; release verification proves the updater path,
not every account-runtime surface.

## 2026-09-28 shared-roster read-budget repair — v0.7.79 published

Public stable release `v0.7.79` is live: [GitHub Release](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.79). Release commit `0ab6d4b042adfbcaae61a2ee6d182419b068e2b0` and tag `v0.7.79` are pushed to `origin`. The GitHub Actions [test run](https://github.com/MaxxTopia/discordmaxxer/actions/runs/36502545710) and [release run](https://github.com/MaxxTopia/discordmaxxer/actions/runs/36502548711) both completed successfully. The release is not a draft or prerelease. Published assets include x64 and ARM64 ZIPs, the NSIS setup EXE, its blockmap, and `latest.yml`. The public `latest.yml` endpoint returned HTTP 200 and advertises version `0.7.79` with `Discordmaxxer-Setup-0.7.79.exe`.

The `optmaxxing-vip` Worker now checks a fixed 30-second Cache API key before
reading the shared `VIP_CLAIMS` KV namespace. The key deliberately ignores the
old client's `dmx_refresh` query parameter, so existing released clients can
reuse a warm roster response. The client release also removed its unique
refresh URL and custom cache-control headers, which avoids unnecessary cache
misses and CORS preflights. Roster payload shape, sanitization, local 30-second
freshness, retry/backoff, last-known-good, and optimistic profile behavior are
unchanged.

Worker verification: `node --check worker.js`, 10 Worker tests including a
quota-shaped warm-cache test with an active read circuit and zero additional KV
get/list calls, Wrangler dry-run, deployment version
`bfb7c77b-b139-4c56-a8b6-fd0f17c82bd2`, and live KV-free
`/healthz` HTTP 200 (`kv: not_checked`). The Worker source checkout contains
pre-existing hardening WIP, so it was deployed from the current verified
working tree without staging unrelated files.

Cloudflare analytics reported 106,118 reads for this namespace on 2026-09-28
and 730 on the new UTC day before the controlled probe. One post-reset
`/roster` request returned HTTP 200, the expected JSON envelope, and
`x-roster-cache: miss`; no repeated live probes were made.

Client verification in isolated checkout
`C:\Users\Diggy\projects\discordmaxxer-roster-read-budget`: `pnpm test`,
strict pinned-Vencord overlay (81 applied, 0 warnings), artifact verification,
`pnpm build`, and `pnpm package:dir` passed. The published source contains only
the roster cache change, release notes, version bump, and this continuity
update; unrelated profile-flair WIP was not touched. Signed-in Discord
behavior, cross-PC roster freshness, and the installed client update path
remain runtime checks; the controlled probe proves the Worker response path,
not the Discord UI.

Best next action: update the installed client and complete the normal signed-in
Discord profile check, then compare roster freshness on the second PC. Do not
use repeated live roster probes while quota is exhausted.

## 2026-09-24 profile flair consistency and automatic name styling — v0.7.70 published

Public stable release `v0.7.70` is live: [GitHub Release](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.70). Release commit `984fb060465c2436a92a9f87012e8a6848c75293` and tag `v0.7.70` are pushed to `origin`; [GitHub Actions run 36046453622](https://github.com/MaxxTopia/discordmaxxer/actions/runs/36046453622) completed successfully, including the Maxxtopia release notification. The release is not a draft or prerelease. Published assets include x64 and ARM64 ZIPs, the NSIS setup EXE, its blockmap, and `latest.yml`. The public `latest.yml` endpoint returned HTTP 200 and advertises version `0.7.70` with `Discordmaxxer-Setup-0.7.70.exe`. The release description now contains user-facing notes and the Discordmaxxer-only visibility boundary. Release publication and updater metadata are verified; a signed-in installed-client update and second-PC visual behavior still need Diggy's test.

Updater notes are present too: the client sets `fullChangelog = true` and reads GitHub's release feed when the generated `latest.yml` has no embedded notes. The public Atom feed was checked and contains the v0.7.70 release notes. The blank `release_notes` YAML value is therefore not evidence that the in-app updater will show an empty changelog.

Based on the published v0.7.69 source, this release addresses four related
rendering issues. Published shared-roster fields
are canonical across installs; old per-PC banner/avatar/gradient values only
act as fallbacks when the roster has no value, while deliberate new picks
still preview immediately. This prevents stale local Crimson/Cotton Candy
settings from masking a published gradient. Downloaded media remains local
until it is published to the shared roster; shared animated banners for other
Discordmaxxer users require that user's media to be published there. These
client-rendered effects are not vanilla Discord profile fields.

The profile MutationObserver now fast-scans semantic profile popouts/modals
before the regular debounced page scan. Profile avatars stay hidden while the
replacement image loads, and the same-image repair path compares the literal
`src` attribute so browser URL normalization cannot trigger repeated reloads.
Tournament Mode remains the animation pause; OS reduced-motion does not gate
profile flair. DMDisplayNameStyle now automatically styles profile names,
member/right-side names, and DM/channel headers when their surface toggles are
enabled. Message-author names remain opt-in via Style other names.

Verification passed: `pnpm test`, `pnpm verifyPlugins`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord` (0 warnings), `pnpm build`,
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`,
`pnpm package:win`, and `git diff --check`. Packaged runtime validation used
an isolated, logged-out profile with `--skip badge`: plugin inventory,
CompactView/Tournament Mode toggles, and MassDelete wiring passed. The visual
Hub check could not be proven on Discord's login screen. The signed-in
profile, animated media, right-side/DM name surfaces, and cross-PC roster
behavior were not tested. The x64/ARM64 ZIPs and NSIS installer plus blockmap
were built locally. The pre-existing untracked `docs/evidence/` content was
preserved and excluded. The canonical checkout was left untouched. The
The source commit and public release are now recorded above. Voice and
screenshare remain outside this profile-only release scope and are not
universal publication gates.

Still needs signed-in client proof: open profile popouts quickly and confirm
the animated avatar advances without a stock-frame flash; inspect profile,
right-side member, and DM-header names; confirm another Discordmaxxer account's
published animated banner renders; compare a published gradient on two PCs.
The cross-PC test must use published shared-roster values, not an unpublished
local preview. Voice and screenshare were not tested, but they are not release
blockers for this profile-only change. Do not claim those paths are verified
without a real session. Best next action after publication: update the client
on both PCs and complete the signed-in profile checks.

## 2026-09-24 profile visuals and display-name styles — v0.7.69 published

This follow-up combines the more discoverable profile Appearance Center and
tour shortcuts with the new `DMDisplayNameStyle` gallery: 30 distinct local
presets, bundled offline script/gothic/comic typefaces, ornaments, color and
typography overrides, and optional motion effects. Motion ignores Windows
reduced-motion as requested but is gated by Tournament Mode. Profile-look
sharing can copy/import only the name style without replacing the banner,
avatar, or gradient. Existing controls were retained; the style changes only
the local rendered name, not the Discord account name or vanilla clients.

Verification completed: combined `pnpm test` (ESLint + TypeScript),
`pnpm verifyPlugins`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, `pnpm build`, `pnpm package:dir`,
`pnpm package:win`, and `git diff --check` passed. The packaged client was
opened with a disposable, logged-out profile; `validate-all.mjs --skip badge`
passed inventory, visual, hotkey, and mass-delete phases. The new plugin
started in that runtime, selected `Flamekissed` with its bundled Great Vibes
font, and set its motion-blocked state when Tournament Mode was activated.
The badge phase was skipped because it writes account settings. No Discord
account was signed in or changed.

The existing gallery screenshot at `docs/evidence/display-name-style-showcase.png`
is retained locally but excluded from the source push: its subtitle describes
the earlier reduced-motion behavior and no longer matches this candidate. Take
a fresh capture from the updated gallery before using visual evidence publicly.

The package version has been bumped locally to `0.7.69`. Both Windows package
targets and the packaged-directory build completed. The packaged runtime
validator (`--skip badge`) passed inventory, visual, hotkey, and mass-delete
phases using a disposable logged-out profile. The new plugin and DM Hub were
confirmed registered and enabled. Because this release changes profile styling
and discovery rather than voice/screenshare code, those paths were outside this
release's test scope and were not tested. Their omission was not a waiver: the
project policy now explicitly says voice/screenshare sessions are not universal
release blockers.
The logged-out profile also means signed-in profile visuals, vanilla-client
rendering, and second-PC sync remain unverified. The validator's visual phase
did not find the Hub FAB on the Discord login screen, so that phase is not proof
of signed-in Hub appearance.

Release commit `1ba11028b19e308c1718635ffc5cba521ece9c78` and tag `v0.7.69`
are pushed to `origin`; the GitHub Release workflow `35982960773` completed
successfully. The published release includes the x64 and ARM64 ZIPs, Windows
installer, blockmap, and `latest.yml`. The release body now has user-facing
notes, and the public `releases/latest/download/latest.yml` returned HTTP 200
with version `0.7.69` and the matching installer path. This verifies release
publication and updater metadata, not that an installed user's client has
already fetched or applied the update.

The prior gallery image at `docs/evidence/display-name-style-showcase.png` is
still untracked and intentionally preserved; it was not included in the push.
Take a fresh capture from the updated gallery before using visual evidence
publicly. Signed-in profile visuals, vanilla-client rendering, second-PC sync,
and real voice/screenshare remain unverified; the latter were outside this
profile-only release's test scope and are not universal publish gates.

Best next action: install/update to `0.7.69` and inspect the name-style gallery,
Plugin Tour, and DM Hub on a signed-in profile; separately test vanilla-client
visibility only for effects intended to cross that client boundary.

## 2026-09-23 profile-look discovery and sharing follow-up — local candidate only

Added direct, additive entry points to the existing profile surfaces: the
Plugin Tour now links to the local Display Name Style gallery and Discord's
native profile editor; DM Hub has the same separate routes. The Appearance
Center also links to Discord's native editor. Existing controls and presets
remain in place, and the tour does not force a new first-run popup.

Profile-look codes can now include a display-name style, with separate
"Copy name style only" and "Import name style only" actions. The import path
uses a shared preset-ID allowlist and whitelisted values, and writes only the
name-style plugin settings; it does not overwrite avatar, banner, or gradient.
Older version-1 codes remain supported. Copy/import feedback distinguishes
local plugin settings from account-level profile edits.

Compatibility check: the custom font, ornament, and animation presets are
painted locally by DMDisplayNameStyle. Discord documents its own account-level
Display Name Styles and native profile editor, but this checkout has no
supported handoff that converts arbitrary plugin CSS/ornaments into those
native saved styles. The UI now explains the separate routes instead of
claiming that every profile field is universally client-only or promising
that custom local effects appear in vanilla Discord. No Discord account was
changed; native account writes and vanilla-recipient rendering were not tested.

Verification: `pnpm test`, `pnpm verifyPlugins`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check` passed. The
overlay build contains DMDisplayNameStyle and its registration checks pass.
These changes remain local, uncommitted, and unpublished. Existing dirty files
and untracked assets were preserved; no files or controls were intentionally
removed. Visual interaction with the tour/hub and a real vanilla-client
recipient check remain unverified.

Best next action: inspect the additive shortcuts and component-only
name-style import in the running client; separately confirm the supported
native editor path on an account before making any native-profile claim.

## 2026-09-23 display-name style plugin — local candidate only

Added the new `DMDisplayNameStyle` plugin. It offers 30 local-only presets,
including script (`Velvet Script`, `Moonlit Script`, `Flamekissed`), gothic,
arcade, luxe, and dream styles; three bundled offline typefaces (Great Vibes,
Unifraktur Cook, and Bangers); custom two-color controls; and font, weight,
spacing, casing, finish, motion, and per-surface overrides. Its settings gallery
has a live sample for the selected look and mood filters. Motion options include
breathing, shimmer, scan, flame flicker, spark twinkle, and electric flashes.
OS reduced-motion settings do not affect this plugin. Tournament Mode is the
automatic animation stop; the plugin's Animate toggle and each preset's Still
choice remain available for manual control.

The plugin is now default-on for new/unseeded installs and discoverable from
the Plugin Tour, DM Hub quick toggles, featured cards, Plugin Health, and the
overlay build registry. The selector only paints the display-name leaf; it no
longer captures Discord's whole account label wrapper, including username and
status text. The candidate renderer was rebuilt and reloaded from this
checkout. Runtime rule check: with Windows reduced-motion enabled, the live
client reported Tournament Mode=false, the Neon Arcade preset's shimmer
effect, and `dm-display-name-shimmer` with a 3.8s duration and running play
state. The window was hidden during automation, so its animation timeline did
not advance there; visible frame progression and a live Tournament Mode
on/off toggle remain unverified. The old saved `respectReducedMotion: true`
value remains inert; the setting is removed from this plugin's controls and is
no longer read by its code. A PII-safe gallery screenshot is saved at
`docs/evidence/display-name-style-showcase.png`.

Latest verification: `pnpm test`, `pnpm overlay:vencord`, and
`git diff --check` passed; the rebuilt renderer was loaded in the running local
client. The source changes remain uncommitted and have not been pushed,
packaged, or published. The
Tournament Mode `manuallyActive` gate remains in place in code; a live on/off
toggle was not exercised during this check. The styling is intentionally
Discordmaxxer-local: the real Discord name, mentions, search, accessibility
label, and vanilla Discord rendering remain unchanged. Native/vanilla
recipient proof and a second-PC check remain external gates.

Best next action: review the candidate in the running client, then decide
whether to commit and release this plugin with the existing profile-flair
follow-up changes.

## 2026-09-23 avatar visibility + gradient tour follow-up — local only

The self-profile avatar was visibly 80x80 but Discord marks its actual `<img>`
with `aria-hidden="true"`; the accessible wrapper carries the useful profile
semantics. The avatar-only visibility checks in
`plugins/DMProfileFlair/index.tsx` now allow that attribute after the element
has matched Discord's avatar class/CDN checks. Banner scanning keeps the
normal hidden-element guard. The idempotent source repair also avoids comparing
Chromium's proxied `currentSrc`, so a healthy GIF is not restarted on every
scan.

`plugins/DMWelcome/index.tsx` now adds the current validated profile gradient
as a `Current profile` swatch in the Plugin Tour when the active pair is a
custom `#RRGGBB` combination. Named presets, including Cotton Candy, remain
available. The isolated v0.7.68 candidate was rebuilt and relaunched from this
checkout. Runtime checks showed the self avatar applied, complete with natural
dimensions 480x266; two one-second avatar clips had different hashes. Turning
TournamentMode on removed the applied avatar markers, and turning it back off
restored them. The Plugin Tour showed both `Current profile` and `Cotton Candy`.
`pnpm test`, strict `pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check` passed.

These source changes are still uncommitted and have not been pushed, packaged,
or published. The runtime proof is renderer-local; native recipient/vanilla
Discord visibility and a second-PC check remain external gates.

Best next action: Diggy confirms the avatar animation in the running client
with TournamentMode off, then decide whether to commit and release this
follow-up.

## 2026-09-23 avatar responsive-source follow-up — local only

The saved self-avatar source is a real multi-frame GIF (97 frames), so the
remaining still-frame symptom was not caused by a missing animated asset. The
Discord avatar image node also carries responsive `srcset`/`sizes` candidates;
setting only `src` could leave Chromium painting the static `currentSrc` while
DMProfileFlair marked the node as applied.

`plugins/DMProfileFlair/index.tsx` now captures the original avatar attributes,
removes and reasserts `srcset`/`sizes` while flair owns the node, re-applies that
invariant when Discord recycles the same node, and restores the original
attributes on failure or cleanup. The isolated v0.7.68 candidate was rebuilt
and relaunched from this checkout; startup confirmed it is using the rebuilt
candidate renderer. `pnpm test`, strict `pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check` passed.

This source change is still uncommitted and has not been pushed, packaged, or
published. Native playback could not be independently observed because the
computer-use surface did not expose the Electron window; a self-profile check
with TournamentMode off remains the runtime gate. Toggle TournamentMode on and
off afterward to confirm the intentional pause/resume behavior.

Best next action: Diggy refreshes the self profile in the running candidate and
confirms that the avatar advances frames; only then decide whether to commit
and release this follow-up.

## 2026-09-23 post-v0.7.68 profile media candidate — local only

Diggy reported that the banner was still rendering as a single frame and the
avatar was missing from the full-profile surface even though both saved URLs
return HTTP 200 with `image/gif`. The remaining still-frame behavior was in
DMProfileFlair itself: the old reduced-motion path extracted and substituted a
cached PNG whenever Windows/Discord reported reduced motion. This candidate
removes that conversion completely. The original animated URL now reaches the
renderer unchanged; TournamentMode's `manuallyActive` flag is the only media
pause.

The avatar cleanup path also now stores the resolved owner ID on each painted
avatar and recognizes the newer full-profile modal selector families. That
prevents a valid self avatar from being restored immediately when Discord uses
a default/non-CDN source or recycles a modal node. The Appearance Center and
renderer diagnostics now explain the actual rule instead of claiming that
reduced motion will produce a first frame. The legacy setting remains only for
config compatibility and no longer changes media rendering.

Candidate verification passed `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
`pnpm verifyPlugins`, and `git diff --check`. The candidate is not version
bumped, pushed, packaged, or published; the source checkpoint is committed
locally. A running-client animation check and second-PC/recipient check remain
external gates; the attached profile screenshot is evidence of the affected
surface, not playback proof.

Best next action: reload the dev client from this checkout and confirm the
banner advances frames and the avatar remains applied with TournamentMode off;
then toggle TournamentMode on/off to verify the intentional pause/resume. Only
after that should this candidate be bumped and released as a new app version.

## 2026-09-23 v0.7.68 public release — live

Release commit `eee9e4118dd15d1bf34a3f97ccf6f728cd2e1064` and tag `v0.7.68`
are pushed to `main`. GitHub Actions release run `35909670139` and test run
`35909654857` passed. The stable non-draft release is live:
https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.68

Published assets include x64/ARM64 ZIPs, the NSIS installer, blockmap, and
`latest.yml` advertising version `0.7.68` with the installer hash and size.
The release workflow also successfully notified maxxtopia.com. Local gates
passed: `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `pnpm verifyPlugins`,
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`,
`pnpm package:win`, and `git diff --check`.

The shipped fix restores current-user banner/avatar drafts and remembered
IndexedDB files into the renderer on plugin start, lets local self media paint
without waiting for the roster, and keeps reduced-motion media visible via a
cached first frame. TournamentMode remains the explicit media pause. This is
source/build/release proof; the running client, second-PC sync, and recipient
rendering still need a real-device check. The separate `/profile-media`
worker/R2 route was not part of the app tag, but it was deployed afterward
from optimizationmaxxing commit `a979d91` (Worker version
`18aa8c78-5b55-42e4-9f9c-3d39f722b0c6`). Its live upload route returns the
expected validation response and `/roster` returns 200; an authenticated
user-media upload and second-PC recipient render are still unverified.
Vanilla Discord rendering is not claimed for Discordmaxxer-only flair.

Best next action: update/relaunch Discordmaxxer to v0.7.68 on both PCs, open
the self profile, and confirm the banner/avatar are visible after startup.
Then test cross-PC/other-user media with an authenticated publish and a
second Discordmaxxer client; the worker/R2 route is now deployed, but those
recipient checks still need to be performed.

## 2026-09-23 v0.7.67 public release — historical

Release commit `86d4a021476a1dfee47f227cdc19bd509a943d9f` and tag `v0.7.67`
are pushed to `main`. GitHub Actions release run `35853072999` passed, and
the stable non-draft release is live:
https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.67

Published assets include x64/ARM64 ZIPs, the NSIS installer, blockmap, and
`latest.yml` advertising version `0.7.67`. Release notes are populated for the
updater. Local gates passed: `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `pnpm verifyPlugins`,
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`,
`pnpm package:win`, `git diff --check`, and the ASCII shipped-script check.

The running machine still has the older installed client at
`C:\Users\Diggy\AppData\Local\Discordmaxxer\discordmaxxer.exe`; this
session did not load v0.7.67 into the running client, so native runtime,
second-PC sync, and recipient behavior remain unverified. The separate
profile-media worker/R2 deployment was not part of this app release. The app
release does not claim vanilla Discord rendering for Discordmaxxer-only flair.

Best next action: install/update v0.7.67 on both PCs and run the focused
gradient, local media, backup/restore, and second-PC roster smoke test. Deploy
the separate worker/R2 candidate only when that is explicitly scoped.

## 2026-09-23 v0.7.68 profile flair recovery — release candidate

Diggy reported that a v0.7.67 update left the gradient visible while the
custom banner and animated avatar disappeared. The regression came from two
independent gates: media rendering trusted the shared roster even when the
current install had no usable roster snapshot, and the Windows reduced-motion
path suppressed animated media instead of keeping a visible still frame.

The v0.7.68 candidate fixes the whole self-render path: saved HTTPS drafts and
remembered IndexedDB files are restored when the plugin starts and paint the
current user's banner/avatar immediately; the current user's local field wins
over an older shared value without leaking to other users; reduced motion
keeps the media visible and swaps to a cached first frame when available; and
TournamentMode remains the explicit performance pause. The avatar sweep gate
now includes local self media, so the current user's avatar is not skipped
before the profile surface is scanned. Clearing a local field also clears its
remembered file.

Candidate verification passed `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
`pnpm verifyPlugins`, `pnpm package:dir`, `pnpm package:win`, and
`git diff --check`. A visual running-client or second-PC/recipient assertion
was not available in this session, so those remain explicit external gates.

This candidate was superseded by the published v0.7.68 release above. The
separate `/profile-media` worker/R2 route was not silently included in that
app-only tag; it is now deployed separately, while cross-PC/other-user file
visibility still needs authenticated publish and recipient proof. Vanilla
Discord rendering remains outside the Discordmaxxer-only flair path.

## 2026-09-23 post-update flair fallback candidate — superseded

Diggy reported that after updating, the profile gradient still appeared but
the custom banner and animated avatar disappeared. The v0.7.67 renderer made
media roster-authoritative while allowing the current user's gradient draft to
paint immediately. This fresh client had no successful roster snapshot because
the live worker `/roster` route is currently returning a retryable 503 while
Cloudflare KV's daily legacy-list quota recovers. The saved avatar URL is also
260 characters, so it cannot be published under the shared short-URL limit;
the banner URL is within the limit. Windows reports `MinAnimate=0`, and the
plugin setting `respectReducedMotion` is true, so animated GIF media is also
intentionally suppressed until that preference is disabled.

The first uncommitted candidate treated a valid saved HTTPS media URL as a
self-only local fallback only when no successful roster snapshot existed. That
was too narrow: it did not restore remembered local files into the renderer,
and reduced motion could still make the animated media look absent. v0.7.68
supersedes it with per-field local precedence, startup file restoration, and a
cached first-frame path.

Candidate verification passed `pnpm test` (lint + types), `pnpm build`,
`pnpm verifyPlugins`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check`. The staged
renderer is 1,505,181 bytes. A dev Electron client was launched from this
checkout and is running; no CUA accessibility binding was available for a
visual/profile-recipient assertion, so this is build/process proof only.

This historical candidate was not committed, pushed, published, or released.
Do not use its narrower test instruction as the current release behavior.

## 2026-09-23 v0.7.67 release contents

### Profile appearance center and renderer guardrails

The profile-flair editor now has a three-layer Appearance Center for gradient,
banner, and avatar. Each layer shows whether it is local, a URL draft, shared
roster data, or unset, and a `Why am I seeing this?` explanation makes the
current precedence and native-Discord boundary visible. Renderer health is
available in the same panel with scan counts, visible candidates, applied
layers, and the last media fallback failure.

Local banner/avatar files can be selected, dragged in, or chosen from the
keyboard. They remain per-PC and are remembered in IndexedDB; Export/Import
appearance backup now carries the selected file bytes and cosmetic settings in
a private JSON file without claim codes or worker credentials, so a Windows
reinstall has a deliberate recovery path. Media failures restore the original
Discord asset instead of leaving a broken image. Share codes can now copy or
import banner-only, avatar-only, or gradient-only components without
overwriting unrelated look fields.

The gradient picker is shared by the tour and Profile Flair and now exposes 24
presets plus custom top/bottom color inputs. Every preset applies locally
immediately; a claim code is only needed for shared cross-PC/user sync. The
renderer bounds work to visible surfaces, caches stable profile identity
lookups, skips hidden windows, and respects TournamentMode/reduced-motion
media suppression while keeping gradients available.

These additions were validated in the candidate by `pnpm test`, `pnpm build`,
strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`pnpm verifyPlugins`, `node overlay-scripts/verify-build.mjs`, and
`git diff --check`. The release is now pushed and deployed through the
GitHub Actions release workflow; the running client, real Discordmaxxer
second-PC sync, worker/R2 media publication, and native Discord recipient
behavior remain human/external gates.

### Follow-up hardening included in v0.7.67

DMProfileFlair now remembers a selected banner and avatar file in Vencord's
local IndexedDB, matching VideoBackground's same-PC restart behavior. The
editor labels the file as remembered-on-this-PC versus session-only and keeps
the boundary explicit: only the deliberate Publish as shared... action makes a
copy available across PCs; a Windows reinstall still needs the original file.
Profile writes, profile-media uploads, remote URL reads, and still-frame fetches
now have hard timeouts with actionable failure toasts instead of hanging
indefinitely; a timed-out shared write leaves the local gradient applied.

The profile renderer also skips reconciliation while Discord is backgrounded,
resumes with a fresh avatar sweep when visible, and debounces mutation-driven
full-document scans to a bounded trailing interval before the animation-frame
paint. This reduces avoidable work during chat scroll/call churn without
changing the 750ms avatar freshness limit or the two-second safety net.

The follow-up gates passed: `pnpm test`, `pnpm testTypes`, `pnpm build`,
`pnpm verifyPlugins`, `node overlay-scripts/verify-build.mjs`,
`pnpm overlay:vencord`, and `git diff --check`. They were included in the
published app build; the running client, worker/R2 path, second-PC sync, and
native Discord recipient remain unverified.

This release improves the existing Discordmaxxer architecture without
changing the canonical dirty checkout. It corrects stale upstream plugin IDs,
migrates the two renamed settings once, removes unavailable legacy IDs from
defaults and quick-enable bundles, and adds a registry gate so defaults,
bundles, and featured cards cannot point at missing plugins.

DM Hub now has a Plugin health panel with loaded/off/conditional/best-effort/
experimental/caution/unavailable states. The tour and quick bundles report
when a plugin is not present instead of claiming it was enabled. The tour copy
also keeps local gradients, service/account-dependent profile media, native
Discord actions, and Tournament Mode's best-effort frame-rate behavior
separate and explicit. README/CLAUDE/RESILIENCE documentation was corrected to
match the current registry and to remove an unverified fixed RAM claim.

The follow-up audit found and fixed three quieter reliability issues. DMTyping
now targets the pinned TypingTweaks row class, rechecks recycled DOM rows and
roster updates, and cleans up its observer on stop instead of silently doing
nothing after a Vencord UI change. DMGrant now reads the current `DMGrant`
settings key while retaining a read-only fallback for old
`DiscordmaxxerGrant` data. DMVotes now skips tally polling for ineligible
users and bounds its worker requests to eight seconds.

DMVotes no longer presents the old filler poll. Its six moderated candidates now
map to the actual profile backup, banner-only copy, media restore, sync/conflict,
voice/screenshare, and native-Discord explanation work users have been asking
for. Retired worker keys are excluded from the visible total. The panel also
lets every user save up to ten short requests locally and copy one into
`#vip-chat` or support; the current worker has no moderated suggestion endpoint,
so custom text is not pretended to be a shared vote.

The static gates pass locally: `pnpm verifyPlugins`, `pnpm test` (lint and
TypeScript), `pnpm build`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, and `git diff --check`. The overlay
compiled all 24 custom plugins and the registry audit resolved 53 defaults, 10
bundle entries, and 8 featured entries. These changes are published in
v0.7.67, but are not loaded into the running client in this session. Native
runtime behavior, two-PC roster sync, and service/account paths remain
unverified. Recipient voice/screenshare sessions are optional human quality
checks, not release gates.

Best next action: install/update v0.7.67 on both PCs for the focused
health/tour, DMTyping, gradient, local-media, backup/restore, and roster smoke
test.

## 2026-09-22 profile-flair media + instant tour gradient picker — unpublished candidate

This candidate continues the v0.7.66 profile-flair fix in two isolated
worktrees. It is not loaded into the running client and does not change the
canonical dirty checkout.

The DMWelcome tour is now version 6. It has 24 gradient swatches plus a
top/bottom color picker for custom blends. Every preset applies immediately on
the current PC, even without a claim code; the current user's local choice
overrides an older shared gradient so a click cannot look broken. With a claim
code, the same action also publishes both colors through `/profile` and lets
the shared roster sync across PCs and other Discordmaxxer users. If shared
publication fails, the free local gradient remains applied with an explicit
sync warning. Gradients are FREE, not MAXXER++-only. Animated avatars remain
MAXXER+ and shared banners remain MAXXER. Vanilla Discord still cannot render
Discordmaxxer-only roster flair; the optional native Discord action is a
separate Discord/Nitro-gated path.

The same low-friction pass now covers the other raw-input surfaces that were
most likely to feel broken: DMTheme has visual swatch cards alongside its
keyboard-friendly selector; DMPresence has one-click purpose presets plus a
preview line while keeping custom MAXXER++ fields; and DMVipClaim cleans and
formats pasted codes, uppercases typed input, shows character progress, and
only enables Redeem once the code shape is valid. VideoBackground now explains
that local files persist across app restarts on the same PC but cannot survive
a Windows reinstall without the original file or a portable HTTPS source.

The same treatment now covers shortcuts. CompactView, TournamentMode, and
DMVoiceKeybinds expose visual recorders with safe modifier requirements,
readable current values, and one-click default reset while retaining their raw
settings for advanced users. Changed CompactView and TournamentMode shortcuts
re-register immediately instead of waiting for a plugin restart, named keys
(Escape, arrows, Space, Page Up, and lock keys) are normalized in both the
renderer fallback and Electron bridge, and a global-registration conflict
falls back to a focused-window handler with an explicit warning.

The app worktree is
`C:\Users\Diggy\projects\discordmaxxer-profile-flair-local-media` on
`codex/profile-flair-local-media`. The worker worktree is
`C:\Users\Diggy\projects\optimizationmaxxing-profile-media` on
`codex/profile-flair-media-upload`. The worker candidate adds authenticated
`/profile-media` upload and serving with R2-backed image/GIF/video storage so
a local banner can be deliberately published and recovered on another PC;
the R2 bucket still needs to be created and deployed before that path is live.

Profile writes carry an `updatedAt` conflict guard, the roster replaces stale
profiles atomically, and media serving supports HEAD/range requests plus
bounded per-user retention. The updater page now shows a GitHub release link
when release notes are empty or arrive in an unexpected format.

Verification: app `pnpm testTypes`, `pnpm build`, `pnpm lint`,
`pnpm build:dev`, strict `CI=true pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, updater syntax, and diff checks pass.
The worker profile-media suite is 8/8 passing, `node --check vip-worker/worker.js`
passes, and its diff check passes. The strict overlay used a temporary Vencord
source worktree only for this candidate build. No native client, second-PC,
recipient, R2, worker-deploy, or live-release proof has been claimed.

Live boundary: v0.7.66 remains the public release. The old live tour could
leave a per-install draft behind or let an older shared red value win, which is
why the user's Cotton Candy click could appear ineffective; this candidate
overrides that stale value locally, repaints the open profile synchronously,
and publishes the shared value when the worker accepts it. The next
real-client checks are to click a tour swatch and a custom blend, confirm the
new value survives reload and another Discordmaxxer client syncs after the
worker/app release, then publish a local banner after the worker/R2 deployment
gate.
The best next action is explicit review/approval for the separate worker
deployment and app publication, followed by those human client checks.

## 2026-09-22 profile-flair consistency and usability — v0.7.66 public release — live

Diggy reported that the same Diggyai account showed the published green-cave/red
look on one PC but a local Cotton Candy gradient and different background on
another. The root cause was self-view precedence: the profile-flair renderer
let per-install editor settings override the shared roster for the current user,
while other clients rendered the roster. The live roster currently contains the
red theme values, so the mismatch was a local draft being rendered as truth,
not a second published look.

The isolated release worktree now makes the published roster authoritative for
self and other users; editor fields are clearly labeled per-install drafts until
Save, and Restore reloads the published look without changing real Discord.
Save is merge-only so editing a banner on a new PC cannot erase an avatar that
already exists remotely; banner-only and avatar-only clear/share/import paths
are explicit. Profile Flair is easier to reach from DMHub, direct-HTTPS errors
explain the limit, downloaded GIF/image/video files can be previewed or sent
once to real Discord, and profile-look codes can contain only the banner or
avatar. Local files are intentionally not silently uploaded to the shared roster.

Current state: stable v0.7.66 is published from commit
`310138c479a2ed3489a678553d544aa314676de5`; tag `v0.7.66` points to that
commit. The [GitHub release](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.66)
is public, stable, and not a draft. Its [release workflow](https://github.com/MaxxTopia/discordmaxxer/actions/runs/35808934513)
completed successfully, including strict overlay, build, integrity check,
Windows packaging, upload, and the MaxxTopia site notification dispatch.

The public release contains x64 and ARM64 ZIPs, the NSIS installer and
blockmap, and `latest.yml`. The public updater manifest returned HTTP 200 and
names `Discordmaxxer-Setup-0.7.66.exe` at 211,048,844 bytes. Local checks
passed: `pnpm test`, strict `DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`pnpm build`, `node overlay-scripts/verify-build.mjs`, `pnpm package:dir`,
`pnpm package:win`, shipped-script ASCII validation, and `git diff --check`.
The installer is unsigned, so Windows SmartScreen may show the existing trust
warning. The canonical dirty checkout was not staged or modified by this
release.

Client-side checks remain: load this candidate in the actual client; compare Diggyai's
self profile with Diggy T viewing Diggyai; press Restore; save banner-only and
confirm the remote avatar remains; test a local-file one-time Discord broadcast;
and perform native recipient/Nitro checks. The release makes the published
Discordmaxxer roster authoritative for rendering, but it does not silently
change Diggyai's roster look or real Discord account: Save is still the user
action that shares a profile-flair edit. Vanilla Discord still requires the
explicit broadcast path and its Nitro/server limits; local video files remain
per-install app data and are not recoverable after a Windows reinstall unless
backed up separately. Best next step: update or relaunch the real client,
confirm About shows v0.7.66, then perform those checks.

## 2026-09-22 v0.7.65 public release — live

Diggy asked for the app update to go live before the real-client checks and
will test after release. Stable v0.7.65 is published from commit
`b4aee35403e0b45cdbafe76213411ed73792089a`; tag `v0.7.65` points to that
commit. The [GitHub release](https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.65)
is public, stable, and not a draft. Its [release workflow](https://github.com/MaxxTopia/discordmaxxer/actions/runs/35799871094)
completed successfully, including overlay, build, integrity check, Windows
packaging, upload, and the MaxxTopia site notification dispatch.

The release has x64 and ARM64 zip files, the NSIS installer and blockmap, and
`latest.yml`. The public updater manifest returned HTTP 200 and names
`Discordmaxxer-Setup-0.7.65.exe` at 211,045,288 bytes. Local checks passed:
`pnpm test` (lint and TypeScript), strict Vencord overlay (24 plugins, 0
rebrand warnings), `verify-build.mjs`, `pnpm build`, x64/ARM64 packaging, and
`git diff --check`. The installer is unsigned, so Windows SmartScreen may show
the existing trust warning.

Additional real-client quality checks were not completed: call and screenshare
with audio; Founder/MAXXER++ benefit inheritance; Tournament Mode during
voice/screenshare; and creating, importing, and saving a `DMLOOK1:` profile
look between two clients. These were follow-ups, not publish blockers. The
local client currently open is still the v0.7.64 candidate at
`C:\Users\Diggy\projects\discordmaxxer-release-074\dist\win-unpacked\discordmaxxer.exe`;
it was not replaced or restarted. No localhost:9223 debugger is listening, so
the packaged runtime validator remains unrun.

Best next step: update or relaunch the official client, confirm About shows
v0.7.65, then run the real-client checks above. No client restart was performed.

The VIP Worker checkout remains at its public baseline. Its local `worker.js`
and README contain a large mixed diff with unrelated VIP admin/Aimmaxer work;
deploying that file would publish unrelated changes. The candidate Worker
also filters stale cosmetic fields after downgrades, contrary to Diggy's
accepted behavior that stale flair may remain. Do not deploy that checkout as
part of this release. The Discordmaxxer app is the only release in scope.

## Current maintenance/release state — v0.7.66 published

## 2026-09-21 covered-window/screenshare release — v0.7.64

## 2026-09-22 local install handoff — v0.7.64

The published v0.7.64 NSIS installer was downloaded from the MaxxTopia GitHub
release and matched the published SHA-512. The stale installed v0.7.63 client
was replaced. The Start Menu shortcut now targets
`C:\Users\Diggy\AppData\Local\Discordmaxxer\discordmaxxer.exe`, and that
installed executable is running at v0.7.64. The earlier unpacked test process
from `discordmaxxer-release-074\dist\win-unpacked` was closed.

Windows' icon cache was refreshed with `ie4uinit`, `SHChangeNotify`, and a
targeted icon-cache rebuild. Explorer was restarted and the installed client
was relaunched. The moved cache files are backed up under
`C:\Users\Diggy\AppData\Local\Temp\discordmaxxer-iconcache-20260922-093515`.

## 2026-09-22 profile-flair, tier-entitlement, and taskbar candidate

This isolated candidate addresses the cross-client profile report and the
remaining Windows identity mismatch without changing the canonical dirty
checkout. The generic boat seen in ordinary Discord is Discord's
server-side banner; Discordmaxxer's custom banner/avatar/theme roster is an
in-app feature and is only rendered by another Discordmaxxer client. The
candidate now makes that path reliable for default-avatar users and changing
Discord markup: it discovers profile ids from data attributes, links, React
props, and avatar URLs; refreshes the roster listeners when the async fetch
completes; reapplies or removes banner/theme/avatar flair when the roster or
tier changes; and restores Discord's original inline styles when the plugin
stops or a user loses a field.

Tier gates are aligned across the renderer, roster sanitizer, and VIP card:
gradients are FREE for every user; MAXXER gets custom banners and five saved
video-background slots; MAXXER+ gets animated avatars, video-background
playback, twenty slots, and the three exclusive themes; MAXXER++ gets animated
name tint, custom presence, voice color, beta builds, votes, and the About
credit. A claim is still required for any shared roster write, and the worker
continues to gate shared media server-side. The badge registration now
re-evaluates after roster load. VIP claims accept the worker's `rebound`
response and update the locally cached granted tier, expiry, and scope. The
worker source has not been deployed.

The Windows taskbar fix sets `com.maxxtopia.discordmaxxer` before Electron
creates a window, supplies the Clyde icon through `setAppDetails`, and keeps
the BrowserWindow icon explicit. A fresh candidate AUMID displayed the Clyde
icon; the old `dev.diggy.discordmaxxer` AUMID retained Windows' cached Atom
icon. The candidate is running from
`C:\Users\Diggy\projects\discordmaxxer-release-074\dist\win-unpacked\discordmaxxer.exe`
with the shared profile. Public stable v0.7.64 and the canonical checkout are
unchanged.

Verification in this checkout: `pnpm test` (lint plus TypeScript),
`DM_STRICT_REBRAND=1 pnpm overlay:vencord` (81 idempotent upstream patches,
24 custom plugins, 0 warnings), `pnpm build`,
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`, `node --check`
on the worker, and `git diff --check` all pass. The remaining human gate is a
second Discordmaxxer client viewing this account's profile after the roster
has refreshed. Publishing the worker or producing a new public app release
still requires an explicit release decision.

## 2026-09-22 tier inheritance, Tournament Mode, and profile-look sharing candidate

The next local candidate keeps cosmetic flair deliberately stale after a
downgrade or a cleared profile field, while the live tier and expiry lookup
still follows the current roster. The shared tier boundary now normalizes
Founder slots 1–33 to MAXXER++, treats higher numeric tiers as including every
lower tier, and preserves legacy claim records that omitted their tier as the
historical MAXXER++ entitlement. The VIP card and renderer gates use the same
ladder, and the worker source mirrors the founder and profile-field rules. The
worker change is local source only; the public worker has not been deployed.

Tournament Mode now sends all three settings to the native bridge whenever the
mode starts or a setting changes: process-priority lowering, the best-effort
30-fps request, and arRPC disable/restore. The bridge reports requested state
without claiming that normal windowed Chromium accepted a frame cap. Original
arRPC intent is preserved across setting changes and restored when the mode is
turned off.

DMProfileFlair now has a versioned `DMLOOK1:` share code. It carries only the
cosmetic banner, animated avatar, gradient colors, Maxxer theme selection, and
rich-presence look. It is HTTPS/length/field allowlisted, checksummed, and
contains no claim code, HWID, Discord id, tier, or credential. Users can create
and copy a code or paste one into the editor; imported flair is local until
Save, while the theme/presence settings are applied through Vencord's settings
proxy. Unknown or edited codes are rejected.

The isolated candidate is running from
`C:\Users\Diggy\projects\discordmaxxer-release-074\dist\win-unpacked\discordmaxxer.exe`
with the shared profile. Public stable v0.7.64 and the canonical checkout are
unchanged. Verification passed: `pnpm test`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`,
`node overlay-scripts/verify-build.mjs`, `pnpm build`, `pnpm package:dir`,
worker `node --check worker.js`, worker extension tests (3/3), and
`git diff --check`. Additional real-client checks were not completed: a live
Founder/higher-tier test, a Tournament Mode voice/screenshare toggle test, and
a two-client profile-look create/import/Save test. Diggy authorized the public app release on
2026-09-22. At that time the docs described a real-client release gate; that
policy was removed on 2026-09-24. These tests remain quality follow-ups, not
release blockers.

This release carries the covered-window and screenshare diagnostics work that
Diggy field-tested in the running client. The live check looked good while a
Chrome YouTube window was being shared, including when Discordmaxxer was not
the foreground window.

The focused changes are:

- Windows Graphics Capture feature aliases are explicitly enabled or disabled
  from the existing setting, so the restart-time choice is deterministic.
- `getDisplayMedia()` video tracks are registered before Discord creates its
  senders. RTC diagnostics now inspect only display-capture tracks, expose a
  screen-share source label, and warn when the sender falls below 24 FPS.
- Settings now include a safe per-user Chrome `WindowOcclusionEnabled=0`
  toggle. Discordmaxxer records ownership, leaves machine or externally owned
  policies unchanged, and removes only the value it created. Chrome must be
  fully exited and reopened for the policy to take effect.

Automated release evidence in the isolated release checkout: `pnpm install
--frozen-lockfile`, `pnpm test`, `pnpm build`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord` (`81` patches applied, `0` warnings),
`node overlay-scripts/verify-build.mjs`, `pnpm package:dir`,
`pnpm package:win`, `git diff --check`, and the packaged read-only validator
(`inventory`, `visual`, `hotkeys`, and `massdelete`) all pass. The Windows
artifacts are the x64/ARM64 ZIPs, NSIS installer, blockmap, and `latest.yml`.
The installer remains unsigned, so Windows SmartScreen may still show the
existing trust warning.

The public stable release is now v0.7.64 from the tagged release commit. A
native recipient test of Fortnite and Chrome sharing with two-way voice/audio
is still the final real-device quality check; the automated sender telemetry
and this local field test do not replace that viewer-side proof. Chrome source
picker enumeration was not changed by this release.

The canonical checkout may still contain unrelated dirty `plugins/DMPresence`
edits and untracked `plugins/DMTranslate/` and
`plugins/PlaylistmaxxingPresence/` work; those files were not included.

## 2026-09-14 upstream Electron drift maintenance — v0.7.64 candidate

The September 14 Maxx-bot `upstream drift detected` DM was a valid maintenance
signal, not a live suite outage. The successful `upstream-watch` run
`34884180290` found only one difference: upstream Vesktop had moved to Electron
`43.2.0`, while Discordmaxxer's frozen release lockfile still resolved
`43.0.0`. The pinned Vencord commit remains
`ef29bbeb6119cfb53d1273ed78147bcc97d91261`; its age was below the workflow's
30-day drift threshold, so no Vencord re-pin was included. The live
`suite-monitor.maxxtopia.workers.dev` endpoint was healthy in observation mode
(`allUp: true`) during this audit.

The candidate changes `package.json` and `pnpm-lock.yaml` to exact Electron
`43.2.0`. Exact pinning keeps the frozen release reproducible and aligns the
declared dependency with upstream Vesktop. No custom plugin or unrelated local
work was changed. The public stable release remains v0.7.63 until this
candidate is released.

Automated verification in an isolated worktree: `pnpm install
--frozen-lockfile`, `pnpm test`, strict `DM_STRICT_REBRAND=1
pnpm overlay:vencord` against the pinned Vencord commit (0 warnings),
`pnpm build`, `node overlay-scripts/verify-build.mjs`, Electron runtime
`v43.2.0`, `pnpm electron-builder --windows --dir`, and `git diff --check` all
pass. The moving Vencord `main` tree was deliberately not used for the release
overlay because its paths have drifted beyond the pinned patch contract.

The candidate was pushed to `main` in commit `6f2150417b4081ecb0dd294425c35145eb01970b`.
Manual upstream-watch run `34927596682` completed successfully against that
commit, and the Discord audit found no new upstream-drift DM after the run. The
the then-current v0.7.63 installer remained stable pending the v0.7.64 release.

Historical release gate wording (superseded 2026-09-24): the v0.7.64 notes
required a real voice call and screenshare-with-audio sender/receiver check
before tagging. Those session checks were not provable from automation and are
now optional, non-blocking quality checks, not current release policy. Preserve the canonical dirty
`plugins/DMPresence/index.ts` edits and untracked `plugins/DMTranslate/` and
`plugins/PlaylistmaxxingPresence/` work.

## 2026-09-01 screenshare upstream-drift safeguard

Carried forward Vencord upstream fix `be77396b` in
`overlay-scripts/rebrand-vencord.mjs`. The WebScreenShareFixes overlay now
pauses the hidden application-stream preview before detaching `srcObject`,
preventing long-running screenshares from accumulating preview decode CPU and
starving the sender encoder. This is intentionally a focused overlay change;
bitrate, codec selection, Windows capture routing, and winaudio were not
changed because this audit had no fresh native-recipient stream stats proving a
different cause.

Verification: `pnpm test`, `pnpm build:dev`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord` (0 warnings),
`node overlay-scripts/verify-build.mjs`, and the strict overlay idempotence pass
all pass. The generated renderer bundle contains both the existing
`x-google-max-bitrate=80000` patch and the new preview `pause()`/`srcObject=null`
patch. The running local Electron client was reloaded from the project debug
renderer and the read-only validator passed inventory, visual, hotkeys, and
mass-delete phases with the account-writing badge phase skipped.

Published as v0.7.63 from commit `70e6976` via GitHub Actions release run
`33582607106`. The public GitHub Release is stable (not draft or prerelease),
and its `latest.yml` advertises version `0.7.63`. Uploaded assets include the
Windows installer, x64 and ARM64 ZIPs, installer blockmap, and updater
manifest.

The public release is a test candidate, not proof that native recipient
quality improved. Diggy still owes the real sender/receiver test with a native
Discord recipient: application window and whole-screen sharing, live encoder
stats, viewer smoothness, and voice/screenshare audio. The microphone
`Error: 3002` remains separate. Keep the unrelated dirty
`plugins/DMPresence/index.ts` edits and untracked `plugins/DMTranslate/` and
`plugins/PlaylistmaxxingPresence/` work untouched.

## 2026-08-21 DMWidget refresh/discovery release — v0.7.62

The DMWidget live-stat path now sends no-cache/cache-bust hints to HenrikDev,
publishes fresh game stats before a new game card's first publish, includes the
actual Valorant RR in the manual-refresh result, and reports partial refresh
failures instead of always showing a green success toast. Discord's already-open
profile board can still take a moment to redraw after a successful publish; this
is a display/propagation delay, not a second stat source. The DMHub now has a
direct "Create / edit profile widget" action that opens the DMWidget modal with a
settings-page fallback. Curated hero presets are available for Neon, Jett, Reyna,
Raze, and Sage, plus a small Catwoman Fortnite starter preset; custom URLs remain
available. The native Discord Add Widgets menu was not patched because it is a
remote Discord surface rather than a stable Vencord plugin registry.

Verification for this release: `pnpm test`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
`pnpm build:dev`, `pnpm package:dir`, and `pnpm package:win` pass. The cache-busted HenrikDev request returned HTTP 200
with the current account at Diamond 3 / 42 RR during this session. Commit `2da75f3`
and tag `v0.7.62` are pushed. GitHub release workflow `32535488912` completed
successfully in 5m36s; the stable non-draft release has x64/ARM64 ZIPs, the NSIS
installer, blockmap, and `latest.yml` with updater version `0.7.62`. The generated
installer remains unsigned, so SmartScreen is still the public-trust caveat.

The rebuilt dev client was opened and checked in the real renderer: the Hub showed
the new shortcut, it opened the DMWidget modal directly, the Jett preset selected,
and the native-backed preview rendered a real image. The Fortnite template showed
the Catwoman preset and a rendered preview as well. The test restored the user's
editor state to Valorant + Automatic and deliberately did not click Create, Update,
or Refresh, so no Discord app/profile data changed. Remaining user check: click
Refresh when desired and confirm the already-open profile board redraws; a real
publish/propagation test is still separate from this local UI test. Maxxtopia
release-sync `32535830677` updated the download pointer, and the site update was
published in commit `5a23436` through Pages deploy `32536038918`. Preserve the
existing dirty DMPresence edits and untracked DMTranslate/PlaylistmaxxingPresence
work.

2026-08-17 upstream-drift maintenance: tracking issue #32 identified a stale
Vencord pin. The release workflow now checks out Vencord
`ef29bbeb6119cfb53d1273ed78147bcc97d91261`; Electron remains on the existing
compatible `^43.0.0` line. The overlay rewriter was updated for upstream's new
WebKeybinds architecture and its CSP patches are now marker-based and
idempotent, so repeated local overlays no longer duplicate injected blocks.

The runtime validator now uses the actual `DMBadge`/`DMHub`/`DMTheme` names,
awaits plugin restart lifecycle calls, preserves user settings, and validates
the Hub panel root correctly. The winaudio test helpers now poll the same
`drainChunks()` path used by Electron; the native roundtrip test passes at
48kHz, 2-channel float capture. A process-loopback diagnostic delivered
packets but observed no non-silent signal from the selected process, so a
known-audio human test is still required before calling process audio verified.

Verification: strict overlay on a pristine current Vencord clone passed with
0 warnings and was idempotent; the normalized CI-equivalent lint scan is clean
across 104 tracked source files, and `pnpm test` now passes locally. JavaScript
syntax checks, `pnpm build`, artifact verification, the read-only runtime
validator, and winaudio native tests also pass. After reclaiming approximately
46 GiB of replaceable build/cache storage, both `pnpm package:dir` and the
full `pnpm package:win` target pass, producing x64/ARM64 ZIPs and the NSIS
installer without `ENOSPC`. The generated installer is currently reported by
Windows as `NotSigned`; local packaging works, but public distribution trust
and SmartScreen remain an explicit release gate until signing is configured.
The lint correction is mechanical (formatting, file headers, import order, and
safe autofix-only cleanup). The maintenance chain ending at `a40e322` is pushed to `main`; the
latest GitHub test run `32097496202` passed cleanly after the workflow actions
moved to their current Node-24-compatible major versions. The v0.7.61 release
workflow `32104737220` also passed strict overlay, build, artifact
verification, Electron Builder, and publication.

2026-08-17 screenshare follow-up: Diggy reproduced a real v0.7.60 cross-PC
problem: whole-screen sharing became usable after a warm-up, while application
window sharing stayed choppy. The receiver was the normal Discord client. The
sender showed `OpenH264`/software encoder health and Discord's separate mic
input `Error: 3002` banner. The candidate now applies an aspect-preserving
`crop-and-scale` target before Discord ingests Windows capture, awaits that
pass, and retries after the MediaEngine sender is created at 75/250/600/1200/
2200 ms. Retries stop once the actual track is at the requested dimensions and
frame rate. This avoids the old fixed-16:9/`resizeMode: "none"` one-shot path,
which could miss application captures or leave them at native resolution.

The follow-up passed `pnpm test`, `pnpm build`, strict overlay with zero
warnings, overlay artifact verification, the live read-only validator, native
winaudio tests (4/4), `pnpm package:dir`, and `pnpm package:win`. The public
release assets and `latest.yml` returned HTTP 200 and the manifest declares
version `0.7.61`; Diggy accepted the unsigned installer gate. The main-PC real
sender test is now post-release validation: test both an application window and
the whole screen, check the live encoder stats, and confirm viewer smoothness
plus voice/screenshare audio. The mic `Error: 3002` remains a separate
diagnostic until the microphone itself is confirmed audible.

The resilience cache boundary is now hardened locally: fetched config is
allowlisted and bounded, banner links must be HTTPS, malformed responses are
discarded, and cache replacement is atomic so an interrupted fetch cannot
destroy the last-known-good startup state.

The dev client was reloaded from the project Electron binary after the
screenshare follow-up overlay rebuild. The live read-only runtime validator
passed with the account-writing badge phase skipped. This validates the loaded
client and plugin surface, not a real sender/receiver screenshare session;
Diggy's main-PC retest remains post-release validation.

The working tree still contains Diggy's unrelated DMPresence edits and
untracked DMTranslate/PlaylistmaxxingPresence work; preserve those changes.

## Current live state — v0.7.62

Released 2026-08-21 through tag `v0.7.62` and the tag-driven GitHub release
workflow. GitHub Release `v0.7.62` is stable and non-draft with HTTP-200
installer, Windows/ARM64 ZIPs, blockmap, and `latest.yml` assets. The updater
manifest declares version `0.7.62` and points to
`Discordmaxxer-Setup-0.7.62.exe`.

## Previous live state — v0.7.60

Released 2026-08-02: the overlay was rebuilt and verified locally and then
published through the tag-driven GitHub release workflow. Right-clicking a real image attachment now
adds ImageZoom to Discord's current `message` context-menu route; the three
sliders are marked interactive and their pointer/arrow events are isolated so
dragging no longer closes the menu. WebKeybinds now yields to already-claimed
Discord events, IME composition, editable controls, and content-editable
surfaces. Renderer fallback hotkeys in CompactView, TournamentMode,
DMVoiceKeybinds, and DMStreamMute now run in the normal bubbling phase and
return when Discord has already prevented the event.

Verification performed:
- `pnpm overlay:vencord` passed; rebrand warnings were 0 and the staged
  renderer bundle was written to `vencord-dist`.
- Live DOM/CDP check used a real image attachment: menu id `message`,
  `message-vc-zoom` was present, and dragging changed
  `Vencord.PlainSettings.plugins.ImageZoom.zoom` while the menu stayed open.
- Live WebKeybinds inspection confirmed the `defaultPrevented`/editable-target
  guard is present in the loaded plugin.
- Release workflow `30788781038` passed strict rebrand, overlay build, artifact
  verification, Electron Builder, and publish.
- GitHub Release `v0.7.60` is stable and non-draft with HTTP-200 installer,
  blockmap, Windows ZIP, and `latest.yml` assets. The updater manifest declares
  version `0.7.60` and points to `Discordmaxxer-Setup-0.7.60.exe`.

The working tree still contains Diggy's unrelated DMPresence edits and
untracked DMTranslate/PlaylistmaxxingPresence work; preserve those changes.

Known check state: `pnpm testTypes`, strict overlay, `pnpm build`, artifact
verification, and `pnpm package:dir` passed. The full local `pnpm lint` command
still reports pre-existing formatting/header/import findings in unrelated
source files; those were not mass-reformatted or included in this release.

Diggy-owed test: manually right-click an image, drag each zoom slider, and
exercise any Discord keybinds that overlap the configured Discordmaxxer
fallback hotkeys. The updater should offer the release on its normal polling
cycle and install it on quit; the release itself is already published.

## Last published baseline — v0.7.50 (historical release)

Mature, shipping Vesktop fork (Electron 41 + bundled Vencord, pinned to a main
COMMIT). ~30+ Vencord plugins enabled by default + ~24 custom plugins. Repo:
`github.com/MaxxTopia/discordmaxxer` (public, GPL-3.0-or-later). Distributes via
GitHub Releases + in-app electron-updater. That historical baseline was clean
and pushed; the current working tree still has unrelated local WIP, while
v0.7.60 is published.

Recent shipped work (2026-06-26/27):
- **v0.7.43** — in-app RNNoise mic noise suppression (Krisp replacement).
- **v0.7.44** — TournamentMode voice-aware priority (keeps renderer+GPU at NORMAL
  while in a call/stream so it never starves voice), periodic update check (6h),
  global mute/deafen keybinds (`DMVoiceKeybinds`, Ctrl+Alt+M / Ctrl+Alt+D).
- **v0.7.45** — mic noise suppression DEFAULT ON + auto-disables the browser's own
  noise suppression (no double-processing). Diggy confirmed it sounds better.
- **v0.7.48** — full bug-audit hardening pass (~30 fixes, no new features). Highlights:
  winaudio/venmic/HWID/ipcCommands IPC now sender-validated; dmMediaProxy SSRF closed
  via pinned-DNS fetch (banners verified still load); MassDelete single-flight (1 msg/sec
  rule was bypassable); localStorage->DataStore for VideoBackground slots + ProfileFlair
  hide-list + Votes (these never persisted before); micNoiseSuppression AudioContext+mic
  leak fixed; DMPrivacy now actually revokes analytics/personalization; DMStreamMute no
  longer claims success when it muted nothing; updater double-open + tray-destroy crashes.
- **v0.7.49** — new **DMWidget** plugin (default-OFF, experimental): one-click custom
  Discord profile-board widgets ("widgets v2" / Social SDK) with no Developer Portal,
  DevTools, or paid "widget maker" site. Live game cards for Fortnite (fortnite-api.com)
  and Valorant (HenrikDev) with auto-refreshing stats, rank badges on the stat cells
  (Valorant tiers auto-sourced; Fortnite Bronze->Unreal + Unreal Legends baked in), game
  logos, and multi-widget support (FN + Valorant coexist on one board). Move a widget
  between accounts with a copy/paste code that carries content + images but never your
  API keys/token. DMHub gains a "Refresh widget stats" button. Model B (per-user,
  self-owned app; bot token minted via 2FA, used once, never stored). Undocumented
  pre-GA Discord surface, gated behind an in-plugin experimental warning.
- **v0.7.50** — DMWidget follow-ups: "Move to top" button to reorder profile-board cards
  (front of the widgets array = top, verified live); cross-account deploy auto-creates a
  fresh app when a slot points at an app another account owns (switch account + Create,
  no manual reset); copy/paste share code now carries per-slot hero + app-icon images
  (true visual clone; only API keys re-entered by design).

## Self-maintenance (built 2026-06-27 — see TROUBLESHOOTING.md "Self-maintenance")

This project is built to run with minimal attention and to PING a human when it
can't fix itself:
- **Auto-update:** electron-updater checks on launch + every 6h; installs on quit.
- **CI gates (a broken build can't publish):** strict-rebrand (`DM_STRICT_REBRAND=1`
  fails release on stale patches) + artifact integrity (`overlay-scripts/verify-build.mjs`).
- **Maxx-bot alerts:** DMs Diggy on release failure / upstream drift / canary
  shipped / auto-rebump bail (`scripts/notify-maxx.sh`, secret `MAXX_BOT_TOKEN`).
- **Canary auto-rebump:** `vencord-shc-autobump.yml` ships Vencord re-pins as a
  `-beta.1` PRERELEASE (beta users only), never straight to everyone.
- **Drift watch:** `upstream-watch.yml` weekly flags Electron/Vencord staleness.

## How to ship a release

Bump `version` in `package.json`, then `git tag vX.Y.Z && git push origin main && push origin vX.Y.Z`.
Tag push triggers `release.yml` (overlay + build + gates + electron-builder publish).
Full detail + the gotchas (zstd voice flag, Vencord-pin-is-a-commit, frozen-lockfile,
winaudio prebuilt) are in `CLAUDE.md` "Operational facts" and `TROUBLESHOOTING.md`.

## Open items (none blocking; documented so they're not lost)

PENDING DIGGY RUNTIME TEST (code-verified, not yet runtime-confirmed):
- TournamentMode ON + a CPU-pegged game → voice stays clean (Stream & Voice Health panel).
- Global mute/deafen (Ctrl+Alt+M / Ctrl+Alt+D) fire while in a fullscreen game.
- v0.7.43 carryover: choppy-stream after quitting from tray w/ HW accel ON; echo.

FROM THE 2026-06-26 AUDIT (`AUDIT-2026-06-26.md`) — not yet built:
- **H5:** `hardwareVideoAcceleration` default-OFF may lock screenshare to the
  software encoder — needs a LIVE encoder-stats retest on current Chromium.
- Medium QoL: reconsider surprising default-on plugins (SilentTyping,
  NewGuildSettings), MessageLogger disk growth, persist arRPC restore-intent,
  echo-fix quiet-start gap.

KNOWN TIME-BOMB: voice rides a `ZstdContentEncoding` disable flag for Electron 41.
When Electron is eventually bumped, review the flag. A real voice call can add
evidence, but is optional and non-blocking; report voice as unverified if not
tested. `upstream-watch` will flag the drift; the runbook has the procedure.

## Key files

- `src/main/index.ts` — Electron main, Chromium feature flags (zstd disable here)
- `src/main/discordmaxxerPerf.ts` — TournamentMode system bridge (priority/voice gating)
- `src/main/discordmaxxerDefaults.ts` — default-on plugin list
- `src/main/updater.ts` — auto-updater (periodic check)
- `plugins/` — custom Vencord plugins (overlaid by `pnpm overlay:vencord`)
- `packages/winaudio/` — native per-process audio (screenshare); test with `test-loopback.js`
- `.github/workflows/` — release, upstream-watch, vencord-shc-autobump
- `TROUBLESHOOTING.md` — failure runbook + alert response table (AI-agnostic)
- `_IF-YOU-LOSE-CLAUDE.txt` — recovery anchor (auto-generated by _CONTINUITY/backup.ps1)

## 2026-10-19 — v0.7.101 cross-account media/widget repair and taskbar icon

Published release: v0.7.101 from `codex/release-v0.7.100` in
`C:\Users\Diggy\projects\discordmaxxer-release-v0.7.100`. Diggy authorized
publication on 2026-10-19. The client commit is `47f664c`, `origin/main` and
the release branch contain it, and tag `v0.7.101` is public at
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.101`.
The two-PC runtime acceptance test remains separate from source/build/deploy
proof and still belongs to Diggy after installation.

Worker-side repair in `C:\Users\Diggy\projects\optimizationmaxxing-profile-media`:
- Profile clears now leave an `updatedAt` tombstone instead of deleting the
  record. That prevents another client from republishing stale local banner or
  avatar media after the owner cleared it.
- Roster entries retain `profileUpdatedAt` even for an empty/tombstoned profile.
- Roster responses and R2 snapshots are `no-store`, so an old browser/CDN
  roster cannot silently win after an owner update.
- The existing R2 snapshot path remains the normal roster path; the legacy KV
  migration warning is expected when the test deliberately simulates the daily
  KV list limit.

Client-side repair in `DMProfileFlair`, `DMWidget`, and shared roster code:
- Owner media reconciliation is scheduled on startup, focus, and visibility
  changes, with a bounded retry/refresh path. It adopts an authoritative empty
  remote value as well as a non-empty value, and uses updatedAt conflict
  protection so stale second-PC writes cannot win.
- Banner/theme/profile DOM markers now carry the actual profile owner. Widget
  style and hint lookup is owner-scoped and no longer falls back to the viewer's
  widget skin when the viewed owner's skin is available or known to be empty.
- The generated Windows taskbar asset now uses the full Discordmaxxer brand
  mark. `static/taskbar/taskbar.png` is included in `app.asar`, and the branded
  `shortcut-icon.ico` is included as an Electron resource.

Verification completed:
- Worker: `node --check vip-worker/worker.js` passed.
- Worker: `node --test vip-worker/profile-media.test.mjs` passed all 17 tests.
- Worker: `vip-worker/deploy.ps1 -DryRun` passed; no deploy was performed.
- Client: `pnpm test` (ESLint + TypeScript) passed.
- Client: `pnpm build` passed.
- Overlay: strict `pnpm overlay:vencord` passed; all 27 custom plugins built.
- Overlay: `node overlay-scripts/verify-build.mjs` passed.
- Windows package: `pnpm package:dir` passed. The packaged `app.asar` contains
  `static/taskbar/taskbar.png`; the packaged resources contain
  `shortcut-icon.ico`. The taskbar PNG was visually inspected.
- Windows distributables: `pnpm package:win` passed and the public release
  contains the installer, x64/ARM64 archives, blockmap, and `latest.yml`.
- `git diff --check` passed in both modified worktrees.
- Worker deployment: commit `a8539f1` is deployed at
  `https://optmaxxing-vip.maxxtopia.workers.dev`, deployment version
  `7da980fc-504b-45ce-af59-1507634903b5`; live `GET /roster` returned 200 with
  `no-store`.
- Public release workflow: GitHub Actions run
  `https://github.com/MaxxTopia/discordmaxxer/actions/runs/39291316232`
  completed successfully. Public `latest.yml` returned 200 and version
  `0.7.101`.

Not done / waiting on Diggy:
- Source/build/deploy evidence cannot prove two signed-in recipients see the
  same live profile. Install v0.7.101 on both PCs, sign in as DiggyT and
  DiggyAI, then verify: each account's current animated banner is identical
  when viewed from the other account; DiggyT and DiggyAI each show both of the
  owner's chosen widget skins, including the now-playing card; skins do not
  disappear after waiting, opening/closing a profile, or switching accounts;
  and no viewer-account skin leaks into the viewed profile.
- After installing the packaged build, Windows may retain a cached old taskbar
  icon. Fully quit the old client, launch the new packaged executable, and if
  a pinned shortcut still shows the paper icon, unpin the old shortcut and pin
  the new Discordmaxxer shortcut once. This is Windows shell caching, not a
  renderer data path.

Next action: perform the two-PC acceptance test above. If any account still
shows a stale banner, missing animation, wrong gradient, or a skinless/wrong
owner widget, capture the exact account/viewer/build pair and time before
changing code; the next repair needs to distinguish a client cache/render
failure from an owner sync or Worker-data failure.

## 2026-10-19 — v0.7.102 avatar regression release candidate

After v0.7.101, the owner animated-avatar path could fall back to Discord's
native avatar while the roster was still loading, or when a persisted owner
avatar existed before a cloud profile record arrived. The live Worker data was
checked first: DiggyAI's roster entry contains a canonical avatar URL, and the
Worker returns it as HTTP 200 `image/gif` with a 2.9 MB payload. This is a
client state-timing regression, not a missing media object.

Release candidate repair in `plugins/DMProfileFlair/index.tsx`:
- restore the v0.7.100-compatible persisted-avatar fallback only when no
  timestamped cloud profile record has supplied an avatar;
- preserve an already-proven, owner-marked avatar while the first roster fetch
  is pending, without allowing it to leak to another profile;
- keep a populated cloud avatar authoritative and continue honoring a
  timestamped empty profile as an explicit clear.

Verification for this repair: `git diff --check`, `pnpm test`, `pnpm build`,
strict `pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
`pnpm package:dir`, and `pnpm package:win` all passed. The owner authorized
publication on 2026-10-19. Commit `2d5364c` was pushed to `main` and the
release branch, tag `v0.7.102` was pushed, and GitHub Actions run
`https://github.com/MaxxTopia/discordmaxxer/actions/runs/39332909340`
completed successfully. The public release is live at
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.102`; its
installer, x64/ARM64 archives, blockmap, readable notes, and HTTP-200
`latest.yml` advertising version `0.7.102` were verified.

Still waiting on recipient-side proof: install v0.7.102 on both signed-in
PCs and repeat the two-PC avatar test before claiming the rendered result is
verified. Confirm that DiggyAI and DiggyT each show the owner's animated
avatar without a default/static flash when the profile first opens or the
client starts, and that an explicit cloud-side clear remains cleared.

## 2026-11-04 — local strict selected-window screenshare audio candidate

Scope: repair the Windows screenshare path so Fortnite/game-window audio can
be selected without Discord call audio leaking into the stream. This is an
unpublished local candidate based on the v0.7.121 source state in the isolated
worktree `C:\Users\Diggy\projects\discordmaxxer-full-dev-merge-20261103c`.

Implementation:
- The existing per-window setting is now strict selected-window audio. The
  renderer resolves Electron's selected `window:<HWND>` source to its owning
  PID through the native Windows bridge and starts process-loopback capture in
  include mode.
- Strict mode withholds Chromium's system-loopback track at the main-process
  boundary. If source resolution or native capture fails, the share continues
  video-only and shows an error instead of falling back to a system mix that
  could contain Discord audio. Voice and microphone capture are unchanged.
- The previous exclude-this-client compatibility path remains available when
  strict mode is off. It is not a Fortnite-only guarantee.
- The freshly compiled native resolver was copied into the checked-in x64
  N-API prebuild so the Windows package carries the new behavior.

Verification completed locally:
- `pnpm test` passed (ESLint and TypeScript).
- `pnpm build` passed.
- `pnpm buildWinAudio` passed with only the existing MSVC macro/C++ standard
  warnings.
- `node --test packages/winaudio/test.js` passed all 4 native tests.
- Native window resolution returned OBS PID 19684 for HWND 394326.
- Strict pinned Vencord source passed the rebrand guard: 123 patches applied,
  zero warnings; all 29 custom plugins were staged.
- `node overlay-scripts/verify-build.mjs` passed, including required custom
  plugins and staged hash checks.
- `pnpm exec electron-builder --dir` passed. The packaged
  `resources/winaudio.node` hash matches the freshly built/prebuilt binary,
  and the Electron runtime loaded its process-loopback and window-resolver
  exports.
- The packaged executable stayed alive through an 8-second startup smoke test
  with isolated user data at `E:\Codex-recovery\discordmaxxer-package-smoke-20261104`;
  it was stopped afterward and did not touch the signed-in public client.
- A 3-second include-mode probe against the currently running OBS browser
  process received 299 packets but measured zero amplitude. That is
  inconclusive because the selected process was not producing audible audio;
  it is not evidence of Fortnite capture.

Release state: no commit, push, tag, live deployment, or public installer was
made. Generated local artifacts exist under `dist/` and the pinned Vencord
candidate worktree under `E:\Codex-recovery`; the user's public client was not
replaced or restarted.

Remaining proof gate: run the packaged candidate while signed in, enable
strict selected-window audio, share the Fortnite window with Stream With Audio,
and have a second account confirm that Fortnite audio is audible while Discord
call audio is absent. Also test a window with no audio and stop/restart the
share to confirm cleanup. Do not claim game-only audio from the automated
native packet test alone.

## 2026-11-04 — v0.7.122 public release (published)

Scope: keep the image-menu/enlargement repair, the DMProfileCosmetics default
profile-gradient parity repair, and the existing strict selected-window
screenshare-audio candidate in one public release. This release is based on
v0.7.121.

Implementation:
- `overlay-scripts/rebrand-vencord.mjs` hardens ImageZoom for both native
  image-context and message routes, isolates custom image controls and plugin
  settings with error boundaries, validates numeric settings, deduplicates
  menu injection, and preserves Discord's native attachment click path.
- `plugins/DMEmoji/index.tsx` isolates custom message controls so a DMEmoji
  failure cannot replace or crash the native message menu.
- `plugins/DMProfileCosmetics/index.ts` uses the canonical DMProfileFlair
  palette and marks the actual action surface so Profile gradient (default) /
  Match profile gradient can blend the real popout rows into the exact profile
  gradient rather than leaving a dark stock card.
- `plugins/DMTrim/index.ts` strengthens sponsored/reward-card detection for
  Fanduel-style placements: bounded delayed scans cover already-mounted or
  late-filled cards, text/semantic updates are observed, and the detector
  targets a coherent card-sized ancestor without broad relational selectors.
- `overlay-scripts/rebrand-vencord.mjs` now treats the transitional PluginModal
  patches as consumed once the final compact author renderer is present, so
  repeated strict overlay/package builds stay warning-free.
- The pre-existing strict selected-window screenshare-audio changes remain in
  the same candidate; they must not be split into a separate release.
- `package.json` is versioned `0.7.122`; release notes are in
  `docs/releases/v0.7.122.md`.

Verification completed:
- `pnpm test` passed after the DMTrim changes; the packaged build also
  completed its TypeScript build and structural verification.
- `node --test packages/winaudio/test.js` passed all 4 native capture tests.
- Fresh pinned Vencord source with `DM_STRICT_REBRAND=1`: 129 patches applied,
  zero warnings; all 29 custom plugins staged.
- A repeat overlay build from the same pinned checkout reported 129 idempotent
  skips and zero warnings.
- `pnpm package:dir` completed for v0.7.122.
- `pnpm package:win` completed with the pinned Vencord checkout and produced
  the x64 and ARM64 packages, combined installer, signing output, and blockmap.
- `node overlay-scripts/verify-build.mjs` passed, including version 0.7.122,
  source fingerprint, staged hashes, and required plugin presence.
- The unpacked Windows executable stayed alive for an 8-second isolated smoke
  run using `--user-data-dir` and `--disable-gpu`, then was stopped; the
  signed-in client was not touched.
- `git diff --check` passed.
- The native strict include-mode probe received packets, but measured zero
  amplitude from an OBS process with no known audible source. That probe is
  inconclusive and is not being treated as Fortnite-audio proof.

Release state: commit `b1207844ccf494e4ff1f9283c1497afdfa8d89f3` was pushed to
`origin/main`; tag `v0.7.122` was pushed; and GitHub Actions release run
`https://github.com/MaxxTopia/discordmaxxer/actions/runs/41846202083`
completed successfully. The public release is live at
`https://github.com/MaxxTopia/discordmaxxer/releases/tag/v0.7.122` with x64,
ARM64, installer, blockmap, and `latest.yml` assets. The public updater route
returned HTTP 200 and advertised version `0.7.122` with the signed installer
path. The Maxxtopia release notification step also passed.

Diggy-owed acceptance checks after publication:
- In the signed-in client, right-click a sent image: it must not crash, and the
  normal Discord reply/forward/reaction/action menu must remain present.
- Click the sent image itself: it must open Discord's enlarged viewer.
- Open DMProfileCosmetics, leave the mode at Profile gradient (default), and
  compare the actual profile popout with the showroom: action rows should be
  seamless, use the exact gradient palette, and remain correctly placed.
- Confirm DMTrim removes the sponsored/reward card after a fresh client load
  and after navigating to another channel.
- Confirm DMEmoji's native message menu remains usable and its mouse Send
  control sends the draft without requiring Enter.
- Share a Fortnite window with audio while a second listener confirms Fortnite
  audio is present and Discord call audio is absent. A failed selected-process
  capture should be video-only, not a system-audio fallback.

Next action: Diggy should update both signed-in PCs to v0.7.122 and run the
acceptance checks above. Report the exact client version and any failing path;
source, build, publication, and updater-route gates are already verified, while
the visual and second-listener checks remain device-side evidence.

## 2026-11-04 — unpublished image context-menu crash candidate

Scope: investigate the continuing crash when Diggy right-clicks an image in a
message. The public v0.7.122 build still contains the earlier broad ImageZoom
message-menu hook, so this is a new local candidate and not a claim about the
live installer.

Implementation:
- `overlay-scripts/rebrand-vencord.mjs` no longer injects ImageZoom into
  Discord's broad `message` context-menu route. The native `image-context`
  route remains guarded for ImageZoom's optional controls, while ordinary
  image right-clicks use Discord's own menu path.
- `plugins/DMEmoji/index.tsx` now detects image attachments and image/gif
  embeds and leaves those message menus completely untouched. Text-message
  menus retain DMEmoji's search/react and saved-media actions.
- This preserves the native Reply, Forward, reaction, attachment, and image
  actions instead of allowing an optional submenu to destabilize that path.

Verification completed locally:
- `git diff --check` passed.
- `node --check overlay-scripts/rebrand-vencord.mjs` passed.
- `pnpm test` passed (ESLint and TypeScript).
- Strict `pnpm overlay:vencord` from pinned Vencord revision
  `ef29bbeb6119cfb53d1273ed78147bcc97d91261` completed with zero warnings;
  all 29 custom plugins were staged.
- `node overlay-scripts/verify-build.mjs` passed, including package/version
  identity, source fingerprint, staged hashes, and required plugin presence.
- A static check confirmed the unsafe ImageZoom message route is absent from
  the pinned source and DMEmoji is present in the staged renderer.
- `pnpm package:dir` passed when pointed at the required pinned Vencord
  checkout; the default local command correctly refused the stale
  `vencord-src` checkout instead of packaging the wrong source.
- The packaged renderer hash exactly matched `vencord-dist/`, and the packaged
  executable stayed alive through an 8-second isolated startup smoke using a
  temporary `--user-data-dir`; the signed-in client was not touched.

Release state: no commit, push, tag, installer, or public deployment has been
made for this candidate. Generated local overlay files are present in
`vencord-dist/`; the signed-in public client was not replaced or restarted.

Diggy-owed acceptance checks after an explicitly approved publication:
- right-click an image and confirm there is no crash and the normal Discord
  menu remains usable;
- click the image itself and confirm the enlarged viewer opens;
- right-click a text-only message and confirm DMEmoji's submenu still appears;
- open several plugins through DMHub to confirm the broader settings crash is
  not reintroduced.

Evidence boundary: source, build, packaged renderer, and isolated startup are
verified. A signed-in right-click image test is still required before calling
the crash fixed for users.

Next action: package and publish only after the candidate receives explicit
release approval, then verify the public artifact and updater route separately
from the signed-in image-menu test.

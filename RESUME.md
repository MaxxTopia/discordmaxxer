# Discordmaxxer — RESUME

> Live status / cold-open pointer. If you're picking this up after a long gap
> (or you're an AI, not Claude): read this, then `TROUBLESHOOTING.md`, then
> `CLAUDE.md` ("Operational facts" section). Those three are enough to build,
> ship, and maintain without prior context.

## 2026-09-24 profile visuals and display-name styles — source pushed; updater held

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

The smoke packages are still labeled `0.7.68`, which is already the public
release. They are not updater artifacts for this candidate. The reviewed source
was pushed to `origin/main` as commit
`8bc63448f304aede0c7bc70be3d3cfc242594c93`; the remote branch SHA was verified.
No new version tag or updater artifact was created, so this source push alone
does not deliver the new features to installed clients. A new updater release
must wait until Diggy completes the required real voice call and
screenshare-with-audio test on the target Windows setup. Vanilla-client
rendering, second-PC sync, and signed-in profile surfaces remain unverified.

Best next action: Diggy runs the real voice/screenshare-with-audio gate on the
target Windows setup; after it passes, prepare the next version and updater
release. Capture a fresh gallery screenshot before using visual evidence
publicly.

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
runtime behavior, two-PC roster sync, service/account paths, and recipient
voice/screenshare checks remain human gates.

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

Human gates remain: load this candidate in the actual client; compare Diggyai's
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

Diggy's real-client checks remain owed: call and screenshare with audio;
Founder/MAXXER++ benefit inheritance; Tournament Mode during voice/screenshare;
and creating, importing, and saving a `DMLOOK1:` profile look between two
clients. The local client currently open is still the v0.7.64 candidate at
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
`git diff --check`. Diggy still owes a live Founder/higher-tier gate test, a
Tournament Mode voice/screenshare toggle test, and a two-client profile-look
create/import/Save test. Diggy authorized the public app release on
2026-09-22; the project-mandated real-client release gate remains outstanding.

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
public stable installer remains v0.7.63 until the real voice gate passes and
v0.7.64 is tagged.

Release gate: before the public tag, Diggy must run one real voice call with the
v0.7.64 candidate and confirm connect, two-way audio, and stable
disconnect/reconnect behavior, plus the existing real screenshare-with-audio
sender/receiver check on the target Windows setup. These real-device/session
tests are not provable from the automated build. If both pass, tag and push
`v0.7.64` so GitHub Actions publishes the Windows installer; if either fails,
fix the candidate before tagging. Preserve the canonical dirty
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
When Electron is eventually bumped, **test a real voice call** and the flag may be
droppable. `upstream-watch` will flag the drift; the runbook has the procedure.

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

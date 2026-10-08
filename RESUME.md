# Discordmaxxer — RESUME

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

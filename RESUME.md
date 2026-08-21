# Discordmaxxer — RESUME

> Live status / cold-open pointer. If you're picking this up after a long gap
> (or you're an AI, not Claude): read this, then `TROUBLESHOOTING.md`, then
> `CLAUDE.md` ("Operational facts" section). Those three are enough to build,
> ship, and maintain without prior context.

## Current maintenance/release state — v0.7.62 release candidate

## 2026-08-21 DMWidget refresh/discovery release candidate

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

Verification for this release candidate: `pnpm test`, strict
`DM_STRICT_REBRAND=1 pnpm overlay:vencord`, `node overlay-scripts/verify-build.mjs`,
`pnpm build:dev`, `pnpm package:dir`, and `pnpm package:win` pass. The cache-busted HenrikDev request returned HTTP 200
with the current account at Diamond 3 / 42 RR during this session. No commit,
push, deployment, or tag release has been made yet; v0.7.61 remains the live version
until the v0.7.62 tag workflow completes.

The rebuilt dev client was opened and checked in the real renderer: the Hub showed
the new shortcut, it opened the DMWidget modal directly, the Jett preset selected,
and the native-backed preview rendered a real image. The Fortnite template showed
the Catwoman preset and a rendered preview as well. The test restored the user's
editor state to Valorant + Automatic and deliberately did not click Create, Update,
or Refresh, so no Discord app/profile data changed. Remaining post-release check:
click Refresh when desired and confirm the already-open profile board redraws;
the release workflow and a real publish/propagation check are still separate from
this local UI test. Preserve the
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

## Current live state — v0.7.61

Released 2026-08-18 through tag `v0.7.61` and the tag-driven GitHub release
workflow. GitHub Release `v0.7.61` is stable and non-draft with HTTP-200
installer, Windows/ARM64 ZIPs, blockmap, and `latest.yml` assets. The updater
manifest declares version `0.7.61` and points to
`Discordmaxxer-Setup-0.7.61.exe`.

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

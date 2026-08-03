# Discordmaxxer — RESUME

> Live status / cold-open pointer. If you're picking this up after a long gap
> (or you're an AI, not Claude): read this, then `TROUBLESHOOTING.md`, then
> `CLAUDE.md` ("Operational facts" section). Those three are enough to build,
> ship, and maintain without prior context.

## Current local state — v0.7.60 (release candidate)

Checkpoint 2026-08-02: the local overlay was rebuilt and verified in the
running Discordmaxxer dev client. Right-clicking a real image attachment now
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

Not released: no commit, push, deploy, or publish was performed. The working
tree still contains Diggy's unrelated DMPresence edits and untracked
DMTranslate/PlaylistmaxxingPresence work; preserve those changes.

Known check state: `pnpm test` is blocked by the existing root-lint failure
because generated `vencord-src` references missing `scripts/header-new.txt`;
`pnpm testTypes` still reports the existing venmic/State/screen-share type
errors. The overlay build itself is the passing verification for this change.

Diggy-owed test: manually right-click an image, drag each zoom slider, and
exercise any Discord keybinds that overlap the configured Discordmaxxer
fallback hotkeys. Best next move is to keep this local for that test; commit
only after the interaction feels correct in the normal window.

## Last published baseline — v0.7.50 (historical release)

Mature, shipping Vesktop fork (Electron 41 + bundled Vencord, pinned to a main
COMMIT). ~30+ Vencord plugins enabled by default + ~24 custom plugins. Repo:
`github.com/MaxxTopia/discordmaxxer` (public, GPL-3.0-or-later). Distributes via
GitHub Releases + in-app electron-updater. That historical baseline was clean
and pushed; do not infer that the current working tree is clean or that local
v0.7.60 changes have been published.

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

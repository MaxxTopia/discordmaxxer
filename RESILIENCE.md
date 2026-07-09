# Discordmaxxer — Voice/Compat Resilience Register

> Produced by the `resilience-audit` skill, 2026-07-06, after the Electron 41->43
> bump (issue #28). Pre-mortem of what can nuke the client — especially
> all-users-at-once — with a detection signal and a plan B for each.
>
> Grounding note: this is built on code that already exists —
> `src/renderer/patches/rtcStats.ts` already tracks every `RTCPeerConnection`
> (`PC_REGISTRY`), `src/main/index.ts` already carries the zstd launch-flag fix,
> and `src/main/updater.ts` already does a startup network fetch. The safeguards
> below extend those, they don't start from zero.

## Fix-class legend

- **HOT** — fixable by a runtime toggle, no restart. True auto-failover possible.
- **RESTART** — fixable by a launch flag / init-time setting. Auto-heal = apply on relaunch.
- **REBUILD** — needs a code change + new release. CANNOT auto-heal; optimize detect + communicate.

## Risk register (ranked: blast radius x likelihood)

| # | Failure | Blast | Trigger | Likelihood | Detection signal | Fix class | Plan B |
|---|---------|-------|---------|-----------|------------------|-----------|--------|
| 1 | **DAVE/zstd-style voice-transport break** — Discord ships a server-side voice change bundled Electron/Chromium can't handle; RTC rejects with 4017, mic captures but no peer connection forms. Voice dead. | **EVERYONE** | Discord server push OR an Electron bump that regresses zstd/WebRTC | Medium — **already happened once**; recurs whenever we drift behind Chromium | Read `iceConnectionState`/`connectionState` off the connections already in `PC_REGISTRY` (rtcStats.ts). Repeated `failed` with 0 successful voice connects in a window = this. | RESTART (it's a `--disable-features` launch flag) | Remote config carries `launch_flags_add`; on detect, apply corrected flags + prompt one-click restart. Until then, in-app banner "voice issue — fix incoming." |
| 2 | **Stale Vencord pin** — pinned Vencord commit drifts; a rebrand/webpack patch silently no-ops ("Patch had no effect"); a feature or the whole client half-breaks. | EVERYONE | Discord webpack change vs an old Vencord pin | Medium — Discord reshuffles webpack often | `overlay:vencord` patch-skip count > 0 at build; `upstream-watch.yml` >30d-behind flag. (Build-time, not runtime.) | REBUILD (re-pin + release) | Remote config `vencord_pin_override` to roll the pin without editing source; else detect at build, block the tag, ship a re-pinned release. |
| 3 | **Bad release / regression** — a build ships that breaks voice, screenshare, or launch for everyone who auto-updates. | EVERYONE | our own tag+release | Low-Medium — no runtime test gate; voice is human-verified only | Post-release: incident spike from the same voice detector (#1); pre-release: the live-voice-call gate. | REBUILD (roll forward) OR HOT (remote-disable the bad feature) | `min_supported_version` + `force_update` in remote config to pull everyone off a known-bad build fast; `disable_plugins` to kill one bad plugin without a rebuild. |
| 4 | **Screenshare audio / echo regression** — encoder falls to software or echo-fix falls back to loopback; choppy stream or Discord-voice bleed. | SOME (streamers) | Electron/Chromium encoder change, GPU driver, winaudio native break | Medium | Already detected — `streamHealthAuto.ts` reads outbound video stats + echo-fix status and shows a verdict. | REBUILD (encoder/winaudio) or config | Extend existing health panel to emit an opt-in telemetry event on `!healthy`; remote banner if a common regression is confirmed. |
| 5 | **Auto-updater dead** — electron-updater can't reach GitHub / `latest.yml` malformed; users stranded on old builds and can't receive fix #1-#3. | EVERYONE (silent) | GitHub outage, bad release asset, unsigned-binary block | Low | `updater.ts` startup `checkForUpdates()` error path (already logs). Heartbeat: count successful update checks. | REBUILD/infra | The remote config is a *second, independent* delivery path — even if the updater is stuck, the launch-time config fetch can still push flags/banners. Redundancy by design. |
| 6 | **Remote-config channel itself down/poisoned** — the safeguard becomes the outage, or a bad config bricks launch. | EVERYONE | Worker over free-tier, bad JSON pushed, KV gone | Low | Config fetch error / schema-validation fail at launch. | HOT (revert config) | **Fail OPEN to last-known-good cached config; never block startup.** Every config change is versioned (git/KV history) and one-command revertable. Config is validated against a schema before apply. |

## The EVERYONE rows, plainly

Rows **#1, #2, #3, #5** can take out **every user at once**. #1 is the one with a live-fire history. All four are covered by the same two-part safeguard below — that's why it's the MVP.

## Safeguard backlog (prioritized)

1. **[MVP] Remote control channel** — a tiny signed JSON on a free CF Worker + KV that the client fetches on launch (alongside the existing updater check) and caches. Fields: `min_supported_version`, `force_update`, `launch_flags_add/remove`, `disable_plugins`, `vencord_pin_override`, `banner`. **Fail open to cache.** This one piece unlocks the plan B for rows #1, #2, #3, #5. Build this first.
2. **Voice-connect detector** — read `iceConnectionState`/`connectionState` off `PC_REGISTRY` (already tracked). Emit an opt-in, anonymous, count-only telemetry event when N consecutive voice connects fail. This is the trigger for #1.
3. **Incident aggregator + alert** — a Worker endpoint counts detector events; a spike DMs the owner via the existing Maxx bot ([[reference_suite_monitor_and_bot_alerts]]) and can stage the matching remote-config change for one-tap approval. Reuse the deployed suite monitor; do not build a new alert stack.
4. **Off-stack dead-man** — the aggregator pings healthchecks.io so a dead monitor is itself caught ([[self-sustaining-service]]).

## What this does NOT promise

- **No magic auto-repair for REBUILD-class breaks.** #2 (re-pin), a genuine encoder regression in #4, and most of #3 need a release. For those the safeguard is *speed to detect + instant owner alert + honest in-app banner*, not self-healing.
- **Launch flags need a relaunch.** #1's auto-failover is "detect -> corrected flags cached -> one-click restart," not a mid-call hot-swap (Chromium can't hot-swap feature flags).
- **Detection telemetry is opt-in and anonymous** (counts, never call content).

## Human-only gate (unchanged)

A live voice call on the target Electron build remains the real acceptance test before any tag. No amount of this tooling replaces it — it makes the *next* break fast to catch and fast to mitigate, not invisible.

# Discordmaxxer — Voice/Compat Resilience Register

> Maintained 2026-08-17 after the upstream Vencord drift review. This is the
> pre-mortem of what can nuke the client — especially
> all-users-at-once — with a detection signal and a plan B for each.
>
> Grounding note: this is built on code that already exists —
> `src/renderer/patches/rtcStats.ts` already tracks every `RTCPeerConnection`
> (`PC_REGISTRY`), `src/main/index.ts` already carries the zstd launch-flag fix,
> and `src/main/updater.ts` already does a startup network fetch. The safeguards
> below extend those, they don't start from zero.

## Current status (2026-08-17)

- The client-side failover path is implemented in `src/main/remoteConfig.ts`,
  `src/main/index.ts`, `src/renderer/patches/rtcStats.ts`, and
  `src/renderer/resilienceBanner.ts`. It reads a cached config synchronously,
  fetches fresh config after startup, reports conservative anonymous incident
  signatures, and fails open to a no-op configuration.
- The public worker is reachable at
  `https://discordmaxxer-resilience.maxxtopia.workers.dev/` and currently
  serves inert config revision 0. The worker and suite-monitor deployment were
  recorded as live in the continuity snapshot; this repository does not store
  their secrets, so do not claim the approval path is healthy without a
  separate authenticated probe.
- The current local candidate has a clean strict overlay, artifact integrity,
  test, build, package, and runtime-validator result. The real voice and
  screenshare-with-audio test remains human-only.
- The client cache boundary now normalizes allowlisted fields, bounds remote
  values, accepts HTTPS-only banner links, and replaces the cache atomically;
  malformed or interrupted updates keep the prior safe state.

## Fix-class legend

- **HOT** — fixable by a runtime toggle, no restart. True auto-failover possible.
- **RESTART** — fixable by a launch flag / init-time setting. Auto-heal = apply on relaunch.
- **REBUILD** — needs a code change + new release. CANNOT auto-heal; optimize detect + communicate.

## Risk register (ranked: blast radius x likelihood)

| #   | Failure                                                                                                                                                                                                    | Blast             | Trigger                                                             | Likelihood                                                                   | Detection signal                                                                                                                                                               | Fix class                                                      | Plan B                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **DAVE/zstd-style voice-transport break** — Discord ships a server-side voice change bundled Electron/Chromium can't handle; RTC rejects with 4017, mic captures but no peer connection forms. Voice dead. | **EVERYONE**      | Discord server push OR an Electron bump that regresses zstd/WebRTC  | Medium — **already happened once**; recurs whenever we drift behind Chromium | Read `iceConnectionState`/`connectionState` off the connections already in `PC_REGISTRY` (rtcStats.ts). Repeated `failed` with 0 successful voice connects in a window = this. | RESTART (it's a `--disable-features` launch flag)              | Remote config carries `launch_flags_add`; on detect, apply corrected flags + prompt one-click restart. Until then, in-app banner "voice issue — fix incoming."                                           |
| 2   | **Stale Vencord pin** — pinned Vencord commit drifts; a rebrand/webpack patch silently no-ops ("Patch had no effect"); a feature or the whole client half-breaks.                                          | EVERYONE          | Discord webpack change vs an old Vencord pin                        | Medium — Discord reshuffles webpack often                                    | `overlay:vencord` patch-skip count > 0 at build; `upstream-watch.yml` >30d-behind flag. (Build-time, not runtime.)                                                             | REBUILD (re-pin + release)                                     | Strict overlay blocks a bad tag. Re-pin the commit, rerun the full gates, and release; `vencord_pin_override` is worker-side metadata only and is not currently consumed by the client.                  |
| 3   | **Bad release / regression** — a build ships that breaks voice, screenshare, or launch for everyone who auto-updates.                                                                                      | EVERYONE          | our own tag+release                                                 | Low-Medium — no runtime test gate; voice is human-verified only              | Post-release: incident spike from the same voice detector (#1); pre-release: the live-voice-call gate.                                                                         | REBUILD (roll forward) OR HOT (remote-disable the bad feature) | `min_supported_version` + `force_update` in remote config to pull everyone off a known-bad build fast; `disable_plugins` to kill one bad plugin without a rebuild.                                       |
| 4   | **Screenshare audio / echo regression** — encoder falls to software or echo-fix falls back to loopback; choppy stream or Discord-voice bleed.                                                              | SOME (streamers)  | Electron/Chromium encoder change, GPU driver, winaudio native break | Medium                                                                       | Already detected — `streamHealthAuto.ts` reads outbound video stats + echo-fix status and shows a verdict.                                                                     | REBUILD (encoder/winaudio) or config                           | Extend existing health panel to emit an opt-in telemetry event on `!healthy`; remote banner if a common regression is confirmed.                                                                         |
| 5   | **Auto-updater dead** — electron-updater can't reach GitHub / `latest.yml` malformed; users stranded on old builds and can't receive fix #1-#3.                                                            | EVERYONE (silent) | GitHub outage, bad release asset, unsigned-binary block             | Low                                                                          | `updater.ts` startup `checkForUpdates()` error path (already logs). Heartbeat: count successful update checks.                                                                 | REBUILD/infra                                                  | The remote config is a _second, independent_ delivery path — even if the updater is stuck, the launch-time config fetch can still push flags/banners. Redundancy by design.                              |
| 6   | **Remote-config channel itself down/poisoned** — the safeguard becomes the outage, or a bad config bricks launch.                                                                                          | EVERYONE          | Worker over free-tier, bad JSON pushed, KV gone                     | Low                                                                          | Config fetch error / malformed fields at launch.                                                                                                                               | HOT (revert config)                                            | **Fail OPEN to last-known-good cached config; never block startup.** The client normalizes the known arrays/banner shape, but signed payloads, strict bounds, and a formal schema remain hardening work. |

## The EVERYONE rows, plainly

Rows **#1, #2, #3, #5** can take out **every user at once**. #1 is the one with a live-fire history. The client and worker cover detection plus a pre-baked plan-B for #1, #3, and #5; #2 still requires a strict-overlay rebuild and release.

## Safeguard backlog (prioritized)

1. **[IMPLEMENTED] Remote control channel** — the client reads a fail-open cached config and the public worker serves the inert default. Keep the approval/revert path authenticated and independently probed; do not treat the channel as a substitute for a release.
2. **[IMPLEMENTED] Voice-connect detector** — `rtcStats.ts` observes `connectionstatechange`/`iceconnectionstatechange`, reports a conservative anonymous signature through IPC, and never touches the connection.
3. **[IMPLEMENTED, VERIFY ON INCIDENT] Incident aggregator + alert** — the worker counts detector events and the existing suite-monitor service binding drives `/sweep`; an authenticated end-to-end alert probe is intentionally not run during ordinary maintenance because it can DM the owner.
4. **[OPEN] Off-stack dead-man** — add an independent health check for the worker/monitor path so a dead monitor is itself caught.
5. **[PARTIAL] Remote-config hardening** — the client now bounds/allowlists
   values and atomically replaces its cache. Worker-side schema enforcement and
   signed or otherwise integrity-checked payloads remain open before adding
   more powerful remediations.

## What this does NOT promise

- **No magic auto-repair for REBUILD-class breaks.** #2 (re-pin), a genuine encoder regression in #4, and most of #3 need a release. For those the safeguard is _speed to detect + instant owner alert + honest in-app banner_, not self-healing.
- **Launch flags need a relaunch.** #1's auto-failover is "detect -> corrected flags cached -> one-click restart," not a mid-call hot-swap (Chromium can't hot-swap feature flags).
- **Detection telemetry is opt-in and anonymous** (counts, never call content).

## Human-only gate (unchanged)

A live voice call on the target Electron build remains the real acceptance test before any tag. No amount of this tooling replaces it — it makes the _next_ break fast to catch and fast to mitigate, not invisible.

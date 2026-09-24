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
  test, build, package, and runtime-validator result. Real voice and
  screenshare-with-audio validation is human-only and is not a universal
  release gate.
- The client cache boundary now normalizes allowlisted fields, bounds remote
  values, accepts HTTPS-only banner links, and replaces the cache atomically;
  malformed or interrupted updates keep the prior safe state.

## Profile flair/media safeguards (2026-09-22 candidate)

- **Roster consistency:** the client replaces the current sanitized roster
  instead of merging stale cosmetic fields, keeps the last good snapshot when
  a refresh fails, retries after 30 seconds, and lets a successful profile
  write paint the current self-view immediately.
- **Cross-PC write safety:** profile writes carry `updatedAt`; a second PC with
  an older snapshot receives a conflict response and must refresh before it can
  overwrite newer flair. Expired or non-Discordmaxxer claims cannot publish.
- **Media boundary:** local image/GIF/video files are never silently shared.
  An explicit publish uploads to the R2-backed worker, caps object sizes,
  supports `HEAD` and single-range reads for reliable rendering, rate-limits
  uploads, and prunes old per-user objects. Native Discord broadcast remains a
  separate one-time action and does not masquerade as shared roster state.
- **Input boundary:** raw hex, theme IDs, rich-presence fields, and VIP claim
  codes now have visual or guided paths first. Swatches/presets apply the
  common choice immediately; advanced fields remain available where intended;
  pasted claim codes are normalized locally, while the worker remains the
  authority for entitlement and binding.
- **Shortcut boundary:** CompactView, TournamentMode, and DMVoiceKeybinds now
  record modifier shortcuts, normalize named keys across the renderer and
  Electron paths, re-register edits immediately, and retain a focused-window
  fallback when another app owns the OS-level combination.
- **Plugin availability boundary:** default seeding, bundles, and the tour use
  exact IDs from the pinned Vencord registry; old aliases migrate once, absent
  legacy IDs are no longer seeded, and DM Hub exposes loaded/off/conditional/
  unavailable status instead of silently creating dead toggles. DMTyping also
  follows the pinned TypingTweaks row class and roster refresh lifecycle, while
  DMGrant retains a legacy settings fallback and DMVotes does not poll a
  locked-out account.
- **Release gate:** this candidate is not live until the R2 bucket exists, the
  worker and app are released as a tested pair, and a real second-client and
  native-recipient check confirm the intended boundaries. Build and unit tests
  cannot prove those external surfaces.

## Follow-up local-media/rendering safeguards (2026-09-23 candidate)

- **Appearance explainability:** the Profile Appearance Center labels each
  gradient/banner/avatar layer as local, URL draft, shared roster, or unset and
  exposes a renderer-health snapshot. This makes precedence and fallback
  failures diagnosable without opening DevTools or guessing whether vanilla
  Discord is involved.
- **Reinstall recovery:** Export/Import appearance backup is an explicit,
  private JSON backup of cosmetic settings and selected local media bytes. It
  excludes claim codes and credentials, has a bounded input size, and never
  uploads anything by itself. A real off-machine copy is still required for
  disaster recovery.
- **Local-file continuity:** a selected profile banner/avatar is copied into
  Vencord's local IndexedDB after the user chooses it, so reopening the editor
  or restarting Discordmaxxer on the same PC can restore the prepared file.
  The UI distinguishes remembered files from session-only files. This is not a
  Windows-reinstall backup and never silently uploads media; shared recovery
  still requires the explicit R2-backed Publish as shared... action.
- **Bounded profile operations:** profile writes, native profile URL reads, and
  still-frame reads abort after 15 seconds; explicit shared media uploads abort
  after 30 seconds and show a retryable error. A stalled worker or dead media
  host therefore cannot leave the editor's busy state hanging forever. A
  timed-out shared gradient write keeps the local gradient applied.
- **Renderer workload bound:** profile-flair mutation scans are skipped while
  the window is hidden, resumed with a fresh avatar sweep on visibility, and
  debounced to a 120ms trailing interval before an animation-frame paint. The
  two-second reconciliation timer also sleeps while hidden. This is a local
  performance guard, not proof of low resource usage on every Discord surface;
  native client/call testing remains the evidence gate.
- **Media-failure fallback:** image/video probes mark a failing shared URL for
  the session, restore Discord's original banner/avatar/background, and expose
  the latest failure in renderer health. This prevents a dead host from
  repeatedly flashing broken media on every mutation.
- **Reduced-motion boundary:** the default reduced-motion guard suppresses
  custom banner/avatar media while preserving theme gradients; TournamentMode
  remains an explicit stronger performance gate. Both are user-visible in the
  editor so a deliberate suppression is not mistaken for a broken gradient.
- **Component-share safety:** banner-only, avatar-only, and gradient-only
  profile-look codes are sanitized through the same bounded decoder and apply
  only their named component. They cannot carry claim codes or silently clear
  unrelated profile fields.

## Fix-class legend

- **HOT** — fixable by a runtime toggle, no restart. True auto-failover possible.
- **RESTART** — fixable by a launch flag / init-time setting. Auto-heal = apply on relaunch.
- **REBUILD** — needs a code change + new release. CANNOT auto-heal; optimize detect + communicate.

## Risk register (ranked: blast radius x likelihood)

| #   | Failure                                                                                                                                                                                                    | Blast             | Trigger                                                             | Likelihood                                                                   | Detection signal                                                                                                                                                               | Fix class                                                      | Plan B                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **DAVE/zstd-style voice-transport break** — Discord ships a server-side voice change bundled Electron/Chromium can't handle; RTC rejects with 4017, mic captures but no peer connection forms. Voice dead. | **EVERYONE**      | Discord server push OR an Electron bump that regresses zstd/WebRTC  | Medium — **already happened once**; recurs whenever we drift behind Chromium | Read `iceConnectionState`/`connectionState` off the connections already in `PC_REGISTRY` (rtcStats.ts). Repeated `failed` with 0 successful voice connects in a window = this. | RESTART (it's a `--disable-features` launch flag)              | Remote config carries `launch_flags_add`; on detect, apply corrected flags + prompt one-click restart. Until then, in-app banner "voice issue — fix incoming."                                           |
| 2   | **Stale Vencord pin** — pinned Vencord commit drifts; a rebrand/webpack patch silently no-ops ("Patch had no effect"); a feature or the whole client half-breaks.                                          | EVERYONE          | Discord webpack change vs an old Vencord pin                        | Medium — Discord reshuffles webpack often                                    | `overlay:vencord` patch-skip count > 0 at build; `upstream-watch.yml` >30d-behind flag. (Build-time, not runtime.)                                                             | REBUILD (re-pin + release)                                     | Strict overlay blocks a bad tag. Re-pin the commit and pass strict-overlay/artifact checks; `vencord_pin_override` is worker-side metadata only and is not currently consumed by the client.            |
| 3   | **Bad release / regression** — a build ships that breaks voice, screenshare, or launch for everyone who auto-updates.                                                                                      | EVERYONE          | our own tag+release                                                 | Low-Medium — live session quality is not universally tested pre-release    | Post-release: incident spike from the same voice detector (#1); no mandatory pre-release live-call gate.                                                                        | REBUILD (roll forward) OR HOT (remote-disable the bad feature) | `min_supported_version` + `force_update` in remote config to pull everyone off a known-bad build fast; `disable_plugins` to kill one bad plugin without a rebuild.                                       |
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

## Human-only quality checks (not a release gate)

Real voice and screenshare-with-audio sessions are the only way to prove those
paths work with a recipient, but they are optional, non-blocking quality checks
and are not required before a tag. When they are not run, describe those paths
as unverified. The detector and recovery plan reduce incident time; they do not
turn automated checks into live-session proof.

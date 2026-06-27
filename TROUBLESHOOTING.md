# Discordmaxxer — Troubleshooting Runbook

A self-contained playbook for diagnosing and fixing the failures most likely to
hit Discordmaxxer, so anyone (you, a new contributor, or any AI assistant) can
fix them fast — without needing the original author or prior context.

The golden rule for **any** "X used to work, now it's broken in Discordmaxxer
but works in real Discord / a browser" report: **Discord shipped a change the
build hasn't caught up to.** Don't assume the user's machine. Reproduce, read
the console, find the close code or error, match it below.

---

## How to read what's actually happening (do this first)

1. Open Discordmaxxer → press **Ctrl+Shift+I** → **Console** tab.
2. Reproduce the problem (join voice, send a message, etc.).
3. Scan for **red errors** and lines in brackets like `[RTCConnection]`,
   `[RTCControlSocket]`, `[LibDaveManager]`, `[GatewaySocket]`.
4. For voice specifically, the key datum is the **WebSocket close code** —
   `[WS CLOSED] (... code: NNNN, reason: ...)`.
5. For asset/network failures, look for `Failed to load resource: net::ERR_...`.

The built-in **DMVoiceGuard** plugin watches for this automatically and, on a
detected voice failure, shows a banner with a **Copy report** button — that
report is the console evidence you need, pre-collected.

To compare against a known-good client: open `discord.com/app` in a normal
browser on the same machine. If it works there but not in Discordmaxxer, the
cause is in **our build** (Electron/Chromium version, a flag, or a patch), not
the network or the user's PC.

---

## Voice: RTC / WebSocket close codes

Voice connects to `wss://<region>.discord.media`. After it authenticates, a
close code tells you why it dropped. Repeated cycling = a fatal close looping.

| Code | Reason | Likely cause | Fix |
|---|---|---|---|
| **4017** | `E2EE/DAVE protocol required` | Discord requires its DAVE end-to-end voice encryption, and the **DAVE WebAssembly module failed to load** (look for `net::ERR_CONTENT_DECODING_FAILED` on a `/assets/*.wasm` + `[LibDaveManager] Failed to initialize DAVE`). Discord serves that wasm `Content-Encoding: zstd`, and Electron's webRequest-intercepted response path (Vencord hooks `onHeadersReceived` for CSP) can't decode zstd. | Disable zstd so the CDN serves br/gzip. **Already applied** in `src/main/index.ts`: `disabledFeatures.add("ZstdContentEncoding")` + `"SharedZstd"`. If it regresses, confirm those are still in the disabled-features list. The deeper fix is bumping Electron (see below). |
| **4016** | `unknown encryption mode` | Discord dropped an old voice encryption mode the bundled WebRTC still offers. | Bump Electron to a version whose libwebrtc supports the required AEAD `_rtpsize` modes. |
| 4006 | `session is no longer valid` | Usually **fallout** from a real failure above (the loop re-auths with a stale session). Fix the root close code, not this. | — |
| 4014 | disconnected (kicked / channel deleted / permissions) | Often legitimate. | Not a build bug unless it loops with another code. |
| 4015 | voice server crashed | Discord-side, transient. | Wait / retry. |

**Symptom signature of the DAVE/zstd class (the 2026-06 outage):**
mic capture (`getUserMedia`) succeeds, **no `RTCPeerConnection` ever forms** in
`chrome://webrtc-internals`, console shows the wasm `ERR_CONTENT_DECODING_FAILED`
→ `Failed to initialize DAVE` → `[WS CLOSED] code: 4017` on a loop. This broke
voice for **every** user, not just one — it's a build issue, ship a fix release.

---

## Assets fail with `net::ERR_CONTENT_DECODING_FAILED`

The response body couldn't be decompressed — a **content-encoding** the build
can't decode. Almost always **zstd**: Electron's webRequest-intercepted response
path (active because Vencord registers `onHeadersReceived`) doesn't decode zstd,
even on a Chromium that normally would. Garbled fonts (`OTS parsing error:
invalid sfntVersion: 0`) are the same root cause.

- **Fix (applied):** disable the `ZstdContentEncoding` Chromium feature so the
  client stops advertising `zstd` in `Accept-Encoding`; the CDN falls back to
  brotli/gzip, which Electron decodes. See `src/main/index.ts`.
- **Do NOT** try to strip `Accept-Encoding` in `webRequest.onBeforeSendHeaders`
  — Electron doesn't expose that header there, so it silently no-ops (this was a
  failed first attempt, v0.7.30). Use the feature flag.
- A corrupt/cached copy of the asset can persist for **one launch** after a fix
  ships; a reload (Ctrl+R) or restart clears it.

---

## The deeper fix for the whole class: stay current with Electron / Vesktop

The reason these break is the build **falling behind** Discord. A newer Electron
(newer Chromium/libwebrtc) decodes zstd and supports current voice encryption
out of the box. When you take an Electron bump:

1. Update `electron` in `package.json` (keep it in step with upstream Vesktop
   where practical — see their `package.json`).
2. `pnpm install && pnpm overlay:vencord && pnpm build`.
3. **Test a real voice call** before releasing. If voice works on the new
   Electron, the `ZstdContentEncoding` / `SharedZstd` disables in
   `src/main/index.ts` may no longer be needed — but they're harmless to leave.

The `upstream-watch` GitHub Action opens an issue when upstream Vesktop or its
Electron pin moves ahead of ours, so this never goes unnoticed.

---

## Cutting a fix release

```powershell
# bump "version" in package.json, then:
git add -A
git commit -m "release: vX.Y.Z — <what>"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z   # tag push triggers the Release workflow (CI builds + publishes)
```

CI (`.github/workflows/release.yml`) runs `pnpm overlay:vencord` (rebuilds
Vencord with our `plugins/`) + `pnpm build` + `electron-builder --publish`, and
uploads the installer + `latest.yml`. Users get it via the in-app updater.

Verify after: `gh release view vX.Y.Z -R MaxxTopia/discordmaxxer` should list
`Discordmaxxer-Setup-X.Y.Z.exe` and `latest.yml`.

---

## Self-maintenance: what runs automatically + how to respond

Discordmaxxer is built to keep itself alive and **tell a human when it can't** —
so it survives without the original author. A Vesktop fork rides three moving
externals (Discord's web client, Vencord `main`, Electron); novel breakage still
needs a code fix, but detection, recovery, and alerting are automated.

**Always-on safety nets (no action needed):**
- **Auto-update:** `src/main/updater.ts` checks GitHub on launch **and every 6h**,
  and applies a downloaded update on next quit. So a shipped fix reaches users
  even if they never restart deliberately.
- **In-app failure banner:** `DMVoiceGuard` shows a banner + "Copy report" when
  voice fails (see top of this doc).
- **Graceful fallbacks:** winaudio→system loopback, RNNoise mic→raw mic, zstd
  disabled, screenshare quality cap. A failed feature degrades, never crashes.

**CI gates (a bad build can't publish):**
- **Strict rebrand** — `release.yml` runs the overlay with `DM_STRICT_REBRAND=1`,
  so `rebrand-vencord.mjs` FAILS the release if any rebrand patch went stale
  (un-rebranded "Vencord" surfaces / stale plugin patch).
- **Artifact integrity** — `overlay-scripts/verify-build.mjs` fails the release
  if the Vencord dist is hollow or our custom plugins didn't compile in.
- A failed gate = the release stops and you get a **Maxx-bot DM** (below).

**Maxx-bot alerts (DMs to Diggy via the Maxxtopia bot — `scripts/notify-maxx.sh`).**
Requires repo secret `MAXX_BOT_TOKEN` (the bot token). Set once:
`gh secret set MAXX_BOT_TOKEN -R MaxxTopia/discordmaxxer`. If unset, alerts just
no-op (nothing breaks). What each DM means and what to do:

| DM you receive | What happened | Your move |
|---|---|---|
| "RELEASE FAILED for vX.Y.Z" | A tag-push release hit a gate/build/publish error; nothing shipped | Open the linked run, read the failing step. Stale-rebrand → fix find-strings (see "stay current"). Integrity → the overlay produced a bad bundle, re-run. |
| "upstream drift detected" | A dependency (Electron/Vencord) fell behind upstream | Review the tracking issue; decide if an Electron/Vencord bump is needed. Bump → test voice → release. |
| "auto-rebump shipped CANARY ...-beta.1" | The ShowHiddenChannels fix landed; a **prerelease** auto-shipped to beta users only | Update on a beta-opted client, test a voice call, then promote: bump `package.json` to the base version, tag it, push. |
| "auto-rebump FAILED to verify" | The auto re-pin didn't verify clean; nothing shipped | A rebrand patch needs updating vs new Vencord (see the manual-review issue). |

**Canary auto-rebump:** `vencord-shc-autobump.yml` watches Vencord bug #4256; when
it closes, it re-pins Vencord and ships a **`-beta.1` prerelease** (only DMBeta /
`allowPrerelease` users auto-update) — never straight to everyone. Promote to
stable manually after a voice test. This is the audit-2026-06-26 H1 safeguard.

**Drift detection:** `upstream-watch.yml` (weekly) opens a tracking issue **and**
DMs when Electron/Vencord move ahead of our pins.

---

## Where things live

| What | Where |
|---|---|
| Chromium flags / feature disables | `src/main/index.ts` (the `disabledFeatures` set) |
| Custom plugins (incl. DMVoiceGuard) | `plugins/` (merged into Vencord by `pnpm overlay:vencord`) |
| Default-on plugin list | `src/main/discordmaxxerDefaults.ts` |
| Auto-updater | `src/main/updater.ts` (electron-updater → GitHub Releases) |
| In-app updater UI | `static/views/updater/` |
| Voice failure watcher | `plugins/DMVoiceGuard/` |
| Maxx-bot CI alerts | `scripts/notify-maxx.sh` (needs secret `MAXX_BOT_TOKEN`) |
| Release integrity gate | `overlay-scripts/verify-build.mjs` |
| Strict-rebrand gate | `overlay-scripts/rebrand-vencord.mjs` (`DM_STRICT_REBRAND=1`) |
| Auto-rebump (canary) | `.github/workflows/vencord-shc-autobump.yml` |
| Upstream drift watch | `.github/workflows/upstream-watch.yml` |

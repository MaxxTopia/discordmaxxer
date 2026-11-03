/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Discordmaxxer — performance-mode bridge
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Real CPU/GPU savings for TournamentMode. Two working knobs + one deferred:
 *
 *   1. Process priority — drop the heavy processes (renderer + GPU + main) to
 *      BELOW_NORMAL on Windows so the game wins CPU/GPU scheduling. CRITICAL
 *      EXCEPTIONS (never throttled): the audio + network utility processes
 *      (local audio I/O + RTC transport), and — while the user is in a voice
 *      call or streaming — the renderer and GPU too, because the WebRTC Opus
 *      encode/decode + NetEq jitter buffer run on threads INSIDE the renderer
 *      and HW screenshare encode uses the GPU. This is what stops TournamentMode
 *      from sacrificing in-game voice/stream quality. (audit 2026-06-26)
 *
 *   2. arRPC worker — terminate the Rich Presence server worker thread when
 *      perf mode is on. Saves a worker thread + IPC server + game-process
 *      polling. Toggles the user's existing Settings.store.arRPC flag (saved +
 *      restored on toggle off).
 *
 *   3. Background/occlusion throttling — normal Chromium scheduling applies
 *      while idle or minimized; a live voice/stream explicitly opts out so
 *      WebRTC audio and capture are never background-throttled.
 *
 *   (deferred) Renderer frame-rate cap — webContents.setFrameRate(30) only takes
 *      effect under offscreen rendering, which this app does NOT use, so on a
 *      normal windowed BrowserWindow it is a SILENT NO-OP. It is left as a
 *      harmless best-effort call but is NOT reported as a GPU saving. The
 *      background-throttling path below is the real hidden-window lever.
 *
 * Cosmetic-only changes (animation strips, badge hiding) live in the
 * TournamentMode plugin's CSS — not here. This file is system-level only,
 * matching the principle: "if it doesn't add lag, leave it on."
 */

import { app, BrowserWindow, webContents } from "electron";
import { setPriority } from "os";

import { type DmPerformanceModeOptions, IpcEvents } from "../shared/IpcEvents";
import { Settings } from "./settings";
import { handle } from "./utils/ipcWrappers";

// Node's os.setPriority mapping (Windows-mapped):
//   0  = NORMAL          (NORMAL_PRIORITY_CLASS)
//   10 = BELOW_NORMAL    (BELOW_NORMAL_PRIORITY_CLASS)
//   19 = IDLE            (IDLE_PRIORITY_CLASS)
const PRIORITY_BELOW_NORMAL = 10;
const PRIORITY_NORMAL = 0;

const FRAME_RATE_PERF = 30;
const FRAME_RATE_NORMAL = 60;

// Utility processes we must NEVER throttle while gaming. Starving these under
// full game-CPU load is a way TournamentMode could "sacrifice audio":
//   - Audio Service does the audio device I/O (WASAPI capture/render).
//   - Network Service carries the RTC media (UDP) packets.
//   - video/capture/media/WebRTC helpers can carry an active stream's media.
// Matched against ProcessMetric.name + serviceName for type === "Utility".
const PROTECTED_UTILITY_RE = /audio|network|capture|video|media|webrtc|rtc/i;

interface PerfState {
    priorArRpc: boolean | null;
    on: boolean;
    lowerProcessPriority: boolean;
    capFrameRate: boolean;
    disableArRpc: boolean;
}

const state: PerfState = {
    priorArRpc: null,
    on: false,
    lowerProcessPriority: true,
    capFrameRate: true,
    disableArRpc: true
};

// Whether the user is currently in a voice channel (and therefore possibly
// talking or streaming). Pushed from the renderer (TournamentMode plugin
// subscribes to VOICE_CHANNEL_SELECT). When true AND perf mode is on, we keep
// the renderer + GPU at NORMAL priority so voice/stream encode isn't starved.
let voiceActive = false;

export function isVoiceActive(): boolean {
    return voiceActive;
}

function setAllRendererFrameRates(fps: number) {
    // NOTE: no-op on windowed BrowserWindows (setFrameRate needs offscreen
    // rendering). Kept best-effort; intentionally NOT surfaced as a perf win.
    for (const wc of webContents.getAllWebContents()) {
        try {
            wc.setFrameRate(fps);
        } catch {
            // some webContents (devtools, internal) reject setFrameRate
        }
    }
}

// The target priority for a single process given the current perf + voice state.
function priorityTargetFor(type: string, name: string, serviceName: string): number {
    // AUDIO INTEGRITY GUARANTEE:
    // A call or stream keeps every core process at NORMAL. This is deliberately
    // conservative because WebRTC Opus decode, NetEq jitter buffers, and HW
    // screenshare encode can run inside the renderer/GPU, not only in a named
    // utility process.
    if (!state.on || !state.lowerProcessPriority || voiceActive) return PRIORITY_NORMAL;

    const kind = String(type ?? "")
        .trim()
        .toLowerCase();
    const mediaIdentity = `${name ?? ""} ${serviceName ?? ""}`;
    if (kind === "utility" && PROTECTED_UTILITY_RE.test(mediaIdentity)) return PRIORITY_NORMAL;
    if (PROTECTED_UTILITY_RE.test(mediaIdentity)) return PRIORITY_NORMAL;

    // With no active call/stream, let the game win scheduling time from the
    // client process tree. Browser is the Electron main process; Tab/Renderer
    // and GPU cover the visible Discord UI and compositor. Non-media utility
    // helpers can yield too. Unknown process types stay NORMAL by default.
    if (kind === "browser" || kind === "tab" || kind === "renderer" || kind === "gpu") return PRIORITY_BELOW_NORMAL;
    if (kind === "utility") return PRIORITY_BELOW_NORMAL;
    return PRIORITY_NORMAL;
}

// Set every Discordmaxxer process to its correct priority for the current
// (state.on, voiceActive) combination. Idempotent — safe to call on perf
// toggle, on voice-state change, and on new-window creation. app.getAppMetrics()
// enumerates main, gpu, renderer(s), and utility processes; os.setPriority takes
// a pid. Per-pid try/catch because a child can exit mid-iteration.
function applyProcessPriorities(): boolean {
    let metrics: ReturnType<typeof app.getAppMetrics> = [];
    try {
        metrics = app.getAppMetrics();
    } catch (e) {
        console.warn("[Discordmaxxer] getAppMetrics failed:", (e as Error).message);
    }

    let count = 0;
    let sawMain = false;
    for (const m of metrics) {
        if (typeof m.pid !== "number") continue;
        if (m.pid === process.pid) sawMain = true;
        const target = priorityTargetFor(m.type, m.name ?? "", m.serviceName ?? "");
        try {
            setPriority(m.pid, target);
            count++;
        } catch {
            // transient/exited child process — skip it
        }
    }
    // Fallback: ensure our own (main) process is set even if metrics was empty.
    if (!sawMain) {
        try {
            setPriority(process.pid, priorityTargetFor("Browser", "", ""));
            count++;
        } catch {
            // ignore
        }
    }
    if (count === 0) console.warn("[Discordmaxxer] setPriority: no processes updated");
    return count > 0;
}

/** Keep background scheduling conservative for idle windows, but never let a
 * live call/stream lose renderer time to Chromium's background timer policy.
 * This is intentionally independent of Tournament Mode: normal Discordmaxxer
 * should follow Chromium's standard idle behavior too, while voice safety is
 * a property of the active call rather than of the visual performance mode.
 */
function applyBackgroundThrottling(): boolean {
    let changed = false;
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
            win.webContents.setBackgroundThrottling(!voiceActive);
            changed = true;
        } catch {
            // A renderer can disappear during reload; the next voice/window
            // event will apply the policy to the replacement webContents.
        }
    }
    return changed;
}

function normalizedPerformanceOptions(options?: Partial<DmPerformanceModeOptions>): DmPerformanceModeOptions {
    return {
        lowerProcessPriority: options?.lowerProcessPriority !== false,
        capFrameRate: options?.capFrameRate !== false,
        disableArRpc: options?.disableArRpc !== false
    };
}

function syncArRpcPolicy(on: boolean): boolean {
    let touched = false;
    if (!on || !state.disableArRpc) {
        if (state.priorArRpc === true && Settings.store.arRPC !== true) {
            Settings.store.arRPC = true;
            touched = true;
        }
        state.priorArRpc = null;
        return touched;
    }

    if (state.priorArRpc === null) {
        state.priorArRpc = Settings.store.arRPC === true;
        if (state.priorArRpc) {
            Settings.store.arRPC = false; // change-listener in arrpc/index.ts handles teardown
            touched = true;
        }
    }
    return touched;
}

handle(IpcEvents.DM_SET_PERFORMANCE_MODE, (_e, on: boolean, rawOptions?: Partial<DmPerformanceModeOptions>) => {
    const options = normalizedPerformanceOptions(rawOptions);
    const optionsChanged =
        state.lowerProcessPriority !== options.lowerProcessPriority ||
        state.capFrameRate !== options.capFrameRate ||
        state.disableArRpc !== options.disableArRpc;
    if (on === state.on && !optionsChanged) {
        return { priorityChanged: false, frameRateLimited: false, arRpcDisabled: false };
    }

    const wasCapFrameRate = state.capFrameRate;
    state.on = on;
    state.lowerProcessPriority = options.lowerProcessPriority;
    state.capFrameRate = options.capFrameRate;
    state.disableArRpc = options.disableArRpc;
    const priorityChanged = applyProcessPriorities();
    applyBackgroundThrottling();
    // setFrameRate is a harmless best effort, but Chromium ignores it for a
    // normal windowed BrowserWindow. Avoid touching every webContents when the
    // user explicitly disables the unsupported cap.
    if (state.capFrameRate || wasCapFrameRate) setAllRendererFrameRates(on ? FRAME_RATE_PERF : FRAME_RATE_NORMAL);

    const arRpcDisabled = syncArRpcPolicy(on);

    console.log(
        `[Discordmaxxer] PerfMode ${on ? "ON" : "OFF"} — priority=${priorityChanged} lowerPriority=${state.lowerProcessPriority} voiceActive=${voiceActive} arRpc=${arRpcDisabled} capFrameRate=${state.capFrameRate}`
    );

    // frameRateLimited is intentionally always false: the cap is a no-op on
    // windowed mode, so we don't claim a GPU saving we aren't delivering.
    return { priorityChanged, frameRateLimited: false, arRpcDisabled };
});

// Renderer reports voice-channel join/leave. While perf mode is on, joining a
// call restores renderer+GPU to NORMAL (protect voice/stream encode); leaving
// drops them back to BELOW_NORMAL for the full perf win.
handle(IpcEvents.DM_SET_VOICE_ACTIVE, (_e, active: boolean) => {
    const next = !!active;
    if (next === voiceActive) return { reapplied: false };
    voiceActive = next;

    // Voice active: keep every renderer's clocks live for WebRTC. Voice
    // inactive: restore Chromium's standard idle/occlusion throttling.
    applyBackgroundThrottling();

    const reapplied = state.on ? applyProcessPriorities() : false;
    if (reapplied) console.log(`[Discordmaxxer] voiceActive=${voiceActive} — re-balanced priorities`);
    return { reapplied };
});

// A new window/renderer coming online while perf mode is on needs its priority
// set so it inherits the right class (e.g. unfocus → new-window). Best-effort:
// if the child isn't in getAppMetrics yet, the next perf/voice event catches it.
app.on("browser-window-created", (_e, _win: BrowserWindow) => {
    applyBackgroundThrottling();
    if (state.on) applyProcessPriorities();
});

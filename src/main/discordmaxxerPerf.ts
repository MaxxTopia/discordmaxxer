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
 *   (deferred) Renderer frame-rate cap — webContents.setFrameRate(30) only takes
 *      effect under offscreen rendering, which this app does NOT use, so on a
 *      normal windowed BrowserWindow it is a SILENT NO-OP. It is left as a
 *      harmless best-effort call but is NOT reported as a GPU saving. The real
 *      "throttle the hidden window" lever is backgroundThrottling, which is
 *      force-disabled elsewhere for voice reasons and needs a live voice test
 *      before it can be conditionally re-enabled. See AUDIT-2026-06-26.md (H3).
 *
 * Cosmetic-only changes (animation strips, badge hiding) live in the
 * TournamentMode plugin's CSS — not here. This file is system-level only,
 * matching the principle: "if it doesn't add lag, leave it on."
 */

import { app, BrowserWindow, webContents } from "electron";
import { setPriority } from "os";

import { IpcEvents } from "../shared/IpcEvents";
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
// Matched against ProcessMetric.name + serviceName for type === "Utility".
const PROTECTED_UTILITY_RE = /audio|network/i;

interface PerfState {
    priorArRpc: boolean | null;
    on: boolean;
}

const state: PerfState = {
    priorArRpc: null,
    on: false
};

// Whether the user is currently in a voice channel (and therefore possibly
// talking or streaming). Pushed from the renderer (TournamentMode plugin
// subscribes to VOICE_CHANNEL_SELECT). When true AND perf mode is on, we keep
// the renderer + GPU at NORMAL priority so voice/stream encode isn't starved.
let voiceActive = false;

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
    if (!state.on) return PRIORITY_NORMAL;
    // Audio + network utility: never throttle (local audio I/O + RTC transport).
    if (type === "Utility" && PROTECTED_UTILITY_RE.test(`${name} ${serviceName}`)) {
        return PRIORITY_NORMAL;
    }
    // In a voice call / streaming: keep the renderer (Opus encode/decode + NetEq
    // run here) and the GPU (HW screenshare encode) at NORMAL too.
    if (voiceActive && (type === "GPU" || type === "Tab")) {
        return PRIORITY_NORMAL;
    }
    return PRIORITY_BELOW_NORMAL;
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
            setPriority(process.pid, state.on ? PRIORITY_BELOW_NORMAL : PRIORITY_NORMAL);
            count++;
        } catch {
            // ignore
        }
    }
    if (count === 0) console.warn("[Discordmaxxer] setPriority: no processes updated");
    return count > 0;
}

handle(IpcEvents.DM_SET_PERFORMANCE_MODE, (_e, on: boolean) => {
    if (on === state.on) {
        return { priorityChanged: false, frameRateLimited: false, arRpcDisabled: false };
    }

    state.on = on;
    const priorityChanged = applyProcessPriorities();
    setAllRendererFrameRates(on ? FRAME_RATE_PERF : FRAME_RATE_NORMAL);

    let arRpcDisabled = false;
    if (on) {
        if (Settings.store.arRPC === true) {
            state.priorArRpc = true;
            Settings.store.arRPC = false; // change-listener in arrpc/index.ts handles teardown
            arRpcDisabled = true;
        } else {
            state.priorArRpc = false;
        }
    } else {
        if (state.priorArRpc === true) {
            Settings.store.arRPC = true; // change-listener restarts the worker
            arRpcDisabled = true; // semantics: "we touched arRpc"
        }
        state.priorArRpc = null;
    }

    console.log(
        `[Discordmaxxer] PerfMode ${on ? "ON" : "OFF"} — priority=${priorityChanged} voiceActive=${voiceActive} arRpc=${arRpcDisabled}`
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
    const reapplied = state.on ? applyProcessPriorities() : false;
    if (reapplied) console.log(`[Discordmaxxer] voiceActive=${voiceActive} — re-balanced priorities`);
    return { reapplied };
});

// A new window/renderer coming online while perf mode is on needs its priority
// set so it inherits the right class (e.g. unfocus → new-window). Best-effort:
// if the child isn't in getAppMetrics yet, the next perf/voice event catches it.
app.on("browser-window-created", (_e, _win: BrowserWindow) => {
    if (!state.on) return;
    applyProcessPriorities();
});

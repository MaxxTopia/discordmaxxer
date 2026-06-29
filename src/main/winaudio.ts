/*
 * Discordmaxxer — winaudio bridge (Windows-only)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Bridges the native packages/winaudio module (per-output-device WASAPI
 * loopback) into the renderer via IPC. Replaces Electron's default-device-
 * only "loopback" string for users with audio mixers (Voicemeeter / VB-
 * Cable / EqualizerAPO) where the system default is a virtual mix.
 *
 * Audio chunks flow main → renderer via webContents.send(DM_WIN_AUDIO_CHUNK).
 * At ~50 chunks/sec × ~3-4KB each, this is well within IPC bandwidth.
 *
 * The actual screenshare-track replacement (Web Audio AudioContext →
 * MediaStream → RTCPeerConnection.replaceTrack) lives in the renderer —
 * see src/renderer/components/ScreenSharePicker.tsx.
 */

import { BrowserWindow } from "electron";

import { IpcEvents } from "../shared/IpcEvents";
import { handle } from "./utils/ipcWrappers";

interface WinAudioModule {
    listOutputDevices: () => { devices: Array<{ id: string; name: string; isDefault: boolean }> };
    startCapture: (
        deviceId: string,
        onChunk: (chunk: { data: Buffer; frameCount: number; timestamp100ns: bigint; silent: boolean }) => void,
    ) => { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean };
    stopCapture: () => void;
    isCapturing: () => boolean;
    enumerateAudioSessions: () => {
        sessions: Array<{ pid: number; processName: string; displayName: string; isActive: boolean }>;
    };
    startProcessLoopback: (
        targetPid: number,
        mode: "include" | "exclude",
        onChunk: (chunk: { data: Buffer; frameCount: number; timestamp100ns: bigint; silent: boolean }) => void,
    ) => { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean };
    // Pull PCM chunks parked by the native capture thread. Polled by the JS
    // side because the ThreadSafeFunction push path is never serviced in the
    // Electron main process.
    drainChunks: () => Array<{ data: Buffer; frameCount: number; timestamp100ns: bigint; silent: boolean }>;
}

// The native onChunk callback (ThreadSafeFunction) NEVER fires in the Electron
// main process (Electron doesn't service the TSFN's async handle, even while JS
// timers run — verified end-to-end). So we ignore that callback and instead
// POLL mod.drainChunks() on a timer, which IS serviced, and forward each chunk
// to the renderer. One poller at a time (captures are single-instance).
const NOOP_CHUNK = () => { /* unused — delivery is via the drainChunks poller */ };
let chunkPoller: ReturnType<typeof setInterval> | null = null;

function startChunkForwarding(mod: WinAudioModule, win: BrowserWindow | null) {
    stopChunkForwarding();
    if (!win || win.isDestroyed()) return;
    chunkPoller = setInterval(() => {
        if (!win || win.isDestroyed()) { stopChunkForwarding(); return; }
        let chunks;
        try {
            chunks = mod.drainChunks();
        } catch {
            return;
        }
        for (const chunk of chunks) {
            win.webContents.send(IpcEvents.DM_WIN_AUDIO_CHUNK, {
                data: chunk.data,
                frameCount: chunk.frameCount,
                timestamp100ns: chunk.timestamp100ns.toString(),
                silent: chunk.silent,
            });
        }
    }, 10);
}

function stopChunkForwarding() {
    if (chunkPoller) {
        clearInterval(chunkPoller);
        chunkPoller = null;
    }
}

// Lazy-load — winaudio only ships on Windows, and we don't want missing-module
// errors crashing the main process on Linux/macOS dev builds.
let winaudio: WinAudioModule | null = null;
let loadAttempted = false;
let loadError: string | null = null;

function load(): WinAudioModule | null {
    if (loadAttempted) return winaudio;
    loadAttempted = true;
    if (process.platform !== "win32") {
        loadError = "winaudio is Windows-only";
        return null;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        winaudio = require("winaudio");
        return winaudio;
    } catch (e: any) {
        loadError = String(e?.message || e);
        console.warn("[winaudio] load failed:", loadError);
        return null;
    }
}

handle(IpcEvents.DM_WIN_AUDIO_LIST, async () => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        return { ok: true, devices: mod.listOutputDevices().devices };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

handle(IpcEvents.DM_WIN_AUDIO_START, async (event, deviceId: string) => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    const win = BrowserWindow.fromWebContents(event.sender);
    // Don't start native capture if there's no live window to drain it — the
    // native ring buffer would grow unbounded with nothing forwarding chunks.
    if (!win || win.isDestroyed()) return { ok: false, error: "no live window" };
    try {
        const format = mod.startCapture(deviceId, NOOP_CHUNK);
        startChunkForwarding(mod, win);
        return { ok: true, format };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

handle(IpcEvents.DM_WIN_AUDIO_STOP, async () => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        stopChunkForwarding();
        mod.stopCapture();
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

handle(IpcEvents.DM_WIN_AUDIO_SESSIONS, async () => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        return { ok: true, sessions: mod.enumerateAudioSessions().sessions };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

handle(
    IpcEvents.DM_WIN_AUDIO_START_PROCESS,
    async (event, targetPid: number, mode: "include" | "exclude") => {
        const mod = load();
        if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) return { ok: false, error: "no live window" };
        try {
            const format = mod.startProcessLoopback(targetPid, mode, NOOP_CHUNK);
            startChunkForwarding(mod, win);
            return { ok: true, format };
        } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
        }
    },
);

// Exclude-self: capture the WHOLE system output mix EXCEPT this app's own
// process tree. Used for full-screen shares / when we can't identify the
// shared window's owning app — keeps Discord's own voice playback out of the
// outgoing stream (= viewers don't hear themselves). The PID is resolved
// here in main from process.pid; the renderer never supplies it, so it can't
// be tricked into excluding the wrong tree.
handle(IpcEvents.DM_WIN_AUDIO_START_EXCLUDE_SELF, async event => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: "no live window" };
    try {
        const format = mod.startProcessLoopback(process.pid, "exclude", NOOP_CHUNK);
        startChunkForwarding(mod, win);
        return { ok: true, format };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});


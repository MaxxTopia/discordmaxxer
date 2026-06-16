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

import { BrowserWindow, ipcMain } from "electron";

import { IpcEvents } from "../shared/IpcEvents";

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

ipcMain.handle(IpcEvents.DM_WIN_AUDIO_LIST, async () => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        return { ok: true, devices: mod.listOutputDevices().devices };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

ipcMain.handle(IpcEvents.DM_WIN_AUDIO_START, async (event, deviceId: string) => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const format = mod.startCapture(deviceId, chunk => {
            // Forward to the renderer that requested the start. If the
            // window's been destroyed mid-capture, drop silently.
            if (!win || win.isDestroyed()) return;
            win.webContents.send(IpcEvents.DM_WIN_AUDIO_CHUNK, {
                data: chunk.data,
                frameCount: chunk.frameCount,
                // BigInt → string over IPC (Electron serializer handles it but
                // some downstream code is happier with strings).
                timestamp100ns: chunk.timestamp100ns.toString(),
                silent: chunk.silent,
            });
        });
        return { ok: true, format };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

ipcMain.handle(IpcEvents.DM_WIN_AUDIO_STOP, async () => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        mod.stopCapture();
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

ipcMain.handle(IpcEvents.DM_WIN_AUDIO_SESSIONS, async () => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        return { ok: true, sessions: mod.enumerateAudioSessions().sessions };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

ipcMain.handle(
    IpcEvents.DM_WIN_AUDIO_START_PROCESS,
    async (event, targetPid: number, mode: "include" | "exclude") => {
        const mod = load();
        if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            const format = mod.startProcessLoopback(targetPid, mode, chunk => {
                if (!win || win.isDestroyed()) return;
                win.webContents.send(IpcEvents.DM_WIN_AUDIO_CHUNK, {
                    data: chunk.data,
                    frameCount: chunk.frameCount,
                    timestamp100ns: chunk.timestamp100ns.toString(),
                    silent: chunk.silent,
                });
            });
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
ipcMain.handle(IpcEvents.DM_WIN_AUDIO_START_EXCLUDE_SELF, async event => {
    const mod = load();
    if (!mod) return { ok: false, error: loadError ?? "winaudio unavailable" };
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const format = mod.startProcessLoopback(process.pid, "exclude", chunk => {
            if (!win || win.isDestroyed()) return;
            win.webContents.send(IpcEvents.DM_WIN_AUDIO_CHUNK, {
                data: chunk.data,
                frameCount: chunk.frameCount,
                timestamp100ns: chunk.timestamp100ns.toString(),
                silent: chunk.silent,
            });
        });
        return { ok: true, format };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});


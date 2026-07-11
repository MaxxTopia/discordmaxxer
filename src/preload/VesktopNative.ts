/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Node } from "@vencord/venmic";
import { ipcRenderer } from "electron/renderer";
import type { IpcMessage, IpcResponse } from "main/ipcCommands";
import type { Settings } from "shared/settings";

import { IpcEvents, UpdaterCheckResult } from "../shared/IpcEvents";
import { invoke, sendSync } from "./typedIpc";

type SpellCheckerResultCallback = (word: string, suggestions: string[]) => void;

const spellCheckCallbacks = new Set<SpellCheckerResultCallback>();

ipcRenderer.on(IpcEvents.SPELLCHECK_RESULT, (_, w: string, s: string[]) => {
    spellCheckCallbacks.forEach(cb => cb(w, s));
});

let onDevtoolsOpen = () => {};
let onDevtoolsClose = () => {};

ipcRenderer.on(IpcEvents.DEVTOOLS_OPENED, () => onDevtoolsOpen());
ipcRenderer.on(IpcEvents.DEVTOOLS_CLOSED, () => onDevtoolsClose());

// Discordmaxxer global hotkey bridge — supports multiple registrations keyed by id.
const globalHotkeyHandlers = new Map<string, () => void>();
ipcRenderer.on(IpcEvents.DM_GLOBAL_HOTKEY_FIRED, (_e, id: string) => {
    globalHotkeyHandlers.get(id)?.();
});

export const VesktopNative = {
    app: {
        relaunch: () => invoke<void>(IpcEvents.RELAUNCH),
        getVersion: () => sendSync<void>(IpcEvents.GET_VERSION),
        setBadgeCount: (count: number) => invoke<void>(IpcEvents.SET_BADGE_COUNT, count),
        supportsWindowsTransparency: () => sendSync<boolean>(IpcEvents.SUPPORTS_WINDOWS_TRANSPARENCY),
        getEnableHardwareAcceleration: () => sendSync<boolean>(IpcEvents.GET_ENABLE_HARDWARE_ACCELERATION),
        isOutdated: () => invoke<boolean>(IpcEvents.UPDATER_IS_OUTDATED),
        openUpdater: () => invoke<void>(IpcEvents.UPDATER_OPEN),
        // Fresh on-demand check that reports its outcome (incl. the error text),
        // so a failing update check is visible instead of silently doing nothing.
        checkForUpdates: () => invoke<UpdaterCheckResult>(IpcEvents.DM_UPDATER_CHECK),
        // used by vencord
        getRendererCss: () => invoke<string>(IpcEvents.GET_VESKTOP_RENDERER_CSS),
        onRendererCssUpdate: (cb: (newCss: string) => void) => {
            if (!IS_DEV) return;

            ipcRenderer.on(IpcEvents.VESKTOP_RENDERER_CSS_UPDATE, (_e, newCss: string) => cb(newCss));
        }
    },
    resilience: {
        // Renderer voice-fail detector -> main -> worker /incident (anon count).
        reportVoiceIncident: (sig: string) => invoke<void>(IpcEvents.DM_REPORT_INCIDENT, sig),
        // Same-launch state for the known-issue banner + forced-update verdict.
        getState: () =>
            invoke<{
                banner: { level: string; text: string; url: string };
                versionOutdated: boolean;
                forceUpdate: boolean;
                updateUrl: string;
            }>(IpcEvents.DM_GET_RESILIENCE_STATE)
    },
    autostart: {
        isEnabled: () => sendSync<boolean>(IpcEvents.AUTOSTART_ENABLED),
        enable: () => invoke<void>(IpcEvents.ENABLE_AUTOSTART),
        disable: () => invoke<void>(IpcEvents.DISABLE_AUTOSTART)
    },
    fileManager: {
        isUsingCustomVencordDir: () => sendSync<boolean>(IpcEvents.IS_USING_CUSTOM_VENCORD_DIR),
        showCustomVencordDir: () => invoke<void>(IpcEvents.SHOW_CUSTOM_VENCORD_DIR),
        selectVencordDir: (value?: null) => invoke<"cancelled" | "invalid" | "ok">(IpcEvents.SELECT_VENCORD_DIR, value),
        chooseUserAsset: (asset: string, value?: null) =>
            invoke<"cancelled" | "invalid" | "ok" | "failed">(IpcEvents.CHOOSE_USER_ASSET, asset, value)
    },
    settings: {
        get: () => sendSync<Settings>(IpcEvents.GET_SETTINGS),
        set: (settings: Settings, path?: string) => invoke<void>(IpcEvents.SET_SETTINGS, settings, path)
    },
    spellcheck: {
        getAvailableLanguages: () => sendSync<string[]>(IpcEvents.SPELLCHECK_GET_AVAILABLE_LANGUAGES),
        onSpellcheckResult(cb: SpellCheckerResultCallback) {
            spellCheckCallbacks.add(cb);
        },
        offSpellcheckResult(cb: SpellCheckerResultCallback) {
            spellCheckCallbacks.delete(cb);
        },
        replaceMisspelling: (word: string) => invoke<void>(IpcEvents.SPELLCHECK_REPLACE_MISSPELLING, word),
        addToDictionary: (word: string) => invoke<void>(IpcEvents.SPELLCHECK_ADD_TO_DICTIONARY, word)
    },
    win: {
        focus: () => invoke<void>(IpcEvents.FOCUS),
        close: (key?: string) => invoke<void>(IpcEvents.CLOSE, key),
        minimize: (key?: string) => invoke<void>(IpcEvents.MINIMIZE, key),
        maximize: (key?: string) => invoke<void>(IpcEvents.MAXIMIZE, key),
        flashFrame: (flag: boolean) => invoke<void>(IpcEvents.FLASH_FRAME, flag),
        setDevtoolsCallbacks: (onOpen: () => void, onClose: () => void) => {
            onDevtoolsOpen = onOpen;
            onDevtoolsClose = onClose;
        }
    },
    capturer: {
        getLargeThumbnail: (id: string) => invoke<string>(IpcEvents.CAPTURER_GET_LARGE_THUMBNAIL, id)
    },
    /** only available on Linux. */
    virtmic: {
        list: () =>
            invoke<
                { ok: false; isGlibCxxOutdated: boolean } | { ok: true; targets: Node[]; hasPipewirePulse: boolean }
            >(IpcEvents.VIRT_MIC_LIST),
        start: (include: Node[]) => invoke<void>(IpcEvents.VIRT_MIC_START, include),
        startSystem: (exclude: Node[]) => invoke<void>(IpcEvents.VIRT_MIC_START_SYSTEM, exclude),
        stop: () => invoke<void>(IpcEvents.VIRT_MIC_STOP)
    },
    clipboard: {
        copyImage: (imageBuffer: Uint8Array, imageSrc: string) =>
            invoke<void>(IpcEvents.CLIPBOARD_COPY_IMAGE, imageBuffer, imageSrc)
    },
    debug: {
        launchGpu: () => invoke<void>(IpcEvents.DEBUG_LAUNCH_GPU),
        launchWebrtcInternals: () => invoke<void>(IpcEvents.DEBUG_LAUNCH_WEBRTC_INTERNALS)
    },
    commands: {
        onCommand(cb: (message: IpcMessage) => void) {
            ipcRenderer.on(IpcEvents.IPC_COMMAND, (_, message) => cb(message));
        },
        respond: (response: IpcResponse) => ipcRenderer.send(IpcEvents.IPC_COMMAND, response)
    },
    globalHotkey: {
        register: (id: string, hotkey: string, onFire: () => void) => {
            globalHotkeyHandlers.set(id, onFire);
            return invoke<boolean>(IpcEvents.DM_REGISTER_GLOBAL_HOTKEY, id, hotkey);
        },
        unregister: (id: string) => {
            globalHotkeyHandlers.delete(id);
            return invoke<boolean>(IpcEvents.DM_UNREGISTER_GLOBAL_HOTKEY, id);
        }
    },
    performanceMode: {
        set: (on: boolean) => invoke<{ priorityChanged: boolean; frameRateLimited: boolean; arRpcDisabled: boolean }>(IpcEvents.DM_SET_PERFORMANCE_MODE, on),
        // Tell the perf bridge whether we're in a voice call so TournamentMode
        // can keep the renderer + GPU at full priority during calls/streaming
        // (Opus voice encode/decode runs in the renderer) while still throttling
        // them when solo.
        setVoiceActive: (active: boolean) => invoke<{ reapplied: boolean }>(IpcEvents.DM_SET_VOICE_ACTIVE, active)
    },
    hwid: {
        get: () => invoke<{ ok: boolean; hwid?: string; error?: string }>(IpcEvents.DM_GET_HWID)
    },
    beta: {
        getAllowPrerelease: () => invoke<boolean>(IpcEvents.DM_GET_ALLOW_PRERELEASE),
        setAllowPrerelease: (on: boolean) => invoke<void>(IpcEvents.DM_SET_ALLOW_PRERELEASE, on)
    },
    /**
     * Windows-only — per-output-device + per-process WASAPI loopback capture
     * (native packages/winaudio). Lets screenshare source audio from a chosen
     * output device or app process tree instead of whatever Windows says is
     * the default. Fixes screenshare for users with Voicemeeter / VB-Cable /
     * EqualizerAPO routing, and the process-exclude path keeps the streamer's
     * own Discord voice playback out of the outgoing stream (no echo).
     * `list()` returns `{ ok: false, error }` on other platforms.
     */
    winAudio: {
        list: () =>
            invoke<
                { ok: false; error: string }
                | { ok: true; devices: Array<{ id: string; name: string; isDefault: boolean }> }
            >(IpcEvents.DM_WIN_AUDIO_LIST),
        start: (deviceId: string) =>
            invoke<
                { ok: false; error: string }
                | { ok: true; format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean } }
            >(IpcEvents.DM_WIN_AUDIO_START, deviceId),
        stop: () => invoke<{ ok: true } | { ok: false; error: string }>(IpcEvents.DM_WIN_AUDIO_STOP),
        onChunk: (cb: (chunk: { data: Buffer; frameCount: number; timestamp100ns: string; silent: boolean }) => void) => {
            const handler = (_e: unknown, chunk: any) => cb(chunk);
            ipcRenderer.on(IpcEvents.DM_WIN_AUDIO_CHUNK, handler);
            return () => ipcRenderer.off(IpcEvents.DM_WIN_AUDIO_CHUNK, handler);
        },
        listSessions: () =>
            invoke<
                { ok: false; error: string }
                | {
                      ok: true;
                      sessions: Array<{
                          pid: number;
                          processName: string;
                          displayName: string;
                          isActive: boolean;
                      }>;
                  }
            >(IpcEvents.DM_WIN_AUDIO_SESSIONS),
        startProcess: (targetPid: number, mode: "include" | "exclude") =>
            invoke<
                { ok: false; error: string }
                | { ok: true; format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean } }
            >(IpcEvents.DM_WIN_AUDIO_START_PROCESS, targetPid, mode),
        // Capture everything except our own process tree (no PID arg — main
        // uses process.pid). Keeps Discord's voice playback out of the stream.
        startExcludeSelf: () =>
            invoke<
                { ok: false; error: string }
                | { ok: true; format: { sampleRate: number; channels: number; bitsPerSample: number; isFloat: boolean } }
            >(IpcEvents.DM_WIN_AUDIO_START_EXCLUDE_SELF)
    }
};

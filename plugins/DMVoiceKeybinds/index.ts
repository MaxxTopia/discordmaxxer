/*
 * Discordmaxxer — DMVoiceKeybinds plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The #1 competitive in-game voice control that Vesktop forks lack: a GLOBAL
 * mute / deafen hotkey that works while you're focused on a fullscreen game
 * (Discord unfocused). Discord's own keybinds settings only fire when the
 * window is focused, and DMStreamMute's Ctrl+Shift+M is a window-level handler
 * too — useless mid-match. This registers OS-level hotkeys through the existing
 * Discordmaxxer global-hotkey bridge (same path TournamentMode uses) and toggles
 * Discord's real self-mute / self-deafen.
 *
 * NOTE: true hold-to-talk (push-to-talk) is infeasible here — Electron's
 * globalShortcut only fires on key-DOWN (no key-up), so we ship reliable TOGGLE
 * mute + toggle deafen instead. Discord's built-in PTT still works window-focused.
 *
 * Falls back to a window-focused keydown listener if OS-level registration
 * fails (e.g. the chosen combo is already claimed by another app).
 */

import { definePluginSettings } from "@api/Settings";
import { findByPropsLazy } from "@webpack";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelRTCStore,
    FluxDispatcher,
    MediaEngineStore,
    RTCConnectionStore,
    SelectedChannelStore,
    Toasts as DiscordToasts
} from "@webpack/common";

import { showDiscordmaxxerStatusToast } from "../_dm-shared/statusToast";

const Toasts = { ...DiscordToasts, show: showDiscordmaxxerStatusToast };

const MUTE_ID = "discordmaxxer.VoiceKeybinds.mute";
const DEAFEN_ID = "discordmaxxer.VoiceKeybinds.deafen";
const SCREENSHARE_ID = "discordmaxxer.VoiceKeybinds.screenshare";

// Discord's voice action module — setSelfMute(bool) / setSelfDeaf(bool). Found
// at runtime so it survives Discord's minified-module churn.
const VoiceActions = findByPropsLazy("setSelfMute", "setSelfDeaf");
const StreamActions = findByPropsLazy("stopStream");
const ApplicationStreamingStore = findByPropsLazy("getCurrentUserActiveStream");

let muteGlobalRegistered = false;
let deafenGlobalRegistered = false;
let screenshareGlobalRegistered = false;
let windowHandler: ((e: KeyboardEvent) => void) | null = null;

function toast(message: string, active: boolean) {
    Toasts.show({
        message,
        type: active ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS,
        id: Toasts.genId(),
        options: { duration: 1200, position: Toasts.Position.TOP }
    });
}

function toggleMute() {
    try {
        // isSelfMute() is the CURRENT state; the new state is its negation.
        const next = !(MediaEngineStore as any).isSelfMute?.();
        VoiceActions.setSelfMute(next);
        toast(next ? "🎤 Mic muted" : "🎤 Mic unmuted", next);
    } catch (e) {
        console.warn("[DMVoiceKeybinds] toggleMute failed:", e);
    }
}

function toggleDeafen() {
    try {
        const next = !(MediaEngineStore as any).isSelfDeaf?.();
        VoiceActions.setSelfDeaf(next);
        toast(next ? "🔇 Deafened" : "🔊 Undeafened", next);
    } catch (e) {
        console.warn("[DMVoiceKeybinds] toggleDeafen failed:", e);
    }
}

function isVoiceActive(): boolean {
    try {
        if (Boolean(SelectedChannelStore?.getVoiceChannelId?.())) return true;
        if (Boolean(RTCConnectionStore?.isConnected?.() || RTCConnectionStore?.getChannelId?.())) return true;
        if (Boolean(ChannelRTCStore?.isConnected?.())) return true;
        if (Boolean((globalThis as any).__dmActiveRtcConnected)) return true;
    } catch {}
    return false;
}

function isStreamingActive(): boolean {
    try {
        const stream = ApplicationStreamingStore?.getCurrentUserActiveStream?.();
        if (stream) return true;
    } catch {}
    return false;
}

function isClickable(element: HTMLElement): boolean {
    if (element.getAttribute("aria-disabled") === "true") return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    if (!element.isConnected) return false;

    try {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
    } catch {}

    return true;
}

function simulateClick(element: HTMLElement) {
    const button = (element.closest('button, [role="button"]') || element) as HTMLElement;
    try { button.focus(); } catch {}

    const rect = button.getBoundingClientRect();
    const x = rect.left + Math.max(1, rect.width / 2);
    const y = rect.top + Math.max(1, rect.height / 2);
    const eventInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1
    };

    try { button.dispatchEvent(new PointerEvent("pointerdown", eventInit)); } catch {}
    try { button.dispatchEvent(new MouseEvent("mousedown", eventInit)); } catch {}
    try { button.dispatchEvent(new PointerEvent("pointerup", eventInit)); } catch {}
    try { button.dispatchEvent(new MouseEvent("mouseup", eventInit)); } catch {}
    try { button.dispatchEvent(new MouseEvent("click", eventInit)); } catch {}
    try { button.click(); } catch {}
}

function findVoiceControlButton(isStop: boolean): HTMLElement | null {
    // 1. Search strictly inside voice-specific control areas first (zero noise from chat/members/servers)
    const voiceContainers = Array.from(
        document.querySelectorAll<HTMLElement>(
            'section[class*="panels_"], [class*="callContainer_"], [class*="videoControls_"], [class*="bottomControls_"], [class*="wrapper_"][class*="call_"], [class*="wrapper_"][class*="video_"], div[class*="connection_"], div[class*="voice_"]'
        )
    );

    const matchRegex = isStop
        ? /stop\s*(stream|screenshare|sharing)|end\s*stream/i
        : /share\s*(your\s*)?screen|screen\s*share|go\s*live/i;

    const notMatchRegex = isStop
        ? /^$/
        : /camera|video/i;

    for (const container of voiceContainers) {
        if (!isClickable(container)) continue;
        const candidates = Array.from(
            container.querySelectorAll<HTMLElement>('button, [role="button"], [aria-label], [title], [data-tooltip-id]')
        );

        for (const el of candidates) {
            const btn = (el.closest('button, [role="button"]') || el) as HTMLElement;
            if (!isClickable(btn)) continue;

            const text = [
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.getAttribute("data-tooltip-id"),
                el.getAttribute("data-tooltip"),
                btn.getAttribute("aria-label"),
                btn.getAttribute("title"),
                (btn as HTMLButtonElement).innerText?.trim()
            ].filter(Boolean).join(" ");

            if (matchRegex.test(text) && !notMatchRegex.test(text)) {
                return btn;
            }
        }
    }

    // 2. Fallback: Global search strictly for buttons with exact voice aria-labels
    const globalCandidates = isStop
        ? Array.from(document.querySelectorAll<HTMLElement>(
            'button[aria-label*="Stop Streaming" i], button[aria-label*="Stop Screen" i], button[aria-label*="Stop Sharing" i], button[aria-label*="End Stream" i], [role="button"][aria-label*="Stop Streaming" i]'
        ))
        : Array.from(document.querySelectorAll<HTMLElement>(
            'button[aria-label*="Share Your Screen" i], button[aria-label*="Screen Share" i], button[aria-label*="Screenshare" i], button[aria-label*="Share Screen" i], button[aria-label*="Go Live" i], [role="button"][aria-label*="Share Your Screen" i]'
        ));

    for (const el of globalCandidates) {
        const btn = (el.closest('button, [role="button"]') || el) as HTMLElement;
        if (isClickable(btn)) {
            return btn;
        }
    }

    return null;
}

/**
 * Use Discord's native voice-control button to toggle screen share on or off.
 * When starting, sets __dmAutoStartScreenShare so ScreenSharePicker auto-picks
 * the primary screen/game and starts streaming without requiring manual clicks.
 * When stopping, dispatches STREAM_STOP, calls Discord's stopStream action,
 * and clicks the UI stop button.
 */
function triggerScreenshare() {
    if (!isVoiceActive()) {
        toast("🖥️ Join a voice channel first — screen share is unavailable here", false);
        return;
    }

    const streaming = isStreamingActive();
    const stopButton = findVoiceControlButton(true);

    if (streaming || stopButton) {
        try {
            const activeStream = ApplicationStreamingStore?.getCurrentUserActiveStream?.();
            if (activeStream?.streamKey) {
                StreamActions?.stopStream?.(activeStream.streamKey);
            } else if (activeStream?.guildId && activeStream?.channelId) {
                StreamActions?.stopStream?.(activeStream.guildId, activeStream.channelId);
            } else {
                StreamActions?.stopStream?.();
            }
        } catch (e) {
            console.warn("[DMVoiceKeybinds] StreamActions.stopStream failed:", e);
        }

        try {
            const activeStream = ApplicationStreamingStore?.getCurrentUserActiveStream?.();
            if (activeStream?.streamKey) {
                FluxDispatcher.dispatch({ type: "STREAM_STOP", streamKey: activeStream.streamKey });
            }
        } catch {}

        if (stopButton) {
            simulateClick(stopButton);
        }

        toast("🖥️ Live stream ended", false);
        return;
    }

    const shareButton = findVoiceControlButton(false);
    if (!shareButton) {
        toast("🖥️ Could not find voice screen share button — make sure you are in a call", false);
        return;
    }

    // Set auto-start flag so ScreenSharePicker immediately auto-picks primary screen/game
    (globalThis as any).__dmAutoStartScreenShare = true;
    setTimeout(() => {
        (globalThis as any).__dmAutoStartScreenShare = false;
    }, 10000);

    simulateClick(shareButton);
    toast("🖥️ Starting live stream to voice call…", false);

    // Watch for any subsequent "Go Live" or "Share" modal submit button that Discord might display
    const checkModalIntervals = [120, 280, 500, 850, 1300];
    checkModalIntervals.forEach(delay => {
        setTimeout(() => {
            try {
                const modalSubmit = document.querySelector<HTMLElement>(
                    '[class*="modal_"] button[type="submit"], [role="dialog"] button[type="submit"], [class*="modal_"] button[aria-label*="Go Live" i], [role="dialog"] button[aria-label*="Go Live" i]'
                );
                if (modalSubmit && isClickable(modalSubmit)) {
                    const label = [
                        modalSubmit.innerText,
                        modalSubmit.getAttribute("aria-label"),
                        modalSubmit.getAttribute("title")
                    ].filter(Boolean).join(" ").toLowerCase();
                    if (/go\s*live|share/i.test(label)) {
                        simulateClick(modalSubmit);
                    }
                }
            } catch {}
        }, delay);
    });
}

interface ParsedHotkey {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    key: string;
}

const KEY_ALIASES: Record<string, string> = {
    control: "control",
    esc: "escape",
    return: "enter",
    spacebar: " ",
    space: " ",
    left: "arrowleft",
    right: "arrowright",
    up: "arrowup",
    down: "arrowdown"
};

const NAMED_KEYS = new Set([
    "backspace",
    "delete",
    "end",
    "enter",
    "escape",
    "home",
    "insert",
    "pagedown",
    "pageup",
    "tab",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "arrowup",
    "capslock",
    "numlock",
    "scrolllock",
    "printscreen",
    " ",
    "plus"
]);

function normalizeKeyToken(key: string): string {
    const raw = key.toLowerCase();
    const normalized = raw.length === 1 ? raw : raw.trim();
    return KEY_ALIASES[normalized] ?? normalized;
}

function isValidKeyToken(key: string): boolean {
    if (NAMED_KEYS.has(key) || /^(?:f(?:[1-9]|1[0-2]))$/.test(key)) return true;
    // A single printable key, including punctuation such as ], [, /, or -.
    // Do not accept + because it is the hotkey separator, and reject whitespace.
    return Array.from(key).length === 1 && key !== "+" && !/\s/.test(key);
}

function parseHotkey(hk: string): ParsedHotkey {
    const parts = hk.toLowerCase().split("+").map(s => s.trim()).filter(Boolean);
    return {
        ctrl: parts.includes("ctrl") || parts.includes("control"),
        alt: parts.includes("alt"),
        shift: parts.includes("shift"),
        key: normalizeKeyToken(parts[parts.length - 1] ?? "")
    };
}

function validateHotkey(value: string): boolean | string {
    const parts = value.toLowerCase().split("+").map(s => s.trim()).filter(Boolean);
    const key = parts.at(-1) ?? "";
    const modifiers = parts.slice(0, -1);
    const allowed = new Set(["ctrl", "control", "alt", "shift"]);

    if (modifiers.some(m => !allowed.has(m))) {
        return "Supported modifiers are ctrl, alt, and shift.";
    }
    if (!key || allowed.has(key) || !isValidKeyToken(normalizeKeyToken(key))) {
        return "Use a single key like ] or a modifier combo like ctrl+alt+m.";
    }
    return true;
}

function safeHotkey(value: string, fallback: string): string {
    return validateHotkey(value) === true ? value : fallback;
}

function matches(e: KeyboardEvent, hk: ParsedHotkey): boolean {
    return (
        e.ctrlKey === hk.ctrl &&
        e.altKey === hk.alt &&
        e.shiftKey === hk.shift &&
        !e.metaKey &&
        normalizeKeyToken(e.key) === hk.key
    );
}

const STORAGE_KEY_MUTE = "dm_voice_mute_hotkey";
const STORAGE_KEY_DEAFEN = "dm_voice_deafen_hotkey";
const STORAGE_KEY_SCREENSHARE = "dm_voice_screenshare_hotkey";

// Re-register hotkeys after a settings edit. Without this, changing a hotkey
// or toggling OS-level mode did nothing until the plugin was toggled off/on.
function reapplyKeybinds() {
    try {
        if (settings.store.muteHotkey) (globalThis as any).localStorage?.setItem?.(STORAGE_KEY_MUTE, settings.store.muteHotkey);
        if (settings.store.deafenHotkey) (globalThis as any).localStorage?.setItem?.(STORAGE_KEY_DEAFEN, settings.store.deafenHotkey);
        if (settings.store.screenshareHotkey) (globalThis as any).localStorage?.setItem?.(STORAGE_KEY_SCREENSHARE, settings.store.screenshareHotkey);
    } catch {}
    teardownKeybinds()
        .then(setupKeybinds)
        .catch(e => console.warn("[DMVoiceKeybinds] reapply failed:", e));
}

const settings = definePluginSettings({
    muteHotkey: {
        type: OptionType.STRING,
        description: "Toggle self-mute. Use a single key like ] or a combo like ctrl+alt+m. Works in-game when OS-level hotkeys are on.",
        default: "ctrl+alt+m",
        isValid: validateHotkey,
        onChange: reapplyKeybinds
    },
    deafenHotkey: {
        type: OptionType.STRING,
        description: "Toggle self-deafen. Use a single key like ] or a combo like ctrl+alt+d. Works in-game when OS-level hotkeys are on.",
        default: "ctrl+alt+d",
        isValid: validateHotkey,
        onChange: reapplyKeybinds
    },
    screenshareHotkey: {
        type: OptionType.STRING,
        description: "Open Discord's native screen-share controls. Use a single key like ] or a combo like ctrl+alt+s.",
        default: "ctrl+alt+s",
        isValid: validateHotkey,
        onChange: reapplyKeybinds
    },
    useGlobalHotkey: {
        type: OptionType.BOOLEAN,
        description: "Use OS-level hotkeys (fire while you're in a fullscreen game with Discord unfocused). Recommended ON for competitive use.",
        default: true,
        onChange: reapplyKeybinds
    }
});

async function tryRegisterGlobal(id: string, hotkey: string, cb: () => void): Promise<boolean> {
    const native = (globalThis as any).VesktopNative;
    if (!(settings.store.useGlobalHotkey && native?.globalHotkey?.register)) return false;
    try {
        const ok = await native.globalHotkey.register(id, hotkey, cb);
        if (ok) return true;
        console.warn(`[DMVoiceKeybinds] OS-level register failed for ${hotkey} (likely a conflict) — using window-focused fallback`);
    } catch (e) {
        console.warn("[DMVoiceKeybinds] OS-level register threw, falling back:", e);
    }
    return false;
}

async function setupKeybinds() {
    let savedMute: string | null = null;
    let savedDeafen: string | null = null;
    let savedScreenshare: string | null = null;
    try {
        savedMute = (globalThis as any).localStorage?.getItem?.(STORAGE_KEY_MUTE);
        savedDeafen = (globalThis as any).localStorage?.getItem?.(STORAGE_KEY_DEAFEN);
        savedScreenshare = (globalThis as any).localStorage?.getItem?.(STORAGE_KEY_SCREENSHARE);
    } catch {}

    const muteVal = (savedMute && validateHotkey(savedMute) === true) ? savedMute : settings.store.muteHotkey;
    const deafenVal = (savedDeafen && validateHotkey(savedDeafen) === true) ? savedDeafen : settings.store.deafenHotkey;
    const screenshareVal = (savedScreenshare && validateHotkey(savedScreenshare) === true) ? savedScreenshare : settings.store.screenshareHotkey;

    const muteHotkey = safeHotkey(muteVal, "ctrl+alt+m");
    const deafenHotkey = safeHotkey(deafenVal, "ctrl+alt+d");
    const screenshareHotkey = safeHotkey(screenshareVal, "ctrl+alt+s");
    muteGlobalRegistered = await tryRegisterGlobal(MUTE_ID, muteHotkey, toggleMute);
    deafenGlobalRegistered = await tryRegisterGlobal(DEAFEN_ID, deafenHotkey, toggleDeafen);
    screenshareGlobalRegistered = await tryRegisterGlobal(SCREENSHARE_ID, screenshareHotkey, triggerScreenshare);

    // Window-focused fallback for whichever hotkey didn't register globally
    // (so the feature still works when the window is focused).
    if (!muteGlobalRegistered || !deafenGlobalRegistered || !screenshareGlobalRegistered) {
        const mute = parseHotkey(muteHotkey);
        const deafen = parseHotkey(deafenHotkey);
        const screenshare = parseHotkey(screenshareHotkey);
        windowHandler = (e: KeyboardEvent) => {
            // Discord's own keybind dispatcher gets first refusal. This is a
            // fallback only for a hotkey Electron could not register globally.
            if (e.defaultPrevented) return;
            const t = e.target as HTMLElement | null;
            const tag = t?.tagName?.toUpperCase();
            if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
            if (!muteGlobalRegistered && matches(e, mute)) {
                e.preventDefault();
                e.stopPropagation();
                toggleMute();
            } else if (!deafenGlobalRegistered && matches(e, deafen)) {
                e.preventDefault();
                e.stopPropagation();
                toggleDeafen();
            } else if (!screenshareGlobalRegistered && matches(e, screenshare)) {
                e.preventDefault();
                e.stopPropagation();
                triggerScreenshare();
            }
        };
        window.addEventListener("keydown", windowHandler);
    }

    console.log(
        `[DMVoiceKeybinds] mute=${muteHotkey} deafen=${deafenHotkey} screenshare=${screenshareHotkey} ` +
            `(global: mute=${muteGlobalRegistered} deafen=${deafenGlobalRegistered} screenshare=${screenshareGlobalRegistered})`
    );
}

async function teardownKeybinds() {
    const native = (globalThis as any).VesktopNative;
    if (muteGlobalRegistered) {
        native?.globalHotkey?.unregister?.(MUTE_ID);
        muteGlobalRegistered = false;
    }
    if (deafenGlobalRegistered) {
        native?.globalHotkey?.unregister?.(DEAFEN_ID);
        deafenGlobalRegistered = false;
    }
    if (screenshareGlobalRegistered) {
        native?.globalHotkey?.unregister?.(SCREENSHARE_ID);
        screenshareGlobalRegistered = false;
    }
    if (windowHandler) {
        window.removeEventListener("keydown", windowHandler);
        windowHandler = null;
    }
}

export default definePlugin({
    name: "DMVoiceKeybinds",
    description:
        "🎤 Global mute, deafen, and screenshare hotkeys that work while you're in a fullscreen game (Discord unfocused). Defaults: Ctrl+Alt+M mute, Ctrl+Alt+D deafen, Ctrl+Alt+S screen share. Configurable; screenshare opens Discord's native picker and falls back to window-focused if an OS combo is taken.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        return setupKeybinds();
    },

    stop() {
        return teardownKeybinds();
    }
});

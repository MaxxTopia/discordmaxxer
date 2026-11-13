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
import { MediaEngineStore, Toasts as DiscordToasts } from "@webpack/common";

import { showDiscordmaxxerStatusToast } from "../_dm-shared/statusToast";

const Toasts = { ...DiscordToasts, show: showDiscordmaxxerStatusToast };

const MUTE_ID = "discordmaxxer.VoiceKeybinds.mute";
const DEAFEN_ID = "discordmaxxer.VoiceKeybinds.deafen";
const SCREENSHARE_ID = "discordmaxxer.VoiceKeybinds.screenshare";

// Discord's voice action module — setSelfMute(bool) / setSelfDeaf(bool). Found
// at runtime so it survives Discord's minified-module churn.
const VoiceActions = findByPropsLazy("setSelfMute", "setSelfDeaf");

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

function isVisible(element: HTMLElement): boolean {
    if (element.getAttribute("aria-hidden") === "true" || element.getAttribute("aria-disabled") === "true") return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
}

/**
 * Use Discord's own voice-control button instead of reimplementing its
 * screenshare picker. That preserves Discordmaxxer's native WGC/audio path
 * and keeps this shortcut working if Discord changes its internal action
 * modules. The label is intentionally narrow so a message's ordinary Share
 * button is never selected.
 */
function triggerScreenshare() {
    // Check if user is currently streaming — stop it if active
    const stopButton = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label], [title], [data-tooltip], button, [role="button"]')
    ).find(element => {
        if (!isVisible(element)) return false;
        const text = [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-tooltip"),
            element.innerText?.trim().slice(0, 100)
        ].filter(Boolean).join(" ").toLowerCase();
        return /stop\s*(stream|screenshare|sharing)|end\s*stream/.test(text);
    });

    if (stopButton) {
        stopButton.click();
        toast("🖥️ Live stream ended", false);
        return;
    }

    const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label], [title], [data-tooltip], button, [role="button"]')
    )
        .filter(isVisible)
        .map(element => {
            const label = [
                element.getAttribute("aria-label"),
                element.getAttribute("title"),
                element.getAttribute("data-tooltip"),
                element.innerText?.trim().slice(0, 100)
            ]
                .filter(Boolean)
                .join(" ");
            const normalized = label.toLowerCase();
            let score = 0;
            if (/share\s*(your\s*)?screen|screen\s*share/.test(normalized)) score += 100;
            if (/go\s*live/.test(normalized)) score += 80;
            if (/stream/.test(normalized)) score += 50;
            if (/camera|video/.test(normalized) && !/screen/.test(normalized)) score -= 80;
            return { element, score };
        })
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score);

    const button = candidates[0]?.element;
    if (!button) {
        toast("🖥️ Join a voice channel first — screen share is unavailable here", false);
        return;
    }

    (globalThis as any).__dmAutoStartScreenShare = true;
    button.click();
    toast("🖥️ Starting live stream to voice call…", false);
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
        if (settings.store.muteHotkey) localStorage.setItem(STORAGE_KEY_MUTE, settings.store.muteHotkey);
        if (settings.store.deafenHotkey) localStorage.setItem(STORAGE_KEY_DEAFEN, settings.store.deafenHotkey);
        if (settings.store.screenshareHotkey) localStorage.setItem(STORAGE_KEY_SCREENSHARE, settings.store.screenshareHotkey);
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
        savedMute = localStorage.getItem(STORAGE_KEY_MUTE);
        savedDeafen = localStorage.getItem(STORAGE_KEY_DEAFEN);
        savedScreenshare = localStorage.getItem(STORAGE_KEY_SCREENSHARE);
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

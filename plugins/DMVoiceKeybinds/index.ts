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

    button.click();
    toast("🖥️ Screen share controls opened", false);
}

interface ParsedHotkey {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    key: string;
}

function parseHotkey(hk: string): ParsedHotkey {
    const parts = hk.toLowerCase().split("+").map(s => s.trim());
    return {
        ctrl: parts.includes("ctrl") || parts.includes("control"),
        alt: parts.includes("alt"),
        shift: parts.includes("shift"),
        key: parts[parts.length - 1] ?? ""
    };
}

function validateHotkey(value: string): boolean | string {
    const parts = value.toLowerCase().split("+").map(s => s.trim()).filter(Boolean);
    const key = parts.at(-1) ?? "";
    const modifiers = parts.slice(0, -1);
    const allowed = new Set(["ctrl", "control", "alt", "shift"]);

    if (parts.length < 2 || !modifiers.some(m => allowed.has(m))) {
        return "Use a modifier plus a key, for example ctrl+alt+m.";
    }
    if (modifiers.some(m => !allowed.has(m))) {
        return "Supported modifiers are ctrl, alt, and shift.";
    }
    if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/i.test(key)) {
        return "The final key must be A-Z, 0-9, or F1-F12.";
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
        e.key.toLowerCase() === hk.key
    );
}

// Re-register hotkeys after a settings edit. Without this, changing a hotkey
// or toggling OS-level mode did nothing until the plugin was toggled off/on.
function reapplyKeybinds() {
    teardownKeybinds()
        .then(setupKeybinds)
        .catch(e => console.warn("[DMVoiceKeybinds] reapply failed:", e));
}

const settings = definePluginSettings({
    muteHotkey: {
        type: OptionType.STRING,
        description: "Toggle self-mute. Use ctrl+alt+m format; supported modifiers are ctrl, alt, and shift. Works in-game when OS-level hotkeys are on.",
        default: "ctrl+alt+m",
        isValid: validateHotkey,
        onChange: reapplyKeybinds
    },
    deafenHotkey: {
        type: OptionType.STRING,
        description: "Toggle self-deafen. Use ctrl+alt+d format; supported modifiers are ctrl, alt, and shift. Works in-game when OS-level hotkeys are on.",
        default: "ctrl+alt+d",
        isValid: validateHotkey,
        onChange: reapplyKeybinds
    },
    screenshareHotkey: {
        type: OptionType.STRING,
        description: "Open Discord's native screen-share controls. Use ctrl+alt+s format; this works in-game when OS-level hotkeys are on.",
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
    const muteHotkey = safeHotkey(settings.store.muteHotkey, "ctrl+alt+m");
    const deafenHotkey = safeHotkey(settings.store.deafenHotkey, "ctrl+alt+d");
    const screenshareHotkey = safeHotkey(settings.store.screenshareHotkey, "ctrl+alt+s");
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

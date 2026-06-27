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
import { MediaEngineStore, Toasts } from "@webpack/common";

const MUTE_ID = "discordmaxxer.VoiceKeybinds.mute";
const DEAFEN_ID = "discordmaxxer.VoiceKeybinds.deafen";

// Discord's voice action module — setSelfMute(bool) / setSelfDeaf(bool). Found
// at runtime so it survives Discord's minified-module churn.
const VoiceActions = findByPropsLazy("setSelfMute", "setSelfDeaf");

let muteGlobalRegistered = false;
let deafenGlobalRegistered = false;
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

interface ParsedHotkey {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    key: string;
}

function parseHotkey(hk: string): ParsedHotkey {
    const parts = hk.toLowerCase().split("+").map(s => s.trim());
    return {
        ctrl: parts.includes("ctrl"),
        alt: parts.includes("alt"),
        shift: parts.includes("shift"),
        key: parts[parts.length - 1] ?? ""
    };
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

const settings = definePluginSettings({
    muteHotkey: {
        type: OptionType.STRING,
        description: "Toggle self-mute (format: ctrl+alt+m). Works in-game when 'Use OS-level hotkeys' is on.",
        default: "ctrl+alt+m"
    },
    deafenHotkey: {
        type: OptionType.STRING,
        description: "Toggle self-deafen (format: ctrl+alt+d). Works in-game when 'Use OS-level hotkeys' is on.",
        default: "ctrl+alt+d"
    },
    useGlobalHotkey: {
        type: OptionType.BOOLEAN,
        description: "Use OS-level hotkeys (fire while you're in a fullscreen game with Discord unfocused). Recommended ON for competitive use.",
        default: true
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

export default definePlugin({
    name: "DMVoiceKeybinds",
    description:
        "🎤 Global mute & deafen hotkeys that work while you're in a fullscreen game (Discord unfocused) — the in-game voice control Vesktop forks are missing. Defaults: Ctrl+Alt+M to mute, Ctrl+Alt+D to deafen. Configurable; falls back to window-focused if the OS combo is taken.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        muteGlobalRegistered = await tryRegisterGlobal(MUTE_ID, settings.store.muteHotkey, toggleMute);
        deafenGlobalRegistered = await tryRegisterGlobal(DEAFEN_ID, settings.store.deafenHotkey, toggleDeafen);

        // Window-focused fallback for whichever hotkey didn't register globally
        // (so the feature still works when the window is focused).
        if (!muteGlobalRegistered || !deafenGlobalRegistered) {
            const mute = parseHotkey(settings.store.muteHotkey);
            const deafen = parseHotkey(settings.store.deafenHotkey);
            windowHandler = (e: KeyboardEvent) => {
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
                }
            };
            window.addEventListener("keydown", windowHandler, true);
        }

        console.log(
            `[DMVoiceKeybinds] mute=${settings.store.muteHotkey} deafen=${settings.store.deafenHotkey} ` +
                `(global: mute=${muteGlobalRegistered} deafen=${deafenGlobalRegistered})`
        );
    },

    stop() {
        const native = (globalThis as any).VesktopNative;
        if (muteGlobalRegistered) {
            native?.globalHotkey?.unregister?.(MUTE_ID);
            muteGlobalRegistered = false;
        }
        if (deafenGlobalRegistered) {
            native?.globalHotkey?.unregister?.(DEAFEN_ID);
            deafenGlobalRegistered = false;
        }
        if (windowHandler) {
            window.removeEventListener("keydown", windowHandler, true);
            windowHandler = null;
        }
    }
});

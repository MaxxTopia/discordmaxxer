/*
 * Discordmaxxer — TournamentMode plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Performance mode for competitive gaming. ONLY strips things that cost CPU,
 * GPU, or RAM — not cosmetic stuff. Designed to be safe to leave on
 * permanently: you keep your fancy plugins, you just stop wasting cycles
 * Discord doesn't need while a game is running.
 *
 * What it does:
 *   System (via VesktopNative.performanceMode bridge):
 *     1. Lower process priority to BELOW_NORMAL — game gets scheduling
 *        priority over Discord
 *     2. Cap renderer frame rate at 30 fps (down from 60) — half the
 *        compositor work, GPU freed for the game
 *     3. Terminate the arRPC Rich Presence worker — saves a worker thread
 *        + IPC pipe + game-process polling
 *
 *   Renderer CSS — pause animations that decode every frame:
 *     4. Animated emoji (.gif/.apng decoding loop)
 *     5. Animated avatars (Nitro)
 *     6. Typing-dots (.... animation, runs constantly while anyone types)
 *     7. Voice-activity speaking ring (pulses while anyone is talking)
 *
 * What it does NOT do (intentionally):
 *   - Strip CSS transitions / hover effects (GPU compositor handles them
 *     basically for free)
 *   - Hide unread badges / mention counts (cosmetic, no perf cost)
 *   - Pause non-critical Vencord plugins (most are event-driven, near-zero
 *     idle cost)
 *   - Disable hardware acceleration (would shift load from GPU to CPU,
 *     usually a net loss)
 *
 * v3 — 2026-05-06: Refactored from "kill all animations + hide badges"
 * (cosmetic visual-distraction-killer) to system-level perf mode. Aligns
 * with the "always-on-friendly" principle.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, SelectedChannelStore, Toasts } from "@webpack/common";

const HOTKEY_ID = "discordmaxxer.TournamentMode";

let style: HTMLStyleElement;
let active = false;
let hotkeyHandler: ((e: KeyboardEvent) => void) | null = null;
let globalRegistered = false;
let voiceSub: ((e: any) => void) | null = null;

// Report voice-channel join/leave to the perf bridge. While Tournament Mode is
// on, this keeps the renderer + GPU at full priority during a call/stream (the
// WebRTC Opus encode/decode runs in the renderer) instead of starving voice.
function reportVoiceActive(inVoice: boolean) {
    const native = (globalThis as any).VesktopNative;
    try {
        native?.performanceMode?.setVoiceActive?.(inVoice);
    } catch (e) {
        console.warn("[TournamentMode] setVoiceActive failed:", e);
    }
}

// CPU-saving CSS only. Pauses (not hides) animations that decode/run every
// frame. Cosmetic elements stay fully visible.
const PERF_CSS = `
    /* Animated emoji — gif/apng decoding loop is a real CPU cost */
    [class*="emoji"] img,
    [class*="emoji"] video,
    img[src*=".gif"],
    img[src*="format=gif"] {
        animation-play-state: paused !important;
    }
    /* Animated avatars (Nitro) — same loop */
    [class*="avatar"] img[src*=".gif"],
    [class*="avatar"] video {
        animation-play-state: paused !important;
    }
    /* "is typing" 3-dot animation — runs constantly when anyone is typing */
    [class*="typing-"] [class*="dots-"],
    [class*="typing-"] svg {
        animation: none !important;
    }
    /* Voice-activity speaking ring — pulses while anyone is talking in voice */
    [class*="speakingIndicator"],
    [class*="speaking-"] {
        animation: none !important;
    }
`;

const settings = definePluginSettings({
    hotkey: {
        type: OptionType.STRING,
        description: "Hotkey to toggle (format: ctrl+alt+t). Works system-wide when 'Use OS-level hotkey' is on.",
        default: "ctrl+alt+t"
    },
    useGlobalHotkey: {
        type: OptionType.BOOLEAN,
        description: "Use OS-level hotkey (fires while you're in a game with Discord unfocused). Recommended ON for competitive use.",
        default: true
    },
    enabledOnStart: {
        type: OptionType.BOOLEAN,
        description: "Enable Tournament Mode automatically on Discord launch. Safe to leave on — TM only strips real-cost stuff (CPU/GPU/RAM), not cosmetic plugins.",
        default: false
    },
    lowerProcessPriority: {
        type: OptionType.BOOLEAN,
        description: "Lower Discord's process priority to BELOW_NORMAL while TM is on. Frees CPU scheduling slots for your game. Recommended ON.",
        default: true
    },
    capFrameRate: {
        type: OptionType.BOOLEAN,
        description: "Cap renderer frame rate at 30 fps while TM is on (default 60). Halves compositor GPU load. Recommended ON.",
        default: true
    },
    disableArRpc: {
        type: OptionType.BOOLEAN,
        description: "Terminate Rich Presence worker (arRPC) while TM is on. Disables 'Now Playing' detection. Set OFF if you want streamers/friends to see your game.",
        default: true
    },
    // Runtime mirror of the `active` module-level flag. Hidden from the
    // settings UI (DiscordmaxxerHub uses it to render a real toggle button
    // alongside the hotkey). Keep in sync with setActive() on every flip.
    manuallyActive: {
        type: OptionType.BOOLEAN,
        description: "Live runtime toggle (mirrored to module state). Toggle from the Discordmaxxer Hub.",
        default: false,
        hidden: true,
        onChange: (val: boolean) => {
            // Guard against the recursion: setActive() writes this setting
            // after flipping, which re-fires onChange.  Compare current state.
            if (val !== active) setActive(val).catch(() => {});
        }
    }
});

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

async function setActive(next: boolean) {
    active = next;
    if (style) style.textContent = active ? PERF_CSS : "";
    // Mirror to settings so the Hub's toggle button reflects current state
    // even when the user flipped via hotkey (not via the toggle).
    try { settings.store.manuallyActive = next; } catch { /* settings not init yet */ }

    // System-level perf mode bridge
    const native = (globalThis as any).VesktopNative;
    let result: any = null;
    if (native?.performanceMode?.set) {
        try {
            result = await native.performanceMode.set(active);
        } catch (e) {
            console.warn("[TournamentMode] performanceMode bridge failed:", e);
        }
    }

    console.log(`[TournamentMode] ${active ? "ACTIVE" : "off"}`, result);

    Toasts.show({
        message: active
            ? `🎮 Tournament Mode: ON — priority↓ ${result?.arRpcDisabled ? "rpc✕" : ""}`
            : "Tournament Mode: OFF — restored",
        type: active ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: { duration: 1800, position: Toasts.Position.TOP }
    });
}

export default definePlugin({
    name: "TournamentMode",
    description: "Press Ctrl+Alt+T (configurable) to toggle a real performance mode for gaming: drops Discord's process priority, caps the renderer at 30 fps, kills Rich Presence, and pauses animated emoji/avatars/typing-dots. Safe to leave on permanently — only strips things with measurable CPU/GPU cost; cosmetic plugins stay fully active.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        style = createAndAppendStyle("dm-tournament-mode", managedStyleRootNode);

        // Track voice-channel state so the perf bridge can protect renderer+GPU
        // priority during calls/streaming. Report the current state once (in case
        // we launched already in a call), then on every join/leave.
        try {
            reportVoiceActive(!!SelectedChannelStore.getVoiceChannelId());
        } catch {
            // store may not be ready at startup — the subscription will catch up
        }
        voiceSub = (e: any) => reportVoiceActive(!!e?.channelId);
        FluxDispatcher.subscribe("VOICE_CHANNEL_SELECT", voiceSub);

        if (settings.store.enabledOnStart) {
            await setActive(true);
        } else {
            // The main process persists perf state (process priority, killed
            // arRPC) ACROSS renderer reloads. If a prior session left TM active
            // and the renderer reloaded — Ctrl+R, a crash, or CrashHandler
            // recovery — `active` resets to false here but Discord is still
            // pinned at BELOW_NORMAL with Rich Presence dead, and nothing would
            // ever restore it. Proactively clear stale perf state to default on
            // any non-activating start. Idempotent + silent (no toast).
            const native = (globalThis as any).VesktopNative;
            if (native?.performanceMode?.set) {
                try {
                    await native.performanceMode.set(false);
                } catch (e) {
                    console.warn("[TournamentMode] startup perf-state reset failed:", e);
                }
            }
        }

        const native = (globalThis as any).VesktopNative;
        const wantGlobal = settings.store.useGlobalHotkey && native?.globalHotkey?.register;

        if (wantGlobal) {
            try {
                const ok = await native.globalHotkey.register(HOTKEY_ID, settings.store.hotkey, () => {
                    setActive(!active);
                });
                if (ok) {
                    globalRegistered = true;
                    console.log("[TournamentMode] OS-level hotkey registered");
                    return;
                }
                console.warn("[TournamentMode] OS-level register failed (likely conflict) — falling back to window-focused");
            } catch (e) {
                console.warn("[TournamentMode] OS-level register threw, falling back:", e);
            }
        }

        const hk = parseHotkey(settings.store.hotkey);
        hotkeyHandler = (e: KeyboardEvent) => {
            // Let Discord's own keybinds win when the OS-level registration
            // was unavailable and this renderer fallback is active.
            if (e.defaultPrevented) return;
            if (
                e.ctrlKey === hk.ctrl &&
                e.altKey === hk.alt &&
                e.shiftKey === hk.shift &&
                e.key.toLowerCase() === hk.key
            ) {
                e.preventDefault();
                e.stopPropagation();
                setActive(!active);
            }
        };
        window.addEventListener("keydown", hotkeyHandler);
    },

    async stop() {
        if (active) {
            // Restore system state before unloading
            await setActive(false);
        }
        if (voiceSub) {
            try {
                FluxDispatcher.unsubscribe("VOICE_CHANNEL_SELECT", voiceSub);
            } catch {
                // ignore
            }
            voiceSub = null;
        }
        if (globalRegistered) {
            (globalThis as any).VesktopNative?.globalHotkey?.unregister?.(HOTKEY_ID);
            globalRegistered = false;
        }
        if (hotkeyHandler) {
            window.removeEventListener("keydown", hotkeyHandler);
            hotkeyHandler = null;
        }
        style?.remove();
        active = false;
        // Ensure the persisted "on" mirror is cleared even if we started this
        // session inactive (enabledOnStart=false) with a stale saved value —
        // otherwise the Hub toggle shows ON while the feature is OFF.
        try { settings.store.manuallyActive = false; } catch { /* settings not init */ }
    }
});

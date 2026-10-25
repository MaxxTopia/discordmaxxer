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
import { ChannelRTCStore, FluxDispatcher, RTCConnectionStore, SelectedChannelStore, Toasts } from "@webpack/common";

const HOTKEY_ID = "discordmaxxer.TournamentMode";

let style: HTMLStyleElement;
let active = false;
let hotkeyHandler: ((e: KeyboardEvent) => void) | null = null;
let globalRegistered = false;
let voiceSub: ((e: any) => void) | null = null;
let voicePollTimer: ReturnType<typeof setInterval> | null = null;
let statusToast: HTMLDivElement | null = null;
let statusToastTimer: number | null = null;

const VOICE_FLUX_EVENTS = [
    "VOICE_CHANNEL_SELECT",
    "RTC_CONNECTION_STATE",
    "CALL_CREATE",
    "CALL_UPDATE",
    "VOICE_STATE_UPDATES"
];

function isVoiceOrCallActive(): boolean {
    try {
        if (Boolean(SelectedChannelStore?.getVoiceChannelId?.())) return true;
        if (Boolean(RTCConnectionStore?.isConnected?.() || RTCConnectionStore?.getChannelId?.())) return true;
        if (Boolean(ChannelRTCStore?.isConnected?.())) return true;
        if (Boolean((globalThis as any).__dmActiveRtcConnected)) return true;
    } catch {
        // fail-safe
    }
    return false;
}

// Report voice-channel or call join/leave to the perf bridge. Protects
// renderer + GPU priority and WebRTC Opus encoding/decoding during calls/streaming.
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
    /* Custom anime cursor animations + smoke in Tournament Mode */
    .anime-cursor *,
    .anime-cursor svg * {
        animation-play-state: paused !important;
    }
    .dm-cursor-smoke-container {
        display: none !important;
    }
    /* DMWidget skins and surfaces in Tournament Mode — freeze animation loops to 0% CPU */
    [data-dm-widget-skin]::before,
    [data-dm-widget-skin]::after,
    [data-dm-widget-surface-root="true"]::after {
        animation-play-state: paused !important;
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

function hideTournamentStatusOverlay(): void {
    if (statusToastTimer !== null) {
        window.clearTimeout(statusToastTimer);
        statusToastTimer = null;
    }
    statusToast?.remove();
    statusToast = null;
}

function showTournamentToast(message: string, type: any, duration = 3200): void {
    // Discord's native toast API is valid, but in this client/theme combination
    // it can collapse into an empty grey marker. Keep the status readable by
    // rendering a small plugin-owned status surface instead of depending on
    // Discord's internal toast CSS/layout.
    if (typeof document === "undefined") return;
    const mount = document.body ?? document.documentElement;
    if (!mount) return;

    if (statusToastTimer !== null) {
        window.clearTimeout(statusToastTimer);
        statusToastTimer = null;
    }

    if (!statusToast || !statusToast.isConnected) {
        statusToast = document.createElement("div");
        statusToast.setAttribute("role", "status");
        statusToast.setAttribute("aria-live", "polite");
        statusToast.style.position = "fixed";
        statusToast.style.top = "24px";
        statusToast.style.right = "24px";
        statusToast.style.zIndex = "100000";
        statusToast.style.maxWidth = "min(440px, calc(100vw - 48px))";
        statusToast.style.padding = "12px 16px";
        statusToast.style.border = "1px solid rgba(255, 255, 255, 0.16)";
        statusToast.style.borderRadius = "10px";
        statusToast.style.boxSizing = "border-box";
        statusToast.style.color = "#fff";
        statusToast.style.fontFamily = "var(--font-primary, sans-serif)";
        statusToast.style.fontSize = "14px";
        statusToast.style.fontWeight = "600";
        statusToast.style.lineHeight = "1.35";
        statusToast.style.letterSpacing = "0.01em";
        statusToast.style.boxShadow = "0 10px 28px rgba(0, 0, 0, 0.38)";
        statusToast.style.pointerEvents = "none";
        statusToast.style.opacity = "0";
        statusToast.style.transform = "translateY(-8px)";
        statusToast.style.transition = "opacity 160ms ease, transform 160ms ease";
        mount.appendChild(statusToast);
    }

    const failure = type === Toasts.Type.FAILURE;
    const success = type === Toasts.Type.SUCCESS;
    statusToast.textContent = message;
    statusToast.style.background = failure
        ? "linear-gradient(135deg, #8e2632, #5b1824)"
        : success
            ? "linear-gradient(135deg, #237a58, #14513d)"
            : "linear-gradient(135deg, #4b3c8f, #29234f)";
    statusToast.style.borderColor = failure
        ? "rgba(255, 130, 143, 0.7)"
        : success
            ? "rgba(111, 255, 194, 0.55)"
            : "rgba(190, 176, 255, 0.55)";
    statusToast.style.opacity = "1";
    statusToast.style.transform = "translateY(0)";

    statusToastTimer = window.setTimeout(() => {
        if (!statusToast) return;
        statusToast.style.opacity = "0";
        statusToast.style.transform = "translateY(-8px)";
        statusToastTimer = window.setTimeout(hideTournamentStatusOverlay, 180);
    }, duration);
}

function publishTournamentModeState(): void {
    // DMWidget needs the live renderer state, not the persisted hidden setting.
    // The setting can survive a reload while the module-level performance mode
    // has already been reset to OFF.
    (globalThis as any).__dmTournamentModeActive = active;
    try {
        window.dispatchEvent(new CustomEvent("discordmaxxer:tournament-mode-changed", {
            detail: { active }
        }));
    } catch {
        // The plugin can be stopped during renderer teardown.
    }
}

async function setActive(next: boolean) {
    active = next;
    if (style) style.textContent = active ? PERF_CSS : "";
    publishTournamentModeState();
    // Mirror to settings so the Hub's toggle button reflects current state
    // even when the user flipped via hotkey (not via the toggle).
    try { settings.store.manuallyActive = next; } catch { /* settings not init yet */ }

    // Acknowledge the user's click immediately. Waiting for the native bridge
    // made the old toast race Discord's renderer and sometimes left only the
    // small grey toast marker visible.
    showTournamentToast(
        active ? "🎮 Tournament Mode: ON — applying performance settings…" : "Tournament Mode: OFF — restoring…",
        active ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
    );

    // System-level perf mode bridge
    const native = (globalThis as any).VesktopNative;
    let result: any = null;
    let nativeFailed = false;
    if (native?.performanceMode?.set) {
        try {
            result = await native.performanceMode.set(active);
        } catch (e) {
            nativeFailed = true;
            console.warn("[TournamentMode] performanceMode bridge failed:", e);
        }
    }

    console.log(`[TournamentMode] ${active ? "ACTIVE" : "off"}`, result);
    if (nativeFailed) {
        showTournamentToast(
            "Tournament Mode changed locally, but the system performance bridge did not respond.",
            Toasts.Type.FAILURE,
            4500
        );
    }
}

export default definePlugin({
    name: "TournamentMode",
    description: "Press Ctrl+Alt+T (configurable) to toggle a real performance mode for gaming: drops Discord's process priority, caps the renderer at 30 fps, kills Rich Presence, and pauses animated emoji/avatars/typing-dots. Safe to leave on permanently — only strips things with measurable CPU/GPU cost; cosmetic plugins stay fully active.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        // `manuallyActive` is a runtime mirror, not a startup preference. Do
        // not let a value persisted by an earlier renderer session freeze
        // cosmetic motion after a normal reload.
        active = false;
        try { settings.store.manuallyActive = false; } catch { /* settings not init */ }
        publishTournamentModeState();
        style = createAndAppendStyle("dm-tournament-mode", managedStyleRootNode);

        // Track voice/call state so the perf bridge protects renderer WebRTC
        // threads during calls/streaming across server voice, DMs, and Group DMs.
        const checkVoice = () => {
            reportVoiceActive(isVoiceOrCallActive());
        };

        checkVoice();
        voiceSub = () => checkVoice();
        for (const ev of VOICE_FLUX_EVENTS) {
            try { FluxDispatcher.subscribe(ev, voiceSub); } catch {}
        }
        voicePollTimer = setInterval(checkVoice, 2000);

        try {
            if (typeof window !== "undefined" && window.RTCPeerConnection && !(window as any).__dmRtcPatched) {
                (window as any).__dmRtcPatched = true;
                const origPC = window.RTCPeerConnection;
                window.RTCPeerConnection = class extends origPC {
                    constructor(config?: RTCConfiguration) {
                        super(config);
                        this.addEventListener("connectionstatechange", () => {
                            if (this.connectionState === "connected") {
                                (globalThis as any).__dmActiveRtcConnected = true;
                                reportVoiceActive(true);
                            } else if (this.connectionState === "disconnected" || this.connectionState === "closed" || this.connectionState === "failed") {
                                (globalThis as any).__dmActiveRtcConnected = false;
                                setTimeout(checkVoice, 500);
                            }
                        });
                    }
                };
            }
        } catch {
            // best effort
        }

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
            for (const ev of VOICE_FLUX_EVENTS) {
                try { FluxDispatcher.unsubscribe(ev, voiceSub); } catch {}
            }
            voiceSub = null;
        }
        if (voicePollTimer) {
            clearInterval(voicePollTimer);
            voicePollTimer = null;
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
        hideTournamentStatusOverlay();
        active = false;
        // Ensure the persisted "on" mirror is cleared even if we started this
        // session inactive (enabledOnStart=false) with a stale saved value —
        // otherwise the Hub toggle shows ON while the feature is OFF.
        try { settings.store.manuallyActive = false; } catch { /* settings not init */ }
    }
});

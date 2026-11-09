/*
 * Discordmaxxer — TournamentMode plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Performance mode for competitive gaming. The base mode pauses high-frequency
 * decoration while preserving Discord's layout and voice path. Its default
 * profile also releases optional paint-heavy flair/media layers; users who
 * prefer every visual detail can keep that polish with the advanced override.
 * Designed to be safe to leave on permanently without disabling core Discord.
 *
 * What it does:
 *   System (via VesktopNative.performanceMode bridge):
 *     1. Lower process priority to BELOW_NORMAL — game gets scheduling
 *        priority over Discord
 *     2. Request a 30 fps renderer cap where the platform supports it. The
 *        normal windowed Electron build currently reports this as unsupported
 *        (setFrameRate is an offscreen-rendering API), so this is not counted
 *        as a measured saving.
 *     3. Terminate the arRPC Rich Presence worker — saves a worker thread
 *        + IPC pipe + game-process polling
 *
 *   Renderer CSS — pause animations that decode every frame:
 *     4. Animated emoji (.gif/.apng decoding loop)
 *     5. Animated avatars (Nitro)
 *     6. Typing-dots (.... animation, runs constantly while anyone types)
 *     7. Voice-activity speaking ring (pulses while anyone is talking)
 *
 * What the base mode does NOT do (intentionally):
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

import { hideDiscordmaxxerStatusToast, showDiscordmaxxerStatusToast } from "../_dm-shared/statusToast";

const HOTKEY_ID = "discordmaxxer.TournamentMode";

let style: HTMLStyleElement;
let active = false;
let hotkeyHandler: ((e: KeyboardEvent) => void) | null = null;
let globalRegistered = false;
let voiceSub: ((e: any) => void) | null = null;
let voicePollTimer: ReturnType<typeof setInterval> | null = null;

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
    /* DMProfileCosmetics effects in Tournament Mode — pause the owned effect
     * layer as well as its pseudo-elements. The preview stays visible; only
     * the animation clock is stopped. */
    [data-dm-profile-effect-layer="true"],
    [data-dm-profile-effect-layer="true"]::before,
    [data-dm-profile-effect-layer="true"]::after,
    .dm-profile-preview-effect,
    .dm-profile-preview-effect::before,
    .dm-profile-preview-effect::after {
        animation-play-state: paused !important;
    }
    /* DMWidget skins and surfaces in Tournament Mode — freeze animation loops to 0% CPU */
    [data-dm-widget-skin],
    [data-dm-widget-skin]::before,
    [data-dm-widget-skin]::after,
    [data-dm-widget-surface-root="true"],
    [data-dm-widget-surface-root="true"]::before,
    [data-dm-widget-surface-root="true"]::after {
        animation-play-state: paused !important;
    }
    /* DMTheme flair in Tournament Mode — pause only the theme's named live
     * effects. The palette, badges, mention styling, and layout remain. */
    body[class*="dm-theme-"] [class*="mentionsBadge_"],
    body[class*="dm-theme-"] [class*="numberBadge_"],
    body[class*="dm-theme-"] [class*="typing_"] [class*="dot_"],
    body[class*="dm-theme-"] [class*="mentioned_"] [class*="content_"],
    body[class*="dm-theme-"] [class*="mentioned_"] [class*="content_"]::before,
    body[class*="dm-theme-"] [class*="mentioned_"] [class*="content_"]::after {
        animation-play-state: paused !important;
    }
    /* External BetterDiscord themes do not use DMTheme's marker classes.
     * Bound their CSS animation clocks while Tournament Mode is active so a
     * third-party theme cannot keep a full-screen gradient, glow, particle,
     * or background animation on the GPU. This is intentionally limited to
     * animation-play-state: colors, layout, interaction, and voice UI remain
     * intact, and normal mode keeps the theme exactly as selected. */
    html[data-dm-tournament-mode] *,
    html[data-dm-tournament-mode] *::before,
    html[data-dm-tournament-mode] *::after {
        animation-play-state: paused !important;
    }
`;

// Tournament's reduced-cost presentation profile. This deliberately targets
// optional presentation layers only: Discord's content, layout, controls,
// widget cards, profile identity, and voice UI stay mounted and usable.
// DMTheme listens to the same marker and removes its optional flair stylesheet
// while retaining the selected palette.
const MINIMAL_VISUALS_CSS = `
    /* Optional DMProfileCosmetics finish is presentation-only. Keep the
       profile/avatar/banner content, but remove the extra effect layer. */
    [data-dm-profile-effect-layer="true"],
    .dm-profile-preview-effect {
        display: none !important;
    }
    [data-dm-profile-effect-layer="true"]::before,
    [data-dm-profile-effect-layer="true"]::after,
    .dm-profile-preview-effect::before,
    .dm-profile-preview-effect::after {
        display: none !important;
    }
    /* Keep the user's widget skin and its structure, but remove optional
       paint-heavy filters and shadows from the skin's decoration layer. */
    [data-dm-widget-skin]::before,
    [data-dm-widget-skin]::after,
    [data-dm-widget-surface-root="true"]::before,
    [data-dm-widget-surface-root="true"]::after {
        filter: none !important;
        box-shadow: none !important;
    }
    /* The video plugin removes its decoder and its transparency stylesheet in
       this profile. This selector is a defensive visual fallback for the
       short interval between the mode event and the plugin reconciliation. */
    #dm-video-bg {
        display: none !important;
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
        description: "Enable Tournament Mode automatically on Discord launch. The default profile keeps Discord usable while pausing optional visual work; voice and core controls stay available.",
        default: false
    },
    lowerProcessPriority: {
        type: OptionType.BOOLEAN,
        description: "Lower Discord's process priority to BELOW_NORMAL while TM is on. Frees CPU scheduling slots for your game. Recommended ON.",
        default: true,
        onChange: () => { if (active) void syncNativePerformanceMode(); }
    },
    capFrameRate: {
        type: OptionType.BOOLEAN,
        description: "Request a 30 FPS cap where supported. Windowed Discordmaxxer currently cannot enforce it, so this remains a future/offscreen compatibility option and is not counted as a saving.",
        default: true,
        onChange: () => { if (active) void syncNativePerformanceMode(); }
    },
    disableArRpc: {
        type: OptionType.BOOLEAN,
        description: "Terminate Rich Presence worker (arRPC) while TM is on. Disables 'Now Playing' detection. Set OFF if you want streamers/friends to see your game.",
        default: true,
        onChange: () => { if (active) void syncNativePerformanceMode(); }
    },
    minimalVisuals: {
        type: OptionType.BOOLEAN,
        description: "Internal compatibility setting. Tournament always removes optional theme flair, profile finish effects, widget paint-heavy decoration, and the video decoder while preserving palette, layout, content, widgets, and voice UI.",
        default: true,
        hidden: true,
        onChange: () => {
            // Older builds exposed this as an opt-out. Tournament now owns
            // the reduced-cost profile, so a stale false value can never
            // weaken the mode.
            if (settings.store.minimalVisuals !== true) settings.store.minimalVisuals = true;
            if (active) publishTournamentModeState();
        }
    },
    // Retained so older settings files migrate without leaving an exposed
    // prototype control behind.
    minimalVisualsMigrated: {
        type: OptionType.BOOLEAN,
        description: "Internal Tournament Mode migration marker.",
        default: false,
        hidden: true
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

function showTournamentToast(message: string, type: any, duration = 3200): void {
    showDiscordmaxxerStatusToast(message, type, duration);
}

function publishTournamentModeState(): void {
    // DMWidget needs the live renderer state, not the persisted hidden setting.
    // The setting can survive a reload while the module-level performance mode
    // has already been reset to OFF.
    (globalThis as any).__dmTournamentModeActive = active;
    // There is intentionally no Tournament visual opt-out anymore. The
    // regular mode is the place for full theme/effect/video presentation.
    const minimalVisuals = active;
    // The root marker lets Tournament Mode bound animation clocks from
    // external BetterDiscord themes, whose class names are not ours to know.
    // Removing the attribute on OFF keeps normal mode fully reversible.
    document.documentElement?.toggleAttribute("data-dm-tournament-mode", active);
    document.documentElement?.toggleAttribute("data-dm-tournament-minimal", minimalVisuals);
    if (style) style.textContent = active
        ? `${PERF_CSS}${minimalVisuals ? MINIMAL_VISUALS_CSS : ""}`
        : "";
    try {
        window.dispatchEvent(new CustomEvent("discordmaxxer:tournament-mode-changed", {
            detail: { active, minimalVisuals }
        }));
    } catch {
        // The plugin can be stopped during renderer teardown.
    }
}

function currentPerformanceOptions() {
    return {
        lowerProcessPriority: settings.store.lowerProcessPriority !== false,
        capFrameRate: settings.store.capFrameRate !== false,
        disableArRpc: settings.store.disableArRpc !== false
    };
}

async function syncNativePerformanceMode() {
    const native = (globalThis as any).VesktopNative;
    if (!native?.performanceMode?.set) return null;
    try {
        return await native.performanceMode.set(active, currentPerformanceOptions());
    } catch (e) {
        console.warn("[TournamentMode] performanceMode bridge failed:", e);
        return null;
    }
}

async function setActive(next: boolean) {
    active = next;
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
    let result: any = null;
    let nativeFailed = false;
    if ((globalThis as any).VesktopNative?.performanceMode?.set) {
        result = await syncNativePerformanceMode();
        nativeFailed = result === null;
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
    description: "Press Ctrl+Alt+T (configurable) to toggle a voice-safe gaming mode: lowers Discord scheduling priority when enabled, disables Rich Presence polling when selected, pauses animated decoration, removes optional theme/profile effects, and releases the video decoder while preserving core content, widgets, layout, and voice UI. The windowed build does not claim an FPS cap; full visuals remain available when Tournament Mode is off.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        // `manuallyActive` is a runtime mirror, not a startup preference. Do
        // not let a value persisted by an earlier renderer session freeze
        // cosmetic motion after a normal reload.
        active = false;
        try {
            // Tournament owns the reduced-cost profile now. Force the value
            // true so an old opt-out saved by a previous build cannot survive.
            settings.store.minimalVisuals = true;
            settings.store.minimalVisualsMigrated = true;
        } catch {
            // Settings can be unavailable during an early plugin bootstrap.
        }
        try { settings.store.manuallyActive = false; } catch { /* settings not init */ }
        style = createAndAppendStyle("dm-tournament-mode", managedStyleRootNode);
        // Create the stylesheet before startup activation publishes state. If
        // enabledOnStart is true, setActive(true) publishes immediately; the
        // old order created an empty style element after that publish, leaving
        // Tournament Mode marked active but without its reduced-cost rules
        // until the next manual toggle.
        publishTournamentModeState();

        // Track voice/call state so the perf bridge protects renderer WebRTC
        // threads during calls/streaming across server voice, DMs, and Group DMs.
        const checkVoice = () => {
            try {
                reportVoiceActive(isVoiceOrCallActive());
            } catch (error) {
                console.warn("[TournamentMode] voice-state refresh ignored during navigation:", error);
            }
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
                                setTimeout(() => {
                                    try {
                                        checkVoice();
                                    } catch (error) {
                                        console.warn("[TournamentMode] delayed voice refresh ignored during navigation:", error);
                                    }
                                }, 500);
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
        hideDiscordmaxxerStatusToast();
        active = false;
        // Ensure the persisted "on" mirror is cleared even if we started this
        // session inactive (enabledOnStart=false) with a stale saved value —
        // otherwise the Hub toggle shows ON while the feature is OFF.
        try { settings.store.manuallyActive = false; } catch { /* settings not init */ }
    }
});

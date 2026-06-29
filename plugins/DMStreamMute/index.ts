/*
 * Discordmaxxer — DiscordmaxxerStreamMute plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One-sided escape hatch for the "I hear myself in my friend's screenshare"
 * bug. The friend's WASAPI loopback might be capturing Discord's own
 * playback (= your incoming voice) and re-broadcasting it through their
 * screenshare audio track. v0.7.5's process-exclude default fixes the bug
 * on THEIR side once they update — but if they haven't, this plugin lets
 * YOU mute incoming screenshare audio without asking them to fix anything.
 *
 * Voice chat audio is on a DIFFERENT RTCPeerConnection (no `streamUserId`
 * field on the connection object), so muting screenshare audio leaves your
 * friend's voice fully audible. You only lose the streamer's game/system
 * audio while muted — which is what you wanted anyway when it was echoing
 * your own voice back at you.
 *
 * Implementation:
 *   1. Walk MediaEngineStore.getMediaEngine().connections
 *   2. Filter to those with a streamUserId (= screenshare connections)
 *   3. For each, find the RTCPeerConnection and iterate getReceivers()
 *   4. Set every audio receiver's track.enabled = !muted
 *   5. Subscribe to STREAM_CREATE so newly-joined screenshares inherit the
 *      current mute state
 *
 * Toggle paths:
 *   - Hub panel quick-toggle row (auto-wired via QUICK_TOGGLES)
 *   - Ctrl+Shift+M renderer hotkey (skips input fields)
 *   - Plugin settings panel in Discord settings → Discordmaxxer
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, Toasts } from "@webpack/common";

// Track which receiver tracks we've touched so we can cleanly restore them
// on plugin stop / unmute, without un-muting tracks the user muted via some
// other path (Discord's per-stream volume slider, system audio mixer, etc.).
const touchedTracks = new WeakSet<MediaStreamTrack>();
let appliedMuted = false;
// True between start() and stop(). Deferred timeouts check this so a timer that
// fires after the plugin is disabled can't re-mute (and leave audio stuck muted
// with no listener left to restore it).
let pluginActive = false;
// Outstanding deferred apply-timers, cleared on stop().
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
function deferApply(muted: boolean, delayMs: number) {
    const id = setTimeout(() => {
        pendingTimers.delete(id);
        if (!pluginActive) return;
        applyMuteState(muted);
    }, delayMs);
    pendingTimers.add(id);
}

function getEngine(): any {
    const w = (globalThis as any).Vencord;
    return (
        w?.Webpack?.Common?.MediaEngineStore?.getMediaEngine?.() ??
        w?.WebpackCommon?.MediaEngineStore?.getMediaEngine?.()
    );
}

// Bounded BFS for an RTCPeerConnection embedded inside a Discord connection
// wrapper. Discord's media engine hides the underlying PC under different
// keys across versions, so we walk the object graph instead of guessing.
function findPC(root: any, depth = 0, seen = new Set<any>()): RTCPeerConnection | undefined {
    if (!root || typeof root !== "object" || depth > 4 || seen.has(root)) return undefined;
    seen.add(root);
    if (root instanceof RTCPeerConnection) return root;
    for (const key of Object.keys(root)) {
        try {
            const v = (root as any)[key];
            if (v instanceof RTCPeerConnection) return v;
            if (v && typeof v === "object") {
                const found = findPC(v, depth + 1, seen);
                if (found) return found;
            }
        } catch {
            /* getters may throw — skip */
        }
    }
    return undefined;
}

interface ApplyResult {
    affected: number;
    streamCount: number;
}

function applyMuteState(muted: boolean): ApplyResult {
    const engine = getEngine();
    if (!engine) return { affected: 0, streamCount: 0 };
    let affected = 0;
    let streamCount = 0;
    for (const conn of engine.connections ?? []) {
        // Only screenshare connections carry a streamUserId. Voice-chat
        // connections don't, so they're skipped — voice stays audible.
        if (!conn?.streamUserId) continue;
        streamCount++;
        const pc: RTCPeerConnection | undefined =
            conn.pc ?? conn.connection?.pc ?? findPC(conn);
        if (!pc || typeof pc.getReceivers !== "function") continue;
        for (const receiver of pc.getReceivers()) {
            const track = receiver.track;
            if (!track || track.kind !== "audio") continue;
            const targetEnabled = !muted;
            if (muted) {
                // Mute: flip if needed, and record that WE touched it.
                if (track.enabled !== targetEnabled) {
                    track.enabled = false;
                    affected++;
                }
                touchedTracks.add(track);
            } else {
                // Unmute: ONLY restore tracks we previously muted. A track
                // disabled by some other path (Discord's per-stream volume,
                // system mixer) must not be force-enabled by us. This is the
                // safety the header promises — previously touchedTracks was
                // written but never read, so unmute clobbered everything.
                if (touchedTracks.has(track)) {
                    if (track.enabled !== targetEnabled) {
                        track.enabled = true;
                        affected++;
                    }
                    touchedTracks.delete(track);
                }
            }
        }
    }
    appliedMuted = muted;
    return { affected, streamCount };
}

function showToggleToast(muted: boolean, res: ApplyResult) {
    // Honesty guard: if there ARE active screenshares but we flipped nothing,
    // the mute did not actually engage — Discord hides the RTCPeerConnection
    // behind a native wrapper on some builds (the same reason the sender-side
    // track-replace path in screenShareFixes was abandoned). Never claim
    // success when affected === 0 with streams present.
    if (muted && res.streamCount > 0 && res.affected === 0) {
        Toasts.show({
            message:
                "⚠️ Couldn't mute screenshare audio — Discord didn't expose the stream's audio on this build. " +
                "Ask the streamer to update Discordmaxxer (sender-side fix) instead.",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: { duration: 5000, position: Toasts.Position.TOP }
        });
        return;
    }

    const msg = muted
        ? res.streamCount === 0
            ? "🔇 Screenshare audio muted — no active screenshares right now, new ones will mute on join"
            : `🔇 Screenshare audio muted (${res.affected} track${res.affected === 1 ? "" : "s"} across ${res.streamCount} stream${res.streamCount === 1 ? "" : "s"})`
        : res.streamCount === 0
          ? "🔊 Screenshare audio unmuted"
          : `🔊 Screenshare audio unmuted (${res.streamCount} stream${res.streamCount === 1 ? "" : "s"})`;
    Toasts.show({
        message: msg,
        type: muted ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS,
        id: Toasts.genId(),
        options: { duration: 3000, position: Toasts.Position.TOP }
    });
}

// Fires when a new screenshare connection is created (anyone in the call
// starts sharing, including yourself). If we're currently muted, re-apply
// after a short delay so the new connection's receivers exist.
function onStreamCreate() {
    if (!settings.store.muted) return;
    // Discord wires the RTCPeerConnection asynchronously after the Flux
    // event fires. 300ms is the sweet spot from testing — most negotiations
    // complete <100ms but a buffer absorbs slow rigs. Tracked + plugin-active
    // guarded so it can't fire after stop().
    deferApply(true, 300);
}

const settings = definePluginSettings({
    muted: {
        type: OptionType.BOOLEAN,
        description:
            "Mute ALL incoming screenshare audio (voice chat stays unchanged). " +
            "Flip ON when a streamer's audio capture is feeding your own voice back at you. " +
            "Persists across launches and re-applies to newly-joined screenshares.",
        default: false,
        onChange: (value: boolean) => {
            const res = applyMuteState(value);
            showToggleToast(value, res);
        }
    },
    showHotkeyHint: {
        type: OptionType.BOOLEAN,
        description: "Show a console hint about the Ctrl+Shift+M hotkey on plugin start.",
        default: true
    }
});

function toggleMute() {
    settings.store.muted = !settings.store.muted;
    // onChange handler applies state + shows the toast.
}

function onKeyDown(e: KeyboardEvent) {
    // Ctrl+Shift+M, no Alt, no Meta. Skip if the user is typing in a field
    // — Discord's message composer is a contentEditable, also covered.
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (e.key !== "M" && e.key !== "m") return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    toggleMute();
}

export default definePlugin({
    name: "DMStreamMute",
    description:
        "🔇 Local mute toggle for incoming screenshare audio. Voice chat stays audible — only the streamer's game/system audio gets silenced. Use when a streamer's WASAPI loopback is echoing your own voice back at you and you don't want to walk them through fixing their settings. Hotkey: Ctrl+Shift+M.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        pluginActive = true;
        window.addEventListener("keydown", onKeyDown, true);
        FluxDispatcher.subscribe("STREAM_CREATE", onStreamCreate);
        // Re-apply persisted state on launch so a saved mute survives restart.
        // 500ms gives Discord's media engine time to come up before we
        // poke at its connections list.
        if (settings.store.muted) {
            deferApply(true, 500);
        }
        if (settings.store.showHotkeyHint) {
            console.log(
                "[DiscordmaxxerStreamMute] Loaded. Toggle incoming screenshare audio with Ctrl+Shift+M, " +
                    "or use the row in the Discordmaxxer Hub panel."
            );
        }
    },

    stop() {
        pluginActive = false;
        // Cancel any pending deferred applies so a timer can't re-mute after
        // we restore below (which would strand audio muted with no listener).
        for (const id of pendingTimers) clearTimeout(id);
        pendingTimers.clear();
        window.removeEventListener("keydown", onKeyDown, true);
        FluxDispatcher.unsubscribe("STREAM_CREATE", onStreamCreate);
        // On unload, un-mute everything we muted — leaves the user's audio
        // in a known-good state if they uninstall the plugin.
        if (appliedMuted) applyMuteState(false);
    }
});

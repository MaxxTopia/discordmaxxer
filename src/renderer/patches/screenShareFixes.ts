/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Discordmaxxer contributors — Windows per-window audio patch
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { Toasts } from "@vencord/types/webpack/common";
import { currentSettings } from "renderer/components/ScreenSharePicker";
import { State } from "renderer/settings";
import { isLinux } from "renderer/utils";
import { startWinAudioExcludeSelfSession } from "renderer/winaudioBridge";

const logger = new Logger("VesktopStreamFixes");

const isWindows = !isLinux && navigator.platform.startsWith("Win");

if (isLinux) {
    const original = navigator.mediaDevices.getDisplayMedia;

    async function getVirtmic() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioDevice = devices.find(({ label }) => label === "vencord-screen-share");
            return audioDevice?.deviceId;
        } catch (error) {
            return null;
        }
    }

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        const stream = await original.call(this, opts);
        const id = await getVirtmic();

        const frameRate = Number(State.store.screenshareQuality?.frameRate ?? 30);
        const height = Number(State.store.screenshareQuality?.resolution ?? 720);
        const width = Math.round(height * (16 / 9));
        const track = stream.getVideoTracks()[0];

        track.contentHint = String(currentSettings?.contentHint);

        const constraints = {
            ...track.getConstraints(),
            frameRate: { min: frameRate, ideal: frameRate },
            width: { min: 640, ideal: width, max: width },
            height: { min: 480, ideal: height, max: height },
            advanced: [{ width: width, height: height }],
            resizeMode: "none"
        };

        track
            .applyConstraints(constraints)
            .then(() => {
                logger.info("Applied constraints successfully. New constraints: ", track.getConstraints());
            })
            .catch(e => logger.error("Failed to apply constraints.", e));

        if (id) {
            const audio = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: {
                        exact: id
                    },
                    autoGainControl: false,
                    echoCancellation: false,
                    noiseSuppression: false,
                    channelCount: 2,
                    sampleRate: 48000,
                    sampleSize: 16
                }
            });

            stream.getAudioTracks().forEach(t => stream.removeTrack(t));
            stream.addTrack(audio.getAudioTracks()[0]);
        }

        return stream;
    };
}

// Windows screenshare audio — winaudio exclude-self injection (echo fix).
//
// THE ECHO: `getDisplayMedia({ audio: true })` on Windows hands back a
// system-loopback track (everything playing on the default output device).
// When a viewer is also on the voice call, that loopback contains the
// viewer's own voice playing back through the broadcaster's output → the
// viewer hears themself echoed.
//
// THE FIX: before Discord ever ingests the stream, swap the loopback audio
// track for a native winaudio process-loopback capture in EXCLUDE-SELF mode —
// the whole system mix MINUS Discordmaxxer's own process tree. Discord plays
// incoming voice through its own (excluded) renderer/audio-service children,
// so that voice is never in the captured mix → no echo. The game / desktop
// audio (separate processes) stays. This is what official Discord effectively
// does, and the native capture is verified working on real hardware
// (packages/winaudio/test-loopback.js).
//
// WHY HERE and not replaceTrack-on-sender: Discord's MediaEngine hides its
// RTCPeerConnection behind a native wrapper, so the prior approach (find the
// audio RTCRtpSender and replaceTrack) never located a sender and silently
// fell back to the echoing loopback every time. Injecting at getDisplayMedia
// time has zero dependency on Discord internals — the swapped track simply IS
// the screenshare's audio when Discord picks the stream up.
//
// FALLBACK: if winaudio is unavailable (load failed / non-float mix format /
// any error) we leave the original loopback track in place — audio still
// works, just with the pre-existing echo. Never worse than before.
//
// Diagnostic breadcrumbs land in window.__dmEcho without spamming the console.
const ECHO_LOG: any[] = [];
(globalThis as any).__dmEcho = ECHO_LOG;

// Records how the most recent screenshare resolved its audio, so the
// auto-capture (patches/streamHealthAuto.ts) can report whether the echo fix
// actually engaged without re-deriving it.
//   "winaudio"          → clean exclude-self capture injected (no echo)
//   "loopback-fallback" → winaudio unavailable/non-float, kept system loopback (may echo)
//   "video-only"        → audio not requested
//   "none"              → no share since launch
export type EchoInjectionResult = "winaudio" | "loopback-fallback" | "video-only" | "none";
let lastEchoInjection: EchoInjectionResult = "none";
export function getLastEchoInjection(): EchoInjectionResult {
    return lastEchoInjection;
}

function debug(...args: any[]) {
    logger.info("[echo]", ...args);
    ECHO_LOG.push(args.map(a => (typeof a === "object" ? JSON.parse(JSON.stringify(a)) : a)));
}

function toast(message: string, type: number) {
    try {
        Toasts.show({ message, id: Toasts.genId(), type });
    } catch (e) {
        debug("toast failed", String(e));
    }
}

if (isWindows) {
    debug("screenShareFixes patch loaded — getDisplayMedia wrapper installed (winaudio exclude-self)");

    const original = navigator.mediaDevices.getDisplayMedia;

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        const stream = await original.call(this, opts);

        debug("getDisplayMedia called", { audioRequested: !!currentSettings?.audio });

        // Video-only share, or audio not requested → nothing to de-echo.
        if (!currentSettings?.audio) {
            lastEchoInjection = "video-only";
            return stream;
        }

        const loopbackTracks = stream.getAudioTracks();
        debug(`original (loopback) audio track count: ${loopbackTracks.length}`);

        try {
            // Capture the system mix minus our own process tree. The PID is
            // resolved in the main process from process.pid — the renderer
            // never supplies it, so it can't be tricked into excluding the
            // wrong tree.
            const session = await startWinAudioExcludeSelfSession();

            // Safety: the renderer PCM feeder only handles 32-bit float mix
            // formats (every modern Win10/11 shared-mode mix is float). On a
            // rare non-float rig the track would be SILENT — worse than echo —
            // so bail and keep the loopback track instead of going quiet.
            if (!session.format.isFloat) {
                await session.stop().catch(() => {});
                throw new Error(`winaudio mix is non-float (bits=${session.format.bitsPerSample}) — keeping loopback`);
            }

            const cleanTrack = session.track;
            if (!cleanTrack || cleanTrack.readyState === "ended") {
                await session.stop().catch(() => {});
                throw new Error("winaudio produced no live track");
            }

            // A "live" track can still be SILENT (suspended AudioContext, native
            // capture returning silence on this rig, broken IPC feed). That's
            // strictly worse than the echo we're trying to remove — viewers hear
            // nothing. So before committing, confirm real audio is reaching the
            // track. Crucially we DON'T stop the loopback yet, so if the clean
            // capture is silent we can fall back to it (audible, may echo).
            const flowing = await session.waitForSignal(1500);
            if (!flowing) {
                await session.stop().catch(() => {});
                throw new Error("winaudio track had no signal within 1.5s — keeping audible loopback");
            }

            // Confirmed audible. NOW it's safe to drop the echoing loopback.
            loopbackTracks.forEach(t => {
                stream.removeTrack(t);
                t.stop();
            });
            stream.addTrack(cleanTrack);

            lastEchoInjection = "winaudio";
            debug("VERDICT: winaudio exclude-self audio injected (signal confirmed) — no Discord voice in the mix");
            toast("Stream audio: capturing game/desktop audio without your call (no echo).", Toasts.Type.MESSAGE);
        } catch (e) {
            // Keep the stock loopback track exactly as it was — audio works,
            // may echo. Strictly never worse than not having this patch.
            lastEchoInjection = "loopback-fallback";
            debug("winaudio injection failed — keeping system loopback audio (may echo)", String(e));
        }

        return stream;
    };
}

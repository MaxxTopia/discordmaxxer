/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { Toasts } from "@vencord/types/webpack/common";
import { currentSettings, currentSourceId } from "renderer/components/ScreenSharePicker";
import { Settings, State } from "renderer/settings";
import { isLinux } from "renderer/utils";
import {
    resolveWinAudioSourceProcessId,
    startWinAudioExcludeSelfSession,
    startWinAudioProcessSession
} from "renderer/winaudioBridge";

import { registerScreenShareVideoTracks } from "./screenShareTrackRegistry";
import { applyScreenShareVideoQuality } from "./videoQuality";

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
        registerScreenShareVideoTracks(stream);
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

// Windows screenshare audio — strict selected-window capture plus an
// exclude-self compatibility path (echo fix).
//
// THE ECHO: `getDisplayMedia({ audio: true })` on Windows hands back a
// system-loopback track (everything playing on the default output device).
// When a viewer is also on the voice call, that loopback contains the
// viewer's own voice playing back through the broadcaster's output → the
// viewer hears themself echoed.
//
// THE STRICT FIX: when the user enables selected-window audio, resolve the
// Windows source id to its owning process and swap the loopback audio track
// for a native winaudio process-loopback capture in INCLUDE mode. That means
// the selected game's process tree is the only captured program; Discord's
// call audio is not part of the stream. If the source cannot be resolved or
// the native capture cannot become ready, remove the audio track and keep the
// share video-only rather than leaking the system mix.
//
// COMPATIBILITY PATH: when strict selected-window audio is off, retain the
// existing EXCLUDE-SELF capture. It removes Discordmaxxer's process tree from
// the system mix but can still include other applications, so it is not a
// Fortnite-only guarantee.
//
// WHY HERE and not replaceTrack-on-sender: Discord's MediaEngine hides its
// RTCPeerConnection behind a native wrapper, so the prior approach (find the
// audio RTCRtpSender and replaceTrack) never located a sender and silently
// fell back to the echoing loopback every time. Injecting at getDisplayMedia
// time has zero dependency on Discord internals — the swapped track simply IS
// the screenshare's audio when Discord picks the stream up.
//
// STRICT FALLBACK: if strict winaudio is unavailable (load failed / source
// cannot resolve / non-float format / any error), we remove the original
// loopback track. Video continues, but no untrusted system audio is sent.
// Compatibility mode retains its old loopback fallback for availability.
//
// Diagnostic breadcrumbs land in window.__dmEcho without spamming the console.
const ECHO_LOG: any[] = [];
(globalThis as any).__dmEcho = ECHO_LOG;

// Records how the most recent screenshare resolved its audio, so the
// auto-capture (patches/streamHealthAuto.ts) can report whether the echo fix
// actually engaged without re-deriving it.
//   "strict-winaudio"   → selected process capture injected (Fortnite-only)
//   "winaudio"          → clean exclude-self capture injected (no self-echo)
//   "strict-failed"     → strict isolation failed; audio was removed
//   "loopback-fallback" → compatibility capture failed; kept system loopback (may echo)
//   "video-only"        → audio not requested
//   "none"              → no share since launch
export type EchoInjectionResult =
    | "strict-winaudio"
    | "winaudio"
    | "strict-failed"
    | "loopback-fallback"
    | "video-only"
    | "none";
let lastEchoInjection: EchoInjectionResult = "none";
export function getLastEchoInjection(): EchoInjectionResult {
    return lastEchoInjection;
}

function debug(...args: any[]) {
    logger.info("[echo]", ...args);
    ECHO_LOG.push(args.map(a => (typeof a === "object" ? JSON.parse(JSON.stringify(a)) : a)));
}

function toast(message: string, type: string) {
    try {
        Toasts.show({ message, id: Toasts.genId(), type });
    } catch (e) {
        debug("toast failed", String(e));
    }
}

// Cap the captured screenshare video to the user's chosen quality and hint the
// encoder toward motion. Windows capture can initially expose the source's
// native dimensions while Discord is still negotiating its sender. Applying a
// target before ingestion, then retrying after submit(), keeps application
// windows and whole-screen captures on the same bounded path. Preserve the
// source aspect ratio and allow Chromium to crop-and-scale; forcing a fixed
// 16:9 box or resizeMode "none" is a poor fit for arbitrary application
// windows. The cap helps whether the eventual encoder is software or hardware.
async function applyVideoQualityConstraints(stream: MediaStream) {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
        const settings = await applyScreenShareVideoQuality(track, currentSettings?.contentHint);
        debug("applied video quality constraints", settings ?? track.getSettings?.());
    } catch (e) {
        debug("failed to apply video constraints", String(e));
    }
}

if (isWindows) {
    debug("screenShareFixes patch loaded — getDisplayMedia wrapper installed (strict selected-window audio available)");

    const original = navigator.mediaDevices.getDisplayMedia;

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        const stream = await original.call(this, opts);
        registerScreenShareVideoTracks(stream);

        debug("getDisplayMedia called", { audioRequested: !!currentSettings?.audio });

        // Cap resolution/framerate before Discord ingests the stream. The
        // sender-side retry in ScreenSharePicker handles the later negotiation
        // step that is especially easy to miss for application captures.
        try {
            await applyVideoQualityConstraints(stream);
        } catch (e) {
            debug("video quality constraint pass failed", String(e));
        }

        // Video-only share, or audio not requested → nothing to de-echo.
        if (!currentSettings?.audio) {
            lastEchoInjection = "video-only";
            return stream;
        }

        const loopbackTracks = stream.getAudioTracks();
        debug(`original (loopback) audio track count: ${loopbackTracks.length}`);

        // Strict mode is deliberately fail-closed. The main-process source
        // handler withholds Chromium's system loopback, and this branch adds
        // only the selected window's process capture after it is ready.
        if (Settings.store.screensharePerWindowAudio === true) {
            let strictSession: Awaited<ReturnType<typeof startWinAudioProcessSession>> | null = null;
            try {
                if (!currentSourceId) throw new Error("no selected Windows share source");

                const targetPid = await resolveWinAudioSourceProcessId(currentSourceId);
                strictSession = await startWinAudioProcessSession(targetPid, "include");

                if (!strictSession.format.isFloat) {
                    throw new Error(`selected process mix is non-float (bits=${strictSession.format.bitsPerSample})`);
                }

                const cleanTrack = strictSession.track;
                if (!cleanTrack || cleanTrack.readyState === "ended") {
                    throw new Error("selected process capture produced no live track");
                }

                const ready = await strictSession.waitUntilReady(3000);
                if (!ready) throw new Error("selected process AudioContext never reached running within 3s");

                // Informational only. A quiet/loading game is still a valid
                // capture; readiness, not loudness, is the safety gate.
                const audibleAtSwap = await strictSession.waitForSignal(400);
                debug("strict selected-window pipeline ready; audible-at-swap =", audibleAtSwap, { targetPid });

                loopbackTracks.forEach(t => {
                    stream.removeTrack(t);
                    t.stop();
                });
                stream.addTrack(cleanTrack);

                lastEchoInjection = "strict-winaudio";
                debug("VERDICT: selected process audio injected — system/Discord audio excluded", { targetPid });
                toast(
                    "Stream audio: capturing only the selected window (Discord audio excluded).",
                    Toasts.Type.SUCCESS
                );
                return stream;
            } catch (e) {
                await strictSession?.stop().catch(() => {});
                loopbackTracks.forEach(t => {
                    stream.removeTrack(t);
                    t.stop();
                });
                lastEchoInjection = "strict-failed";
                debug("STRICT AUDIO FAILED — continuing video-only to prevent Discord/system audio leak", String(e));
                toast(
                    "Stream audio disabled: Discordmaxxer could not isolate the selected window. Choose the game window or turn off strict audio.",
                    Toasts.Type.FAILURE
                );
                return stream;
            }
        }

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

            // Gate on PIPELINE READINESS (AudioContext running), NOT loudness.
            // A running context outputs the exclude-self mix — game audio when
            // it plays, silence when the game is quiet — and never Discord's own
            // voice, so it's echo-free regardless of whether sound happens to be
            // playing at Go-Live. Requiring audible audio here would wrongly fall
            // back to the echoing loopback whenever you go live during a quiet/
            // loading moment (WASAPI emits no packets during true silence). The
            // real failure we DO guard against — a context that never resumes
            // (silent forever) — returns false and falls back. The loopback
            // track is held until this resolves, so fallback stays audible.
            const ready = await session.waitUntilReady(3000);
            if (!ready) {
                await session.stop().catch(() => {});
                throw new Error("winaudio AudioContext never reached running within 3s — keeping loopback");
            }
            // Informational only — was audible program audio present right at
            // swap time? Does NOT gate the swap; just a breadcrumb in __dmEcho.
            const audibleAtSwap = await session.waitForSignal(400);
            debug("winaudio pipeline ready (ctx running); audible-at-swap =", audibleAtSwap);

            // Confirmed audible. NOW it's safe to drop the echoing loopback.
            loopbackTracks.forEach(t => {
                stream.removeTrack(t);
                t.stop();
            });
            stream.addTrack(cleanTrack);

            lastEchoInjection = "winaudio";
            debug("VERDICT: winaudio exclude-self audio injected (pipeline flowing) — no Discord voice in the mix");
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

/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Discordmaxxer contributors — Windows per-window audio patch
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { Toasts } from "@vencord/types/webpack/common";
import { currentSettings, currentSourceId } from "renderer/components/ScreenSharePicker";
import { State } from "renderer/settings";
import { isLinux } from "renderer/utils";

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

// Windows screenshare audio — per-window swap with no-op detection.
//
// `getDisplayMedia({ audio: true })` on Windows hands back a system-loopback
// track (everything playing on the default output device). When the viewer
// is also on the voice call, that loopback contains the viewer's own voice
// coming through the broadcaster's speakers → the viewer hears themself
// echoed back.
//
// The mitigation: re-request audio with `chromeMediaSource: "desktop"` +
// the window source id, which Chromium *does* support for Chromium-rendered
// windows (Chrome, Edge, Electron apps including Discord itself). For those
// the resulting track is pinned to the window's process and doesn't include
// the rest of the system mixer → no echo.
//
// The catch: for native Win32 windows (games like Valorant, Fortnite),
// Chromium can't hook into the window's audio session and silently falls
// back to system loopback. So the "swap" returns the same loopback track
// we already had → echo persists.
//
// We detect the no-op at runtime by comparing the swapped track's label
// to the original loopback track's label. Identical → swap fell back,
// drop audio entirely (silence > echo). Different → swap actually moved
// us to a per-window source, keep it.
//
// Diagnostic logs land in window.__dmEcho for later debug retrieval
// without spamming the user console at warn level.
const ECHO_LOG: any[] = [];
(globalThis as any).__dmEcho = ECHO_LOG;

function debug(...args: any[]) {
    logger.info("[echo]", ...args);
    ECHO_LOG.push(args.map(a => (typeof a === "object" ? JSON.parse(JSON.stringify(a)) : a)));
}

function snapshotTrack(t: MediaStreamTrack, tag: string) {
    try {
        const settings = t.getSettings ? t.getSettings() : {};
        const info = {
            label: t.label,
            kind: t.kind,
            id: t.id,
            readyState: t.readyState,
            enabled: t.enabled,
            muted: t.muted,
            settings
        };
        debug(`audio-track[${tag}]`, info);
        return info;
    } catch (e) {
        debug(`audio-track[${tag}] snapshot failed`, String(e));
        return null;
    }
}

function dropAudioTracks(stream: MediaStream, reason: string) {
    stream.getAudioTracks().forEach(t => {
        stream.removeTrack(t);
        t.stop();
    });
    debug(`dropped audio track — ${reason}`);
}

function toast(message: string, type: number) {
    try {
        Toasts.show({ message, id: Toasts.genId(), type });
    } catch (e) {
        debug("toast failed", String(e));
    }
}

// True when post-swap track looks like the same source as pre-swap (label
// match). Chromium hands back the same loopback for windows it can't
// audio-capture per-process.
//
// Empty-string labels are AMBIGUOUS — Chromium often returns empty labels
// for screenshare audio tracks regardless of whether they're true per-window
// or system loopback. We only flag the unambiguous case (both labels
// non-empty and identical). Empty=empty falls through as "not a confirmed
// no-op" so audio is preserved. The cost is that game-window shares may
// echo through in WGC-off mode (since their fallback loopback label is
// also probably empty), but the user's strong preference is "audio working
// over echo prevention" — a future proper-fix is the winaudio module.
function swapWasNoOp(pre: MediaStreamTrack | undefined, post: MediaStreamTrack): boolean {
    if (!pre) return false;
    const preLabel = (pre.label ?? "").trim();
    const postLabel = (post.label ?? "").trim();
    if (preLabel === "" || postLabel === "") return false;
    return preLabel === postLabel;
}

if (isWindows) {
    debug("screenShareFixes patch loaded — getDisplayMedia wrapper installed");

    const original = navigator.mediaDevices.getDisplayMedia;

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        const stream = await original.call(this, opts);

        debug("getDisplayMedia called", {
            audioRequested: !!currentSettings?.audio,
            sourceId: currentSourceId ?? "(none)"
        });

        if (!currentSettings?.audio) return stream;

        const originalTracks = stream.getAudioTracks();
        debug(`original audio track count: ${originalTracks.length}`);
        const preSnap = originalTracks[0];
        originalTracks.forEach((t, i) => snapshotTrack(t, `pre-swap-${i}`));

        if (!currentSourceId) {
            dropAudioTracks(stream, "no source id from picker");
            toast(
                "Stream audio dropped — no source selected. Reopen the share picker.",
                Toasts.Type.FAILURE
            );
            return stream;
        }

        try {
            const audio = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: "desktop",
                        chromeMediaSourceId: currentSourceId
                    }
                } as any
            });

            const newTrack = audio.getAudioTracks()[0];
            if (!newTrack) {
                dropAudioTracks(stream, "per-window capture returned no tracks");
                toast(
                    "Stream audio not available for this window — sharing video only.",
                    Toasts.Type.MESSAGE
                );
                return stream;
            }

            snapshotTrack(newTrack, "post-swap-new");

            // Detect the silent-fallback case: Chromium couldn't give us a
            // per-window audio session for this source (native game window,
            // unsupported app, etc.) and returned the same system loopback.
            // Keeping it would echo the call back to viewers.
            if (swapWasNoOp(preSnap, newTrack)) {
                newTrack.stop();
                dropAudioTracks(stream, "post-swap label matched pre-swap — Chromium fell back to loopback");
                toast(
                    "Stream audio not supported for this window (likely a game) — " +
                        "sharing video only. Use a Chrome/Edge window or share the whole screen for audio.",
                    Toasts.Type.MESSAGE
                );
                debug("VERDICT: per-window swap was a no-op for this source — audio dropped to prevent echo");
                return stream;
            }

            // Real swap: release the loopback session, replace with the
            // per-window track. Stop-before-remove so Chromium tears down
            // the underlying capture cleanly.
            stream.getAudioTracks().forEach(t => {
                stream.removeTrack(t);
                t.stop();
            });
            stream.addTrack(newTrack);

            debug(`VERDICT: per-window swap succeeded for source ${currentSourceId}`);
        } catch (e) {
            dropAudioTracks(stream, "per-window capture threw");
            toast(
                "Stream audio capture failed — sharing video only.",
                Toasts.Type.FAILURE
            );
            debug("per-window capture threw", String(e));
        }

        return stream;
    };
}

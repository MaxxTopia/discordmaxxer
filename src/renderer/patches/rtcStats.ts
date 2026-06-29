/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Discordmaxxer contributors — live WebRTC encoder telemetry
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Why this exists: the #1 recurring screenshare complaint is "viewers say my
 * stream is choppy/laggy" and NO in-app setting (bitrate, resolution, fps, HW
 * accel) changes it. That signature almost always means the WebRTC video
 * encoder fell back to SOFTWARE (OpenH264 / libvpx) and is CPU-limited, so it
 * drops frames under fast motion — the broadcaster's own preview looks fine
 * because that's the raw capture, but viewers get the throttled encoded stream.
 *
 * The only way to know for sure is the sender-side getStats() outbound-rtp
 * video report: `encoderImplementation` (hardware vs software) and
 * `qualityLimitationReason` (cpu vs bandwidth vs none). Discord's MediaEngine
 * hides its RTCPeerConnection behind a native wrapper, so we can't reach it by
 * walking the connection object (that's also why the old replaceTrack-on-sender
 * echo path never fired). Instead we patch the RTCPeerConnection CONSTRUCTOR at
 * renderer startup and keep a weak registry of every PC Discord's web client
 * creates. Polling getStats across them surfaces the encoder truth with zero
 * dependency on Discord internals.
 */

// Live registry of every RTCPeerConnection created in this renderer. WeakRef so
// closed/GC'd connections don't leak. Discord makes several (voice, video,
// stream); we scan all and pick whichever currently has an outbound video feed.
const PC_REGISTRY: Array<WeakRef<RTCPeerConnection>> = [];

let patched = false;

export function installRtcStatsTracker() {
    if (patched) return;
    patched = true;

    const Native = window.RTCPeerConnection;
    if (!Native || (Native as any).__dmTracked) return;

    function TrackedRTCPeerConnection(this: any, ...args: any[]) {
        // `new RTCPeerConnection(...)` — construct the real one and register it.
        const pc = new (Native as any)(...args);
        try {
            PC_REGISTRY.push(new WeakRef(pc));
            // Opportunistic compaction so the array can't grow unbounded across
            // a long session of repeated calls.
            if (PC_REGISTRY.length > 32) {
                for (let i = PC_REGISTRY.length - 1; i >= 0; i--) {
                    if (!PC_REGISTRY[i].deref()) PC_REGISTRY.splice(i, 1);
                }
            }
        } catch {
            /* never let telemetry break a real connection */
        }
        return pc;
    }

    TrackedRTCPeerConnection.prototype = Native.prototype;
    (TrackedRTCPeerConnection as any).__dmTracked = true;
    // Preserve static helpers (generateCertificate, etc.).
    Object.setPrototypeOf(TrackedRTCPeerConnection, Native);

    try {
        window.RTCPeerConnection = TrackedRTCPeerConnection as any;
        // Some Chromium builds also expose the webkit-prefixed alias.
        (window as any).webkitRTCPeerConnection = TrackedRTCPeerConnection;
    } catch {
        // If the property is non-writable for some reason, bail quietly —
        // worst case the live readout just shows "no data".
        patched = false;
    }
}

export interface OutboundVideoStat {
    /** "hardware" if encoderImplementation looks like a GPU encoder, else "software". */
    encoderKind: "hardware" | "software" | "unknown";
    encoderImplementation: string;
    /** "cpu" = encoder-bound, "bandwidth" = network, "none" = healthy. */
    qualityLimitationReason: string;
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    /** kbps over the sample window. */
    kbps: number;
    /** % of frames the encoder dropped vs captured this session (0–100). */
    dropPct: number;
}

// Heuristic: Chromium reports HW encoders with vendor / accelerator strings and
// software with "OpenH264"/"libvpx"/"SimulcastEncoderAdapter (libvpx...)".
function classifyEncoder(impl: string): "hardware" | "software" | "unknown" {
    if (!impl) return "unknown";
    const i = impl.toLowerCase();
    if (i.includes("openh264") || i.includes("libvpx") || i.includes("libaom") || i.includes("ffmpeg"))
        return "software";
    if (
        i.includes("nvenc") ||
        i.includes("mediafoundation") ||
        i.includes("media foundation") ||
        i.includes("d3d") ||
        i.includes("qsv") ||
        i.includes("quicksync") ||
        i.includes("vaapi") ||
        i.includes("amf") ||
        i.includes("hardware") ||
        i.includes("encodeaccelerator") ||
        i.includes("externalencoder")
    )
        return "hardware";
    return "unknown";
}

// Track last bytesSent per PC so we can compute a bitrate from the delta.
const lastSample = new Map<string, { bytes: number; ts: number }>();

// Stable per-PC id so the bitrate-sample key survives PC_REGISTRY compaction.
// Keying by the live array index (the old approach) meant a splice renumbered
// indices and every PC's kbps delta reset to 0 for a cycle.
let pcIdCounter = 0;
const pcIds = new WeakMap<RTCPeerConnection, number>();
function pcIdFor(pc: RTCPeerConnection): number {
    let id = pcIds.get(pc);
    if (id === undefined) {
        id = ++pcIdCounter;
        pcIds.set(pc, id);
    }
    return id;
}

/**
 * Poll every tracked RTCPeerConnection's getStats() and return the most active
 * outbound video stream's encoder telemetry, or null if nothing is streaming
 * video right now. Safe to call on an interval from a settings panel.
 */
export async function getOutboundVideoStats(): Promise<OutboundVideoStat | null> {
    let best: OutboundVideoStat | null = null;
    let bestFrames = -1;

    for (let idx = 0; idx < PC_REGISTRY.length; idx++) {
        const pc = PC_REGISTRY[idx].deref();
        if (!pc || pc.connectionState === "closed") continue;
        const pcKey = pcIdFor(pc);

        let report: RTCStatsReport;
        try {
            report = await pc.getStats();
        } catch {
            continue;
        }

        report.forEach((s: any) => {
            if (s.type !== "outbound-rtp") return;
            if ((s.kind ?? s.mediaType) !== "video") return;
            // Skip inactive simulcast layers / not-yet-sending senders.
            const framesEncoded = s.framesEncoded ?? 0;
            if (!framesEncoded && !(s.bytesSent > 0)) return;
            if (framesEncoded <= bestFrames) return;
            bestFrames = framesEncoded;

            const key = `${pcKey}:${s.ssrc ?? s.id}`;
            const now = s.timestamp ?? Date.now();
            const bytes = s.bytesSent ?? 0;
            let kbps = 0;
            const prev = lastSample.get(key);
            if (prev && now > prev.ts) {
                kbps = Math.max(0, ((bytes - prev.bytes) * 8) / (now - prev.ts)); // bytes/ms*8 = kbit/s
            }
            lastSample.set(key, { bytes, ts: now });

            const framesSent = s.framesSent ?? framesEncoded;
            const dropped = Math.max(0, framesEncoded - framesSent);
            const dropPct = framesEncoded > 0 ? Math.min(100, (dropped / framesEncoded) * 100) : 0;

            const impl = String(s.encoderImplementation ?? "");
            best = {
                encoderKind: classifyEncoder(impl),
                encoderImplementation: impl || "(unknown)",
                qualityLimitationReason: String(s.qualityLimitationReason ?? "none"),
                framesPerSecond: Math.round(s.framesPerSecond ?? 0),
                frameWidth: s.frameWidth ?? 0,
                frameHeight: s.frameHeight ?? 0,
                kbps: Math.round(kbps),
                dropPct: Math.round(dropPct)
            };
        });
    }

    // Bound the delta map — keys accumulate as ssrcs churn over a long session.
    // Clearing costs one cycle of kbps=0 on the next poll, which is harmless.
    if (lastSample.size > 256) lastSample.clear();

    return best;
}

installRtcStatsTracker();

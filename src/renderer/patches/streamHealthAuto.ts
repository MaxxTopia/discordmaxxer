/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Toasts } from "@vencord/types/webpack/common";
import { Settings } from "renderer/settings";
import { isWindows } from "renderer/utils";

import { getOutboundVideoStats } from "./rtcStats";
import { getLastEchoInjection } from "./screenShareFixes";
import { getLiveScreenShareVideoTrack } from "./screenShareTrackRegistry";
import { showDiscordmaxxerStatusToast } from "./statusToast";
import { applyScreenShareVideoQuality, getScreenShareQualityTarget } from "./videoQuality";

export interface LastStreamHealth {
    ts: number;
    sourceKind: "screenshare";
    encoderImplementation: string;
    encoderKind: "hardware" | "software" | "unknown";
    qualityLimitationReason: string;
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    kbps: number;
    dropPct: number;
    echoFix: string;
    verdict: string;
    healthy: boolean;
}

function toast(message: string, type: string) {
    showDiscordmaxxerStatusToast(message, type);
}

let streaming = false;
let streamStartTs = 0;
let capturedThisStream = false;
let autoAdjustedThisStream = false;

const WARMUP_MS = 6000;
const POLL_MS = 3000;

async function tick() {
    let stat;
    try {
        stat = await getOutboundVideoStats();
    } catch {
        return;
    }

    if (stat) {
        if (!streaming) {
            // null → streaming edge: a share just went live.
            streaming = true;
            streamStartTs = Date.now();
            capturedThisStream = false;
            autoAdjustedThisStream = false;
        }
        // Keep watching after startup as well. A game can become encoder- or
        // bandwidth-limited several seconds into a share, especially when a
        // match starts or Discord opens another hardware-accelerated surface.
        const stabilizing = stabilizeVideoIfNeeded(stat);
        // Once the encoder has settled, snapshot exactly once per share.
        if (!capturedThisStream && !stabilizing && Date.now() - streamStartTs >= WARMUP_MS) {
            capturedThisStream = true;
            capture(stat);
        }
    } else if (streaming) {
        // streaming → null edge: share ended, re-arm for the next one.
        streaming = false;
    }
}

function nextStabilizingTarget(stat: NonNullable<Awaited<ReturnType<typeof getOutboundVideoStats>>>) {
    const requested = getScreenShareQualityTarget();
    const videoStressed =
        stat.qualityLimitationReason === "cpu" ||
        stat.qualityLimitationReason === "bandwidth" ||
        (stat.encoderKind === "software" && stat.framesPerSecond < requested.frameRate * 0.9) ||
        stat.framesPerSecond < requested.frameRate * 0.75;

    if (!videoStressed) return null;

    // Preserve resolution first when possible: dropping 60 -> 30 is usually
    // enough to rescue a game share while keeping text and HUD detail sharp.
    if (requested.frameRate > 30) return { frameRate: 30, height: requested.height };

    const rung = [480, 720, 1080, 1440, 2160].indexOf(requested.height);
    if (rung > 1) return { frameRate: requested.frameRate, height: [480, 720, 1080, 1440, 2160][rung - 1] };

    return null;
}

function stabilizeVideoIfNeeded(stat: NonNullable<Awaited<ReturnType<typeof getOutboundVideoStats>>>) {
    if (autoAdjustedThisStream) return false;

    const target = nextStabilizingTarget(stat);
    if (!target) return false;

    const track = getLiveScreenShareVideoTrack();
    if (!track) return false;

    autoAdjustedThisStream = true;
    void applyScreenShareVideoQuality(track, "motion", target)
        .then(settings => {
            const delivered = settings as MediaTrackSettings | null;
            const actual = delivered?.height ? `${delivered.width ?? "?"}x${delivered.height}` : "the safer fallback";
            toast(
                `Stream was limited at the selected quality; stabilized at ${target.height}p${target.frameRate} (${actual}) to prevent freeze frames.`,
                Toasts.Type.MESSAGE
            );
        })
        .catch(() => {
            autoAdjustedThisStream = false;
        });

    return true;
}

function capture(stat: NonNullable<Awaited<ReturnType<typeof getOutboundVideoStats>>>) {
    const echoFix = getLastEchoInjection();

    const software = stat.encoderKind === "software";
    const cpuLimited = stat.qualityLimitationReason === "cpu";
    const bwLimited = stat.qualityLimitationReason === "bandwidth";
    const lowFps = stat.framesPerSecond < 24;
    const echoRisk = echoFix === "loopback-fallback" || echoFix === "strict-failed";
    const healthy = !lowFps && !software && !cpuLimited && !echoRisk;

    let verdict: string;
    if (lowFps)
        verdict = `Only ${stat.framesPerSecond} FPS is leaving the screenshare sender — capture or encoding is stalled`;
    else if (software)
        verdict = `Software encoder (${stat.encoderImplementation}) — choppy under motion; re-enable HW encode`;
    else if (cpuLimited) verdict = "Hardware encoder but CPU-limited — drop to 720p30 / check optimizer tweaks";
    else if (bwLimited) verdict = "Bandwidth-limited — network is the bottleneck";
    else verdict = `Healthy: hardware encoder @ ${stat.framesPerSecond}fps`;

    const health: LastStreamHealth = {
        ts: Date.now(),
        sourceKind: stat.sourceKind,
        encoderImplementation: stat.encoderImplementation,
        encoderKind: stat.encoderKind,
        qualityLimitationReason: stat.qualityLimitationReason,
        framesPerSecond: stat.framesPerSecond,
        frameWidth: stat.frameWidth,
        frameHeight: stat.frameHeight,
        kbps: stat.kbps,
        dropPct: stat.dropPct,
        echoFix,
        verdict,
        healthy
    };

    try {
        // Persists to the on-disk settings.json via the global change listener.
        (Settings.store as any).lastStreamHealth = health;
    } catch {
        /* never let persistence break anything */
    }

    // Surface it. Healthy = quiet confirmation; problem = louder + actionable.
    const delivered = `${stat.frameWidth}x${stat.frameHeight} @ ${stat.framesPerSecond}fps`;
    if (healthy) {
        toast(
            `Stream OK: ${delivered}, ${stat.encoderKind} encoder, ${stat.kbps}kbps, echo-fix on`,
            Toasts.Type.SUCCESS
        );
    } else {
        const echoNote =
            echoFix === "strict-failed"
                ? " · strict audio was disabled because isolation failed"
                : echoFix === "loopback-fallback"
                  ? " · echo fix fell back to loopback"
                  : "";
        toast(
            `Stream health: ${verdict}${echoNote}. See Settings → Discordmaxxer → Dev Settings.`,
            Toasts.Type.FAILURE
        );
    }
}

// Windows-only: this whole class of complaint (choppy-to-viewers, echo) is the
// Windows screenshare path. Other platforms don't need the poll.
if (isWindows) {
    setInterval(tick, POLL_MS);
}

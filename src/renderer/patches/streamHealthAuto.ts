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

export interface LastStreamHealth {
    ts: number;
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
    try {
        Toasts.show({ message, id: Toasts.genId(), type });
    } catch {
        /* webpack not ready / no toast — fine */
    }
}

let streaming = false;
let streamStartTs = 0;
let capturedThisStream = false;

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
        }
        // Once the encoder has settled, snapshot exactly once per share.
        if (!capturedThisStream && Date.now() - streamStartTs >= WARMUP_MS) {
            capturedThisStream = true;
            capture(stat);
        }
    } else if (streaming) {
        // streaming → null edge: share ended, re-arm for the next one.
        streaming = false;
    }
}

function capture(stat: NonNullable<Awaited<ReturnType<typeof getOutboundVideoStats>>>) {
    const echoFix = getLastEchoInjection();

    const software = stat.encoderKind === "software";
    const cpuLimited = stat.qualityLimitationReason === "cpu";
    const bwLimited = stat.qualityLimitationReason === "bandwidth";
    const echoRisk = echoFix === "loopback-fallback";
    const healthy = !software && !cpuLimited && !echoRisk;

    let verdict: string;
    if (software)
        verdict = `Software encoder (${stat.encoderImplementation}) — choppy under motion; re-enable HW encode`;
    else if (cpuLimited) verdict = "Hardware encoder but CPU-limited — drop to 720p30 / check optimizer tweaks";
    else if (bwLimited) verdict = "Bandwidth-limited — network is the bottleneck";
    else verdict = `Healthy: hardware encoder @ ${stat.framesPerSecond}fps`;

    const health: LastStreamHealth = {
        ts: Date.now(),
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
    if (healthy) {
        toast(`Stream OK: ${stat.encoderKind} encoder @ ${stat.framesPerSecond}fps, echo-fix on`, Toasts.Type.SUCCESS);
    } else {
        const echoNote = echoRisk ? " · echo fix fell back to loopback" : "";
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

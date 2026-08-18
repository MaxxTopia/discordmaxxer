/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { State } from "renderer/settings";

const DEFAULT_FRAME_RATE = 30;
const DEFAULT_HEIGHT = 720;
const DEFAULT_ASPECT = 16 / 9;
const MAX_WIDTH = 3840;

function even(value: number) {
    return Math.max(2, Math.round(value / 2) * 2);
}

function qualityTarget() {
    const frameRate = Number(State.store.screenshareQuality?.frameRate ?? DEFAULT_FRAME_RATE);
    const height = Number(State.store.screenshareQuality?.resolution ?? DEFAULT_HEIGHT);

    return {
        frameRate: Number.isFinite(frameRate) && frameRate > 0 ? frameRate : DEFAULT_FRAME_RATE,
        height: Number.isFinite(height) && height > 0 ? height : DEFAULT_HEIGHT
    };
}

function targetDimensions(track: MediaStreamTrack) {
    const { height: targetHeight } = qualityTarget();
    const settings = track.getSettings?.() ?? {};
    const sourceWidth = Number(settings.width);
    const sourceHeight = Number(settings.height);
    const aspect =
        Number.isFinite(sourceWidth) && sourceWidth > 1 && Number.isFinite(sourceHeight) && sourceHeight > 1
            ? sourceWidth / sourceHeight
            : DEFAULT_ASPECT;

    let height = even(targetHeight);
    let width = even(height * aspect);
    if (width > MAX_WIDTH) {
        width = MAX_WIDTH;
        height = even(width / aspect);
    }

    return { frameRate: qualityTarget().frameRate, width, height };
}

/**
 * Build constraints that let Chromium downscale a desktop/window capture.
 * `resizeMode: "none"` is a poor fit for application windows: when their
 * native aspect ratio or dimensions do not match the requested 16:9 box,
 * Chromium can reject the request or leave the track at its expensive native
 * size. Preserve the source aspect ratio and use crop-and-scale so window and
 * whole-screen shares settle through the same path.
 */
export function getScreenShareVideoConstraints(track: MediaStreamTrack): MediaTrackConstraints {
    const { frameRate, width, height } = targetDimensions(track);

    // Preserve unrelated constraints, but replace stale dimensions/advanced
    // entries from the previous one-shot pass so they cannot fight this retry.
    const preserved = { ...track.getConstraints() } as MediaTrackConstraints & { advanced?: unknown };
    delete (preserved as any).width;
    delete (preserved as any).height;
    delete (preserved as any).frameRate;
    delete (preserved as any).resizeMode;
    delete preserved.advanced;

    return {
        ...preserved,
        frameRate: { ideal: frameRate, max: frameRate },
        width: { ideal: width, max: width },
        height: { ideal: height, max: height },
        resizeMode: "crop-and-scale"
    } as MediaTrackConstraints;
}

export async function applyScreenShareVideoQuality(track: MediaStreamTrack, contentHint?: string) {
    if (track.readyState !== "live") return null;

    track.contentHint = contentHint === "detail" ? "detail" : "motion";
    await track.applyConstraints(getScreenShareVideoConstraints(track));
    return track.getSettings?.() ?? null;
}

function isAtTarget(track: MediaStreamTrack) {
    const settings = track.getSettings?.() ?? {};
    const width = Number(settings.width);
    const height = Number(settings.height);
    const frameRate = Number(settings.frameRate);
    if (![width, height, frameRate].every(Number.isFinite)) return false;

    const target = targetDimensions(track);
    // Chromium can round capture dimensions by a pixel or two. Treat that as
    // settled, but do not stop while the track is still above the requested
    // resource budget.
    return width <= target.width + 2 && height <= target.height + 2 && frameRate <= target.frameRate + 1;
}

/**
 * Discord creates the MediaEngine sender after getDisplayMedia resolves. A
 * single delayed applyConstraints call can therefore miss it, especially for
 * application/window captures. Retry briefly while the sender settles; each
 * pass is idempotent and stops naturally when the stream ends.
 */
export async function settleScreenShareVideoQuality(
    getTrack: () => MediaStreamTrack | undefined,
    contentHint?: string
) {
    const delays = [75, 250, 600, 1200, 2200];
    let applied = false;

    for (const delay of delays) {
        await new Promise(resolve => setTimeout(resolve, delay));
        const track = getTrack();
        if (!track || track.readyState !== "live") continue;

        try {
            await applyScreenShareVideoQuality(track, contentHint);
            applied = true;
            if (isAtTarget(track)) break;
        } catch {
            // A transient negotiation state can reject constraints. The next
            // pass retries after the track has had time to settle.
        }
    }

    return applied;
}

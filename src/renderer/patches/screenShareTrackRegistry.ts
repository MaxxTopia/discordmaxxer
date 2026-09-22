/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const screenShareTrackIds = new Set<string>();
const DISPLAY_SURFACES = new Set(["application", "browser", "monitor", "window"]);

/** Mark the video tracks returned by getDisplayMedia before Discord adds them
 * to its sender. This lets diagnostics distinguish a screenshare from the
 * camera without relying on whichever outbound stream has the most frames. */
export function registerScreenShareVideoTracks(stream: MediaStream) {
    for (const track of stream.getVideoTracks()) {
        if (track.readyState !== "live") continue;

        screenShareTrackIds.add(track.id);
        track.addEventListener(
            "ended",
            () => {
                screenShareTrackIds.delete(track.id);
            },
            { once: true }
        );
    }
}

export function isScreenShareVideoTrack(track: MediaStreamTrack) {
    if (screenShareTrackIds.has(track.id)) return true;

    try {
        const surface = String((track.getSettings?.() as any)?.displaySurface ?? "").toLowerCase();
        return DISPLAY_SURFACES.has(surface);
    } catch {
        return false;
    }
}

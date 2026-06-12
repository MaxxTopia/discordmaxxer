/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { MediaEngineStore } from "@vencord/types/webpack/common";

const logger = new Logger("VesktopStreamFixes");

function fixAudioTrackConstraints(constraint: MediaTrackConstraints) {
    // Legacy Chromium desktop-capture constraints use the non-standard
    // `mandatory`/`optional` (GoogConstraints) form — e.g. the per-window
    // screenshare audio swap in screenShareFixes.ts requests
    // `{ audio: { mandatory: { chromeMediaSource, chromeMediaSourceId } } }`.
    // Bolting a spec-style `autoGainControl` key alongside `mandatory` makes
    // Chromium reject the whole getUserMedia call (OverconstrainedError),
    // which then drops the stream's audio. Leave those constraints untouched.
    if ((constraint as any).mandatory || (constraint as any).optional) return;

    const target = constraint.advanced?.find(opt => Object.hasOwn(opt, "autoGainControl")) ?? constraint;

    target.autoGainControl = MediaEngineStore.getAutomaticGainControl();
}

function fixVideoTrackConstraints(constraint: MediaTrackConstraints) {
    if (typeof constraint.deviceId === "string" && constraint.deviceId !== "default") {
        constraint.deviceId = { exact: constraint.deviceId };
    }
}

function fixStreamConstraints(constraints: MediaStreamConstraints | undefined) {
    if (!constraints) return;

    if (constraints.audio) {
        if (typeof constraints.audio !== "object") {
            constraints.audio = {};
        }
        fixAudioTrackConstraints(constraints.audio);
    }

    if (constraints.video) {
        if (typeof constraints.video !== "object") {
            constraints.video = {};
        }
        fixVideoTrackConstraints(constraints.video);
    }
}

const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
navigator.mediaDevices.getUserMedia = function (constraints) {
    try {
        fixStreamConstraints(constraints);
    } catch (e) {
        logger.error("Failed to fix getUserMedia constraints", e);
    }
    return originalGetUserMedia.call(this, constraints);
};

const originalApplyConstraints = MediaStreamTrack.prototype.applyConstraints;
MediaStreamTrack.prototype.applyConstraints = function (constraints) {
    if (constraints) {
        try {
            if (this.kind === "audio") {
                fixAudioTrackConstraints(constraints);
            } else if (this.kind === "video") {
                fixVideoTrackConstraints(constraints);
            }
        } catch (e) {
            logger.error("Failed to fix constraints", e);
        }
    }
    return originalApplyConstraints.call(this, constraints);
};

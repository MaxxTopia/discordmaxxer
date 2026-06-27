/*
 * Discordmaxxer — in-app microphone noise suppression (RNNoise)
 * Copyright (c) 2026 Discordmaxxer contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * WHY THIS EXISTS:
 * Discord's built-in "Krisp" noise suppression is a NATIVE module
 * (discord_krisp) that only loads in the official native client — it cannot
 * run in a Vesktop-based client (which loads the web Discord app in Electron),
 * and its integrity check refuses modified clients. So a fork like this gets a
 * raw, un-suppressed mic vs official Discord.
 *
 * THE FIX (no external app, no native module): run the mic through RNNoise
 * (xiph's RNN noise-suppression model, compiled to WebAssembly) in an
 * AudioWorklet, and hand Discord the CLEANED MediaStreamTrack. Same approach
 * Jitsi Meet uses for browser noise removal. Quality: removes steady noise
 * (fans, hum, hiss, AC) well — clearly better than nothing, somewhat below
 * Krisp on bursty noise. DeepFilterNet is a future near-Krisp upgrade behind
 * the same interface.
 *
 * INTEGRATION: wraps navigator.mediaDevices.getUserMedia (composes with the
 * existing fixStreamConstraints wrapper). When the user has the feature on and
 * the request is a real microphone capture (not a desktop/loopback capture),
 * we splice the RNNoise graph onto the captured audio track and return a stream
 * carrying the cleaned track instead.
 *
 * SAFETY: any failure (worklet load, wasm instantiate, no track) falls back to
 * the ORIGINAL stream — the mic always works; worst case it's just un-filtered.
 * Toggle is OFF by default and read at capture time, so flipping it applies on
 * the next mic acquire (reconnect voice).
 */

import { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
// SIMD build — Chromium m134 (Electron 41) supports WASM SIMD. esbuild's
// "binary" loader bundles this inline as a Uint8Array (lands in the asar).
import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm";
// The worklet processor's source, inlined as text (rawPlugin). Registered from
// a Blob URL at runtime so we don't ship a separate .js asset.
import rnnoiseWorkletSrc from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw";

import { Logger } from "@vencord/types/utils";
import { Settings } from "renderer/settings";

const logger = new Logger("DMMicNoiseSuppression");

// RNNoise operates at 48kHz. Force the graph to 48kHz so the captured track is
// resampled into the model's expected rate (createMediaStreamSource resamples
// the input to the context rate automatically).
const RNNOISE_SAMPLE_RATE = 48000;

// Lazily-built, reused Blob URL for the worklet module source.
let workletBlobUrl: string | null = null;
function getWorkletBlobUrl(): string {
    if (!workletBlobUrl) {
        const blob = new Blob([rnnoiseWorkletSrc], { type: "text/javascript" });
        workletBlobUrl = URL.createObjectURL(blob);
    }
    return workletBlobUrl;
}

// A fresh ArrayBuffer copy of the wasm per worklet (the worklet may transfer /
// take ownership of the buffer it's handed).
function wasmBuffer(): ArrayBuffer {
    // esbuild's "binary" loader backs this with a plain ArrayBuffer.
    return (rnnoiseWasm.buffer as ArrayBuffer).slice(
        rnnoiseWasm.byteOffset,
        rnnoiseWasm.byteOffset + rnnoiseWasm.byteLength
    );
}

/**
 * Build an RNNoise processing graph for `inputStream`'s audio and return a new
 * stream whose audio track is the cleaned output. Throws on any failure so the
 * caller can fall back to the raw stream.
 */
async function applyRnnoise(inputStream: MediaStream): Promise<MediaStream> {
    const ctx = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE, latencyHint: "interactive" });
    try {
        await ctx.audioWorklet.addModule(getWorkletBlobUrl());

        const source = ctx.createMediaStreamSource(inputStream);
        const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasmBuffer() });
        const dest = ctx.createMediaStreamDestination();

        source.connect(rnnoise).connect(dest);

        const cleaned = dest.stream.getAudioTracks()[0];
        if (!cleaned) throw new Error("RNNoise destination produced no audio track");

        // Tear the whole graph down when Discord stops the mic track, so we
        // don't leak an AudioContext per voice session.
        const original = inputStream.getAudioTracks()[0];
        const teardown = () => {
            try {
                rnnoise.destroy();
            } catch { /* ok */ }
            try {
                source.disconnect();
            } catch { /* ok */ }
            ctx.close().catch(() => {});
            try {
                original?.stop();
            } catch { /* ok */ }
        };
        cleaned.addEventListener("ended", teardown);
        original?.addEventListener("ended", teardown);

        logger.info("RNNoise mic filter engaged");
        return new MediaStream([cleaned]);
    } catch (e) {
        await ctx.close().catch(() => {});
        throw e;
    }
}

// A real microphone request, as opposed to a desktop/loopback audio capture
// (those use the legacy GoogConstraints `mandatory`/`optional` shape that
// screenShareFixes / Discord use for screenshare audio — never filter those).
function isPlainMicRequest(constraints: MediaStreamConstraints | undefined): boolean {
    if (!constraints?.audio) return false;
    if (constraints.video) return false; // camera/screen capture, not a mic
    const audio = constraints.audio;
    if (typeof audio === "object" && ((audio as any).mandatory || (audio as any).optional)) return false;
    return true;
}

const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

// When RNNoise is engaged, disable the BROWSER's own noise suppression on the
// capture request so the two don't stack. Double-processing (Discord's
// "Standard" noise suppression on top of RNNoise) muddies the voice and adds
// artefacts — this is the "auto turn off the other one" so the user can't leave
// it fighting RNNoise by mistake. We deliberately leave echoCancellation alone
// (RNNoise has no echo canceller) and don't touch autoGainControl.
function withBrowserNoiseSuppressionOff(constraints: MediaStreamConstraints): MediaStreamConstraints {
    const audio = constraints.audio;
    const audioObj = typeof audio === "object" && audio ? { ...audio } : {};
    (audioObj as any).noiseSuppression = false;
    return { ...constraints, audio: audioObj };
}

navigator.mediaDevices.getUserMedia = async function (constraints) {
    const useRnnoise = Settings.store.micNoiseSuppression && isPlainMicRequest(constraints);
    if (!useRnnoise) return originalGetUserMedia(constraints);

    // Acquire with the browser's noise suppression off so RNNoise is the ONLY
    // suppressor. If the modified request is rejected for any reason, honour the
    // original constraints.
    let stream: MediaStream;
    try {
        stream = await originalGetUserMedia(withBrowserNoiseSuppressionOff(constraints as MediaStreamConstraints));
    } catch {
        return originalGetUserMedia(constraints);
    }
    if (!stream.getAudioTracks().length) return stream;

    try {
        return await applyRnnoise(stream);
    } catch (e) {
        // RNNoise failed — don't leave the user with NO suppression. Drop the
        // NS-off stream and re-acquire with Discord's original constraints so its
        // own (browser) noise suppression is back in play.
        logger.error("RNNoise filter failed; re-acquiring mic with original constraints", e);
        try {
            stream.getTracks().forEach(t => t.stop());
        } catch {
            /* ok */
        }
        return originalGetUserMedia(constraints);
    }
};

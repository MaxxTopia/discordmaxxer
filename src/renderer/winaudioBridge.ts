/*
 * Discordmaxxer — winaudio renderer bridge
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Glue layer that turns winaudio's per-output-device WASAPI loopback
 * (PCM chunks streamed via IPC) into a MediaStreamTrack we can feed into
 * Discord's outgoing screenshare audio sender.
 *
 * Pipeline:
 *   main winaudio.cc  →  IPC chunks (Buffer of interleaved float32 PCM)
 *   ↓
 *   AudioWorklet "pcm-feeder" (queues chunks, drains into output blocks)
 *   ↓
 *   AudioContext  →  MediaStreamAudioDestinationNode
 *   ↓
 *   MediaStreamTrack (audio)
 *   ↓
 *   RTCRtpSender.replaceTrack on Discord's outgoing screenshare audio
 *
 * The default Vesktop / Electron path is `streams.audio = "loopback"` →
 * Discord builds an audio sender from the SYSTEM DEFAULT output device's
 * loopback. We let that initial sender wire up, then swap its track for
 * our per-device-loopback track. Cleaner than monkey-patching getUserMedia.
 *
 * Cleanup wires off STREAM_CLOSE — same pattern as the Linux venmic stop
 * call already in ScreenSharePicker.tsx.
 */

interface CaptureFormat {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    isFloat: boolean;
}

interface ChunkMessage {
    data: Buffer;
    frameCount: number;
    timestamp100ns: string;
    silent: boolean;
}

// Inline AudioWorklet source — we register it via a Blob URL so we don't
// have to ship a separate .js file inside the asar (which complicates the
// addModule resolver). Worklet runs in the audio thread; queues incoming
// PCM and drains it into the per-render-quantum output buffer.
const WORKLET_SOURCE = `
class PCMFeeder extends AudioWorkletProcessor {
    constructor() {
        super();
        this._channels = 2;
        this._queue = [];     // FIFO of Float32Array chunks (interleaved samples)
        this._cursor = 0;     // position into _queue[0]
        this._sampleRate = sampleRate;
        this.port.onmessage = (e) => {
            const msg = e.data;
            if (msg && msg.type === "config") {
                this._channels = msg.channels | 0 || 2;
                return;
            }
            if (msg && msg.samples instanceof Float32Array) {
                this._queue.push(msg.samples);
                // Drop oldest chunks if queue grows beyond ~500ms backlog —
                // avoids ever-growing latency if the renderer momentarily
                // can't keep up. 500ms @ 48kHz stereo = 48000 samples.
                let queued = 0;
                for (const c of this._queue) queued += c.length;
                while (queued > 96000 && this._queue.length > 1) {
                    queued -= this._queue.shift().length;
                    this._cursor = 0;
                }
            }
        };
    }
    process(inputs, outputs) {
        const out = outputs[0];
        const numCh = out.length;
        const block = out[0].length;
        const interChans = this._channels;

        let written = 0;
        while (written < block && this._queue.length > 0) {
            const chunk = this._queue[0];
            const samplesAvailable = (chunk.length - this._cursor) / interChans | 0;
            const samplesNeeded = block - written;
            const n = Math.min(samplesAvailable, samplesNeeded);
            for (let i = 0; i < n; i++) {
                for (let c = 0; c < numCh; c++) {
                    // Map source channel to output channel (mono-fold or stereo passthrough).
                    const srcCh = c < interChans ? c : 0;
                    out[c][written + i] = chunk[this._cursor + i * interChans + srcCh];
                }
            }
            written += n;
            this._cursor += n * interChans;
            if (this._cursor >= chunk.length) {
                this._queue.shift();
                this._cursor = 0;
            }
        }
        // Pad with zeros if we ran dry — silence beats glitching.
        if (written < block) {
            for (let c = 0; c < numCh; c++) {
                for (let i = written; i < block; i++) out[c][i] = 0;
            }
        }
        return true;
    }
}
registerProcessor("dm-pcm-feeder", PCMFeeder);
`;

export interface WinAudioSession {
    /** Stop the WASAPI capture + tear down Web Audio. Idempotent. */
    stop(): Promise<void>;
    /** The audio MediaStreamTrack produced from the WASAPI capture. */
    track: MediaStreamTrack;
    /** Format of the underlying capture (for diagnostics / sample-rate info). */
    format: CaptureFormat;
    /**
     * Resolve true as soon as a real (non-silent) audio signal is observed
     * reaching the OUTPUT track within `ms`, else false. Measured at the
     * feeder output (post-worklet), so it catches every silent-track cause:
     * native capture returning silence, a suspended AudioContext that never
     * drains the worklet, or a broken IPC feed. Lets the caller fall back to
     * the audible system-loopback track instead of broadcasting silence.
     */
    waitForSignal(ms: number): Promise<boolean>;
    /**
     * Resolve true as soon as the AudioContext is RUNNING within `ms` (the
     * worklet is draining → the output track carries the exclude-self mix).
     * Does NOT require audible audio: WASAPI emits no packets during true
     * silence, so requiring them would wrongly fall back to the echoing
     * loopback on a quiet/loading Go-Live. A context that never resumes
     * (the real silent-track failure) returns false → caller falls back.
     * This is the keep-vs-fallback gate; waitForSignal stays for loudness.
     */
    waitUntilReady(ms: number): Promise<boolean>;
}

let activeSession: WinAudioSession | null = null;

/**
 * Start a winaudio per-output-device loopback capture + return a
 * MediaStreamTrack the caller can swap into Discord's outgoing audio
 * sender. Caller is responsible for calling session.stop() on
 * STREAM_CLOSE.
 */
export async function startWinAudioSession(deviceId: string): Promise<WinAudioSession> {
    return startSessionFromInit(() => VesktopNative.winAudio.start(deviceId));
}

/**
 * Start a winaudio process-loopback capture (Win10 1903+). Captures audio
 * FROM the target process tree. Use mode="include" to capture only that
 * app (typical: pick the game), or "exclude" to capture everything except
 * that app (typical: pick Discord to keep its playback out of the
 * stream — fixes audio-mixer echo).
 */
export async function startWinAudioProcessSession(
    targetPid: number,
    mode: "include" | "exclude"
): Promise<WinAudioSession> {
    return startSessionFromInit(() => VesktopNative.winAudio.startProcess(targetPid, mode));
}

/**
 * Start a winaudio process-loopback capture of the whole system mix MINUS
 * this app's own process tree. Used for full-screen shares / when we can't
 * pin down the shared window's owning app — captures all game/app audio while
 * keeping Discord's own voice playback out of the stream (no self-echo).
 */
export async function startWinAudioExcludeSelfSession(): Promise<WinAudioSession> {
    return startSessionFromInit(() => VesktopNative.winAudio.startExcludeSelf());
}

async function startSessionFromInit(
    init: () => Promise<{ ok: true; format: CaptureFormat } | { ok: false; error: string }>
): Promise<WinAudioSession> {
    if (activeSession) {
        // Defensive — Discord screenshares are one-at-a-time; if a prior
        // session leaked, tear it down now rather than refusing.
        await activeSession.stop();
        activeSession = null;
    }

    const startResult = await init();
    if (!startResult.ok) {
        throw new Error("winaudio start failed: " + startResult.error);
    }
    const format = startResult.format;

    // Build the Web Audio graph at the WASAPI device's native sample rate
    // so we don't introduce resampling on our side. AudioContext will
    // resample to the destination sink rate (Discord's PeerConnection)
    // automatically if it differs.
    const ctx = new AudioContext({ sampleRate: format.sampleRate, latencyHint: "interactive" });
    const blob = new Blob([WORKLET_SOURCE], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    try {
        await ctx.audioWorklet.addModule(blobUrl);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }

    const feeder = new AudioWorkletNode(ctx, "dm-pcm-feeder", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [Math.max(format.channels, 2)]
    });
    feeder.port.postMessage({ type: "config", channels: format.channels });

    const dest = ctx.createMediaStreamDestination();
    feeder.connect(dest);

    // Tap the feeder output with an analyser so we can verify real audio is
    // actually reaching the destination track (not just arriving over IPC).
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    feeder.connect(analyser);

    // A freshly constructed AudioContext can start in the "suspended" state
    // (browser/Electron autoplay gating). While suspended the worklet's
    // process() is NEVER called, so the destination track is silent even
    // though PCM keeps streaming in over IPC — this was the "winaudio injected
    // but viewers hear nothing" bug. Resume explicitly; the app already sets
    // autoplay-policy=no-user-gesture-required so this is allowed.
    await ctx.resume().catch(() => {});

    // Subscribe to PCM chunks from the main process. winaudio.cc emits
    // interleaved float32 (typical Win10/11 mix format) — confirmed via
    // the format probe at startCapture time. If the rig is on a non-float
    // mix format (rare; some old WDM drivers), we drop chunks for now —
    // future revision could convert int16 → float32 here.
    const offChunk = VesktopNative.winAudio.onChunk((chunk: ChunkMessage) => {
        if (chunk.silent || !chunk.data || chunk.data.length === 0) return;
        if (!format.isFloat) {
            // TODO: int16 / int24 conversion path — modern Windows rarely needs this.
            return;
        }
        const buf = chunk.data;
        // Build a Float32Array view backed by the chunk's bytes. Buffer is
        // a Uint8Array subclass; .buffer/.byteOffset are compatible.
        const samples = new Float32Array(
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        );
        feeder.port.postMessage({ samples }, [samples.buffer]);
    });

    const audioTracks = dest.stream.getAudioTracks();
    if (!audioTracks.length) {
        // Web Audio failed to produce a track somehow — bail.
        offChunk();
        await ctx.close().catch(() => {});
        await VesktopNative.winAudio.stop();
        throw new Error("MediaStreamAudioDestinationNode produced no audio track");
    }
    const track = audioTracks[0];

    const session: WinAudioSession = {
        track,
        format,
        async waitForSignal(ms: number): Promise<boolean> {
            const buf = new Float32Array(analyser.fftSize);
            const deadline = Date.now() + ms;
            // ~0.0005 peak ignores dither/denormal noise but catches any real
            // program audio. Poll every 100ms until signal or timeout.
            while (Date.now() < deadline) {
                analyser.getFloatTimeDomainData(buf);
                let peak = 0;
                for (let i = 0; i < buf.length; i++) {
                    const a = Math.abs(buf[i]);
                    if (a > peak) peak = a;
                }
                if (peak > 0.0005) return true;
                await new Promise(r => setTimeout(r, 100));
            }
            return false;
        },
        async waitUntilReady(ms: number): Promise<boolean> {
            // Ready = the AudioContext is RUNNING (worklet is draining). That's
            // the only thing that matters for echo-safety: a running context
            // outputs the exclude-self mix — game audio when it plays, silence
            // when the game is quiet — and NEVER Discord's own voice. We do NOT
            // require audible chunks: WASAPI delivers no packets during true
            // silence, so requiring them would wrongly fall back to the echoing
            // loopback whenever you go live during a quiet/loading moment. A
            // suspended context (the real silent-track failure) returns false
            // here and correctly falls back. ctx.resume() already ran; this
            // mostly returns immediately.
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                if (ctx.state === "running") return true;
                await ctx.resume().catch(() => {});
                await new Promise(r => setTimeout(r, 50));
            }
            return false;
        },
        async stop() {
            offChunk();
            try {
                feeder.disconnect();
            } catch { /* ok */ }
            try {
                analyser.disconnect();
            } catch { /* ok */ }
            try {
                await ctx.close();
            } catch { /* ok */ }
            try {
                await VesktopNative.winAudio.stop();
            } catch { /* ok */ }
            if (activeSession === session) activeSession = null;
        }
    };
    activeSession = session;
    return session;
}

/**
 * Walk Discord's media engine to find the outgoing screenshare's audio
 * RTCRtpSender + replace its track with `newTrack`. Returns true on
 * success; false if no sender was found (e.g., screenshare hadn't fully
 * negotiated yet, or it's video-only).
 *
 * Discord's wrapper hides the underlying RTCPeerConnection behind various
 * keys depending on the version. We try the documented `connection.pc`
 * path first, fall back to scanning `connection` for any RTCPeerConnection.
 */
export async function replaceScreenShareAudioTrack(
    streamUserId: string,
    newTrack: MediaStreamTrack
): Promise<boolean> {
    // MediaEngineStore is a Vencord/Discord-internal store; we access via
    // global Vencord webpack. The renderer-side patches in ScreenSharePicker
    // already use this same path.
    const w = (globalThis as any).Vencord;
    const MediaEngineStore = w?.Webpack?.Common?.MediaEngineStore
        ?? w?.WebpackCommon?.MediaEngineStore;
    if (!MediaEngineStore) {
        console.warn("[winaudio] MediaEngineStore not found via Vencord webpack");
        return false;
    }
    const engine = MediaEngineStore.getMediaEngine?.();
    if (!engine) {
        console.warn("[winaudio] mediaEngine null");
        return false;
    }
    const conn = [...(engine.connections ?? [])].find(
        (c: any) => c?.streamUserId === streamUserId
    );
    if (!conn) {
        console.warn("[winaudio] no connection for streamUserId", streamUserId);
        return false;
    }
    // Try documented path first, fall back to BFS search.
    const pc: RTCPeerConnection | undefined = conn.pc ?? conn.connection?.pc ?? findPC(conn);
    if (!pc || typeof pc.getSenders !== "function") {
        console.warn("[winaudio] no RTCPeerConnection on connection — Discord wrapper changed?");
        return false;
    }
    const audioSender = pc.getSenders().find(s => s.track?.kind === "audio");
    if (!audioSender) {
        console.warn("[winaudio] no audio sender on screenshare PC");
        return false;
    }
    try {
        await audioSender.replaceTrack(newTrack);
        console.log("[winaudio] audio track replaced — winaudio capture is live");
        return true;
    } catch (e) {
        console.warn("[winaudio] replaceTrack failed:", e);
        return false;
    }
}

// Bounded BFS through a Discord connection wrapper looking for an
// RTCPeerConnection. Caps depth to avoid traversing huge object graphs.
function findPC(root: any, depth = 0, seen = new Set<any>()): RTCPeerConnection | undefined {
    if (!root || typeof root !== "object" || depth > 4 || seen.has(root)) return undefined;
    seen.add(root);
    if (root instanceof RTCPeerConnection) return root;
    for (const key of Object.keys(root)) {
        try {
            const v = (root as any)[key];
            if (v instanceof RTCPeerConnection) return v;
            if (v && typeof v === "object") {
                const found = findPC(v, depth + 1, seen);
                if (found) return found;
            }
        } catch { /* getters can throw, skip */ }
    }
    return undefined;
}

export function getActiveWinAudioSession(): WinAudioSession | null {
    return activeSession;
}

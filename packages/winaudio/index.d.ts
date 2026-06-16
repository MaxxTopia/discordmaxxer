/**
 * winaudio — WASAPI loopback capture for Windows.
 *
 * Per-output-device loopback that fixes Discord screenshare audio for users
 * with Voicemeeter / VB-Cable / EqualizerAPO routing. Lets the screenshare
 * picker capture from a SPECIFIC output endpoint rather than whatever
 * Windows says is the system default.
 */

export interface OutputDevice {
    /** WASAPI endpoint ID, e.g. `{0.0.0.00000000}.{guid}`. Stable across reboots. */
    id: string;
    /** Friendly name, e.g. "Headphones (Realtek HD Audio)". */
    name: string;
    /** True for whatever Windows currently considers the default render device. */
    isDefault: boolean;
}

export interface CaptureFormat {
    /** Sample rate in Hz, typically 48000. */
    sampleRate: number;
    /** Channel count, typically 2 (stereo). */
    channels: number;
    /** Bits per sample. 32 = float (most common on modern Win10/11), 16 = int. */
    bitsPerSample: number;
    /** True if PCM samples are IEEE 754 float (subtype is FLOAT/SUBTYPE_IEEE_FLOAT). */
    isFloat: boolean;
}

export interface AudioChunk {
    /**
     * Interleaved PCM frames. Decode based on the CaptureFormat you got back
     * from `startCapture`:
     *   - isFloat=true, bitsPerSample=32 → Float32Array.from(buf)
     *   - isFloat=false, bitsPerSample=16 → Int16Array
     */
    data: Buffer;
    /** Number of audio frames in this chunk (frame = sample × channels). */
    frameCount: number;
    /** WASAPI device timestamp in 100-ns units. Useful for sync, not required. */
    timestamp100ns: bigint;
    /**
     * True if this chunk represents a silence period that WASAPI inserted
     * (e.g. no upstream apps producing audio). Caller can either render
     * silence or skip the chunk.
     */
    silent: boolean;
}

export interface ListDevicesResult {
    devices: OutputDevice[];
}

/** Enumerate all active audio render endpoints. Synchronous, fast. */
export function listOutputDevices(): ListDevicesResult;

/**
 * Start loopback capture from the named device. Spawns a WASAPI capture
 * thread that emits audio chunks to `onChunk` via N-API thread-safe
 * function. Returns the capture format synchronously (or throws).
 *
 * Only one capture can be active at a time — calling startCapture while
 * another is running throws. Stop the previous one first.
 *
 * @param deviceId  Endpoint ID from `listOutputDevices()`.
 * @param onChunk   Called from the JS event loop for each audio packet.
 *                  Do NOT block — return immediately.
 */
export function startCapture(
    deviceId: string,
    onChunk: (chunk: AudioChunk) => void,
): CaptureFormat;

/**
 * Stop the active capture. Blocks until the capture thread exits cleanly
 * (typically <50ms). Safe to call when nothing is capturing — no-op.
 */
export function stopCapture(): void;

/** True if a capture is currently active. */
export function isCapturing(): boolean;

export interface AudioSession {
    /** Process ID (Windows DWORD). 0 is filtered out (system sounds). */
    pid: number;
    /** Best-effort exe basename, e.g. "FortniteClient-Win64-Shipping.exe".
     *  Empty if OpenProcess access was denied (e.g., elevated processes
     *  while running unelevated). */
    processName: string;
    /** Session display name set by the app (often empty). */
    displayName: string;
    /** True if the session is currently producing audio (vs idle). */
    isActive: boolean;
}

export interface ListSessionsResult {
    sessions: AudioSession[];
}

/**
 * Enumerate active audio sessions across all render endpoints. Useful for
 * populating an "app picker" UI for process-loopback capture. Returns
 * deduped-by-pid list (an app with N streams shows once).
 *
 * Returns an empty list if no app currently has an open audio session —
 * tell users to start playing audio first.
 */
export function enumerateAudioSessions(): ListSessionsResult;

export type ProcessLoopbackMode = "include" | "exclude";

/**
 * Start a Process Loopback capture (Win10 1903+). Captures audio FROM a
 * specific process tree, regardless of which output device that process's
 * audio routes to. Solves the audio-mixer echo problem: the streamer's
 * Voicemeeter / VB-Cable routing is bypassed because we're not capturing
 * the system output — we're capturing the source app directly.
 *
 * mode = "include": capture only from the target process tree (e.g.,
 *   pid = Fortnite → captures only Fortnite audio).
 * mode = "exclude": capture everything EXCEPT the target process tree
 *   (e.g., pid = Discord → captures everything except Discord's playback).
 *
 * Format is fixed at float32 stereo @ 48kHz (what Process Loopback API
 * accepts; matches our renderer AudioWorklet).
 *
 * Throws if Win10 < 1903 or the API is unavailable.
 */
export function startProcessLoopback(
    targetPid: number,
    mode: ProcessLoopbackMode,
    onChunk: (chunk: AudioChunk) => void,
): CaptureFormat;

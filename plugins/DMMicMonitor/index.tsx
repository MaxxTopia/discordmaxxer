/*
 * Discordmaxxer - outgoing microphone boost, processed preview and level monitor
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The outgoing path is deliberately opt-in. When enabled, only microphone
 * streams returned by getUserMedia are processed; getDisplayMedia and screen
 * share audio are never intercepted. A limiter protects voice from hard
 * clipping, but it cannot repair a microphone that is already clipping.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, Toasts as DiscordToasts } from "@webpack/common";

import { showDiscordmaxxerStatusToast } from "../_dm-shared/statusToast";

const Toasts = { ...DiscordToasts, show: showDiscordmaxxerStatusToast };

type MonitorState = "off" | "starting" | "running" | "error";

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

interface OutgoingGraph {
    context: AudioContext;
    input: MediaStream;
    output: MediaStream;
    gain: GainNode;
    compressor: DynamicsCompressorNode;
    analyser: AnalyserNode;
    closed: boolean;
}

let monitorRun = 0;
let monitorState: MonitorState = "off";
let monitorError = "";
let monitorLevel = 0;
let monitorContext: AudioContext | null = null;
let monitorStream: MediaStream | null = null;
let monitorSource: MediaStreamAudioSourceNode | null = null;
let monitorGain: GainNode | null = null;
let monitorDryGain: GainNode | null = null;
let monitorOutgoingGain: GainNode | null = null;
let monitorOutgoingCompressor: DynamicsCompressorNode | null = null;
let monitorProcessedGain: GainNode | null = null;
let monitorAnalyser: AnalyserNode | null = null;
let monitorFrame: number | null = null;
let monitorBuffer: Float32Array | null = null;

let originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia | null = null;
let outgoingGraphs = new Set<OutgoingGraph>();
let outgoingCleanupTimer: number | null = null;
let bypassOutgoingProcessing = false;
const monitorListeners = new Set<() => void>();

function notifyMonitorListeners() {
    for (const listener of monitorListeners) listener();
}

function setMonitorState(state: MonitorState, error = "") {
    monitorState = state;
    monitorError = error;
    notifyMonitorListeners();
}

function setMonitorLevel(level: number) {
    monitorLevel = Math.max(0, Math.min(1, level));
    notifyMonitorListeners();
}

function numberSetting(name: string, fallback: number, min: number, max: number) {
    const value = Number((settings.store as any)[name]);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function monitorGainValue(): number {
    return numberSetting("monitorGain", 1, 0.5, 3);
}

function outgoingGainValue(): number {
    return numberSetting("outgoingBoost", 1.25, 1, 2.5);
}

function outgoingBoostEnabled(): boolean {
    return (settings.store as any).outgoingBoostEnabled === true;
}

function audioContextConstructor(): AudioContextConstructor | null {
    return (window.AudioContext ?? (window as any).webkitAudioContext) as AudioContextConstructor | null;
}

function calculateLevel(analyser: AnalyserNode, buffer: Float32Array) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    let peak = 0;
    for (const sample of buffer) {
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / buffer.length);
    return Math.min(1, Math.max(rms * 4, peak * 0.7));
}

function configureVoiceCompressor(compressor: DynamicsCompressorNode) {
    // A conservative limiter keeps a 1-2.5x boost from producing harsh digital
    // clipping. Discord's own voice processing remains in the capture chain.
    compressor.threshold.value = -6;
    compressor.knee.value = 10;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;
}

function releaseGraph(graph: OutgoingGraph, stopInput = true) {
    if (graph.closed) return;
    graph.closed = true;
    outgoingGraphs.delete(graph);
    graph.analyser.disconnect();
    graph.compressor.disconnect();
    graph.gain.disconnect();
    try {
        // The output keeps the caller's video tracks. Stopping every input
        // track here would unexpectedly turn off a webcam when the voice
        // capture graph is released; only retire the audio source we own.
        if (stopInput) graph.input.getAudioTracks().forEach(track => track.stop());
    } catch {}
    if (graph.context.state !== "closed") void graph.context.close().catch(() => undefined);
}

function cleanupOutgoingGraphs() {
    for (const graph of outgoingGraphs) {
        if (graph.closed || graph.output.getAudioTracks().every(track => track.readyState === "ended") || graph.input.getTracks().every(track => track.readyState === "ended")) {
            releaseGraph(graph);
        }
    }
    if (outgoingGraphs.size === 0 && outgoingCleanupTimer !== null) {
        window.clearInterval(outgoingCleanupTimer);
        outgoingCleanupTimer = null;
    }
}

function ensureOutgoingCleanupTimer() {
    if (outgoingCleanupTimer === null) outgoingCleanupTimer = window.setInterval(cleanupOutgoingGraphs, 5000);
}

function updateOutgoingGraphGain() {
    const target = outgoingBoostEnabled() ? outgoingGainValue() : 1;
    for (const graph of outgoingGraphs) {
        if (graph.closed) continue;
        graph.gain.gain.setTargetAtTime(target, graph.context.currentTime, 0.03);
    }
}

async function createOutgoingGraph(input: MediaStream): Promise<MediaStream> {
    const Constructor = audioContextConstructor();
    const audioTracks = input.getAudioTracks();
    if (!Constructor || audioTracks.length === 0 || !outgoingBoostEnabled()) return input;

    try {
        const context = new Constructor({ latencyHint: "interactive" });
        const source = context.createMediaStreamSource(new MediaStream(audioTracks));
        const gain = context.createGain();
        const compressor = context.createDynamicsCompressor();
        const analyser = context.createAnalyser();
        const destination = context.createMediaStreamDestination();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.72;
        gain.gain.setValueAtTime(outgoingGainValue(), context.currentTime);
        configureVoiceCompressor(compressor);

        source.connect(gain);
        gain.connect(compressor);
        compressor.connect(analyser);
        analyser.connect(destination);

        const output = new MediaStream([
            ...input.getVideoTracks(),
            ...destination.stream.getAudioTracks()
        ]);
        const graph: OutgoingGraph = { context, input, output, gain, compressor, analyser, closed: false };
        outgoingGraphs.add(graph);
        ensureOutgoingCleanupTimer();
        try {
            await context.resume();
            if (context.state !== "running") throw new Error(`Audio context is ${context.state}`);
        } catch (error) {
            // Autoplay policy can refuse a new AudioContext outside a user
            // gesture. Never hand Discord a suspended destination (which can
            // look like a dead microphone); restore the native stream instead.
            releaseGraph(graph, false);
            console.warn("[DMMicMonitor] outgoing boost unavailable; using Discord's native stream", error);
            return input;
        }

        for (const track of input.getAudioTracks()) {
            track.addEventListener("ended", () => releaseGraph(graph), { once: true });
        }
        return output;
    } catch (error) {
        console.warn("[DMMicMonitor] outgoing microphone boost could not start; using Discord's native stream", error);
        return input;
    }
}

function installOutgoingCapture() {
    if (originalGetUserMedia || !navigator.mediaDevices?.getUserMedia) return;
    originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const nativeGetUserMedia = originalGetUserMedia;
    navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await nativeGetUserMedia(constraints);
        if (bypassOutgoingProcessing || (globalThis as any).__dmScreenShareAudioCapture === true || !constraints?.audio || !outgoingBoostEnabled()) return stream;
        return createOutgoingGraph(stream);
    };
}

function uninstallOutgoingCapture() {
    if (originalGetUserMedia && navigator.mediaDevices) navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    originalGetUserMedia = null;
    for (const graph of outgoingGraphs) releaseGraph(graph);
    if (outgoingCleanupTimer !== null) {
        window.clearInterval(outgoingCleanupTimer);
        outgoingCleanupTimer = null;
    }
}

function releaseAudioGraph() {
    if (monitorFrame !== null) {
        window.cancelAnimationFrame(monitorFrame);
        monitorFrame = null;
    }
    monitorBuffer = null;
    monitorAnalyser?.disconnect();
    monitorProcessedGain?.disconnect();
    monitorOutgoingCompressor?.disconnect();
    monitorOutgoingGain?.disconnect();
    monitorDryGain?.disconnect();
    monitorGain?.disconnect();
    monitorSource?.disconnect();
    monitorAnalyser = null;
    monitorProcessedGain = null;
    monitorOutgoingCompressor = null;
    monitorOutgoingGain = null;
    monitorDryGain = null;
    monitorGain = null;
    monitorSource = null;
    for (const track of monitorStream?.getTracks() ?? []) track.stop();
    monitorStream = null;
    const context = monitorContext;
    monitorContext = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
}

function stopMonitor() {
    monitorRun += 1;
    releaseAudioGraph();
    setMonitorLevel(0);
    setMonitorState("off");
}

function startMeter(run: number) {
    const analyser = monitorAnalyser;
    const buffer = monitorBuffer;
    if (!analyser || !buffer) return;

    const tick = () => {
        if (run !== monitorRun || monitorAnalyser !== analyser) return;
        setMonitorLevel(calculateLevel(analyser, buffer));
        monitorFrame = window.requestAnimationFrame(tick);
    };

    tick();
}

async function startMonitor() {
    stopMonitor();
    const run = monitorRun;
    setMonitorState("starting");

    try {
        if (!originalGetUserMedia) throw new Error("Microphone capture is not ready yet.");
        const Constructor = audioContextConstructor();
        if (!Constructor) throw new Error("This client does not expose an audio monitor.");

        // This is the optional local sidetone capture. Bypass the outgoing
        // wrapper so the monitor does not recursively create a second graph.
        bypassOutgoingProcessing = true;
        let stream: MediaStream;
        try {
            stream = await originalGetUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: false
                }
            });
        } finally {
            bypassOutgoingProcessing = false;
        }
        if (run !== monitorRun || !(settings.store as any).monitorEnabled) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        const context = new Constructor({ latencyHint: "interactive" });
        await context.resume().catch(() => undefined);
        const source = context.createMediaStreamSource(stream);
        // Keep a dry path and a processed path so the monitor auditions the
        // same boost/limiter stage used by the outgoing wrapper. The final
        // monitor gain below is only a local listening-volume control; Discord
        // may add its own voice processing after this stage.
        const outgoingPreviewGain = context.createGain();
        const outgoingPreviewCompressor = context.createDynamicsCompressor();
        const dryGain = context.createGain();
        const processedGain = context.createGain();
        const gain = context.createGain();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.72;
        const boostEnabled = outgoingBoostEnabled();
        outgoingPreviewGain.gain.setValueAtTime(boostEnabled ? outgoingGainValue() : 1, context.currentTime);
        dryGain.gain.setValueAtTime(boostEnabled ? 0 : 1, context.currentTime);
        processedGain.gain.setValueAtTime(boostEnabled ? 1 : 0, context.currentTime);
        configureVoiceCompressor(outgoingPreviewCompressor);
        gain.gain.setValueAtTime(monitorGainValue(), context.currentTime);

        source.connect(dryGain);
        dryGain.connect(analyser);
        source.connect(outgoingPreviewGain);
        outgoingPreviewGain.connect(outgoingPreviewCompressor);
        outgoingPreviewCompressor.connect(processedGain);
        processedGain.connect(analyser);
        // Meter the processed outgoing signal before the local listening
        // volume. Changing monitor gain must not make the outgoing meter lie.
        analyser.connect(gain);
        gain.connect(context.destination);
        monitorContext = context;
        monitorStream = stream;
        monitorSource = source;
        monitorGain = gain;
        monitorDryGain = dryGain;
        monitorOutgoingGain = outgoingPreviewGain;
        monitorOutgoingCompressor = outgoingPreviewCompressor;
        monitorProcessedGain = processedGain;
        monitorAnalyser = analyser;
        monitorBuffer = new Float32Array(analyser.fftSize);
        setMonitorState("running");
        startMeter(run);
        Toasts.show({
            message: outgoingBoostEnabled()
                ? "🎙️ Mic monitor enabled — previewing the boosted outgoing signal; monitor gain is local only"
                : "🎙️ Mic monitor enabled — previewing the mic signal; monitor gain is local only",
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 2200, position: Toasts.Position.TOP }
        });
    } catch (error) {
        releaseAudioGraph();
        if (run !== monitorRun) return;
        const message = error instanceof Error ? error.message : "Microphone permission was denied.";
        setMonitorState("error", message);
        Toasts.show({
            message: `🎙️ Mic monitor could not start: ${message}`,
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: { duration: 2600, position: Toasts.Position.TOP }
        });
    }
}

function onMonitorEnabledChange(enabled: boolean) {
    if (enabled) void startMonitor();
    else stopMonitor();
}

function onMonitorGainChange(value: number) {
    if (monitorGain && monitorContext) monitorGain.gain.setTargetAtTime(value, monitorContext.currentTime, 0.02);
}

function onOutgoingBoostChange() {
    updateOutgoingGraphGain();
    if (monitorOutgoingGain && monitorDryGain && monitorProcessedGain && monitorContext) {
        const enabled = outgoingBoostEnabled();
        monitorOutgoingGain.gain.setTargetAtTime(
            enabled ? outgoingGainValue() : 1,
            monitorContext.currentTime,
            0.015,
        );
        monitorDryGain.gain.setTargetAtTime(enabled ? 0 : 1, monitorContext.currentTime, 0.015);
        monitorProcessedGain.gain.setTargetAtTime(enabled ? 1 : 0, monitorContext.currentTime, 0.015);
    }
    Toasts.show({
        message: outgoingBoostEnabled()
            ? "🎙️ Outgoing mic boost changed — active voice uses it now; reconnect voice if needed"
            : "🎙️ Outgoing mic boost disabled",
        type: Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: { duration: 2200, position: Toasts.Position.TOP }
    });
}

function MicMonitorShowroom() {
    const [, forceRender] = React.useState(0);
    const live = settings.use(["outgoingBoostEnabled", "outgoingBoost", "monitorEnabled", "monitorGain", "showMeter"]);

    React.useEffect(() => {
        const update = () => forceRender(value => value + 1);
        monitorListeners.add(update);
        return () => monitorListeners.delete(update);
    }, []);

    const boostEnabled = live.outgoingBoostEnabled === true;
    const boost = Number(live.outgoingBoost ?? 1.25);
    const monitorGain = Number(live.monitorGain ?? 1);
    const stateLabel = monitorState === "running"
        ? "Running"
        : monitorState === "starting"
            ? "Requesting microphone permission..."
            : monitorState === "error"
                ? `Could not start: ${monitorError}`
                : "Off until you enable the monitor";
    const meterWidth = `${Math.round(monitorLevel * 100)}%`;

    return React.createElement("div", {
        style: {
            display: "grid",
            gap: 10,
            padding: 12,
            borderRadius: 10,
            border: "1px solid rgba(96, 220, 255, .34)",
            background: "linear-gradient(135deg, rgba(19, 28, 45, .96), rgba(20, 55, 64, .82))",
            color: "#effcff"
        }
    },
    React.createElement("div", { style: { fontWeight: 800, fontSize: 13 } }, "🎙️ Microphone boost + sidetone monitor"),
    React.createElement("div", { style: { fontSize: 11, lineHeight: 1.45, color: "#bfeef4" } },
        "Outgoing boost changes the microphone track Discord sends to other people. When the monitor is enabled, it previews that boosted signal automatically; monitor gain only changes your local listening volume. Discord may apply additional voice processing. Screen-share audio is not intercepted. Use headphones to prevent feedback."),
    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11 } },
        React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: boostEnabled ? "#4cf78a" : "#778399" } }),
        React.createElement("span", null, boostEnabled ? "Outgoing boost enabled" : "Outgoing boost off"),
        React.createElement("span", { style: { marginLeft: "auto", color: "#ffe28a", fontWeight: 700 } }, `${boost.toFixed(2)}x outgoing`)),
    React.createElement("div", { style: { fontSize: 10, color: "#9fb3c2" } }, "If you change this while already in a call, reconnect voice so Discord requests a fresh microphone stream."),
    React.createElement("div", { style: { fontSize: 10, color: boostEnabled ? "#ffe28a" : "#9fb3c2" } },
        boostEnabled ? "Monitor preview: boosted outgoing signal (approximate before Discord processing)" : "Monitor preview: microphone signal (outgoing boost is off)"),
    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11 } },
        React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: monitorState === "running" ? "#4cf78a" : monitorState === "error" ? "#ff6b83" : "#778399" } }),
        React.createElement("span", null, stateLabel),
        React.createElement("span", { style: { marginLeft: "auto", color: "#ffe28a", fontWeight: 700 } }, `${monitorGain.toFixed(1)}x local volume`)),
    live.showMeter !== false && React.createElement("div", null,
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 10, color: "#bfeef4", marginBottom: 4 } },
            React.createElement("span", null, "Outgoing preview level"),
            React.createElement("span", null, `${Math.round(monitorLevel * 100)}%`)),
        React.createElement("div", { style: { height: 9, borderRadius: 999, overflow: "hidden", background: "rgba(0,0,0,.38)", border: "1px solid rgba(255,255,255,.12)" } },
            React.createElement("div", { style: { width: meterWidth, height: "100%", borderRadius: 999, background: "linear-gradient(90deg, #48e0c2, #f7e36e 72%, #ff6b83)", transition: "width 80ms linear" } }))));
}

const settings = definePluginSettings({
    showroom: {
        type: OptionType.COMPONENT,
        description: "",
        component: MicMonitorShowroom
    },
    outgoingBoostEnabled: {
        type: OptionType.BOOLEAN,
        description: "Boost the microphone track sent to other people. Applies only to Discord microphone capture, never screen-share audio. Reconnect voice after enabling if already in a call.",
        default: false,
        onChange: onOutgoingBoostChange
    },
    outgoingBoost: {
        type: OptionType.SLIDER,
        description: "Outgoing microphone multiplier. Start at 1.25x and ask a recipient to check for clarity before using more.",
        markers: [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5],
        default: 1.25,
        stickToMarkers: false,
        onChange: onOutgoingBoostChange
    },
    monitorEnabled: {
        type: OptionType.BOOLEAN,
        description: "Hear the microphone locally. When outgoing boost is enabled, the monitor previews the boosted outgoing signal automatically. Off by default; headphones are recommended to avoid feedback.",
        default: false,
        onChange: onMonitorEnabledChange
    },
    monitorGain: {
        type: OptionType.SLIDER,
        description: "Local listening volume only. It does not change what other people receive, and it does not change the outgoing preview meter.",
        markers: [0.5, 1, 1.5, 2, 2.5, 3],
        default: 1,
        stickToMarkers: false,
        onChange: onMonitorGainChange
    },
    showMeter: {
        type: OptionType.BOOLEAN,
        description: "Show the outgoing-signal preview meter before local monitor volume is applied.",
        default: true
    }
});

export default definePlugin({
    name: "DMMicMonitor",
    description: "🎙️ Optional outgoing microphone boost plus processed local preview and level meter. Boost is limited and screen-share audio is left untouched.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        installOutgoingCapture();
        if ((settings.store.monitorEnabled as boolean)) void startMonitor();
    },

    stop() {
        stopMonitor();
        uninstallOutgoingCapture();
    }
});

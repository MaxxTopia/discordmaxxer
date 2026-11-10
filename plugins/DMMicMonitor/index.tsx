/*
 * Discordmaxxer - microphone sidetone and level monitor
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This is deliberately a local monitor. It never replaces Discord's
 * outgoing MediaStream, so changing the monitor gain cannot unexpectedly
 * change what other people hear. It is off by default and is intended for
 * headphones to avoid acoustic feedback.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, Toasts as DiscordToasts } from "@webpack/common";

import { showDiscordmaxxerStatusToast } from "../_dm-shared/statusToast";

const Toasts = { ...DiscordToasts, show: showDiscordmaxxerStatusToast };

type MonitorState = "off" | "starting" | "running" | "error";

let monitorRun = 0;
let monitorState: MonitorState = "off";
let monitorError = "";
let monitorLevel = 0;
let monitorContext: AudioContext | null = null;
let monitorStream: MediaStream | null = null;
let monitorSource: MediaStreamAudioSourceNode | null = null;
let monitorGain: GainNode | null = null;
let monitorCompressor: DynamicsCompressorNode | null = null;
let monitorAnalyser: AnalyserNode | null = null;
let monitorFrame: number | null = null;
let monitorBuffer: Float32Array | null = null;
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

function monitorGainValue(): number {
    const value = Number((settings.store as any).monitorGain);
    return Number.isFinite(value) ? Math.max(0.5, Math.min(3, value)) : 1;
}

function releaseAudioGraph() {
    if (monitorFrame !== null) {
        window.cancelAnimationFrame(monitorFrame);
        monitorFrame = null;
    }
    monitorBuffer = null;
    monitorAnalyser?.disconnect();
    monitorCompressor?.disconnect();
    monitorGain?.disconnect();
    monitorSource?.disconnect();
    monitorAnalyser = null;
    monitorCompressor = null;
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
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        let peak = 0;
        for (const sample of buffer) {
            sum += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
        }
        const rms = Math.sqrt(sum / buffer.length);
        // A combined RMS/peak display is easier to read for normal speech
        // than a raw waveform amplitude and still reacts to loud peaks.
        setMonitorLevel(Math.min(1, Math.max(rms * 4, peak * 0.7)));
        monitorFrame = window.requestAnimationFrame(tick);
    };

    tick();
}

async function startMonitor() {
    stopMonitor();
    const run = monitorRun;
    setMonitorState("starting");

    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This client does not expose microphone capture.");
        const AudioContextCtor = window.AudioContext ?? (window as any).webkitAudioContext;
        if (!AudioContextCtor) throw new Error("This client does not expose an audio monitor.");

        // Echo cancellation and noise suppression protect speakers if a user
        // accidentally enables this without headphones. Headphones are still
        // strongly recommended. Discord's own outgoing stream is untouched.
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: false
            }
        });
        if (run !== monitorRun || !(settings.store as any).monitorEnabled) {
            for (const track of stream.getTracks()) track.stop();
            return;
        }

        const context: AudioContext = new AudioContextCtor();
        await context.resume().catch(() => undefined);
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        const compressor = context.createDynamicsCompressor();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.72;
        gain.gain.setValueAtTime(monitorGainValue(), context.currentTime);
        compressor.threshold.value = -7;
        compressor.knee.value = 12;
        compressor.ratio.value = 8;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.18;

        source.connect(gain);
        gain.connect(compressor);
        compressor.connect(analyser);
        analyser.connect(context.destination);
        monitorContext = context;
        monitorStream = stream;
        monitorSource = source;
        monitorGain = gain;
        monitorCompressor = compressor;
        monitorAnalyser = analyser;
        monitorBuffer = new Float32Array(analyser.fftSize);
        setMonitorState("running");
        startMeter(run);
        Toasts.show({
            message: "🎙️ Mic monitor enabled — headphones recommended; outgoing Discord mic unchanged",
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
    if (monitorGain && monitorContext) {
        monitorGain.gain.setTargetAtTime(value, monitorContext.currentTime, 0.02);
    }
}

function MicMonitorShowroom() {
    const [, forceRender] = React.useState(0);
    const live = settings.use(["monitorEnabled", "monitorGain", "showMeter"]);

    React.useEffect(() => {
        const update = () => forceRender(value => value + 1);
        monitorListeners.add(update);
        return () => monitorListeners.delete(update);
    }, []);

    const enabled = live.monitorEnabled === true;
    const gain = Number(live.monitorGain ?? 1);
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
    React.createElement("div", { style: { fontWeight: 800, fontSize: 13 } }, "🎙️ Microphone sidetone + level monitor"),
    React.createElement("div", { style: { fontSize: 11, lineHeight: 1.45, color: "#bfeef4" } },
        "Hear a local preview while you tune the monitor gain. This does not change Discord's outgoing microphone volume. Use headphones to prevent feedback."),
    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11 } },
        React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: monitorState === "running" ? "#4cf78a" : monitorState === "error" ? "#ff6b83" : "#778399" } }),
        React.createElement("span", null, stateLabel),
        React.createElement("span", { style: { marginLeft: "auto", color: "#ffe28a", fontWeight: 700 } }, `${gain.toFixed(1)}x monitor gain`)),
    live.showMeter !== false && React.createElement("div", null,
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 10, color: "#bfeef4", marginBottom: 4 } },
            React.createElement("span", null, "Live monitor level"),
            React.createElement("span", null, `${Math.round(monitorLevel * 100)}%`)),
        React.createElement("div", { style: { height: 9, borderRadius: 999, overflow: "hidden", background: "rgba(0,0,0,.38)", border: "1px solid rgba(255,255,255,.12)" } },
            React.createElement("div", { style: { width: meterWidth, height: "100%", borderRadius: 999, background: "linear-gradient(90deg, #48e0c2, #f7e36e 72%, #ff6b83)", transition: "width 80ms linear" } }))),
    React.createElement("div", { style: { fontSize: 10, color: "#9fb3c2" } }, enabled ? "Change Monitor gain below while speaking to hear the difference." : "Enable Monitor sidetone below to request microphone permission."));
}

const settings = definePluginSettings({
    showroom: {
        type: OptionType.COMPONENT,
        description: "",
        component: MicMonitorShowroom
    },
    monitorEnabled: {
        type: OptionType.BOOLEAN,
        description: "Hear your microphone locally through the monitor. Off by default; headphones are recommended. Discord's outgoing microphone stream is not modified.",
        default: false,
        onChange: onMonitorEnabledChange
    },
    monitorGain: {
        type: OptionType.SLIDER,
        description: "Local monitor gain only. Speak while changing this value and watch the live level meter above.",
        markers: [0.5, 1, 1.5, 2, 2.5, 3],
        default: 1,
        stickToMarkers: false,
        onChange: onMonitorGainChange
    },
    showMeter: {
        type: OptionType.BOOLEAN,
        description: "Show the live microphone level meter in the monitor panel.",
        default: true
    }
});

export default definePlugin({
    name: "DMMicMonitor",
    description: "🎙️ Optional local microphone sidetone with a live level meter and adjustable monitor gain. Uses a separate local audio path and never replaces Discord's outgoing microphone stream.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        if ((settings.store as any).monitorEnabled) void startMonitor();
    },

    stop() {
        stopMonitor();
    }
});

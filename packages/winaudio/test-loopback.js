/*
 * Standalone process-loopback diagnostic.
 *
 * WHY this exists: the original test.js only COUNTED chunks — but WASAPI emits
 * silence packets even when nothing's playing, so a totally silent capture still
 * "passes" a chunk-count test. That's exactly why the 5 prior attempts couldn't
 * tell a working capture from a broken one. This measures the REAL audio level
 * (peak + RMS of the float samples) and writes a WAV you can actually play back.
 *
 * Run it in isolation — no app, no screenshare wiring — to settle whether the
 * native capture itself works on this machine.
 *
 *   cd packages/winaudio
 *   npm install                 # builds winaudio.node (needs MSVC + node-gyp)
 *   node test-loopback.js                 # lists what's playing; pick your game's pid
 *   node test-loopback.js <pid> include 6 # capture ONLY that pid for 6s
 *   node test-loopback.js <pid> exclude 6 # capture everything EXCEPT that pid
 *
 * Then: read the PEAK line, and play loopback-test.wav.
 */
const winaudio = require(".");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const pid = args[0] ? parseInt(args[0], 10) : null;
const mode = args[1] === "exclude" ? "exclude" : "include";
const seconds = args[2] ? parseInt(args[2], 10) : 6;

const { sessions } = winaudio.enumerateAudioSessions();
console.log("\nAudio sessions currently playing:");
if (!sessions.length) console.log("  (none — start your game and make it play sound first)");
sessions.forEach(s =>
    console.log(`  pid ${String(s.pid).padEnd(7)} ${(s.processName || "").padEnd(24)} "${s.displayName || ""}" ${s.isActive ? "[active]" : ""}`)
);

if (!pid) {
    console.log("\nUsage: node test-loopback.js <pid> [include|exclude] [seconds]");
    console.log("Pick your GAME's pid from the list above, then re-run with it.");
    process.exit(0);
}

console.log(`\nCapturing mode="${mode}" pid=${pid} for ${seconds}s — play game audio now...`);

let chunks = 0;
let silentChunks = 0;
let peak = 0;
let sumSq = 0;
let sampleCount = 0;
const pcm = [];

if (typeof winaudio.drainChunks !== "function") {
    console.log("\nERROR: native drainChunks() export is missing.");
    process.exit(1);
}

const drain = () => {
    for (const chunk of winaudio.drainChunks()) {
        chunks++;
        if (chunk.silent) silentChunks++;
        const buf = Buffer.from(chunk.data);
        pcm.push(buf);
        const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
        for (let i = 0; i < f.length; i++) {
            const a = Math.abs(f[i]);
            if (a > peak) peak = a;
            sumSq += f[i] * f[i];
            sampleCount++;
        }
    }
};

let fmt;
try {
    // Match the Electron main-process bridge: it polls drainChunks() because
    // the native callback is not serviced by Electron's event loop.
    fmt = winaudio.startProcessLoopback(pid, mode, () => {});
} catch (e) {
    console.log("\n❌ startProcessLoopback THREW: " + (e && e.message ? e.message : e));
    console.log("(That's a different failure than silent capture — paste this.)");
    process.exit(1);
}

const drainTimer = setInterval(drain, 20);

setTimeout(() => {
    clearInterval(drainTimer);
    drain();
    try {
        winaudio.stopCapture();
    } catch {}
    const rms = sampleCount ? Math.sqrt(sumSq / sampleCount) : 0;
    const sr = (fmt && fmt.sampleRate) || 48000;
    const ch = (fmt && fmt.channels) || 2;

    console.log("\n--------------- RESULT ---------------");
    console.log(`chunks received : ${chunks}  (flagged silent: ${silentChunks})`);
    console.log(`PEAK amplitude  : ${peak.toFixed(5)}`);
    console.log(`RMS  amplitude  : ${rms.toFixed(5)}`);
    console.log(
        peak < 0.0005
            ? "VERDICT: ⚠️ NO NON-SILENT AUDIO OBSERVED — capture delivered packets, but the selected process produced no measurable signal during the window. Re-run while known audio is playing before treating this as a native failure."
            : "VERDICT: ✅ AUDIO CAPTURED — peak is non-zero, the native capture WORKS. The old failure was the app wiring, not this."
    );

    try {
        const data = Buffer.concat(pcm);
        const out = path.join(__dirname, "loopback-test.wav");
        fs.writeFileSync(out, makeFloatWav(data, sr, ch));
        console.log(`WAV written     : ${out}\n→ play it to hear what the capture actually got.`);
    } catch (e) {
        console.log("WAV write failed: " + (e && e.message ? e.message : e));
    }
    process.exit(0);
}, seconds * 1000);

function makeFloatWav(float32Data, sampleRate, channels) {
    const blockAlign = channels * 4;
    const byteRate = sampleRate * blockAlign;
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + float32Data.length, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(3, 20); // 3 = IEEE float
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(byteRate, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(32, 34);
    h.write("data", 36);
    h.writeUInt32LE(float32Data.length, 40);
    return Buffer.concat([h, float32Data]);
}

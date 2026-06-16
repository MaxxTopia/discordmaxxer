/**
 * @type {typeof import(".")}
 */
const winaudio = require(".");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("listOutputDevices returns at least one device", () => {
    const { devices } = winaudio.listOutputDevices();
    assert.ok(Array.isArray(devices));
    assert.ok(devices.length >= 1, "expected at least one render endpoint");
    for (const d of devices) {
        assert.strictEqual(typeof d.id, "string");
        assert.strictEqual(typeof d.name, "string");
        assert.strictEqual(typeof d.isDefault, "boolean");
        assert.ok(d.id.length > 0);
        assert.ok(d.name.length > 0);
    }
    // Exactly one default.
    const defaultCount = devices.filter(d => d.isDefault).length;
    assert.strictEqual(defaultCount, 1, "expected exactly one default device");
});

test("startCapture / stopCapture roundtrip on default device", async () => {
    const { devices } = winaudio.listOutputDevices();
    const def = devices.find(d => d.isDefault);
    assert.ok(def, "no default device");

    let chunkCount = 0;
    let totalBytes = 0;
    let format = null;

    format = winaudio.startCapture(def.id, (chunk) => {
        chunkCount++;
        totalBytes += chunk.data.length;
    });

    assert.ok(format, "no format returned");
    assert.ok(format.sampleRate >= 8000 && format.sampleRate <= 192000);
    assert.ok(format.channels >= 1 && format.channels <= 8);
    assert.ok(format.bitsPerSample === 16 || format.bitsPerSample === 24 || format.bitsPerSample === 32);
    assert.ok(winaudio.isCapturing());

    // Capture for 2 seconds. WASAPI loopback emits silence packets even
    // when no apps play, so chunkCount > 0 even without user audio.
    await new Promise(r => setTimeout(r, 2000));

    winaudio.stopCapture();
    assert.ok(!winaudio.isCapturing());

    console.log(`captured ${chunkCount} chunks (${totalBytes} bytes) @ ${format.sampleRate}Hz ${format.channels}ch ${format.bitsPerSample}bit ${format.isFloat ? "float" : "int"}`);
    assert.ok(chunkCount > 0, "no chunks received in 2s — WASAPI event loop may be broken");
});

test("startCapture twice without stop throws", () => {
    const { devices } = winaudio.listOutputDevices();
    const def = devices.find(d => d.isDefault);

    const fmt = winaudio.startCapture(def.id, () => {});
    try {
        assert.throws(() => {
            winaudio.startCapture(def.id, () => {});
        }, /already active/);
    } finally {
        winaudio.stopCapture();
    }
});

test("startCapture with bad device id throws", () => {
    assert.throws(() => {
        winaudio.startCapture("{not-a-real-id}", () => {});
    });
});

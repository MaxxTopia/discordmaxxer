/*
 * Discordmaxxer — HWID computation
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Computes a stable per-rig fingerprint matching optimizationmaxxing's
 * algorithm so a VIP code minted for a given HWID is interchangeable
 * across both products. Source-of-truth lives in
 *   optimizationmaxxing/src-tauri/src/vip.rs::compute_hwid()
 *
 * Algorithm:
 *   basis = "<BIOS UUID>|<BIOS Serial>|<CPU Brand>"
 *   hwid  = sha256(basis).hex().slice(0, 32)   // 16 bytes hex-encoded
 *
 * BIOS data via PowerShell -> Get-CimInstance (the modern WMI API).
 * Stable across Windows reinstalls (BIOS data survives), unique per
 * motherboard.
 *
 * Renderer accesses via VesktopNative.hwid.get().
 */

import { execFile } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";

import { IpcEvents } from "../shared/IpcEvents";
import { handle } from "./utils/ipcWrappers";

const execFileAsync = promisify(execFile);

const PS_QUERY = `
$ErrorActionPreference = 'SilentlyContinue';
$u = (Get-CimInstance Win32_ComputerSystemProduct).UUID;
$s = (Get-CimInstance Win32_BIOS).SerialNumber;
$c = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name;
"$u|$s|$c"
`.trim();

let cached: string | null = null;

async function computeHwid(): Promise<string> {
    if (cached) return cached;

    if (process.platform !== "win32") {
        // Non-Windows fallback — use machine-stable bits available
        // (hostname + arch + cpu count). Less stable but better than nothing.
        // Discordmaxxer ships Windows-only in v0.5; this is for forward compat.
        const os = await import("os");
        const basis = `${os.hostname()}|${os.arch()}|${os.cpus().length}`;
        cached = createHash("sha256").update(basis).digest("hex").slice(0, 32);
        return cached;
    }

    try {
        const { stdout } = await execFileAsync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-Command", PS_QUERY
            ],
            { windowsHide: true, timeout: 10_000 }
        );
        const basis = stdout.trim();
        cached = createHash("sha256").update(basis).digest("hex").slice(0, 32);
        return cached;
    } catch (e) {
        console.error("[discordmaxxerHwid] WMI query failed:", e);
        throw new Error("hwid_unavailable");
    }
}

handle(IpcEvents.DM_GET_HWID, async () => {
    try {
        return { ok: true, hwid: await computeHwid() };
    } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
    }
});

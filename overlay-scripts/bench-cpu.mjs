/*
 * Discordmaxxer - CPU/RAM benchmark
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Measures the actual process tree for one or both clients. This is a
 * Windows-first harness because Discordmaxxer is an Electron desktop app.
 * It deliberately does not match every process named "electron": that would
 * also count unrelated Electron apps and made the old comparison invalid.
 *
 * Examples:
 *   node overlay-scripts/bench-cpu.mjs --target maxxer --duration 60 --interval 5
 *   node overlay-scripts/bench-cpu.mjs --target discord --duration 60 --interval 5
 *   node overlay-scripts/bench-cpu.mjs --target both --duration 300 --interval 5
 *   node overlay-scripts/bench-cpu.mjs --target maxxer --require-visible
 *
 * Keep the same workload and window state for each run. This script measures
 * process CPU time and memory; it does not prove input latency, voice quality,
 * GPU engine usage, or gameplay performance.
 */

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const DURATION_S = Math.max(1, Number(args.duration ?? 60));
const INTERVAL_S = Math.max(0.5, Number(args.interval ?? 5));
const TARGET = String(args.target ?? "both").toLowerCase();
const OUT = args.out ?? `bench-${Date.now()}.csv`;
const MAXXER_ROOT = normalizePath(args["maxxer-root"] ?? process.cwd());
const DISCORD_ROOT = normalizePath(args["discord-root"] ?? join(process.env.LOCALAPPDATA ?? "", "Discord"));
const MAXXER_PID = args["maxxer-pid"] ? Number(args["maxxer-pid"]) : null;
const DISCORD_PID = args["discord-pid"] ? Number(args["discord-pid"]) : null;
const REQUIRE_FOREGROUND = Boolean(args["require-foreground"]);
const REQUIRE_VISIBLE = Boolean(args["require-visible"] || REQUIRE_FOREGROUND);
const LOGICAL_CPU_COUNT = cpus().length;
const PHYSICAL_MEMORY_MB = totalmem() / 1024 / 1024;

if (!Number.isFinite(DURATION_S) || !Number.isFinite(INTERVAL_S)) {
    throw new Error("--duration and --interval must be numbers");
}
if (!["maxxer", "discord", "both"].includes(TARGET)) {
    throw new Error("--target must be maxxer, discord, or both");
}

function normalizePath(value) {
    if (!value) return "";
    return resolve(String(value)).replaceAll("/", "\\").toLowerCase();
}

function processQuery() {
    const ps = `
$windowProbe = @'
using System;
using System.Runtime.InteropServices;
public static class DmBenchWindowProbe {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@
Add-Type $windowProbe -ErrorAction SilentlyContinue
$foregroundHandle = [DmBenchWindowProbe]::GetForegroundWindow()
[uint32]$foregroundPid = 0
[DmBenchWindowProbe]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid) | Out-Null
$byId = @{}
Get-Process | ForEach-Object {
    $cpu = 0
    $private = 0
    $handles = 0
    $threads = 0
    try { $cpu = [double]$_.CPU } catch {}
    try { $private = [int64]$_.PrivateMemorySize64 } catch {}
    try { $handles = [int]$_.HandleCount } catch {}
    try { $threads = [int]$_.Threads.Count } catch {}
    $byId[[int]$_.Id] = [pscustomobject]@{
        cpuSeconds = $cpu
        wsBytes = [int64]$_.WorkingSet64
        privateBytes = $private
        handles = $handles
        threads = $threads
        mainWindowHandle = [int64]$_.MainWindowHandle
        windowVisible = [DmBenchWindowProbe]::IsWindowVisible($_.MainWindowHandle)
        windowMinimized = [DmBenchWindowProbe]::IsIconic($_.MainWindowHandle)
    }
}
Get-CimInstance Win32_Process | ForEach-Object {
    $m = $byId[[int]$_.ProcessId]
    [pscustomobject]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        name = [string]$_.Name
        exe = [string]$_.ExecutablePath
        cmd = [string]$_.CommandLine
        cpuSeconds = if ($m) { $m.cpuSeconds } else { 0 }
        wsBytes = if ($m) { $m.wsBytes } else { 0 }
        privateBytes = if ($m) { $m.privateBytes } else { 0 }
        handles = if ($m) { $m.handles } else { 0 }
        threads = if ($m) { $m.threads } else { 0 }
        mainWindowHandle = if ($m) { $m.mainWindowHandle } else { 0 }
        windowVisible = if ($m) { $m.windowVisible } else { $false }
        windowMinimized = if ($m) { $m.windowMinimized } else { $false }
        foregroundPid = [int]$foregroundPid
    }
} | ConvertTo-Json -Compress -Depth 3
`;
    const result = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error("Process query failed: " + result.stderr);
    const parsed = JSON.parse(result.stdout.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
}

function commandIncludes(process, needle) {
    const command = `${process.exe ?? ""} ${process.cmd ?? ""}`.toLowerCase();
    return needle && command.includes(needle);
}

function isRootProcess(process, kind) {
    const command = String(process.cmd ?? "").toLowerCase();
    if (kind === "maxxer") {
        return process.name?.toLowerCase() === "electron.exe" && !command.includes("--type=");
    }
    return process.name?.toLowerCase() === "discord.exe" && !command.includes("--type=");
}

function findRoots(processes, kind) {
    const explicitPid = kind === "maxxer" ? MAXXER_PID : DISCORD_PID;
    const identity = kind === "maxxer" ? MAXXER_ROOT : DISCORD_ROOT;
    if (explicitPid) {
        const explicit = processes.find(p => p.pid === explicitPid);
        if (!explicit) throw new Error(`${kind} PID ${explicitPid} is not running`);
        return [explicit];
    }

    const candidates = processes.filter(p => isRootProcess(p, kind) && commandIncludes(p, identity));
    if (candidates.length > 0) return candidates;

    // Some Discord builds omit the full install path from the root command
    // line. In that case use the executable path, but still require a root
    // process rather than accepting all matching child renderers.
    const byExe = processes.filter(p => {
        if (!isRootProcess(p, kind)) return false;
        return normalizePath(p.exe).startsWith(identity);
    });
    return byExe;
}

function collectTree(processes, roots) {
    const included = new Set(roots.map(root => root.pid));
    let changed = true;
    while (changed) {
        changed = false;
        for (const process of processes) {
            if (!included.has(process.pid) && included.has(process.parentPid)) {
                included.add(process.pid);
                changed = true;
            }
        }
    }
    return processes.filter(process => included.has(process.pid));
}

function summarize(processes, roots) {
    const tree = collectTree(processes, roots);
    return {
        rootCount: roots.length,
        processCount: tree.length,
        cpuSeconds: tree.reduce((sum, process) => sum + Number(process.cpuSeconds || 0), 0),
        wsMb: tree.reduce((sum, process) => sum + Number(process.wsBytes || 0), 0) / 1024 / 1024,
        privateMb: tree.reduce((sum, process) => sum + Number(process.privateBytes || 0), 0) / 1024 / 1024,
        handles: tree.reduce((sum, process) => sum + Number(process.handles || 0), 0),
        threads: tree.reduce((sum, process) => sum + Number(process.threads || 0), 0),
        rootPids: roots.map(root => root.pid).join("|")
    };
}

function validateWindowState(processes, roots, label) {
    if (!REQUIRE_VISIBLE && !REQUIRE_FOREGROUND) return;
    const foregroundPid = Number(processes[0]?.foregroundPid ?? 0);
    const visibleRoot = roots.some(root => Number(root.mainWindowHandle || 0) !== 0
        && root.windowVisible === true
        && root.windowMinimized !== true);
    if (REQUIRE_VISIBLE && !visibleRoot) {
        throw new Error(`${label} must be visible and not minimized for --require-visible (foreground PID ${foregroundPid}; roots ${roots.map(root => root.pid).join(",")}).`);
    }
    const foregroundRoot = roots.some(root => root.pid === foregroundPid && visibleRoot);
    if (REQUIRE_FOREGROUND && !foregroundRoot) {
        throw new Error(`${label} must be visible, not minimized, and foreground for --require-foreground (foreground PID ${foregroundPid}; roots ${roots.map(root => root.pid).join(",")}).`);
    }
}

const specs = [];
if (TARGET === "maxxer" || TARGET === "both") specs.push({ label: "Discordmaxxer", kind: "maxxer" });
if (TARGET === "discord" || TARGET === "both") specs.push({ label: "Discord", kind: "discord" });

const columns = ["ts_iso", "seconds_elapsed"];
for (const spec of specs) {
    columns.push(
        `${spec.label}_root_count`,
        `${spec.label}_proc_count`,
        `${spec.label}_cpu_seconds`,
        `${spec.label}_cpu_pct_one_core`,
        `${spec.label}_ram_mb`,
        `${spec.label}_private_mb`,
        `${spec.label}_handles`,
        `${spec.label}_threads`,
        `${spec.label}_root_pids`
    );
}

const rows = [columns.join(",")];
const startMs = Date.now();
const sampleCount = Math.ceil(DURATION_S / INTERVAL_S);
let previous = null;

console.error(`[bench] target=${TARGET} duration=${DURATION_S}s interval=${INTERVAL_S}s samples=${sampleCount + 1}`);
console.error(`[bench] maxxer root=${MAXXER_ROOT}`);
console.error(`[bench] discord root=${DISCORD_ROOT}`);
if (REQUIRE_FOREGROUND) console.error("[bench] guard=require-foreground");

for (let sample = 0; sample <= sampleCount; sample++) {
    const elapsed = (Date.now() - startMs) / 1000;
    const snapshot = processQuery();
    const current = new Map();

    for (const spec of specs) {
        const roots = findRoots(snapshot, spec.kind);
        if (roots.length === 0) {
            throw new Error(`${spec.label} was not found. Start it or pass --${spec.kind}-pid <pid>.`);
        }
        validateWindowState(snapshot, roots, spec.label);
        current.set(spec.label, summarize(snapshot, roots));
    }

    const fields = [new Date().toISOString(), elapsed.toFixed(1)];
    const logParts = [];
    for (const spec of specs) {
        const value = current.get(spec.label);
        const prior = previous?.get(spec.label);
        const wallSeconds = prior ? Math.max(0.001, elapsed - previous.elapsed) : 0;
        const cpuPct = prior ? ((value.cpuSeconds - prior.cpuSeconds) / wallSeconds) * 100 : 0;
        fields.push(
            value.rootCount,
            value.processCount,
            value.cpuSeconds.toFixed(2),
            cpuPct.toFixed(2),
            value.wsMb.toFixed(1),
            value.privateMb.toFixed(1),
            value.handles,
            value.threads,
            value.rootPids
        );
        logParts.push(`${spec.label}: ${value.processCount}p ${cpuPct.toFixed(1)}% CPU ${value.wsMb.toFixed(0)}MB WS ${value.rootPids}`);
    }
    rows.push(fields.join(","));
    console.error(`  t=${elapsed.toFixed(1)}s  ${logParts.join("  |  ")}`);

    previous = new Map(current);
    previous.elapsed = elapsed;
    if (sample < sampleCount) {
        // Schedule against the original start time so the PowerShell query
        // itself does not stretch a nominal 60-second run into 90 seconds.
        const nextSampleAt = startMs + (sample + 1) * INTERVAL_S * 1000;
        const delayMs = Math.max(0, nextSampleAt - Date.now());
        await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs));
    }
}

writeFileSync(OUT, rows.join("\n") + "\n", "utf8");
const metadataPath = `${OUT}.meta.json`;
writeFileSync(metadataPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    target: TARGET,
    durationSeconds: DURATION_S,
    intervalSeconds: INTERVAL_S,
    maxxerRoot: MAXXER_ROOT,
    discordRoot: DISCORD_ROOT,
    logicalCpuCount: LOGICAL_CPU_COUNT,
    physicalMemoryMb: Number(PHYSICAL_MEMORY_MB.toFixed(1)),
    requireVisible: REQUIRE_VISIBLE,
    requireForeground: REQUIRE_FOREGROUND,
    note: "CPU percent is relative to one logical CPU. Keep workload and focus state identical between runs. --require-foreground rejects hidden, minimized, or non-foreground root windows."
}, null, 2) + "\n", "utf8");
console.error(`[bench] wrote ${OUT}`);
console.error(`[bench] wrote ${metadataPath}`);

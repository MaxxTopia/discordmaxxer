/*
 * Summarize CSV files produced by bench-cpu.mjs.
 *
 * Usage:
 *   node overlay-scripts/analyze-bench.mjs bench-maxxer.csv bench-discord.csv
 *   pnpm bench:analyze -- bench-maxxer.csv
 *
 * The summary is deliberately limited to process CPU time and memory. It does
 * not claim input latency, GPU performance, voice quality, or gameplay proof.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

function parseArgs(argv) {
    const files = [];
    let tailSeconds = 20;
    let json = false;

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === "--tail-seconds") {
            tailSeconds = Number(argv[++i]);
            continue;
        }
        if (token === "--json") {
            json = true;
            continue;
        }
        if (!token.startsWith("--")) files.push(token);
    }

    if (!Number.isFinite(tailSeconds) || tailSeconds < 0) {
        throw new Error("--tail-seconds must be a non-negative number");
    }

    return { files, tailSeconds, json };
}

function csvRows(file) {
    const lines = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(line => line.length > 0);
    if (lines.length < 2) throw new Error(`${file} has no benchmark samples`);

    const headers = lines[0].split(",");
    return lines.slice(1).map((line, rowIndex) => {
        const values = line.split(",");
        if (values.length !== headers.length) {
            throw new Error(`${file} row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
        }
        return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    });
}

function quantile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * fraction)));
    return sorted[index];
}

function metric(values) {
    const numbers = values.map(Number).filter(Number.isFinite);
    if (numbers.length === 0) return null;
    return {
        median: quantile(numbers, 0.5),
        p95: quantile(numbers, 0.95),
        min: Math.min(...numbers),
        max: Math.max(...numbers)
    };
}

function round(value) {
    return value == null ? null : Number(value.toFixed(2));
}

function summarize(file, tailSeconds) {
    const rows = csvRows(file);
    const elapsed = rows.map(row => Number(row.seconds_elapsed)).filter(Number.isFinite);
    const lastElapsed = elapsed.at(-1) ?? 0;
    const firstTailElapsed = Math.max(0, lastElapsed - tailSeconds);
    const tail = rows.filter(row => Number(row.seconds_elapsed) >= firstTailElapsed);
    const prefixes = [...new Set(Object.keys(rows[0])
        .filter(key => key.endsWith("_cpu_pct_one_core"))
        .map(key => key.slice(0, -"_cpu_pct_one_core".length)))];

    const targets = Object.fromEntries(prefixes.map(prefix => {
        const cpu = metric(tail.map(row => row[`${prefix}_cpu_pct_one_core`]));
        const ram = metric(tail.map(row => row[`${prefix}_ram_mb`]));
        const privateMemory = metric(tail.map(row => row[`${prefix}_private_mb`]));
        const firstRam = Number(tail[0]?.[`${prefix}_ram_mb`]);
        const lastRam = Number(tail.at(-1)?.[`${prefix}_ram_mb`]);
        return [prefix, {
            samples: tail.length,
            cpuPctOneCore: mapMetric(cpu),
            ramMb: mapMetric(ram),
            privateMb: mapMetric(privateMemory),
            ramDriftMb: Number.isFinite(firstRam) && Number.isFinite(lastRam)
                ? round(lastRam - firstRam)
                : null
        }];
    }));

    return {
        file: resolve(file),
        samples: rows.length,
        elapsedSeconds: round(lastElapsed),
        tailWindow: {
            startSeconds: round(firstTailElapsed),
            endSeconds: round(lastElapsed),
            seconds: tailSeconds
        },
        targets
    };
}

function mapMetric(value) {
    if (!value) return null;
    return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, round(number)]));
}

const { files: requestedFiles, tailSeconds, json } = parseArgs(process.argv.slice(2));
const files = requestedFiles.length > 0
    ? requestedFiles
    : readdirSync(process.cwd())
        .filter(file => /^bench-.*\.csv$/i.test(file))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

if (files.length === 0) {
    throw new Error("No benchmark CSV files supplied and no bench-*.csv files were found");
}

for (const file of files) {
    if (!existsSync(file)) throw new Error(`Benchmark file not found: ${file}`);
}

const summaries = files.map(file => summarize(file, tailSeconds));
if (json) {
    console.log(JSON.stringify(summaries, null, 2));
} else {
    console.log(`Benchmark summaries (last ${tailSeconds}s of each file)`);
    for (const summary of summaries) {
        console.log(`\n${basename(summary.file)} (${summary.elapsedSeconds}s, ${summary.samples} samples)`);
        for (const [target, values] of Object.entries(summary.targets)) {
            const cpu = values.cpuPctOneCore ?? {};
            const ram = values.ramMb ?? {};
            const drift = values.ramDriftMb == null ? "n/a" : `${values.ramDriftMb >= 0 ? "+" : ""}${values.ramDriftMb} MB`;
            console.log(`  ${target}: CPU median ${cpu.median ?? "n/a"}% / p95 ${cpu.p95 ?? "n/a"}%; RAM median ${ram.median ?? "n/a"} MB / p95 ${ram.p95 ?? "n/a"} MB; tail drift ${drift}`);
        }
    }
}

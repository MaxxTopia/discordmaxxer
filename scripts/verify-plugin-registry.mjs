/*
 * Discordmaxxer — plugin registry consistency gate
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The defaults seeder, one-click bundles, and the tour are all user-facing
 * entry points into the same Vencord registry. A renamed or removed upstream
 * plugin must not turn into a dead button, a fake enabled setting, or a build
 * that only looks healthy on a fresh install.
 *
 * Run after the overlay has copied custom plugins into vencord-src/src/userplugins.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(path) {
    return readFileSync(join(ROOT, path), "utf8");
}

function quotedMatches(source, regex) {
    return [...source.matchAll(regex)].map(match => match[1]);
}

function walkFiles(root) {
    if (!existsSync(root)) return [];
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) files.push(...walkFiles(path));
        else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
    }
    return files;
}

function collectRegisteredPlugins() {
    const roots = [
        join(ROOT, "vencord-src", "src", "plugins"),
        join(ROOT, "vencord-src", "src", "userplugins"),
        join(ROOT, "plugins")
    ];
    const registered = new Set();
    for (const root of roots) {
        for (const path of walkFiles(root)) {
            const source = readFileSync(path, "utf8");
            for (const name of quotedMatches(source, /^\s*name:\s*["']([^"']+)["']/gm)) registered.add(name);
        }
    }
    return registered;
}

function collectDefaults() {
    return quotedMatches(read("src/main/discordmaxxerDefaults.ts"), /^\s*["']([A-Za-z0-9]+)["'](?:,|\s*\/\/)/gm);
}

function collectBundlePlugins() {
    const source = read("plugins/_dm-shared/bundles.ts");
    const ids = [];
    for (const match of source.matchAll(/plugins\s*:\s*\[([\s\S]*?)\]/g)) {
        ids.push(...quotedMatches(match[1], /["']([^"']+)["']/g));
    }
    return ids;
}

function collectFeaturedPlugins() {
    return quotedMatches(read("plugins/_dm-shared/featured.ts"), /^\s*id:\s*["']([^"']+)["']/gm);
}

function unique(values) {
    return [...new Set(values)];
}

function report(label, values, registered) {
    const missing = unique(values).filter(id => !registered.has(id));
    if (missing.length) {
        console.error(`[plugin-registry] FAIL ${label}: missing ${missing.join(", ")}`);
        return missing;
    }
    console.log(`[plugin-registry] OK   ${label}: ${unique(values).length} IDs resolve`);
    return [];
}

const registered = collectRegisteredPlugins();
const defaults = collectDefaults();
const bundles = collectBundlePlugins();
const featured = collectFeaturedPlugins();
const missing = [
    ...report("defaults", defaults, registered),
    ...report("bundles", bundles, registered),
    ...report("featured", featured, registered)
];

console.log(`[plugin-registry] registry sources: ${registered.size} plugin IDs`);
if (missing.length) {
    process.exitCode = 1;
} else {
    console.log("[plugin-registry] All user-facing plugin IDs are registered.");
}

/*
 * Discordmaxxer — build artifact integrity gate
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A release-time sanity check (audit 2026-06-26): a build can "succeed" yet
 * produce a broken bundle — the overlay silently emitted an empty/garbage
 * Vencord dist, or our custom plugins didn't compile in. electron-builder would
 * then happily publish it to everyone. This script FAILS the release if the
 * shipped artifacts aren't structurally sound, so a hollow build can't reach
 * users. Run in release.yml AFTER `pnpm overlay:vencord` + `pnpm build`, BEFORE
 * electron-builder. Safe to run locally too: `node overlay-scripts/verify-build.mjs`.
 *
 * This catches gross/structural breakage. It does NOT exercise the running app
 * (live voice, "Patch had no effect", etc.) — that needs a real launch + a
 * Discord login and is the user's runtime test, not a CI gate.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileSnapshot, pluginNames, sourceFingerprint } from "./build-fingerprint.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const errors = [];
const ok = msg => console.log(`[verify] OK  ${msg}`);
const fail = msg => {
    errors.push(msg);
    console.error(`[verify] ✗   ${msg}`);
};

function sizeKB(p) {
    try {
        return statSync(p).size / 1024;
    } catch {
        return 0;
    }
}

// 1) The overlaid Vencord dist (what extraResources copies into the app).
const VDIST = join(ROOT, "vencord-dist");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VDIST_FILES = {
    "vencordDesktopMain.js": 5,
    "vencordDesktopPreload.js": 1,
    "vencordDesktopRenderer.js": 200,
    "vencordDesktopRenderer.css": 1
};
for (const [file, minKB] of Object.entries(VDIST_FILES)) {
    const p = join(VDIST, file);
    if (!existsSync(p)) fail(`missing vencord-dist/${file} — overlay:vencord did not produce it`);
    else if (sizeKB(p) < minKB) fail(`vencord-dist/${file} is only ${sizeKB(p).toFixed(1)}KB (< ${minKB}KB) — likely a hollow/failed build`);
    else ok(`vencord-dist/${file} present (${sizeKB(p).toFixed(0)}KB)`);
}

// 1b) Prove that the staged renderer belongs to this checkout and package.
const manifestPath = join(VDIST, "discordmaxxer-build.json");
if (!existsSync(manifestPath)) {
    fail("vencord-dist/discordmaxxer-build.json missing — refusing an unverified staged renderer");
} else {
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.product !== "discordmaxxer") fail("build manifest product is not discordmaxxer");
        else ok("build manifest product is discordmaxxer");
        if (manifest.appVersion !== packageJson.version) fail(`build manifest version ${manifest.appVersion} does not match package ${packageJson.version}`);
        else ok(`build manifest version matches package ${packageJson.version}`);
        if (manifest.sourceFingerprint !== sourceFingerprint()) fail("build manifest source fingerprint is stale or from another checkout");
        else ok("build manifest source fingerprint matches this checkout");
        const actualSnapshot = fileSnapshot(VDIST);
        for (const [file, expected] of Object.entries(manifest.stagedFiles ?? {})) {
            const actual = actualSnapshot[file];
            if (!expected || !actual || expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
                fail(`staged file hash mismatch for ${file}`);
            } else {
                ok(`staged file hash matches for ${file}`);
            }
        }
        const actualPlugins = pluginNames();
        for (const name of ["DMProfileCosmetics", "DMDisplayNameStyle", "DMEmoji", "DMTranslate"]) {
            if (!actualPlugins.includes(name) || !manifest.pluginNames?.includes(name)) fail(`required source plugin ${name} is not represented in the build manifest`);
            else ok(`manifest includes required source plugin ${name}`);
        }
    } catch (error) {
        fail(`could not read build manifest: ${error.message}`);
    }
}

// 2) Our custom plugins actually compiled INTO the renderer bundle. If the
// overlay silently dropped plugins/, these name strings won't be present.
const rendererPath = join(VDIST, "vencordDesktopRenderer.js");
if (existsSync(rendererPath)) {
    const renderer = readFileSync(rendererPath, "utf8");
    // Critical custom plugins — if any of these is absent, the overlay is broken.
    const REQUIRED_PLUGINS = ["TournamentMode", "DMVoiceKeybinds", "DMVoiceGuard", "DMHub", "DMTierFlair", "DMProfileCosmetics", "DMDisplayNameStyle", "DMEmoji", "DMTranslate"];
    for (const name of REQUIRED_PLUGINS) {
        if (renderer.includes(name)) ok(`plugin "${name}" compiled into renderer`);
        else fail(`plugin "${name}" NOT found in renderer bundle — overlay failed to include custom plugins`);
    }
}

// 3) The Vesktop shell build output (what electron-builder packages).
const shellRenderer = join(ROOT, "dist", "js", "renderer.js");
if (!existsSync(shellRenderer)) fail("dist/js/renderer.js missing — `pnpm build` did not produce the shell bundle");
else if (sizeKB(shellRenderer) < 50) fail(`dist/js/renderer.js is only ${sizeKB(shellRenderer).toFixed(1)}KB — likely a failed build`);
else ok(`dist/js/renderer.js present (${sizeKB(shellRenderer).toFixed(0)}KB)`);

if (errors.length) {
    console.error(`\n[verify] ✗ FAILED — ${errors.length} integrity problem(s). Refusing to publish this build.`);
    process.exit(1);
}
console.log("\n[verify] ✅ Build artifacts look structurally sound.");

/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "crypto";
import { app } from "electron";
import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

import { SESSION_DATA_DIR } from "./constants";
import { State } from "./settings";

const REQUIRED_BUILD_PLUGINS = [
    "TournamentMode",
    "DMVoiceKeybinds",
    "DMVoiceGuard",
    "DMHub",
    "DMTierFlair",
    "DMProfileCosmetics",
    "DMDisplayNameStyle",
    "DMEmoji",
    "DMTranslate"
];

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hasVerifiedBuildIdentity(dir: string): boolean {
    const manifestPath = join(dir, "discordmaxxer-build.json");
    if (!existsSync(manifestPath)) {
        console.warn(`[Discordmaxxer] Rejecting unverified staged Vencord at ${dir}: build manifest is missing`);
        return false;
    }

    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            product?: unknown;
            appVersion?: unknown;
            buildId?: unknown;
            pluginNames?: unknown;
            stagedFiles?: Record<string, { bytes?: number; sha256?: string }>;
        };
        if (manifest.product !== "discordmaxxer") {
            console.warn(`[Discordmaxxer] Rejecting staged Vencord at ${dir}: manifest product is invalid`);
            return false;
        }
        if (manifest.appVersion !== app.getVersion()) {
            console.warn(
                `[Discordmaxxer] Rejecting staged Vencord at ${dir}: manifest version ${String(manifest.appVersion)} does not match app ${app.getVersion()}`
            );
            return false;
        }
        if (typeof manifest.buildId !== "string" || !manifest.buildId) {
            console.warn(`[Discordmaxxer] Rejecting staged Vencord at ${dir}: build identity is missing`);
            return false;
        }
        const pluginNames = new Set(Array.isArray(manifest.pluginNames) ? manifest.pluginNames : []);
        const missingPlugin = REQUIRED_BUILD_PLUGINS.find(name => !pluginNames.has(name));
        if (missingPlugin) {
            console.warn(
                `[Discordmaxxer] Rejecting staged Vencord at ${dir}: required plugin ${missingPlugin} is missing`
            );
            return false;
        }

        const renderer = join(dir, "vencordDesktopRenderer.js");
        const rendererSnapshot = manifest.stagedFiles?.["vencordDesktopRenderer.js"];
        if (
            !rendererSnapshot ||
            rendererSnapshot.bytes !== statSync(renderer).size ||
            rendererSnapshot.sha256 !== sha256File(renderer)
        ) {
            console.warn(
                `[Discordmaxxer] Rejecting staged Vencord at ${dir}: renderer hash does not match its manifest`
            );
            return false;
        }
        console.log(`[Discordmaxxer] Verified build identity ${manifest.buildId}`);
        return true;
    } catch (error) {
        console.warn(
            `[Discordmaxxer] Rejecting staged Vencord at ${dir}: invalid build manifest (${error instanceof Error ? error.message : String(error)})`
        );
        return false;
    }
}

// this is in a separate file to avoid circular dependencies

// Discordmaxxer override: prefer our locally-staged Vencord build (with our
// custom plugins compiled in) when it exists. This bypasses Vesktop's runtime
// download of stock Vencord. The staged folder is built by `pnpm overlay:vencord`.
function discordmaxxerStagedVencord(): string | null {
    const required = [
        "vencordDesktopMain.js",
        "vencordDesktopPreload.js",
        "vencordDesktopRenderer.js",
        "vencordDesktopRenderer.css"
    ];

    // Dev: project-relative path. Production: bundled in resources/.
    // In dev __dirname is dist/js/ — go up 2 levels to project root.
    const candidates = IS_DEV
        ? [resolve(__dirname, "..", "..", "vencord-dist"), resolve(app.getAppPath(), "vencord-dist")]
        : [join(process.resourcesPath ?? "", "vencord-dist"), join(app.getAppPath(), "vencord-dist")];

    for (const dir of candidates) {
        const filesPresent = required.every(f => existsSync(join(dir, f)));
        if (!filesPresent) {
            console.log(`[Discordmaxxer] vencord-dist candidate: ${dir} -> miss`);
            continue;
        }
        const verified = hasVerifiedBuildIdentity(dir);
        console.log(`[Discordmaxxer] vencord-dist candidate: ${dir} -> ${verified ? "MATCH" : "rejected"}`);
        if (verified) return dir;
    }
    return null;
}

const STAGED = discordmaxxerStagedVencord();
if (STAGED) {
    console.log(`[Discordmaxxer] Using locally-staged Vencord at ${STAGED}`);
} else {
    console.log("[Discordmaxxer] No staged vencord-dist found, falling back to download");
}

export const VENCORD_FILES_DIR = STAGED || State.store.vencordDir || join(SESSION_DATA_DIR, "vencordFiles");

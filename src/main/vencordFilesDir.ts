/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { existsSync } from "fs";
import { join, resolve } from "path";

import { SESSION_DATA_DIR } from "./constants";
import { State } from "./settings";

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
        const found = required.every(f => existsSync(join(dir, f)));
        console.log(`[Discordmaxxer] vencord-dist candidate: ${dir} -> ${found ? "MATCH" : "miss"}`);
        if (found) return dir;
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

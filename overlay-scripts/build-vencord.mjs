/*
 * Discordmaxxer — Vencord overlay builder
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Mirrors `plugins/` into vencord-src/src/userplugins/, builds Vencord from
 * source, then stages the 4 dist files Vesktop expects into `vencord-dist/`.
 * Run via `pnpm overlay:vencord`.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileSnapshot, gitCommit, pluginNames, sourceFingerprint } from "./build-fingerprint.mjs";
import "./rebrand-vencord.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

const PLUGINS_SRC = join(PROJECT_ROOT, "plugins");
const VENCORD_SRC = resolve(process.env.DISCORDMAXXER_VENCORD_SRC ?? join(PROJECT_ROOT, "vencord-src"));
const VENCORD_USERPLUGINS = join(VENCORD_SRC, "src", "userplugins");
const VENCORD_BUILT_DIST = join(VENCORD_SRC, "dist");
const STAGED_DIST = join(PROJECT_ROOT, "vencord-dist");

const FILES_TO_STAGE = [
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
];

function log(msg) {
    console.log(`[overlay] ${msg}`);
}

function syncUserplugins() {
    // Wipe + recreate userplugins to guarantee deletes propagate
    if (existsSync(VENCORD_USERPLUGINS)) {
        rmSync(VENCORD_USERPLUGINS, { recursive: true, force: true });
    }
    mkdirSync(VENCORD_USERPLUGINS, { recursive: true });

    if (!existsSync(PLUGINS_SRC)) {
        log("No plugins/ folder found — building stock Vencord (no custom plugins)");
        return 0;
    }

    const entries = readdirSync(PLUGINS_SRC);
    let copied = 0;
    for (const name of entries) {
        const src = join(PLUGINS_SRC, name);
        if (!statSync(src).isDirectory()) continue;
        const dest = join(VENCORD_USERPLUGINS, name);
        cpSync(src, dest, { recursive: true });
        copied++;
        log(`  ✓ ${name}`);
    }
    return copied;
}

function buildVencord() {
    // CI and normal local builds keep using the documented pnpm entry point.
    // The direct entry is an explicit escape hatch for Windows worktrees where
    // pnpm is asked to remove/relink a junctioned modules directory without a
    // TTY. The caller must provide the already-installed, lockfile-verified
    // dependency tree; this does not skip the actual Vencord build.
    const useDirectBuild = process.env.DM_SKIP_VENCORD_INSTALL === "1";
    log(
        `Running Vencord build (${useDirectBuild ? "direct build entry" : "pnpm build"} --disable-updater inside vencord-src/)...`,
    );
    // --disable-updater bakes IS_UPDATER_DISABLED=true into the bundle (see
    // vencord-src/scripts/build/common.mjs). Without this flag, Vencord's
    // internal updater plugin runs at startup, hits the upstream Vencord
    // GitHub for new commits, and posts a "A Vencord update is available!"
    // Windows toast — confusing for Discordmaxxer users since they should
    // update via OUR electron-updater (src/main/updater.ts) targeting our
    // own GitHub Releases. Disabling Vencord's updater at build time keeps
    // the user on the Discordmaxxer release channel exclusively.
    const command = useDirectBuild
        ? "node --require=./scripts/suppressExperimentalWarnings.js scripts/build/build.mjs --disable-updater"
        : "pnpm build -- --disable-updater";
    execSync(command, { cwd: VENCORD_SRC, stdio: "inherit" });
}

function stageDist() {
    if (!existsSync(VENCORD_BUILT_DIST)) {
        throw new Error(`Vencord build did not produce ${VENCORD_BUILT_DIST}`);
    }

    if (existsSync(STAGED_DIST)) {
        rmSync(STAGED_DIST, { recursive: true, force: true });
    }
    mkdirSync(STAGED_DIST, { recursive: true });

    for (const filename of FILES_TO_STAGE) {
        const src = join(VENCORD_BUILT_DIST, filename);
        const dest = join(STAGED_DIST, filename);
        if (!existsSync(src)) {
            throw new Error(`Expected Vencord output missing: ${filename}`);
        }
        cpSync(src, dest);
    }

    // Vesktop's vencordLoader expects a package.json alongside the JS files
    writeFileSync(join(STAGED_DIST, "package.json"), JSON.stringify({ name: "vencord-discordmaxxer" }, null, 2));

    const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
    const commit = gitCommit();
    const fingerprint = sourceFingerprint();
    writeFileSync(
        join(STAGED_DIST, "discordmaxxer-build.json"),
        `${JSON.stringify(
            {
                product: "discordmaxxer",
                appVersion: packageJson.version,
                buildId: `${packageJson.version}-${commit.slice(0, 12)}-${fingerprint.slice(0, 16)}`,
                gitCommit: commit,
                sourceFingerprint: fingerprint,
                pluginNames: pluginNames(),
                stagedFiles: fileSnapshot(STAGED_DIST),
                generatedAt: new Date().toISOString(),
            },
            null,
            2,
        )}\n`,
        "utf8",
    );

    log(`Staged ${FILES_TO_STAGE.length + 2} files at ${STAGED_DIST}`);
}

function main() {
    log("=== Discordmaxxer overlay build ===");
    const t0 = Date.now();

    if (!existsSync(VENCORD_SRC)) {
        console.error(`vencord-src/ not found. Run: git clone https://github.com/Vendicated/Vencord.git ${VENCORD_SRC}`);
        process.exit(1);
    }

    const copied = syncUserplugins();
    log(`Synced ${copied} custom plugin(s) into vencord-src/src/userplugins/`);

    buildVencord();
    stageDist();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`✅ Done in ${elapsed}s. Pointing Discordmaxxer at ${STAGED_DIST}`);
    log(`   Set State.store.vencordDir to this path on next launch (handled in main/index.ts).`);
}

main();

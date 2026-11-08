/*
 * Discordmaxxer — Generate .desktop file and icon for Linux tar.gz
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Electron-builder generates .desktop files for deb/rpm/AppImage natively
 * (from package.json linux.desktop.entry). The tar.gz target does NOT —
 * it just packs dist/linux-unpacked/ as-is. This script generates the
 * .desktop file and copies the icon into dist/linux-unpacked/ so they
 * are included in the tar.gz.
 *
 * Users install these to their system by running discordmaxxer-install.sh
 * after extracting the tar.gz (that script handles symlinks, icon theme
 * placement, and cache rebuilds).
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");

function log(msg) {
    console.log(`[gen-desktop] ${msg}`);
}

const BUILD_DIR = join(PROJECT_ROOT, "dist", "linux-unpacked");
const ICON_SRC = join(PROJECT_ROOT, "build", "icon.png");
const ICON_DST_DIR = join(BUILD_DIR, "resources", "icons");
const ICON_DST = join(ICON_DST_DIR, "discordmaxxer.png");
const DESKTOP_DST = join(BUILD_DIR, "discordmaxxer.desktop");

mkdirSync(ICON_DST_DIR, { recursive: true });

if (existsSync(ICON_SRC)) {
    copyFileSync(ICON_SRC, ICON_DST);
    log(`Copied icon to ${ICON_DST}`);
} else {
    log(`WARNING: Icon not found at ${ICON_SRC}`);
}

const desktopContent = [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=Discordmaxxer",
    "GenericName=Internet Messenger",
    "Comment=Discord, optimized",
    "Exec=discordmaxxer %U",
    "Icon=discordmaxxer",
    "Terminal=false",
    "StartupNotify=true",
    "Categories=Network;InstantMessaging;Chat;",
    "Keywords=discord;discordmaxxer;vencord;electron;chat;",
    "MimeType=x-scheme-handler/discord;",
    "StartupWMClass=discordmaxxer",
    "",
].join("\n");

writeFileSync(DESKTOP_DST, desktopContent);
log(`Generated .desktop at ${DESKTOP_DST}`);
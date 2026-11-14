/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "fs";
import { dirname, join } from "path";

import { CommandLine } from "./cli";

const vesktopDir = dirname(process.execPath);
const isElectronDevelopment = process.execPath.toLowerCase().endsWith("electron.exe");
const isDefaultWindowsInstall =
    process.platform === "win32" &&
    typeof process.env.LOCALAPPDATA === "string" &&
    vesktopDir.toLowerCase() === join(process.env.LOCALAPPDATA, "Discordmaxxer").toLowerCase();

export const PORTABLE =
    process.platform === "win32" &&
    !process.execPath.toLowerCase().endsWith("electron.exe") &&
    !existsSync(join(vesktopDir, "Uninstall Discordmaxxer.exe")) &&
    !isDefaultWindowsInstall;

export const DATA_DIR =
    process.env.VENCORD_USER_DATA_DIR || (PORTABLE ? join(vesktopDir, "Data") : join(app.getPath("userData")));

mkdirSync(DATA_DIR, { recursive: true });

// A portable build keeps user-facing Vencord settings and assets beside the
// executable, but its Chromium session/cache is a hot I/O path.  When the
// package lives on a removable drive, putting that hot path on the USB volume
// causes cache open failures and can leave Discord's renderer on its loading
// shell.  Keep the dev profile separate and give portable builds a stable
// local runtime directory instead.  An explicit override remains available
// for diagnostics and managed deployments.
const stableInstalledSessionDataDir = join(app.getPath("appData"), "Discordmaxxer", "sessionData");

function hasChromiumSessionData(dir: string) {
    return ["Network", "Local Storage", "IndexedDB"].some(name => {
        try {
            return readdirSync(join(dir, name)).length > 0;
        } catch {
            return false;
        }
    });
}

/**
 * Older releases could put the Chromium session in a profile selected from
 * the install directory. That directory can change during an NSIS update,
 * which makes Discord look logged out even though the old session still
 * exists. Migrate only when the stable destination has no session markers;
 * never overwrite an existing profile.
 */
function migrateLegacyInstalledSessionData(destination: string) {
    if (hasChromiumSessionData(destination)) return;

    const candidates = [
        join(app.getPath("userData"), "sessionData"),
        join(app.getPath("appData"), "DiscordmaxxerPortable", "sessionData"),
        typeof process.env.LOCALAPPDATA === "string" ? join(process.env.LOCALAPPDATA, "DiscordmaxxerReleasePreview-Codex", "sessionData") : "",
        join(app.getPath("appData"), "Vesktop", "sessionData"),
        join(app.getPath("appData"), "Vencord", "sessionData"),
        join(vesktopDir, "Data", "sessionData")
    ].filter((candidate, index, all) => !!candidate && candidate !== destination && all.indexOf(candidate) === index);

    const source = candidates.find(hasChromiumSessionData);
    if (!source) return;

    try {
        mkdirSync(dirname(destination), { recursive: true });

        // Electron may create an empty sessionData tree before this check.
        // Preserve any cache-only tree, then move the real legacy profile into
        // the stable location instead of treating those empty marker folders
        // as a valid logged-in session.
        if (existsSync(destination)) {
            const existingEntries = readdirSync(destination);
            if (existingEntries.length > 0) {
                let backup = `${destination}.pre-migration`;
                let suffix = 1;
                while (existsSync(backup)) backup = `${destination}.pre-migration-${suffix++}`;
                renameSync(destination, backup);
            } else {
                rmdirSync(destination);
            }
        }

        renameSync(source, destination);
        console.log(`[Discordmaxxer] Migrated the existing session profile to ${destination}`);
    } catch (error) {
        // A failed migration must never prevent Discord from starting. The
        // next launch can retry after a stale updater/portable process exits.
        console.warn("[Discordmaxxer] Could not migrate the existing session profile:", error);
    }
}

if (!PORTABLE && !isElectronDevelopment && !process.env.DISCORDMAXXER_SESSION_DATA_DIR) {
    migrateLegacyInstalledSessionData(stableInstalledSessionDataDir);
}

export const SESSION_DATA_DIR =
    process.env.DISCORDMAXXER_SESSION_DATA_DIR ||
    (PORTABLE
        ? join(app.getPath("appData"), "DiscordmaxxerPortable", "sessionData")
        : isElectronDevelopment
          ? join(DATA_DIR, "sessionData")
          : stableInstalledSessionDataDir);
app.setPath("sessionData", SESSION_DATA_DIR);

export const VENCORD_SETTINGS_DIR = join(DATA_DIR, "settings");
mkdirSync(VENCORD_SETTINGS_DIR, { recursive: true });
export const VENCORD_QUICKCSS_FILE = join(VENCORD_SETTINGS_DIR, "quickCss.css");
export const VENCORD_SETTINGS_FILE = join(VENCORD_SETTINGS_DIR, "settings.json");
export const VENCORD_THEMES_DIR = join(DATA_DIR, "themes");

export const USER_AGENT = `Discordmaxxer/${app.getVersion()} (https://github.com/MaxxTopia/discordmaxxer)`;

// dimensions shamelessly stolen from Discord Desktop :3
export const MIN_WIDTH = 940;
export const MIN_HEIGHT = 500;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

export const DISCORD_HOSTNAMES = ["discord.com", "canary.discord.com", "ptb.discord.com"];

const VersionString = `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;
const BrowserUserAgents = {
    darwin: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${VersionString}`,
    linux: `Mozilla/5.0 (X11; Linux x86_64) ${VersionString}`,
    windows: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${VersionString}`
};

export const BrowserUserAgent =
    CommandLine.values["user-agent"] ||
    BrowserUserAgents[CommandLine.values["user-agent-os"] || process.platform] ||
    BrowserUserAgents.windows;

export const enum MessageBoxChoice {
    Default,
    Cancel
}

export const IS_FLATPAK = process.env.FLATPAK_ID !== undefined;

/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

import { CommandLine } from "./cli";

const vesktopDir = dirname(process.execPath);

export const PORTABLE =
    process.platform === "win32" &&
    !process.execPath.toLowerCase().endsWith("electron.exe") &&
    !existsSync(join(vesktopDir, "Uninstall Discordmaxxer.exe"));

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
export const SESSION_DATA_DIR =
    process.env.DISCORDMAXXER_SESSION_DATA_DIR ||
    (PORTABLE ? join(app.getPath("appData"), "DiscordmaxxerPortable", "sessionData") : join(DATA_DIR, "sessionData"));
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

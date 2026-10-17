/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, net } from "electron";
import { join } from "path";
import { pathToFileURL } from "url";

import { isPathInDirectory } from "./utils/isPathInDirectory";

const STATIC_DIR = join(__dirname, "..", "..", "static");
const DISPLAY_NAME_FONT_PATHS = new Set([
    "/fonts/display-name-style/great-vibes-latin.woff2",
    "/fonts/display-name-style/unifraktur-cook-latin.woff2",
    "/fonts/display-name-style/bangers-latin.woff2"
]);
const DISCORD_CLIENT_ORIGINS = new Set([
    "https://discord.com",
    "https://canary.discord.com",
    "https://ptb.discord.com"
]);

export async function handleVesktopStaticProtocol(path: string, req: Request) {
    const fullPath = join(STATIC_DIR, path);
    if (!isPathInDirectory(fullPath, STATIC_DIR)) {
        return new Response(null, { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(fullPath).href);
    if (!DISPLAY_NAME_FONT_PATHS.has(path) || !response.ok) return response;

    const headers = new Headers(response.headers);
    headers.set("content-type", "font/woff2");
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-content-type-options", "nosniff");

    const origin = req.headers.get("origin");
    if (origin && DISCORD_CLIENT_ORIGINS.has(origin)) {
        headers.set("access-control-allow-origin", origin);
        headers.append("vary", "Origin");
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

export function loadView(browserWindow: BrowserWindow, view: string, params?: URLSearchParams) {
    const url = new URL(`vesktop://static/views/${view}`);
    if (params) {
        url.search = params.toString();
    }

    return browserWindow.loadURL(url.toString());
}

/*
 * Discordmaxxer — CDP inspector
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Connects to a running Discordmaxxer launched via `pnpm start:dev:debug`
 * and runs DOM/visual checks against the Discord webview. Used to verify
 * plugin selectors and capture screenshots without needing eyeballs.
 *
 * Usage: node overlay-scripts/cdp-inspect.mjs <command>
 *   commands: status | selectors | screenshot | hotkey-toggle <ctrl+alt+x>
 */

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, "screenshots");

const DEBUG_URL = "http://localhost:9222";

async function connect() {
    const browser = await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null });
    const pages = await browser.pages();
    const discord = pages.find(p => p.url().includes("discord.com")) ?? pages[0];
    if (!discord) throw new Error("No Discord page found");
    return { browser, page: discord };
}

async function status() {
    const { page } = await connect();
    const url = page.url();
    const title = await page.title();
    const pluginInfo = await page.evaluate(() => {
        const v = (globalThis).Vencord;
        if (!v) return { error: "Vencord global not found" };
        const plugins = v.Plugins?.plugins ?? {};
        const pluginSettings = v.PlainSettings?.plugins ?? {};
        const watch = ["TournamentMode", "CompactView", "MassDelete", "DMBadge", "DMTheme", "VideoBackground", "DMHub", "BetterGifPicker", "FakeNitro", "MessageLogger", "PinDMs", "VolumeBooster", "ClearURLs"];
        return {
            vencordPresent: true,
            totalPlugins: Object.keys(plugins).length,
            enabledCount: Object.values(pluginSettings).filter(p => p?.enabled).length,
            seededField: v.PlainSettings?.discordmaxxerSeededPlugins?.length ?? "(missing — seeder fix not applied)",
            watchedPlugins: Object.fromEntries(watch.map(n => [n, {
                inRegistry: n in plugins,
                enabled: pluginSettings[n]?.enabled === true
            }]))
        };
    });
    console.log(JSON.stringify({ url, title, ...pluginInfo }, null, 2));
}

async function selectors() {
    const { page } = await connect();
    const result = await page.evaluate(() => {
        const probe = (name, sel) => {
            const els = document.querySelectorAll(sel);
            return {
                name,
                selector: sel,
                count: els.length,
                firstClass: els[0]?.className?.toString()?.slice(0, 80) ?? null,
                firstAriaLabel: els[0]?.getAttribute?.("aria-label") ?? null
            };
        };
        return {
            // CompactView's selectors
            "CompactView: server rail": probe("server rail", '[class*="guilds-"]'),
            "CompactView: channel sidebar": probe("channel sidebar", '[class*="sidebar-"]:not([class*="sidebarRegion"])'),
            "CompactView: member list (class)": probe("member list (class)", '[class*="membersWrap-"]'),
            "CompactView: member list (aria)": probe("member list (aria)", 'aside[aria-label*="ember" i]'),
            // Cleaner aria-label alternatives we should consider
            "Alternative: nav aria=Servers sidebar": probe("nav aria=Servers", 'nav[aria-label*="ervers" i]'),
            "Alternative: nav aria=Channels sidebar": probe("nav aria=Channels", 'nav[aria-label*="hannels" i]')
        };
    });
    console.log(JSON.stringify(result, null, 2));
}

async function screenshot(label = "current") {
    const { page } = await connect();
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const path = join(SCREENSHOTS_DIR, `${Date.now()}-${label}.png`);
    await page.screenshot({ path, type: "png" });
    console.log(`Screenshot saved: ${path}`);
}

async function hotkey(combo) {
    const { page } = await connect();
    const parts = combo.toLowerCase().split("+").map(s => s.trim());
    const modifiers = [];
    if (parts.includes("ctrl")) modifiers.push("Control");
    if (parts.includes("alt")) modifiers.push("Alt");
    if (parts.includes("shift")) modifiers.push("Shift");
    const key = parts[parts.length - 1];

    await page.bringToFront();
    for (const m of modifiers) await page.keyboard.down(m);
    await page.keyboard.press(key.length === 1 ? key.toUpperCase() : key);
    for (const m of modifiers.slice().reverse()) await page.keyboard.up(m);
    console.log(`Dispatched ${combo}`);
}

const cmd = process.argv[2];
const arg = process.argv[3];
const cmds = { status, selectors, screenshot: () => screenshot(arg ?? "current"), hotkey: () => hotkey(arg ?? "ctrl+alt+t") };

if (!cmd || !(cmd in cmds)) {
    console.error("Usage: node cdp-inspect.mjs <status|selectors|screenshot [label]|hotkey [combo]>");
    process.exit(1);
}

try {
    await cmds[cmd]();
    process.exit(0);
} catch (err) {
    console.error(`[cdp-inspect] ${cmd} failed:`, err.message);
    process.exit(1);
}

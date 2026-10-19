/*
 * Discordmaxxer — icon regeneration
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Rasterizes two .ico packs and a few PNGs:
 *
 *   build/icon.ico            — embedded in the .exe by electron-builder.
 *                               Drives the PINNED TASKBAR slot, Alt+Tab
 *                               thumbnail (when no setIcon override fires),
 *                               and the .exe icon shown in Explorer.
 *                               Source: build/tray-source.png (no bullet
 *                               holes — bullet holes blur to noise at
 *                               16-32px taskbar render sizes).
 *
 *   build/shortcut-icon.ico   — shipped as an extraResource and applied to
 *                               Start Menu + Desktop shortcuts via the
 *                               customInstall macro in build/installer.nsh.
 *                               Lets Diggy keep the bullet-holes horror-
 *                               Clyde character on shortcut surfaces while
 *                               the pinned taskbar gets the cleaner glyph.
 *                               Source: build/icon-source.png (with bullet
 *                               holes).
 *
 *   static/tray/tray.png      — Electron Tray (system notification area).
 *   static/tray/trayUnread.png  No bullet holes.
 *   static/taskbar/taskbar.png — Runtime BrowserWindow.setIcon override.
 *                               Redundant now that .exe icon = no-bullet-
 *                               holes, but kept as belt-and-suspenders.
 *
 * .icns (macOS) deferred to v0.2.
 *
 * Usage:
 *   pnpm add -D sharp png-to-ico
 *   pnpm regen-icons
 */

import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const HOLES_PNG = resolve(ROOT, "build", "icon-source.png");      // with bullet holes
const NO_HOLES_PNG = resolve(ROOT, "build", "tray-source.png");   // no bullet holes
const BRANDING_PNG = resolve(ROOT, "branding", "existing-dm-logo-render.png");
const SVG = resolve(ROOT, "build", "icon.svg");
const ICO = resolve(ROOT, "build", "icon.ico");                   // .exe / pinned taskbar (no holes)
const SHORTCUT_ICO = resolve(ROOT, "build", "shortcut-icon.ico"); // Start menu + desktop (with holes)
const TRAY_PNG = resolve(ROOT, "static", "tray", "tray.png");
const TRAY_UNREAD_PNG = resolve(ROOT, "static", "tray", "trayUnread.png");
const TASKBAR_PNG = resolve(ROOT, "static", "taskbar", "taskbar.png");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

let sharp, pngToIco;
try {
    sharp = (await import("sharp")).default;
    pngToIco = (await import("png-to-ico")).default;
} catch (e) {
    console.error("[regenIcons] missing deps:", e.message);
    console.error("Install with: pnpm add -D sharp png-to-ico");
    process.exit(1);
}

async function exists(p) {
    try { await access(p); return true; } catch { return false; }
}

async function loadSource(...candidates) {
    for (const p of candidates) {
        if (await exists(p)) {
            const buf = await readFile(p);
            const isSvg = p.toLowerCase().endsWith(".svg");
            return { path: p, buf, isSvg };
        }
    }
    throw new Error(`[regenIcons] no source found. Tried: ${candidates.join(", ")}`);
}

function makeSharp(src, density = 384) {
    return src.isSvg ? sharp(src.buf, { density }) : sharp(src.buf);
}

const noHolesSrc = await loadSource(NO_HOLES_PNG, HOLES_PNG, SVG);
console.log(`[regenIcons] no-bullet-holes source: ${noHolesSrc.path} (${noHolesSrc.buf.length} bytes)`);

const holesSrc = await loadSource(HOLES_PNG, SVG);
console.log(`[regenIcons] bullet-holes source:    ${holesSrc.path} (${holesSrc.buf.length} bytes)`);

// The taskbar is a user-facing identity surface. The old tray glyph is a
// tiny white face with transparent padding, which Windows can rasterize as a
// generic paper icon at taskbar size. Prefer the full Discordmaxxer brand mark
// here while keeping the existing executable/shortcut/tray sources stable.
const taskbarSrc = await loadSource(BRANDING_PNG, NO_HOLES_PNG, HOLES_PNG, SVG);
console.log(`[regenIcons] branded taskbar source:  ${taskbarSrc.path} (${taskbarSrc.buf.length} bytes)`);

// Tray + taskbar PNGs reuse the no-holes source; aliased for clarity below.
const traySrc = noHolesSrc;

// build/icon.ico — embedded in the .exe (pinned taskbar, .exe in Explorer,
// Alt+Tab fallback). No bullet holes.
const mainBuffers = [];
for (const size of ICO_SIZES) {
    const png = await makeSharp(noHolesSrc, 384)
        .resize(size, size)
        .png()
        .toBuffer();
    mainBuffers.push(png);
    console.log(`  no-holes ${size}x${size} (${png.length} bytes)`);
}
const ico = await pngToIco(mainBuffers);
await writeFile(ICO, ico);
console.log(`[regenIcons] wrote ${ICO} (${ico.length} bytes)`);

// build/shortcut-icon.ico — applied to Start Menu + Desktop .lnk via the
// customInstall macro in build/installer.nsh. No bullet holes — bullet
// holes were carrying through onto the pinned-taskbar slot (which uses
// the shortcut icon while the app is closed) and reading as noise at
// small sizes. Diggy's call 2026-05-12: cleaner glyph everywhere on
// system shell surfaces; bullet-holes mark stays for marketing/branding
// art only.
const shortcutBuffers = [];
for (const size of ICO_SIZES) {
    const png = await makeSharp(noHolesSrc, 384)
        .resize(size, size)
        .png()
        .toBuffer();
    shortcutBuffers.push(png);
    console.log(`  no-holes (shortcut) ${size}x${size} (${png.length} bytes)`);
}
const shortcutIco = await pngToIco(shortcutBuffers);
await writeFile(SHORTCUT_ICO, shortcutIco);
console.log(`[regenIcons] wrote ${SHORTCUT_ICO} (${shortcutIco.length} bytes)`);

// Tray PNGs — Windows + Linux read these directly. (macOS reads
// trayTemplate.png separately; deferred to v0.2 since template icons
// require monochrome alpha-only PNGs.)
const trayPng = await makeSharp(traySrc, 512)
    .resize(32, 32)
    .png()
    .toBuffer();
await writeFile(TRAY_PNG, trayPng);
console.log(`[regenIcons] wrote ${TRAY_PNG} (${trayPng.length} bytes)`);

// trayUnread: same silhouette with a 1px red border so users can distinguish
// "you have notifications" from "tray idle" at a glance.
const trayUnreadPng = await makeSharp(traySrc, 512)
    .resize(30, 30)
    .extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 255, g: 80, b: 80, alpha: 1 } })
    .png()
    .toBuffer();
await writeFile(TRAY_UNREAD_PNG, trayUnreadPng);
console.log(`[regenIcons] wrote ${TRAY_UNREAD_PNG} (${trayUnreadPng.length} bytes)`);

// Taskbar runtime override icon (Win32 BrowserWindow.setIcon). Use the full
// Discordmaxxer brand mark so Windows does not reduce the transparent tray
// glyph to a white paper-looking square. The shortcut/exe/tray sources stay
// unchanged. See src/main/mainWindow.ts.
const taskbarPng = await makeSharp(taskbarSrc, 512)
    .resize(256, 256)
    .png()
    .toBuffer();
await writeFile(TASKBAR_PNG, taskbarPng);
console.log(`[regenIcons] wrote ${TASKBAR_PNG} (${taskbarPng.length} bytes)`);

console.log("\n.icns + trayTemplate.png generation deferred to v0.2 (Mac target). For Mac:");
console.log("  - install iconutil or use https://github.com/idesis-gmbh/png2icons");
console.log("  - run an .icns step here that emits build/icon.icns");

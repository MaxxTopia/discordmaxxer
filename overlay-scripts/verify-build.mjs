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
    const REQUIRED_PLUGINS = ["TournamentMode", "DMVoiceKeybinds", "DMMicMonitor", "DMVoiceGuard", "DMHub", "DMTierFlair", "DMProfileCosmetics", "DMDisplayNameStyle", "DMEmoji", "DMTranslate", "DMImageContext"];
    for (const name of REQUIRED_PLUGINS) {
        if (renderer.includes(name)) ok(`plugin "${name}" compiled into renderer`);
        else fail(`plugin "${name}" NOT found in renderer bundle — overlay failed to include custom plugins`);
    }
}

// 2b) Regression contracts for native Discord interaction paths. These are
// deliberately source-level assertions: the renderer bundle can still be a
// valid JavaScript file after an overlay silently reclaims a native menu or
// hides a folder child. Fail the release before that behavior reaches users.
// Keep the source contract check on the same Vencord checkout used by the
// overlay builder. CI uses the repository-local clone; local release checks
// may intentionally point at a fresh pinned checkout when the cached source
// tree has older generated edits.
const overlaySourceRoot = join(resolve(process.env.DISCORDMAXXER_VENCORD_SRC ?? join(ROOT, "vencord-src")), "src");
if (!existsSync(overlaySourceRoot)) {
    fail("vencord-src is missing — native interaction regression contracts could not be verified");
} else {
    const readOverlaySource = relativePath => {
        const path = join(overlaySourceRoot, relativePath);
        if (!existsSync(path)) {
            fail(`missing overlay source ${relativePath} — native interaction contracts could not be verified`);
            return "";
        }
        return readFileSync(path, "utf8");
    };
    const webContextMenusSource = readOverlaySource("plugins/webContextMenus.web/index.ts");
    const dmImageContextSource = readFileSync(join(ROOT, "plugins", "DMImageContext", "index.tsx"), "utf8");
    if (webContextMenusSource.includes("const shouldAddBackMenus = () => false;")) {
        ok("desktop image/message context menus remain on Discord's native path (compatibility hook hard-disabled)");
    } else {
        fail("desktop native context-menu path is missing or the web replacement is forced on");
    }
    const imageMenuPredicates = webContextMenusSource.match(/predicate: shouldAddImageMenus,/g)?.length ?? 0;
    if (imageMenuPredicates >= 3) {
        ok("built-in image context-menu route is scoped and available (" + imageMenuPredicates + " predicates)");
    } else {
        fail("built-in image context-menu route is missing or not scoped away from the global listener swap");
    }
    const safeImageMenuMarkers = [
    'window.addEventListener("contextmenu", imageContextMenuHandler, true)',
        "nodeType === 1",
        'id: "dm-copy-image"',
        'label: "Copy Image"',
        "ContextMenuApi.openContextMenu",
        "navigator.clipboard.write"
    ];
    const missingSafeImageMenuMarkers = safeImageMenuMarkers.filter(marker => !dmImageContextSource.includes(marker));
    if (missingSafeImageMenuMarkers.length === 0) {
        ok("safe attachment-image menu includes a real Copy Image clipboard action");
    } else {
        fail(`safe attachment-image menu is incomplete: missing ${missingSafeImageMenuMarkers.join(", ")}`);
    }

    const desktopImageMenuMarkers = [
        'name: "DMImageContext"',
        "required: true",
        'window.addEventListener("contextmenu", imageContextMenuHandler, true)',
        'id: "dm-copy-image"',
        'label: "Copy Image"',
        "ContextMenuApi.openContextMenu",
        "nativeClipboard.copyImage"
    ];
    const missingDesktopImageMenuMarkers = desktopImageMenuMarkers.filter(marker => !dmImageContextSource.includes(marker));
    if (missingDesktopImageMenuMarkers.length === 0) {
        ok("required desktop image menu includes native Copy Image handling");
    } else {
        fail(`required desktop image menu is incomplete: missing ${missingDesktopImageMenuMarkers.join(", ")}`);
    }
    if (webContextMenusSource.includes("required: IS_DISCORD_DESKTOP || IS_VESKTOP,") && webContextMenusSource.includes("enabledByDefault: true,")) {
        ok("native composer menu bridge is required and enabled by default on desktop");
    } else {
        fail("native composer menu bridge is not enabled on the desktop path");
    }
    if (webContextMenusSource.includes("const shouldAddBackMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;")) {
        fail("web context menus still intercept the desktop native path");
    }
    const guardedWebContextPatches = [
        ...(webContextMenusSource.match(/predicate: shouldAddBackMenus,/g) ?? []),
        ...(webContextMenusSource.match(/predicate: shouldAddComposerMenus,/g) ?? [])
    ].length;
    if (guardedWebContextPatches >= 9) {
        ok(`web context-menu patches are fail-open guarded (${guardedWebContextPatches} predicates)`);
    } else {
        fail("one or more web context-menu patches can still modify native Discord menus");
    }
    const composerMarkers = [
        "const shouldAddComposerMenus = () => IS_DISCORD_DESKTOP || IS_VESKTOP || settings.store.addBack;",
        "function isComposerTarget(event: Event)",
        "let composerContextMenuRouter: ((event: MouseEvent) => void) | null = null;",
        "window.addEventListener(\"contextmenu\", router)",
        "predicate: shouldAddComposerMenus,"
    ];
    const missingComposerMarkers = composerMarkers.filter(marker => !webContextMenusSource.includes(marker));
    if (missingComposerMarkers.length === 0) {
        ok("message composer uses a narrow native context-menu bridge while other menus stay fail-open");
    } else {
        fail(`native composer context-menu bridge is incomplete: missing ${missingComposerMarkers.join(", ")}`);
    }
    const pluginManagerSource = readOverlaySource("api/PluginManager.ts");
    if (/DISCORDMAXXER_NATIVE_MENU_IDS\.has\(navId\) && !DISCORDMAXXER_NATIVE_MENU_PATCH_PLUGINS\.has\(name\)/.test(pluginManagerSource) &&
        /DISCORDMAXXER_NATIVE_MENU_PATCH_PLUGINS = new Set\(\["MessageLogger", "WebContextMenus"\]\)/.test(pluginManagerSource)) {
        ok("unsafe message/image menu patches stay blocked while MessageLogger history and native desktop menus remain available");
    } else {
        fail("PluginManager does not preserve the native menu boundary around WebContextMenus");
    }
    const imageZoomSource = readOverlaySource("plugins/imageZoom/index.tsx");
    if (imageZoomSource.includes("Discordmaxxer: preserve native attachment image node.")) {
        ok("ImageZoom preserves Discord's native attachment image node");
    } else {
        fail("ImageZoom native attachment image-node safeguard is missing");
    }
    if (imageZoomSource.includes('"image-context": imageContextMenuPatch')) {
        fail("ImageZoom still owns Discord's native image context-menu route");
    }

    const tournamentModeSource = readFileSync(join(ROOT, "plugins", "TournamentMode", "index.ts"), "utf8");
    const mediaViewerMotionMarkers = [
        'html[data-dm-tournament-mode] [role="dialog"]',
        '[class*="mediaViewer"]',
        '[class*="imageModal"]',
        "animation-play-state: running !important;"
    ];
    const missingMediaViewerMotionMarkers = mediaViewerMotionMarkers.filter(marker => !tournamentModeSource.includes(marker));
    if (missingMediaViewerMotionMarkers.length === 0) {
        ok("Tournament Mode leaves native media-viewer/modal entrance animations running");
    } else {
        fail(`Tournament Mode media-viewer animation safeguard is incomplete: missing ${missingMediaViewerMotionMarkers.join(", ")}`);
    }

    const betterFoldersSource = readOverlaySource("plugins/betterFolders/index.tsx");
    const guardedFolderPredicates = betterFoldersSource.match(/predicate: \(\) => settings\.store\.sidebar && DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED/g)?.length ?? 0;
    if (betterFoldersSource.includes("export const DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED = false;") && guardedFolderPredicates >= 3) {
        ok(`BetterFolders custom interception is fail-open guarded (${guardedFolderPredicates} predicates)`);
    } else {
        fail("BetterFolders custom interception is not fully guarded behind the disabled sidebar bridge");
    }

    const folderSidebarSource = readOverlaySource("plugins/betterFolders/FolderSideBar.tsx");
    const hasFolderIdHelper = folderSidebarSource.includes("const folderId = normalizedId(data?.folderId ?? data?.id);") ||
        folderSidebarSource.includes("const folderId = normalizeFolderId(folder.folderId);");
    if (folderSidebarSource.includes("if (!DISCORDMAXXER_CUSTOM_SIDEBAR_SUPPORTED) return null;") && hasFolderIdHelper) {
        ok("unsupported custom folder sidebar fails open and uses the shared ID helper");
    } else {
        fail("custom folder sidebar still has an unsafe mount or undefined folder-ID helper");
    }

    const messageLoggerSource = readOverlaySource("plugins/messageLogger/index.tsx");
    const messageLoggerMarkers = [
        "Discordmaxxer: harden MessageLogger context history.",
        "props?.message",
        "MessageStore.getMessage",
        'label=\"Remove Message History\"'
    ];
    const missingMessageLoggerMarkers = messageLoggerMarkers.filter(marker => !messageLoggerSource.includes(marker));
    if (missingMessageLoggerMarkers.length === 0) {
        ok("MessageLogger resolves full deleted/edit history before adding its context actions");
    } else {
        fail(`MessageLogger history action hardening is incomplete: missing ${missingMessageLoggerMarkers.join(", ")}`);
    }

    const dmEmojiSource = readFileSync(join(ROOT, "plugins", "DMEmoji", "index.tsx"), "utf8");
    const dmEmojiPreviewMarkers = [
        "normalizePendingUploads",
        "PENDING_UPLOAD_GRACE_MS",
        "pendingUploadsSignature",
        "nativePreviewRefreshRef",
        "failedPreviewIds",
        "removePendingUpload",
        "onError={markMediaFailed}",
        "naturalWidth > 0",
        "readyState >= 2",
        "uploadsSignatureRef.current = \"\";"
    ];
    const missingDmEmojiMarkers = dmEmojiPreviewMarkers.filter(marker => !dmEmojiSource.includes(marker));
    if (missingDmEmojiMarkers.length === 0) {
        ok("DMEmoji attachment preview has stable upload identity and loaded-media detection");
    } else {
        fail(`DMEmoji attachment preview hardening is incomplete: missing ${missingDmEmojiMarkers.join(", ")}`);
    }

    const dmHubSource = readFileSync(join(ROOT, "plugins", "DMHub", "index.ts"), "utf8");
    const dmHubMarkers = [
        "const ACCOUNT_PANEL_SELECTOR",
        "const ACCOUNT_TOOLBAR_SELECTOR",
        'button[aria-label*=\"mute\" i]',
        "data-dm-account-surface",
        "buttonsRow.insertBefore(fab, anchor)"
    ];
    const missingDmHubMarkers = dmHubMarkers.filter(marker => !dmHubSource.includes(marker));
    if (missingDmHubMarkers.length === 0) {
        ok("DMHub is anchored to the real account-panel toolbar and reinsertable after Discord re-renders it");
    } else {
        fail(`DMHub account-bar anchoring is incomplete: missing ${missingDmHubMarkers.join(", ")}`);
    }

    const dmTrimSource = readFileSync(join(ROOT, "plugins", "DMTrim", "index.ts"), "utf8");
    if (
        dmTrimSource.includes('[class*="panels_"] > [class*="container_"]') &&
        dmTrimSource.includes('div[class*="questBar_"]') &&
        !dmTrimSource.includes('div[class*="questBar" i]')
    ) {
        ok("DMTrim protects the account panel and does not ship the broad QuestBar selector");
    } else {
        fail("DMTrim account-panel protection or narrowed QuestBar selector is missing");
    }

    // Profile badges are evaluated once per viewed user. Keep the current
    // account's private/local tier override behind an explicit user-ID guard;
    // every other profile must resolve through the public roster. This is a
    // source-level regression contract for the cross-account isolation rule.
    const tierFlairSource = readFileSync(join(ROOT, "plugins", "DMTierFlair", "index.tsx"), "utf8");
    const tierIsolationContract = /function getDisplayTier\(userId: string\): Tier[\s\S]*?if \(UserStore\.getCurrentUser\(\)\?\.id === userId\) return getMyTier\(\);[\s\S]*?return getRosterTier\(userId\);/.test(tierFlairSource);
    const tierFlairMarkers = [
        'shouldShow: ({ userId }: { userId: string }) => getDisplayTier(userId) >= Tier.MAXXER_PLUS_PLUS',
        "const tier = getDisplayTier(userId);",
        '[data-dm-tier], [data-dm-founder], [data-dm-tier-for]',
        "delete el.dataset.dmTierFor;"
    ];
    const missingTierFlairMarkers = tierFlairMarkers.filter(marker => !tierFlairSource.includes(marker));
    if (tierIsolationContract && missingTierFlairMarkers.length === 0) {
        ok("profile tier badges stay isolated to the viewed user ID");
    } else {
        const reasons = [
            !tierIsolationContract ? "self-tier guard or other-user roster fallback is missing" : "",
            ...missingTierFlairMarkers.map(marker => `missing ${marker}`)
        ].filter(Boolean);
        fail(`profile tier badge isolation contract is incomplete: ${reasons.join(", ")}`);
    }

    const dmBadgeSource = readFileSync(join(ROOT, "plugins", "DMBadge", "index.tsx"), "utf8");
    if (dmBadgeSource.includes("shouldShow: ({ userId }) => knownIds.has(userId) || getRosterTier(userId) !== Tier.FREE")) {
        ok("generic Discordmaxxer badge also resolves against the viewed user ID");
    } else {
        fail("generic Discordmaxxer badge is missing its viewed-user ID gate");
    }
}

// 3) The Vesktop shell build output (what electron-builder packages).
const shellRenderer = join(ROOT, "dist", "js", "renderer.js");
if (!existsSync(shellRenderer)) fail("dist/js/renderer.js missing — `pnpm build` did not produce the shell bundle");
else if (sizeKB(shellRenderer) < 50) fail(`dist/js/renderer.js is only ${sizeKB(shellRenderer).toFixed(1)}KB — likely a failed build`);
else ok(`dist/js/renderer.js present (${sizeKB(shellRenderer).toFixed(0)}KB)`);

// 4) Startup recovery must ship with the shell. A normal TypeScript/build
// check cannot catch accidentally omitting the recovery view or reverting the
// watchdog wiring, which would put users back into an unrecoverable blank
// window after a bad renderer/plugin start.
const recoveryView = join(ROOT, "static", "views", "startup-recovery.html");
if (!existsSync(recoveryView)) {
    fail("static/views/startup-recovery.html missing — startup failures would have no recovery UI");
} else {
    const recoveryMarkup = readFileSync(recoveryView, "utf8");
    for (const control of ['id="retry"', 'id="restart"', 'id="log"']) {
        if (recoveryMarkup.includes(control)) ok(`startup recovery view includes ${control}`);
        else fail(`startup recovery view is missing ${control}`);
    }
}

const shellMain = join(ROOT, "dist", "js", "main.js");
const shellPreload = join(ROOT, "dist", "js", "preload.js");
const startupMarkers = [
    [shellMain, "did-fail-load", "main-process navigation watchdog"],
    [shellMain, "startup-timeout-recovery-scheduled", "automatic startup timeout recovery"],
    [shellMain, "renderer-probe-started", "navigation-commit startup surface probe"],
    [shellMain, "Discord did not finish loading after automatic recovery attempts.", "terminal startup timeout diagnostic"],
    [shellMain, "The plugin engine did not become ready within the startup timeout.", "plugin preparation timeout"],
    [shellMain, "renderer-liveness-failure", "post-startup renderer liveness watchdog"],
    [shellMain, "surface-hidden", "visible Discord surface probe"],
    [shellPreload, "DM_STARTUP_ERROR", "renderer startup error reporting"],
    [shellPreload, "renderer-script-load", "empty renderer bundle reporting"]
];
for (const [file, marker, description] of startupMarkers) {
    if (!existsSync(file) || !readFileSync(file, "utf8").includes(marker)) {
        fail(`${description} marker is missing from ${file.replace(ROOT + "\\", "")}`);
    } else {
        ok(`${description} is present`);
    }
}

if (errors.length) {
    console.error(`\n[verify] ✗ FAILED — ${errors.length} integrity problem(s). Refusing to publish this build.`);
    process.exit(1);
}
console.log("\n[verify] ✅ Build artifacts look structurally sound.");

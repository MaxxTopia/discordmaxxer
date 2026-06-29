/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater, UpdateInfo } from "electron-updater";
import { join } from "path";
import { IpcEvents, UpdaterIpcEvents } from "shared/IpcEvents";
import { Millis } from "shared/utils/millis";

import { State } from "./settings";
import { handle } from "./utils/ipcWrappers";
import { makeLinksOpenExternally } from "./utils/makeLinksOpenExternally";
import { loadView } from "./vesktopStatic";

let updaterWindow: BrowserWindow | null = null;

autoUpdater.on("update-available", update => {
    if (State.store.updater?.ignoredVersion === update.version) return;
    // Snooze is version-specific — snoozing v0.7.12 must not silence
    // v0.7.13/v0.7.14. Without the version check a 24h snooze was eating
    // every release that landed during that window (burned 2026-05-11).
    if (
        State.store.updater?.snoozedVersion === update.version &&
        (State.store.updater?.snoozeUntil ?? 0) > Date.now()
    )
        return;

    openUpdater(update);
});

autoUpdater.on("update-downloaded", () => setTimeout(() => autoUpdater.quitAndInstall(), 100));
autoUpdater.on("download-progress", p =>
    updaterWindow?.webContents.send(UpdaterIpcEvents.DOWNLOAD_PROGRESS, p.percent)
);
autoUpdater.on("error", err => {
    // Surface to the updater window if it's open, AND always log — the
    // startup checkForUpdates() runs before any window exists, so without
    // a log a network/auth failure was completely invisible (burned
    // 2026-05-11 diagnosing why a v0.7.14 prompt didn't fire).
    updaterWindow?.webContents.send(UpdaterIpcEvents.ERROR, err.message);
    console.error("[Discordmaxxer updater]", err);
});

autoUpdater.autoDownload = false;
// Apply a downloaded update on the next natural quit. Pairs with the
// existing prompt: clicking Install kicks off downloadUpdate(), and even
// if the user closes the updater window without restarting, the file is
// applied silently when they next quit Discord — no more "I clicked
// Install but nothing happened" failure modes.
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.fullChangelog = true;

// Discordmaxxer — beta-builds opt-in (MAXXER++ tier perk). When State.store
// .allowPrerelease is true, electron-updater accepts prerelease GitHub
// releases (tagged vX.Y.Z-beta.N) in addition to stable. Default off.
autoUpdater.allowPrerelease = State.store.allowPrerelease ?? false;

const isOutdated = autoUpdater
    .checkForUpdates()
    .then(res => Boolean(res?.isUpdateAvailable))
    .catch(err => {
        // Startup check fires before any updater window exists, so the
        // 'error' handler above won't be able to surface this to the UI.
        // Log so it's at least diagnosable from devtools / the console.
        console.error("[Discordmaxxer updater] startup checkForUpdates failed:", err);
        return false;
    });

// H2 (audit 2026-06-26): the checkForUpdates() above runs exactly ONCE at
// startup. A client left open for days/weeks would never discover a fix release
// until restart — and "ship the next build" is the entire recovery model (the
// zstd voice outage relied on users getting the next version). Re-check every
// 6h. Skip while the updater prompt is already open or a download is in flight
// so we never stack windows or interrupt an install.
let updateDownloading = false;
autoUpdater.on("download-progress", () => (updateDownloading = true));
autoUpdater.on("update-downloaded", () => (updateDownloading = false));

setInterval(() => {
    if (updaterWindow || updateDownloading) return;
    autoUpdater
        .checkForUpdates()
        .catch(err => console.warn("[Discordmaxxer updater] periodic checkForUpdates failed:", err));
}, 6 * Millis.HOUR);

handle(IpcEvents.UPDATER_IS_OUTDATED, () => isOutdated);
handle(IpcEvents.UPDATER_OPEN, async () => {
    const res = await autoUpdater.checkForUpdates();
    if (res?.isUpdateAvailable && res.updateInfo) openUpdater(res.updateInfo);
});

handle(IpcEvents.DM_GET_ALLOW_PRERELEASE, () => State.store.allowPrerelease ?? false);
handle(IpcEvents.DM_SET_ALLOW_PRERELEASE, async (_e, on: boolean) => {
    State.store.allowPrerelease = !!on;
    autoUpdater.allowPrerelease = !!on;
    // Re-check immediately so a freshly-flipped beta opt-in surfaces a
    // pending beta release without waiting for the next periodic check.
    try {
        const res = await autoUpdater.checkForUpdates();
        if (res?.isUpdateAvailable && res.updateInfo) openUpdater(res.updateInfo);
    } catch (e) {
        console.warn("[Discordmaxxer] DM_SET_ALLOW_PRERELEASE checkForUpdates failed:", e);
    }
});

function openUpdater(update: UpdateInfo) {
    // Guard against double-open: a manual check (UPDATER_OPEN) or beta-toggle
    // (DM_SET_ALLOW_PRERELEASE) can fire while the updater window is already
    // open. Re-registering the UpdaterIpcEvents handlers below would throw
    // ("second handler") and orphan a window. Just focus the existing one.
    if (updaterWindow && !updaterWindow.isDestroyed()) {
        updaterWindow.focus();
        return;
    }

    updaterWindow = new BrowserWindow({
        title: "Discordmaxxer Updater",
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, "updaterPreload.js")
        },
        minHeight: 400,
        minWidth: 750
    });
    makeLinksOpenExternally(updaterWindow);

    handle(UpdaterIpcEvents.GET_DATA, () => ({ update, version: app.getVersion() }));
    handle(UpdaterIpcEvents.INSTALL, async () => {
        await autoUpdater.downloadUpdate();
    });
    handle(UpdaterIpcEvents.SNOOZE_UPDATE, () => {
        State.store.updater ??= {};
        State.store.updater.snoozeUntil = Date.now() + 1 * Millis.DAY;
        State.store.updater.snoozedVersion = update.version;
        updaterWindow?.close();
    });
    handle(UpdaterIpcEvents.IGNORE_UPDATE, () => {
        State.store.updater ??= {};
        State.store.updater.ignoredVersion = update.version;
        updaterWindow?.close();
    });

    updaterWindow.on("closed", () => {
        ipcMain.removeHandler(UpdaterIpcEvents.GET_DATA);
        ipcMain.removeHandler(UpdaterIpcEvents.INSTALL);
        ipcMain.removeHandler(UpdaterIpcEvents.SNOOZE_UPDATE);
        ipcMain.removeHandler(UpdaterIpcEvents.IGNORE_UPDATE);
        updaterWindow = null;
    });

    loadView(updaterWindow, "updater/index.html");
}

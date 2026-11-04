/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, dialog } from "electron";
import { rm } from "fs/promises";
import { DATA_DIR, MessageBoxChoice } from "main/constants";

export async function clearData(win: BrowserWindow) {
    const { response } = await dialog.showMessageBox(win, {
        message: "Are you sure you want to reset Discordmaxxer?",
        detail: "This will log you out, clear caches and reset all your settings!\n\nDiscordmaxxer will automatically restart after this operation.",
        buttons: ["Yes", "No"],
        cancelId: MessageBoxChoice.Cancel,
        defaultId: MessageBoxChoice.Default,
        type: "warning"
    });

    if (response === MessageBoxChoice.Cancel) return;

    const discordSession = win.webContents.session;
    win.close();

    // Reset is invoked from a tray/menu callback. Keep cleanup failures from
    // becoming an unhandled rejection that takes down the main process.
    const cleanup = [
        ["storage data", () => discordSession.clearStorageData()],
        ["cache", () => discordSession.clearCache()],
        ["code cache", () => discordSession.clearCodeCaches({})],
        ["profile data", () => rm(DATA_DIR, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })]
    ] as const;

    for (const [label, task] of cleanup) {
        try {
            await task();
        } catch (error) {
            console.warn(`[Discordmaxxer] Reset could not clear ${label}; continuing:`, error);
        }
    }

    app.relaunch();
    app.quit();
}

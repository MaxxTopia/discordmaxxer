/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { SplashProps } from "shared/browserWinProperties";

import { Settings } from "./settings";
import { loadView } from "./vesktopStatic";

let splash: BrowserWindow | undefined;
let recoveryWindow: BrowserWindow | undefined;

type StartupRecoveryHandlers = {
    retry: () => void;
    restart: () => void;
    openLog: () => void;
};

let recoveryHandlers: StartupRecoveryHandlers | undefined;
let recoveryIpcRegistered = false;

export function registerStartupRecoveryHandlers(handlers: StartupRecoveryHandlers) {
    recoveryHandlers = handlers;

    if (recoveryIpcRegistered) return;
    recoveryIpcRegistered = true;

    ipcMain.on("startup-recovery-retry", () => recoveryHandlers?.retry());
    ipcMain.on("startup-recovery-restart", () => recoveryHandlers?.restart());
    ipcMain.on("startup-recovery-open-log", () => recoveryHandlers?.openLog());
}

export function createSplashWindow(startMinimized = false) {
    splash = new BrowserWindow({
        ...SplashProps,
        show: !startMinimized,
        webPreferences: {
            preload: join(__dirname, "splashPreload.js")
        }
    });

    loadView(splash, "splash.html");

    const { splashBackground, splashColor, splashTheming, splashPixelated } = Settings.store;

    if (splashTheming !== false) {
        if (splashColor) {
            const semiTransparentSplashColor = splashColor.replace("rgb(", "rgba(").replace(")", ", 0.2)");

            splash.webContents.insertCSS(`body { --fg: ${splashColor} !important }`);
            splash.webContents.insertCSS(`body { --fg-semi-trans: ${semiTransparentSplashColor} !important }`);
        }

        if (splashBackground) {
            splash.webContents.insertCSS(`body { --bg: ${splashBackground} !important }`);
        }
    }

    if (splashPixelated) {
        splash.webContents.insertCSS(`img { image-rendering: pixelated; }`);
    }

    return splash;
}

export function updateSplashMessage(message: string) {
    if (splash && !splash.isDestroyed()) splash.webContents.send("update-splash-message", message);
}

function createRecoveryWindow() {
    return new BrowserWindow({
        ...SplashProps,
        width: 760,
        height: 520,
        minWidth: 620,
        minHeight: 420,
        show: false,
        resizable: true,
        webPreferences: {
            preload: join(__dirname, "splashPreload.js")
        }
    });
}

export function showStartupRecovery(reason: string, diagnosticId: string, version: string) {
    const window = splash && !splash.isDestroyed() ? splash : (recoveryWindow ??= createRecoveryWindow());
    const params = new URLSearchParams({
        reason: reason.slice(0, 600),
        diagnostic: diagnosticId.slice(0, 120),
        version: version.slice(0, 40)
    });

    window.setSize(760, 520);
    window.center();
    window.show();
    window.focus();
    void loadView(window, "startup-recovery.html", params).catch(error => {
        console.error("[splash] failed to load startup recovery view:", error);
    });
}

export function closeStartupRecovery() {
    if (!recoveryWindow || recoveryWindow.isDestroyed()) {
        recoveryWindow = undefined;
        return;
    }

    recoveryWindow.destroy();
    recoveryWindow = undefined;
}

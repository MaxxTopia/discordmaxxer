/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer } from "electron/renderer";

contextBridge.exposeInMainWorld("VesktopSplashNative", {
    onUpdateMessage(callback: (message: string) => void) {
        ipcRenderer.on("update-splash-message", (_, message: string) => callback(message));
    },
    retryStartup() {
        ipcRenderer.send("startup-recovery-retry");
    },
    restartStartup() {
        ipcRenderer.send("startup-recovery-restart");
    },
    openStartupLog() {
        ipcRenderer.send("startup-recovery-open-log");
    }
});

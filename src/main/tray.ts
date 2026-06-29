/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, Menu, Tray } from "electron";

import { createAboutWindow } from "./about";
import { AppEvents } from "./events";
import { Settings } from "./settings";
import { resolveAssetPath } from "./userAssets";
import { clearData } from "./utils/clearData";
import { downloadVencordFiles } from "./utils/vencordLoader";

let tray: Tray | null = null;
let trayVariant: "tray" | "trayUnread" = "tray";

AppEvents.on("userAssetChanged", async asset => {
    if (tray && (asset === "tray" || asset === "trayUnread")) {
        const img = await resolveAssetPath(trayVariant);
        // tray may have been destroyed during the await
        if (tray && !tray.isDestroyed()) tray.setImage(img);
    }
});

AppEvents.on("setTrayVariant", async variant => {
    if (trayVariant === variant) return;

    trayVariant = variant;
    if (!tray) return;

    const img = await resolveAssetPath(trayVariant);
    if (tray && !tray.isDestroyed()) tray.setImage(img);
});

export function destroyTray() {
    tray?.destroy();
    // Null the reference — the listeners above guard on `tray`, but a
    // destroyed-but-non-null Tray would still reach setImage() and throw.
    tray = null;
}

export async function initTray(win: BrowserWindow, setIsQuitting: (val: boolean) => void) {
    const onTrayClick = () => {
        if (Settings.store.clickTrayToShowHide && win.isVisible()) win.hide();
        else win.show();
    };

    const trayMenu = Menu.buildFromTemplate([
        {
            label: "Open",
            click() {
                win.show();
            }
        },
        {
            label: "About",
            click: createAboutWindow
        },
        {
            label: "Repair Plugin Engine",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Reset Discordmaxxer",
            async click() {
                await clearData(win);
            }
        },
        {
            type: "separator"
        },
        {
            label: "Restart",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        {
            label: "Quit",
            click() {
                setIsQuitting(true);
                app.quit();
            }
        }
    ]);

    tray = new Tray(await resolveAssetPath(trayVariant));
    tray.setToolTip("Discordmaxxer");
    tray.setContextMenu(trayMenu);
    tray.on("click", onTrayClick);
}

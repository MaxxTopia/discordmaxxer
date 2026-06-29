/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { BrowserWindow } from "electron/main";
import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { SplashProps } from "shared/browserWinProperties";

import { autoStart } from "./autoStart";
import { DATA_DIR } from "./constants";
import { createWindows } from "./mainWindow";
import { Settings, State } from "./settings";
import { makeLinksOpenExternally } from "./utils/makeLinksOpenExternally";
import { loadView } from "./vesktopStatic";

interface Data {
    discordBranch: "stable" | "canary" | "ptb";
    minimizeToTray?: "on";
    autoStart?: "on";
    importSettings?: "on";
    richPresence?: "on";
    skipTips?: "on";
}

export function createFirstLaunchTour() {
    const win = new BrowserWindow({
        ...SplashProps,
        transparent: false,
        frame: true,
        autoHideMenuBar: true,
        height: 550,
        width: 600
    });

    makeLinksOpenExternally(win);

    loadView(win, "first-launch.html");
    win.webContents.addListener("console-message", (_e, _l, msg) => {
        if (msg === "cancel") return app.exit();

        if (!msg.startsWith("form:")) return;
        let data: Data;
        try {
            data = JSON.parse(msg.slice(5)) as Data;
        } catch (e) {
            console.error("[Discordmaxxer] first-launch form parse failed:", e);
            return;
        }

        State.store.firstLaunch = false;
        State.store.discordmaxxerSkipTips = !!data.skipTips;
        // Validate the branch against the known set — it later becomes the
        // Discord subdomain in loadUrl(), so a bad value yields a broken load.
        Settings.store.discordBranch = ["stable", "canary", "ptb"].includes(data.discordBranch)
            ? data.discordBranch
            : "stable";
        Settings.store.minimizeToTray = !!data.minimizeToTray;
        Settings.store.arRPC = !!data.richPresence;

        if (data.autoStart) autoStart.enable();

        if (data.importSettings) {
            // Look for any prior client install's settings dir under userData's parent.
            // Order: discordmaxxer's prior install, vencord (legacy), vesktop (legacy).
            const candidates = ["Discordmaxxer", "Vencord", "Vesktop"]
                .map(name => join(app.getPath("userData"), "..", name, "settings"))
                .filter(p => p !== join(DATA_DIR, "settings")); // never copy from self
            const to = join(DATA_DIR, "settings");
            for (const from of candidates) {
                try {
                    const files = readdirSync(from);
                    mkdirSync(to, { recursive: true });
                    for (const file of files) copyFileSync(join(from, file), join(to, file));
                    console.log(`[Discordmaxxer] Imported settings from ${from}`);
                    break;
                } catch (e) {
                    if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
                    console.error(`Failed to import settings from ${from}:`, e);
                }
            }
        }

        win.close();

        createWindows();
    });
}

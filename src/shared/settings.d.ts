/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Rectangle } from "electron";

export interface Settings {
    discordBranch?: "stable" | "canary" | "ptb";
    transparencyOption?: "none" | "mica" | "tabbed" | "acrylic";
    tray?: boolean;
    minimizeToTray?: boolean;
    autoStartMinimized?: boolean;
    openLinksWithElectron?: boolean;
    staticTitle?: boolean;
    enableMenu?: boolean;
    disableSmoothScroll?: boolean;
    hardwareAcceleration?: boolean;
    hardwareVideoAcceleration?: boolean;
    arRPC?: boolean;
    appBadge?: boolean;
    enableTaskbarFlashing?: boolean;
    disableMinSize?: boolean;
    clickTrayToShowHide?: boolean;
    customTitleBar?: boolean;

    enableSplashScreen?: boolean;
    splashTheming?: boolean;
    splashColor?: string;
    splashBackground?: string;
    splashPixelated?: boolean;

    // When true, force Chromium's Windows Graphics Capture path for WebRTC
    // screenshare. WGC composites the system cursor into per-window captures
    // of exclusive-fullscreen games (e.g. Fortnite) — but on some Windows
    // audio setups it also prevents the "loopback" audio request from
    // capturing system audio, leading to silent screenshares. Off by default
    // for that reason. Requires a full app restart to take effect.
    screenshareForceWgc?: boolean;

    // When ON, screenshare audio re-captures per-window audio (anti-echo swap
    // in screenShareFixes.ts). OFF by default: the swap runs a desktop-audio
    // getUserMedia that can crash the renderer on some Windows audio setups, so
    // stream audio just uses plain system loopback (which works and only echoes
    // if you're listening on speakers, not headphones). Requires a restart.
    screensharePerWindowAudio?: boolean;

    spellCheckLanguages?: string[];

    audio?: {
        workaround?: boolean;

        deviceSelect?: boolean;
        granularSelect?: boolean;

        ignoreVirtual?: boolean;
        ignoreDevices?: boolean;
        ignoreInputMedia?: boolean;

        onlySpeakers?: boolean;
        onlyDefaultSpeakers?: boolean;
    };
}

export interface State {
    maximized?: boolean;
    minimized?: boolean;
    windowBounds?: Rectangle;

    firstLaunch?: boolean;

    steamOSLayoutVersion?: number;
    linuxAutoStartEnabled?: boolean;

    vencordDir?: string;

    updater?: {
        ignoredVersion?: string;
        snoozeUntil?: number;
        snoozedVersion?: string;
    };

    /** Discordmaxxer — MAXXER++ "beta builds" perk. When true,
     *  electron-updater accepts prerelease GitHub releases (vX.Y.Z-beta.N) */
    allowPrerelease?: boolean;
}

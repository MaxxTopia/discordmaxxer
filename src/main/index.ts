/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./cli";
import "./updater";
import "./ipc";
import "./discordmaxxerHotkeys";
import "./discordmaxxerPerf";
import "./discordmaxxerHwid";
import "./userAssets";
import "./winaudio";
import "./vesktopProtocol";
// dmMediaProxy MUST be imported before app.whenReady fires — its module
// side effect registers `dm-media://` as a privileged scheme.
import "./dmMediaProxy";

import { app, BrowserWindow, nativeTheme } from "electron";

import { DATA_DIR } from "./constants";
import { applyRemotelyDisabledPlugins, seedDiscordmaxxerDefaults } from "./discordmaxxerDefaults";
import { createFirstLaunchTour } from "./firstLaunch";
import { createWindows, mainWin } from "./mainWindow";
import { registerMediaPermissionsHandler } from "./mediaPermissions";
import { applyRemoteLaunchFlags, getRemotelyDisabledPlugins, refreshRemoteConfig } from "./remoteConfig";
import { registerScreenShareHandler } from "./screenShare";
import { Settings, State } from "./settings";
import { setAsDefaultProtocolClient } from "./utils/setAsDefaultProtocolClient";
import { isDeckGameMode } from "./utils/steamOS";

console.log("Discordmaxxer v" + app.getVersion());

// Make the Vencord files use our DATA_DIR
process.env.VENCORD_USER_DATA_DIR = DATA_DIR;

const isLinux = process.platform === "linux";

export let enableHardwareAcceleration = true;

function init() {
    setAsDefaultProtocolClient("discord");

    const { disableSmoothScroll, hardwareAcceleration, hardwareVideoAcceleration } = Settings.store;

    const enabledFeatures = new Set(app.commandLine.getSwitchValue("enable-features").split(","));
    const disabledFeatures = new Set(app.commandLine.getSwitchValue("disable-features").split(","));
    app.commandLine.removeSwitch("enable-features");
    app.commandLine.removeSwitch("disable-features");

    if (hardwareAcceleration === false || process.argv.includes("--disable-gpu")) {
        enableHardwareAcceleration = false;
        app.disableHardwareAcceleration();
    } else {
        if (hardwareVideoAcceleration) {
            enabledFeatures.add("AcceleratedVideoEncoder");
            enabledFeatures.add("AcceleratedVideoDecoder");

            if (isLinux) {
                enabledFeatures.add("AcceleratedVideoDecodeLinuxGL");
                enabledFeatures.add("AcceleratedVideoDecodeLinuxZeroCopyGL");
            }
        }
    }

    if (disableSmoothScroll) {
        app.commandLine.appendSwitch("disable-smooth-scrolling");
    }

    // disable renderer backgrounding to prevent the app from unloading when in the background
    // https://github.com/electron/electron/issues/2822
    // https://github.com/GoogleChrome/chrome-launcher/blob/5a27dd574d47a75fec0fb50f7b774ebf8a9791ba/docs/chrome-flags-for-tools.md#task-throttling
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-background-timer-throttling");
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    if (process.platform === "win32") {
        disabledFeatures.add("CalculateNativeWinOcclusion");
    }

    // work around chrome 66 disabling autoplay by default
    app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

    // WinRetrieveSuggestionsOnlyOnDemand: Work around electron 13 bug w/ async spellchecking on Windows.
    // HardwareMediaKeyHandling, MediaSessionService: Prevent Discord from registering as a media service.
    disabledFeatures.add("WinRetrieveSuggestionsOnlyOnDemand");
    disabledFeatures.add("HardwareMediaKeyHandling");
    disabledFeatures.add("MediaSessionService");

    // OPT-IN: force Chromium's Windows Graphics Capture API for screenshare.
    // WGC composites the system cursor into the captured frame for both window
    // and screen sources, whereas the legacy GDI/BitBlt path drops the cursor
    // on per-window captures of apps in exclusive fullscreen (e.g. Fortnite).
    //
    // Default OFF because forcing WGC on m134 (Electron 41) breaks the
    // `streams.audio = "loopback"` request used by screenShare.ts: streamers
    // share silent screenshares despite checking "Stream With Audio". Toggling
    // this back ON is wired through Settings → "Stream cursor on per-window
    // fullscreen captures (forces WGC)".
    //
    // Multiple feature names listed because Chromium renamed/split this flag
    // across versions; unknown features are ignored, so over-specifying is
    // safe.
    if (process.platform === "win32" && Settings.store.screenshareForceWgc) {
        enabledFeatures.add("AllowWgcCapturer");
        enabledFeatures.add("AllowWgcScreenCapturer");
        enabledFeatures.add("AllowWgcWindowCapturer");
        enabledFeatures.add("WebRtcAllowWgcDesktopCapturer");
    }

    // Disable Opaque Response Blocking (ORB) so user-provided cross-origin
    // media URLs work in <video>/<img> elements. Without this, MP4s from
    // public CDNs (commondatastorage.googleapis.com, sample-videos.com,
    // anywhere not pre-allowlisted) get net::ERR_BLOCKED_BY_ORB and silently
    // fail to load. Used by VideoBackground (whole-app background) and
    // DMProfileFlair (custom banner/avatar). Chromium has renamed this flag
    // multiple times — over-specify defensively.
    disabledFeatures.add("OpaqueResponseBlocking");
    disabledFeatures.add("OpaqueResponseBlockingV01");
    disabledFeatures.add("OpaqueResponseBlockingV02");
    disabledFeatures.add("CrossOriginOpenerPolicyByDefault");

    // Fix voice calls looping "Authenticating -> Disconnected" (RTC close code
    // 4017, "E2EE/DAVE protocol required"). Discord made its DAVE end-to-end
    // voice encryption mandatory; the DAVE WebAssembly module (plus some JS
    // chunks/fonts) is served Content-Encoding: zstd. Electron's
    // webRequest-intercepted response path (Vencord hooks onHeadersReceived for
    // CSP) cannot decode zstd, so those assets fail net::ERR_CONTENT_DECODING_
    // FAILED -> "[LibDaveManager] Failed to initialize DAVE" -> the voice server
    // rejects every connection with 4017 and the client reconnect-loops forever
    // (mic captured, but no RTCPeerConnection ever forms). Disabling the
    // ZstdContentEncoding feature stops Chromium advertising zstd in
    // Accept-Encoding (which can't be done from onBeforeSendHeaders — that
    // header isn't exposed there), so Discord's CDN falls back to brotli/gzip,
    // which Electron decodes. Remove once on an Electron whose intercepted
    // response path decodes zstd (track upstream Vesktop's Electron bump).
    disabledFeatures.add("ZstdContentEncoding");
    disabledFeatures.add("SharedZstd");

    // Resilience remote config (client half of the one-tap voice-failover): let
    // a pushed config add/remove Chromium feature flags WITHOUT shipping a
    // release. Reads the on-disk cache synchronously and fail-open (no cache or
    // any error => no change). Placed here so it composes with the built-in
    // flags above before they're set on the command line — so a pushed fix can
    // re-assert the zstd disable, or drop it to test E43's native zstd. The
    // fresh config is fetched post-ready (refreshRemoteConfig) for the NEXT boot.
    applyRemoteLaunchFlags(disabledFeatures);

    if (isLinux) {
        // Support TTS on Linux using https://wiki.archlinux.org/title/Speech_dispatcher
        app.commandLine.appendSwitch("enable-speech-dispatcher");
    }

    disabledFeatures.forEach(feat => enabledFeatures.delete(feat));

    const enabledFeaturesArray = enabledFeatures.values().filter(Boolean).toArray();
    const disabledFeaturesArray = disabledFeatures.values().filter(Boolean).toArray();

    if (enabledFeaturesArray.length) {
        app.commandLine.appendSwitch("enable-features", enabledFeaturesArray.join(","));
        console.log("Enabled Chromium features:", enabledFeaturesArray.join(", "));
    }

    if (disabledFeaturesArray.length) {
        app.commandLine.appendSwitch("disable-features", disabledFeaturesArray.join(","));
        console.log("Disabled Chromium features:", disabledFeaturesArray.join(", "));
    }

    // In the Flatpak on SteamOS the theme is detected as light, but SteamOS only has a dark mode, so we just override it
    if (isDeckGameMode) nativeTheme.themeSource = "dark";

    app.on("second-instance", (_event, _cmdLine, _cwd, data: any) => {
        if (data.IS_DEV) app.quit();
        else if (mainWin) {
            if (mainWin.isMinimized()) mainWin.restore();
            if (!mainWin.isVisible()) mainWin.show();
            mainWin.focus();
        }
    });

    app.whenReady().then(async () => {
        if (process.platform === "win32") app.setAppUserModelId("dev.diggy.discordmaxxer");

        registerScreenShareHandler();
        registerMediaPermissionsHandler();

        bootstrap();

        // Fetch the fresh resilience config and cache it for next launch.
        // Fire-and-forget, time-boxed, fail-open — never blocks startup.
        void refreshRemoteConfig();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindows();
        });
    });
}

if (!app.requestSingleInstanceLock({ IS_DEV })) {
    if (IS_DEV) {
        console.log("Discordmaxxer is already running. Quitting previous instance...");
        init();
    } else {
        console.log("Discordmaxxer is already running. Quitting...");
        app.quit();
    }
} else {
    init();
}

async function bootstrap() {
    seedDiscordmaxxerDefaults();
    // Emergency remote kill-switch: force-disable any plugin the resilience worker
    // is currently rolling off (from the cached config), BEFORE Vencord reads its
    // settings this launch. Restores plugins when the incident is lifted. Fail-open.
    applyRemotelyDisabledPlugins(getRemotelyDisabledPlugins());
    if (!Object.hasOwn(State.store, "firstLaunch")) {
        createFirstLaunchTour();
    } else {
        createWindows();
    }
}

// MacOS only event
export let darwinURL: string | undefined;
app.on("open-url", (_, url) => {
    darwinURL = url;
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

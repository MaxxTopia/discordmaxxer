/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    app,
    BrowserWindow,
    BrowserWindowConstructorOptions,
    ipcMain,
    Menu,
    MenuItemConstructorOptions,
    nativeImage,
    nativeTheme,
    Rectangle,
    screen,
    session,
    shell
} from "electron";
import { existsSync } from "fs";
import { join } from "path";
import { IpcCommands, IpcEvents } from "shared/IpcEvents";
import { STATIC_DIR } from "shared/paths";
import { isTruthy } from "shared/utils/guards";
import { once } from "shared/utils/once";
import type { SettingsStore } from "shared/utils/SettingsStore";

import { createAboutWindow } from "./about";
import { initArRPC } from "./arrpc";
import { CommandLine } from "./cli";
import { BrowserUserAgent, DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH } from "./constants";
import { AppEvents } from "./events";
import { darwinURL } from "./index";
import { sendRendererCommand } from "./ipcCommands";
import { Settings, State, VencordSettings } from "./settings";
import {
    closeStartupRecovery,
    createSplashWindow,
    registerStartupRecoveryHandlers,
    showStartupRecovery,
    updateSplashMessage
} from "./splash";
import { describeStartupError, getStartupLogPath, recordStartupEvent } from "./startupDiagnostics";
import { destroyTray, initTray } from "./tray";
import { clearData } from "./utils/clearData";
import { makeLinksOpenExternally } from "./utils/makeLinksOpenExternally";
import { applyDeckKeyboardFix, askToApplySteamLayout, isDeckGameMode } from "./utils/steamOS";
import { downloadVencordFiles, ensureVencordFiles, vencordSupportsSandboxing } from "./utils/vencordLoader";
import { VENCORD_FILES_DIR } from "./vencordFilesDir";

let isQuitting = false;

applyDeckKeyboardFix();

app.on("before-quit", () => {
    isQuitting = true;
});

export let mainWin: BrowserWindow;

const STARTUP_PREPARATION_TIMEOUT_MS = 20_000;
const STARTUP_RENDERER_TIMEOUT_MS = 25_000;
const STARTUP_PROBE_INTERVAL_MS = 250;
const MAX_STARTUP_NAVIGATION_RETRIES = 3;
const retryDelay = 1000;

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let startupWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let startupProbeTimer: ReturnType<typeof setInterval> | null = null;
let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
let startupAttempt = 0;
let startupTargetUrl = "";
let startupReady = false;
let startupRecoveryShown = false;
let navigationRetryCount = 0;
let recoveryHandlersRegistered = false;
let startupFailureIpcRegistered = false;
let createWindowsPromise: Promise<void> | null = null;

function makeSettingsListenerHelpers<O extends object>(o: SettingsStore<O>) {
    const listeners = new Map<(data: any) => void, PropertyKey>();

    const addListener: typeof o.addChangeListener = (path, cb) => {
        listeners.set(cb, path);
        o.addChangeListener(path, cb);
    };
    const removeAllListeners = () => {
        for (const [listener, path] of listeners) {
            o.removeChangeListener(path as any, listener);
        }

        listeners.clear();
    };

    return [addListener, removeAllListeners] as const;
}

const [addSettingsListener, removeSettingsListeners] = makeSettingsListenerHelpers(Settings);
const [addVencordSettingsListener, removeVencordSettingsListeners] = makeSettingsListenerHelpers(VencordSettings);

type MenuItemList = Array<MenuItemConstructorOptions | false>;

function initMenuBar(win: BrowserWindow) {
    const isWindows = process.platform === "win32";
    const isDarwin = process.platform === "darwin";
    const wantCtrlQ = !isWindows || VencordSettings.store.winCtrlQ;

    const subMenu = [
        {
            label: "About Discordmaxxer",
            click: createAboutWindow
        },
        {
            label: "Force Update Plugin Engine",
            async click() {
                await downloadVencordFiles();
                app.relaunch();
                app.quit();
            },
            toolTip: "Discordmaxxer will automatically restart after this operation"
        },
        {
            label: "Reset Discordmaxxer",
            async click() {
                await clearData(win);
            },
            toolTip: "Discordmaxxer will automatically restart after this operation"
        },
        {
            label: "Relaunch",
            accelerator: "CmdOrCtrl+Shift+R",
            click() {
                app.relaunch();
                app.quit();
            }
        },
        ...(!isDarwin
            ? []
            : ([
                  {
                      type: "separator"
                  },
                  {
                      label: "Settings",
                      accelerator: "CmdOrCtrl+,",
                      async click() {
                          sendRendererCommand(IpcCommands.NAVIGATE_SETTINGS);
                      }
                  },
                  {
                      type: "separator"
                  },
                  {
                      role: "hide"
                  },
                  {
                      role: "hideOthers"
                  },
                  {
                      role: "unhide"
                  },
                  {
                      type: "separator"
                  }
              ] satisfies MenuItemList)),
        {
            label: "Quit",
            accelerator: wantCtrlQ ? "CmdOrCtrl+Q" : void 0,
            visible: !isWindows,
            role: "quit",
            click() {
                app.quit();
            }
        },
        isWindows && {
            label: "Quit",
            accelerator: "Alt+F4",
            role: "quit",
            click() {
                app.quit();
            }
        },
        // See https://github.com/electron/electron/issues/14742 and https://github.com/electron/electron/issues/5256
        {
            label: "Zoom in (hidden, hack for Qwertz and others)",
            accelerator: "CmdOrCtrl+=",
            role: "zoomIn",
            visible: false
        }
    ] satisfies MenuItemList;

    const menuItems = [
        {
            label: "Discordmaxxer",
            role: "appMenu",
            submenu: subMenu.filter(isTruthy)
        },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        isDarwin && { role: "windowMenu" }
    ] satisfies MenuItemList;

    const menu = Menu.buildFromTemplate(menuItems.filter(isTruthy));

    Menu.setApplicationMenu(menu);
}

function initWindowBoundsListeners(win: BrowserWindow) {
    const saveState = () => {
        State.store.maximized = win.isMaximized();
        State.store.minimized = win.isMinimized();
    };

    const onMinimizeOrHide = () => {
        saveState();
        // Never throttle background audio clocks — preserves crystal-clear WebRTC voice fidelity.
        // Flush in-memory V8 code caches on minimize to free working set cleanly.
        try {
            win.webContents.session.clearCodeCaches({});
        } catch {
            // best effort
        }
    };

    const onRestoreOrShow = () => {
        saveState();
    };

    win.on("maximize", saveState);
    win.on("minimize", onMinimizeOrHide);
    win.on("hide", onMinimizeOrHide);
    win.on("unmaximize", saveState);
    win.on("restore", onRestoreOrShow);
    win.on("show", onRestoreOrShow);
    win.on("focus", onRestoreOrShow);

    const saveBounds = () => {
        if (win.isMaximized()) return;

        State.store.windowBounds = win.getBounds();
    };

    win.on("resize", saveBounds);
    win.on("move", saveBounds);
}

function initSettingsListeners(win: BrowserWindow) {
    addSettingsListener("tray", enable => {
        if (enable) initTray(win, q => (isQuitting = q));
        else destroyTray();
    });

    addSettingsListener("disableMinSize", disable => {
        if (disable) {
            // 0 no work
            win.setMinimumSize(1, 1);
        } else {
            win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);

            const { width, height } = win.getBounds();
            win.setBounds({
                width: Math.max(width, MIN_WIDTH),
                height: Math.max(height, MIN_HEIGHT)
            });
        }
    });

    addVencordSettingsListener("macosTranslucency", enabled => {
        if (enabled) {
            win.setVibrancy("sidebar");
            win.setBackgroundColor("#ffffff00");
        } else {
            win.setVibrancy(null);
            win.setBackgroundColor("#ffffff");
        }
    });

    addSettingsListener("enableMenu", enabled => {
        win.setAutoHideMenuBar(enabled ?? false);
    });

    addSettingsListener("spellCheckLanguages", languages => initSpellCheckLanguages(win, languages));
}

async function initSpellCheckLanguages(win: BrowserWindow, languages?: string[]) {
    languages ??= await sendRendererCommand(IpcCommands.GET_LANGUAGES);
    if (!languages) return;

    const ses = session.defaultSession;

    const available = ses.availableSpellCheckerLanguages;
    const applicable = languages.filter(l => available.includes(l)).slice(0, 5);
    if (applicable.length) ses.setSpellCheckerLanguages(applicable);
}

function initSpellCheck(win: BrowserWindow) {
    win.webContents.on("context-menu", (_, data) => {
        win.webContents.send(IpcEvents.SPELLCHECK_RESULT, data.misspelledWord, data.dictionarySuggestions);
    });

    initSpellCheckLanguages(win, Settings.store.spellCheckLanguages);
}

function initDevtoolsListeners(win: BrowserWindow) {
    win.webContents.on("devtools-opened", () => {
        win.webContents.send(IpcEvents.DEVTOOLS_OPENED);
    });
    win.webContents.on("devtools-closed", () => {
        win.webContents.send(IpcEvents.DEVTOOLS_CLOSED);
    });
}

function initStaticTitle(win: BrowserWindow) {
    const listener = (e: { preventDefault: Function }) => e.preventDefault();

    if (Settings.store.staticTitle) win.on("page-title-updated", listener);

    addSettingsListener("staticTitle", enabled => {
        if (enabled) {
            win.setTitle("Discordmaxxer");
            win.on("page-title-updated", listener);
        } else {
            win.off("page-title-updated", listener);
        }
    });
}

function getWindowBoundsOptions(): BrowserWindowConstructorOptions {
    // We want the default window behaviour to apply in game mode since it expects everything to be fullscreen and maximized.
    if (isDeckGameMode) return {};

    const { x, y, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = State.store.windowBounds ?? {};

    const options = { width, height } as BrowserWindowConstructorOptions;

    if (x != null && y != null) {
        function isInBounds(rect: Rectangle, display: Rectangle) {
            return !(
                rect.x + rect.width < display.x ||
                rect.x > display.x + display.width ||
                rect.y + rect.height < display.y ||
                rect.y > display.y + display.height
            );
        }

        const inBounds = screen.getAllDisplays().some(d => isInBounds({ x, y, width, height }, d.bounds));
        if (inBounds) {
            options.x = x;
            options.y = y;
        }
    }

    if (!Settings.store.disableMinSize) {
        options.minWidth = MIN_WIDTH;
        options.minHeight = MIN_HEIGHT;
    }

    return options;
}

/**
 * Resolve the icon before BrowserWindow is constructed. Windows associates an
 * active window with its AppUserModelId during construction; setting the icon
 * afterwards changes the thumbnail but can leave the taskbar button using
 * Electron's default atom icon. Keep the packaged .ico first so the shell can
 * use the full multi-size icon, with the PNG as a development fallback.
 */
function getWindowsIconPath(): string | undefined {
    if (process.platform !== "win32") return undefined;

    const candidates = app.isPackaged
        ? [join(process.resourcesPath, "shortcut-icon.ico"), join(STATIC_DIR, "taskbar", "taskbar.png")]
        : [
              join(app.getAppPath(), "build", "shortcut-icon.ico"),
              join(app.getAppPath(), "build", "icon.ico"),
              join(STATIC_DIR, "taskbar", "taskbar.png")
          ];
    return candidates.find(candidate => existsSync(candidate));
}

function buildBrowserWindowOptions(): BrowserWindowConstructorOptions {
    const { staticTitle, transparencyOption, enableMenu, customTitleBar, splashTheming, splashBackground } =
        Settings.store;

    const { frameless, transparent, macosVibrancyStyle } = VencordSettings.store;

    const noFrame = frameless === true || customTitleBar === true;
    const backgroundColor =
        splashTheming !== false ? splashBackground : nativeTheme.shouldUseDarkColors ? "#313338" : "#ffffff";

    const options: BrowserWindowConstructorOptions = {
        show: Settings.store.enableSplashScreen === false && !CommandLine.values["start-minimized"],
        backgroundColor,
        icon: getWindowsIconPath(),
        webPreferences: {
            nodeIntegration: false,
            sandbox: vencordSupportsSandboxing(),
            contextIsolation: true,
            devTools: true,
            preload: join(__dirname, "preload.js"),
            spellcheck: true,
            // Use Chromium's normal idle/occlusion scheduling. The perf bridge
            // disables this only while a voice call or stream is active so
            // WebRTC audio stays live without keeping idle Discord fully hot.
            backgroundThrottling: true
        },
        frame: !noFrame,
        autoHideMenuBar: enableMenu,
        ...getWindowBoundsOptions()
    };

    if (transparent) {
        options.transparent = true;
        options.backgroundColor = "#00000000";
    }

    if (transparencyOption && transparencyOption !== "none") {
        options.backgroundColor = "#00000000";
        options.backgroundMaterial = transparencyOption;

        if (customTitleBar) {
            options.transparent = true;
        }
    }

    if (staticTitle) {
        options.title = "Discordmaxxer";
    }

    if (process.platform === "darwin") {
        options.titleBarStyle = "hidden";
        options.trafficLightPosition = { x: 10, y: 10 };

        if (macosVibrancyStyle) {
            options.vibrancy = macosVibrancyStyle;
            options.backgroundColor = "#00000000";
        }
    }

    return options;
}

function createMainWindow() {
    // Clear up previous settings listeners
    removeSettingsListeners();
    removeVencordSettingsListeners();

    const win = (mainWin = new BrowserWindow(buildBrowserWindowOptions()));

    // Tell Windows which icon belongs to this taskbar identity. BrowserWindow's
    // `icon` option and setIcon() update the window icon, but Windows can keep a
    // stale Electron icon for an existing AppUserModelId unless the taskbar
    // button details include the app icon explicitly.
    if (process.platform === "win32") {
        try {
            const iconPath = getWindowsIconPath();
            if (iconPath) {
                win.setAppDetails({
                    appId: "com.maxxtopia.discordmaxxer",
                    appIconPath: iconPath,
                    appIconIndex: 0,
                    relaunchCommand: process.execPath,
                    relaunchDisplayName: "Discordmaxxer"
                });
            }

            // Use the no-bullet-holes Clyde for the small runtime/taskbar
            // thumbnail while keeping the full character in the shortcut/.exe.
            const taskbarIcon = nativeImage.createFromPath(join(STATIC_DIR, "taskbar", "taskbar.png"));
            if (!taskbarIcon.isEmpty()) win.setIcon(taskbarIcon);
        } catch (e) {
            console.warn("[mainWindow] failed to set runtime taskbar icon:", e);
        }
    }

    win.setMenuBarVisibility(false);
    if (process.platform === "darwin" && Settings.store.customTitleBar) win.setWindowButtonVisibility(false);

    win.on("close", e => {
        const useTray = !isDeckGameMode && Settings.store.minimizeToTray !== false && Settings.store.tray !== false;
        if (isQuitting || (process.platform !== "darwin" && !useTray)) return;

        e.preventDefault();

        if (process.platform === "darwin") app.hide();
        else win.hide();

        return false;
    });

    win.on("focus", () => {
        win.flashFrame(false);
    });

    initWindowBoundsListeners(win);
    if (!isDeckGameMode && (Settings.store.tray ?? true) && process.platform !== "darwin")
        initTray(win, q => (isQuitting = q));

    initMenuBar(win);
    makeLinksOpenExternally(win);
    initSettingsListeners(win);
    initSpellCheck(win);
    initDevtoolsListeners(win);
    initStaticTitle(win);

    win.webContents.setUserAgent(BrowserUserAgent);

    return win;
}

const runVencordMain = once(() => require(join(VENCORD_FILES_DIR, "vencordDesktopMain.js")));

function clearStartupWatch() {
    if (startupWatchdogTimer !== null) {
        clearTimeout(startupWatchdogTimer);
        startupWatchdogTimer = null;
    }
    if (startupProbeTimer !== null) {
        clearInterval(startupProbeTimer);
        startupProbeTimer = null;
    }
    if (unresponsiveTimer !== null) {
        clearTimeout(unresponsiveTimer);
        unresponsiveTimer = null;
    }
}

function startupDiagnosticId() {
    return `${app.getVersion()}-${process.pid}-${Date.now().toString(36)}`;
}

function failStartup(reason: string, error?: unknown) {
    if (startupRecoveryShown) return;

    startupRecoveryShown = true;
    clearStartupWatch();
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }

    const detail = error === undefined ? reason : `${reason} ${describeStartupError(error)}`;
    const diagnosticId = startupDiagnosticId();
    recordStartupEvent("startup-recovery", {
        diagnosticId,
        reason,
        detail,
        targetUrl: startupTargetUrl
    });
    showStartupRecovery(detail, diagnosticId, app.getVersion());
}

function markStartupReady(attempt: number) {
    if (attempt !== startupAttempt || startupReady) return;

    startupReady = true;
    startupRecoveryShown = false;
    clearStartupWatch();
    recordStartupEvent("renderer-ready", { attempt, targetUrl: startupTargetUrl });
    closeStartupRecovery();
    AppEvents.emit("appLoaded");
}

function beginStartupWatch(targetUrl: string) {
    startupAttempt += 1;
    startupReady = false;
    startupRecoveryShown = false;
    startupTargetUrl = targetUrl;
    clearStartupWatch();

    const attempt = startupAttempt;
    startupWatchdogTimer = setTimeout(() => {
        failStartup("Discord did not finish loading within the startup timeout.");
    }, STARTUP_RENDERER_TIMEOUT_MS);

    recordStartupEvent("navigation-start", { attempt, targetUrl });
    return attempt;
}

function startRendererProbe(attempt: number) {
    let probeInFlight = false;

    const probe = () => {
        if (attempt !== startupAttempt || startupReady || startupRecoveryShown) return;
        if (!mainWin || mainWin.isDestroyed()) return;
        if (probeInFlight) return;

        probeInFlight = true;

        try {
            void mainWin.webContents
                .executeJavaScript(
                    `(() => { const mount = document.querySelector("#app-mount"); return Boolean(mount && mount.childElementCount > 0); })()`,
                    true
                )
                .then(isReady => {
                    if (isReady === true) markStartupReady(attempt);
                })
                .catch(error => recordStartupEvent("renderer-probe-error", describeStartupError(error)))
                .finally(() => {
                    probeInFlight = false;
                });
        } catch (error) {
            recordStartupEvent("renderer-probe-error", describeStartupError(error));
            probeInFlight = false;
        }
    };

    probe();
    startupProbeTimer = setInterval(probe, STARTUP_PROBE_INTERVAL_MS);
}

function retryStartup() {
    recordStartupEvent("startup-retry-requested");
    startupRecoveryShown = false;
    navigationRetryCount = 0;
    closeStartupRecovery();

    if (!mainWin || mainWin.isDestroyed()) {
        app.relaunch();
        app.quit();
        return;
    }

    loadUrl(undefined, true);
}

function restartStartup() {
    recordStartupEvent("startup-restart-requested");
    app.relaunch();
    app.quit();
}

function registerStartupRecovery() {
    if (!recoveryHandlersRegistered) {
        recoveryHandlersRegistered = true;
        registerStartupRecoveryHandlers({
            retry: retryStartup,
            restart: restartStartup,
            openLog: () => void shell.openPath(getStartupLogPath())
        });
    }

    if (startupFailureIpcRegistered) return;
    startupFailureIpcRegistered = true;
    ipcMain.on(IpcEvents.DM_STARTUP_ERROR, (event, stage: string, detail: string) => {
        if (!mainWin || event.sender !== mainWin.webContents) return;

        recordStartupEvent("renderer-startup-error", { stage, detail });
        if (!startupReady) failStartup(`Discord's startup script failed at ${stage || "an unknown stage"}.`, detail);
    });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}

export function loadUrl(uri: string | undefined, resetRetries = true) {
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (resetRetries) navigationRetryCount = 0;

    const branch = Settings.store.discordBranch;
    const subdomain = branch === "canary" || branch === "ptb" ? `${branch}.` : "";
    let targetUrl: string;
    try {
        targetUrl = `https://${subdomain}discord.com/${uri ? new URL(uri).pathname.slice(1) || "app" : "app"}`;
    } catch (error) {
        failStartup("Discord's startup URL was invalid.", error);
        return;
    }

    const attempt = beginStartupWatch(targetUrl);
    recordStartupEvent("navigation-requested", { attempt, targetUrl });
    if (!mainWin || mainWin.isDestroyed()) {
        failStartup("Discord's main window was unavailable during startup.");
        return;
    }

    void mainWin
        .loadURL(targetUrl)
        .then(() => {
            if (attempt !== startupAttempt || startupRecoveryShown) return;
            recordStartupEvent("document-loaded", { attempt, targetUrl });
            startRendererProbe(attempt);
        })
        .catch(error => {
            const failure = error as { url?: string; code?: string };
            retryUrl(failure.url || targetUrl, failure.code || "ERR_UNKNOWN", error);
        });
}

function retryUrl(url: string, description: string, error: unknown) {
    // Electron reports ERR_ABORTED when a navigation is superseded by a
    // legitimate redirect (for example /app -> /login) or by another loadURL
    // call. Treat that as a normal navigation transition.
    if (description === "ERR_ABORTED") return;

    recordStartupEvent("navigation-failed", { url, description, error: describeStartupError(error) });
    updateSplashMessage(`Failed to load Discord: ${description}`);
    console.warn("[mainWindow] Discord navigation failed:", error);

    if (startupRecoveryShown || retryTimer !== null) return;
    if (navigationRetryCount >= MAX_STARTUP_NAVIGATION_RETRIES) {
        failStartup(`Discord navigation failed after ${MAX_STARTUP_NAVIGATION_RETRIES} attempts (${description}).`, error);
        return;
    }

    navigationRetryCount += 1;
    console.log(`[mainWindow] retrying Discord navigation in ${retryDelay}ms (${navigationRetryCount}/${MAX_STARTUP_NAVIGATION_RETRIES})`);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!mainWin || mainWin.isDestroyed()) return;
        loadUrl(url, false);
    }, retryDelay);
}

async function createWindowsInternal() {
    const startMinimized = CommandLine.values["start-minimized"];
    registerStartupRecovery();

    let splash: BrowserWindow | undefined;
    if (Settings.store.enableSplashScreen !== false) {
        splash = createSplashWindow(startMinimized);

        // SteamOS letterboxes and scales it terribly, so just full screen it
        if (isDeckGameMode) splash.setFullScreen(true);
    }

    try {
        recordStartupEvent("vencord-preparation-start", { directory: VENCORD_FILES_DIR });
        await withTimeout(
            ensureVencordFiles(),
            STARTUP_PREPARATION_TIMEOUT_MS,
            "The plugin engine did not become ready within the startup timeout."
        );
        recordStartupEvent("vencord-preparation-ready");
        runVencordMain();
        recordStartupEvent("vencord-main-ready");
    } catch (error) {
        failStartup("The Discordmaxxer plugin engine could not start.", error);
        return;
    }

    AppEvents.on("appLoaded", () => {
        startupReady = true;
        startupRecoveryShown = false;
        clearStartupWatch();
        closeStartupRecovery();

        try {
            splash?.destroy();
        } catch {}

        if (!startMinimized && mainWin && !mainWin.isDestroyed()) {
            mainWin.show();
            mainWin.focus();
            if (State.store.maximized && !isDeckGameMode) mainWin.maximize();
        }

        if (isDeckGameMode) {
            // always use entire display
            mainWin!.setFullScreen(true);

            askToApplySteamLayout(mainWin);
        }

        mainWin.once("show", () => {
            if (State.store.maximized && !mainWin!.isMaximized() && !isDeckGameMode) {
                mainWin!.maximize();
            }
        });
    });

    // Register before createMainWindow() starts loadURL(). A cached or very
    // fast packaged load can otherwise emit appLoaded before the splash
    // handler exists, leaving the splash window permanently on top of a fully
    // loaded Discord renderer.
    mainWin = createMainWindow();

    mainWin.webContents.on("did-fail-load", (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;

        retryUrl(
            validatedURL || startupTargetUrl,
            `${errorCode}: ${errorDescription}`,
            { errorCode, errorDescription, validatedURL }
        );
    });

    mainWin.webContents.on("did-navigate", (_, url: string, responseCode: number) => {
        updateSplashMessage(""); // clear the splash message

        // Discord intentionally redirects /app to /login, /register, or other
        // first-party routes. Treating every non-/app response as broken
        // starts a second loadURL, aborts the first navigation, and leaves the
        // splash stuck on "ERR_ABORTED". Only recover if navigation escaped
        // Discord's own origin.
        let isDiscordOrigin = false;
        try {
            isDiscordOrigin = /^(([^.]+\.)*discord\.com)$/i.test(new URL(url).hostname);
        } catch {
            isDiscordOrigin = false;
        }
        if (responseCode >= 300 && !isDiscordOrigin) {
            retryUrl(url, `HTTP ${responseCode}`, new Error(`Discord navigation escaped to ${url}`));
            console.warn(`'did-navigate': Caught bad page response: ${responseCode}, retrying the main app`);
        }
    });

    mainWin.webContents.on("render-process-gone", (_event, details) => {
        recordStartupEvent("render-process-gone", details);
        if (!startupReady) failStartup("The Discord renderer stopped during startup.", details);
    });

    mainWin.webContents.on("unresponsive", () => {
        recordStartupEvent("renderer-unresponsive");
        if (startupReady || unresponsiveTimer !== null) return;

        unresponsiveTimer = setTimeout(() => {
            unresponsiveTimer = null;
            if (!startupReady) failStartup("The Discord renderer stopped responding during startup.");
        }, 8_000);
    });

    mainWin.webContents.on("responsive", () => {
        recordStartupEvent("renderer-responsive");
        if (unresponsiveTimer !== null) {
            clearTimeout(unresponsiveTimer);
            unresponsiveTimer = null;
        }
    });

    initArRPC();
    loadUrl(darwinURL || process.argv.find(arg => arg.startsWith("discord://")));
}

/**
 * App activation, first-launch completion, and the normal bootstrap can all
 * ask for a window around the same time. Keep those paths on one startup
 * promise; two concurrent Vencord preparations can otherwise race over the
 * staged files and leave one of the windows blank.
 */
export function createWindows() {
    if (createWindowsPromise) return createWindowsPromise;

    const promise = createWindowsInternal();
    createWindowsPromise = promise.finally(() => {
        // If preparation failed before a main window existed, allow a later
        // activation/retry to start a fresh attempt. Once a real window exists,
        // keep the promise as the single owner for this process lifetime.
        if (!mainWin || mainWin.isDestroyed()) createWindowsPromise = null;
    });

    return createWindowsPromise;
}

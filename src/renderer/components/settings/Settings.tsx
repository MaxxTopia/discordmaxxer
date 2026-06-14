/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./settings.css";

import { classNameFactory } from "@vencord/types/api/Styles";
import { BaseText, Divider, ErrorBoundary } from "@vencord/types/components";
import { ComponentType } from "react";
import { Settings, useSettings } from "renderer/settings";
import { isMac, isWindows } from "renderer/utils";

import { AutoStartToggle } from "./AutoStartToggle";
import { DeveloperOptionsButton } from "./DeveloperOptions";
import { DiscordBranchPicker } from "./DiscordBranchPicker";
import { NotificationBadgeToggle } from "./NotificationBadgeToggle";
import { OutdatedVesktopWarning } from "./OutdatedVesktopWarning";
import { UserAssetsButton } from "./UserAssets";
import { VesktopSettingsSwitch } from "./VesktopSettingsSwitch";
import { WindowsTransparencyControls } from "./WindowsTransparencyControls";

interface BooleanSetting {
    key: keyof typeof Settings.store;
    title: string;
    description: string;
    defaultValue: boolean;
    disabled?(): boolean;
    invisible?(): boolean;
}

export const cl = classNameFactory("vcd-settings-");

export type SettingsComponent = ComponentType<{ settings: typeof Settings.store }>;

const SettingsOptions: Record<string, Array<BooleanSetting | SettingsComponent>> = {
    "Discord Branch": [DiscordBranchPicker],
    "System Startup & Performance": [
        AutoStartToggle,
        {
            key: "hardwareAcceleration",
            title: "Hardware Acceleration",
            description: "Enable hardware acceleration",
            defaultValue: true
        },
        {
            key: "hardwareVideoAcceleration",
            title: "Video Hardware Acceleration",
            description:
                "Enable hardware video acceleration. This can improve performance of screenshare and video playback, but may cause graphical glitches and infinitely loading streams.",
            defaultValue: false,
            disabled: () => Settings.store.hardwareAcceleration === false
        },
        {
            key: "screenshareForceWgc",
            title: "Stream cursor on per-window fullscreen captures",
            description:
                "Forces Windows Graphics Capture for screenshares so the cursor shows up when capturing a single exclusive-fullscreen game window (e.g. Fortnite). Audio works in both WGC modes — the renderer-side per-window audio swap takes over when WGC is forced. Requires a full app restart.",
            defaultValue: false,
            invisible: () => !isWindows
        },
        {
            key: "screensharePerWindowAudio",
            title: "Per-window stream audio (anti-echo)",
            description:
                "Re-captures audio from the shared window instead of the whole system, to stop viewers hearing themselves echoed. OFF by default because on some Windows audio setups this capture crashes the screenshare — with it off, stream audio uses normal system loopback (works fine; only echoes if you're on speakers, not headphones). Requires a full app restart.",
            defaultValue: false,
            invisible: () => !isWindows
        }
    ],
    "User Interface": [
        {
            key: "customTitleBar",
            title: "Discord Titlebar",
            description: "Use Discord's custom title bar instead of the native system one. Requires a full restart.",
            defaultValue: isWindows
        },
        {
            key: "staticTitle",
            title: "Static Title",
            description: 'Makes the window title "Discordmaxxer" instead of changing to the current page',
            defaultValue: false
        },
        {
            key: "enableMenu",
            title: "Enable Menu Bar",
            description: "Enables the application menu bar. Press ALT to toggle visibility.",
            defaultValue: false,
            disabled: () => Settings.store.customTitleBar ?? isWindows
        },
        {
            key: "enableSplashScreen",
            title: "Enable Splash Screen",
            description:
                "Shows a small splash screen while Discordmaxxer is loading. Disabling this option will show the main window earlier while it's still loading.",
            defaultValue: true
        },
        {
            key: "splashTheming",
            title: "Splash theming",
            description: "Adapt the splash window colors to your custom theme",
            defaultValue: true
        },
        WindowsTransparencyControls,
        UserAssetsButton
    ],
    Behaviour: [
        {
            key: "tray",
            title: "Tray Icon",
            description: "Add a tray icon for Discordmaxxer",
            defaultValue: true,
            invisible: () => isMac
        },
        {
            key: "minimizeToTray",
            title: "Minimize to tray",
            description: "Hitting X will make Discordmaxxer minimize to the tray instead of closing",
            defaultValue: true,
            invisible: () => isMac,
            disabled: () => Settings.store.tray === false
        },
        {
            key: "clickTrayToShowHide",
            title: "Hide/Show on tray click",
            description: "Left clicking tray icon will toggle the vesktop window visibility.",
            defaultValue: false
        },
        {
            key: "disableMinSize",
            title: "Disable minimum window size",
            description: "Allows you to make the window as small as your heart desires",
            defaultValue: false
        },
        {
            key: "disableSmoothScroll",
            title: "Disable smooth scrolling",
            description: "Disables smooth scrolling",
            defaultValue: false
        }
    ],
    Notifications: [
        NotificationBadgeToggle,
        {
            key: "enableTaskbarFlashing",
            title: "Enable Taskbar Flashing",
            description: "Flashes the app in your taskbar when you have new notifications.",
            defaultValue: false
        }
    ],
    Miscellaneous: [
        {
            key: "arRPC",
            title: "Rich Presence",
            description: "Enables Rich Presence via arRPC",
            defaultValue: false
        },

        {
            key: "openLinksWithElectron",
            title: "Open Links in app (experimental)",
            description: "Opens links in a new Discordmaxxer window instead of your web browser",
            defaultValue: false
        }
    ],
    "Developer Options": [DeveloperOptionsButton]
};

function SettingsSections() {
    const Settings = useSettings();

    const sections = Object.entries(SettingsOptions).map(([title, settings], i, arr) => (
        <div key={title} className={cl("category")}>
            <BaseText size="lg" weight="semibold" tag="h3" className={cl("category-title")}>
                {title}
            </BaseText>

            <div className={cl("category-content")}>
                {settings.map((Setting, i) => {
                    if (typeof Setting === "function") return <Setting key={`Custom-${i}`} settings={Settings} />;

                    const { defaultValue, title, description, key, disabled, invisible } = Setting;
                    if (invisible?.()) return null;

                    return (
                        <VesktopSettingsSwitch
                            title={title}
                            description={description}
                            value={Settings[key as any] ?? defaultValue}
                            onChange={v => (Settings[key as any] = v)}
                            disabled={disabled?.()}
                            key={key}
                        />
                    );
                })}
            </div>

            {i < arr.length - 1 && <Divider className={cl("category-divider")} />}
        </div>
    ));

    return <>{sections}</>;
}

export default ErrorBoundary.wrap(
    function SettingsUI() {
        return (
            <section>
                <OutdatedVesktopWarning />
                <SettingsSections />
            </section>
        );
    },
    {
        message:
            "Failed to render the Discordmaxxer Settings tab. If this issue persists, try to right click the Discordmaxxer tray icon, then click 'Repair Vencord'. And make sure your Discordmaxxer is up to date."
    }
);

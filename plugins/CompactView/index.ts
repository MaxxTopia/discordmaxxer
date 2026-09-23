/*
 * Discordmaxxer — CompactView plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Hotkey-toggle to hide Discord's server list / channel list / member list.
 * Designed for vertical-monitor users who lose real estate during screenshare.
 *
 * v2: OS-level global hotkey via Discordmaxxer's globalShortcut bridge.
 * Falls back to window-focused keydown when Discord is focused.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { React, Toasts } from "@webpack/common";

import { HotkeyPicker } from "../_dm-shared/HotkeyPicker";
import { matchesHotkey, parseHotkey } from "../_dm-shared/hotkey";

const HOTKEY_ID = "discordmaxxer.CompactView";
const DEFAULT_HOTKEY = "ctrl+alt+h";

let style: HTMLStyleElement;
let active = false;
let hotkeyHandler: ((e: KeyboardEvent) => void) | null = null;
let globalRegistered = false;
let pluginStarted = false;

function buildCss(): string {
    // Selectors verified via CDP inspection on real Discord (2026-05-05).
    // Discord's class-name suffixes use `__hash` (double underscore), not `-hash`.
    // Aria-labels are stable across Discord redesigns; preferred over class.
    const parts: string[] = [];
    if (settings.store.hideServerList) {
        parts.push(`nav[aria-label*="ervers sidebar" i] { display: none !important; }`);
    }
    if (settings.store.hideChannelList) {
        // Covers both server-channel list and @me DM list ("Private channels").
        parts.push(`nav[aria-label*="hannels" i], nav[aria-label*="rivate channels" i] { display: none !important; }`);
    }
    if (settings.store.hideMemberList) {
        // Member list lives in an aside. Two known aria-labels: "Members" or "members".
        parts.push(`aside[aria-label*="ember" i] { display: none !important; }`);
    }
    return parts.join("\n");
}

const settings = definePluginSettings({
    picker: {
        type: OptionType.COMPONENT,
        description: "",
        component: CompactHotkeyPicker
    },
    hotkey: {
        type: OptionType.STRING,
        description: "Use the recorder above for the common path, or type a shortcut like ctrl+alt+h. Changes apply immediately.",
        default: DEFAULT_HOTKEY,
        onChange: () => { if (pluginStarted) reapplyHotkey(); }
    },
    useGlobalHotkey: {
        type: OptionType.BOOLEAN,
        description: "Use OS-level hotkey (fires while Discord is unfocused — useful during screenshare).",
        default: true,
        onChange: () => { if (pluginStarted) reapplyHotkey(); }
    },
    hideServerList: {
        type: OptionType.BOOLEAN,
        description: "Hide the server-rail strip on the far left",
        default: true,
        onChange: () => { if (active) refresh(); }
    },
    hideChannelList: {
        type: OptionType.BOOLEAN,
        description: "Hide the channel/DM list",
        default: true,
        onChange: () => { if (active) refresh(); }
    },
    hideMemberList: {
        type: OptionType.BOOLEAN,
        description: "Hide the member list on the right",
        default: true,
        onChange: () => { if (active) refresh(); }
    },
    enabledOnStart: {
        type: OptionType.BOOLEAN,
        description: "Enable Compact View automatically on Discord launch",
        default: false
    },
    // Runtime mirror of the `active` module-level flag. Hidden from the
    // settings UI (DiscordmaxxerHub uses it to render a real toggle button
    // alongside the hotkey). Kept in sync with setActive() on every flip.
    manuallyActive: {
        type: OptionType.BOOLEAN,
        description: "Live runtime toggle (mirrored to module state). Toggle from the Discordmaxxer Hub.",
        default: false,
        hidden: true,
        onChange: (val: boolean) => {
            if (val !== active) setActive(val);
        }
    }
});

function CompactHotkeyPicker() {
    return React.createElement(HotkeyPicker, {
        value: settings.store.hotkey,
        defaultValue: DEFAULT_HOTKEY,
        label: "Compact View shortcut",
        description: "Record a shortcut that toggles the sidebars. OS-level mode works while Discord is unfocused; the window fallback remains available.",
        onChange: value => { settings.store.hotkey = value; }
    });
}

function refresh() {
    if (style) style.textContent = active ? buildCss() : "";
}

function setActive(next: boolean) {
    active = next;
    refresh();
    // Mirror to settings so the Hub's toggle button reflects current state
    // even when the user flipped via hotkey (not via the toggle).
    try { settings.store.manuallyActive = next; } catch { /* settings not init yet */ }
    Toasts.show({
        message: active ? "📐 Compact View: ON" : "Compact View: OFF",
        type: active ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: { duration: 1200, position: Toasts.Position.TOP }
    });
}

function teardownHotkey() {
    if (globalRegistered) {
        (globalThis as any).VesktopNative?.globalHotkey?.unregister?.(HOTKEY_ID);
        globalRegistered = false;
    }
    if (hotkeyHandler) {
        window.removeEventListener("keydown", hotkeyHandler);
        hotkeyHandler = null;
    }
}

async function setupHotkey() {
    teardownHotkey();

    const native = (globalThis as any).VesktopNative;
    const wantGlobal = settings.store.useGlobalHotkey && native?.globalHotkey?.register;

    if (wantGlobal) {
        try {
            const ok = await native.globalHotkey.register(HOTKEY_ID, settings.store.hotkey, () => {
                setActive(!active);
            });
            if (ok) {
                globalRegistered = true;
                console.log("[CompactView] OS-level hotkey registered");
                return;
            }
            console.warn("[CompactView] OS-level register failed — falling back");
        } catch (e) {
            console.warn("[CompactView] OS-level register threw, falling back:", e);
        }
    }

    const hk = parseHotkey(settings.store.hotkey);
    hotkeyHandler = (e: KeyboardEvent) => {
        // Discord's own keybind dispatcher gets first refusal. This
        // fallback is only for combos the OS-level registration could not
        // claim, so it must not steal a user's existing Discord keybind.
        if (e.defaultPrevented) return;
        if (matchesHotkey(e, hk)) {
            e.preventDefault();
            e.stopPropagation();
            setActive(!active);
        }
    };
    window.addEventListener("keydown", hotkeyHandler);
}

function reapplyHotkey() {
    void setupHotkey().catch(e => console.warn("[CompactView] hotkey reapply failed:", e));
}

export default definePlugin({
    name: "CompactView",
    description: "Press Ctrl+Alt+H (configurable) to TOGGLE hiding Discord's sidebars (server rail, channel/DM list, member list). Built for vertical monitors and screenshare-heavy use. Each panel can be controlled independently in settings.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        style = createAndAppendStyle("dm-compact-view", managedStyleRootNode);
        pluginStarted = true;

        if (settings.store.enabledOnStart) setActive(true);
        await setupHotkey();
    },

    stop() {
        pluginStarted = false;
        teardownHotkey();
        style?.remove();
        active = false;
        // Clear the persisted "on" mirror so the Hub toggle doesn't render ON
        // while the feature is actually OFF after a disable/restart.
        try { settings.store.manuallyActive = false; } catch { /* settings not init */ }
    }
});

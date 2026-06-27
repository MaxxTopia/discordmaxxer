/*
 * Discordmaxxer — defaults seeder
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Seeds the Vencord settings.json on first launch with all of the
 * Discordmaxxer-recommended plugins enabled. On subsequent launches, only
 * adds plugins the user has never seen (so we never override choices).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

import { VENCORD_SETTINGS_FILE } from "./constants";

const PLUGINS_DEFAULT_ON: string[] = [
    "FakeNitro",
    "MessageLogger",
    "ClearURLs",
    "AlwaysTrust",
    "ClientTheme",
    "FriendsSince",
    "ImageZoom",
    "TypingTweaks",
    "RelationshipNotifier",
    "SilentTyping",
    "GifPaste",
    "StickerPaste",
    "VolumeBooster",
    "FixCodeblockGap",
    "NoReplyMention",
    "CopyStickerLinks",
    "ValidReply",
    "BetterFolders",
    "BetterSettings",
    "MentionAvatars",
    "MoreQuickReact",
    "NewGuildSettings",
    "NoF1",
    "PinDMs",
    "ReadAllNotificationsButton",
    "SelfForward",
    "TextReplace",
    "ThemeAttributes",
    "ThemeLibrary",
    "WebKeybinds",
    "WebScreenShareFix",
    "BetterGifPicker",
    "FavoriteGifSearch",
    // Privacy / telemetry kill
    "NoTrack", // disables /science + /tracking analytics endpoints
    "BlockKrispWeb", // blocks Discord-funded Krisp noise-cancel from loading (privacy + CPU)
    "DisableCallIdle", // stops auto-voice-disconnect after 5 min (saves a heartbeat round-trip on idle)
    // Discordmaxxer custom plugins
    "TournamentMode",
    "CompactView",
    "MassDelete",
    "DMBadge",
    "DMProfileFlair", // user-set custom banner / animated avatar / theme colors
    "DMTheme",
    "VideoBackground",
    "DMHub",
    "DMWelcome", // first-launch plugin tour + bundles + identity consent
    "DMCursor", // disabled-effect by default — user picks skin
    "DMPrivacy", // one-shot consent prompt to disable Discord telemetry
    "DMTrim", // hides Family Center / Nitro promos / HypeSquad
    "DMPresence", // broadcasts "Playing Discordmaxxer" rich-presence activity
    "DMGrant", // right-click → Grant tier (admin-only UI); cross-references local grants on view
    "DMVipClaim", // settings panel: redeem HWID-locked VIP code → unlocks MAXXER++ tier
    "DMTierFlair", // cross-user status flex: avatar ring, name tint, popout banner, founder gem
    "DMTyping", // MAXXER perk: [VIP]/[VIP+]/[MVP++] prefix in typing indicator
    "DMStreamMute", // local mute toggle for incoming screenshare audio (Ctrl+Shift+M)
    "DMVoiceKeybinds", // GLOBAL mute/deafen hotkeys that work in a fullscreen game (Ctrl+Alt+M / Ctrl+Alt+D)
    "DMVoiceGuard", // safeguard: surfaces a banner when voice silently fails (e.g. Discord change the build can't handle)
    "DMBeta", // MAXXER++ perk: opt-in beta channel for prerelease GitHub tags
    "DMVotes" // MAXXER++ perk: panel for voting on candidate features (polls in #vip-chat)
];

const VENCORD_DEFAULTS = {
    // Vencord's own auto-updater is OFF by default in Discordmaxxer because
    // it pulls fresh upstream Vencord source which silently undoes our
    // rebrand patches (donate card returns, "Vencord" labels reappear,
    // settings tab unrebrands). Discordmaxxer ships its own update channel
    // via electron-updater + GitHub Releases — that's the only updater
    // path users should be on. If a user explicitly flips these on, that's
    // their call, but the default is OFF.
    notifyAboutUpdates: false,
    autoUpdate: false,
    autoUpdateNotification: false,
    useQuickCss: true,
    themeLinks: [],
    enabledThemes: [],
    frameless: false,
    transparent: false,
    winCtrlQ: false,
    macosVibrancyStyle: null,
    disableMinSize: false,
    winNativeTitleBar: false,
    plugins: Object.fromEntries(PLUGINS_DEFAULT_ON.map(name => [name, { enabled: true }]))
};

function readSettingsSafe(): Record<string, any> | null {
    try {
        if (!existsSync(VENCORD_SETTINGS_FILE)) return null;
        const raw = readFileSync(VENCORD_SETTINGS_FILE, "utf-8");
        return JSON.parse(raw);
    } catch (e) {
        console.warn("[Discordmaxxer] Failed to read Vencord settings.json:", e);
        return null;
    }
}

// Tracks which plugins Discordmaxxer has explicitly set as default-on. The key
// distinguishes "Vencord auto-wrote enabled:false on init" from "user toggled
// off". Once a plugin is in this list, we never touch its enabled state again.
const SEEDED_KEY = "discordmaxxerSeededPlugins";

export function seedDiscordmaxxerDefaults() {
    const existing = readSettingsSafe();

    // True first launch — no settings.json exists at all.
    if (existing === null) {
        const defaults = {
            ...VENCORD_DEFAULTS,
            [SEEDED_KEY]: [...PLUGINS_DEFAULT_ON]
        };
        try {
            writeFileSync(VENCORD_SETTINGS_FILE, JSON.stringify(defaults, null, 4));
            console.log(
                `[Discordmaxxer] First-launch seed: enabled ${PLUGINS_DEFAULT_ON.length} default plugins.`
            );
        } catch (e) {
            console.error("[Discordmaxxer] Failed to write default Vencord settings.json:", e);
        }
        return;
    }

    // Migration / new-default application path.
    const plugins = existing.plugins ?? {};
    const seeded: string[] = Array.isArray(existing[SEEDED_KEY]) ? [...existing[SEEDED_KEY]] : [];

    let added = 0;
    for (const name of PLUGINS_DEFAULT_ON) {
        if (seeded.includes(name)) continue; // user has had the chance — leave alone
        plugins[name] = { ...(plugins[name] ?? {}), enabled: true };
        seeded.push(name);
        added++;
    }

    // Forced overrides that ALWAYS reapply on launch (not respected as user
    // preferences). Vencord's auto-updater silently pulls upstream files
    // that undo our rebrand patches — keeping it OFF is structural to the
    // product, not a default the user gets to toggle. If a user wants
    // Vencord-style updates, they can install Vesktop directly.
    const FORCED_OFF_FLAG = "discordmaxxerForcedDefaultsApplied_v1";
    let forcedChanged = false;
    if (!existing[FORCED_OFF_FLAG]) {
        for (const key of ["notifyAboutUpdates", "autoUpdate", "autoUpdateNotification"] as const) {
            if (existing[key] !== false) {
                existing[key] = false;
                forcedChanged = true;
            }
        }
        existing[FORCED_OFF_FLAG] = true;
    }

    if (added === 0 && !forcedChanged) return;

    existing.plugins = plugins;
    existing[SEEDED_KEY] = seeded;
    try {
        writeFileSync(VENCORD_SETTINGS_FILE, JSON.stringify(existing, null, 4));
        console.log(`[Discordmaxxer] Applied ${added} new default(s); future user toggles will be respected.`);
    } catch (e) {
        console.error("[Discordmaxxer] Failed to update Vencord settings.json:", e);
    }
}

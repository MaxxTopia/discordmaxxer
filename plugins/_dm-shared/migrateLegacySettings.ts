/*
 * Discordmaxxer — legacy settings migration helper
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * v0.7.14 renamed the `Discordmaxxer*` plugins to `DM*` for terseness in
 * the settings UI. Vencord stores plugin settings keyed by plugin name, so
 * a naive rename would orphan every user's saved toggles + state.
 *
 * This module runs once on first import: walks `Vencord.PlainSettings.plugins`
 * looking for any of the old `Discordmaxxer*` keys, and if the matching new
 * `DM*` key isn't already populated, copies the old settings forward.
 *
 * The `enabled` field IS copied so user's on/off choice survives the rename.
 * The discordmaxxerDefaults seed only runs on first launch — for upgrading
 * users, the new DM* plugin names start unset (Vencord default = off) unless
 * we forward the old enabled state. The old record is left in place as a
 * rollback safety net (cheap; tiny JSON).
 *
 * Plugins that were renamed import this module via side-effect:
 *     import "../_dm-shared/migrateLegacySettings";
 * Multiple imports are deduplicated by the module-level `migrated` latch.
 */

const PLUGIN_RENAMES: Array<[string, string]> = [
    ["DiscordmaxxerBadge", "DMBadge"],
    ["DiscordmaxxerTheme", "DMTheme"],
    ["DiscordmaxxerHub", "DMHub"],
    ["DiscordmaxxerCursor", "DMCursor"],
    ["DiscordmaxxerPrivacy", "DMPrivacy"],
    ["DiscordmaxxerTrim", "DMTrim"],
    ["DiscordmaxxerPresence", "DMPresence"],
    ["DiscordmaxxerGrant", "DMGrant"],
    ["DiscordmaxxerVipClaim", "DMVipClaim"],
    ["DiscordmaxxerTierFlair", "DMTierFlair"],
    ["DiscordmaxxerTyping", "DMTyping"],
    ["DiscordmaxxerStreamMute", "DMStreamMute"],
    ["DiscordmaxxerBeta", "DMBeta"],
    ["DiscordmaxxerVotes", "DMVotes"]
];

let migrated = false;

function doMigrate(): boolean {
    const v = (globalThis as any).Vencord;
    const plain = v?.PlainSettings?.plugins;
    const settings = v?.Settings?.plugins;
    if (!plain || !settings) return false; // Vencord not ready yet — retry caller

    let copied = 0;
    for (const [oldName, newName] of PLUGIN_RENAMES) {
        const oldEntry = plain[oldName];
        if (!oldEntry || typeof oldEntry !== "object") continue;
        const newEntry = plain[newName];

        // Ensure the destination object exists before writing into it.
        // Vencord's settings proxy does not reliably auto-vivify a nested
        // plugin object on first write across versions — without this, every
        // `settings[newName][key] = …` below throws, the forward-copy silently
        // fails, and yet we'd still delete the legacy entry → permanent data
        // loss. `forwardOk` tracks whether the copy actually landed so we only
        // delete the source when it's safe.
        let forwardOk = true;
        try {
            if (!settings[newName] || typeof settings[newName] !== "object") {
                settings[newName] = {};
            }
        } catch (e) {
            console.warn(`[migrate] could not initialize ${newName}:`, e);
            forwardOk = false;
        }

        // Sync `enabled` from old to new. Vencord defaults unseeded plugins
        // to enabled=false which is indistinguishable from a real user
        // "disable" choice — but the user never saw the new DM* plugin name
        // before this migration ran, so the old plugin's enabled state IS
        // their effective choice.
        if (forwardOk && "enabled" in oldEntry) {
            try {
                if (settings[newName].enabled !== oldEntry.enabled) {
                    settings[newName].enabled = oldEntry.enabled;
                }
            } catch (e) {
                console.warn(`[migrate] ${newName}.enabled write failed:`, e);
                forwardOk = false;
            }
        }

        // Migrate non-enabled keys only when the new plugin entry doesn't
        // yet have user data (avoid clobbering user changes on a re-run).
        const newHasUserData = newEntry && Object.keys(newEntry).filter(k => k !== "enabled").length > 0;
        if (forwardOk && !newHasUserData) {
            for (const [key, value] of Object.entries(oldEntry)) {
                if (key === "enabled") continue; // handled above
                try {
                    settings[newName][key] = value;
                } catch (e) {
                    console.warn(`[migrate] ${newName}.${key} write failed:`, e);
                    forwardOk = false; // don't delete the source if a key was lost
                }
            }
        }

        // Delete the legacy entry ONLY once the forward-copy is confirmed, so
        // future runs skip this pair and the user can disable the new plugin
        // without the migration re-enabling it. If anything above failed, keep
        // the old entry as the source of truth — a later launch retries it.
        if (forwardOk) {
            try {
                delete settings[oldName];
            } catch (e) {
                console.warn(`[migrate] delete ${oldName} failed:`, e);
            }
            copied++;
        }
    }
    if (copied > 0) {
        console.log(`[migrate] migrated ${copied} plugin(s) Discordmaxxer* → DM* and cleaned up legacy entries`);
    }
    return true;
}

function scheduleMigrate(): void {
    if (migrated) return;
    if (doMigrate()) {
        migrated = true;
        return;
    }
    // Vencord settings not initialized yet — back off and retry. Plugin start
    // hooks run after Vencord boots so this usually resolves in <100ms.
    setTimeout(scheduleMigrate, 100);
}

scheduleMigrate();

export { };

/*
 * Discordmaxxer — DiscordmaxxerBadge plugin (Channel A)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Identity layer:
 *   A) Profile badge (mod-side only, default-on)
 *
 * Channels B (custom status), C (bio append) and D (pronouns) were retired —
 * DiscordmaxxerPresence broadcasts "Playing Discordmaxxer" via gateway rich
 * presence with the brand logo, which is strictly better than putting text
 * into someone's profile + zero TOS risk. A legacy clear toggle remains for
 * users who set the older "Using Discordmaxxer" custom status.
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { RestAPI, Toasts, UserStore } from "@webpack/common";

import { getRosterTier, refreshRoster } from "../_dm-shared/roster";
import { Tier } from "../_dm-shared/vip";

// Profile-badge mark — v1 horror-Clyde, 96px PNG with TRANSPARENT background,
// glyph cropped tight (no cream sticker frame, no padding) so the badge fills
// its ~22-24px Discord popout slot edge-to-edge. The bullet-hole + red-eye
// detail still reads as a "shot up Discord mascot" identity at that size.
// Pipeline: build/icon-source.png -> bbox-crop -> LANCZOS resize 96px ->
// base64 (see branding/generated/make-badge-icon.py).
const BADGE_ICON =
    "data:image/png;base64,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";

function toast(msg: string, type: any = Toasts.Type.SUCCESS) {
    Toasts.show({
        message: msg,
        type,
        id: Toasts.genId(),
        options: { duration: 3000, position: Toasts.Position.TOP }
    });
}

async function clearCustomStatus() {
    try {
        await RestAPI.patch({
            url: "/users/@me/settings",
            body: { custom_status: null }
        });
        toast("✅ Custom status cleared");
        return true;
    } catch (e) {
        console.warn("[DiscordmaxxerBadge] clearCustomStatus failed:", e);
        toast("Failed to clear custom status — see console", Toasts.Type.FAILURE);
        return false;
    }
}

const settings = definePluginSettings({
    // Channel A — profile badge
    showOnOwnProfile: {
        type: OptionType.BOOLEAN,
        description:
            "[Channel A] Render the DM badge on YOUR OWN profile in YOUR OWN Discordmaxxer client. " +
            "Note: this toggle is LOCAL-ONLY — it doesn't affect what other people see. The badge only renders inside Discordmaxxer (vanilla Discord doesn't show it). " +
            "Visibility logic: any user found on the Discordmaxxer tier roster (= anyone who's redeemed a MAXXER / MAXXER+ / MAXXER++ / Founder code) automatically gets a badge on their profile when viewed from another Discordmaxxer client. " +
            "Free-tier friends who haven't claimed a code aren't in the roster yet — paste their user IDs into 'extraUserIds' below to show their badge.",
        default: true
    },
    extraUserIds: {
        type: OptionType.STRING,
        description:
            "[Channel A] Comma-separated additional user IDs to show the badge for. Use this to surface badges on free-tier Discordmaxxer friends who aren't in the tier roster. Right-click a user → 'Copy User ID' (requires Discord Developer Mode in Advanced settings).",
        default: ""
    },
    remoteListUrl: {
        type: OptionType.STRING,
        description: "[Channel A] Optional URL returning a JSON array of user IDs (fetched once on plugin start). Most users can leave this empty — the tier roster covers anyone who's claimed a code.",
        default: ""
    },

    // Legacy clear-status toggle — retired Channel B. Kept so users who set
    // the old "Using Discordmaxxer" custom status (pre-DiscordmaxxerPresence)
    // can wipe it. Toggling OFF does nothing.
    clearLegacyStatus: {
        type: OptionType.BOOLEAN,
        description:
            "Clear any 'Using Discordmaxxer' custom status set by a prior version. Flip ON once to PATCH custom_status to null. Toggling OFF does nothing.",
        default: false,
        onChange: (value: boolean) => {
            if (value) clearCustomStatus();
        }
    }
});

const knownIds = new Set<string>();

function rebuildKnownIds() {
    knownIds.clear();
    if (settings.store.showOnOwnProfile) {
        const me = UserStore.getCurrentUser();
        if (me?.id) knownIds.add(me.id);
    }
    settings.store.extraUserIds
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(id => knownIds.add(id));
}

async function loadRemoteList() {
    const url = settings.store.remoteListUrl?.trim();
    if (!url) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) {
            console.warn(`[DiscordmaxxerBadge] remote list fetch ${res.status}`);
            return;
        }
        const ids: unknown = await res.json();
        if (!Array.isArray(ids)) {
            console.warn("[DiscordmaxxerBadge] remote list is not an array");
            return;
        }
        let added = 0;
        for (const id of ids) {
            if (typeof id === "string" && id.length >= 17) {
                if (!knownIds.has(id)) added++;
                knownIds.add(id);
            }
        }
        console.log(`[DiscordmaxxerBadge] remote list loaded: +${added} new (${knownIds.size} total)`);
    } catch (e) {
        console.warn("[DiscordmaxxerBadge] remote list load failed:", e);
    } finally {
        clearTimeout(timer);
    }
}

const badge: ProfileBadge = {
    id: "discordmaxxer-user",
    description: "Discordmaxxer user — discord, optimized",
    iconSrc: BADGE_ICON,
    link: "https://maxxtopia.com/discordmaxxer",
    position: BadgePosition.START,
    // Show on: (1) IDs in the local knownIds set — your own ID if
    // showOnOwnProfile is on, plus extraUserIds, plus optional remoteListUrl,
    // OR (2) anyone present on the Discordmaxxer tier roster (i.e., they've
    // redeemed a paid claim code). The roster covers the common "two friends
    // running DM" case without either user having to manually paste IDs.
    // Free-tier users without paid claims aren't in the roster — those
    // friends need to be added manually via the extraUserIds setting.
    shouldShow: ({ userId }) => knownIds.has(userId) || getRosterTier(userId) !== Tier.FREE
};

export default definePlugin({
    name: "DMBadge",
    description:
        "A small Discordmaxxer badge on your profile, mod-only visibility (other DM users see it; vanilla Discord users see nothing different). Custom-status / bio / pronouns broadcasting was retired — see DiscordmaxxerPresence (rich presence card with the brand logo) for the identity-broadcast job those channels used to do.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        rebuildKnownIds();
        addProfileBadge(badge);
        // Kick off a roster refresh so paid-tier users appear in the cache
        // soon after launch. shouldShow() reads the cache synchronously and
        // returns Tier.FREE for un-cached users — meaning the first time you
        // open a paid friend's profile after a fresh launch you might not
        // see the badge, but the next render (after the fetch resolves) will.
        // Discord re-renders profile popouts on every open, so the catch-up
        // is invisible in practice.
        refreshRoster().catch(e => console.warn("[DiscordmaxxerBadge] roster refresh failed:", e));
        await loadRemoteList();
    },

    stop() {
        removeProfileBadge(badge);
        knownIds.clear();
    }
});

/*
 * Discordmaxxer — Rich Presence
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Broadcasts a "Playing Discordmaxxer" activity so the user shows up
 * in friends' member lists with the brand. Uses the same FluxDispatcher
 * LOCAL_ACTIVITY_UPDATE path as LastFMRichPresence — the gateway then
 * syncs the activity to the server.
 *
 * Tier behaviour:
 * - FREE / MAXXER: presence is mandatory ON; activity name/details/
 *   state/type/button are locked to the brand defaults; "Get
 *   Discordmaxxer" button is forced visible (it's how we grow).
 * - MAXXER+ / MAXXER++: every field is freely customizable, and the
 *   user can disable the activity entirely.
 *
 * Anti-self-bot rule: this is a CLIENT-presence broadcast (the same
 * mechanism Discord apps use to show "Playing CSGO"). Not a profile
 * mutation. We set ONCE on plugin start and refresh on a low cadence
 * so the activity doesn't decay.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

import { hasTier, Tier } from "../_dm-shared/vip";

const SOCKET_ID = "Discordmaxxer";
const REFRESH_MS = 60_000;
// v0.6.0+ ladder: custom rich-presence text is the MAXXER++ marquee perk
// (vanilla-visible flex — every friend sees whatever you write on their
// friends list). FREE / MAXXER / MAXXER+ stay locked to brand defaults
// because the broadcast is how we grow. MAXXER++ unlocks all fields and
// the disable toggle.
const VIP_GATE = Tier.MAXXER_PLUS_PLUS;
const isCustomizable = () => hasTier(VIP_GATE);
const isLocked = () => !isCustomizable();

// Discord application registration — required for the big-logo Fortnite-style
// activity card. One-time setup at https://discord.com/developers/applications:
//   1. New Application → name "Discordmaxxer" → copy the Application ID
//   2. Rich Presence → Art Assets → upload v1 mark (1024x1024 PNG)
//      under the asset name "dm_logo"
//   3. (Optional) upload a smaller secondary asset as "dm_badge"
//   4. Paste the Application ID below; assets are auto-resolved by name.
// If DM_APPLICATION_ID is empty the plugin falls back to text-only activity.
const DM_APPLICATION_ID = "1502451778426372116";
// NOTE: dev portal currently has a duplicate "discordmaxxer-mark-primary"
// asset (two uploads, same name → Discord can't disambiguate, renders ?).
// Use the uniquely-named "discordmaxxer-logo-v1" instead. Same image content.
const DM_LARGE_IMAGE_KEY = "discordmaxxer-logo-v1";
const DM_SMALL_IMAGE_KEY = ""; // e.g. "dm_badge" if a secondary asset is uploaded
const DM_SMALL_IMAGE_TEXT = "maxxtopia.com";

// Pull the running DM version from the Electron app at broadcast time so the
// logo tooltip reads "Discordmaxxer v0.7.26 • maxxtopia.com" — lets anyone
// (including vanilla viewers) tell which version a user is running just by
// hovering the activity card's big logo. Critical for diagnosing stale builds
// without having to DM users for screenshots.
function getLargeImageText(): string {
    try {
        const v = (globalThis as any).VesktopNative?.app?.getVersion?.();
        return v ? `Discordmaxxer v${v} • maxxtopia.com` : "Discordmaxxer • maxxtopia.com";
    } catch {
        return "Discordmaxxer • maxxtopia.com";
    }
}

const DEFAULT_NAME = "Discordmaxxer";
const DEFAULT_DETAILS = "Discord, optimized";
const DEFAULT_STATE = "maxxtopia.com";
const DEFAULT_BUTTON_LABEL = "Visit maxxtopia.com";
const DEFAULT_BUTTON_URL = "https://maxxtopia.com";

let timer: ReturnType<typeof setInterval> | null = null;

function setActivity(activity: any | null) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: SOCKET_ID
    });
}

// Resolve a Rich Presence asset NAME to its asset SNOWFLAKE ID. Discord's
// gateway expects `assets.large_image` to be a snowflake, not the dev-portal
// asset name — sending the name renders ? on the activity card. LastFM does
// the same lookup via fetchAssetIds.
//
// Cache the resolved id: the asset snowflake for a fixed (app, name) never
// changes, but buildActivity() runs on every 60s refresh — without the cache
// that's a network round-trip per tick for a constant value.
const assetIdCache = new Map<string, string>();
async function resolveAssetId(name: string): Promise<string | undefined> {
    if (!name || !DM_APPLICATION_ID) return undefined;
    const cached = assetIdCache.get(name);
    if (cached) return cached;
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(DM_APPLICATION_ID, [name]);
        const id = ids?.[0];
        if (id) assetIdCache.set(name, id);
        return id;
    } catch (e) {
        console.warn("[DiscordmaxxerPresence] resolveAssetId failed:", name, e);
        return undefined;
    }
}

async function buildActivity() {
    const s = settings.store;
    const customizable = isCustomizable();

    // Non-VIP+ users: always show, ignore the enabled toggle.
    // VIP+ users: respect the enabled toggle.
    if (customizable && !s.enabled) return null;

    const ACTIVITY_TYPE_PLAYING = 0;
    const ACTIVITY_TYPE_COMPETING = 5;
    const ACTIVITY_TYPE_WATCHING = 3;

    const typeMap: Record<string, number> = {
        playing: ACTIVITY_TYPE_PLAYING,
        watching: ACTIVITY_TYPE_WATCHING,
        competing: ACTIVITY_TYPE_COMPETING
    };

    const showButton = customizable ? s.showButton : true;

    // Big-logo card requires application_id + a large_image SNOWFLAKE (not name).
    // Fall back to text-only activity if the app isn't registered yet.
    const hasApp = DM_APPLICATION_ID.length > 0;
    const largeId = hasApp ? await resolveAssetId(DM_LARGE_IMAGE_KEY) : undefined;
    const smallId = hasApp && DM_SMALL_IMAGE_KEY ? await resolveAssetId(DM_SMALL_IMAGE_KEY) : undefined;
    const assets = largeId
        ? {
              large_image: largeId,
              large_text: getLargeImageText(),
              ...(smallId ? { small_image: smallId, small_text: DM_SMALL_IMAGE_TEXT } : {})
          }
        : undefined;

    return {
        application_id: hasApp ? DM_APPLICATION_ID : undefined,
        name: customizable ? (s.name || DEFAULT_NAME) : DEFAULT_NAME,
        details: customizable ? (s.details || DEFAULT_DETAILS) : DEFAULT_DETAILS,
        state: customizable ? (s.state || DEFAULT_STATE) : DEFAULT_STATE,
        type: customizable ? (typeMap[s.activityType] ?? ACTIVITY_TYPE_PLAYING) : ACTIVITY_TYPE_PLAYING,
        flags: 1, // INSTANCE — keeps the entry stable
        assets,
        timestamps: s.showElapsed ? { start: Date.now() } : undefined,
        buttons: showButton ? [DEFAULT_BUTTON_LABEL] : undefined,
        metadata: showButton ? { button_urls: [DEFAULT_BUTTON_URL] } : undefined
    };
}

async function refresh() {
    setActivity(await buildActivity());
}

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description:
            "Show 'Playing Discordmaxxer' so friends see what client you use. " +
            "Locked ON for FREE / MAXXER / MAXXER+ tier; MAXXER++ can disable.",
        default: true,
        disabled: isLocked,
        onChange: refresh
    },
    activityType: {
        type: OptionType.SELECT,
        description: "How the activity displays: 'Playing X', 'Watching X', or 'Competing in X'. (MAXXER++)",
        default: "playing",
        options: [
            { label: "Playing Discordmaxxer", value: "playing", default: true },
            { label: "Watching Discordmaxxer", value: "watching" },
            { label: "Competing in Discordmaxxer", value: "competing" }
        ],
        disabled: isLocked,
        onChange: refresh
    },
    name: {
        type: OptionType.STRING,
        description: "Activity name (the bold line in the user list). (MAXXER++)",
        default: DEFAULT_NAME,
        disabled: isLocked,
        onChange: refresh
    },
    details: {
        type: OptionType.STRING,
        description: "First details line under the activity name. (MAXXER++)",
        default: DEFAULT_DETAILS,
        disabled: isLocked,
        onChange: refresh
    },
    state: {
        type: OptionType.STRING,
        description: "Second details line (shows under details). (MAXXER++)",
        default: DEFAULT_STATE,
        disabled: isLocked,
        onChange: refresh
    },
    showElapsed: {
        type: OptionType.BOOLEAN,
        description: "Show 'XX:XX elapsed' timer.",
        default: true,
        onChange: refresh
    },
    showButton: {
        type: OptionType.BOOLEAN,
        description:
            "Show a 'Get Discordmaxxer' button on your activity card (visible on profile hover). " +
            "Forced ON for FREE / MAXXER / MAXXER+ tier.",
        default: true,
        disabled: isLocked,
        onChange: refresh
    }
});

export default definePlugin({
    name: "DMPresence",
    description:
        "Broadcasts 'Playing Discordmaxxer' as your activity so friends see what client you use. " +
        "Standard rich-presence — no profile mutations. " +
        "FREE / MAXXER / MAXXER+ tier: locked ON with brand defaults (it's how we grow). " +
        "MAXXER++ tier: customize the activity name, details, state, type, button, or disable entirely — vanilla-visible flex (your whole friends list sees it).",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        refresh();
        timer = setInterval(refresh, REFRESH_MS);
    },

    stop() {
        if (timer) clearInterval(timer);
        timer = null;
        setActivity(null);
    }
});

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
 * - FREE / MAXXER / MAXXER+: presence stays on, but activity text and type
 *   are editable so every user can personalize the presence they share.
 * - MAXXER++: also gets the ability to disable the presence, hide the
 *   acquisition button, and fully control the remaining acquisition controls.
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
// Presence text and activity type are free for every tier because they are a
// useful identity hook and a better first-run experience. FREE keeps the
// activity on so the client can advertise itself; MAXXER and above may turn
// it off. The clean second widget button remains a separate MAXXER++ perk.
const PRESENCE_DISABLE_GATE = Tier.MAXXER;
const CLEAN_WIDGET_GATE = Tier.MAXXER_PLUS_PLUS;
const canDisablePresence = () => hasTier(PRESENCE_DISABLE_GATE);
const canUseCleanWidget = () => hasTier(CLEAN_WIDGET_GATE);
const presenceLocked = () => !canDisablePresence();

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
// logo tooltip reads "Discordmaxxer v<current> • maxxtopia.com" — lets anyone
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
// that's a network round-trip per tick for a constant value. The cache key is
// scoped by app id so Widget Mode (a user's OWN app) can't collide with the
// brand app's assets.
const assetIdCache = new Map<string, string>();
async function resolveAssetId(appId: string, name: string): Promise<string | undefined> {
    if (!name || !appId) return undefined;
    const key = `${appId}:${name}`;
    const cached = assetIdCache.get(key);
    if (cached) return cached;
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(appId, [name]);
        const id = ids?.[0];
        if (id) assetIdCache.set(key, id);
        return id;
    } catch (e) {
        console.warn("[DiscordmaxxerPresence] resolveAssetId failed:", appId, name, e);
        return undefined;
    }
}

// A Discord Application ID is a 17-20 digit snowflake. Widget Mode only wires
// up the user's app (assets + buttons need it) once it looks well-formed.
const APP_ID_RE = /^\d{17,20}$/;

// Activity type ids (Discord gateway). Shared by both the branded promo path
// and Widget Mode.
const ACTIVITY_TYPE_PLAYING = 0;
const ACTIVITY_TYPE_LISTENING = 2;
const ACTIVITY_TYPE_WATCHING = 3;
const ACTIVITY_TYPE_COMPETING = 5;
const TYPE_MAP: Record<string, number> = {
    playing: ACTIVITY_TYPE_PLAYING,
    listening: ACTIVITY_TYPE_LISTENING,
    watching: ACTIVITY_TYPE_WATCHING,
    competing: ACTIVITY_TYPE_COMPETING
};

// Widget Mode: broadcast a fully self-serve Rich Presence card from the user's
// OWN Discord application — same flow as CustomRP, but native and tokenless.
// They register an app at discord.com/developers/applications, paste its
// Application ID, upload art under Rich Presence → Art Assets, and reference
// each asset by name here. Images + buttons require the app id (Discord ties
// them to a registered application); without one it degrades to a text card.
//
// Free for ALL tiers (it's an acquisition hook), but the brand rides along:
// FREE / MAXXER / MAXXER+ get ONE button of their own; the 2nd slot is locked
// to a non-removable "Get Discordmaxxer" button so their widget augments growth
// instead of replacing the promo card. MAXXER++ (`clean`) gets both buttons
// free and no forced brand.
async function buildWidgetActivity(clean: boolean) {
    const s = settings.store;
    const appId = (s.widgetAppId || "").trim();
    const hasApp = APP_ID_RE.test(appId);

    const largeId = hasApp && s.widgetLargeImage
        ? await resolveAssetId(appId, s.widgetLargeImage.trim())
        : undefined;
    const smallId = hasApp && s.widgetSmallImage
        ? await resolveAssetId(appId, s.widgetSmallImage.trim())
        : undefined;

    const largeText = (s.widgetLargeText || "").trim();
    const smallText = (s.widgetSmallText || "").trim();
    let assets: any;
    if (largeId) {
        assets = { large_image: largeId, ...(largeText ? { large_text: largeText } : {}) };
        if (smallId) {
            assets.small_image = smallId;
            if (smallText) assets.small_text = smallText;
        }
    } else if (smallId) {
        assets = { small_image: smallId, ...(smallText ? { small_text: smallText } : {}) };
    }

    // Up to 2 buttons. Only keep pairs with a label AND a well-formed http(s)
    // url — a labelless or malformed button makes Discord drop the whole card.
    const labels: string[] = [];
    const urls: string[] = [];
    const addButton = (label?: string, url?: string) => {
        const l = (label || "").trim();
        const u = (url || "").trim();
        if (labels.length < 2 && l && /^https?:\/\/\S+$/i.test(u)) {
            labels.push(l);
            urls.push(u);
        }
    };
    addButton(s.widgetButton1Label, s.widgetButton1Url);
    if (clean) {
        // MAXXER++: second button is theirs too.
        addButton(s.widgetButton2Label, s.widgetButton2Url);
    } else {
        // Lower tiers: the brand rides in the 2nd slot, non-removable.
        addButton("Get Discordmaxxer", DEFAULT_BUTTON_URL);
    }

    return {
        application_id: hasApp ? appId : undefined,
        name: (s.widgetName || "").trim() || DEFAULT_NAME,
        details: (s.widgetDetails || "").trim() || undefined,
        state: (s.widgetState || "").trim() || undefined,
        type: TYPE_MAP[s.widgetType] ?? ACTIVITY_TYPE_PLAYING,
        flags: 1, // INSTANCE — keeps the entry stable
        assets,
        timestamps: s.showElapsed ? { start: Date.now() } : undefined,
        buttons: labels.length ? labels : undefined,
        metadata: urls.length ? { button_urls: urls } : undefined
    };
}

async function buildActivity() {
    const s = settings.store;
    const canDisable = canDisablePresence();

    // FREE users: always show, ignore the enabled toggle.
    // MAXXER and above: respect the enabled toggle.
    if (canDisable && !s.enabled) return null;

    // Widget Mode is free for every tier; the builder itself forces the brand
    // button for non-MAXXER++ so the promo still rides along. `clean` = ++.
    if (s.widgetMode) return buildWidgetActivity(canUseCleanWidget());

    const typeMap = TYPE_MAP;

    const showButton = canDisable ? s.showButton : true;

    // Big-logo card requires application_id + a large_image SNOWFLAKE (not name).
    // Fall back to text-only activity if the app isn't registered yet.
    const hasApp = DM_APPLICATION_ID.length > 0;
    const largeId = hasApp ? await resolveAssetId(DM_APPLICATION_ID, DM_LARGE_IMAGE_KEY) : undefined;
    const smallId = hasApp && DM_SMALL_IMAGE_KEY ? await resolveAssetId(DM_APPLICATION_ID, DM_SMALL_IMAGE_KEY) : undefined;
    const assets = largeId
        ? {
              large_image: largeId,
              large_text: getLargeImageText(),
              ...(smallId ? { small_image: smallId, small_text: DM_SMALL_IMAGE_TEXT } : {})
          }
        : undefined;

    return {
        application_id: hasApp ? DM_APPLICATION_ID : undefined,
        name: s.name || DEFAULT_NAME,
        details: s.details || DEFAULT_DETAILS,
        state: s.state || DEFAULT_STATE,
        type: typeMap[s.activityType] ?? ACTIVITY_TYPE_PLAYING,
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
            "FREE is locked ON; MAXXER and above can disable it.",
        default: true,
        disabled: presenceLocked,
        onChange: refresh
    },
    activityType: {
        type: OptionType.SELECT,
        description: "How the activity displays: 'Playing X', 'Watching X', or 'Competing in X'. Free for every tier.",
        default: "playing",
        options: [
            { label: "Playing Discordmaxxer", value: "playing", default: true },
            { label: "Watching Discordmaxxer", value: "watching" },
            { label: "Competing in Discordmaxxer", value: "competing" }
        ],
        onChange: refresh
    },
    name: {
        type: OptionType.STRING,
        description: "Activity name (the bold line in the user list). Free for every tier.",
        default: DEFAULT_NAME,
        onChange: refresh
    },
    details: {
        type: OptionType.STRING,
        description: "First details line under the activity name. Free for every tier.",
        default: DEFAULT_DETAILS,
        onChange: refresh
    },
    state: {
        type: OptionType.STRING,
        description: "Second details line (shows under details). Free for every tier.",
        default: DEFAULT_STATE,
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
            "FREE is forced ON; MAXXER and above can hide it.",
        default: true,
        disabled: presenceLocked,
        onChange: refresh
    },

    // ---- Widget Mode (FREE, all tiers) : self-serve custom Rich Presence ----
    // When ON, the branded fields above are ignored and the fields below
    // broadcast a fully custom card from the user's OWN Discord application.
    // Free for everyone as an acquisition hook; the brand rides along for
    // non-MAXXER++ via a locked "Get Discordmaxxer" 2nd button (enforced in
    // buildWidgetActivity, not here). MAXXER++ gets a clean card + both buttons.
    // Setup:
    //   1. discord.com/developers/applications -> New Application (its name is
    //      the bold line if you leave "Widget: activity name" blank)
    //   2. Rich Presence -> Art Assets -> upload images, note each asset NAME
    //   3. Paste the Application ID + asset names below.
    widgetMode: {
        type: OptionType.BOOLEAN,
        description:
            "WIDGET MODE (free): broadcast your OWN custom profile widget instead of the Discordmaxxer promo. " +
            "Uses your own Discord application — images + button + text you control. Tokenless (standard Rich Presence). " +
            "FREE / MAXXER / MAXXER+: your 2nd button is a locked 'Get Discordmaxxer' link. MAXXER++: both buttons free. " +
            "When ON, the branded fields above are ignored.",
        default: false,
        onChange: refresh
    },
    widgetAppId: {
        type: OptionType.STRING,
        description:
            "Widget: your Discord Application ID (discord.com/developers/applications -> your app -> copy Application ID). " +
            "Required for images and buttons to show.",
        default: "",
        onChange: refresh
    },
    widgetName: {
        type: OptionType.STRING,
        description: "Widget: activity name (the bold line). Blank = your application's name.",
        default: "",
        onChange: refresh
    },
    widgetType: {
        type: OptionType.SELECT,
        description: "Widget: how it reads — Playing / Listening to / Watching / Competing in.",
        default: "playing",
        options: [
            { label: "Playing", value: "playing", default: true },
            { label: "Listening to", value: "listening" },
            { label: "Watching", value: "watching" },
            { label: "Competing in", value: "competing" }
        ],
        onChange: refresh
    },
    widgetDetails: {
        type: OptionType.STRING,
        description: "Widget: first line under the name (details).",
        default: "",
        onChange: refresh
    },
    widgetState: {
        type: OptionType.STRING,
        description: "Widget: second line (state).",
        default: "",
        onChange: refresh
    },
    widgetLargeImage: {
        type: OptionType.STRING,
        description: "Widget: large image — the asset NAME you uploaded under your app's Rich Presence -> Art Assets.",
        default: "",
        onChange: refresh
    },
    widgetLargeText: {
        type: OptionType.STRING,
        description: "Widget: tooltip shown when hovering the large image.",
        default: "",
        onChange: refresh
    },
    widgetSmallImage: {
        type: OptionType.STRING,
        description: "Widget: small corner image — another Art Asset NAME (optional).",
        default: "",
        onChange: refresh
    },
    widgetSmallText: {
        type: OptionType.STRING,
        description: "Widget: tooltip shown when hovering the small image.",
        default: "",
        onChange: refresh
    },
    widgetButton1Label: {
        type: OptionType.STRING,
        description: "Widget: button 1 label (needs a valid URL below to show).",
        default: "",
        onChange: refresh
    },
    widgetButton1Url: {
        type: OptionType.STRING,
        description: "Widget: button 1 link (must start with http:// or https://).",
        default: "",
        onChange: refresh
    },
    widgetButton2Label: {
        type: OptionType.STRING,
        description: "Widget: button 2 label. MAXXER++ only — lower tiers' 2nd slot is the 'Get Discordmaxxer' button.",
        default: "",
        disabled: () => !canUseCleanWidget(),
        onChange: refresh
    },
    widgetButton2Url: {
        type: OptionType.STRING,
        description: "Widget: button 2 link (must start with http:// or https://). MAXXER++ only.",
        default: "",
        disabled: () => !canUseCleanWidget(),
        onChange: refresh
    }
});

export default definePlugin({
    name: "DMPresence",
    description:
        "Broadcasts 'Playing Discordmaxxer' as your activity so friends see what client you use. " +
        "Standard rich-presence — no profile mutations. " +
        "FREE / MAXXER / MAXXER+ tier: customize the activity name, details, state, and type. " +
        "FREE keeps the activity on; MAXXER and above can hide the acquisition button or disable it entirely — vanilla-visible flex (your whole friends list sees it). " +
        "Widget Mode (free, all tiers): broadcast your OWN custom profile widget from your own Discord app (images, buttons, custom text) — the native, tokenless CustomRP replacement. Non-MAXXER++ carry a locked 'Get Discordmaxxer' 2nd button so the brand still rides along.",
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

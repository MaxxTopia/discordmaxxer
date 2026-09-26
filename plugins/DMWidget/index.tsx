/*
 * Discordmaxxer — DMWidget plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One-click custom Discord PROFILE BOARD WIDGET ("widgets v2" / Social SDK) —
 * the card that shows on the board tab / profile popout. The full underground
 * flow (create app -> Social SDK -> upload image asset -> build+publish the
 * widget layout -> authorize -> pin to profile -> claim the profile identity)
 * runs here as plain authenticated REST calls, so the user never touches
 * DevTools, the Developer Portal, or a paid "widget maker" site.
 *
 * Model B (per-user, self-owned): the app is created & owned by the USER; the
 * bot token (minted via /bot/reset, which is why it needs their 2FA) is used
 * once for the identity claim and never stored.
 *
 * Everything here was reverse-engineered live against Discord (2026-07):
 *  - Images are UPLOADED application assets (3-step upload), referenced with
 *    value_type "application_asset" — NOT raw URLs.
 *  - Surfaces: widget_top(hero), widget_bottom(stats), add_widget_preview,
 *    and mini_profile (mini_profile_hero_stat = hero_image + stat.text) which
 *    drives the profile-popout cutout.
 *  - Existing widgets are read from GET /users/{id}/profile (the /users/@me/
 *    widgets GET verb is 405).
 *  - The identity claim PATCH must be sent header-clean from the main process
 *    (see native.ts) or Discord returns 403 code 40333.
 *
 * HONEST CAVEATS (surfaced in the UI):
 *  - Custom app widgets are a pre-GA Discord experiment. Whether a given
 *    VIEWER sees your widget depends on Discord enrolling THEIR account in the
 *    rollout — not something any tool controls. Owners just make the widget
 *    correct; visibility spreads as Discord ships it.
 *  - Undocumented endpoints — Discord can change or pull this at any time.
 *  - Never name the app after a real brand — that's the one bannable thing.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import * as DataStore from "@api/DataStore";
import { Button, React, RestAPI, Toasts, UserStore } from "@webpack/common";

import { makePersistentValue } from "../_dm-shared/persist";
import { DEFAULT_APP_ICONS, FN_RANK_ICONS } from "./logos";

const Native = VencordNative.pluginHelpers.DMWidget as PluginNative<typeof import("./native")>;

// Default hero render per game — used when you haven't pasted your own image URL,
// so a game card looks finished on first Create. A direct URL (not baked base64;
// full agent portraits are ~800KB); uploadHeroAsset's native fetch handles the
// CORS-blocked host. These are a deliberately small, curated set rather than a
// giant cosmetics catalog. The user can still paste any direct image URL.
const DEFAULT_HEROES: Record<string, string> = {
    valorant: "https://media.valorant-api.com/agents/bb2a4828-46eb-8cd1-e765-15848195d751/fullportrait.png",
    fortnite: "https://fortnite-api.com/images/cosmetics/br/cid_530_athena_commando_f_blackmonday_1bv6j/featured.png"
};

const VALORANT_HERO_PRESETS: Record<string, string> = {
    neon: DEFAULT_HEROES.valorant,
    jett: "https://media.valorant-api.com/agents/add6443a-41bd-e414-f6ad-e58d267f4e95/fullportrait.png",
    reyna: "https://media.valorant-api.com/agents/a3bfb853-43b2-7238-a4f1-ad90e9e46bcc/fullportrait.png",
    raze: "https://media.valorant-api.com/agents/f94c3b30-42be-e959-889c-5aa313dba261/fullportrait.png",
    sage: "https://media.valorant-api.com/agents/569fdd95-4d10-43ab-ca70-79becc718b46/fullportrait.png"
};

const FORTNITE_HERO_PRESETS: Record<string, string> = {
    catwoman: DEFAULT_HEROES.fortnite
};

// ---- local (per-user) identity: the self-owned app + its widget config ------
interface WidgetIdentity {
    appId: string;
    configId: string;
    heroAssetKey: string; // last uploaded hero asset, so refreshes reuse it
    heroImageUrl: string; // per-slot hero source URL (so each slot keeps its own image + preview)
    appIconUrl: string;   // per-slot app-icon URL (so a FN slot can wear an F logo, Valorant its own)
    rankIconKey: string;  // uploaded rank-badge asset for the current-rank stat cell
    rankIconName: string; // the rank name that badge is for (skip re-upload until it changes)
    peakIconKey: string;  // uploaded rank-badge asset for the peak-rank stat cell
    peakIconName: string;
    widgetStyle?: string;
    topLayout?: "hero" | "contained";
    bottomLayout?: "stats" | "progress";
}
const EMPTY_IDENTITY: WidgetIdentity = { appId: "", configId: "", heroAssetKey: "", heroImageUrl: "", appIconUrl: "", rankIconKey: "", rankIconName: "", peakIconKey: "", peakIconName: "" };
const parseId = (raw: any): WidgetIdentity => ({ appId: String(raw?.appId ?? ""), configId: String(raw?.configId ?? ""), heroAssetKey: String(raw?.heroAssetKey ?? ""), heroImageUrl: String(raw?.heroImageUrl ?? ""), appIconUrl: String(raw?.appIconUrl ?? ""), rankIconKey: String(raw?.rankIconKey ?? ""), rankIconName: String(raw?.rankIconName ?? ""), peakIconKey: String(raw?.peakIconKey ?? ""), peakIconName: String(raw?.peakIconName ?? ""), widgetStyle: typeof raw?.widgetStyle === "string" ? raw.widgetStyle : undefined, topLayout: raw?.topLayout === "hero" || raw?.topLayout === "contained" ? raw.topLayout : undefined, bottomLayout: raw?.bottomLayout === "stats" || raw?.bottomLayout === "progress" ? raw.bottomLayout : undefined });

// Multiple widgets = one Discord app per game template ("slot"). The slot key
// IS the gameTemplate value ("fortnite" / "valorant" / "none"), so the template
// picker doubles as "which widget am I editing", each deploys its own app, and
// all stay pinned on the board at once.
type Slots = Record<string, WidgetIdentity>;
const slots = makePersistentValue<Slots>("dm-widget-slots", {}, raw => {
    if (typeof raw !== "object" || raw === null) return null;
    const out: Slots = {};
    for (const k of Object.keys(raw)) out[k] = parseId((raw as any)[k]);
    return out;
});
// The old store was global to the Discordmaxxer install. That meant switching
// between DiggyAI and DiggyT could make one account's local app ids appear to
// vanish or, worse, make the editor point at the other account's app. Keep the
// old key for backwards compatibility, but archive the recovered identities by
// Discord account once the current user is known.
type AccountSlots = Record<string, Slots>;
const accountSlots = makePersistentValue<AccountSlots>("dm-widget-slots-by-account", {}, raw => {
    if (typeof raw !== "object" || raw === null) return null;
    const out: AccountSlots = {};
    for (const accountId of Object.keys(raw)) {
        const value = (raw as any)[accountId];
        if (typeof value !== "object" || value === null) continue;
        const scoped: Slots = {};
        for (const k of Object.keys(value)) scoped[k] = parseId(value[k]);
        out[accountId] = scoped;
    }
    return out;
});
// Legacy single-widget store — migrated into a slot on first load.
const legacyIdentity = makePersistentValue<WidgetIdentity>("dm-widget-identity", EMPTY_IDENTITY, raw => (raw && typeof raw === "object" ? parseId(raw) : null));

let slotsMigrated = false;
let activeSlotsAccountId = "";
async function ensureSlots(): Promise<void> {
    await slots.ready; await accountSlots.ready; await legacyIdentity.ready;

    const accountId = String(UserStore.getCurrentUser()?.id ?? "");
    if (accountId && activeSlotsAccountId !== accountId) {
        const previousAccountId = activeSlotsAccountId;
        const previousSlots = slots.get();
        const archived = accountSlots.get()[accountId];

        // The first account seen owns any pre-v0.7.73 unscoped data. On a real
        // account switch, save the previous account before loading the new one.
        if (previousAccountId && previousAccountId !== accountId) {
            accountSlots.set({ ...accountSlots.get(), [previousAccountId]: previousSlots });
        } else if (!previousAccountId && !archived && Object.keys(previousSlots).length > 0) {
            accountSlots.set({ ...accountSlots.get(), [accountId]: previousSlots });
        }

        activeSlotsAccountId = accountId;
        if (archived) {
            slots.set(archived);
        } else if (previousAccountId && previousAccountId !== accountId) {
            // Do not leak the previous account's app ids into a new account.
            slots.set({});
        }
    }

    if (slotsMigrated) return;
    slotsMigrated = true;
    if (Object.keys(slots.get()).length === 0) {
        const legacy = legacyIdentity.get();
        if (SNOWFLAKE.test(legacy.appId)) {
            const key = String((settings.store as any).gameTemplate ?? "none") || "none";
            slots.set({ [key]: legacy });
            if (activeSlotsAccountId) accountSlots.set({ ...accountSlots.get(), [activeSlotsAccountId]: { [key]: legacy } });
        }
    }
}
const getSlot = (key: string): WidgetIdentity => ({ ...EMPTY_IDENTITY, ...(slots.get()[key] ?? {}) });
const setSlot = (key: string, v: WidgetIdentity): void => {
    const next = { ...slots.get(), [key]: v };
    slots.set(next);
    if (activeSlotsAccountId) accountSlots.set({ ...accountSlots.get(), [activeSlotsAccountId]: next });
};
const slotKeyOf = (): string => String((settings.store as any).gameTemplate ?? "none") || "none";
// Game slots that currently have a deployed app (for auto-refresh).
const deployedGameSlots = (): string[] => Object.entries(slots.get()).filter(([k, v]) => (k === "fortnite" || k === "valorant") && SNOWFLAKE.test(v.appId)).map(([k]) => k);

const MAX_WIDGET_IMAGE_BYTES = 8 * 1024 * 1024;
const LOCAL_WIDGET_IMAGE_PREFIX = "dm-widget-local-hero:";
const widgetImageMime = (blob: Blob): string => {
    const mime = String(blob.type ?? "").toLowerCase();
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) return mime;
    const name = String((blob as File).name ?? "").toLowerCase();
    return name.endsWith(".png") ? "image/png"
        : name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg"
            : name.endsWith(".webp") ? "image/webp"
                : name.endsWith(".gif") ? "image/gif" : "";
};
const localWidgetImageKey = (slotKey: string): string => `${LOCAL_WIDGET_IMAGE_PREFIX}${slotKey}`;

async function getLocalWidgetImage(slotKey: string): Promise<File | null> {
    try {
        const value = await DataStore.get(localWidgetImageKey(slotKey));
        if (!(value instanceof Blob) || value.size > MAX_WIDGET_IMAGE_BYTES || !widgetImageMime(value)) return null;
        const name = String((value as File).name ?? `widget-${slotKey}`);
        return new File([value], name, { type: widgetImageMime(value) });
    } catch (e) {
        console.warn(`[DMWidget] could not read local image for ${slotKey}:`, e);
        return null;
    }
}

async function saveLocalWidgetImage(slotKey: string, file: File): Promise<void> {
    const mime = widgetImageMime(file);
    if (!mime) throw new Error("Choose a PNG, JPG, WebP, or GIF image.");
    if (file.size > MAX_WIDGET_IMAGE_BYTES) throw new Error("That image is over 8 MB. Choose a smaller file.");
    await DataStore.set(localWidgetImageKey(slotKey), new File([file], file.name, { type: mime }));
}

async function removeLocalWidgetImage(slotKey: string): Promise<void> {
    await DataStore.del(localWidgetImageKey(slotKey));
}

let lastResult = "";

// ---- game templates (auto-stat cards) --------------------------------------
// Latest fetched Fortnite overall stats (null until first refresh). Kept in a
// module var — NOT in the user's manual stat fields — so a live refresh never
// clobbers hand-entered stats and buildSurfaces can read whichever is active.
let fnStats: Record<string, number> | null = null;
let valStats: Record<string, any> | null = null;
let fnRefreshTimer: ReturnType<typeof setInterval> | null = null;

function presetHeroUrl(tpl: string): string {
    const s = settings.store as any;
    if (tpl === "valorant") return VALORANT_HERO_PRESETS[String(s.valHeroPreset ?? "auto")] ?? "";
    if (tpl === "fortnite") return FORTNITE_HERO_PRESETS[String(s.fnHeroPreset ?? "auto")] ?? "";
    return "";
}

function heroUrlFor(tpl: string, id: WidgetIdentity): string {
    const custom = String((settings.store as any).heroImageUrl ?? "").trim();
    const preset = presetHeroUrl(tpl);
    if (preset) return preset;
    // For a game slot, Automatic means the slot's own remembered image (or its
    // game default). Do not accidentally carry the previous slot's draft image
    // across when someone switches from Fortnite to Valorant. Custom image URL
    // is the explicit opt-in for the shared URL field.
    const choice = tpl === "valorant"
        ? String((settings.store as any).valHeroPreset ?? "auto")
        : tpl === "fortnite" ? String((settings.store as any).fnHeroPreset ?? "auto") : "custom";
    return (tpl === "none" || choice === "custom")
        ? custom || id.heroImageUrl || DEFAULT_HEROES[tpl] || ""
        : id.heroImageUrl || DEFAULT_HEROES[tpl] || "";
}

const fmtNum = (n: number | undefined): string => {
    if (n === undefined || n === null || Number.isNaN(n)) return "—";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 1 : 2).replace(/\.0$/, "") + "K";
    return String(n);
};

// Map the 6 stat slots for the Fortnite template: two manual prestige stats
// (Unreal rank + earnings — no free API) then four live ones from fnStats.
function fortniteStatLines(): string[] {
    const s = settings.store as any;
    const o = fnStats ?? {};
    const rank = String(s.fnUnrealRank ?? "").trim() || "Unranked";
    const earn = String(s.fnEarnings ?? "").trim() || "$0";
    const placement = String(s.fnTopPlacement ?? "").trim();
    const hrs = o.minutesPlayed !== undefined ? Math.round(Number(o.minutesPlayed) / 60) : undefined;
    // Prioritized; take the first 6 that exist. 👑 = Unreal badge, 💵 = green $
    // (Discord styles all stat text one color, so an emoji is the only "color").
    const all = [
        `Highest Rank | ${rank}`, // rank badge is drawn as the stat icon (fields.icon)
        `Earnings | 💵 ${earn}`,
        placement ? `Best (Ch) | ${placement}` : null,
        `Wins | ${fmtNum(o.wins)}`,
        `K/D | ${o.kd !== undefined ? Number(o.kd).toFixed(2) : "—"}`,
        hrs !== undefined ? `Playtime | ${fmtNum(hrs)}h` : null,
        `Kills | ${fmtNum(o.kills)}` // fills a slot only if placement/playtime absent
    ].filter((x): x is string => !!x);
    return all.slice(0, 6);
}

// Discord rejects an application name containing ":" (and trims to ~60 chars);
// the widget header IS the app name, so sanitize before any /applications PATCH.
const sanitizeAppName = (v: string): string => v.replace(/:/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Widget";

// The small header line above the title: "Fn · Ch6 S3" / "Val" / the app name.
function slotHeader(tpl: string): string {
    const s = settings.store as any;
    if (tpl === "fortnite") { const cs = String(s.fnChapterSeason ?? "").trim(); return cs ? `Fort · ${cs}` : "Fort"; }
    if (tpl === "valorant") {
        // Season line shown above the username title, e.g. "V26 A4 - Ascendant 3".
        // Rank is appended live from HenrikDev; act/episode is a typed-in field.
        // NB: the header IS the app name, which Discord forbids ":" in
        // (APPLICATION_NAME_INVALID_CONTAINS, probed live) — so strip colons and
        // join with " - " instead.
        return "Val";
    }
    return String(s.appName ?? "").trim() || "My Widget";
}

// Valorant template map (all live from HenrikDev — rank/RR/peak/agent/WR/KD).
function valorantStatLines(): string[] {
    const o = valStats ?? {};
    return [
        `Rank | ${o.rank ?? "—"}`,
        `RR | ${o.rr !== undefined ? o.rr + " RR" : "—"}`,
        `Peak Rank | ${o.peak ?? "—"}`,
        `Main Agent | ${o.mainAgent ?? "—"}`,
        `Recent WR | ${o.recentWR !== undefined ? o.recentWR + "%" : "—"}`,
        `K/D | ${o.avgKD !== undefined ? o.avgKD : "—"}`
    ];
}

// ---- helpers ---------------------------------------------------------------
function toast(msg: string, type: any = Toasts.Type.SUCCESS, durationMs = 5000) {
    if (type === Toasts.Type.SUCCESS) lastResult = "✅ " + msg;
    else if (type === Toasts.Type.FAILURE) lastResult = "⚠ " + msg;
    Toasts.show({ message: msg, type, id: Toasts.genId(), options: { duration: durationMs, position: Toasts.Position.TOP } });
}

async function copyText(t: string): Promise<boolean> {
    try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}

function classifyDiscordError(err: any): string {
    const body = err?.body ?? err?.response?.body ?? {};
    const message = String(body?.message ?? err?.message ?? "unknown error");
    if (/requires a claimed game on the application team/i.test(message)) {
        return "Discord requires this application team to claim an eligible game before it can deploy this game widget. The local style preview still works; retrying Create/Update will keep failing until Discord clears that requirement.";
    }
    return message;
}

const SNOWFLAKE = /^\d{17,20}$/;
const RESERVED_NAME =
    /\b(discord|discordapp|steam|valve|nitro|official|staff|admin|administrator|moderator|epic\s*games|riot|xbox|playstation|nintendo|spotify|twitch)\b/i;
function impersonationError(name: string): string | null {
    if (!name) return "Give your widget app a name first.";
    if (name.length > 60) return "App name is too long (Discord caps it at ~60 chars).";
    if (RESERVED_NAME.test(name)) return "That name impersonates a real brand/service. Discord disables accounts for this — pick a name you own.";
    return null;
}

const apiGet = async (url: string): Promise<any> => (await RestAPI.get({ url })).body;
const apiPost = async (url: string, body: any): Promise<any> => (await RestAPI.post({ url, body })).body;
const apiPatch = async (url: string, body: any): Promise<any> => (await RestAPI.patch({ url, body })).body;
const apiPut = async (url: string, body: any): Promise<any> => (await RestAPI.put({ url, body })).body;

function socialSdkBody(appName: string) {
    return {
        name: appName || "widget", business_email: "widget@maxxtopia.com", game_or_studio_name: appName || "widget",
        game_or_studio_url: "", email_updates_consent: false, country_or_region: "United States", title_role: "Founder",
        target_platforms: [], form_type: "Dev Solutions", sfdc_leadsource: "Dev Portal", utm_campaign: "SDK Enable Form"
    };
}

// A widget config is create-once per app; its id comes back as `config_id`.
async function resolveConfigId(appId: string, appName: string): Promise<string> {
    try {
        const list = await apiGet(`/applications/${appId}/widget-configs`);
        const arr: any[] = Array.isArray(list) ? list : list?.configs ?? [];
        if (arr[0]?.config_id) return String(arr[0].config_id);
    } catch { /* create below */ }
    const cfg = await apiPost(`/applications/${appId}/widget-configs`, { display_name: appName });
    return String(cfg.config_id ?? cfg.id);
}

// Download the hero URL and (re)upload it as an "application_asset" the widget
// can reference. Returns the asset key, or null if there's no/invalid image.
async function uploadHeroAsset(appId: string, url: string, localFile?: Blob | null): Promise<string | null> {
    if (!url && !localFile) return null;
    let blob: Blob | null = localFile ?? null;
    if (!blob && url) {
        try {
            const r = await fetch(url, { credentials: "omit" });
            if (!r.ok) throw new Error("HTTP " + r.status);
            blob = await r.blob();
        } catch {
            // Renderer fetch blocked (CORS / CSP) — pull it through the main process,
            // which isn't CORS-bound, so any image host works.
            const nat = await Native.fetchImageData(url);
            if (!("error" in nat)) {
                try {
                    const bytes = Uint8Array.from(atob(nat.dataBase64), c => c.charCodeAt(0));
                    blob = new Blob([bytes], { type: nat.contentType || "image/png" });
                } catch { /* fall through */ }
            }
        }
    }
    if (!blob) {
        toast("Couldn't read the hero image. Check the link or choose the file again.", Toasts.Type.MESSAGE, 5000);
        return null;
    }
    const ct = widgetImageMime(blob);
    if (!ct) throw new Error("The hero must be PNG, JPG, WebP, or GIF.");
    if (blob.size > MAX_WIDGET_IMAGE_BYTES) throw new Error("The hero image is over 8 MB. Choose a smaller file.");
    if (blob.type !== ct) blob = new Blob([blob], { type: ct });
    const ext = ct.includes("gif") ? "gif" : ct.includes("webp") ? "webp" : ct.includes("jpeg") ? "jpg" : "png";
    // Clean up any prior hero assets (best effort) so re-deploys don't pile up.
    try {
        const list = await apiGet(`/applications/${appId}/assets`);
        const arr: any[] = Array.isArray(list) ? list : list?.assets ?? [];
        for (const a of arr) {
            const k = String(a.key ?? a.name ?? "");
            const aid = a.id ?? a.asset_id;
            if (k.startsWith("hero") && aid) { try { await RestAPI.del({ url: `/applications/${appId}/assets/${aid}` }); } catch { /* ignore */ } }
        }
    } catch { /* ignore */ }
    // Unique key so a leftover asset can never 409 the registration.
    const key = "hero" + Date.now();
    const slot = await apiPost(`/applications/${appId}/assets/upload`, { filename: `${key}.${ext}`, file_size: blob.size });
    const put = await fetch(slot.upload_url, { method: "PUT", body: blob });
    if (!put.ok) throw new Error("image storage upload failed: HTTP " + put.status);
    const asset = await apiPost(`/applications/${appId}/assets`, { key, upload_filename: slot.upload_filename, visibility: "public" });
    return String(asset?.key ?? key);
}

const tf = (v: string) => ({ presentation_type: "text", value_type: "custom_string", value: String(v ?? "") });
const nf = (v: number | string) => ({ presentation_type: "number", value_type: "custom_string", value: String(v) });
// An image field pointing at an uploaded application asset (rank badge, etc).
const assetImg = (key: string) => ({ presentation_type: "image", value_type: "application_asset", value: key });

// Valorant competitive tier -> Riot's PERMANENT tier ID (0, 3..27; 1/2 unused).
// Names match HenrikDev's tier.name (compared case-insensitively). Icons come
// from valorant-api.com's CORS-open media host; uploadIconAsset's native
// fallback handles Discord's renderer CSP (same host as the Neon default hero).
const VAL_TIER_ID: Record<string, number> = {
    "IRON 1": 3, "IRON 2": 4, "IRON 3": 5,
    "BRONZE 1": 6, "BRONZE 2": 7, "BRONZE 3": 8,
    "SILVER 1": 9, "SILVER 2": 10, "SILVER 3": 11,
    "GOLD 1": 12, "GOLD 2": 13, "GOLD 3": 14,
    "PLATINUM 1": 15, "PLATINUM 2": 16, "PLATINUM 3": 17,
    "DIAMOND 1": 18, "DIAMOND 2": 19, "DIAMOND 3": 20,
    "ASCENDANT 1": 21, "ASCENDANT 2": 22, "ASCENDANT 3": 23,
    "IMMORTAL 1": 24, "IMMORTAL 2": 25, "IMMORTAL 3": 26,
    "RADIANT": 27
};
// Current competitive-tier icon set. If badges ever 404 after a Riot episode
// rollover, refresh this: GET valorant-api.com/v1/competitivetiers -> last uuid.
const VAL_TIER_SET = "03621f52-342b-cf4e-4f86-9350a49c6d04";
function valRankIconUrl(rankName: string): string | null {
    const id = VAL_TIER_ID[String(rankName ?? "").trim().toUpperCase().replace(/\s+/g, " ")];
    return id === undefined ? null : `https://media.valorant-api.com/competitivetiers/${VAL_TIER_SET}/${id}/largeicon.png`;
}

// Upload an icon image (rank badge) as a reusable "application_asset" under a
// stable key prefix, deleting prior versions of that same slot first. Mirrors
// uploadHeroAsset (renderer fetch -> native fallback for CSP-blocked hosts).
async function uploadIconAsset(appId: string, url: string, keyBase: string): Promise<string | null> {
    if (!url) return null;
    let blob: Blob | null = null;
    try {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        blob = await r.blob();
    } catch {
        const nat = await Native.fetchImageData(url);
        if (!("error" in nat)) {
            try {
                const bytes = Uint8Array.from(atob(nat.dataBase64), c => c.charCodeAt(0));
                blob = new Blob([bytes], { type: nat.contentType || "image/png" });
            } catch { /* fall through */ }
        }
    }
    if (!blob) return null;
    const ext = (blob.type || "").includes("jpeg") ? "jpg" : (blob.type || "").includes("webp") ? "webp" : "png";
    try {
        const list = await apiGet(`/applications/${appId}/assets`);
        const arr: any[] = Array.isArray(list) ? list : list?.assets ?? [];
        for (const a of arr) {
            const k = String(a.key ?? a.name ?? ""); const aid = a.id ?? a.asset_id;
            if (k.startsWith(keyBase) && aid) { try { await RestAPI.del({ url: `/applications/${appId}/assets/${aid}` }); } catch { /* ignore */ } }
        }
    } catch { /* ignore */ }
    const key = keyBase + Date.now();
    const slot = await apiPost(`/applications/${appId}/assets/upload`, { filename: `${key}.${ext}`, file_size: blob.size });
    const put = await fetch(slot.upload_url, { method: "PUT", body: blob });
    if (!put.ok) return null;
    const asset = await apiPost(`/applications/${appId}/assets`, { key, upload_filename: slot.upload_filename, visibility: "public" });
    return String(asset?.key ?? key);
}

// Map the typed Fortnite rank text to a baked badge (keyword match). "Legend(s)"
// wins over plain "unreal" so Unreal Legends shows its own crown.
function fnRankIconDataUri(rankText: string): string | null {
    const t = String(rankText ?? "").toLowerCase();
    if (t.includes("legend")) return FN_RANK_ICONS["unreal legends"] ?? null;
    for (const k of ["unreal", "champion", "elite", "diamond", "platinum", "gold", "silver", "bronze"])
        if (t.includes(k)) return FN_RANK_ICONS[k] ?? null;
    return null;
}

// Upload the badge for the current Fortnite rank onto the FN slot (one stat icon;
// FN has no peak). Only re-uploads when the typed rank changes.
async function syncFortniteRankIcon(slotKey: string): Promise<void> {
    const id = getSlot(slotKey);
    if (!SNOWFLAKE.test(id.appId)) return;
    const rankText = String((settings.store as any).fnUnrealRank ?? "").trim();
    if (!rankText || rankText === id.rankIconName) return;
    const uri = fnRankIconDataUri(rankText);
    if (!uri) return;
    const k = await uploadIconAsset(id.appId, uri, "rankicon");
    if (k) setSlot(slotKey, { ...id, rankIconKey: k, rankIconName: rankText });
}

// Make sure the Valorant slot has uploaded rank badges for the current + peak
// rank (only re-uploads when the rank name actually changes, to avoid asset
// churn / rate limits). Call after valStats is refreshed, before republishing.
async function syncValorantRankIcons(slotKey: string): Promise<void> {
    const id = getSlot(slotKey);
    if (!SNOWFLAKE.test(id.appId)) return;
    const o = valStats ?? {};
    const next = { ...id }; let changed = false;
    const rn = String(o.rank ?? "").trim();
    if (rn && rn !== id.rankIconName) {
        const url = valRankIconUrl(rn);
        if (url) { const k = await uploadIconAsset(id.appId, url, "rankicon"); if (k) { next.rankIconKey = k; next.rankIconName = rn; changed = true; } }
    }
    const pn = String(o.peak ?? "").trim();
    if (pn && pn !== id.peakIconName) {
        const url = valRankIconUrl(pn);
        if (url) { const k = await uploadIconAsset(id.appId, url, "peakicon"); if (k) { next.peakIconKey = k; next.peakIconName = pn; changed = true; } }
    }
    if (changed) setSlot(slotKey, next);
}

// Read an image URL into a base64 data URI (for the application icon PATCH,
// which — unlike the widget hero — takes an inline data URI, not an asset key).
async function urlToDataUri(url: string): Promise<string | null> {
    if (!url) return null;
    try {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const blob = await r.blob();
        return await new Promise<string | null>(resolve => {
            const fr = new FileReader();
            fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
            fr.onerror = () => resolve(null);
            fr.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

// The app icon is the small top-left logo on the widget card (like the game
// icon on a Marvel Rivals widget). Standard documented endpoint — best-effort:
// a bad/oversized image just leaves the default icon, never fails the deploy.
async function setAppIcon(appId: string, src: string): Promise<void> {
    if (!src) return;
    // A baked default logo is already a data URI; a user-provided URL needs fetching.
    const dataUri = src.startsWith("data:") ? src : await urlToDataUri(src);
    if (!dataUri) return;
    try {
        await apiPatch(`/applications/${appId}`, { icon: dataUri });
    } catch (e) {
        console.warn("[DMWidget] app icon (non-fatal):", e);
    }
}

function buildSurfaces(tpl: string, imageKey: string | null, opts?: { titleIconKey?: string }) {
    const s = settings.store as any;
    const savedSlot = getSlot(tpl);
    // A refresh can run while the editor is pointed at another slot. Read the
    // appearance/layout from the slot being published, not from whichever
    // settings tab happens to be visible. This is what makes a skin choice
    // durable across Fortnite / Valorant / Custom and across restarts.
    const selectedTopLayout = savedSlot.topLayout ?? s.topLayout;
    const selectedBottomLayout = savedSlot.bottomLayout ?? s.bottomLayout;
    const img = imageKey
        ? { presentation_type: "image", value_type: "application_asset", value: imageKey }
        : { presentation_type: "image", value_type: "custom_string", value: "" };
    // widget_top's `title` is a SINGLE-line text field — verified live (2026-07):
    // Discord collapses newlines to spaces and truncates a long title with "…",
    // so a fake multi-line header via "\n" just produces a mangled run-on. The
    // card already has natural tiers (app-name header + this title + the stat
    // grid), so the title stays one short line and extra lines go in the stats.
    // `tpl` (the slot's game template) decides title + stat source, so a slot
    // can be rebuilt independently of whichever template the picker shows.
    const fnMode = tpl === "fortnite" || tpl === "valorant"; // "game mode" (forces stat grid)
    const title = tpl === "fortnite"
        ? (String(s.fnIgn ?? "").trim() || "Fortnite")
        : tpl === "valorant"
            ? (String(s.valRiotId ?? "").trim().split("#")[0] || "Valorant")
            : (String(s.widgetTitle ?? "").trim() || "My Widget");

    const rawStats = tpl === "fortnite" ? fortniteStatLines()
        : tpl === "valorant" ? valorantStatLines()
            : [1, 2, 3, 4, 5, 6].map(i => String(s[`stat${i}`] ?? ""));
    const stats: Record<string, any> = {};
    let firstStat = "";
    for (let i = 1; i <= 6; i++) {
        const raw = String(rawStats[i - 1] ?? "").trim();
        let label = "", value = "";
        if (raw) { const p = raw.indexOf("|"); if (p >= 0) { label = raw.slice(0, p).trim(); value = raw.slice(p + 1).trim(); } else value = raw; if (!firstStat) firstStat = label ? `${label}: ${value}` : value; }
        stats[`stat_${i}`] = { fields: { value: tf(value), label: tf(label) } };
    }
    // Rank badges next to the rank cells (Marvel-Rivals style). Valorant's stat
    // order is fixed (Rank=1, Peak Rank=3); the badge asset keys live on the slot.
    if (tpl === "valorant") {
        const slot = getSlot(tpl);
        if (slot.rankIconKey && stats.stat_1) stats.stat_1.fields.icon = assetImg(slot.rankIconKey);
        if (slot.peakIconKey && stats.stat_3) stats.stat_3.fields.icon = assetImg(slot.peakIconKey);
    }
    if (tpl === "fortnite") {
        // Highest Rank (stat_1) wears the Fortnite rank badge.
        const slot = getSlot(tpl);
        if (slot.rankIconKey && stats.stat_1) stats.stat_1.fields.icon = assetImg(slot.rankIconKey);
    }

    // widget_bottom is a SINGLE slot: either the stat grid OR a progress bar
    // (verified live 2026-07). Progress needs an objective IMAGE (an uploaded
    // asset — we reuse the hero) + name, and progress.current as a 0..1 fraction,
    // so it falls back to stats when there's no hero image to borrow.
    let widget_bottom: any;
    if (selectedBottomLayout === "progress" && imageKey && !fnMode) {
        const pct = Math.max(0, Math.min(100, Number(s.progressPercent ?? 50))) / 100;
        widget_bottom = {
            layout: "widget_bottom_progress",
            components: {
                progress: { fields: { current: nf(pct) } },
                objective: { fields: { image: img, name: tf(String(s.progressLabel ?? "").trim() || "Progress") } }
            }
        };
    } else {
        widget_bottom = { layout: "widget_bottom_stats", components: stats };
    }

    // widget_top: hero (image bleeds off the right edge, banner-style) OR
    // contained (image boxed beside the title) — verified live 2026-07. The
    // preview + popout stay on the hero layout (proven; independent surfaces).
    // Optionally hang a badge (rank icon) on the title itself, next to the app
    // icon — same application_asset mechanism the stat cells use. Experimental:
    // publishSurfaces retries WITHOUT it if Discord rejects a title icon.
    const titleFields: any = { text: tf(title) };
    if (opts?.titleIconKey) titleFields.icon = assetImg(opts.titleIconKey);
    const widget_top = selectedTopLayout === "contained"
        ? { layout: "widget_top_contained", components: { contained_image: { fields: { image: img } }, title: { fields: titleFields } } }
        : { layout: "widget_top_hero", components: { hero_image: { fields: { image: img } }, title: { fields: titleFields } } };

    return {
        surfaces: {
            widget_top,
            widget_bottom,
            add_widget_preview: { layout: "add_widget_preview_hero", components: { hero_image: { fields: { image: img } } } },
            // Drives the profile-popout cutout: hero image + one stat line.
            mini_profile: { layout: "mini_profile_hero_stat", components: { hero_image: { fields: { image: img } }, stat: { fields: { text: tf(firstStat || (selectedBottomLayout === "progress" ? String(s.progressLabel ?? "").trim() : "") || title) } } } }
        }
    };
}

// Patch the widget config then publish it. For game slots we try to put a rank
// badge in the TITLE (next to the app icon); if Discord's schema rejects a title
// icon, we retry text-only so a deploy never bricks over an experimental field.
async function publishSurfaces(appId: string, configId: string, slotKey: string, assetKey: string | null) {
    // Title icons are NOT supported by Discord's widget schema — probed live
    // (title.fields.icon / a sibling icon component / title.badge all return
    // WIDGET_CONFIG_UNKNOWN_FIELD/COMPONENT). The top of the card only takes the
    // app icon + hero image, so we never attempt a title icon. (Kept as a no-op
    // so the fallback plumbing stays harmless if Discord ever adds the field.)
    const titleIconKey = "";
    const base = { display_name: slotHeader(slotKey) };
    try {
        await apiPatch(`/applications/${appId}/widget-configs/${configId}`, { ...buildSurfaces(slotKey, assetKey, { titleIconKey }), ...base });
    } catch (e) {
        if (!titleIconKey) throw e;
        console.warn("[DMWidget] title icon rejected — retrying text-only:", e);
        await apiPatch(`/applications/${appId}/widget-configs/${configId}`, { ...buildSurfaces(slotKey, assetKey), ...base });
    }
    await apiPost(`/applications/${appId}/widget-configs/${configId}/publish`, {});
}

async function attachToProfile(appId: string, userId: string) {
    let widgets: any[] = [];
    try { const prof = await apiGet(`/users/${userId}/profile`); widgets = profileWidgetEntries(prof) ?? []; } catch { widgets = []; }
    if (!widgets.some(w => w?.data?.application_id === appId)) widgets = [{ data: { type: "application", application_id: appId } }, ...widgets];
    await apiPut("/users/@me/widgets", { widgets });
}

async function authorizeApp(appId: string) {
    // Best-effort: grants our own app the presence scope so the identity claim
    // is permitted. Non-fatal — a static widget still deploys without it.
    try {
        await apiPatch(`/applications/${appId}`, { redirect_uris: ["https://discord.com"] });
        await apiPost(`/oauth2/authorize?client_id=${appId}&response_type=token&scope=${encodeURIComponent("openid sdk.social_layer_presence")}`, { authorize: true, permissions: "0" });
    } catch (e) {
        console.warn("[DMWidget] authorize (non-fatal):", e);
    }
}

// Claim the widget onto the profile identity so it renders for OTHER viewers.
// Mints a bot token (prompts the user's 2FA) and PATCHes header-clean via the
// main process. Returns null on success, or a message on failure.
async function finalizeIdentity(appId: string, userId: string): Promise<string | null> {
    let token = "";
    try { token = (await apiPost(`/applications/${appId}/bot/reset`, {})).token; }
    catch (e) { return "couldn't mint bot token — " + classifyDiscordError(e) + " (2FA must be enabled on this account)"; }
    if (!token) return "bot token reset returned nothing";
    // Persist the token (encrypted, main-process only) so live stat refreshes
    // don't re-prompt 2FA. Non-fatal if storage fails.
    try { await Native.storeWidgetToken(token); } catch (e) { console.warn("[DMWidget] token store (non-fatal):", e); }
    const r = await Native.setWidgetProfile(appId, userId, token, JSON.stringify({ data: { dynamic: [] } }));
    return "error" in r ? "identity claim failed — " + r.error : null;
}

// Re-publish the widget config with current settings (used by live refresh —
// reuses the already-uploaded hero asset, no re-upload). Mechanism A: proven,
// no token needed. Returns null on success or an error message.
async function republishConfig(slotKey: string): Promise<string | null> {
    await ensureSlots();
    const id = getSlot(slotKey);
    if (!SNOWFLAKE.test(id.appId) || !SNOWFLAKE.test(id.configId)) return "no widget deployed yet";
    try {
        // Recover the already-uploaded hero asset if we didn't record its key
        // (widget created before heroAssetKey existed) so a refresh keeps the image.
        let assetKey = id.heroAssetKey;
        if (!assetKey) {
            try {
                const list = await apiGet(`/applications/${id.appId}/assets`);
                const arr: any[] = Array.isArray(list) ? list : list?.assets ?? [];
                const found = arr.map(a => String(a.key ?? a.name ?? "")).find(k => k.startsWith("hero"));
                if (found) { assetKey = found; setSlot(slotKey, { ...id, heroAssetKey: found }); }
            } catch { /* fall through with none */ }
        }
        // The rendered header line is the app NAME (not display_name), so keep it
        // current on every refresh — e.g. Valorant's "Act 3 Ep 3: <live rank>".
        try { await apiPatch(`/applications/${id.appId}`, { name: sanitizeAppName(slotHeader(slotKey)) }); } catch (e) { lastResult = "⚠ header rename failed: " + classifyDiscordError(e); console.warn("[DMWidget] header name:", e); }
        await publishSurfaces(id.appId, id.configId, slotKey, assetKey || null);
        return null;
    } catch (e) { return classifyDiscordError(e); }
}

let widgetStylePublishSerial = 0;

async function republishSelectedWidgetStyle(slotKey: string): Promise<void> {
    const request = ++widgetStylePublishSerial;
    await ensureSlots();
    // The local slot can be empty after a reinstall, an account switch, or a
    // DataStore migration even though the widget is still attached to this
    // account's profile. Recover it before deciding that the skin is preview-only.
    await refreshAttachedWidgetStyles(true);
    const id = getSlot(slotKey);
    scheduleWidgetSkinScan();
    if (!SNOWFLAKE.test(id.appId)) {
        toast(`${SLOT_LABEL[slotKey] ?? slotKey} skin saved and applied in Discordmaxxer. Create/Update will publish its supported layout and image.`, Toasts.Type.MESSAGE, 6500);
        return;
    }
    // A skin is a Discordmaxxer renderer feature, not a Discord widget-v2
    // field. Do not rebuild the remote card from an empty post-reinstall form
    // just because the user picked a new skin; that would replace a perfectly
    // good published card with blank stats. The existing app identity has been
    // recovered above, so the renderer can apply the skin immediately. The
    // deliberate Update action remains the place where supported card fields
    // are sent to Discord after the user reviews the recovered form.
    if (request !== widgetStylePublishSerial) return;
    scheduleWidgetSkinScan();
    toast(`${SLOT_LABEL[slotKey] ?? slotKey} skin applied to your existing widget in Discordmaxxer. Your published card was left unchanged; review the fields before choosing Update existing widget.`, Toasts.Type.SUCCESS, 8000);
}

// Fetch a specific game slot's live stats (native, no CORS) and re-publish it.
// The boolean lets the hub distinguish "published" from "the provider or
// publish step failed" instead of always showing a green success toast.
async function refreshGameSlot(tpl: string, announce = false): Promise<boolean> {
    if (tpl !== "fortnite" && tpl !== "valorant") return false;
    const s = settings.store as any;
    await ensureSlots();
    if (!SNOWFLAKE.test(getSlot(tpl).appId)) {
        if (announce) toast("Create this widget first, then refresh stats.", Toasts.Type.FAILURE);
        return false;
    }

    try {
        if (tpl === "fortnite") {
            const ign = String(s.fnIgn ?? "").trim(); const key = String(s.fnApiKey ?? "").trim();
            if (!ign || !key) {
                if (announce) toast("Set your Epic IGN + fortnite-api.com key first.", Toasts.Type.FAILURE);
                return false;
            }
            const res = await Native.fetchFortniteStats(ign, key, String(s.fnAccountType ?? "epic"));
            if ("error" in res) {
                const msg = `Fortnite stats: ${res.error}`;
                if (announce) toast(msg, Toasts.Type.FAILURE, 8000); else console.warn("[DMWidget]", msg);
                return false;
            }
            fnStats = res.overall;
            // Upload the current rank badge before republishing so buildSurfaces can
            // hang it on the Highest Rank stat cell.
            await syncFortniteRankIcon(tpl);
        } else {
            const riot = String(s.valRiotId ?? "").trim(); const key = String(s.valApiKey ?? "").trim();
            const hash = riot.indexOf("#");
            if (hash < 1 || !key) {
                if (announce) toast("Set your Riot ID (Name#Tag) + HenrikDev key first.", Toasts.Type.FAILURE);
                return false;
            }
            const res = await Native.fetchValorantStats(riot.slice(0, hash), riot.slice(hash + 1), String(s.valRegion ?? "na"), "pc", key);
            if ("error" in res) {
                if (announce) toast(res.error, Toasts.Type.FAILURE, 8000); else console.warn("[DMWidget]", res.error);
                return false;
            }
            valStats = res.overall;
            // Upload/refresh the current + peak rank badges before we republish so
            // buildSurfaces can hang them on the Rank / Peak Rank stat cells.
            await syncValorantRankIcons(tpl);
        }

        const err = await republishConfig(tpl);
        if (err) {
            const msg = `Stats fetched but publish failed: ${err}`;
            if (announce) toast(msg, Toasts.Type.FAILURE, 8000); else console.warn("[DMWidget]", msg);
            return false;
        }
        if (announce) {
            if (tpl === "fortnite") {
                toast(`Fortnite stats updated — ${fmtNum(fnStats?.wins)} wins, ${fnStats?.kd?.toFixed?.(2) ?? "—"} K/D.`, Toasts.Type.SUCCESS, 6000);
            } else {
                const rr = valStats?.rr !== undefined ? `${valStats.rr} RR` : "RR unavailable";
                toast(`Valorant stats updated — ${valStats?.rank ?? "—"}, ${rr}, main ${valStats?.mainAgent ?? "—"}. The profile card may take a moment to redraw.`, Toasts.Type.SUCCESS, 8000);
            }
        }
        return true;
    } catch (e) {
        const msg = `Stats refresh failed: ${classifyDiscordError(e)}`;
        if (announce) toast(msg, Toasts.Type.FAILURE, 8000); else console.warn("[DMWidget]", e);
        return false;
    }
}

// Manual "Refresh now" button — refreshes the slot the picker is on.
const refreshGame = (announce = false) => refreshGameSlot(slotKeyOf(), announce);

// Timer — refresh EVERY deployed game slot (so FN + Valorant both stay live).
async function refreshAllGames(): Promise<{ updated: number; failed: number; }> {
    await ensureSlots();
    let updated = 0;
    let failed = 0;
    for (const key of deployedGameSlots()) {
        if (await refreshGameSlot(key, false)) updated++;
        else failed++;
    }
    return { updated, failed };
}

// ---- the whole flow --------------------------------------------------------
async function deployWidget(): Promise<void> {
    const me = UserStore.getCurrentUser();
    if (!me?.id) { toast("Not logged in yet — try again in a moment.", Toasts.Type.FAILURE); return; }
    const appName = String((settings.store as any).appName ?? "").trim();
    const nameErr = impersonationError(appName);
    if (nameErr) { toast(nameErr, Toasts.Type.FAILURE, 8000); return; }

    await ensureSlots();
    // Rehydrate an app/config that is still on this account's profile before
    // falling back to the create flow. This keeps a reinstall or account
    // switch from silently creating a duplicate widget.
    await refreshAttachedWidgetStyles(true);
    const slotKey = slotKeyOf();
    let id: WidgetIdentity = getSlot(slotKey);

    // If this slot points at an app the CURRENT account doesn't own — e.g. you
    // switched Discord accounts to deploy the same widget on your real profile —
    // forget it so we create a fresh app under THIS account instead of failing
    // to edit someone else's app. This makes moving a widget between accounts
    // "just log in and Create", no manual reset.
    if (SNOWFLAKE.test(id.appId)) {
        try {
            const app = await apiGet(`/applications/${id.appId}`);
            const ownerId = String(app?.owner?.id ?? app?.team?.owner_user_id ?? "");
            if (ownerId && ownerId !== me.id) { id = { ...EMPTY_IDENTITY }; setSlot(slotKey, id); }
        } catch (e: any) {
            // A profile-attached app is still a valid update target even when
            // Discord temporarily hides its metadata. Only discard a stale
            // local id when the current profile did not just prove that this
            // app belongs to the active account.
            if ((e?.status === 403 || e?.status === 404) && !attachedWidgetSlots.has(id.appId)) {
                id = { ...EMPTY_IDENTITY }; setSlot(slotKey, id);
            }
        }
    }

    // Reinstall/account recovery can recover the published app without
    // recovering private game credentials. Never let an apparently normal
    // Update click turn that missing draft into a blank Valorant/Fortnite
    // publish; the gallery skin is already safe to apply locally.
    if (SNOWFLAKE.test(id.appId)) {
        const draft = settings.store as any;
        const missingValorantDraft = slotKey === "valorant"
            && (!String(draft.valRiotId ?? "").includes("#") || !String(draft.valApiKey ?? "").trim());
        const missingFortniteDraft = slotKey === "fortnite"
            && (!String(draft.fnIgn ?? "").trim() || !String(draft.fnApiKey ?? "").trim());
        if (missingValorantDraft || missingFortniteDraft) {
            const game = slotKey === "valorant" ? "Riot ID (Name#Tag) + HenrikDev key" : "Epic IGN + Fortnite API key";
            toast(`Existing ${SLOT_LABEL[slotKey] ?? slotKey} widget recovered. Re-enter your ${game} before Update existing widget; changing the skin is already applied locally and will not erase the published card.`, Toasts.Type.MESSAGE, 10000);
            return;
        }
    }

    try {
        if (!SNOWFLAKE.test(id.appId)) {
            toast("Creating your widget app…", Toasts.Type.MESSAGE, 2500);
            const app = await apiPost("/applications", { name: appName, team_id: null });
            id.appId = String(app.id); setSlot(slotKey, id);
            await apiPost(`/applications/${id.appId}/social-sdk/enable`, socialSdkBody(appName));
        }
        if (!SNOWFLAKE.test(id.configId)) { id.configId = await resolveConfigId(id.appId, appName); setSlot(slotKey, id); }

        toast(slotKey === "fortnite" || slotKey === "valorant" ? "Uploading image + fetching live stats…" : "Uploading image + publishing layout…", Toasts.Type.MESSAGE, 3000);
        // The app NAME is what renders as the small header above the title
        // (not the config display_name), so set it to "Fn · Ch6 S3" / "Val".
        try { await apiPatch(`/applications/${id.appId}`, { name: sanitizeAppName(slotHeader(slotKey)) }); } catch (e) { lastResult = "⚠ header rename failed: " + classifyDiscordError(e); console.warn("[DMWidget] app name:", e); }
        // Per-slot media: remember the URLs on THIS slot so switching slots keeps
        // each widget's own hero/icon (FN and Valorant no longer share one image).
        const iconUrl = String((settings.store as any).appIconUrl ?? "").trim() || id.appIconUrl || "";
        // An explicit curated preset wins; otherwise keep the typed field, the
        // slot's remembered/imported hero, or the game's default. This preserves
        // existing custom cards while making a new game card one-click friendly.
        const localHeroFile = await getLocalWidgetImage(slotKey);
        const heroUrl = heroUrlFor(slotKey, id);
        // Prefer the style saved on THIS game slot. The mirrored setting is
        // kept for backwards compatibility, but using it first could publish
        // the last-edited widget's skin onto a different slot when a user
        // switched templates and hit Create/Update quickly.
        const chosenPreset = WIDGET_STYLE_PRESETS.find(preset => preset.id === String(id.widgetStyle ?? ""))
            ?? WIDGET_STYLE_PRESETS.find(preset => preset.id === String((settings.store as any).widgetStyle ?? ""));
        id.heroImageUrl = heroUrl;
        id.appIconUrl = iconUrl;
        // Persist the complete gallery choice on the slot at publish time too.
        // This matters when Create/Update is the first action after selecting a
        // skin: the deployed app must keep the same style/layout on the next
        // render, even if the settings panel is reopened on another slot.
        if (chosenPreset) {
            id.widgetStyle = chosenPreset.id;
            id.topLayout = chosenPreset.topLayout;
            id.bottomLayout = chosenPreset.bottomLayout;
        } else {
            id.topLayout = (settings.store as any).topLayout === "contained" ? "contained" : "hero";
            id.bottomLayout = (settings.store as any).bottomLayout === "progress" ? "progress" : "stats";
        }
        setSlot(slotKey, id);
        // Top-left logo: your custom icon if set, otherwise the game's baked logo
        // (Fortnite F / Valorant V) so a game card auto-brands with no image hosting.
        await setAppIcon(id.appId, iconUrl || DEFAULT_APP_ICONS[slotKey] || "");
        let imageKey = await uploadHeroAsset(id.appId, heroUrl, localHeroFile);
        // No new/valid image URL but this slot already has an uploaded asset —
        // reuse it so "Update" never blanks an existing widget's hero.
        if (!imageKey && SNOWFLAKE.test(id.appId) && id.heroAssetKey) imageKey = id.heroAssetKey;
        if (imageKey) { id.heroAssetKey = imageKey; setSlot(slotKey, id); }
        if ((settings.store as any).bottomLayout === "progress" && !imageKey && slotKey === "none")
            toast("Progress-bar mode needs a hero image (it doubles as the goal icon) — showing the stat grid instead. Add a Hero image URL to use the bar.", Toasts.Type.MESSAGE, 8000);
        // Game cards should fetch before their first publish. The old order made
        // a new card briefly publish null/old stats and then republish, which was
        // especially confusing when Discord kept the first board response warm.
        // If the provider is unavailable, still publish the card with its current
        // layout so creation is not blocked.
        const liveStatsPublished = (slotKey === "fortnite" || slotKey === "valorant")
            ? await refreshGameSlot(slotKey, false)
            : false;
        if (!liveStatsPublished) await publishSurfaces(id.appId, id.configId, slotKey, imageKey);

        await authorizeApp(id.appId);
        await attachToProfile(id.appId, me.id);

        // Claim onto the profile identity so others can see it (needs 2FA).
        toast("Claiming widget to your profile (enter 2FA if prompted)…", Toasts.Type.MESSAGE, 4000);
        const claimErr = await finalizeIdentity(id.appId, me.id);
        if (claimErr) {
            toast(`Widget deployed to your board, but the public claim failed: ${claimErr}. It shows on your own profile; click again to retry the claim.`, Toasts.Type.FAILURE, 10000);
        } else {
            toast("Widget deployed AND claimed — it now shows to other viewers (who have Discord's widget feature), not just you.", Toasts.Type.SUCCESS, 8000);
        }
    } catch (e: any) {
        console.warn("[DMWidget] deploy failed:", e);
        toast(`Widget deploy failed: ${classifyDiscordError(e)}`, Toasts.Type.FAILURE, 9000);
    }
}

async function removeFromProfile(): Promise<void> {
    await ensureSlots();
    const me = UserStore.getCurrentUser();
    const slotKey = slotKeyOf();
    const id = getSlot(slotKey);
    if (!id.appId) { toast("No widget to remove.", Toasts.Type.MESSAGE); return; }
    try {
        let widgets: any[] = [];
        try { const prof = await apiGet(`/users/${me.id}/profile`); widgets = profileWidgetEntries(prof) ?? []; } catch { widgets = []; }
        await apiPut("/users/@me/widgets", { widgets: widgets.filter(w => w?.data?.application_id !== id.appId) });
        setSlot(slotKey, { ...EMPTY_IDENTITY }); // forget this slot so status resets
        toast("Widget removed from your profile board. (Your app stays in the Developer Portal — delete it there if you want.)", Toasts.Type.MESSAGE, 7000);
    } catch (e: any) {
        toast(`Remove failed: ${classifyDiscordError(e)}`, Toasts.Type.FAILURE, 7000);
    }
}

// Reorder the profile board so THIS slot's card sits on top. The FRONT of the
// widgets array is the top of the board (verified live), so we move this app's
// entry to the front and keep the rest in their existing order.
async function moveToTop(): Promise<void> {
    await ensureSlots();
    const me = UserStore.getCurrentUser();
    const slotKey = slotKeyOf();
    const id = getSlot(slotKey);
    if (!me?.id || !SNOWFLAKE.test(id.appId)) { toast("Create this widget first.", Toasts.Type.FAILURE); return; }
    try {
        let widgets: any[] = [];
        try { const prof = await apiGet(`/users/${me.id}/profile`); widgets = profileWidgetEntries(prof) ?? []; } catch { widgets = []; }
        const mine = widgets.filter(w => w?.data?.application_id === id.appId);
        if (!mine.length) { toast("This card isn't on your board yet — hit Create first.", Toasts.Type.FAILURE); return; }
        const rest = widgets.filter(w => w?.data?.application_id !== id.appId);
        await apiPut("/users/@me/widgets", { widgets: [...mine, ...rest] });
        toast("Moved to the top of your profile board.", Toasts.Type.SUCCESS, 5000);
    } catch (e: any) {
        toast(`Couldn't reorder: ${classifyDiscordError(e)}`, Toasts.Type.FAILURE, 7000);
    }
}

// ---- share / import (move a widget from one account to another) ------------
// Serialize the CONTENT of the current widget (never the app id, bot token, or
// API keys) to a short code the user can paste on another account. Secrets are
// excluded by construction: only these fields are ever read or written.
const SHAREABLE = [
    "gameTemplate", "appName", "widgetTitle", "topLayout", "bottomLayout", "widgetStyle",
    "stat1", "stat2", "stat3", "stat4", "stat5", "stat6",
    "progressLabel", "progressPercent", "heroImageUrl", "appIconUrl",
    "fnIgn", "fnAccountType", "fnUnrealRank", "fnEarnings", "fnChapterSeason", "fnTopPlacement",
    "valRiotId", "valRegion", "valActEpisode"
] as const;

// UTF-8-safe base64 (btoa/atob are latin1-only; emoji/katakana in titles break it).
const b64encode = (s: string): string => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string): string => decodeURIComponent(escape(atob(s)));

async function exportConfig(): Promise<string> {
    const s = settings.store as any;
    const o: Record<string, any> = {};
    for (const k of SHAREABLE) o[k] = s[k];
    // Per-slot content and appearance so a paste reproduces each card's
    // supported layout/style choice. Only remote URLs travel; local files stay
    // on this PC and account-bound IDs/tokens are never exported.
    const media: Record<string, { heroImageUrl: string; appIconUrl: string; widgetStyle?: string; topLayout?: string; bottomLayout?: string; }> = {};
    const cur = slots.get();
    for (const key of Object.keys(cur)) {
        const v = cur[key];
        if (!v) continue;
        const localFile = await getLocalWidgetImage(key);
        const entry = {
            heroImageUrl: localFile ? "" : v.heroImageUrl || "",
            appIconUrl: v.appIconUrl || "",
            widgetStyle: v.widgetStyle,
            topLayout: v.topLayout,
            bottomLayout: v.bottomLayout
        };
        if (entry.heroImageUrl || entry.appIconUrl || entry.widgetStyle || entry.topLayout || entry.bottomLayout || localFile) media[key] = entry;
    }
    if (Object.keys(media).length) o.__slots = media;
    if (await getLocalWidgetImage(String(s.gameTemplate ?? "none"))) o.heroImageUrl = "";
    return "DMW1:" + b64encode(JSON.stringify(o));
}

// Returns null on success or a human message on failure. Applies only SHAREABLE
// keys, so a tampered code can never inject an API key or an app id.
function importConfig(code: string): string | null {
    const raw = String(code ?? "").trim().replace(/^DMW1:/i, "").trim();
    if (!raw) return "Paste a widget code first (get one with 'Copy this widget' on your other account).";
    let obj: any;
    try { obj = JSON.parse(b64decode(raw)); } catch { return "That doesn't look like a valid DMWidget code."; }
    if (!obj || typeof obj !== "object") return "That code is empty or malformed.";
    const s = settings.store as any;
    let n = 0;
    for (const k of SHAREABLE) {
        if (!(k in obj)) continue;
        const value = obj[k];
        // These new appearance fields affect the request sent to Discord, so
        // accept only values the gallery itself can produce.
        if (k === "widgetStyle") {
            if (typeof value === "string" && WIDGET_STYLE_PRESETS.some(preset => preset.id === value)) { s[k] = value; n++; }
            continue;
        }
        if (k === "topLayout") {
            if (value === "hero" || value === "contained") { s[k] = value; n++; }
            continue;
        }
        if (k === "bottomLayout") {
            if (value === "stats" || value === "progress") { s[k] = value; n++; }
            continue;
        }
        s[k] = value;
        n++;
    }
    // Restore per-slot URLs and style selection. A local file intentionally
    // never travels in a share code; only seed remote URLs and safe layout IDs.
    // Never import appId/assetKeys/tokens — keep any real deploy intact.
    const media = obj.__slots;
    if (media && typeof media === "object") {
        for (const key of Object.keys(media)) {
            const m = media[key] || {};
            const existing = getSlot(key);
            const next: WidgetIdentity = {
                ...existing,
                heroImageUrl: String(m.heroImageUrl ?? existing.heroImageUrl ?? ""),
                appIconUrl: String(m.appIconUrl ?? existing.appIconUrl ?? "")
            };
            if (typeof m.widgetStyle === "string" && WIDGET_STYLE_PRESETS.some(preset => preset.id === m.widgetStyle)) next.widgetStyle = m.widgetStyle;
            if (m.topLayout === "hero" || m.topLayout === "contained") next.topLayout = m.topLayout;
            if (m.bottomLayout === "stats" || m.bottomLayout === "progress") next.bottomLayout = m.bottomLayout;
            setSlot(key, next);
            n++;
        }
    }
    if (!n) return "No widget fields found in that code.";
    return null;
}

// ---- settings UI -----------------------------------------------------------
function ImgPreview({ url, label, round }: { url: string; label: string; round?: boolean; }) {
    const src = url.trim();
    const [previewSrc, setPreviewSrc] = React.useState("");
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        let active = true;
        setPreviewSrc("");
        setFailed(false);
        if (!src) return () => { active = false; };
        if (!/^https?:\/\//i.test(src)) {
            setPreviewSrc(src);
            return () => { active = false; };
        }
        // Discord's renderer can block direct third-party image URLs even
        // though the native upload path can fetch them. Reuse that native path
        // for the preview so presets look selectable before the user deploys.
        Native.fetchImageData(src).then(result => {
            if (!active) return;
            if ("error" in result) setFailed(true);
            else setPreviewSrc(`data:${result.contentType};base64,${result.dataBase64}`);
        }).catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [src]);
    if (!src) return null;
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            {failed
                ? <div style={{ width: round ? 48 : 96, height: 48, display: "grid", placeItems: "center", borderRadius: round ? "50%" : 6, border: "1px dashed var(--text-danger, #f23f43)", color: "var(--text-danger, #f23f43)", fontSize: 11, textAlign: "center", padding: 2 }}>can't load</div>
                : previewSrc
                    ? <img src={previewSrc} onError={() => setFailed(true)} style={{ width: round ? 48 : 96, height: 48, objectFit: "cover", borderRadius: round ? "50%" : 6, border: "1px solid var(--background-modifier-accent)", background: "var(--background-secondary)" }} />
                    : <div style={{ width: round ? 48 : 96, height: 48, display: "grid", placeItems: "center", borderRadius: round ? "50%" : 6, border: "1px dashed var(--background-modifier-accent)", color: "var(--text-muted)", fontSize: 11, textAlign: "center", padding: 2 }}>loading…</div>}
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</span>
        </div>
    );
}

const SLOT_LABEL: Record<string, string> = { fortnite: "Fortnite", valorant: "Valorant", none: "Custom" };
const WIDGET_STYLE_SLOT_KEYS = ["valorant", "fortnite", "none"];

type WidgetStylePreset = {
    id: string;
    name: string;
    mood: string;
    glyph: string;
    accent: string;
    secondary: string;
    surface: string;
    topLayout: "hero" | "contained";
    bottomLayout: "stats" | "progress";
    motion: "none" | "scan" | "embers" | "aurora" | "glint" | "laurel" | "orbit" | "bloom" | "glitch" | "solar" | "blood" | "pursuit";
    frame: "rail" | "ember" | "dream" | "glass" | "relic" | "horizon" | "bloom" | "crt" | "halo" | "velvet" | "nocturne";
    ornament: "prism" | "cinder" | "ribbon" | "shard" | "crown" | "orbit" | "petal" | "pixel" | "flare" | "medallion" | "fang";
};

// Layout choices here map to fields in Discord's current widget schema. The
// rest of the preset is a Discordmaxxer client skin: Discord's widget payload
// has no CSS channel, so the renderer below applies these attributes to the
// actual card after Discord mounts it. Stable IDs are kept for saved profiles
// and imported DMW1 codes; names/art direction can evolve without losing a
// user's selection.
const WIDGET_STYLE_PRESETS: WidgetStylePreset[] = [
    { id: "neonCircuit", name: "Prism Relay", mood: "Kinetic / chromatic", glyph: "⟡", accent: "#55f6e8", secondary: "#ff4fc8", surface: "#0b1420", topLayout: "hero", bottomLayout: "stats", motion: "scan", frame: "rail", ornament: "prism" },
    { id: "emberProtocol", name: "Mothlight Reliquary", mood: "Nocturnal / lantern-lit", glyph: "❈", accent: "#ffd36a", secondary: "#b9f08b", surface: "#121a19", topLayout: "contained", bottomLayout: "stats", motion: "embers", frame: "ember", ornament: "cinder" },
    { id: "cottonCandy", name: "Cotton Candy", mood: "Dream / pastel", glyph: "✧", accent: "#ff6ec7", secondary: "#4a73ff", surface: "#1a1425", topLayout: "hero", bottomLayout: "stats", motion: "aurora", frame: "dream", ornament: "ribbon" },
    { id: "frostedGlass", name: "Frosted Glass", mood: "Glacier / refracted light", glyph: "◇", accent: "#d8f3ff", secondary: "#7586a9", surface: "#121a25", topLayout: "contained", bottomLayout: "stats", motion: "glint", frame: "glass", ornament: "shard" },
    { id: "championRun", name: "Sanguine Court", mood: "Velvet / blood-lust", glyph: "♛", accent: "#ff526e", secondary: "#e9b36b", surface: "#150912", topLayout: "hero", bottomLayout: "progress", motion: "blood", frame: "velvet", ornament: "medallion" },
    { id: "deepSpace", name: "Event Horizon", mood: "Starfield / nocturne", glyph: "✦", accent: "#b8cbff", secondary: "#78e0da", surface: "#060914", topLayout: "contained", bottomLayout: "progress", motion: "orbit", frame: "horizon", ornament: "orbit" },
    { id: "voidBloom", name: "Void Bloom", mood: "Bioluminescent / alien garden", glyph: "✿", accent: "#d173ff", secondary: "#79f0cf", surface: "#170e24", topLayout: "hero", bottomLayout: "stats", motion: "bloom", frame: "bloom", ornament: "petal" },
    { id: "pixelOverdrive", name: "Vesper Hunt", mood: "Midnight / lantern chase", glyph: "✶", accent: "#ff6a8f", secondary: "#ffd36a", surface: "#0c0d1a", topLayout: "contained", bottomLayout: "stats", motion: "pursuit", frame: "nocturne", ornament: "fang" },
    { id: "solarFlare", name: "Solar Cathedral", mood: "Noon king / radiant", glyph: "☼", accent: "#ffe3a0", secondary: "#f06b4d", surface: "#24100d", topLayout: "hero", bottomLayout: "stats", motion: "solar", frame: "halo", ornament: "flare" }
];

const WIDGET_PREVIEW_MOTION_CSS = `
@keyframes dm-widget-preview-scan { from { transform: translateY(-70%); } to { transform: translateY(280%); } }
@keyframes dm-widget-preview-embers { 0%, 100% { opacity: .3; transform: translateY(10%) scale(.94); } 50% { opacity: .86; transform: translateY(-3%) scale(1.06); } }
@keyframes dm-widget-preview-aurora { 0%, 100% { transform: translateX(-12%) rotate(-8deg); opacity: .34; } 50% { transform: translateX(12%) rotate(8deg); opacity: .8; } }
@keyframes dm-widget-preview-glint {
    0%, 18% { transform: translateX(-190%) skewX(-22deg); opacity: 0; }
    30% { transform: translateX(-58%) skewX(-22deg); opacity: .08; }
    43% { transform: translateX(22%) skewX(-22deg); opacity: .38; }
    55% { transform: translateX(102%) skewX(-22deg); opacity: .72; }
    66% { transform: translateX(184%) skewX(-22deg); opacity: .46; }
    77% { transform: translateX(268%) skewX(-22deg); opacity: .12; }
    88%, 100% { transform: translateX(445%) skewX(-22deg); opacity: 0; }
}
@keyframes dm-widget-preview-ice-drift { 0%, 100% { transform: translate3d(-1%, .5%, 0) rotate(-.5deg); opacity: .54; } 50% { transform: translate3d(1%, -.5%, 0) rotate(.5deg); opacity: .92; } }
@keyframes dm-widget-preview-laurel { from { transform: rotate(-14deg) scale(.96); opacity: .28; } to { transform: rotate(14deg) scale(1.04); opacity: .72; } }
@keyframes dm-widget-preview-orbit { to { transform: rotate(360deg); } }
@keyframes dm-widget-preview-bloom { 0%, 100% { opacity: .32; transform: scale(.86); } 50% { opacity: .82; transform: scale(1.13); } }
@keyframes dm-widget-preview-glitch { 0%, 86%, 100% { transform: translateX(0); opacity: .24; } 88% { transform: translateX(2px); opacity: .82; } 91% { transform: translateX(-3px); opacity: .52; } 94% { transform: translateX(1px); opacity: .9; } }
@keyframes dm-widget-preview-solar { to { transform: rotate(360deg); } }
.dm-widget-style-preview, .dm-widget-style-swatch { isolation: isolate; }
.dm-widget-style-swatch { position: relative; }
.dm-widget-style-choice:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.dm-widget-style-preview::before, .dm-widget-style-swatch::before { content: ""; position: absolute; z-index: 0; inset: 0; pointer-events: none; border-radius: inherit; }
.dm-widget-style-preview::after { content: ""; position: absolute; z-index: 3; inset: 0; pointer-events: none; overflow: hidden; border-radius: inherit; }
.dm-widget-style-preview[data-style="neonCircuit"]::before, .dm-widget-style-swatch[data-style="neonCircuit"]::before { background-image: repeating-linear-gradient(135deg, transparent 0 13px, rgba(85,246,232,.09) 14px 15px), linear-gradient(90deg, transparent 72%, rgba(140,99,255,.16)); }
  .dm-widget-style-preview[data-style="emberProtocol"]::before, .dm-widget-style-swatch[data-style="emberProtocol"]::before { background-image: radial-gradient(ellipse 18% 44% at 2% 18%, rgba(255,211,106,.34), transparent 70%), radial-gradient(ellipse 16% 42% at 98% 82%, rgba(185,240,139,.26), transparent 70%), radial-gradient(circle at 10% 92%, rgba(255,211,106,.42) 0 2px, transparent 3px), radial-gradient(circle at 91% 12%, rgba(185,240,139,.4) 0 2px, transparent 3px); }
.dm-widget-style-preview[data-style="cottonCandy"]::before, .dm-widget-style-swatch[data-style="cottonCandy"]::before { background-image: radial-gradient(ellipse at 12% 0%, rgba(255,110,199,.27), transparent 42%), radial-gradient(ellipse at 94% 100%, rgba(74,115,255,.32), transparent 47%); }
.dm-widget-style-preview[data-style="frostedGlass"]::before, .dm-widget-style-swatch[data-style="frostedGlass"]::before { background-image: linear-gradient(132deg, transparent 0 18%, rgba(216,243,255,.11) 19% 20%, transparent 21% 58%, rgba(216,243,255,.08) 59% 60%, transparent 61%), radial-gradient(ellipse at 0% 100%, rgba(216,243,255,.17), transparent 38%), radial-gradient(ellipse at 100% 0%, rgba(117,134,169,.2), transparent 34%); clip-path: polygon(0 0, 100% 0, 100% 100%, 83% 94%, 64% 100%, 45% 93%, 25% 100%, 0 91%); animation: dm-widget-preview-ice-drift 8s ease-in-out infinite alternate; }
  .dm-widget-style-preview[data-style="championRun"]::before, .dm-widget-style-swatch[data-style="championRun"]::before { background-image: radial-gradient(ellipse at 0% 14%, rgba(255,82,110,.28), transparent 38%), radial-gradient(ellipse at 100% 88%, rgba(233,179,107,.2), transparent 34%), linear-gradient(90deg, rgba(95,8,32,.56), transparent 19% 81%, rgba(95,8,32,.5)); }
.dm-widget-style-preview[data-style="deepSpace"]::before, .dm-widget-style-swatch[data-style="deepSpace"]::before { background-image: radial-gradient(circle at 12% 28%, #d6e2ff 0 1px, transparent 1.5px), radial-gradient(circle at 77% 22%, #43d9d0 0 1px, transparent 1.5px), radial-gradient(circle at 62% 78%, #89a7ff 0 1px, transparent 1.5px), radial-gradient(circle at 91% 61%, #d6e2ff 0 1px, transparent 1.5px); background-size: 100% 100%; }
.dm-widget-style-preview[data-style="voidBloom"]::before, .dm-widget-style-swatch[data-style="voidBloom"]::before { background-image: radial-gradient(ellipse at 82% 18%, rgba(209,115,255,.34), transparent 32%), radial-gradient(ellipse at 88% 90%, rgba(121,240,207,.23), transparent 40%), radial-gradient(ellipse at 8% 76%, rgba(115,62,165,.22), transparent 38%); }
  .dm-widget-style-preview[data-style="pixelOverdrive"]::before, .dm-widget-style-swatch[data-style="pixelOverdrive"]::before { background-image: radial-gradient(ellipse at 0% 0%, rgba(255,106,143,.22), transparent 35%), radial-gradient(ellipse at 100% 100%, rgba(255,211,106,.2), transparent 34%), linear-gradient(90deg, rgba(255,106,143,.1), transparent 15% 85%, rgba(255,211,106,.08)); }
.dm-widget-style-preview[data-style="solarFlare"]::before, .dm-widget-style-swatch[data-style="solarFlare"]::before { background-image: repeating-conic-gradient(from 2deg at 100% 0%, rgba(255,219,103,.12) 0deg 1deg, transparent 2deg 16deg), radial-gradient(ellipse at 100% 0%, rgba(255,100,77,.29), transparent 48%); }
.dm-widget-style-preview[data-motion="scan"]:not([data-motion-paused="true"])::after { inset: -35% 0 auto; height: 35%; background: linear-gradient(180deg, transparent, var(--dmw-glow), transparent); animation: dm-widget-preview-scan 3.2s ease-in-out infinite; }
.dm-widget-style-preview[data-motion="embers"]:not([data-motion-paused="true"])::after { inset: auto -10% -35%; height: 75%; background: radial-gradient(ellipse at 50% 100%, #ff593a88, var(--dmw-glow) 30%, transparent 72%); filter: blur(7px); animation: dm-widget-preview-embers 2.4s ease-in-out infinite; }
.dm-widget-style-preview[data-motion="aurora"]:not([data-motion-paused="true"])::after { inset: -35% -20%; background: linear-gradient(112deg, transparent 24%, #ff6ec733 42%, #7b7dff55 55%, #4a73ff22 68%, transparent 82%); filter: blur(10px); animation: dm-widget-preview-aurora 6s ease-in-out infinite alternate; }
.dm-widget-style-preview[data-motion="glint"]:not([data-motion-paused="true"])::after { inset: 0 auto 0 -34%; width: 28%; background: linear-gradient(90deg, transparent 0%, rgba(216,243,255,.04) 16%, rgba(255,255,255,.24) 44%, rgba(216,243,255,.12) 58%, rgba(255,255,255,.05) 76%, transparent 100%); filter: blur(.2px); will-change: transform, opacity; animation: dm-widget-preview-glint 7.4s cubic-bezier(.22,.72,.3,1) infinite; }
.dm-widget-style-preview[data-motion="laurel"]:not([data-motion-paused="true"])::after { inset: -70% -10% auto auto; width: 72%; aspect-ratio: 1; border: 1px solid #ffd66b70; border-radius: 50%; box-shadow: 0 0 22px #ffd66b24, inset 0 0 22px #e28d4220; background: repeating-conic-gradient(from 0deg, #ffd66b18 0deg 2deg, transparent 3deg 20deg); animation: dm-widget-preview-laurel 4.5s ease-in-out infinite alternate; }
.dm-widget-style-preview[data-motion="orbit"]:not([data-motion-paused="true"])::after { inset: 15% -18%; border: 1px solid #89a7ff70; border-right-color: #43d9d0; border-radius: 50%; box-shadow: 0 0 18px #89a7ff24, inset 0 0 16px #43d9d018; animation: dm-widget-preview-orbit 16s linear infinite; }
.dm-widget-style-preview[data-motion="bloom"]:not([data-motion-paused="true"])::after { inset: 8% 5% auto auto; width: 42%; aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle, #79f0cf55, #d173ff40 42%, transparent 72%); filter: blur(9px); animation: dm-widget-preview-bloom 3.6s ease-in-out infinite; }
.dm-widget-style-preview[data-motion="glitch"]:not([data-motion-paused="true"])::after { inset: 0; background: repeating-linear-gradient(0deg, transparent 0 13px, #a7ff4f32 14px 15px, transparent 16px 25px); mix-blend-mode: screen; animation: dm-widget-preview-glitch 2.8s steps(1, end) infinite; }
.dm-widget-style-preview[data-motion="solar"]:not([data-motion-paused="true"])::after { inset: -65%; background: repeating-conic-gradient(from 0deg at 50% 50%, transparent 0deg 12deg, #ffdb6726 13deg 15deg, transparent 16deg 24deg); mask: radial-gradient(circle, transparent 27%, #000 42%, #000 54%, transparent 66%); animation: dm-widget-preview-solar 24s linear infinite; }
/* The five refreshed directions use layered geometry rather than one flat
 * gradient. They are intentionally graphic and a little imperfect: a card
 * should feel art-directed, not like a generic AI-generated dashboard tile. */
@keyframes dm-widget-preview-prism { 0%, 100% { transform: translateX(-18%) rotate(-7deg); opacity: .28; } 50% { transform: translateX(22%) rotate(7deg); opacity: .82; } }
@keyframes dm-widget-preview-aurora { 0%, 100% { transform: translateX(-3%) skewX(-3deg); opacity: .62; } 50% { transform: translateX(3%) skewX(3deg); opacity: .98; } }
@keyframes dm-widget-preview-crown { 0%, 100% { transform: rotate(-8deg) scale(.94); opacity: .36; } 50% { transform: rotate(8deg) scale(1.06); opacity: .9; } }
@keyframes dm-widget-preview-horizon { from { transform: rotateX(64deg) rotateZ(0deg); } to { transform: rotateX(64deg) rotateZ(360deg); } }
@keyframes dm-widget-preview-riot { 0%, 78%, 100% { transform: translate(0); clip-path: inset(0); } 80% { transform: translate(3px, -1px); clip-path: inset(12% 0 62% 0); } 83% { transform: translate(-4px, 2px); clip-path: inset(57% 0 18% 0); } 87% { transform: translate(1px); clip-path: inset(0); } }
@keyframes dm-widget-preview-cathedral { to { transform: rotate(360deg); } }
@keyframes dm-widget-preview-relic-drift { 0%, 100% { transform: translate3d(-2%, 1%, 0) rotate(-1deg); opacity: .58; } 50% { transform: translate3d(2%, -1%, 0) rotate(1deg); opacity: .96; } }
@keyframes dm-widget-preview-relic-orbit { from { transform: rotate(0deg); opacity: .42; } to { transform: rotate(360deg); opacity: .86; } }
@keyframes dm-widget-preview-blood-tide { 0%, 100% { transform: translate3d(-2%, 1%, 0) scale(.96); opacity: .56; } 50% { transform: translate3d(2%, -1%, 0) scale(1.04); opacity: .96; } }
@keyframes dm-widget-preview-hunger { 0%, 100% { transform: rotate(-3deg) scale(.94); opacity: .42; } 50% { transform: rotate(3deg) scale(1.05); opacity: .94; } }
@keyframes dm-widget-preview-starfield { 0%, 100% { transform: translate3d(-1%, .5%, 0) scale(.99); opacity: .56; } 50% { transform: translate3d(1%, -.5%, 0) scale(1.015); opacity: .98; } }
@keyframes dm-widget-preview-night-orbit { from { transform: rotateX(58deg) rotateZ(0deg); opacity: .42; } to { transform: rotateX(58deg) rotateZ(360deg); opacity: .9; } }
@keyframes dm-widget-preview-route { 0%, 100% { transform: translateX(-4%); opacity: .38; } 50% { transform: translateX(4%); opacity: .92; } }
  @keyframes dm-widget-preview-hunt-pulse { 0%, 100% { transform: scale(.94) rotate(-2deg); opacity: .46; } 48% { transform: scale(1.04) rotate(2deg); opacity: .98; } 56%, 72% { transform: scale(.98) rotate(0deg); opacity: .72; } }
  @keyframes dm-widget-preview-hunt-lights { 0%, 100% { opacity: .46; filter: saturate(.86) brightness(.9); } 26% { opacity: .92; filter: saturate(1.16) brightness(1.12); } 54% { opacity: .62; filter: saturate(1.02) brightness(1.02); } 78% { opacity: .84; filter: saturate(1.22) brightness(1.08); } }
  @keyframes dm-widget-preview-sanguine-velvet { 0%, 100% { transform: translate3d(-1%, .5%, 0) scale(1); opacity: .68; } 50% { transform: translate3d(1%, -.5%, 0) scale(1.035); opacity: .98; } }
  @keyframes dm-widget-preview-mothlight-dust { 0%, 100% { transform: translate3d(-2%, 1%, 0) scale(.96); opacity: .42; } 50% { transform: translate3d(3%, -2%, 0) scale(1.05); opacity: .94; } }
@keyframes dm-widget-preview-sun-crown { from { transform: rotate(0deg) scale(.96); opacity: .45; } to { transform: rotate(360deg) scale(1.04); opacity: .9; } }
  .dm-widget-style-preview[data-style="neonCircuit"]::before, .dm-widget-style-swatch[data-style="neonCircuit"]::before { background-image: linear-gradient(104deg, transparent 0 23%, rgba(85,246,232,.12) 35%, rgba(140,99,255,.13) 51%, rgba(255,79,200,.19) 69%, transparent 92%), linear-gradient(180deg, transparent 9%, rgba(255,79,200,.2) 52%, transparent 92%), repeating-linear-gradient(90deg, transparent 0 21px, rgba(85,246,232,.07) 22px 23px), radial-gradient(circle at 92% 8%, rgba(255,79,200,.38), transparent 38%); clip-path: polygon(0 0, 100% 0, 100% 65%, 72% 52%, 53% 100%, 0 82%); animation: dm-widget-preview-aurora 8s ease-in-out infinite alternate; }
  .dm-widget-style-preview[data-style="neonCircuit"]::after { inset: -15% -30%; width: 42%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), rgba(85,246,232,.22), transparent); filter: blur(2px); transform: rotate(18deg); animation: dm-widget-preview-prism 4.8s ease-in-out infinite; }
  .dm-widget-style-preview[data-style="emberProtocol"]::before, .dm-widget-style-swatch[data-style="emberProtocol"]::before { background-image: radial-gradient(ellipse 18% 44% at 2% 18%, rgba(255,211,106,.44), transparent 70%), radial-gradient(ellipse 16% 42% at 98% 82%, rgba(185,240,139,.34), transparent 70%), radial-gradient(circle at 10% 92%, rgba(255,211,106,.5) 0 2px, transparent 3px), radial-gradient(circle at 91% 12%, rgba(185,240,139,.46) 0 2px, transparent 3px), linear-gradient(118deg, transparent 0 42%, rgba(255,211,106,.08) 52%, transparent 62%); clip-path: polygon(0 0, 100% 0, 100% 100%, 80% 95%, 62% 100%, 37% 94%, 0 100%); animation: dm-widget-preview-mothlight-dust 5.4s ease-in-out infinite alternate; }
  .dm-widget-style-preview[data-style="emberProtocol"]::after { inset: 0; background-image: radial-gradient(circle at 7% 14%, #ffe29a 0 1.5px, transparent 3px), radial-gradient(circle at 94% 16%, #b9f08b 0 1.5px, transparent 3px), radial-gradient(circle at 3% 78%, #ffd36a 0 1.5px, transparent 3px), radial-gradient(circle at 96% 84%, #e2ffb3 0 1.5px, transparent 3px), radial-gradient(circle at 18% 95%, rgba(255,211,106,.8) 0 1.5px, transparent 3px), radial-gradient(circle at 81% 5%, rgba(185,240,139,.75) 0 1.5px, transparent 3px), radial-gradient(ellipse at 0% 50%, rgba(255,211,106,.16), transparent 24%), radial-gradient(ellipse at 100% 50%, rgba(185,240,139,.14), transparent 24%); mix-blend-mode: screen; animation: dm-widget-preview-mothlight-dust 4.2s ease-in-out infinite reverse; }
  .dm-widget-style-preview[data-style="championRun"]::before, .dm-widget-style-swatch[data-style="championRun"]::before { background-image: radial-gradient(ellipse at -4% 12%, rgba(255,82,110,.46), transparent 36%), radial-gradient(ellipse at 104% 90%, rgba(233,179,107,.28), transparent 34%), linear-gradient(90deg, rgba(95,8,32,.8), transparent 18% 82%, rgba(95,8,32,.74)), repeating-linear-gradient(104deg, transparent 0 17px, rgba(255,82,110,.045) 18px 20px), radial-gradient(ellipse at 50% 100%, #260d1a, #150912 74%); animation: dm-widget-preview-sanguine-velvet 7.2s ease-in-out infinite alternate; }
  .dm-widget-style-preview[data-style="championRun"]::after { inset: 0; background-image: radial-gradient(circle at 4% 12%, #ffd08a 0 1.5px, transparent 3px), radial-gradient(circle at 96% 86%, #ff526e 0 2px, transparent 4px), radial-gradient(circle at 8% 78%, #ff526e 0 1.5px, transparent 3px), radial-gradient(circle at 91% 22%, #e9b36b 0 1.5px, transparent 3px), radial-gradient(ellipse at 50% 100%, rgba(126,9,43,.38), transparent 58%); mix-blend-mode: screen; animation: dm-widget-preview-sanguine-velvet 5.9s ease-in-out infinite reverse; }
.dm-widget-style-preview[data-style="deepSpace"]::before, .dm-widget-style-swatch[data-style="deepSpace"]::before { background-image: radial-gradient(circle at 8% 18%, #f8fbff 0 1px, transparent 1.8px), radial-gradient(circle at 21% 72%, #b8cbff 0 1px, transparent 1.8px), radial-gradient(circle at 34% 31%, #fff 0 1.3px, transparent 2px), radial-gradient(circle at 47% 82%, #78e0da 0 1px, transparent 1.8px), radial-gradient(circle at 58% 16%, #dce6ff 0 1px, transparent 1.8px), radial-gradient(circle at 69% 56%, #fff 0 1.2px, transparent 2px), radial-gradient(circle at 82% 21%, #78e0da 0 1px, transparent 1.8px), radial-gradient(circle at 93% 74%, #b8cbff 0 1px, transparent 1.8px), radial-gradient(circle at 77% 90%, #fff 0 1px, transparent 1.7px), radial-gradient(ellipse at 64% 57%, rgba(120,224,218,.14), transparent 31%), radial-gradient(ellipse at 28% 18%, rgba(112,123,255,.16), transparent 36%), linear-gradient(145deg, #060914 12%, #0c1530 61%, #050711); animation: dm-widget-preview-starfield 7s ease-in-out infinite; }
.dm-widget-style-preview[data-style="deepSpace"]::after { inset: 4% -8% auto auto; width: 66%; aspect-ratio: 1; border: 1px solid rgba(120,224,218,.66); border-radius: 50%; box-shadow: 0 0 22px rgba(120,224,218,.18), 0 0 0 11px rgba(184,203,255,.05), inset 0 0 20px rgba(184,203,255,.1); background: conic-gradient(from 4deg, transparent 0 21deg, rgba(184,203,255,.5) 22deg 24deg, transparent 25deg 76deg, rgba(120,224,218,.48) 77deg 80deg, transparent 81deg 142deg); -webkit-mask: radial-gradient(circle, transparent 0 54%, #000 55% 58%, transparent 59%); mask: radial-gradient(circle, transparent 0 54%, #000 55% 58%, transparent 59%); transform: rotateX(58deg); animation: dm-widget-preview-night-orbit 22s linear infinite; }
  .dm-widget-style-preview[data-style="pixelOverdrive"]::before, .dm-widget-style-swatch[data-style="pixelOverdrive"]::before { inset: 3px; border: 1px solid rgba(255,106,143,.42); border-radius: 8px; background-image: linear-gradient(90deg, rgba(255,106,143,.12), transparent 14% 86%, rgba(255,211,106,.1)), radial-gradient(ellipse at 0% 0%, rgba(255,106,143,.28), transparent 31%), radial-gradient(ellipse at 100% 100%, rgba(255,211,106,.22), transparent 32%); box-shadow: inset 0 0 0 3px rgba(255,211,106,.045), 0 0 12px rgba(255,106,143,.16); animation: dm-widget-preview-hunt-lights 3.1s ease-in-out infinite; }
  .dm-widget-style-preview[data-style="pixelOverdrive"]::after { inset: 0; background-image: radial-gradient(circle at 7% 7%, #ffdca0 0 2px, transparent 3.5px), radial-gradient(circle at 20% 5%, #ff6a8f 0 2px, transparent 3.5px), radial-gradient(circle at 35% 7%, #ffd36a 0 2px, transparent 3.5px), radial-gradient(circle at 50% 4%, #ff8fb2 0 2px, transparent 3.5px), radial-gradient(circle at 66% 7%, #ffd36a 0 2px, transparent 3.5px), radial-gradient(circle at 81% 5%, #ff6a8f 0 2px, transparent 3.5px), radial-gradient(circle at 94% 8%, #ffdca0 0 2px, transparent 3.5px), radial-gradient(circle at 5% 93%, #ff6a8f 0 2px, transparent 3.5px), radial-gradient(circle at 19% 96%, #ffd36a 0 2px, transparent 3.5px), radial-gradient(circle at 34% 94%, #ff8fb2 0 2px, transparent 3.5px), radial-gradient(circle at 50% 97%, #ffdca0 0 2px, transparent 3.5px), radial-gradient(circle at 66% 94%, #ff6a8f 0 2px, transparent 3.5px), radial-gradient(circle at 82% 96%, #ffd36a 0 2px, transparent 3.5px), radial-gradient(circle at 95% 91%, #ff8fb2 0 2px, transparent 3.5px), radial-gradient(circle at 3% 29%, #ffd36a 0 2px, transparent 3.5px), radial-gradient(circle at 97% 30%, #ff6a8f 0 2px, transparent 3.5px), radial-gradient(circle at 3% 52%, #ff8fb2 0 2px, transparent 3.5px), radial-gradient(circle at 97% 54%, #ffdca0 0 2px, transparent 3.5px), radial-gradient(ellipse at 0% 50%, rgba(255,106,143,.18), transparent 24%), radial-gradient(ellipse at 100% 50%, rgba(255,211,106,.16), transparent 24%); mix-blend-mode: screen; animation: dm-widget-preview-hunt-lights 3.1s steps(5, end) infinite reverse; }
.dm-widget-style-preview[data-style="solarFlare"]::before, .dm-widget-style-swatch[data-style="solarFlare"]::before { background-image: radial-gradient(circle at 84% 18%, #fff2bf 0 6%, rgba(255,227,160,.8) 7% 12%, rgba(240,107,77,.28) 13% 27%, transparent 40%), repeating-conic-gradient(from 0deg at 84% 18%, rgba(255,227,160,.32) 0deg 2deg, transparent 3deg 14deg), linear-gradient(152deg, #24100d 0 42%, rgba(240,107,77,.18) 43% 55%, #351714 56% 72%, #160d13 73%); clip-path: polygon(0 0, 100% 0, 100% 100%, 13% 100%, 21% 77%, 0 64%); }
.dm-widget-style-preview[data-style="solarFlare"]::after { inset: -61% -56%; background: repeating-conic-gradient(from 2deg at 50% 50%, transparent 0deg 8deg, rgba(255,227,160,.46) 9deg 12deg, transparent 13deg 22deg); -webkit-mask: radial-gradient(circle, transparent 27%, #000 34%, #000 54%, transparent 64%); mask: radial-gradient(circle, transparent 27%, #000 34%, #000 54%, transparent 64%); animation: dm-widget-preview-sun-crown 23s linear infinite; }
.dm-widget-style-preview[data-motion-paused="true"]::before, .dm-widget-style-preview[data-motion-paused="true"]::after, .dm-widget-style-swatch[data-motion-paused="true"]::before, .dm-widget-style-swatch[data-motion-paused="true"]::after { animation-play-state: paused !important; }
`;

// Discord only stores the widget's supported content/layout fields. It does
// not have a custom-CSS field, so this second stylesheet is deliberately
// client-side: it targets the real profile-board/popout card after Discord
// mounts it. The data attributes contain every preset attribute (skin, frame,
// ornament, motion, pause state, and palette), which also makes the renderer
// easy to diagnose without guessing from a screenshot.
const WIDGET_CLIENT_SKIN_CSS = `
@keyframes dm-widget-client-prism { 0%, 100% { transform: translateX(-24%) rotate(16deg); opacity: .18; } 50% { transform: translateX(224%) rotate(16deg); opacity: .86; } }
@keyframes dm-widget-client-aurora { 0%, 100% { transform: translateX(-3%) skewX(-3deg); opacity: .62; } 50% { transform: translateX(3%) skewX(3deg); opacity: .98; } }
@keyframes dm-widget-client-cinder { 0%, 100% { transform: translateY(9%) scale(.92); opacity: .25; } 50% { transform: translateY(-5%) scale(1.08); opacity: .82; } }
@keyframes dm-widget-client-ribbon { 0%, 100% { transform: translateX(-16%) rotate(-8deg); opacity: .24; } 50% { transform: translateX(16%) rotate(8deg); opacity: .78; } }
@keyframes dm-widget-client-glint {
    0%, 18% { transform: translateX(-190%) skewX(-22deg); opacity: 0; }
    30% { transform: translateX(-58%) skewX(-22deg); opacity: .08; }
    43% { transform: translateX(22%) skewX(-22deg); opacity: .38; }
    55% { transform: translateX(102%) skewX(-22deg); opacity: .72; }
    66% { transform: translateX(184%) skewX(-22deg); opacity: .46; }
    77% { transform: translateX(268%) skewX(-22deg); opacity: .12; }
    88%, 100% { transform: translateX(445%) skewX(-22deg); opacity: 0; }
}
@keyframes dm-widget-client-ice-drift { 0%, 100% { transform: translate3d(-1%, .5%, 0) rotate(-.5deg); opacity: .54; } 50% { transform: translate3d(1%, -.5%, 0) rotate(.5deg); opacity: .92; } }
@keyframes dm-widget-client-crown { 0%, 100% { transform: rotate(-10deg) scale(.93); opacity: .34; } 50% { transform: rotate(10deg) scale(1.05); opacity: .9; } }
@keyframes dm-widget-client-horizon { to { transform: rotateX(65deg) rotateZ(360deg); } }
@keyframes dm-widget-client-bloom { 0%, 100% { transform: scale(.82); opacity: .2; } 50% { transform: scale(1.16); opacity: .78; } }
@keyframes dm-widget-client-riot { 0%, 78%, 100% { transform: translate(0); clip-path: inset(0); opacity: .27; } 80% { transform: translate(4px, -1px); clip-path: inset(9% 0 64% 0); opacity: .82; } 84% { transform: translate(-5px, 2px); clip-path: inset(58% 0 16% 0); opacity: .64; } 88% { transform: translate(1px); clip-path: inset(0); opacity: .34; } }
@keyframes dm-widget-client-flare { to { transform: rotate(360deg); } }
@keyframes dm-widget-client-relic-drift { 0%, 100% { transform: translate3d(-2%, 1%, 0) rotate(-1deg); opacity: .56; } 50% { transform: translate3d(2%, -1%, 0) rotate(1deg); opacity: .96; } }
@keyframes dm-widget-client-relic-orbit { from { transform: rotate(0deg); opacity: .4; } to { transform: rotate(360deg); opacity: .9; } }
@keyframes dm-widget-client-blood-tide { 0%, 100% { transform: translate3d(-2%, 1%, 0) scale(.96); opacity: .54; } 50% { transform: translate3d(2%, -1%, 0) scale(1.04); opacity: .98; } }
@keyframes dm-widget-client-hunger { 0%, 100% { transform: rotate(-3deg) scale(.94); opacity: .42; } 50% { transform: rotate(3deg) scale(1.05); opacity: .96; } }
@keyframes dm-widget-client-starfield { 0%, 100% { transform: translate3d(-1%, .5%, 0) scale(.99); opacity: .52; } 50% { transform: translate3d(1%, -.5%, 0) scale(1.02); opacity: .98; } }
@keyframes dm-widget-client-night-orbit { from { transform: rotateX(58deg) rotateZ(0deg); opacity: .42; } to { transform: rotateX(58deg) rotateZ(360deg); opacity: .9; } }
@keyframes dm-widget-client-route { 0%, 100% { transform: translateX(-4%); opacity: .34; } 50% { transform: translateX(4%); opacity: .94; } }
  @keyframes dm-widget-client-hunt-pulse { 0%, 100% { transform: scale(.94) rotate(-2deg); opacity: .44; } 48% { transform: scale(1.04) rotate(2deg); opacity: .98; } 56%, 72% { transform: scale(.98) rotate(0deg); opacity: .72; } }
  @keyframes dm-widget-client-hunt-lights { 0%, 100% { opacity: .46; filter: saturate(.86) brightness(.9); } 26% { opacity: .92; filter: saturate(1.16) brightness(1.12); } 54% { opacity: .62; filter: saturate(1.02) brightness(1.02); } 78% { opacity: .84; filter: saturate(1.22) brightness(1.08); } }
  @keyframes dm-widget-client-sanguine-velvet { 0%, 100% { transform: translate3d(-1%, .5%, 0) scale(1); opacity: .68; } 50% { transform: translate3d(1%, -.5%, 0) scale(1.035); opacity: .98; } }
  @keyframes dm-widget-client-mothlight-dust { 0%, 100% { transform: translate3d(-2%, 1%, 0) scale(.96); opacity: .42; } 50% { transform: translate3d(3%, -2%, 0) scale(1.05); opacity: .94; } }
@keyframes dm-widget-client-sun-crown { from { transform: rotate(0deg) scale(.96); opacity: .44; } to { transform: rotate(360deg) scale(1.04); opacity: .92; } }
[data-dm-widget-skin] { position: relative !important; isolation: isolate; overflow: hidden !important; border-radius: 12px !important; border: 1px solid color-mix(in srgb, var(--dmw-skin-accent) 62%, transparent) !important; box-shadow: 0 0 0 1px color-mix(in srgb, var(--dmw-skin-accent) 16%, transparent), 0 8px 24px color-mix(in srgb, var(--dmw-skin-accent) 18%, transparent), inset 0 0 24px color-mix(in srgb, var(--dmw-skin-accent) 10%, transparent); background-color: var(--dmw-skin-surface) !important; }
[data-dm-widget-skin]::before, [data-dm-widget-skin]::after { content: ""; position: absolute; pointer-events: none; border-radius: inherit; }
[data-dm-widget-skin]::before { z-index: 0; inset: 0; background-repeat: no-repeat; }
[data-dm-widget-skin]::after { z-index: 2; inset: 0; }
[data-dm-widget-skin] > * { position: relative; z-index: 1; }
[data-dm-widget-skin="neonCircuit"] { background-image: linear-gradient(104deg, transparent 0 24%, color-mix(in srgb, var(--dmw-skin-accent) 12%, transparent) 36%, color-mix(in srgb, #8c63ff 13%, transparent) 52%, color-mix(in srgb, var(--dmw-skin-secondary) 20%, transparent) 70%, transparent 92%), linear-gradient(180deg, transparent 8%, color-mix(in srgb, var(--dmw-skin-secondary) 13%, transparent) 53%, transparent 94%), linear-gradient(135deg, var(--dmw-skin-surface), #111d31 72%) !important; }
[data-dm-widget-skin="neonCircuit"]::before { background-image: linear-gradient(104deg, transparent 0 23%, color-mix(in srgb, var(--dmw-skin-accent) 16%, transparent) 35%, color-mix(in srgb, #8c63ff 14%, transparent) 51%, color-mix(in srgb, var(--dmw-skin-secondary) 22%, transparent) 69%, transparent 92%), linear-gradient(180deg, transparent 9%, color-mix(in srgb, var(--dmw-skin-secondary) 22%, transparent) 52%, transparent 92%), repeating-linear-gradient(90deg, transparent 0 22px, color-mix(in srgb, var(--dmw-skin-accent) 7%, transparent) 23px 24px), radial-gradient(circle at 94% 8%, color-mix(in srgb, var(--dmw-skin-secondary) 44%, transparent), transparent 38%); clip-path: polygon(0 0, 100% 0, 100% 64%, 73% 52%, 51% 100%, 0 82%); filter: blur(.15px); animation: dm-widget-client-aurora 8s ease-in-out infinite alternate; }
[data-dm-widget-skin="neonCircuit"]::after { inset: -15% -34%; width: 38%; background: linear-gradient(90deg, transparent, color-mix(in srgb, #fff 68%, var(--dmw-skin-accent)), transparent); filter: blur(2px); transform: rotate(17deg); animation: dm-widget-client-prism 5s ease-in-out infinite; }
  [data-dm-widget-skin="emberProtocol"] { background-image: radial-gradient(ellipse at 4% 100%, color-mix(in srgb, var(--dmw-skin-accent) 34%, transparent), transparent 42%), radial-gradient(ellipse at 96% 4%, color-mix(in srgb, var(--dmw-skin-secondary) 24%, transparent), transparent 36%), linear-gradient(115deg, #101819, #1d2b24 55%, #100f18 100%) !important; }
  [data-dm-widget-skin="emberProtocol"]::before { background-image: radial-gradient(ellipse 18% 44% at 2% 18%, color-mix(in srgb, var(--dmw-skin-accent) 46%, transparent), transparent 70%), radial-gradient(ellipse 16% 42% at 98% 82%, color-mix(in srgb, var(--dmw-skin-secondary) 35%, transparent), transparent 70%), radial-gradient(circle at 10% 92%, color-mix(in srgb, var(--dmw-skin-accent) 72%, transparent) 0 2px, transparent 3px), radial-gradient(circle at 91% 12%, color-mix(in srgb, var(--dmw-skin-secondary) 72%, transparent) 0 2px, transparent 3px), linear-gradient(118deg, transparent 0 42%, color-mix(in srgb, var(--dmw-skin-accent) 10%, transparent) 52%, transparent 62%); clip-path: polygon(0 0, 100% 0, 100% 100%, 80% 95%, 62% 100%, 37% 94%, 0 100%); animation: dm-widget-client-mothlight-dust 5.4s ease-in-out infinite alternate; }
  [data-dm-widget-skin="emberProtocol"]::after { inset: 0; background-image: radial-gradient(circle at 7% 14%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 94% 16%, color-mix(in srgb, var(--dmw-skin-secondary) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 3% 78%, color-mix(in srgb, var(--dmw-skin-accent) 74%, transparent) 0 2px, transparent 3.5px), radial-gradient(circle at 96% 84%, color-mix(in srgb, var(--dmw-skin-secondary) 74%, transparent) 0 2px, transparent 3.5px), radial-gradient(circle at 18% 95%, color-mix(in srgb, var(--dmw-skin-accent) 82%, transparent) 0 1.5px, transparent 3px), radial-gradient(circle at 81% 5%, color-mix(in srgb, var(--dmw-skin-secondary) 78%, transparent) 0 1.5px, transparent 3px), radial-gradient(ellipse at 0% 50%, color-mix(in srgb, var(--dmw-skin-accent) 16%, transparent), transparent 24%), radial-gradient(ellipse at 100% 50%, color-mix(in srgb, var(--dmw-skin-secondary) 14%, transparent), transparent 24%); mix-blend-mode: screen; animation: dm-widget-client-mothlight-dust 4.2s ease-in-out infinite reverse; }
[data-dm-widget-skin="cottonCandy"] { background-image: radial-gradient(ellipse at 8% 0%, color-mix(in srgb, var(--dmw-skin-accent) 29%, transparent), transparent 42%), radial-gradient(ellipse at 96% 104%, color-mix(in srgb, var(--dmw-skin-secondary) 36%, transparent), transparent 49%), linear-gradient(135deg, var(--dmw-skin-surface), #171b39 84%) !important; }
[data-dm-widget-skin="cottonCandy"]::before { background: linear-gradient(116deg, transparent 20%, color-mix(in srgb, var(--dmw-skin-accent) 15%, transparent) 36%, color-mix(in srgb, var(--dmw-skin-secondary) 18%, transparent) 55%, transparent 72%); filter: blur(4px); animation: dm-widget-client-ribbon 6s ease-in-out infinite alternate; }
[data-dm-widget-skin="cottonCandy"]::after { inset: -30% -22%; background: radial-gradient(ellipse at 35% 50%, color-mix(in srgb, var(--dmw-skin-accent) 22%, transparent), transparent 40%), radial-gradient(ellipse at 74% 50%, color-mix(in srgb, var(--dmw-skin-secondary) 21%, transparent), transparent 40%); filter: blur(13px); animation: dm-widget-client-ribbon 7s ease-in-out infinite alternate-reverse; }
[data-dm-widget-skin="frostedGlass"] { background-image: radial-gradient(ellipse at 0% 100%, rgba(216,243,255,.18), transparent 38%), radial-gradient(ellipse at 100% 0%, rgba(117,134,169,.22), transparent 34%), linear-gradient(135deg, #18283a 0%, rgba(18,26,37,.96) 52%, #202f46 100%) !important; backdrop-filter: blur(12px) saturate(1.25); }
[data-dm-widget-skin="frostedGlass"]::before { inset: 2px; border: 1px solid rgba(216,243,255,.28); background-image: linear-gradient(132deg, transparent 0 18%, rgba(216,243,255,.14) 19% 20%, transparent 21% 58%, rgba(216,243,255,.1) 59% 60%, transparent 61%), radial-gradient(ellipse at 0% 100%, rgba(216,243,255,.21), transparent 38%), radial-gradient(ellipse at 100% 0%, rgba(117,134,169,.22), transparent 34%), linear-gradient(0deg, rgba(255,255,255,.045), transparent); clip-path: polygon(0 0, 100% 0, 100% 100%, 83% 94%, 64% 100%, 45% 93%, 25% 100%, 0 91%); box-shadow: inset 0 0 0 3px rgba(216,243,255,.045), 0 0 15px rgba(216,243,255,.1); animation: dm-widget-client-ice-drift 8s ease-in-out infinite alternate; }
[data-dm-widget-skin="frostedGlass"]::after { inset: 0 auto 0 -34%; width: 28%; background: linear-gradient(90deg, transparent 0%, rgba(216,243,255,.04) 16%, rgba(255,255,255,.3) 44%, rgba(216,243,255,.14) 58%, rgba(255,255,255,.05) 76%, transparent 100%); filter: blur(.2px); will-change: transform, opacity; animation: dm-widget-client-glint 7.4s cubic-bezier(.22,.72,.3,1) infinite; }
  [data-dm-widget-skin="championRun"] { background-image: radial-gradient(ellipse at -4% 12%, color-mix(in srgb, var(--dmw-skin-accent) 46%, transparent), transparent 36%), radial-gradient(ellipse at 104% 90%, color-mix(in srgb, var(--dmw-skin-secondary) 28%, transparent), transparent 34%), linear-gradient(90deg, color-mix(in srgb, #5f0820 80%, transparent), transparent 18% 82%, color-mix(in srgb, #5f0820 74%, transparent)), repeating-linear-gradient(104deg, transparent 0 17px, color-mix(in srgb, var(--dmw-skin-accent) 5%, transparent) 18px 20px), radial-gradient(ellipse at 50% 100%, #260d1a, var(--dmw-skin-surface) 74%) !important; border-color: color-mix(in srgb, var(--dmw-skin-secondary) 64%, var(--dmw-skin-accent)) !important; }
  [data-dm-widget-skin="championRun"]::before { background-image: radial-gradient(ellipse at -4% 12%, color-mix(in srgb, var(--dmw-skin-accent) 56%, transparent), transparent 36%), radial-gradient(ellipse at 104% 90%, color-mix(in srgb, var(--dmw-skin-secondary) 34%, transparent), transparent 34%), linear-gradient(90deg, color-mix(in srgb, #5f0820 86%, transparent), transparent 18% 82%, color-mix(in srgb, #5f0820 78%, transparent)), repeating-linear-gradient(104deg, transparent 0 17px, color-mix(in srgb, var(--dmw-skin-accent) 6%, transparent) 18px 20px); animation: dm-widget-client-sanguine-velvet 7.2s ease-in-out infinite alternate; }
  [data-dm-widget-skin="championRun"]::after { inset: 0; background-image: radial-gradient(circle at 4% 12%, color-mix(in srgb, var(--dmw-skin-secondary) 88%, white) 0 2px, transparent 4px), radial-gradient(circle at 96% 86%, color-mix(in srgb, var(--dmw-skin-accent) 82%, transparent) 0 2px, transparent 4px), radial-gradient(circle at 8% 78%, color-mix(in srgb, var(--dmw-skin-accent) 72%, transparent) 0 1.5px, transparent 3px), radial-gradient(circle at 91% 22%, color-mix(in srgb, var(--dmw-skin-secondary) 74%, transparent) 0 1.5px, transparent 3px), radial-gradient(ellipse at 50% 100%, color-mix(in srgb, #7e092b 42%, transparent), transparent 58%); mix-blend-mode: screen; animation: dm-widget-client-sanguine-velvet 5.9s ease-in-out infinite reverse; }
[data-dm-widget-skin="deepSpace"] { background-image: radial-gradient(ellipse at 64% 58%, color-mix(in srgb, var(--dmw-skin-secondary) 13%, transparent), transparent 30%), radial-gradient(ellipse at 28% 14%, color-mix(in srgb, #707bff 16%, transparent), transparent 36%), linear-gradient(145deg, #060914 12%, #0c1530 61%, #050711) !important; }
[data-dm-widget-skin="deepSpace"]::before { background-image: radial-gradient(circle at 8% 18%, #f8fbff 0 1px, transparent 1.8px), radial-gradient(circle at 21% 72%, var(--dmw-skin-accent) 0 1px, transparent 1.8px), radial-gradient(circle at 34% 31%, #fff 0 1.3px, transparent 2px), radial-gradient(circle at 47% 82%, var(--dmw-skin-secondary) 0 1px, transparent 1.8px), radial-gradient(circle at 58% 16%, #dce6ff 0 1px, transparent 1.8px), radial-gradient(circle at 69% 56%, #fff 0 1.2px, transparent 2px), radial-gradient(circle at 82% 21%, var(--dmw-skin-secondary) 0 1px, transparent 1.8px), radial-gradient(circle at 93% 74%, var(--dmw-skin-accent) 0 1px, transparent 1.8px), radial-gradient(circle at 77% 90%, #fff 0 1px, transparent 1.7px); animation: dm-widget-client-starfield 7s ease-in-out infinite; }
[data-dm-widget-skin="deepSpace"]::after { inset: 4% -8% auto auto; width: 66%; aspect-ratio: 1; border: 1px solid color-mix(in srgb, var(--dmw-skin-secondary) 66%, transparent); border-radius: 50%; box-shadow: 0 0 22px color-mix(in srgb, var(--dmw-skin-secondary) 18%, transparent), 0 0 0 11px color-mix(in srgb, var(--dmw-skin-accent) 5%, transparent), inset 0 0 20px color-mix(in srgb, var(--dmw-skin-accent) 10%, transparent); background: conic-gradient(from 4deg, transparent 0 21deg, color-mix(in srgb, var(--dmw-skin-accent) 50%, transparent) 22deg 24deg, transparent 25deg 76deg, color-mix(in srgb, var(--dmw-skin-secondary) 48%, transparent) 77deg 80deg, transparent 81deg 142deg); -webkit-mask: radial-gradient(circle, transparent 0 54%, #000 55% 58%, transparent 59%); mask: radial-gradient(circle, transparent 0 54%, #000 55% 58%, transparent 59%); animation: dm-widget-client-night-orbit 22s linear infinite; }
[data-dm-widget-skin="voidBloom"] { background-image: radial-gradient(ellipse at 82% 18%, color-mix(in srgb, var(--dmw-skin-accent) 35%, transparent), transparent 33%), radial-gradient(ellipse at 88% 92%, color-mix(in srgb, var(--dmw-skin-secondary) 25%, transparent), transparent 42%), linear-gradient(135deg, #170e24, #101b2a 88%) !important; }
[data-dm-widget-skin="voidBloom"]::before { background-image: radial-gradient(ellipse at 8% 76%, rgba(115,62,165,.23), transparent 38%), radial-gradient(circle at 76% 20%, color-mix(in srgb, var(--dmw-skin-accent) 35%, transparent) 0 1px, transparent 2px), radial-gradient(circle at 88% 73%, color-mix(in srgb, var(--dmw-skin-secondary) 32%, transparent) 0 1px, transparent 2px); }
[data-dm-widget-skin="voidBloom"]::after { inset: 7% 5% auto auto; width: 40%; aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--dmw-skin-secondary) 35%, transparent), color-mix(in srgb, var(--dmw-skin-accent) 24%, transparent) 43%, transparent 72%); filter: blur(8px); animation: dm-widget-client-bloom 3.8s ease-in-out infinite; }
[data-dm-widget-skin="pixelOverdrive"] { background-image: radial-gradient(ellipse at 0% 0%, color-mix(in srgb, var(--dmw-skin-accent) 26%, transparent), transparent 32%), radial-gradient(ellipse at 100% 100%, color-mix(in srgb, var(--dmw-skin-secondary) 22%, transparent), transparent 32%), linear-gradient(116deg, #0c0d1a, #151327 54%, #0b101b 100%) !important; }
[data-dm-widget-skin="pixelOverdrive"]::before { inset: 3px; border: 1px solid color-mix(in srgb, var(--dmw-skin-accent) 64%, transparent); border-radius: 8px; background-image: linear-gradient(90deg, color-mix(in srgb, var(--dmw-skin-accent) 15%, transparent), transparent 14% 86%, color-mix(in srgb, var(--dmw-skin-secondary) 12%, transparent)), radial-gradient(ellipse at 0% 0%, color-mix(in srgb, var(--dmw-skin-accent) 24%, transparent), transparent 31%), radial-gradient(ellipse at 100% 100%, color-mix(in srgb, var(--dmw-skin-secondary) 21%, transparent), transparent 32%); box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--dmw-skin-secondary) 5%, transparent), 0 0 14px color-mix(in srgb, var(--dmw-skin-accent) 15%, transparent); animation: dm-widget-client-hunt-lights 3.1s ease-in-out infinite; }
[data-dm-widget-skin="pixelOverdrive"]::after { inset: 0; background-image: radial-gradient(circle at 7% 7%, color-mix(in srgb, var(--dmw-skin-secondary) 86%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 20% 5%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 35% 7%, color-mix(in srgb, var(--dmw-skin-secondary) 78%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 50% 4%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 66% 7%, color-mix(in srgb, var(--dmw-skin-secondary) 78%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 81% 5%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 94% 8%, color-mix(in srgb, var(--dmw-skin-secondary) 86%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 5% 93%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 19% 96%, color-mix(in srgb, var(--dmw-skin-secondary) 78%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 34% 94%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 50% 97%, color-mix(in srgb, var(--dmw-skin-secondary) 86%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 66% 94%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 82% 96%, color-mix(in srgb, var(--dmw-skin-secondary) 78%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 95% 91%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 3% 29%, color-mix(in srgb, var(--dmw-skin-secondary) 82%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 97% 30%, color-mix(in srgb, var(--dmw-skin-accent) 88%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 3% 52%, color-mix(in srgb, var(--dmw-skin-accent) 78%, white) 0 2px, transparent 3.5px), radial-gradient(circle at 97% 54%, color-mix(in srgb, var(--dmw-skin-secondary) 82%, white) 0 2px, transparent 3.5px), radial-gradient(ellipse at 0% 50%, color-mix(in srgb, var(--dmw-skin-accent) 18%, transparent), transparent 24%), radial-gradient(ellipse at 100% 50%, color-mix(in srgb, var(--dmw-skin-secondary) 16%, transparent), transparent 24%); mix-blend-mode: screen; animation: dm-widget-client-hunt-lights 3.1s steps(5, end) infinite reverse; }
[data-dm-widget-skin="solarFlare"] { background-image: radial-gradient(circle at 84% 18%, #fff2bf 0 6%, color-mix(in srgb, var(--dmw-skin-accent) 80%, transparent) 7% 12%, color-mix(in srgb, var(--dmw-skin-secondary) 28%, transparent) 13% 27%, transparent 40%), repeating-conic-gradient(from 0deg at 84% 18%, color-mix(in srgb, var(--dmw-skin-accent) 32%, transparent) 0deg 2deg, transparent 3deg 14deg), linear-gradient(152deg, #24100d 0 42%, color-mix(in srgb, var(--dmw-skin-secondary) 18%, transparent) 43% 55%, #351714 56% 72%, #160d13 73%) !important; }
[data-dm-widget-skin="solarFlare"]::before { background-image: radial-gradient(circle at 84% 18%, rgba(255,255,255,.72) 0 3%, transparent 4% 9%, color-mix(in srgb, var(--dmw-skin-accent) 24%, transparent) 10% 15%, transparent 16% 34%), repeating-conic-gradient(from 0deg at 84% 18%, color-mix(in srgb, var(--dmw-skin-accent) 28%, transparent) 0deg 2deg, transparent 3deg 14deg), linear-gradient(152deg, transparent 0 42%, color-mix(in srgb, var(--dmw-skin-secondary) 18%, transparent) 43% 55%, transparent 56%); clip-path: polygon(0 0, 100% 0, 100% 100%, 13% 100%, 21% 77%, 0 64%); }
[data-dm-widget-skin="solarFlare"]::after { inset: -61% -56%; background: repeating-conic-gradient(from 2deg at 50% 50%, transparent 0deg 8deg, color-mix(in srgb, var(--dmw-skin-accent) 46%, transparent) 9deg 12deg, transparent 13deg 22deg); -webkit-mask: radial-gradient(circle, transparent 27%, #000 34%, #000 54%, transparent 64%); mask: radial-gradient(circle, transparent 27%, #000 34%, #000 54%, transparent 64%); animation: dm-widget-client-sun-crown 23s linear infinite; }
[data-dm-widget-motion-paused="true"]::before, [data-dm-widget-motion-paused="true"]::after { animation-play-state: paused !important; }
`;

type WidgetSkinSnapshot = {
    attrs: Record<string, string | null>;
    vars: Record<string, { value: string; priority: string; }>;
};

const WIDGET_SKIN_ATTRS = [
    "data-dm-widget-skin",
    "data-dm-widget-frame",
    "data-dm-widget-ornament",
    "data-dm-widget-motion",
    "data-dm-widget-motion-paused",
    "data-dm-widget-app-id",
    "data-dm-widget-top-layout",
    "data-dm-widget-bottom-layout"
];
const WIDGET_SKIN_VARS = ["--dmw-skin-accent", "--dmw-skin-secondary", "--dmw-skin-surface"];
const widgetSkinRoots = new Map<HTMLElement, WidgetSkinSnapshot>();
const widgetApplicationCache = new WeakMap<HTMLElement, { appId: string | null; checkedAt: number; }>();
let widgetSkinStyleElement: HTMLStyleElement | null = null;
let widgetSkinObserver: MutationObserver | null = null;
let removeTournamentModeListener: (() => void) | null = null;
let widgetSkinTimer: number | null = null;
let widgetSkinFrame: number | null = null;
let widgetSkinRescanTimer: number | null = null;
let widgetSkinLastScanAt = 0;
let widgetSkinRun = 0;
// The local slot can outlive an app replacement or an account switch. Keep a
// second runtime map for the application IDs that Discord says are actually
// attached to the current profile board, then reconcile those IDs back to the
// slot's selected design before scanning visible cards.
const attachedWidgetStyles = new Map<string, WidgetStylePreset>();
const attachedWidgetSlots = new Map<string, string>();
let attachedWidgetRefreshAt = 0;
let attachedWidgetRefreshPromise: Promise<void> | null = null;
const ATTACHED_WIDGET_REFRESH_INTERVAL_MS = 30_000;

function selectedWidgetPreset(): WidgetStylePreset {
    return WIDGET_STYLE_PRESETS.find(item => item.id === String((settings.store as any).widgetStyle ?? ""))
        ?? WIDGET_STYLE_PRESETS[0];
}

function presetForSlot(slotKey: string): WidgetStylePreset {
    const slot = getSlot(slotKey);
    return WIDGET_STYLE_PRESETS.find(item => item.id === slot.widgetStyle)
        // If an update left the per-slot DataStore entry behind, the global
        // gallery selection is still a useful recovery style. This keeps a
        // published card visibly skinned instead of silently falling back to
        // plain Discord until the user opens the editor again.
        ?? selectedWidgetPreset();
}

function profileWidgetEntries(profile: any): any[] | null {
    const candidates = [
        profile?.widgets,
        profile?.user_profile?.widgets,
        profile?.user?.profile?.widgets,
        profile?.profile?.widgets,
        profile?.data?.widgets
    ];
    // Prefer a populated list when Discord exposes both a stale/empty
    // top-level field and the current nested profile field. Falling back to
    // an empty array is still useful for a genuine no-widgets response.
    return candidates.find((value) => Array.isArray(value) && value.length > 0)
      ?? candidates.find(Array.isArray)
      ?? null;
}

function profileWidgetApplicationId(widget: any): string {
    const candidates = [
        widget?.data?.application_id,
        widget?.data?.applicationId,
        widget?.application_id,
        widget?.applicationId,
        widget?.data?.application?.id,
        widget?.data?.application?.application_id,
        widget?.data?.application?.applicationId,
        widget?.application?.id,
        widget?.application?.application_id,
        widget?.application?.applicationId
    ];
    return candidates.map(value => String(value ?? "")).find(value => SNOWFLAKE.test(value)) ?? "";
}

function profileWidgetConfigId(widget: any): string {
    const candidates = [
        widget?.data?.config_id,
        widget?.data?.configId,
        widget?.config_id,
        widget?.configId,
        widget?.data?.application?.config_id,
        widget?.data?.application?.configId
    ];
    return candidates.map(value => String(value ?? "")).find(value => SNOWFLAKE.test(value)) ?? "";
}

function inferWidgetSlot(application: any, fallback: string): string {
    const name = String(application?.name ?? application?.description ?? "").toLowerCase();
    if (/valorant|^val(?:\s|$)|riot/.test(name)) return "valorant";
    if (/fortnite|^fort(?:\s|$)|epic/.test(name)) return "fortnite";
    // Unknown app names are custom cards. Falling back to the currently open
    // template used to put a recovered custom card into the Fortnite/Valorant
    // slot and made the editor look blank when the picker changed.
    // If Discord rejects application metadata, however, the current game
    // template is the only useful clue and lets an existing Val/Fort card
    // hydrate instead of forcing a duplicate create flow.
    if (!name && (fallback === "valorant" || fallback === "fortnite")) return fallback;
    return "none";
}

async function recoverAttachedWidgetIdentity(
    slotKey: string,
    appId: string,
    configIdHint = ""
): Promise<void> {
    if (!SNOWFLAKE.test(appId)) return;
    const current = getSlot(slotKey);
    // Never replace a different locally-known app in the same slot. A user can
    // have several cards on a board; only fill an empty slot or complete the
    // exact app that is already mapped to it.
    if (SNOWFLAKE.test(current.appId) && current.appId !== appId) return;

    let configId = SNOWFLAKE.test(configIdHint) ? configIdHint : current.configId;
    if (!SNOWFLAKE.test(configId)) {
        try {
            const list = await apiGet(`/applications/${appId}/widget-configs`);
            const arr: any[] = Array.isArray(list) ? list : list?.configs ?? [];
            const found = arr.map(item => String(item?.config_id ?? item?.configId ?? item?.id ?? ""))
                .find(value => SNOWFLAKE.test(value));
            if (found) configId = found;
        } catch { /* a private/pre-GA app may hide config metadata */ }
    }

    let heroAssetKey = current.heroAssetKey;
    if (!heroAssetKey) {
        try {
            const list = await apiGet(`/applications/${appId}/assets`);
            const arr: any[] = Array.isArray(list) ? list : list?.assets ?? [];
            heroAssetKey = arr.map(asset => String(asset?.key ?? asset?.name ?? ""))
                .find(value => value.startsWith("hero")) ?? "";
        } catch { /* republishConfig has its own best-effort asset recovery */ }
    }

    const next: WidgetIdentity = {
        ...current,
        appId,
        configId: configId || current.configId,
        heroAssetKey: heroAssetKey || current.heroAssetKey,
        widgetStyle: current.widgetStyle ?? selectedWidgetPreset().id
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) setSlot(slotKey, next);
}

async function refreshAttachedWidgetStyles(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - attachedWidgetRefreshAt < ATTACHED_WIDGET_REFRESH_INTERVAL_MS) return;
    if (attachedWidgetRefreshPromise) return attachedWidgetRefreshPromise;
    attachedWidgetRefreshAt = now;
    const task = (async () => {
        await ensureSlots();
        const me = UserStore.getCurrentUser();
        if (!me?.id) return;
        const profile = await apiGet(`/users/${me.id}/profile`);
        const widgets = profileWidgetEntries(profile);
        if (!widgets) {
            console.warn("[DMWidget] profile widget list missing; keeping the last attached skin map");
            return;
        }
        const entries = widgets
            .map(widget => ({ widget, appId: profileWidgetApplicationId(widget), configId: profileWidgetConfigId(widget) }))
            .filter(entry => SNOWFLAKE.test(entry.appId));
        const ids: string[] = Array.from(new Set<string>(entries.map(entry => entry.appId)));
        const stored = new Map<string, string>();
        for (const [slotKey, identity] of Object.entries(slots.get())) {
            if (SNOWFLAKE.test(identity.appId)) stored.set(identity.appId, slotKey);
        }
        const nextStyles = new Map<string, WidgetStylePreset>();
        const nextSlots = new Map<string, string>();
        for (const appId of ids) {
            let slotKey = stored.get(appId) ?? "";
            let application: any = null;
            if (!slotKey) {
                try { application = await apiGet(`/applications/${appId}`); } catch { /* a private app may reject metadata */ }
                slotKey = inferWidgetSlot(application, slotKeyOf());
            }
            const entry = entries.find(item => item.appId === appId);
            await recoverAttachedWidgetIdentity(slotKey, appId, entry?.configId ?? "");
            nextSlots.set(appId, slotKey);
            nextStyles.set(appId, presetForSlot(slotKey));
        }
        attachedWidgetStyles.clear();
        attachedWidgetSlots.clear();
        for (const [appId, preset] of nextStyles) attachedWidgetStyles.set(appId, preset);
        for (const [appId, slotKey] of nextSlots) attachedWidgetSlots.set(appId, slotKey);
    })();
    attachedWidgetRefreshPromise = task;
    try {
        await task;
    } catch (error) {
        console.warn("[DMWidget] attached profile widget reconciliation failed:", error);
    } finally {
        if (attachedWidgetRefreshPromise === task) attachedWidgetRefreshPromise = null;
    }
    scheduleWidgetSkinScan();
}

function updateAttachedWidgetStylesForSlot(slotKey: string, preset: WidgetStylePreset): void {
    for (const [appId, attachedSlot] of attachedWidgetSlots) {
        if (attachedSlot === slotKey) attachedWidgetStyles.set(appId, preset);
    }
    const currentId = getSlot(slotKey).appId;
    if (SNOWFLAKE.test(currentId)) attachedWidgetStyles.set(currentId, preset);
}

function knownWidgetStyles(): Map<string, WidgetStylePreset> {
    const out = new Map<string, WidgetStylePreset>();
    for (const [appId, preset] of attachedWidgetStyles) out.set(appId, preset);
    for (const [slotKey, identity] of Object.entries(slots.get())) {
        if (!SNOWFLAKE.test(identity.appId)) continue;
        const preset = WIDGET_STYLE_PRESETS.find(item => item.id === identity.widgetStyle) ?? WIDGET_STYLE_PRESETS[0];
        // The reconciled profile map knows which app is actually attached and
        // can carry the gallery fallback after an update. Do not overwrite it
        // with an older slot default.
        if (!out.has(identity.appId)) out.set(identity.appId, preset);
        // Keep the slot key in the attribute contract for diagnostics without
        // adding another style rule; app IDs remain the source of truth.
        void slotKey;
    }
    return out;
}

const WIDGET_APPLICATION_ID_ATTRIBUTES = [
    "data-application-id",
    "data-application_id",
    "data-app-id",
    "data-app_id",
    "application-id",
    "application_id"
];

// The full profile Board sometimes keeps the application id in a plain DOM
// attribute instead of the shallow React props attached to the compact card.
// Inspect only the candidate subtree and only return ids that belong to a
// widget attached to this account; this remains safe even when the selector is
// deliberately broad below.
function domApplicationId(element: Element, known: Set<string>): string | null {
    const nodes: Element[] = [element];
    try { nodes.push(...Array.from(element.querySelectorAll("*")).slice(0, 320)); } catch { /* ignore malformed/tearing DOM */ }
    for (const node of nodes) {
        for (const attribute of WIDGET_APPLICATION_ID_ATTRIBUTES) {
            const value = node.getAttribute(attribute);
            if (value && known.has(value)) return value;
        }
        const id = node.getAttribute("id");
        if (id && known.has(id)) return id;
    }
    // A few Board wrappers expose the id only in an aria/data payload. Keep
    // this bounded so a large profile surface cannot turn a scan into a full
    // document walk.
    try {
        const html = element.outerHTML.slice(0, 80_000);
        for (const appId of known) if (html.includes(appId)) return appId;
    } catch { /* ignore transient detached nodes */ }
    return null;
}

function reactApplicationId(element: Element, known: Set<string>): string | null {
    const roots = Object.keys(element).filter(key => key.startsWith("__reactFiber") || key.startsWith("__reactProps"));
    const seen = new WeakSet<object>();
    const queue: Array<{ value: any; depth: number; hint: string; }> = roots.map(key => ({ value: (element as any)[key], depth: 0, hint: key }));
    let budget = 6000;
    while (queue.length && budget-- > 0) {
        const item = queue.shift()!;
        const value = item.value;
        if (!value || (typeof value !== "object" && typeof value !== "function") || item.depth > 24) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        let keys: string[];
        try { keys = Object.keys(value).slice(0, 90); } catch { continue; }
        keys.sort((a, b) => {
            const rank = (key: string) => /application|activity|pendingProps|memoizedProps|props|return|child/i.test(key) ? 0 : 1;
            return rank(a) - rank(b);
        });
        for (const key of keys) {
            let child: any;
            try { child = value[key]; } catch { continue; }
            const lower = key.toLowerCase();
            if ((lower === "applicationid" || lower === "application_id" || lower === "appid" || lower === "app_id") && typeof child === "string" && known.has(child)) return child;
            if (lower === "application" && child && typeof child === "object" && typeof child.id === "string" && known.has(child.id)) return child.id;
            if (lower === "activity" && child && typeof child === "object" && typeof child.application_id === "string" && known.has(child.application_id)) return child.application_id;
            if (child && (typeof child === "object" || typeof child === "function")) queue.push({ value: child, depth: item.depth + 1, hint: key });
        }
    }
    return null;
}

// Discord reuses the same widget card component in three places: the small
// profile popout, the right-hand profile sidebar, and the full Board/profile
// view. The latter has changed class names and wrapper roles several times;
// keep the selector broad, then use the known attached application id as the
// safety filter so ordinary activity cards are never skinned by accident.
const WIDGET_CARD_SELECTOR = [
    '[class*="card__"]',
    '[class*="card_"]',
    '[class*="widget"]',
    '[class*="Widget"]',
    '[class*="application"]',
    '[class*="Application"]',
    '[class*="cardsList"] [role="button"]',
    '[class*="cardsList"] > li > div',
    '[class*="profile"] [role="listitem"]',
    '[class*="profile"] article',
    'li[role="listitem"]'
].join(",");
const WIDGET_MUTATION_SELECTOR = [
    ...WIDGET_APPLICATION_ID_ATTRIBUTES.map(attribute => `[${attribute}]`),
    WIDGET_CARD_SELECTOR
].join(",");

function widgetApplicationId(element: HTMLElement, known: Set<string>): string | null {
    const now = Date.now();
    const cached = widgetApplicationCache.get(element);
    // React props are expensive to walk. Keep successful lookups longer and
    // negative lookups for the duration of the normal reconciliation window so
    // unrelated Discord updates do not repeatedly inspect the same card tree.
    const cacheTtl = cached?.appId ? 5000 : 2600;
    if (cached && now - cached.checkedAt < cacheTtl)
        return cached.appId && known.has(cached.appId) ? cached.appId : null;
    const remember = (appId: string | null, related?: HTMLElement): string | null => {
        const value = { appId, checkedAt: now };
        widgetApplicationCache.set(element, value);
        if (related && related !== element) widgetApplicationCache.set(related, value);
        return appId;
    };
    // Prefer the visible card. The DOM fallback covers the full Board's
    // application wrapper, where Discord may not expose the id on the first
    // React host node at all.
    const directReactId = reactApplicationId(element, known);
    if (directReactId) return remember(directReactId);
    const directDomId = domApplicationId(element, known);
    if (directDomId) return remember(directDomId);
    let current: HTMLElement | null = element;
    for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
        const appId = reactApplicationId(current, known) ?? domApplicationId(current, known);
        if (appId) return remember(appId, current);
    }
    return remember(null);
}

function restoreWidgetSkin(root: HTMLElement): void {
    const snapshot = widgetSkinRoots.get(root);
    if (!snapshot) return;
    for (const attr of WIDGET_SKIN_ATTRS) {
        const value = snapshot.attrs[attr];
        if (value === null) root.removeAttribute(attr); else root.setAttribute(attr, value);
    }
    for (const name of WIDGET_SKIN_VARS) {
        const value = snapshot.vars[name];
        if (!value.value) root.style.removeProperty(name); else root.style.setProperty(name, value.value, value.priority);
    }
    widgetSkinRoots.delete(root);
}

function applyWidgetSkin(root: HTMLElement, preset: WidgetStylePreset, appId: string): void {
    if (!widgetSkinRoots.has(root)) {
        const attrs: Record<string, string | null> = {};
        const vars: Record<string, { value: string; priority: string; }> = {};
        for (const attr of WIDGET_SKIN_ATTRS) attrs[attr] = root.getAttribute(attr);
        for (const name of WIDGET_SKIN_VARS) vars[name] = { value: root.style.getPropertyValue(name), priority: root.style.getPropertyPriority(name) };
        widgetSkinRoots.set(root, { attrs, vars });
    }
    root.dataset.dmWidgetSkin = preset.id;
    root.dataset.dmWidgetFrame = preset.frame;
    root.dataset.dmWidgetOrnament = preset.ornament;
    root.dataset.dmWidgetMotion = preset.motion;
    root.dataset.dmWidgetMotionPaused = isWidgetPreviewMotionPaused() ? "true" : "false";
    root.dataset.dmWidgetAppId = appId;
    root.dataset.dmWidgetTopLayout = preset.topLayout;
    root.dataset.dmWidgetBottomLayout = preset.bottomLayout;
    root.style.setProperty("--dmw-skin-accent", preset.accent);
    root.style.setProperty("--dmw-skin-secondary", preset.secondary);
    root.style.setProperty("--dmw-skin-surface", preset.surface);
}

function scanWidgetSkinCards(): void {
    if (!document.body) return;
    const active = knownWidgetStyles();
    const seen = new Set<HTMLElement>();
    if (active.size) {
        const known = new Set(active.keys());
        // Put explicit application-id hosts first, then use the broad fallback
        // only for Discord's full Board cards whose id is hidden in React. A
        // bounded list protects the main renderer from turning a skin refresh
        // into a page-wide React tree walk.
        const candidateSet = new Set<HTMLElement>();
        const explicitSelector = WIDGET_APPLICATION_ID_ATTRIBUTES.map(attribute => `[${attribute}]`).join(",");
        for (const candidate of Array.from(document.querySelectorAll<HTMLElement>(explicitSelector)).slice(0, 180)) candidateSet.add(candidate);
        for (const candidate of Array.from(document.querySelectorAll<HTMLElement>(WIDGET_CARD_SELECTOR)).slice(0, 540)) candidateSet.add(candidate);
        for (const candidate of Array.from(candidateSet).slice(0, 640)) {
            const appId = widgetApplicationId(candidate, known);
            const preset = appId ? active.get(appId) : undefined;
            if (!preset) continue;
            const rect = candidate.getBoundingClientRect();
            if (rect.width < 20 || rect.height < 12) continue;
            seen.add(candidate);
            applyWidgetSkin(candidate, preset, appId!);
        }
    }
    for (const root of Array.from(widgetSkinRoots.keys())) {
        if (!seen.has(root) || !root.isConnected) restoreWidgetSkin(root);
    }
}

function scheduleWidgetSkinScan(): void {
    if (document.hidden || widgetSkinTimer !== null || widgetSkinFrame !== null) return;
    const delay = Math.max(120, widgetSkinLastScanAt + 500 - Date.now());
    widgetSkinTimer = window.setTimeout(() => {
        widgetSkinTimer = null;
        if (document.hidden) return;
        widgetSkinFrame = window.requestAnimationFrame(() => {
            widgetSkinFrame = null;
            if (!document.hidden) {
                widgetSkinLastScanAt = Date.now();
                scanWidgetSkinCards();
            }
        });
    }, delay);
}

function widgetSkinMutationRelevant(records: MutationRecord[]): boolean {
    for (const record of records) {
        if (record.type !== "childList") continue;
        for (const node of Array.from(record.addedNodes).slice(0, 16)) {
            if (!(node instanceof Element)) continue;
            try {
                if (node.matches(WIDGET_MUTATION_SELECTOR) || node.querySelector(WIDGET_MUTATION_SELECTOR)) return true;
            } catch { /* ignore a tearing/partially-mounted Discord subtree */ }
        }
    }
    return false;
}

function startWidgetSkinRenderer(): void {
    if (widgetSkinStyleElement) return;
    widgetSkinRun++;
    const run = widgetSkinRun;
    widgetSkinStyleElement = document.createElement("style");
    widgetSkinStyleElement.id = "dm-widget-client-skins";
    widgetSkinStyleElement.textContent = WIDGET_CLIENT_SKIN_CSS;
    (document.head || document.documentElement).appendChild(widgetSkinStyleElement);
    document.addEventListener("visibilitychange", onWidgetSkinVisibilityChange);
    const onTournamentModeChanged = () => scheduleWidgetSkinScan();
    window.addEventListener("discordmaxxer:tournament-mode-changed", onTournamentModeChanged);
    removeTournamentModeListener = () => window.removeEventListener("discordmaxxer:tournament-mode-changed", onTournamentModeChanged);
    const attach = () => {
        if (run !== widgetSkinRun || !document.body || widgetSkinObserver) return;
        widgetSkinObserver = new MutationObserver(records => {
            if (widgetSkinMutationRelevant(records)) scheduleWidgetSkinScan();
        });
        widgetSkinObserver.observe(document.body, { childList: true, subtree: true });
        scheduleWidgetSkinScan();
        widgetSkinRescanTimer = window.setInterval(() => scheduleWidgetSkinScan(), 5000);
    };
    if (document.body) attach(); else window.setTimeout(attach, 0);
}

function stopWidgetSkinRenderer(): void {
    widgetSkinRun++;
    document.removeEventListener("visibilitychange", onWidgetSkinVisibilityChange);
    removeTournamentModeListener?.();
    removeTournamentModeListener = null;
    widgetSkinObserver?.disconnect();
    widgetSkinObserver = null;
    if (widgetSkinTimer !== null) { clearTimeout(widgetSkinTimer); widgetSkinTimer = null; }
    if (widgetSkinFrame !== null) { window.cancelAnimationFrame(widgetSkinFrame); widgetSkinFrame = null; }
    if (widgetSkinRescanTimer !== null) { clearInterval(widgetSkinRescanTimer); widgetSkinRescanTimer = null; }
    widgetSkinLastScanAt = 0;
    for (const root of Array.from(widgetSkinRoots.keys())) restoreWidgetSkin(root);
    attachedWidgetStyles.clear();
    attachedWidgetSlots.clear();
    attachedWidgetRefreshAt = 0;
    widgetSkinStyleElement?.remove();
    widgetSkinStyleElement = null;
}

function onWidgetSkinVisibilityChange(): void {
    if (!document.hidden) scheduleWidgetSkinScan();
}

function isWidgetPreviewMotionPaused(): boolean {
    const runtime = (globalThis as any).__dmTournamentModeActive;
    if (typeof runtime === "boolean") return runtime;
    return (globalThis as any).Vencord?.PlainSettings?.plugins?.TournamentMode?.manuallyActive === true;
}

function splitWidgetStat(raw: string): { label: string; value: string; } | null {
    const clean = String(raw ?? "").trim();
    if (!clean) return null;
    const divider = clean.indexOf("|");
    return divider < 0
        ? { label: "", value: clean }
        : { label: clean.slice(0, divider).trim(), value: clean.slice(divider + 1).trim() };
}

function WidgetStylePicker() {
    const [, force] = React.useState(0);
    const [previewSize, setPreviewSize] = React.useState<"compact" | "expanded">("compact");
    const [localHero, setLocalHero] = React.useState<{ slotKey: string; url: string; name: string; } | null>(null);
    const [imageError, setImageError] = React.useState("");
    const imageInput = React.useRef<HTMLInputElement>(null);
    const localHeroUrl = React.useRef("");
    const live = settings.use([
        "gameTemplate", "widgetStyle", "topLayout", "bottomLayout", "appName", "widgetTitle", "heroImageUrl",
        "fnHeroPreset", "fnIgn", "fnUnrealRank", "fnEarnings", "fnTopPlacement", "fnChapterSeason",
        "valHeroPreset", "valRiotId", "stat1", "stat2", "stat3", "stat4", "stat5", "stat6",
        "progressLabel", "progressPercent"
    ]);
    const template = String(live.gameTemplate ?? "none") || "none";
    const initialSlotKey = React.useRef(template).current;
    const initialStyle = React.useRef(String((settings.store as any).widgetStyle ?? "neonCircuit")).current;
    const initialTopLayout = React.useRef(String((settings.store as any).topLayout ?? "hero")).current;
    const initialBottomLayout = React.useRef(String((settings.store as any).bottomLayout ?? "stats")).current;
    const [tournamentPaused, setTournamentPaused] = React.useState(isWidgetPreviewMotionPaused());
    React.useEffect(() => {
        const timer = setInterval(() => {
            const next = isWidgetPreviewMotionPaused();
            setTournamentPaused(current => current === next ? current : next);
        }, 750);
        return () => clearInterval(timer);
    }, []);

    React.useEffect(() => {
        let active = true;
        if (localHeroUrl.current) URL.revokeObjectURL(localHeroUrl.current);
        localHeroUrl.current = "";
        setLocalHero(null);
        void ensureSlots().then(() => refreshAttachedWidgetStyles(true)).then(async () => {
            const slot = getSlot(template);
            const initial = template === initialSlotKey;
            const preset = WIDGET_STYLE_PRESETS.find(item => item.id === slot.widgetStyle)
                ?? (initial ? WIDGET_STYLE_PRESETS.find(item => item.id === initialStyle) : undefined)
                ?? WIDGET_STYLE_PRESETS[0];
            const topLayout = slot.topLayout ?? (initial && (initialTopLayout === "hero" || initialTopLayout === "contained") ? initialTopLayout : preset.topLayout);
            const bottomLayout = slot.bottomLayout ?? (initial && (initialBottomLayout === "stats" || initialBottomLayout === "progress") ? initialBottomLayout : preset.bottomLayout);
            const next = { ...slot, widgetStyle: preset.id, topLayout, bottomLayout };
            if (slot.widgetStyle !== next.widgetStyle || slot.topLayout !== next.topLayout || slot.bottomLayout !== next.bottomLayout) setSlot(template, next);
            const store = settings.store as any;
            store.widgetStyle = preset.id;
            store.topLayout = topLayout;
            store.bottomLayout = bottomLayout;
            const file = await getLocalWidgetImage(template);
            if (!active) return;
            if (file) {
                const url = URL.createObjectURL(file);
                localHeroUrl.current = url;
                setLocalHero({ slotKey: template, url, name: file.name });
            }
            force(value => value + 1);
        }).catch(e => console.warn("[DMWidget] could not restore this slot's style or image:", e));
        return () => {
            active = false;
            if (localHeroUrl.current) URL.revokeObjectURL(localHeroUrl.current);
            localHeroUrl.current = "";
        };
    }, [template]);

    const slot = getSlot(template);
    const fallbackStyle = template === initialSlotKey ? initialStyle : "neonCircuit";
    const selected = WIDGET_STYLE_PRESETS.find(preset => preset.id === slot.widgetStyle)
        ?? WIDGET_STYLE_PRESETS.find(preset => preset.id === fallbackStyle)
        ?? WIDGET_STYLE_PRESETS[0];
    const topLayout = live.topLayout === "contained" ? "contained" : live.topLayout === "hero" ? "hero" : slot.topLayout ?? selected.topLayout;
    const bottomLayout = live.bottomLayout === "progress" ? "progress" : live.bottomLayout === "stats" ? "stats" : slot.bottomLayout ?? selected.bottomLayout;
    const previewHero = localHero?.slotKey === template ? localHero.url : heroUrlFor(template, slot);
    const title = template === "fortnite"
        ? (String(live.fnIgn ?? "").trim() || "Fortnite")
        : template === "valorant"
            ? (String(live.valRiotId ?? "").trim().split("#")[0] || "Valorant")
            : (String(live.widgetTitle ?? "").trim() || "My Widget");
    const header = template === "fortnite"
        ? (String(live.fnChapterSeason ?? "").trim() ? `Fort · ${String(live.fnChapterSeason).trim()}` : "Fort")
        : template === "valorant" ? "Val" : (String(live.appName ?? "").trim() || "My Widget");
    const rawStats = template === "fortnite" ? fortniteStatLines()
        : template === "valorant" ? valorantStatLines()
            : [1, 2, 3, 4, 5, 6].map(i => String((live as any)[`stat${i}`] ?? ""));
    const statRows = rawStats.map(splitWidgetStat).filter((row): row is { label: string; value: string; } => !!row).slice(0, 6);
    const progressLabel = String(live.progressLabel ?? "Level 1").trim() || "Progress";
    const progressPercent = Math.max(0, Math.min(100, Number(live.progressPercent ?? 50)));

    const selectStyleTarget = (slotKey: string) => {
        const targetSlot = getSlot(slotKey);
        const targetPreset = WIDGET_STYLE_PRESETS.find(item => item.id === targetSlot.widgetStyle) ?? WIDGET_STYLE_PRESETS[0];
        const store = settings.store as any;
        // Game template remains the canonical editor target. Mirroring the
        // target's saved style here also makes the preview and Create/Update
        // respond in the same click, without waiting for the restore effect.
        store.gameTemplate = slotKey;
        store.widgetStyle = targetPreset.id;
        store.topLayout = targetSlot.topLayout ?? targetPreset.topLayout;
        store.bottomLayout = targetSlot.bottomLayout ?? targetPreset.bottomLayout;
        force(value => value + 1);
    };

    const choose = (preset: WidgetStylePreset) => {
        const store = settings.store as any;
        const current = getSlot(template);
        // Keep the preset's complete design contract in the durable slot. Game
        // cards still publish Discord's supported stats schema, but the local
        // Discordmaxxer card keeps the selected preset's progress/stats intent
        // so switching templates never silently strips an attribute.
        const nextBottomLayout = preset.bottomLayout;
        setSlot(template, { ...current, widgetStyle: preset.id, topLayout: preset.topLayout, bottomLayout: nextBottomLayout });
        store.widgetStyle = preset.id;
        store.topLayout = preset.topLayout;
        store.bottomLayout = nextBottomLayout;
        force(value => value + 1);
        updateAttachedWidgetStylesForSlot(template, preset);
        scheduleWidgetSkinScan();
        void refreshAttachedWidgetStyles(true);
        void republishSelectedWidgetStyle(template);
    };

    const installLocalPreview = (file: File) => {
        if (localHeroUrl.current) URL.revokeObjectURL(localHeroUrl.current);
        const url = URL.createObjectURL(file);
        localHeroUrl.current = url;
        setLocalHero({ slotKey: template, url, name: file.name });
    };

    const chooseLocalImage = async (file?: File) => {
        if (!file) return;
        setImageError("");
        try {
            await saveLocalWidgetImage(template, file);
            installLocalPreview(file);
            toast("Image saved on this PC. Press Create/Update to upload it to your widget app; choosing a file does not publish anything.", Toasts.Type.SUCCESS, 6500);
        } catch (e) {
            const message = e instanceof Error ? e.message : "Couldn't save that image file.";
            setImageError(message);
            toast(message, Toasts.Type.FAILURE, 5000);
        }
    };

    const clearLocalImage = async () => {
        setImageError("");
        try {
            await removeLocalWidgetImage(template);
            if (localHeroUrl.current) URL.revokeObjectURL(localHeroUrl.current);
            localHeroUrl.current = "";
            setLocalHero(null);
            force(value => value + 1);
        } catch (e) {
            const message = e instanceof Error ? e.message : "Couldn't remove the saved local image.";
            setImageError(message);
        }
    };

    const themeVars = {
        "--dmw-accent": selected.accent,
        "--dmw-secondary": selected.secondary,
        "--dmw-surface": selected.surface,
        "--dmw-glow": `${selected.accent}42`
    } as any;

    return (
        <div style={{ margin: "8px 0 12px", padding: 14, border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, background: "linear-gradient(145deg, rgba(255,255,255,.045), rgba(255,255,255,.015))", color: "#f2f3f5" }}>
            <style>{WIDGET_PREVIEW_MOTION_CSS}</style>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".01em" }}>✦ Choose a widget skin</div>
                <span style={{ fontSize: 11, color: selected.accent }}>{SLOT_LABEL[template] ?? template} · {selected.name}</span>
            </div>
            <div style={{ margin: "10px 0 12px", padding: 10, borderRadius: 9, border: "1px solid rgba(255,255,255,.12)", background: "rgba(0,0,0,.14)" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: "#f2f3f5" }}>Style each widget independently</span>
                    <span style={{ fontSize: 10, color: "#aeb5c5" }}>Styling: {SLOT_LABEL[template] ?? template}</span>
                </div>
                <div style={{ marginTop: 3, fontSize: 10.5, lineHeight: 1.35, color: "#aeb5c5" }}>
                    Pick a widget here, then choose a skin below. Valorant, Fortnite, and Custom keep separate choices, so changing one will not restyle the others.
                </div>
                <div role="group" aria-label="Choose which widget to style" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))", gap: 6, marginTop: 8 }}>
                    {WIDGET_STYLE_SLOT_KEYS.map(slotKey => {
                        const targetSlot = getSlot(slotKey);
                        const targetPreset = WIDGET_STYLE_PRESETS.find(item => item.id === targetSlot.widgetStyle) ?? WIDGET_STYLE_PRESETS[0];
                        const isTarget = template === slotKey;
                        const isPublished = SNOWFLAKE.test(targetSlot.appId);
                        return (
                            <button
                                key={slotKey}
                                type="button"
                                aria-pressed={isTarget}
                                aria-label={`Style ${SLOT_LABEL[slotKey] ?? slotKey} widget`}
                                onClick={() => selectStyleTarget(slotKey)}
                                style={{
                                    minWidth: 0, padding: "7px 8px", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
                                    textAlign: "left", borderRadius: 7, border: `1px solid ${isTarget ? targetPreset.accent : "rgba(255,255,255,.13)"}`,
                                    background: isTarget ? `linear-gradient(135deg, ${targetPreset.accent}20, rgba(255,255,255,.035))` : "rgba(255,255,255,.025)",
                                    color: "#f2f3f5", cursor: "pointer", boxShadow: isTarget ? `0 0 0 1px ${targetPreset.accent}33` : "none"
                                }}
                            >
                                <span style={{ width: "100%", display: "flex", justifyContent: "space-between", gap: 5, alignItems: "center" }}>
                                    <span style={{ fontSize: 10.5, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{isTarget ? "✓ " : ""}{SLOT_LABEL[slotKey] ?? slotKey}</span>
                                    <span style={{ flex: "0 0 auto", width: 7, height: 7, borderRadius: "50%", background: targetPreset.accent, boxShadow: `0 0 8px ${targetPreset.accent}99` }} aria-hidden="true" />
                                </span>
                                <span style={{ maxWidth: "100%", fontSize: 9.5, color: targetPreset.accent, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{targetPreset.name}</span>
                                <span style={{ fontSize: 9, color: "#aeb5c5" }}>{isPublished ? "Published widget" : "Ready to create"}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            <div style={{ margin: "5px 0 12px", fontSize: 11.5, lineHeight: 1.45, color: "#c5c9d4" }}>
                Nine art-directed skins bring their own geometry, frame, ornament, palette, and motion. Select one and the real Discordmaxxer widget card updates immediately; Create/Update also republishes the supported Discord layout and image fields. Vanilla Discord can receive the card content, but cannot render client-only CSS effects.
            </div>
            <div role="group" aria-label="Choose a profile widget style" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 8, marginBottom: 12 }}>
                {WIDGET_STYLE_PRESETS.map(preset => {
                    const isActive = selected.id === preset.id;
                    const displayedBottomLayout = preset.bottomLayout;
                    return (
                        <button
                            key={preset.id}
                            className="dm-widget-style-choice"
                            type="button"
                            aria-pressed={isActive}
                            title={`${preset.name}: ${preset.mood}`}
                            onClick={() => choose(preset)}
                            style={{
                                minHeight: 120, padding: "8px 9px", display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "space-between", gap: 6,
                                textAlign: "left", borderRadius: 9, border: `1px solid ${isActive ? preset.accent : "rgba(255,255,255,.13)"}`,
                                background: preset.surface,
                                color: "#f2f3f5", cursor: "pointer",
                                boxShadow: isActive ? `0 0 0 1px ${preset.accent}55, 0 8px 24px ${preset.accent}28` : "none",
                                transition: "border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease"
                            }}
                        >
                            <span style={{ position: "relative", zIndex: 1, display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }}>
                                <span style={{ fontSize: 16, color: preset.accent }}>{preset.glyph}</span>
                                <span style={{ fontSize: 9, color: preset.accent }}>{preset.topLayout.toUpperCase()} · {displayedBottomLayout.toUpperCase()}</span>
                            </span>
                            <div className="dm-widget-style-swatch" data-style={preset.id} data-motion={preset.motion} data-motion-paused={tournamentPaused ? "true" : "false"} data-frame={preset.frame} data-ornament={preset.ornament} aria-hidden="true" style={{ height: 42, overflow: "hidden", padding: 5, borderRadius: 6, border: `1px solid ${preset.accent}4c`, background: preset.surface }}>
                                <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 5, height: 19 }}>
                                    {preset.topLayout === "contained" && <span style={{ width: 16, height: 16, borderRadius: 3, background: `linear-gradient(145deg, ${preset.accent}b0, ${preset.secondary}8c)` }} />}
                                    <span style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", height: 3, width: "48%", borderRadius: 4, background: preset.accent }} /><span style={{ display: "block", height: 3, width: "72%", marginTop: 4, borderRadius: 4, background: "rgba(255,255,255,.24)" }} /></span>
                                    {preset.topLayout === "hero" && <span style={{ width: 22, height: 18, borderRadius: 3, background: `linear-gradient(135deg, ${preset.accent}b0, ${preset.secondary}8c)` }} />}
                                </div>
                                {displayedBottomLayout === "progress" ? <div style={{ position: "relative", zIndex: 1, height: 3, marginTop: 4, borderRadius: 5, background: `linear-gradient(90deg, ${preset.accent} 65%, rgba(255,255,255,.16) 65%)` }} /> : <div style={{ position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, marginTop: 3 }}><span style={{ height: 3, background: `${preset.accent}99`, borderRadius: 4 }} /><span style={{ height: 3, background: "rgba(255,255,255,.24)", borderRadius: 4 }} /><span style={{ height: 3, background: "rgba(255,255,255,.24)", borderRadius: 4 }} /><span style={{ height: 3, background: `${preset.secondary}99`, borderRadius: 4 }} /></div>}
                            </div>
                            <span style={{ position: "relative", zIndex: 1, fontSize: 11.5, fontWeight: 800, lineHeight: 1.2 }}>{isActive ? "✓ " : ""}{preset.name}</span>
                            <span style={{ position: "relative", zIndex: 1, fontSize: 9.5, lineHeight: 1.2, color: "#c5c9d4" }}>{preset.mood}</span>
                        </button>
                    );
                })}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, fontWeight: 750, letterSpacing: ".08em", textTransform: "uppercase", color: "#c5c9d4" }}>Live preview</span>
                <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#a8adba", marginRight: 3 }}>Preview size</span>
                    {(["compact", "expanded"] as const).map(size => <button key={size} type="button" aria-pressed={previewSize === size} onClick={() => setPreviewSize(size)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${previewSize === size ? selected.accent : "rgba(255,255,255,.18)"}`, background: previewSize === size ? `${selected.accent}20` : "transparent", color: previewSize === size ? selected.accent : "#c5c9d4", cursor: "pointer", fontSize: 10 }}>{size === "compact" ? "Compact" : "Expanded"}</button>)}
                </span>
            </div>
            <div
                className="dm-widget-style-preview"
                data-style={selected.id}
                data-motion={selected.motion}
                data-motion-paused={tournamentPaused ? "true" : "false"}
                data-frame={selected.frame}
                data-ornament={selected.ornament}
                style={{
                    ...themeVars,
                    position: "relative", overflow: "hidden", width: "100%", maxWidth: previewSize === "compact" ? 340 : 520, minHeight: previewSize === "compact" ? 132 : 174, boxSizing: "border-box", padding: previewSize === "compact" ? 10 : 13,
                    borderRadius: 10, border: `1px solid ${selected.accent}72`,
                    background: `radial-gradient(ellipse at 92% 0%, ${selected.secondary}38, transparent 48%), linear-gradient(135deg, ${selected.surface}, #171922 78%)`,
                    boxShadow: `0 0 0 1px ${selected.accent}20, 0 10px 34px ${selected.accent}28, inset 0 0 28px ${selected.accent}12`, isolation: "isolate"
                }}
                aria-label={`${selected.name} widget preview`}
            >
                <div style={{ position: "relative", zIndex: 1, fontSize: 10, fontWeight: 750, letterSpacing: ".09em", textTransform: "uppercase", color: selected.accent, marginBottom: 9 }}>{header}</div>
                {topLayout === "hero" ? (
                    <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 66 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 18, fontWeight: 850, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#f4f6fb" }}>{title}</div>
                            <div style={{ marginTop: 5, fontSize: 10, color: "#aeb5c5" }}>PROFILE WIDGET <span style={{ color: selected.accent }}> / {template === "none" ? "CUSTOM" : template.toUpperCase()}</span></div>
                        </div>
                        {previewHero ? <img src={previewHero} alt="Widget hero art preview" style={{ width: 82, height: 68, objectFit: "contain", objectPosition: "center", flex: "0 0 auto", filter: `drop-shadow(0 4px 12px ${selected.accent}66)` }} /> : <div aria-hidden="true" style={{ width: 72, height: 54, display: "grid", placeItems: "center", borderRadius: 8, border: `1px dashed ${selected.accent}70`, color: selected.accent, fontSize: 22 }}>✧</div>}
                    </div>
                ) : (
                    <div style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 11, minHeight: 66 }}>
                        {previewHero ? <img src={previewHero} alt="Widget hero art preview" style={{ width: 88, height: 58, objectFit: "cover", flex: "0 0 auto", borderRadius: 7, border: `1px solid ${selected.accent}68`, background: `${selected.accent}10` }} /> : <div aria-hidden="true" style={{ width: 88, height: 58, display: "grid", placeItems: "center", borderRadius: 7, border: `1px dashed ${selected.accent}70`, color: selected.accent, fontSize: 22 }}>◇</div>}
                        <div style={{ minWidth: 0 }}><div style={{ fontSize: 18, fontWeight: 850, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#f4f6fb" }}>{title}</div><div style={{ marginTop: 5, fontSize: 10, color: "#aeb5c5" }}>PROFILE WIDGET <span style={{ color: selected.accent }}> / {template === "none" ? "CUSTOM" : template.toUpperCase()}</span></div></div>
                    </div>
                )}
                <div style={{ position: "relative", zIndex: 1, borderTop: `1px solid ${selected.accent}35`, marginTop: 10, paddingTop: 9 }}>
                    {bottomLayout === "progress" && template === "none" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                            {previewHero && <img src={previewHero} alt="" aria-hidden="true" style={{ width: 30, height: 30, objectFit: "cover", borderRadius: 6 }} />}
                            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{progressLabel}<span style={{ float: "right", color: selected.accent }}>{progressPercent}%</span></div><div style={{ height: 6, borderRadius: 99, background: "rgba(255,255,255,.12)", overflow: "hidden" }}><div style={{ width: `${progressPercent}%`, height: "100%", borderRadius: 99, background: `linear-gradient(90deg, ${selected.accent}, ${selected.secondary})` }} /></div></div>
                        </div>
                    ) : statRows.length ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "7px 12px" }}>
                            {statRows.slice(0, 4).map((row, index) => <div key={`${row.label}-${index}`} style={{ minWidth: 0, borderLeft: `2px solid ${selected.accent}88`, paddingLeft: 7 }}><div style={{ fontSize: 9, color: "#aeb5c5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label || "DETAIL"}</div><div style={{ fontSize: 11, fontWeight: 750, color: "#f1f3f8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.value}</div></div>)}
                        </div>
                ) : <div style={{ fontSize: 11, color: "#aeb5c5" }}>Your stats will preview here as you fill them in.</div>}
                </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 7, marginTop: 8 }}>
                <div style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(125,230,180,.24)", background: "rgba(35,160,100,.07)", fontSize: 10.5, lineHeight: 1.45, color: "#c5d8cc" }}><b style={{ color: "#8ee0b2" }}>Discord widget fields:</b> supported layout, title, stats, and uploaded image art. Create/Update is the separate publish step.</div>
                <div style={{ padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(180,160,255,.24)", background: "rgba(120,80,200,.08)", fontSize: 10.5, lineHeight: 1.45, color: "#d2c9ea" }}><b style={{ color: "#bea8ff" }}>Discordmaxxer skin:</b> colors, glow, outlines, motifs, and motion are applied to the real card in this client. Tournament Mode pauses them. Vanilla Discord only receives the supported widget payload.</div>
            </div>

            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 10, paddingTop: 9, borderTop: "1px solid rgba(255,255,255,.1)" }}>
                <button type="button" onClick={() => imageInput.current?.click()} style={{ border: `1px solid ${selected.accent}70`, background: `${selected.accent}18`, color: "#f2f3f5", borderRadius: 7, padding: "7px 10px", cursor: "pointer", fontWeight: 700, fontSize: 11 }}>Choose image file</button>
                <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={event => { const file = event.currentTarget.files?.[0]; void chooseLocalImage(file); event.currentTarget.value = ""; }} />
                {localHero?.slotKey === template ? <>
                    <span style={{ fontSize: 10.5, color: "#c5c9d4" }}>Using {localHero.name} · saved on this PC</span>
                    <button type="button" onClick={() => void clearLocalImage()} style={{ border: "1px solid rgba(255,255,255,.18)", background: "transparent", color: "#c5c9d4", borderRadius: 6, padding: "5px 8px", cursor: "pointer", fontSize: 10 }}>Use link/preset instead</button>
                </> : <span style={{ fontSize: 10.5, color: "#aeb5c5" }}>PNG, JPG, WebP, or GIF · up to 8 MB · stays local until you publish.</span>}
                {imageError && <span role="alert" style={{ width: "100%", fontSize: 10.5, color: "#ff969b" }}>{imageError}</span>}
            </div>
            <div style={{ marginTop: 5, fontSize: 10.5, lineHeight: 1.4, color: "#aeb5c5" }}>
                The selected image is uploaded to your Discord widget app only when you press Create/Update. Local files do not travel in Copy this widget codes. GIF upload is accepted, but animation in Discord and visibility to vanilla viewers still need a real recipient test. {tournamentPaused ? "Tournament Mode is pausing this skin's motion." : selected.motion === "none" ? "This preset has a still design." : "Tournament Mode pauses this skin's motion."}
            </div>
        </div>
    );
}

function WidgetEditor() {
    const [busy, setBusy] = React.useState(false);
    const [, force] = React.useState(0);
    const live = settings.use(["appIconUrl", "heroImageUrl", "gameTemplate", "valHeroPreset", "fnHeroPreset"]);
    const slotKey = String(live.gameTemplate ?? "none") || "none";
    React.useEffect(() => {
        let active = true;
        void ensureSlots()
            .then(() => refreshAttachedWidgetStyles(true))
            .catch(error => console.warn("[DMWidget] widget editor recovery failed:", error))
            .finally(() => {
                if (!active) return;
                const recovered = getSlot(slotKey);
                const store = settings.store as any;
                if (SNOWFLAKE.test(recovered.appId)) {
                    if (recovered.heroImageUrl && recovered.heroImageUrl !== store.heroImageUrl) store.heroImageUrl = recovered.heroImageUrl;
                    if (recovered.appIconUrl !== store.appIconUrl) store.appIconUrl = recovered.appIconUrl;
                }
                force(x => x + 1);
            });
        return () => { active = false; };
    }, [slotKey]);
    const id = getSlot(slotKey);
    const created = SNOWFLAKE.test(id.appId);
    const previewHero = heroUrlFor(slotKey, id);
    // Summary of every deployed widget (so multi-widget is legible).
    const allSlots = Object.entries(slots.get()).filter(([, v]) => SNOWFLAKE.test(v.appId)).map(([k]) => SLOT_LABEL[k] ?? k);

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        try { await fn(); } finally { setBusy(false); force(x => x + 1); }
    };

    return (
        <div style={{ padding: "12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ border: "1px solid var(--status-warning, #e6a817)", borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.45, color: "var(--text-normal)" }}>
                <b>⚠ Experimental — Discord profile widgets are pre-release.</b> This creates a Discord application <i>you own</i>,
                uploads your image to it, and pins a widget to your profile board. The public "claim" step resets a bot token, so
                <b> your account needs 2FA enabled</b> (Discord requires it) and you'll enter your 2FA code once. Whether other people
                see it depends on Discord having enabled widgets for <i>their</i> account. Never name your app after a real brand.
            </div>

            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                Editing the <b style={{ color: "var(--text-normal)" }}>{SLOT_LABEL[slotKey] ?? slotKey}</b> widget:{" "}
                {created ? <b style={{ color: "var(--text-positive, #23a55a)" }}>existing widget recovered ✓</b> : "not linked to this Discord account yet"}
                {created && <span> — app id <code>{id.appId}</code></span>}
                {allSlots.length > 0 && <div style={{ marginTop: 3 }}>On your board: {allSlots.join(" · ")} — switch the <i>Game template</i> above to add/edit another.</div>}
            </div>

            {created && live.gameTemplate === "valorant" && !String((settings.store as any).valRiotId ?? "").trim() && (
                <div style={{ border: "1px solid var(--status-warning, #e6a817)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, lineHeight: 1.45, color: "var(--text-muted)" }}>
                    <b style={{ color: "var(--text-normal)" }}>This widget was recovered from your profile.</b> Discord stores the published card,
                    not your private Riot ID or HenrikDev API key, so those fields cannot be reconstructed after a reinstall or account switch.
                    Re-enter them only if you want live Valorant stat refreshes; the existing widget and its skin can still be updated.
                </div>
            )}

            {(live.appIconUrl?.trim() || previewHero) && (
                <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <ImgPreview url={live.appIconUrl ?? ""} label="app icon" round />
                    <ImgPreview url={previewHero} label="hero image" />
                </div>
            )}

            {lastResult && (
                <div style={{ fontSize: 13, lineHeight: 1.4, color: lastResult.startsWith("⚠") ? "var(--text-danger, #f23f43)" : "var(--text-positive, #23a55a)", wordBreak: "break-word" }}>
                    {lastResult}
                </div>
            )}

            {live.gameTemplate === "fortnite" && (
                <div style={{ border: "1px solid var(--background-modifier-accent)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
                    <b style={{ color: "var(--text-normal)" }}>🎮 Fortnite live stats</b> — Wins / K-D / Kills / Win-Rate auto-refresh from your public
                    career stats (needs your Epic career stats set <b>public</b> + your API key). Unreal rank + earnings are the two you fill in.
                    Auto-updates on launch and every 30 min while open.
                </div>
            )}
            {live.gameTemplate === "valorant" && (
                <div style={{ border: "1px solid var(--background-modifier-accent)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
                    <b style={{ color: "var(--text-normal)" }}>🎯 Valorant live stats</b> — Rank / RR / Peak / Main Agent / Recent Win-Rate / K-D, all
                    auto-pulled from your Riot ID (HenrikDev API key + region required). Auto-updates on launch and every 30 min while open.
                </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button disabled={busy} onClick={() => run(deployWidget)}>{created ? "Update existing widget" : "Create my widget"}</Button>
                {created && (live.gameTemplate === "fortnite" || live.gameTemplate === "valorant") && (
                    <Button disabled={busy} color={Button.Colors.BRAND} onClick={() => run(() => refreshGame(true))}>Refresh {live.gameTemplate === "valorant" ? "Valorant" : "Fortnite"} stats now</Button>
                )}
                {created && <Button disabled={busy} onClick={() => run(moveToTop)}>Move to top</Button>}
                {created && <Button disabled={busy} color={Button.Colors.RED} onClick={() => run(removeFromProfile)}>Remove from profile</Button>}
            </div>

            <div style={{ borderTop: "1px solid var(--background-modifier-accent)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                    <b style={{ color: "var(--text-normal)" }}>Move this widget to another account.</b> Copy the code here, paste it into the
                    “Import code” box on your other account, and hit Import. The code carries your card’s content, style choice, and linked images — never your app,
                    bot token, or API keys. A local file stays on this PC and is not packed into the code.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button disabled={busy} color={Button.Colors.PRIMARY} onClick={() => run(async () => {
                        await ensureSlots();
                        const code = await exportConfig();
                        const ok = await copyText(code);
                        toast(ok ? "Widget code copied — local image files stay on this PC and are not included." : "Clipboard blocked — the code is shown below. Local image files are not included.", ok ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE, 8000);
                        lastResult = (ok ? "✅ Copied widget code:\n" : "⚠ Copy this widget code:\n") + code;
                    })}>Copy this widget</Button>
                    <Button disabled={busy} color={Button.Colors.PRIMARY} onClick={() => run(async () => {
                        await ensureSlots();
                        const err = importConfig((settings.store as any).importCode ?? "");
                        if (err) { toast(err, Toasts.Type.FAILURE, 7000); return; }
                        toast("Widget content imported. Review the fields above, re-enter your game API key if it’s a game card, then hit Create/Update.", Toasts.Type.SUCCESS, 9000);
                    })}>Import from code</Button>
                </div>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    gameTemplate: {
        type: OptionType.SELECT,
        description: "STEP 1 - What is this widget? Pick a game to auto-fill live stats, or 'Custom' to type your own card. IMPORTANT: each choice is its OWN separate widget - switching here does NOT replace the last one, it's how you add a second (e.g. Fortnite AND Valorant both on your board). Only the boxes for the mode you pick are shown below.",
        options: [
            { label: "Custom card (type it yourself)", value: "none", default: true },
            { label: "Fortnite (auto live stats)", value: "fortnite" },
            { label: "Valorant (auto live stats)", value: "valorant" }
        ]
    },
    stylePicker: { type: OptionType.COMPONENT, description: "", component: WidgetStylePicker },
    // The visual gallery owns this value; keep it in plugin settings so the
    // selected preview survives restarts and travels in Copy/Import codes.
    widgetStyle: {
        type: OptionType.SELECT,
        description: "Selected gallery style (managed by the style cards above).",
        default: "neonCircuit",
        hidden() { return true; },
        options: WIDGET_STYLE_PRESETS.map((preset, index) => ({ label: preset.name, value: preset.id, default: index === 0 }))
    },
    fnIgn: { type: OptionType.STRING, description: "Your exact Fortnite (Epic) username - capitals, spaces and symbols must match. Your Fortnite career stats must be set to Public in-game.", default: "", hidden() { return (this.store as any).gameTemplate !== "fortnite"; } },
    fnApiKey: { type: OptionType.STRING, description: "Your free Fortnite stats key from fortnite-api.com (sign in with Discord at dash.fortnite-api.com). Stays on your PC; treat it like a password.", default: "", hidden() { return (this.store as any).gameTemplate !== "fortnite"; } },
    fnAccountType: {
        type: OptionType.SELECT,
        description: "Which platform your Epic account mainly signs in through.",
        hidden() { return (this.store as any).gameTemplate !== "fortnite"; },
        options: [
            { label: "Epic", value: "epic", default: true },
            { label: "PlayStation", value: "psn" },
            { label: "Xbox", value: "xbl" }
        ]
    },
    fnHeroPreset: {
        type: OptionType.SELECT,
        description: "Quick-pick the cutout on your Fortnite card. Automatic keeps the current/remembered image; Custom image uses the URL below. The starter preset is Catwoman, not a full cosmetics catalog.",
        hidden() { return (this.store as any).gameTemplate !== "fortnite"; },
        options: [
            { label: "Automatic (keep current / Catwoman for a new card)", value: "auto", default: true },
            { label: "Catwoman", value: "catwoman" },
            { label: "Custom image URL", value: "custom" }
        ]
    },
    fnUnrealRank: { type: OptionType.STRING, description: "Your rank text to show, e.g. 'Unreal' or 'Unreal #1,234'. (Typed in - there's no free rank API.)", default: "", hidden() { return (this.store as any).gameTemplate !== "fortnite"; } },
    fnEarnings: { type: OptionType.STRING, description: "Your total earnings to show, e.g. '$8,500'. Leave '$0' if none. (Typed in.)", default: "$0", hidden() { return (this.store as any).gameTemplate !== "fortnite"; } },
    fnChapterSeason: { type: OptionType.STRING, description: "Chapter/season shown in the small header, e.g. 'Ch 6 S3'. Leave blank for just 'Fn'.", default: "", hidden() { return (this.store as any).gameTemplate !== "fortnite"; } },
    fnTopPlacement: { type: OptionType.STRING, description: "Best tournament finish to show, e.g. '15th LCQ'. Leave blank to skip.", default: "", hidden() { return (this.store as any).gameTemplate !== "fortnite"; } },
    valRiotId: { type: OptionType.STRING, description: "Your Valorant Riot ID as Name#Tag, e.g. 'Diggy#NA1'.", default: "", hidden() { return (this.store as any).gameTemplate !== "valorant"; } },
    valApiKey: { type: OptionType.STRING, description: "Your free HenrikDev Valorant key (get it in the HenrikDev Discord). Stays on your PC; treat it like a password.", default: "", hidden() { return (this.store as any).gameTemplate !== "valorant"; } },
    valRegion: {
        type: OptionType.SELECT,
        description: "Your Valorant account region.",
        hidden() { return (this.store as any).gameTemplate !== "valorant"; },
        options: [
            { label: "North America", value: "na", default: true },
            { label: "Europe", value: "eu" },
            { label: "Asia-Pacific", value: "ap" },
            { label: "Korea", value: "kr" },
            { label: "LATAM", value: "latam" },
            { label: "Brazil", value: "br" }
        ]
    },
    valHeroPreset: {
        type: OptionType.SELECT,
        description: "Quick-pick a transparent Valorant agent cutout. Automatic keeps the current/remembered image; Custom image uses the URL below. Presets are intentionally curated; you can still paste any direct image URL.",
        hidden() { return (this.store as any).gameTemplate !== "valorant"; },
        options: [
            { label: "Automatic (keep current / Neon for a new card)", value: "auto", default: true },
            { label: "Neon", value: "neon" },
            { label: "Jett", value: "jett" },
            { label: "Reyna", value: "reyna" },
            { label: "Raze", value: "raze" },
            { label: "Sage", value: "sage" },
            { label: "Custom image URL", value: "custom" }
        ]
    },
    valActEpisode: { type: OptionType.STRING, description: "Season line shown above your name, e.g. 'Act 3 Ep 3' or 'E9 A3'. Your current rank is added automatically (-> 'Act 3 Ep 3: Ascendant 3'). Leave blank for just 'Val'.", default: "", hidden() { return (this.store as any).gameTemplate !== "valorant"; } },
    appName: {
        type: OptionType.STRING,
        description: "A name for this widget (shows as a small header line). Use a name you OWN - never a real brand like Discord/Steam/Nitro; Discord bans accounts for that.",
        default: "My Widget",
        hidden() { return (this.store as any).gameTemplate !== "none"; }
    },
    widgetTitle: { type: OptionType.STRING, description: "The big title on the card. Keep it short - one line (Discord cuts off long titles).", default: "My Widget", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    heroImageUrl: { type: OptionType.STRING, description: "Optional direct HTTPS image link (PNG, JPG, WebP, or GIF; not a webpage). You can also choose a local file in the style gallery above. A local file stays on this PC and is uploaded only when you press Create/Update. GIF data is sent as a GIF, but Discord playback is not verified.", default: "" },
    appIconUrl: { type: OptionType.STRING, description: "Small logo in the top-left corner. Paste a direct SQUARE image link, or leave blank. (Fortnite & Valorant fill this in with their game logo automatically.)", default: "", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    topLayout: {
        type: OptionType.SELECT,
        description: "How the main image sits on the card.",
        options: [
            { label: "Banner (image bleeds off the right edge)", value: "hero", default: true },
            { label: "Boxed (image in a box beside the title)", value: "contained" }
        ]
    },
    bottomLayout: {
        type: OptionType.SELECT,
        description: "Bottom of the card: a grid of stats, or a single progress bar (like a level / season-pass bar). Progress bar reuses your main image as its icon.",
        hidden() { return (this.store as any).gameTemplate !== "none"; },
        options: [
            { label: "Stat grid (up to 6)", value: "stats", default: true },
            { label: "Progress bar", value: "progress" }
        ]
    },
    stat1: { type: OptionType.STRING, description: "Stat row 1 - write it as 'Label | Value', e.g. 'Rank | Diamond III'. Leave blank to skip.", default: "", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    stat2: { type: OptionType.STRING, description: "Stat row 2 - 'Label | Value'.", default: "", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    stat3: { type: OptionType.STRING, description: "Stat row 3 - 'Label | Value'.", default: "", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    stat4: { type: OptionType.STRING, description: "Stat row 4 - 'Label | Value'.", default: "", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    stat5: { type: OptionType.STRING, description: "Stat row 5 - 'Label | Value'.", default: "", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    stat6: { type: OptionType.STRING, description: "Stat row 6 - 'Label | Value'.", default: "", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    progressLabel: { type: OptionType.STRING, description: "Progress-bar mode only: the goal name next to the bar, e.g. 'Level 5' or 'Champion'.", default: "Level 1", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    progressPercent: {
        type: OptionType.SLIDER,
        description: "Progress-bar mode only: how full the bar is (0-100%).",
        default: 50,
        markers: [0, 25, 50, 75, 100],
        stickToMarkers: false,
        hidden() { return (this.store as any).gameTemplate !== "none"; }
    },
    importCode: { type: OptionType.STRING, description: "Import code — paste a 'Copy this widget' code from another account here, then click Import from code below. (Content only; no API keys travel in the code.)", default: "" },
    editor: { type: OptionType.COMPONENT, description: "", component: WidgetEditor }
});

export default definePlugin({
    name: "DMWidget",
    description:
        "One-click custom Discord PROFILE BOARD widget (widgets v2 / Social SDK) — free, local, no paid widget-maker. Fill in your content, hit Create, and it builds an app you own, uploads your image, publishes the widget (board card + popout cutout) and claims it to your profile. Experimental / pre-GA; needs 2FA for the public claim; who sees it depends on Discord's rollout.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    // Live game-stat refresh: once on start (after the client settles) + every
    // 30 min while running. Guards inside refreshFortnite make it a no-op unless
    // the Fortnite template is on and a widget exists.
    start() {
        startWidgetSkinRenderer();
        void ensureSlots().then(async () => {
            scheduleWidgetSkinScan();
            await refreshAttachedWidgetStyles(true);
        });
        setTimeout(() => { refreshAllGames(); }, 20_000);
        fnRefreshTimer = setInterval(() => { refreshAllGames(); }, 30 * 60_000);
        // Let DMHub (or any surface) trigger a manual stats refresh — mirrors the
        // __dmReopenWelcome hook DMWelcome exposes for the hub's "Open Tour" row.
        (globalThis as any).__dmWidgetRefresh = async () => {
            await ensureSlots();
            if (deployedGameSlots().length === 0) { toast("No game widget deployed yet — Create one first (Fortnite / Valorant).", Toasts.Type.MESSAGE, 6000); return; }
            toast("Refreshing your widget stats…", Toasts.Type.MESSAGE, 3000);
            const result = await refreshAllGames();
            if (result.failed > 0) {
                toast(`${result.updated} widget${result.updated === 1 ? "" : "s"} updated; ${result.failed} could not be refreshed. Check the DMWidget status for the error.`, Toasts.Type.FAILURE, 8000);
            } else {
                toast(`${result.updated} widget${result.updated === 1 ? "" : "s"} refreshed and published. An already-open profile may take a moment to redraw.`, Toasts.Type.SUCCESS, 6000);
            }
        };
        (globalThis as any).__dmWidgetReskin = () => scheduleWidgetSkinScan();
    },
    stop() {
        stopWidgetSkinRenderer();
        if (fnRefreshTimer) { clearInterval(fnRefreshTimer); fnRefreshTimer = null; }
        delete (globalThis as any).__dmWidgetRefresh;
        delete (globalThis as any).__dmWidgetReskin;
    }
});

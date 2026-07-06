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
import { Button, React, RestAPI, Toasts, UserStore } from "@webpack/common";

import { makePersistentValue } from "../_dm-shared/persist";
import { DEFAULT_APP_ICONS } from "./logos";

const Native = VencordNative.pluginHelpers.DMWidget as PluginNative<typeof import("./native")>;

// Default hero render per game — used when you haven't pasted your own image URL,
// so a game card looks finished on first Create. A direct URL (not baked base64;
// full agent portraits are ~800KB); uploadHeroAsset's native fetch handles the
// CORS-blocked host. Neon = official valorant-api.com full portrait.
const DEFAULT_HEROES: Record<string, string> = {
    valorant: "https://media.valorant-api.com/agents/bb2a4828-46eb-8cd1-e765-15848195d751/fullportrait.png"
};

// ---- local (per-user) identity: the self-owned app + its widget config ------
interface WidgetIdentity {
    appId: string;
    configId: string;
    heroAssetKey: string; // last uploaded hero asset, so refreshes reuse it
    heroImageUrl: string; // per-slot hero source URL (so each slot keeps its own image + preview)
    appIconUrl: string;   // per-slot app-icon URL (so a FN slot can wear an F logo, Valorant its own)
}
const EMPTY_IDENTITY: WidgetIdentity = { appId: "", configId: "", heroAssetKey: "", heroImageUrl: "", appIconUrl: "" };
const parseId = (raw: any): WidgetIdentity => ({ appId: String(raw?.appId ?? ""), configId: String(raw?.configId ?? ""), heroAssetKey: String(raw?.heroAssetKey ?? ""), heroImageUrl: String(raw?.heroImageUrl ?? ""), appIconUrl: String(raw?.appIconUrl ?? "") });

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
// Legacy single-widget store — migrated into a slot on first load.
const legacyIdentity = makePersistentValue<WidgetIdentity>("dm-widget-identity", EMPTY_IDENTITY, raw => (raw && typeof raw === "object" ? parseId(raw) : null));

let slotsMigrated = false;
async function ensureSlots(): Promise<void> {
    await slots.ready; await legacyIdentity.ready;
    if (slotsMigrated) return;
    slotsMigrated = true;
    if (Object.keys(slots.get()).length === 0) {
        const legacy = legacyIdentity.get();
        if (SNOWFLAKE.test(legacy.appId)) {
            const key = String((settings.store as any).gameTemplate ?? "none") || "none";
            slots.set({ [key]: legacy });
        }
    }
}
const getSlot = (key: string): WidgetIdentity => ({ ...EMPTY_IDENTITY, ...(slots.get()[key] ?? {}) });
const setSlot = (key: string, v: WidgetIdentity): void => slots.set({ ...slots.get(), [key]: v });
const slotKeyOf = (): string => String((settings.store as any).gameTemplate ?? "none") || "none";
// Game slots that currently have a deployed app (for auto-refresh).
const deployedGameSlots = (): string[] => Object.entries(slots.get()).filter(([k, v]) => (k === "fortnite" || k === "valorant") && SNOWFLAKE.test(v.appId)).map(([k]) => k);

let lastResult = "";

// ---- game templates (auto-stat cards) --------------------------------------
// Latest fetched Fortnite overall stats (null until first refresh). Kept in a
// module var — NOT in the user's manual stat fields — so a live refresh never
// clobbers hand-entered stats and buildSurfaces can read whichever is active.
let fnStats: Record<string, number> | null = null;
let valStats: Record<string, any> | null = null;
let fnRefreshTimer: ReturnType<typeof setInterval> | null = null;

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
        `Highest Rank | 👑 ${rank}`,
        `Earnings | 💵 ${earn}`,
        placement ? `Best (Ch) | ${placement}` : null,
        `Wins | ${fmtNum(o.wins)}`,
        `K/D | ${o.kd !== undefined ? Number(o.kd).toFixed(2) : "—"}`,
        hrs !== undefined ? `Playtime | ${fmtNum(hrs)}h` : null,
        `Kills | ${fmtNum(o.kills)}` // fills a slot only if placement/playtime absent
    ].filter((x): x is string => !!x);
    return all.slice(0, 6);
}

// The small header line above the title: "Fn · Ch6 S3" / "Val" / the app name.
function slotHeader(tpl: string): string {
    const s = settings.store as any;
    if (tpl === "fortnite") { const cs = String(s.fnChapterSeason ?? "").trim(); return cs ? `Fn · ${cs}` : "Fn"; }
    if (tpl === "valorant") return "Val";
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
    return body?.message ?? err?.message ?? "unknown error";
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
async function uploadHeroAsset(appId: string, url: string): Promise<string | null> {
    if (!url) return null;
    let blob: Blob | null = null;
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
    if (!blob) {
        toast("Couldn't download the hero image (use a direct image link). Deploying without it.", Toasts.Type.MESSAGE, 5000);
        return null;
    }
    const ct = blob.type || "image/png";
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

function buildSurfaces(tpl: string, imageKey: string | null) {
    const s = settings.store as any;
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

    // widget_bottom is a SINGLE slot: either the stat grid OR a progress bar
    // (verified live 2026-07). Progress needs an objective IMAGE (an uploaded
    // asset — we reuse the hero) + name, and progress.current as a 0..1 fraction,
    // so it falls back to stats when there's no hero image to borrow.
    let widget_bottom: any;
    if (s.bottomLayout === "progress" && imageKey && !fnMode) {
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
    const widget_top = s.topLayout === "contained"
        ? { layout: "widget_top_contained", components: { contained_image: { fields: { image: img } }, title: { fields: { text: tf(title) } } } }
        : { layout: "widget_top_hero", components: { hero_image: { fields: { image: img } }, title: { fields: { text: tf(title) } } } };

    return {
        surfaces: {
            widget_top,
            widget_bottom,
            add_widget_preview: { layout: "add_widget_preview_hero", components: { hero_image: { fields: { image: img } } } },
            // Drives the profile-popout cutout: hero image + one stat line.
            mini_profile: { layout: "mini_profile_hero_stat", components: { hero_image: { fields: { image: img } }, stat: { fields: { text: tf(firstStat || (s.bottomLayout === "progress" ? String(s.progressLabel ?? "").trim() : "") || title) } } } }
        }
    };
}

async function attachToProfile(appId: string, userId: string) {
    let widgets: any[] = [];
    try { const prof = await apiGet(`/users/${userId}/profile`); widgets = Array.isArray(prof?.widgets) ? prof.widgets : []; } catch { widgets = []; }
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
        await apiPatch(`/applications/${id.appId}/widget-configs/${id.configId}`, { ...buildSurfaces(slotKey, assetKey || null), display_name: slotHeader(slotKey) });
        await apiPost(`/applications/${id.appId}/widget-configs/${id.configId}/publish`, {});
        return null;
    } catch (e) { return classifyDiscordError(e); }
}

// Fetch a specific game slot's live stats (native, no CORS) and re-publish it.
async function refreshGameSlot(tpl: string, announce = false): Promise<void> {
    if (tpl !== "fortnite" && tpl !== "valorant") return;
    const s = settings.store as any;
    await ensureSlots();
    if (!SNOWFLAKE.test(getSlot(tpl).appId)) { if (announce) toast("Create this widget first, then refresh stats.", Toasts.Type.FAILURE); return; }

    if (tpl === "fortnite") {
        const ign = String(s.fnIgn ?? "").trim(); const key = String(s.fnApiKey ?? "").trim();
        if (!ign || !key) { if (announce) toast("Set your Epic IGN + fortnite-api.com key first.", Toasts.Type.FAILURE); return; }
        const res = await Native.fetchFortniteStats(ign, key, String(s.fnAccountType ?? "epic"));
        if ("error" in res) { toast(`Fortnite stats: ${res.error}`, Toasts.Type.FAILURE, 8000); return; }
        fnStats = res.overall;
    } else {
        const riot = String(s.valRiotId ?? "").trim(); const key = String(s.valApiKey ?? "").trim();
        const hash = riot.indexOf("#");
        if (hash < 1 || !key) { if (announce) toast("Set your Riot ID (Name#Tag) + HenrikDev key first.", Toasts.Type.FAILURE); return; }
        const res = await Native.fetchValorantStats(riot.slice(0, hash), riot.slice(hash + 1), String(s.valRegion ?? "na"), "pc", key);
        if ("error" in res) { toast(res.error, Toasts.Type.FAILURE, 8000); return; }
        valStats = res.overall;
    }

    const err = await republishConfig(tpl);
    if (announce) {
        if (err) toast(`Stats fetched but publish failed: ${err}`, Toasts.Type.FAILURE, 8000);
        else if (tpl === "fortnite") toast(`Fortnite stats updated — ${fmtNum(fnStats?.wins)} wins, ${fnStats?.kd?.toFixed?.(2) ?? "—"} K/D.`, Toasts.Type.SUCCESS, 6000);
        else toast(`Valorant stats updated — ${valStats?.rank ?? "—"}, main ${valStats?.mainAgent ?? "—"}.`, Toasts.Type.SUCCESS, 6000);
    }
}

// Manual "Refresh now" button — refreshes the slot the picker is on.
const refreshGame = (announce = false) => refreshGameSlot(slotKeyOf(), announce);

// Timer — refresh EVERY deployed game slot (so FN + Valorant both stay live).
async function refreshAllGames(): Promise<void> {
    await ensureSlots();
    for (const key of deployedGameSlots()) await refreshGameSlot(key, false);
}

// ---- the whole flow --------------------------------------------------------
async function deployWidget(): Promise<void> {
    const me = UserStore.getCurrentUser();
    if (!me?.id) { toast("Not logged in yet — try again in a moment.", Toasts.Type.FAILURE); return; }
    const appName = String((settings.store as any).appName ?? "").trim();
    const nameErr = impersonationError(appName);
    if (nameErr) { toast(nameErr, Toasts.Type.FAILURE, 8000); return; }

    await ensureSlots();
    const slotKey = slotKeyOf();
    const id: WidgetIdentity = getSlot(slotKey);

    try {
        if (!SNOWFLAKE.test(id.appId)) {
            toast("Creating your widget app…", Toasts.Type.MESSAGE, 2500);
            const app = await apiPost("/applications", { name: appName, team_id: null });
            id.appId = String(app.id); setSlot(slotKey, id);
            await apiPost(`/applications/${id.appId}/social-sdk/enable`, socialSdkBody(appName));
        }
        if (!SNOWFLAKE.test(id.configId)) { id.configId = await resolveConfigId(id.appId, appName); setSlot(slotKey, id); }

        toast("Uploading image + publishing layout…", Toasts.Type.MESSAGE, 3000);
        // The app NAME is what renders as the small header above the title
        // (not the config display_name), so set it to "Fn · Ch6 S3" / "Val".
        try { await apiPatch(`/applications/${id.appId}`, { name: slotHeader(slotKey) }); } catch (e) { console.warn("[DMWidget] app name (non-fatal):", e); }
        // Per-slot media: remember the URLs on THIS slot so switching slots keeps
        // each widget's own hero/icon (FN and Valorant no longer share one image).
        const iconUrl = String((settings.store as any).appIconUrl ?? "").trim();
        // Your pasted hero wins; otherwise fall back to the game's default render
        // (e.g. Valorant -> Neon) so a fresh game card isn't blank.
        const heroUrl = String((settings.store as any).heroImageUrl ?? "").trim() || DEFAULT_HEROES[slotKey] || "";
        id.heroImageUrl = heroUrl; id.appIconUrl = iconUrl; setSlot(slotKey, id);
        // Top-left logo: your custom icon if set, otherwise the game's baked logo
        // (Fortnite F / Valorant V) so a game card auto-brands with no image hosting.
        await setAppIcon(id.appId, iconUrl || DEFAULT_APP_ICONS[slotKey] || "");
        let imageKey = await uploadHeroAsset(id.appId, heroUrl);
        // No new/valid image URL but this slot already has an uploaded asset —
        // reuse it so "Update" never blanks an existing widget's hero.
        if (!imageKey && SNOWFLAKE.test(id.appId) && id.heroAssetKey) imageKey = id.heroAssetKey;
        if (imageKey) { id.heroAssetKey = imageKey; setSlot(slotKey, id); }
        if ((settings.store as any).bottomLayout === "progress" && !imageKey && slotKey === "none")
            toast("Progress-bar mode needs a hero image (it doubles as the goal icon) — showing the stat grid instead. Add a Hero image URL to use the bar.", Toasts.Type.MESSAGE, 8000);
        await apiPatch(`/applications/${id.appId}/widget-configs/${id.configId}`, { ...buildSurfaces(slotKey, imageKey), display_name: slotHeader(slotKey) });
        await apiPost(`/applications/${id.appId}/widget-configs/${id.configId}/publish`, {});

        await authorizeApp(id.appId);
        await attachToProfile(id.appId, me.id);

        // Populate live stats immediately so a fresh game card isn't all "—".
        if (slotKey === "fortnite" || slotKey === "valorant") await refreshGameSlot(slotKey, false);

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
        try { const prof = await apiGet(`/users/${me.id}/profile`); widgets = Array.isArray(prof?.widgets) ? prof.widgets : []; } catch { widgets = []; }
        await apiPut("/users/@me/widgets", { widgets: widgets.filter(w => w?.data?.application_id !== id.appId) });
        setSlot(slotKey, { ...EMPTY_IDENTITY }); // forget this slot so status resets
        toast("Widget removed from your profile board. (Your app stays in the Developer Portal — delete it there if you want.)", Toasts.Type.MESSAGE, 7000);
    } catch (e: any) {
        toast(`Remove failed: ${classifyDiscordError(e)}`, Toasts.Type.FAILURE, 7000);
    }
}

// ---- share / import (move a widget from one account to another) ------------
// Serialize the CONTENT of the current widget (never the app id, bot token, or
// API keys) to a short code the user can paste on another account. Secrets are
// excluded by construction: only these fields are ever read or written.
const SHAREABLE = [
    "gameTemplate", "appName", "widgetTitle", "topLayout", "bottomLayout",
    "stat1", "stat2", "stat3", "stat4", "stat5", "stat6",
    "progressLabel", "progressPercent", "heroImageUrl", "appIconUrl",
    "fnIgn", "fnAccountType", "fnUnrealRank", "fnEarnings", "fnChapterSeason", "fnTopPlacement",
    "valRiotId", "valRegion"
] as const;

// UTF-8-safe base64 (btoa/atob are latin1-only; emoji/katakana in titles break it).
const b64encode = (s: string): string => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string): string => decodeURIComponent(escape(atob(s)));

function exportConfig(): string {
    const s = settings.store as any;
    const o: Record<string, any> = {};
    for (const k of SHAREABLE) o[k] = s[k];
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
    for (const k of SHAREABLE) if (k in obj) { s[k] = obj[k]; n++; }
    if (!n) return "No widget fields found in that code.";
    return null;
}

// ---- settings UI -----------------------------------------------------------
function ImgPreview({ url, label, round }: { url: string; label: string; round?: boolean; }) {
    const [ok, setOk] = React.useState(true);
    const src = url.trim();
    if (!src) return null;
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            {ok
                ? <img src={src} onError={() => setOk(false)} style={{ width: round ? 48 : 96, height: 48, objectFit: "cover", borderRadius: round ? "50%" : 6, border: "1px solid var(--background-modifier-accent)", background: "var(--background-secondary)" }} />
                : <div style={{ width: round ? 48 : 96, height: 48, display: "grid", placeItems: "center", borderRadius: round ? "50%" : 6, border: "1px dashed var(--text-danger, #f23f43)", color: "var(--text-danger, #f23f43)", fontSize: 11, textAlign: "center", padding: 2 }}>can't load</div>}
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</span>
        </div>
    );
}

const SLOT_LABEL: Record<string, string> = { fortnite: "Fortnite", valorant: "Valorant", none: "Custom" };

function WidgetEditor() {
    const [busy, setBusy] = React.useState(false);
    const [, force] = React.useState(0);
    const live = settings.use(["appIconUrl", "heroImageUrl", "gameTemplate"]);
    React.useEffect(() => { ensureSlots().then(() => force(x => x + 1)); }, []);
    const slotKey = String(live.gameTemplate ?? "none") || "none";
    const id = getSlot(slotKey);
    const created = !!id.appId;
    // Switching to an already-deployed slot loads ITS saved hero/icon into the
    // editing buffer, so each widget shows its own image (guarded to not loop:
    // only writes when the value actually differs). New/empty slots keep the
    // current draft untouched.
    React.useEffect(() => {
        ensureSlots().then(() => {
            const s = getSlot(slotKey);
            if (!s.appId) return;
            if (s.heroImageUrl && s.heroImageUrl !== (settings.store as any).heroImageUrl) (settings.store as any).heroImageUrl = s.heroImageUrl;
            if (s.appIconUrl !== (settings.store as any).appIconUrl) (settings.store as any).appIconUrl = s.appIconUrl;
        });
    }, [slotKey]);
    // Summary of every deployed widget (so multi-widget is legible).
    const allSlots = Object.entries(slots.get()).filter(([, v]) => !!v.appId).map(([k]) => SLOT_LABEL[k] ?? k);

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
                {created ? <b style={{ color: "var(--text-normal)" }}>created ✓</b> : "not created yet"}
                {created && <span> — app id <code>{id.appId}</code></span>}
                {allSlots.length > 0 && <div style={{ marginTop: 3 }}>On your board: {allSlots.join(" · ")} — switch the <i>Game template</i> above to add/edit another.</div>}
            </div>

            {(live.appIconUrl?.trim() || live.heroImageUrl?.trim()) && (
                <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <ImgPreview url={live.appIconUrl ?? ""} label="app icon" round />
                    <ImgPreview url={live.heroImageUrl ?? ""} label="hero image" />
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
                <Button disabled={busy} onClick={() => run(deployWidget)}>{created ? "Update my widget" : "Create my widget"}</Button>
                {created && (live.gameTemplate === "fortnite" || live.gameTemplate === "valorant") && (
                    <Button disabled={busy} color={Button.Colors.BRAND} onClick={() => run(() => refreshGame(true))}>Refresh {live.gameTemplate === "valorant" ? "Valorant" : "Fortnite"} stats now</Button>
                )}
                {created && <Button disabled={busy} color={Button.Colors.RED} onClick={() => run(removeFromProfile)}>Remove from profile</Button>}
            </div>

            <div style={{ borderTop: "1px solid var(--background-modifier-accent)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                    <b style={{ color: "var(--text-normal)" }}>Move this widget to another account.</b> Copy the code here, paste it into the
                    “Import code” box on your other account, and hit Import. The code carries your card’s <i>content only</i> — never your app,
                    bot token, or API keys, so you’ll re-enter the game key + hit Create there.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button disabled={busy} color={Button.Colors.PRIMARY} onClick={() => run(async () => {
                        const code = exportConfig();
                        const ok = await copyText(code);
                        toast(ok ? "Widget code copied to clipboard — paste it into the Import box on your other account." : "Clipboard blocked — the code is shown below, select and copy it manually.", ok ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE, 8000);
                        lastResult = (ok ? "✅ Copied widget code:\n" : "⚠ Copy this widget code:\n") + code;
                    })}>Copy this widget</Button>
                    <Button disabled={busy} color={Button.Colors.PRIMARY} onClick={() => run(async () => {
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
    appName: {
        type: OptionType.STRING,
        description: "A name for this widget (shows as a small header line). Use a name you OWN - never a real brand like Discord/Steam/Nitro; Discord bans accounts for that.",
        default: "My Widget",
        hidden() { return (this.store as any).gameTemplate !== "none"; }
    },
    widgetTitle: { type: OptionType.STRING, description: "The big title on the card. Keep it short - one line (Discord cuts off long titles).", default: "My Widget", hidden() { return (this.store as any).gameTemplate !== "none"; } },
    heroImageUrl: { type: OptionType.STRING, description: "Main image on the card - your skin / agent render. Paste a DIRECT image link ending in .png or .jpg (not a webpage). This is the big picture people see.", default: "" },
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
        setTimeout(() => { refreshAllGames(); }, 20_000);
        fnRefreshTimer = setInterval(() => { refreshAllGames(); }, 30 * 60_000);
    },
    stop() {
        if (fnRefreshTimer) { clearInterval(fnRefreshTimer); fnRefreshTimer = null; }
    }
});

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

const Native = VencordNative.pluginHelpers.DMWidget as PluginNative<typeof import("./native")>;

// ---- local (per-user) identity: the self-owned app + its widget config ------
interface WidgetIdentity {
    appId: string;
    configId: string;
    heroAssetKey: string; // last uploaded hero asset, so refreshes reuse it
}
const EMPTY_IDENTITY: WidgetIdentity = { appId: "", configId: "", heroAssetKey: "" };
const identity = makePersistentValue<WidgetIdentity>("dm-widget-identity", EMPTY_IDENTITY, raw => {
    if (typeof raw !== "object" || raw === null) return null;
    return { appId: String(raw.appId ?? ""), configId: String(raw.configId ?? ""), heroAssetKey: String(raw.heroAssetKey ?? "") };
});

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
    return [
        `Unreal Rank | ${rank}`,
        `Earnings | ${earn}`,
        `Wins | ${fmtNum(o.wins)}`,
        `K/D | ${o.kd !== undefined ? Number(o.kd).toFixed(2) : "—"}`,
        `Kills | ${fmtNum(o.kills)}`,
        `Win Rate | ${o.winRate !== undefined ? Number(o.winRate).toFixed(1) + "%" : "—"}`
    ];
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
    let blob: Blob;
    try {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        blob = await r.blob();
    } catch (e) {
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
async function setAppIcon(appId: string, url: string): Promise<void> {
    const dataUri = await urlToDataUri(url);
    if (!dataUri) return;
    try {
        await apiPatch(`/applications/${appId}`, { icon: dataUri });
    } catch (e) {
        console.warn("[DMWidget] app icon (non-fatal):", e);
    }
}

function buildSurfaces(imageKey: string | null) {
    const s = settings.store as any;
    const img = imageKey
        ? { presentation_type: "image", value_type: "application_asset", value: imageKey }
        : { presentation_type: "image", value_type: "custom_string", value: "" };
    // widget_top's `title` is a SINGLE-line text field — verified live (2026-07):
    // Discord collapses newlines to spaces and truncates a long title with "…",
    // so a fake multi-line header via "\n" just produces a mangled run-on. The
    // card already has natural tiers (app-name header + this title + the stat
    // grid), so the title stays one short line and extra lines go in the stats.
    // Game templates override the title + stat grid with live/mapped stats.
    const tpl = s.gameTemplate;
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
async function republishConfig(): Promise<string | null> {
    await identity.ready;
    const id = identity.get();
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
                if (found) { assetKey = found; id.heroAssetKey = found; identity.set(id); }
            } catch { /* fall through with none */ }
        }
        await apiPatch(`/applications/${id.appId}/widget-configs/${id.configId}`, buildSurfaces(assetKey || null));
        await apiPost(`/applications/${id.appId}/widget-configs/${id.configId}/publish`, {});
        return null;
    } catch (e) { return classifyDiscordError(e); }
}

// Fetch live game stats (native, no CORS) and re-publish the card. Handles
// whichever game template is active; a no-op for "none".
async function refreshGame(announce = false): Promise<void> {
    const s = settings.store as any;
    const tpl = s.gameTemplate;
    if (tpl !== "fortnite" && tpl !== "valorant") return;
    await identity.ready;
    if (!SNOWFLAKE.test(identity.get().appId)) { if (announce) toast("Create the widget first, then refresh stats.", Toasts.Type.FAILURE); return; }

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

    const err = await republishConfig();
    if (announce) {
        if (err) toast(`Stats fetched but publish failed: ${err}`, Toasts.Type.FAILURE, 8000);
        else if (tpl === "fortnite") toast(`Fortnite stats updated — ${fmtNum(fnStats?.wins)} wins, ${fnStats?.kd?.toFixed?.(2) ?? "—"} K/D.`, Toasts.Type.SUCCESS, 6000);
        else toast(`Valorant stats updated — ${valStats?.rank ?? "—"}, main ${valStats?.mainAgent ?? "—"}.`, Toasts.Type.SUCCESS, 6000);
    }
}

// ---- the whole flow --------------------------------------------------------
async function deployWidget(): Promise<void> {
    const me = UserStore.getCurrentUser();
    if (!me?.id) { toast("Not logged in yet — try again in a moment.", Toasts.Type.FAILURE); return; }
    const appName = String((settings.store as any).appName ?? "").trim();
    const nameErr = impersonationError(appName);
    if (nameErr) { toast(nameErr, Toasts.Type.FAILURE, 8000); return; }

    await identity.ready;
    const id: WidgetIdentity = { ...identity.get() };

    try {
        if (!SNOWFLAKE.test(id.appId)) {
            toast("Creating your widget app…", Toasts.Type.MESSAGE, 2500);
            const app = await apiPost("/applications", { name: appName, team_id: null });
            id.appId = String(app.id); identity.set(id);
            await apiPost(`/applications/${id.appId}/social-sdk/enable`, socialSdkBody(appName));
        }
        if (!SNOWFLAKE.test(id.configId)) { id.configId = await resolveConfigId(id.appId, appName); identity.set(id); }

        toast("Uploading image + publishing layout…", Toasts.Type.MESSAGE, 3000);
        // Optional top-left logo (non-fatal; falls back to the default icon).
        await setAppIcon(id.appId, String((settings.store as any).appIconUrl ?? "").trim());
        const imageKey = await uploadHeroAsset(id.appId, String((settings.store as any).heroImageUrl ?? "").trim());
        if (imageKey) { id.heroAssetKey = imageKey; identity.set(id); }
        if ((settings.store as any).bottomLayout === "progress" && !imageKey)
            toast("Progress-bar mode needs a hero image (it doubles as the goal icon) — showing the stat grid instead. Add a Hero image URL to use the bar.", Toasts.Type.MESSAGE, 8000);
        await apiPatch(`/applications/${id.appId}/widget-configs/${id.configId}`, buildSurfaces(imageKey));
        await apiPost(`/applications/${id.appId}/widget-configs/${id.configId}/publish`, {});

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
    await identity.ready;
    const me = UserStore.getCurrentUser();
    const id = identity.get();
    if (!id.appId) { toast("No widget to remove.", Toasts.Type.MESSAGE); return; }
    try {
        let widgets: any[] = [];
        try { const prof = await apiGet(`/users/${me.id}/profile`); widgets = Array.isArray(prof?.widgets) ? prof.widgets : []; } catch { widgets = []; }
        await apiPut("/users/@me/widgets", { widgets: widgets.filter(w => w?.data?.application_id !== id.appId) });
        toast("Widget removed from your profile board. (Your app stays in the Developer Portal — delete it there if you want.)", Toasts.Type.MESSAGE, 7000);
    } catch (e: any) {
        toast(`Remove failed: ${classifyDiscordError(e)}`, Toasts.Type.FAILURE, 7000);
    }
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

function WidgetEditor() {
    const [busy, setBusy] = React.useState(false);
    const [, force] = React.useState(0);
    const live = settings.use(["appIconUrl", "heroImageUrl", "gameTemplate"]);
    React.useEffect(() => { identity.ready.then(() => force(x => x + 1)); }, []);
    const id = identity.get();
    const created = !!id.appId;

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
                Status: {created ? <b style={{ color: "var(--text-normal)" }}>widget app created ✓</b> : "no widget yet"}
                {created && <span> — app id <code>{id.appId}</code></span>}
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
        </div>
    );
}

const settings = definePluginSettings({
    gameTemplate: {
        type: OptionType.SELECT,
        description: "Auto-fill the card from a game's live stats. 'Fortnite' pulls your Wins/K-D/Kills/Win-Rate; 'Valorant' pulls your rank + most-used agent. (One template per widget — multiple widgets let both show at once.)",
        options: [
            { label: "None (manual card)", value: "none", default: true },
            { label: "Fortnite live stats", value: "fortnite" },
            { label: "Valorant live stats", value: "valorant" }
        ]
    },
    fnIgn: { type: OptionType.STRING, description: "Fortnite: your EXACT Epic display name (case + spaces + special characters matter). Your career stats must be set to PUBLIC in Fortnite.", default: "" },
    fnApiKey: { type: OptionType.STRING, description: "Fortnite: your free fortnite-api.com key (log in with Discord at dash.fortnite-api.com). Stored locally; treat it like a password.", default: "" },
    fnAccountType: {
        type: OptionType.SELECT,
        description: "Fortnite: which platform your Epic account primarily signs in through.",
        options: [
            { label: "Epic", value: "epic", default: true },
            { label: "PlayStation", value: "psn" },
            { label: "Xbox", value: "xbl" }
        ]
    },
    fnUnrealRank: { type: OptionType.STRING, description: "Fortnite (manual — no free API): your ranked/Unreal rank, e.g. 'Unreal #1,234' or just 'Unreal'.", default: "" },
    fnEarnings: { type: OptionType.STRING, description: "Fortnite (manual — no free API): total career earnings, e.g. '$8,500'. Leave '$0' if none.", default: "$0" },
    valRiotId: { type: OptionType.STRING, description: "Valorant: your Riot ID as Name#Tag (e.g. 'Diggy#NA1').", default: "" },
    valApiKey: { type: OptionType.STRING, description: "Valorant: your free HenrikDev API key (get it in the HenrikDev Discord). Stored locally; treat it like a password.", default: "" },
    valRegion: {
        type: OptionType.SELECT,
        description: "Valorant: your account region.",
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
        description: "Widget app name — shows as the widget's attribution. Pick something you own; do NOT name it after a real brand (Discord/Steam/etc.), that's a bannable impersonation.",
        default: "My Widget"
    },
    widgetTitle: { type: OptionType.STRING, description: "Big title on the card — keep it SHORT (one line; Discord truncates long titles and ignores line breaks). For season / rank / top-hero, use the Stat rows below — they stack as a clean grid. Your app name shows as a smaller header line above this.", default: "My Widget" },
    appIconUrl: { type: OptionType.STRING, description: "Optional app icon — the small logo shown top-left on the widget card (like a game's icon). Direct image link; use a square image for best results. Blank keeps Discord's default.", default: "" },
    heroImageUrl: { type: OptionType.STRING, description: "Direct image URL for the hero image — it gets uploaded to your app. Use a direct link (e.g. https://i.imgur.com/…png / a Discord CDN link), not a webpage.", default: "" },
    topLayout: {
        type: OptionType.SELECT,
        description: "Top section image style: Hero = image bleeds off the right edge (banner look); Contained = image sits in a box beside the title.",
        options: [
            { label: "Hero image (edge-bleed banner)", value: "hero", default: true },
            { label: "Contained image (boxed beside title)", value: "contained" }
        ]
    },
    bottomLayout: {
        type: OptionType.SELECT,
        description: "Bottom section of the card: a grid of stats, or a single progress bar (like a season-pass / rank bar). Progress-bar mode reuses your hero image as the goal icon.",
        options: [
            { label: "Stat grid (up to 6)", value: "stats", default: true },
            { label: "Progress bar", value: "progress" }
        ]
    },
    stat1: { type: OptionType.STRING, description: "Stat 1 — format 'Label | Value' (e.g. 'Rank | Diamond III'). Blank to skip. (Stat-grid mode.)", default: "" },
    stat2: { type: OptionType.STRING, description: "Stat 2 — 'Label | Value'. (Stat-grid mode.)", default: "" },
    stat3: { type: OptionType.STRING, description: "Stat 3 — 'Label | Value'. (Stat-grid mode.)", default: "" },
    stat4: { type: OptionType.STRING, description: "Stat 4 — 'Label | Value'. (Stat-grid mode.)", default: "" },
    stat5: { type: OptionType.STRING, description: "Stat 5 — 'Label | Value'. (Stat-grid mode.)", default: "" },
    stat6: { type: OptionType.STRING, description: "Stat 6 — 'Label | Value'. (Stat-grid mode.)", default: "" },
    progressLabel: { type: OptionType.STRING, description: "Progress-bar mode: the goal label next to the bar (e.g. 'Level 5', 'Season Pass Tier 42', 'Champion').", default: "Level 1" },
    progressPercent: {
        type: OptionType.SLIDER,
        description: "Progress-bar mode: how full the bar is (0–100%).",
        default: 50,
        markers: [0, 25, 50, 75, 100],
        stickToMarkers: false
    },
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
        setTimeout(() => { refreshGame(false); }, 20_000);
        fnRefreshTimer = setInterval(() => { refreshGame(false); }, 30 * 60_000);
    },
    stop() {
        if (fnRefreshTimer) { clearInterval(fnRefreshTimer); fnRefreshTimer = null; }
    }
});

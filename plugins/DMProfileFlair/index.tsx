/*
 * Discordmaxxer — DMProfileFlair plugin (Channels E, F, G)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * User-set custom profile flair, visible only to other Discordmaxxer clients
 * (same architecture as DiscordmaxxerBadge Channel A — fetched from the public
 * tier roster, rendered client-side, vanilla Discord never sees it).
 *
 *   E) Custom banner — image or short MP4 URL, replaces Discord's banner
 *      in profile popouts. Requires MAXXER.
 *   F) Animated avatar — GIF/MP4 URL, replaces the avatar in popouts (P2)
 *      and member list + chat (P5). Requires MAXXER+. Suppressed when
 *      TournamentMode is active (animated content tanks FPS).
 *   G) Theme colors — primary + secondary hex, patched into Discord's
 *      --profile-gradient-*-color CSS vars on the popout root. Requires
 *      MAXXER++.
 *
 * Phasing:
 *   - This file ships the plumbing: settings UI, worker write call, viewer
 *     toggles, TM state helper, effective-flair accessor. Render hooks for
 *     each channel land in follow-up commits.
 *
 * Anti-abuse:
 *   - URLs validated client- AND worker-side (https://, ≤250 chars).
 *   - Viewer toggle defaults ON; per-user "hide flair" right-click action
 *     populates a local block list (P5).
 *   - Worker enforces per-field tier gating so client gating can't be
 *     bypassed by editing this plugin's JS.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Button, React, RestAPI, Toasts, UserStore } from "@webpack/common";

import { makePersistentValue } from "../_dm-shared/persist";
import {
    getRosterProfileFlair,
    onRosterChange,
    ProfileFlair,
    refreshRoster,
    rosterHasAnyAvatarFlair
} from "../_dm-shared/roster";
import { decodeProfileLook, encodeProfileLook, ProfileLookConfig } from "../_dm-shared/profileLookShare";
import { Tier } from "../_dm-shared/vip";
import { normalizeCode, readBinding } from "../_dm-shared/vipClaim";

const WORKER_PROFILE_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile";

const URL_RE = /^https:\/\/[^\s]{1,250}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Hosts that serve HTML pages, not direct media bytes. Pasting one of these
// URLs into a banner/avatar field saves "successfully" but the <img>/<video>
// load gets HTML and renders blank. Catch it early with a friendly hint.
// Special-cased: imgur.com and reddit.com have direct-CDN siblings that ARE
// fine (i.imgur.com, i.redd.it, v.redd.it) — `detectPageHostMistake` checks
// the exact hostname so those pass through.
const PAGE_HOSTS_TO_HINT: Record<string, string> = {
    "tiktok.com": "TikTok",
    "www.tiktok.com": "TikTok",
    "vm.tiktok.com": "TikTok",
    "youtube.com": "YouTube",
    "www.youtube.com": "YouTube",
    "m.youtube.com": "YouTube",
    "youtu.be": "YouTube",
    "twitter.com": "Twitter/X",
    "x.com": "Twitter/X",
    "instagram.com": "Instagram",
    "www.instagram.com": "Instagram",
    "imgur.com": "Imgur (page link)",
    "www.imgur.com": "Imgur (page link)",
    "twitch.tv": "Twitch",
    "www.twitch.tv": "Twitch",
    "clips.twitch.tv": "Twitch",
    "reddit.com": "Reddit (page link)",
    "www.reddit.com": "Reddit (page link)",
    "old.reddit.com": "Reddit (page link)",
    "facebook.com": "Facebook",
    "www.facebook.com": "Facebook",
    "fb.watch": "Facebook",
    "vimeo.com": "Vimeo",
    "www.vimeo.com": "Vimeo"
};

function detectPageHostMistake(url: string): string | null {
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); }
    catch { return null; }  // URL_RE catches malformed strings separately
    const label = PAGE_HOSTS_TO_HINT[host];
    if (!label) return null;
    return `That looks like a ${label} page link, not a direct media file. ` +
        "DMProfileFlair needs a direct .mp4 / .webm / .gif / .png / .jpg URL " +
        "(it fetches the bytes — an HTML page renders blank). " +
        "Fix: download the video (yt-dlp, SnapTik, SSSTik) → drag onto catbox.moe → use the https://files.catbox.moe/... URL it gives you.";
}

function toast(msg: string, type: any = Toasts.Type.SUCCESS, durationMs = 3000) {
    Toasts.show({
        message: msg,
        type,
        id: Toasts.genId(),
        options: { duration: durationMs, position: Toasts.Position.TOP }
    });
}

/** TournamentMode integration: read the plugin's manuallyActive flag through
 *  Vencord's plain-settings tree. Used to suppress animated content (banner
 *  videos + animated avatars) when the user is gaming — TM exists exactly to
 *  free up CPU/GPU, so adding animated avatar decodes back into the mix would
 *  defeat the point. */
export function isTournamentModeActive(): boolean {
    return !!(globalThis as any).Vencord?.PlainSettings?.plugins?.TournamentMode?.manuallyActive;
}

/** Local hide list — userIds whose flair the viewer has muted. Persisted via
 *  DataStore (IndexedDB) so a right-click "hide flair" survives restarts.
 *  (Was localStorage, which modern Discord nukes → the hide list never
 *  persisted AND never stuck within a session.) The 2s rescan timer re-reads
 *  this, so the ~10ms async load is invisible after the first scan. */
const HIDE_LIST_KEY = "dm-profile-flair-hidden";
const hideStore = makePersistentValue<string[]>(HIDE_LIST_KEY, [], raw =>
    Array.isArray(raw) ? raw.filter(x => typeof x === "string") : null
);
function readHideList(): Set<string> {
    return new Set(hideStore.get());
}
function writeHideList(set: Set<string>): void {
    hideStore.set([...set]);
}
export function isFlairHiddenForUser(userId: string): boolean {
    return readHideList().has(userId);
}
export function toggleHideFlairForUser(userId: string): boolean {
    const set = readHideList();
    if (set.has(userId)) set.delete(userId);
    else set.add(userId);
    writeHideList(set);
    return set.has(userId);
}

/** Single point all render hooks call to decide what (if anything) to render
 *  for a given user. Returns null when nothing should render — viewer toggles
 *  off, user in hide list, user not on roster, or no flair set. The `kind`
 *  arg lets the helper apply per-channel gates (TM suppresses animated; the
 *  viewer toggle is per-channel). */
export function getEffectiveFlairForUser(
    userId: string,
    kind: "banner" | "avatar" | "theme"
): ProfileFlair | null {
    const s = settings.store;
    if (!s.showOthersFlair) return null;
    if (kind === "banner" && !s.showOthersBanner) return null;
    if (kind === "avatar" && !s.showOthersAvatar) return null;
    if (kind === "theme" && !s.showOthersThemeColors) return null;
    if (isFlairHiddenForUser(userId)) return null;

    // The published roster is authoritative for rendering — including when
    // you are looking at your own profile. The editor fields are per-install
    // drafts, and letting them override the roster made the same account show
    // a different banner/gradient on each PC (for example, a local Cotton
    // Candy preset on one install versus the published red look elsewhere).
    // Save or Restore updates those drafts; rendering then follows the same
    // shared value that every other Discordmaxxer client sees.
    const flair = getRosterProfileFlair(userId) ?? null;
    if (!flair) return null;

    if ((kind === "banner" || kind === "avatar") && isTournamentModeActive()) {
        // Animated content is the whole point of TM suppression — even a
        // banner image is technically a network fetch + decode we don't
        // want during a match. Theme colors are free, so they stay.
        return null;
    }
    return flair;
}

async function postFlairUpdate(profile: Partial<ProfileFlair>, replace: boolean): Promise<boolean> {
    const me = UserStore.getCurrentUser();
    if (!me?.id) {
        toast("Couldn't read your Discord user ID", Toasts.Type.FAILURE);
        return false;
    }
    // Modern Discord nukes window.localStorage to prevent token theft from
    // injected scripts. That means readBinding() (which reads from localStorage)
    // returns null even after a successful claim. Fall through to the plugin's
    // own `manualClaimCode` setting which IS persisted (Vencord writes settings
    // to disk via main process, independent of localStorage).
    let claimCode = "";
    const binding = readBinding();
    if (binding?.code) {
        claimCode = binding.code;
    } else if (settings.store.manualClaimCode?.trim()) {
        // Use the shared normalizer so a pasted "MAXX-AAAA-BBBB-CCCC-DDDD"
        // becomes the canonical 16-char code. The ad-hoc strip here only
        // removed dashes, leaving the MAXX prefix → a 20-char mismatch.
        claimCode = normalizeCode(settings.store.manualClaimCode);
    }
    if (!claimCode) {
        toast(
            "Need your VIP claim code — paste it into 'manualClaimCode' in this plugin's settings, or claim one via DiscordmaxxerVipClaim first.",
            Toasts.Type.FAILURE, 6000
        );
        return false;
    }
    try {
        const res = await fetch(WORKER_PROFILE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                userId: me.id,
                claimCode,
                profile,
                replace
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const serverError = String(body?.error ?? res.status);
            const friendlyError = /https|250/i.test(serverError)
                ? "Use a direct HTTPS media URL that is 250 characters or fewer. A webpage link or local file will not work here."
                : serverError;
            toast(`Save failed: ${friendlyError}`, Toasts.Type.FAILURE, 6000);
            return false;
        }
        toast("✅ Profile flair saved — the shared roster updates for Discordmaxxer users within ~5 min");
        // Replace the local cache immediately so the sender's own popout and
        // any already-open profile repaint without waiting for the normal TTL.
        refreshRoster().catch(e => console.warn("[DMProfileFlair] roster refresh after save failed:", e));
        // TournamentMode silently suppresses banner + animated avatar (it's
        // the whole point of TM — free up CPU/GPU). The save itself works
        // fine, but the visual won't appear until TM is toggled off, which
        // looks indistinguishable from a broken save. Call it out explicitly.
        if (isTournamentModeActive() && (profile.bannerUrl || profile.avatarAnimatedUrl)) {
            toast(
                "⚠ TournamentMode is on — your banner + animated avatar won't render until you toggle TM off. Theme colors still paint.",
                Toasts.Type.MESSAGE, 8000
            );
        }
        return true;
    } catch (e) {
        console.warn("[DMProfileFlair] save failed:", e);
        toast(`Save failed: ${(e as any)?.message ?? "network"}`, Toasts.Type.FAILURE, 5000);
        return false;
    }
}

function validateLocal(profile: Partial<ProfileFlair>): string | null {
    for (const [k, v] of Object.entries(profile)) {
        if (!v) continue;
        if (k === "bannerUrl" || k === "avatarAnimatedUrl") {
            if (!URL_RE.test(v as string)) return k + " must be a direct HTTPS media URL of 250 characters or fewer. Page links will not render; use the file picker below or host the file first.";
            const pageHint = detectPageHostMistake(v as string);
            if (pageHint) return pageHint;
        }
        // Color fields are auto-normalized in onSave (# prefix auto-added),
        // so by the time we reach validation they should already be canonical
        // #RRGGBB. If not — bad input that even normalizeColor couldn't save.
        if (k === "themeColorPrimary" || k === "themeColorSecondary") {
            if (!COLOR_RE.test(v as string)) {
                return `${k} must be a 6-char hex color (e.g. ff0034 or #ff0034 — the # is optional)`;
            }
        }
    }
    return null;
}

// ─── Vanilla-Discord broadcast (Path A) ────────────────────────────────
// Optional, opt-in, one-shot: PATCH the user's REAL Discord profile. NOTE on
// vanilla visibility: only a STATIC avatar truly renders for everyone on free;
// the theme GRADIENT is Nitro-gated at the render layer (vanilla/non-Nitro
// viewers see default), and BANNERS need Nitro to upload at all. In-app flair
// (the roster path) is always Discordmaxxer-users-only. Three independent
// fields, three independent buttons — colors, avatar, banner — each gated
// behind a confirm modal.
//
// Hard rules carried from DMBadge channels C/D and CLAUDE.md:
//   - Fires only on explicit user click (never on plugin start, never on
//     setting change unless user clicked a dedicated button).
//   - Never re-asserts. If the user changes the value via Discord's normal
//     Settings → Profiles UI, we don't fight them.
//   - One-time apply per click; toggling off does NOT undo (user reverts via
//     Discord normally).
//
// Endpoint shape (verified via DMBadge — same pattern):
//   PATCH /users/@me/profile  body: { theme_colors: [int, int] }     → write may succeed, but Discord NITRO-GATES the render (vanilla / non-Nitro viewers see default, NOT your gradient)
//   PATCH /users/@me/profile  body: { avatar: "data:image/...;base64,..." } → static free, GIF requires Nitro
//   PATCH /users/@me/profile  body: { banner: "data:image/...;base64,..." } → requires Nitro
//
// Discord returns 400 with code 50035 + message naming the field if the
// account doesn't have Nitro for an animated/banner upload. We pattern-match
// that to a clear "Nitro required" toast.

/** Convert "#RRGGBB" → decimal int (Discord's theme_colors API takes ints). */
function hexToInt(hex: string): number | null {
    const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    return parseInt(m[1], 16);
}

/** Fetch a remote URL's bytes and return as a base64 data URI suitable for
 *  Discord's `avatar` / `banner` PATCH fields. Routed through the dm-media://
 *  proxy because Chromium ORB blocks cross-origin no-CORS fetches in the
 *  renderer for arbitrary HTTPS hosts (same reason banner-video uses it). */
async function urlToDataUri(httpsUrl: string): Promise<string | null> {
    try {
        const proxied = httpsUrl.startsWith("https://")
            ? `dm-media://proxy/${encodeURIComponent(httpsUrl)}`
            : httpsUrl;
        const res = await fetch(proxied);
        if (!res.ok) {
            console.warn(`[DMProfileFlair] urlToDataUri ${httpsUrl} → ${res.status}`);
            return null;
        }
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn("[DMProfileFlair] urlToDataUri failed:", e);
        return null;
    }
}

/** Read a locally selected media file for a one-time Discord broadcast. The
 * file is intentionally kept in React state only: the roster contract stores
 * a short HTTPS URL, not arbitrary binary data, and we must not silently upload
 * personal files to a third-party host. */
async function blobToDataUri(blob: Blob): Promise<string | null> {
    try {
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn("[DMProfileFlair] blobToDataUri failed:", e);
        return null;
    }
}

/** Extract a usable error label from a Discord 4xx response. Specifically
 *  detects the "feature requires Nitro" shape so we can route to a tailored
 *  toast instead of a generic "save failed". */
function classifyDiscordError(err: any): { nitroRequired: boolean; label: string } {
    const body = err?.body ?? err?.response?.body ?? {};
    const code = body?.code;
    const message: string = body?.message ?? err?.message ?? "unknown";
    // Common "premium required" shapes Discord returns. The exact code/text
    // has moved around between client builds; check the union.
    const looksLikeNitro =
        code === 50001 ||
        code === 50054 ||
        /nitro|premium|boost|animated/i.test(message) ||
        /requires.*premium/i.test(message);
    return { nitroRequired: looksLikeNitro, label: message };
}

async function broadcastThemeColors(primaryHex: string, secondaryHex: string): Promise<boolean> {
    const p = hexToInt(primaryHex);
    const s = hexToInt(secondaryHex);
    if (p === null || s === null) {
        toast("Both theme colors must be valid #RRGGBB hex before broadcasting.", Toasts.Type.FAILURE, 5000);
        return false;
    }
    try {
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { theme_colors: [p, s] }
        });
        toast("✅ Theme colors written to your Discord profile. Note: Discord only RENDERS profile gradients for Nitro accounts, so non-Nitro / vanilla viewers won't see it. Other Discordmaxxer users see it in-app regardless.", Toasts.Type.SUCCESS, 8000);
        return true;
    } catch (e: any) {
        const { label } = classifyDiscordError(e);
        console.warn("[DMProfileFlair] broadcastThemeColors failed:", e);
        toast(`Broadcast failed: ${label}`, Toasts.Type.FAILURE, 6000);
        return false;
    }
}

// Extract a still PNG frame from an animated banner source (MP4/WEBM video,
// animated GIF, or static image). Pulls the source through the dm-media://
// proxy (Chromium ORB blocks arbitrary HTTPS in renderer fetch), then routes
// through a Blob URL into a <video> or <img>, draws to a canvas, and emits
// a PNG data URI suitable for Discord's banner PATCH field.
//
// Why we need this: DMProfileFlair's `myBannerUrl` can be an MP4/WEBM video.
// Discord's banner endpoint accepts image formats only (no video), so the
// existing "broadcast banner" path can't upload an animated source as-is.
// This converts the first usable frame into PNG bytes Discord will accept
// (Nitro permitting, server-side).
async function extractStillFrameFromUrl(httpsUrl: string): Promise<string | null> {
    try {
        const proxied = httpsUrl.startsWith("https://")
            ? `dm-media://proxy/${encodeURIComponent(httpsUrl)}`
            : httpsUrl;
        const res = await fetch(proxied);
        if (!res.ok) {
            console.warn(`[DMProfileFlair] extractStillFrame fetch failed: ${res.status}`);
            return null;
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const mime = blob.type || "";
        try {
            return mime.startsWith("video/")
                ? await drawVideoFirstFrame(blobUrl)
                : await drawImageFirstFrame(blobUrl);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    } catch (e) {
        console.warn("[DMProfileFlair] extractStillFrameFromUrl failed:", e);
        return null;
    }
}

async function extractStillFrameFromBlob(blob: Blob, isVideo = false): Promise<string | null> {
    const blobUrl = URL.createObjectURL(blob);
    try {
        return isVideo || blob.type.startsWith("video/")
            ? await drawVideoFirstFrame(blobUrl)
            : await drawImageFirstFrame(blobUrl);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

function drawVideoFirstFrame(blobUrl: string): Promise<string | null> {
    return new Promise(resolve => {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        let settled = false;
        const finish = (out: string | null) => { if (!settled) { settled = true; resolve(out); } };
        v.onloadeddata = () => {
            try {
                const c = document.createElement("canvas");
                c.width = v.videoWidth || 600;
                c.height = v.videoHeight || 240;
                const ctx = c.getContext("2d");
                if (!ctx) return finish(null);
                ctx.drawImage(v, 0, 0);
                finish(c.toDataURL("image/png"));
            } catch (e) {
                console.warn("[DMProfileFlair] drawVideoFirstFrame draw failed:", e);
                finish(null);
            }
        };
        v.onerror = () => finish(null);
        setTimeout(() => finish(null), 10000); // hard timeout — Discord PATCH path doesn't deserve to hang
        v.src = blobUrl;
    });
}

function drawImageFirstFrame(blobUrl: string): Promise<string | null> {
    return new Promise(resolve => {
        const img = new Image();
        let settled = false;
        const finish = (out: string | null) => { if (!settled) { settled = true; resolve(out); } };
        img.onload = () => {
            try {
                const c = document.createElement("canvas");
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                const ctx = c.getContext("2d");
                if (!ctx) return finish(null);
                ctx.drawImage(img, 0, 0);
                finish(c.toDataURL("image/png"));
            } catch (e) {
                console.warn("[DMProfileFlair] drawImageFirstFrame draw failed:", e);
                finish(null);
            }
        };
        img.onerror = () => finish(null);
        setTimeout(() => finish(null), 10000);
        img.src = blobUrl;
    });
}

// ─── Recent-picks history ──────────────────────────────────────────────
// Mirrors Discord's "your recent avatars" quick-pick. We keep the last
// MAX_RECENTS values per channel (banner / avatar / color-pair), stored as
// a single stringified-JSON object in `recentPicksJson` so we don't need
// three more Vencord settings. Pushed on Save (after validation passes);
// surfaced as a thumbnail row in FlairEditor.
const MAX_RECENTS = 5;
interface RecentPicks { banners: string[]; avatars: string[]; colors: string[]; }
function readRecentPicks(): RecentPicks {
    try {
        const raw = JSON.parse(settings.store.recentPicksJson || "{}");
        return {
            banners: Array.isArray(raw.banners) ? raw.banners.filter((x: any) => typeof x === "string").slice(0, MAX_RECENTS) : [],
            avatars: Array.isArray(raw.avatars) ? raw.avatars.filter((x: any) => typeof x === "string").slice(0, MAX_RECENTS) : [],
            colors:  Array.isArray(raw.colors)  ? raw.colors.filter((x: any) => typeof x === "string").slice(0, MAX_RECENTS)  : []
        };
    } catch {
        return { banners: [], avatars: [], colors: [] };
    }
}
function writeRecentPicks(next: RecentPicks): void {
    settings.store.recentPicksJson = JSON.stringify(next);
}
function pushRecent(arr: string[], value: string): string[] {
    if (!value || !value.trim()) return arr;
    const trimmed = value.trim();
    const deduped = arr.filter(x => x !== trimmed);
    return [trimmed, ...deduped].slice(0, MAX_RECENTS);
}
function recordRecentPicks(banner: string, avatar: string, primary: string, secondary: string): void {
    const current = readRecentPicks();
    const next: RecentPicks = {
        banners: pushRecent(current.banners, banner),
        avatars: pushRecent(current.avatars, avatar),
        colors:  (primary && secondary) ? pushRecent(current.colors, `${primary}|${secondary}`) : current.colors
    };
    writeRecentPicks(next);
}

// ─── Portable profile-look sharing ─────────────────────────────────────
// Share codes carry cosmetic settings only. Claim codes, Discord ids, tier
// state, and worker/account data never enter this payload. Vencord's Settings
// proxy is used for writes so imported theme/presence values persist and fire
// their normal plugin onChange handlers.
function readPlainPluginSettings(name: string): Record<string, any> {
    return ((globalThis as any).Vencord?.PlainSettings?.plugins?.[name] ?? {}) as Record<string, any>;
}

function readProfileLookConfig(): Omit<ProfileLookConfig, "version"> {
    const theme = readPlainPluginSettings("DMTheme");
    const presence = readPlainPluginSettings("DMPresence");
    const s = settings.store;
    const primary = normalizeColor(s.myThemeColorPrimary) ?? undefined;
    const secondary = normalizeColor(s.myThemeColorSecondary) ?? undefined;

    return {
        flair: {
            ...(s.myBannerUrl.trim() ? { bannerUrl: s.myBannerUrl.trim() } : {}),
            ...(s.myAvatarAnimatedUrl.trim() ? { avatarAnimatedUrl: s.myAvatarAnimatedUrl.trim() } : {}),
            ...(primary ? { themeColorPrimary: primary } : {}),
            ...(secondary ? { themeColorSecondary: secondary } : {})
        },
        theme: {
            ...(typeof theme.selected === "string" ? { selected: theme.selected } : {}),
            ...(typeof theme.enableFlair === "boolean" ? { enableFlair: theme.enableFlair } : {})
        },
        presence: {
            ...(typeof presence.enabled === "boolean" ? { enabled: presence.enabled } : {}),
            ...(typeof presence.activityType === "string" ? { activityType: presence.activityType } : {}),
            ...(typeof presence.name === "string" ? { name: presence.name } : {}),
            ...(typeof presence.details === "string" ? { details: presence.details } : {}),
            ...(typeof presence.state === "string" ? { state: presence.state } : {}),
            ...(typeof presence.showElapsed === "boolean" ? { showElapsed: presence.showElapsed } : {}),
            ...(typeof presence.showButton === "boolean" ? { showButton: presence.showButton } : {})
        }
    };
}

function writeVencordSetting(plugin: string, key: string, value: unknown, skipped: Set<string>): boolean {
    const target = (globalThis as any).Vencord?.Settings?.plugins?.[plugin];
    if (!target) {
        skipped.add(plugin);
        return false;
    }
    try {
        target[key] = value;
        return true;
    } catch (e) {
        console.warn(`[DMProfileFlair] profile-look setting ${plugin}.${key} failed:`, e);
        skipped.add(plugin);
        return false;
    }
}

function applyProfileLookConfig(config: ProfileLookConfig, only?: keyof ProfileFlair): { changed: number; skipped: string[] } {
    const s = settings.store;
    const skipped = new Set<string>();
    let changed = 0;
    const flair: ProfileLookConfig["flair"] = only
        ? { [only]: config.flair?.[only] }
        : config.flair ?? {};
    // Share codes are patches, not destructive full-state restores. A
    // banner-only code must not blank the recipient's avatar, and a full look
    // with an intentionally omitted field should leave that field alone.
    if (flair.bannerUrl !== undefined) {
        s.myBannerUrl = flair.bannerUrl;
        changed++;
    }
    if (flair.avatarAnimatedUrl !== undefined) {
        s.myAvatarAnimatedUrl = flair.avatarAnimatedUrl;
        changed++;
    }
    if (flair.themeColorPrimary !== undefined) {
        s.myThemeColorPrimary = flair.themeColorPrimary;
        changed++;
    }
    if (flair.themeColorSecondary !== undefined) {
        s.myThemeColorSecondary = flair.themeColorSecondary;
        changed++;
    }
    const theme = only ? undefined : config.theme;
    if (theme) {
        if (theme.selected !== undefined && writeVencordSetting("DMTheme", "selected", theme.selected, skipped)) changed++;
        if (theme.enableFlair !== undefined && writeVencordSetting("DMTheme", "enableFlair", theme.enableFlair, skipped)) changed++;
    }
    const presence = only ? undefined : config.presence;
    if (presence) {
        for (const key of ["enabled", "activityType", "name", "details", "state", "showElapsed", "showButton"] as const) {
            const value = presence[key];
            if (value !== undefined && writeVencordSetting("DMPresence", key, value, skipped)) changed++;
        }
    }
    return { changed, skipped: [...skipped] };
}

async function copyProfileLookCode(code: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(code);
        return true;
    } catch {
        return false;
    }
}

async function broadcastStillBanner(animatedUrl: string): Promise<boolean> {
    if (!URL_RE.test(animatedUrl)) {
        toast("Set a valid banner URL above before extracting a still frame.", Toasts.Type.FAILURE, 5000);
        return false;
    }
    const pageHint = detectPageHostMistake(animatedUrl);
    if (pageHint) { toast(pageHint, Toasts.Type.FAILURE, 8000); return false; }
    toast("Extracting still frame from your animated banner…", Toasts.Type.MESSAGE, 3000);
    const dataUri = await extractStillFrameFromUrl(animatedUrl);
    if (!dataUri) {
        toast("Couldn't extract a still frame — verify the banner URL is a direct image/video link.", Toasts.Type.FAILURE, 6000);
        return false;
    }
    try {
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { banner: dataUri }
        });
        toast("✅ Discord accepted the still-frame banner upload. Visibility still follows Discord's Nitro rules.", Toasts.Type.SUCCESS, 6000);
        return true;
    } catch (e: any) {
        const { nitroRequired, label } = classifyDiscordError(e);
        console.warn("[DMProfileFlair] broadcastStillBanner failed:", e);
        if (nitroRequired) {
            toast(
                "⚠ Discord requires Nitro to upload any banner — even a static image. The still frame extracted, but Discord rejected the upload server-side.",
                Toasts.Type.FAILURE, 8000
            );
        } else {
            toast(`Still banner broadcast failed: ${label}`, Toasts.Type.FAILURE, 6000);
        }
        return false;
    }
}

async function broadcastAvatar(url: string): Promise<boolean> {
    if (!URL_RE.test(url)) {
        toast("Avatar needs a direct HTTPS media URL of 250 characters or fewer before broadcasting.", Toasts.Type.FAILURE, 5000);
        return false;
    }
    const pageHint = detectPageHostMistake(url);
    if (pageHint) { toast(pageHint, Toasts.Type.FAILURE, 8000); return false; }
    toast("Downloading avatar bytes…", Toasts.Type.MESSAGE, 3000);
    const dataUri = await urlToDataUri(url);
    if (!dataUri) {
        toast("Couldn't download the avatar URL. Verify it's a direct image link (not a webpage).", Toasts.Type.FAILURE, 6000);
        return false;
    }
    try {
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { avatar: dataUri }
        });
        toast("✅ Avatar broadcast to your real Discord profile.", Toasts.Type.SUCCESS, 5000);
        return true;
    } catch (e: any) {
        const { nitroRequired, label } = classifyDiscordError(e);
        console.warn("[DMProfileFlair] broadcastAvatar failed:", e);
        if (nitroRequired) {
            toast(
                "⚠ Nitro required for an animated/GIF avatar. A static PNG/JPG would upload fine on free.",
                Toasts.Type.FAILURE, 8000
            );
        } else {
            toast(`Avatar broadcast failed: ${label}`, Toasts.Type.FAILURE, 6000);
        }
        return false;
    }
}

async function broadcastBanner(url: string): Promise<boolean> {
    if (!URL_RE.test(url)) {
        toast("Banner needs a direct HTTPS media URL of 250 characters or fewer before broadcasting.", Toasts.Type.FAILURE, 5000);
        return false;
    }
    const pageHint = detectPageHostMistake(url);
    if (pageHint) { toast(pageHint, Toasts.Type.FAILURE, 8000); return false; }
    toast("Downloading banner bytes…", Toasts.Type.MESSAGE, 3000);
    const dataUri = await urlToDataUri(url);
    if (!dataUri) {
        toast("Couldn't download the banner URL. Verify it's a direct image link (not a webpage).", Toasts.Type.FAILURE, 6000);
        return false;
    }
    try {
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { banner: dataUri }
        });
        toast("✅ Banner broadcast to your real Discord profile.", Toasts.Type.SUCCESS, 5000);
        return true;
    } catch (e: any) {
        const { nitroRequired, label } = classifyDiscordError(e);
        console.warn("[DMProfileFlair] broadcastBanner failed:", e);
        if (nitroRequired) {
            toast(
                "⚠ Nitro required for a Discord banner upload. For a no-Nitro identity, set your flair in Discordmaxxer — other Discordmaxxer users see your banner + gradient in-app.",
                Toasts.Type.FAILURE, 8000
            );
        } else {
            toast(`Banner broadcast failed: ${label}`, Toasts.Type.FAILURE, 6000);
        }
        return false;
    }
}

async function broadcastAvatarDataUri(dataUri: string): Promise<boolean> {
    try {
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { avatar: dataUri }
        });
        toast("✅ Avatar sent to your real Discord profile.", Toasts.Type.SUCCESS, 5000);
        return true;
    } catch (e: any) {
        const { nitroRequired, label } = classifyDiscordError(e);
        console.warn("[DMProfileFlair] broadcastAvatarDataUri failed:", e);
        if (nitroRequired) {
            toast(
                "⚠ Nitro is required for an animated/GIF avatar. A static PNG/JPG would upload on free Discord.",
                Toasts.Type.FAILURE, 8000
            );
        } else {
            toast("Avatar broadcast failed: " + label, Toasts.Type.FAILURE, 6000);
        }
        return false;
    }
}

async function broadcastBannerDataUri(dataUri: string): Promise<boolean> {
    try {
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { banner: dataUri }
        });
        toast("✅ Banner sent to your real Discord profile.", Toasts.Type.SUCCESS, 5000);
        return true;
    } catch (e: any) {
        const { nitroRequired, label } = classifyDiscordError(e);
        console.warn("[DMProfileFlair] broadcastBannerDataUri failed:", e);
        if (nitroRequired) {
            toast(
                "⚠ Nitro is required for any Discord banner upload. The file was read locally, but Discord rejected the account update.",
                Toasts.Type.FAILURE, 8000
            );
        } else {
            toast("Banner broadcast failed: " + label, Toasts.Type.FAILURE, 6000);
        }
        return false;
    }
}

type LocalMediaKind = "banner" | "avatar";
interface LocalMediaSelection {
    kind: LocalMediaKind;
    name: string;
    mime: string;
    isVideo: boolean;
    file: File;
    previewUrl: string;
    dataUri: string;
}

const MAX_LOCAL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_LOCAL_VIDEO_BYTES = 15 * 1024 * 1024;

function isSupportedLocalMedia(file: File): boolean {
    if (/^image\/(gif|png|jpeg|webp)$/i.test(file.type)) return true;
    if (/^video\/(mp4|webm|quicktime)$/i.test(file.type)) return true;
    return /\.(gif|png|jpe?g|webp|mp4|webm|mov)$/i.test(file.name);
}

function FlairEditor() {
    const s = settings.store;
    const [busy, setBusy] = React.useState(false);
    const [shareCode, setShareCode] = React.useState("");
    const [shareImport, setShareImport] = React.useState("");
    const [shareMessage, setShareMessage] = React.useState("");
    const [restoreMessage, setRestoreMessage] = React.useState("");
    const [localMedia, setLocalMedia] = React.useState<Partial<Record<LocalMediaKind, LocalMediaSelection>>>({});
    const bannerFileInput = React.useRef<HTMLInputElement>(null);
    const avatarFileInput = React.useRef<HTMLInputElement>(null);
    // Track TM state live so the warning notice flips on/off without a panel
    // reopen. Cheap interval — every 2s is plenty, TM toggles are user-driven.
    const [tmActive, setTmActive] = React.useState(isTournamentModeActive());
    React.useEffect(() => {
        const id = window.setInterval(() => {
            const now = isTournamentModeActive();
            setTmActive(prev => (prev === now ? prev : now));
        }, 2000);
        return () => clearInterval(id);
    }, []);

    React.useEffect(() => {
        return () => {
            Object.values(localMedia).forEach(media => {
                if (media) URL.revokeObjectURL(media.previewUrl);
            });
        };
    }, [localMedia]);

    const onPickLocalFile = async (kind: LocalMediaKind, file: File) => {
        if (!isSupportedLocalMedia(file)) {
            toast("Choose a GIF, PNG, JPG, WEBP, MP4, or WEBM file.", Toasts.Type.FAILURE, 5000);
            return;
        }
        const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(file.name);
        const maxBytes = isVideo
            ? MAX_LOCAL_VIDEO_BYTES
            : MAX_LOCAL_IMAGE_BYTES;
        if (file.size > maxBytes) {
            toast(
                (kind === "banner" ? "Banner" : "Avatar") + " files must be under " +
                (maxBytes === MAX_LOCAL_VIDEO_BYTES ? "15 MB for video or 5 MB for images." : "5 MB for images."),
                Toasts.Type.FAILURE, 6000
            );
            return;
        }
        const dataUri = await blobToDataUri(file);
        if (!dataUri) {
            toast("Couldn't read that file.", Toasts.Type.FAILURE, 5000);
            return;
        }
        const previewUrl = URL.createObjectURL(file);
        setLocalMedia(previous => {
            const old = previous[kind];
            if (old) URL.revokeObjectURL(old.previewUrl);
            return {
                ...previous,
                [kind]: { kind, name: file.name, mime: file.type, isVideo, file, previewUrl, dataUri }
            };
        });
        toast(
            (kind === "banner" ? "Banner" : "Avatar") +
            " file ready for this session. It is not uploaded to the roster.",
            Toasts.Type.SUCCESS, 4500
        );
    };

    const onRestorePublishedLook = async () => {
        setBusy(true);
        setRestoreMessage("Refreshing your saved Discordmaxxer look…");
        try {
            await refreshRoster();
            const me = UserStore.getCurrentUser?.();
            const saved = me?.id ? getRosterProfileFlair(me.id) : undefined;
            if (!saved || !Object.keys(saved).length) {
                setRestoreMessage(
                    "No saved roster look was found. If the old PC never saved this look to Discordmaxxer, only that old install can still have the URL."
                );
                return;
            }
            let restored = 0;
            if (saved.bannerUrl !== undefined) { s.myBannerUrl = saved.bannerUrl; restored++; }
            if (saved.avatarAnimatedUrl !== undefined) { s.myAvatarAnimatedUrl = saved.avatarAnimatedUrl; restored++; }
            if (saved.themeColorPrimary !== undefined) { s.myThemeColorPrimary = saved.themeColorPrimary; restored++; }
            if (saved.themeColorSecondary !== undefined) { s.myThemeColorSecondary = saved.themeColorSecondary; restored++; }
            setRestoreMessage(
                "Restored " + restored + " saved field" + (restored === 1 ? "" : "s") +
                " from the Discordmaxxer roster. Nothing was changed on your real Discord profile."
            );
        } catch (e) {
            console.warn("[DMProfileFlair] restore published look failed:", e);
            setRestoreMessage("Could not refresh the shared roster. Your published look was not changed.");
        } finally {
            setBusy(false);
        }
    };

    const onBroadcastLocal = async (kind: LocalMediaKind, stillFrame: boolean) => {
        const media = localMedia[kind];
        if (!media) return;
        const label = kind === "avatar" ? "avatar" : stillFrame ? "still-frame banner" : "banner";
        if (!confirm(broadcastConfirmCopy(label, stillFrame
            ? "We'll extract the first frame locally, then send one PNG upload to your real Discord profile. Discord banners still require Nitro."
            : "This sends the selected file once to your real Discord profile. It does not save the file to the Discordmaxxer roster."))) return;
        setBusy(true);
        try {
            if (kind === "avatar") {
                await broadcastAvatarDataUri(media.dataUri);
            } else if (stillFrame || media.isVideo) {
                toast("Extracting the first frame locally…", Toasts.Type.MESSAGE, 3000);
                const dataUri = await extractStillFrameFromBlob(media.file, media.isVideo);
                if (!dataUri) {
                    toast("Couldn't extract a frame from that file.", Toasts.Type.FAILURE, 6000);
                } else {
                    await broadcastBannerDataUri(dataUri);
                }
            } else {
                await broadcastBannerDataUri(media.dataUri);
            }
        } finally {
            setBusy(false);
        }
    };

    const onSave = async () => {
        // Normalize colors before sending — the worker validates strict
        // `#RRGGBB`. normalizeColor accepts bare hex, 0x-prefix, 3-digit
        // shorthand, etc and emits canonical lowercase #rrggbb. If a user
        // entered garbage that can't be normalized we let validateLocal
        // surface a friendly error.
        const normalizeForSave = (raw: string): string => {
            const trimmed = raw.trim();
            if (!trimmed) return "";  // empty = clear the field
            const n = normalizeColor(trimmed);
            return n ?? trimmed;       // pass through unchanged so validation catches it
        };
        const proposed: Partial<ProfileFlair> = {};
        const banner = s.myBannerUrl.trim();
        const avatar = s.myAvatarAnimatedUrl.trim();
        const primary = normalizeForSave(s.myThemeColorPrimary);
        const secondary = normalizeForSave(s.myThemeColorSecondary);
        // Save is merge-only. A new PC may not have the old avatar URL in its
        // local settings yet; editing the banner must not erase the published
        // avatar. Explicit clear buttons below handle deletion field by field.
        if (banner) proposed.bannerUrl = banner;
        if (avatar) proposed.avatarAnimatedUrl = avatar;
        if (primary) proposed.themeColorPrimary = primary;
        if (secondary) proposed.themeColorSecondary = secondary;
        if (!Object.keys(proposed).length) {
            toast("There is nothing new to save. Use Restore my published look or an explicit Clear button.", Toasts.Type.MESSAGE, 5000);
            return;
        }
        const err = validateLocal(proposed);
        if (err) { toast(err, Toasts.Type.FAILURE, 5000); return; }
        setBusy(true);
        const ok = await postFlairUpdate(proposed, false);
        if (ok) {
            // Push the just-saved values to the recents history so Diggy can
            // swap back like Discord's recent-avatars picker.
            recordRecentPicks(
                proposed.bannerUrl || "",
                proposed.avatarAnimatedUrl || "",
                proposed.themeColorPrimary || "",
                proposed.themeColorSecondary || ""
            );
        }
        setBusy(false);
    };

    const onClearField = async (field: "bannerUrl" | "avatarAnimatedUrl") => {
        const label = field === "bannerUrl" ? "banner" : "animated avatar";
        if (!confirm("Clear only your saved " + label + "? Your other flair stays unchanged.")) return;
        setBusy(true);
        const update: Partial<ProfileFlair> = field === "bannerUrl"
            ? { bannerUrl: "" }
            : { avatarAnimatedUrl: "" };
        const ok = await postFlairUpdate(update, false);
        if (ok) {
            if (field === "bannerUrl") s.myBannerUrl = "";
            else s.myAvatarAnimatedUrl = "";
        }
        setBusy(false);
    };

    const onClearAll = async () => {
        if (!confirm("Clear all your custom profile flair (banner, avatar, colors)?")) return;
        setBusy(true);
        const ok = await postFlairUpdate({}, true);
        if (ok) {
            s.myBannerUrl = "";
            s.myAvatarAnimatedUrl = "";
            s.myThemeColorPrimary = "";
            s.myThemeColorSecondary = "";
        }
        setBusy(false);
    };

    const onCreateProfileLookShare = async (only?: keyof ProfileFlair) => {
        try {
            const current = readProfileLookConfig();
            if (only && current.flair[only] === undefined) {
                setShareMessage("Set a " + (only === "bannerUrl" ? "banner" : "animated avatar") + " first.");
                return;
            }
            const flair: ProfileLookConfig["flair"] = only
                ? { [only]: current.flair[only] }
                : current.flair;
            const code = encodeProfileLook(only ? { flair } : current);
            setShareCode(code);
            const copied = await copyProfileLookCode(code);
            setShareMessage(copied
                ? (only ? "Copied a " + (only === "bannerUrl" ? "banner-only" : "avatar-only") + " code." : "Copied the full cosmetic look.")
                : "Code ready below. Clipboard access was unavailable, so copy it from the box.");
        } catch (e) {
            console.warn("[DMProfileFlair] profile-look encode failed:", e);
            setShareMessage("Could not create a profile-look code from the current settings.");
        }
    };

    const onImportProfileLookShare = (only?: keyof ProfileFlair) => {
        const decoded = decodeProfileLook(shareImport);
        if (!decoded.ok) {
            setShareMessage(decoded.error);
            return;
        }
        const result = applyProfileLookConfig(decoded.value, only);
        if (only && result.changed === 0) {
            setShareMessage("That code does not contain a " + (only === "bannerUrl" ? "banner" : "animated avatar") + ".");
            return;
        }
        setShareMessage(result.skipped.length
            ? `Imported ${result.changed} cosmetic fields. Enable ${result.skipped.join(" and ")} to apply every shared setting.`
            : `Imported ${result.changed} cosmetic fields. Click Save to Discordmaxxer to publish the flair fields to the roster.`);
        setShareImport("");
    };

    // ── Vanilla broadcast handlers ──────────────────────────────────────
    // Each handler does its own confirm() and then fires ONCE. We don't
    // batch all three into a single button because each touches a
    // different Discord profile field with different Nitro requirements —
    // batching would conflate the "Nitro required" error and make it
    // ambiguous which field caused the failure.
    const broadcastConfirmCopy = (kind: "theme colors" | "avatar" | "banner" | "still-frame banner", extra = "") =>
        `Broadcast your ${kind} to your REAL Discord profile?\n\n` +
        `This sets the value on your actual Discord account. Whether non-modded ("vanilla") Discord users actually SEE it depends on the field — read the per-field note below.\n\n` +
        `We only PATCH once when you click. We never re-assert if you change it back via Discord Settings → Profiles.\n\n` +
        (extra ? `${extra}\n\n` : "") +
        `⚠ Heads up: this technically crosses the same TOS gray-area line as DMBadge's bio/pronouns toggles (Discord forbids third-party clients automating account-level actions). One-click-on-your-consent + no re-assert is what we believe keeps it on the 'tool' side vs 'self-bot'. Enforcement against personal use is rare, but flip with eyes open.`;

    const onBroadcastColors = async () => {
        const p = s.myThemeColorPrimary.trim();
        const sec = s.myThemeColorSecondary.trim();
        if (!p || !sec) {
            toast("Set both primary + secondary theme colors before broadcasting.", Toasts.Type.FAILURE, 5000);
            return;
        }
        if (!confirm(broadcastConfirmCopy("theme colors", "⚠ Discord only RENDERS profile gradients for Nitro accounts. Without Nitro the write may go through, but vanilla / non-Nitro viewers still see your default — they will NOT see this gradient. Other Discordmaxxer users always see it in-app (no Nitro needed)."))) return;
        setBusy(true);
        await broadcastThemeColors(p, sec);
        setBusy(false);
    };

    const onBroadcastStillBanner = async () => {
        const u = s.myBannerUrl.trim();
        if (!u) {
            toast("Set your animated banner URL above before extracting a still.", Toasts.Type.FAILURE, 5000);
            return;
        }
        if (!confirm(broadcastConfirmCopy("still-frame banner",
            "We'll extract the first frame of your animated banner (MP4 / WEBM / GIF / static image), " +
            "convert it to a PNG, and upload that to your real Discord profile. Vanilla viewers will see " +
            "the still image as your banner.\n\n" +
            "⚠ Discord requires Nitro to upload ANY banner — even a static one. Without Nitro the PATCH " +
            "fails server-side and we'll surface a clear error."
        ))) return;
        setBusy(true);
        await broadcastStillBanner(u);
        setBusy(false);
    };

    const onBroadcastAvatar = async () => {
        const u = s.myAvatarAnimatedUrl.trim();
        if (!u) {
            toast("Set an avatar URL above before broadcasting.", Toasts.Type.FAILURE, 5000);
            return;
        }
        if (!confirm(broadcastConfirmCopy("avatar", "ℹ Static PNG/JPG works on free Discord. Animated GIF requires Nitro — Discord will reject the upload otherwise (we'll surface the error)."))) return;
        setBusy(true);
        await broadcastAvatar(u);
        setBusy(false);
    };

    const onBroadcastBanner = async () => {
        const u = s.myBannerUrl.trim();
        if (!u) {
            toast("Set a banner URL above before broadcasting.", Toasts.Type.FAILURE, 5000);
            return;
        }
        if (!confirm(broadcastConfirmCopy("banner", "⚠ Discord banners require Nitro for any user. Without Nitro this PATCH will fail (we'll show a clear error). For a no-Nitro identity, set your flair in Discordmaxxer instead — other Discordmaxxer users see your banner + gradient in-app."))) return;
        setBusy(true);
        await broadcastBanner(u);
        setBusy(false);
    };

    const wrapStyle: React.CSSProperties = {
        marginTop: 12, padding: "12px 14px",
        background: "rgba(226, 91, 255, 0.05)",
        border: "1px solid rgba(226, 91, 255, 0.25)",
        borderRadius: 8
    };
    const titleStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "#fbefff", marginBottom: 8 };
    const noteStyle: React.CSSProperties = { fontSize: 11.5, color: "#cbd0e0", opacity: 0.85, marginBottom: 8 };
    const btnRow: React.CSSProperties = { display: "flex", gap: 8, marginTop: 8 };
    const fileWrapStyle: React.CSSProperties = {
        marginTop: 12, padding: "10px 11px",
        background: "rgba(72, 184, 255, 0.06)",
        border: "1px solid rgba(72, 184, 255, 0.24)",
        borderRadius: 7
    };
    const fileRowStyle: React.CSSProperties = {
        display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 7
    };
    const localMediaStyle: React.CSSProperties = {
        display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
        marginTop: 8, padding: "7px 8px",
        background: "rgba(0, 0, 0, 0.18)", borderRadius: 6
    };
    const localPreviewStyle: React.CSSProperties = {
        width: 84, height: 34, objectFit: "cover", borderRadius: 4, background: "#17131d"
    };

    const tmWarnStyle: React.CSSProperties = {
        marginBottom: 10, padding: "8px 10px",
        background: "rgba(255, 200, 60, 0.12)",
        border: "1px solid rgba(255, 200, 60, 0.45)",
        borderRadius: 6,
        color: "#ffe9a8", fontSize: 12, lineHeight: 1.45
    };

    const broadcastWrapStyle: React.CSSProperties = {
        marginTop: 14, paddingTop: 12,
        borderTop: "1px dashed rgba(226, 91, 255, 0.35)"
    };
    const broadcastTitleStyle: React.CSSProperties = {
        fontSize: 13, fontWeight: 700, color: "#fbefff", marginBottom: 6
    };
    const broadcastNoteStyle: React.CSSProperties = {
        fontSize: 11.5, color: "#cbd0e0", opacity: 0.85, marginBottom: 10, lineHeight: 1.5
    };
    const broadcastBtnRow: React.CSSProperties = {
        display: "flex", flexDirection: "column", gap: 6, marginTop: 8
    };

    const shareWrapStyle: React.CSSProperties = {
        marginTop: 14, paddingTop: 12,
        borderTop: "1px dashed rgba(226, 91, 255, 0.35)"
    };
    const shareInputStyle: React.CSSProperties = {
        width: "100%", boxSizing: "border-box", marginTop: 6,
        padding: "7px 8px", borderRadius: 5,
        border: "1px solid rgba(226, 91, 255, 0.35)",
        background: "rgba(0, 0, 0, 0.22)", color: "#fbefff",
        fontSize: 11, fontFamily: "monospace", resize: "vertical"
    };

    // ── Recent picks UI — Discord-style quick-pick history ─────────────────
    const recents = readRecentPicks();
    const hasAnyRecents = recents.banners.length > 0 || recents.avatars.length > 0 || recents.colors.length > 0;

    const recentsWrap: React.CSSProperties = {
        marginBottom: 12, paddingBottom: 10,
        borderBottom: "1px dashed rgba(226, 91, 255, 0.35)"
    };
    const recentsRowStyle: React.CSSProperties = {
        display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap"
    };
    const recentsLabelStyle: React.CSSProperties = {
        fontSize: 11, fontWeight: 600, color: "#cbd0e0", minWidth: 60
    };
    const thumbButtonStyle: React.CSSProperties = {
        background: "transparent", border: "1px solid rgba(226, 91, 255, 0.35)",
        borderRadius: 4, padding: 1, cursor: "pointer", display: "inline-flex"
    };
    const bannerThumbImg: React.CSSProperties = {
        width: 60, height: 24, objectFit: "cover", borderRadius: 3, display: "block",
        background: "#222"
    };
    const avatarThumbImg: React.CSSProperties = {
        width: 26, height: 26, objectFit: "cover", borderRadius: "50%", display: "block",
        background: "#222"
    };
    const colorSwatch = (p: string, s: string): React.CSSProperties => ({
        width: 26, height: 26, borderRadius: 4, display: "inline-block",
        background: `linear-gradient(180deg, ${p} 0%, ${s} 100%)`
    });

    return (
        <div style={wrapStyle}>
            <div style={titleStyle}>🎨 Save your custom flair</div>

            {hasAnyRecents && (
                <div style={recentsWrap}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#fbefff", marginBottom: 4 }}>
                        ⏱ Recent picks <span style={{ fontSize: 10.5, opacity: 0.7, fontWeight: 400 }}>— click to re-apply (then hit Save again to push to roster)</span>
                    </div>
                    {recents.banners.length > 0 && (
                        <div style={recentsRowStyle}>
                            <span style={recentsLabelStyle}>Banner:</span>
                            {recents.banners.map(url => (
                                <button
                                    key={url}
                                    title={url}
                                    style={thumbButtonStyle}
                                    onClick={() => { s.myBannerUrl = url; }}
                                >
                                    {/\.(mp4|webm|mov)(\?|$)/i.test(url)
                                        ? <span style={{ ...bannerThumbImg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>🎬</span>
                                        : <img src={url} alt="" style={bannerThumbImg} onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />}
                                </button>
                            ))}
                        </div>
                    )}
                    {recents.avatars.length > 0 && (
                        <div style={recentsRowStyle}>
                            <span style={recentsLabelStyle}>Avatar:</span>
                            {recents.avatars.map(url => (
                                <button
                                    key={url}
                                    title={url}
                                    style={thumbButtonStyle}
                                    onClick={() => { s.myAvatarAnimatedUrl = url; }}
                                >
                                    <img src={url} alt="" style={avatarThumbImg} onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                                </button>
                            ))}
                        </div>
                    )}
                    {recents.colors.length > 0 && (
                        <div style={recentsRowStyle}>
                            <span style={recentsLabelStyle}>Gradient:</span>
                            {recents.colors.map(pair => {
                                const [p, sec] = pair.split("|");
                                if (!p || !sec) return null;
                                return (
                                    <button
                                        key={pair}
                                        title={`${p} → ${sec}`}
                                        style={thumbButtonStyle}
                                        onClick={() => { s.myThemeColorPrimary = p; s.myThemeColorSecondary = sec; }}
                                    >
                                        <span style={colorSwatch(p, sec)} />
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {tmActive && (
                <div style={tmWarnStyle}>
                    🟡 <b>TournamentMode is currently active.</b> Your banner and animated avatar
                    will be <b>suppressed</b> in profile popouts until you toggle TM off (TM exists
                    to free up CPU/GPU, so animated content is paused by design). Theme colors
                    still render normally.
                </div>
            )}
            <div style={noteStyle}>
                <b>Discordmaxxer look:</b> these values are saved to the shared roster and
                rendered for every Discordmaxxer user, including you. These fields are
                per-install drafts until you click Save; the published roster is what
                determines the look on every PC. <b>Real Discord look:</b> the optional
                broadcast section below makes a separate one-time account change.
                Worker validates each roster field — banner needs MAXXER, animated avatar
                needs MAXXER+, theme colors need MAXXER++.
            </div>
            <div style={btnRow}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onSave} disabled={busy}>
                    💾 Save to Discordmaxxer
                </Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={onClearAll} disabled={busy}>
                    ✕ Clear all my flair
                </Button>
            </div>
            <div style={btnRow}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onRestorePublishedLook} disabled={busy}>
                    ↻ Restore my published look
                </Button>
            </div>
            <div style={btnRow}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => void onClearField("bannerUrl")} disabled={busy}>
                    Clear banner only
                </Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => void onClearField("avatarAnimatedUrl")} disabled={busy}>
                    Clear avatar only
                </Button>
            </div>
            {restoreMessage && <div style={{ ...noteStyle, marginTop: 7, marginBottom: 0 }}>{restoreMessage}</div>}

            <div style={fileWrapStyle}>
                <div style={titleStyle}>📁 Use a downloaded GIF, image, or video</div>
                <div style={noteStyle}>
                    Choose a local file for a preview or a one-time real-Discord broadcast.
                    The file stays on this PC and is <b>not</b> uploaded to the Discordmaxxer
                    roster. To share it across PCs or with other Discordmaxxer users, host it
                    somewhere that gives you a direct HTTPS media URL, then paste that URL above.
                </div>
                <div style={fileRowStyle}>
                    <input
                        ref={bannerFileInput}
                        type="file"
                        accept=".gif,.png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,image/gif,image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime"
                        style={{ display: "none" }}
                        onChange={e => {
                            const file = e.currentTarget.files?.[0];
                            e.currentTarget.value = "";
                            if (file) void onPickLocalFile("banner", file);
                        }}
                    />
                    <input
                        ref={avatarFileInput}
                        type="file"
                        accept=".gif,.png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,image/gif,image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime"
                        style={{ display: "none" }}
                        onChange={e => {
                            const file = e.currentTarget.files?.[0];
                            e.currentTarget.value = "";
                            if (file) void onPickLocalFile("avatar", file);
                        }}
                    />
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => bannerFileInput.current?.click()} disabled={busy}>
                        Choose banner file
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => avatarFileInput.current?.click()} disabled={busy}>
                        Choose avatar file
                    </Button>
                </div>
                {localMedia.banner && (
                    <div style={localMediaStyle}>
                        {localMedia.banner.isVideo
                            ? <video src={localMedia.banner.previewUrl} muted loop autoPlay playsInline style={localPreviewStyle} />
                            : <img src={localMedia.banner.previewUrl} alt="" style={localPreviewStyle} />}
                        <div style={{ flex: 1, minWidth: 170 }}>
                            <div style={{ fontSize: 11.5, color: "#fbefff", fontWeight: 700 }}>Banner file ready</div>
                            <div style={{ fontSize: 10.5, color: "#cbd0e0", opacity: 0.8 }}>{localMedia.banner.name}</div>
                            <div style={fileRowStyle}>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onBroadcastLocal("banner", false)} disabled={busy}>
                                    Send banner once
                                </Button>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onBroadcastLocal("banner", true)} disabled={busy}>
                                    Send first frame
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
                {localMedia.avatar && (
                    <div style={localMediaStyle}>
                        {localMedia.avatar.isVideo
                            ? <video src={localMedia.avatar.previewUrl} muted loop autoPlay playsInline style={{ ...localPreviewStyle, width: 44, height: 44, borderRadius: "50%" }} />
                            : <img src={localMedia.avatar.previewUrl} alt="" style={{ ...localPreviewStyle, width: 44, height: 44, borderRadius: "50%" }} />}
                        <div style={{ flex: 1, minWidth: 170 }}>
                            <div style={{ fontSize: 11.5, color: "#fbefff", fontWeight: 700 }}>Avatar file ready</div>
                            <div style={{ fontSize: 10.5, color: "#cbd0e0", opacity: 0.8 }}>{localMedia.avatar.name}</div>
                            <div style={fileRowStyle}>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onBroadcastLocal("avatar", false)} disabled={busy}>
                                    Send avatar once
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div style={shareWrapStyle}>
                <div style={broadcastTitleStyle}>🔗 Share your profile look</div>
                <div style={broadcastNoteStyle}>
                    Create a portable code for the whole cosmetic look, or copy just one field.
                    A banner-only code cannot overwrite the recipient's avatar or colors.
                    Codes contain cosmetic settings only — never your claim code, Discord account id,
                    tier, or worker credentials. Imported flair is local until you click Save to Discordmaxxer.
                </div>
                <div style={btnRow}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onCreateProfileLookShare} disabled={busy}>
                        📋 Copy full look
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onCreateProfileLookShare("bannerUrl")} disabled={busy}>
                        Copy banner only
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onCreateProfileLookShare("avatarAnimatedUrl")} disabled={busy}>
                        Copy avatar only
                    </Button>
                </div>
                {shareCode && (
                    <textarea
                        rows={3}
                        readOnly
                        value={shareCode}
                        style={shareInputStyle}
                        aria-label="Profile-look share code"
                        onFocus={e => e.currentTarget.select()}
                    />
                )}
                <input
                    value={shareImport}
                    onChange={e => setShareImport(e.currentTarget.value)}
                    placeholder="Paste a DMLOOK1:... code to import"
                    style={shareInputStyle}
                    aria-label="Paste profile-look share code"
                />
                <div style={btnRow}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onImportProfileLookShare} disabled={busy || !shareImport.trim()}>
                        ✨ Import full look
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => onImportProfileLookShare("bannerUrl")} disabled={busy || !shareImport.trim()}>
                        Import banner only
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => onImportProfileLookShare("avatarAnimatedUrl")} disabled={busy || !shareImport.trim()}>
                        Import avatar only
                    </Button>
                </div>
                {shareMessage && <div style={{ ...noteStyle, marginTop: 8, marginBottom: 0 }}>{shareMessage}</div>}
            </div>

            <div style={broadcastWrapStyle}>
                <div style={broadcastTitleStyle}>📡 Optional: update your real Discord profile</div>
                <div style={broadcastNoteStyle}>
                    The Save button above updates the <b>Discordmaxxer-only</b> look. These buttons
                    make a separate, one-time change to your <b>real Discord profile</b>; they do
                    not make the roster flair appear in vanilla Discord and never re-assert themselves.
                    <br /><br />
                    <b>Theme gradient:</b> Nitro-gated when Discord renders it. <b>Static avatar:</b>
                    normally works on free. <b>Animated avatar + any banner:</b> Discord requires Nitro.
                    A still-frame button only converts a GIF/video into a PNG; it does not bypass that requirement.
                </div>
                <div style={broadcastBtnRow}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastColors} disabled={busy}>
                        Set real Discord theme once
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastAvatar} disabled={busy}>
                        Set real Discord avatar once
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastBanner} disabled={busy}>
                        Set real Discord banner once
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastStillBanner} disabled={busy}>
                        Set banner's first frame once
                    </Button>
                </div>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    // ─── Setter side (your own flair) ─────────────────────────────────────
    myBannerUrl: {
        type: OptionType.STRING,
        description:
            "[Channel E · MAXXER] Paste a DIRECT HTTPS media URL, not a webpage. " +
            "The roster stores this short URL (maximum 250 characters), not the file itself. " +
            "Good: https://i.imgur.com/abc123.png. Bad: https://imgur.com/gallery/abc123. " +
            "For a downloaded GIF/image/video, use Choose banner file in the editor for a local preview or one-time Discord broadcast, " +
            "or host it somewhere that gives you a direct HTTPS media URL. Recommended: 600×240; images ≤5MB and videos ≤15MB. " +
            "This is a local draft until Save; profile rendering follows the shared roster on every PC. TournamentMode pauses custom banner rendering.",
        default: ""
    },
    myAvatarAnimatedUrl: {
        type: OptionType.STRING,
        description:
            "[Channel F · MAXXER+] Paste a DIRECT HTTPS media URL, not a webpage. " +
            "The roster stores the URL (maximum 250 characters), so a downloaded file must be hosted first for cross-PC sharing. " +
            "Use Choose avatar file in the editor for a local preview or one-time real-Discord broadcast. " +
            "Recommended size: 160×160 square. GIF/MP4 avatar rendering is suppressed while TournamentMode is active. " +
            "This is a local draft until Save; profile rendering follows the shared roster on every PC. Member-list/chat/voice replacement also requires you to have a custom Discord avatar rather than Discord's default wordmark.",
        default: ""
    },
    myThemeColorPrimary: {
        type: OptionType.STRING,
        description:
            "[Channel G · MAXXER++] Primary theme color — TOP of the profile gradient. " +
            "Accepts #RRGGBB, RRGGBB (no #), or 0xRRGGBB — auto-normalized. " +
            "Empty by default (no gradient) — pick a preset in the welcome screen or set your own here. " +
            "This is a local draft until Save; profile rendering follows the shared roster on every PC. Clear to remove your gradient.",
        default: ""
    },
    myThemeColorSecondary: {
        type: OptionType.STRING,
        description:
            "[Channel G · MAXXER++] Secondary theme color — BOTTOM of the profile gradient. " +
            "Accepts #RRGGBB, RRGGBB (no #), or 0xRRGGBB — auto-normalized. " +
            "Empty by default (no gradient) — paired with the primary above once both are set. This is a local draft until Save; profile rendering follows the shared roster on every PC.",
        default: ""
    },
    manualClaimCode: {
        type: OptionType.STRING,
        description:
            "Optional fallback: paste your VIP claim code (the MAXX-XXXX-XXXX-XXXX-XXXX you redeemed) here " +
            "if Save → 'Save to Discordmaxxer' tells you it can't find your binding. Discord disables " +
            "localStorage in modern builds which breaks the normal binding-read path; this setting is " +
            "persisted to disk via Vencord, so it survives. Auto-normalized (dashes + case ignored).",
        default: ""
    },
    // Hidden — JSON-stringified history of the last MAX_RECENTS values for
    // banner URL / avatar URL / color pair ("primary|secondary"). Pushed on
    // every successful Save in FlairEditor; surfaced as a quick-pick row at
    // the top of the editor so the user can swap back to a recent flair the
    // way Discord shows your last-uploaded avatars on the avatar picker.
    recentPicksJson: {
        type: OptionType.STRING,
        description: "(hidden) JSON history of recent flair picks — managed by the editor's Save button.",
        default: "{}"
    },
    editor: {
        type: OptionType.COMPONENT,
        description: "",
        component: FlairEditor
    },

    // ─── Viewer side (rendering others' flair) ────────────────────────────
    showOthersFlair: {
        type: OptionType.BOOLEAN,
        description:
            "Master toggle — render custom profile flair set by other Discordmaxxer users. " +
            "Default ON. Flip off if you'd rather just see stock Discord profiles for everyone.",
        default: true
    },
    showOthersBanner: {
        type: OptionType.BOOLEAN,
        description: "Render other users' custom banners.",
        default: true
    },
    showOthersAvatar: {
        type: OptionType.BOOLEAN,
        description: "Render other users' animated avatars.",
        default: true
    },
    showOthersThemeColors: {
        type: OptionType.BOOLEAN,
        description: "Render other users' profile gradient colors.",
        default: true
    }
});

// ─── Render hooks ──────────────────────────────────────────────────────────
// MutationObserver finds profile popouts, reads the user inside, applies
// background-image as an inline style directly on the banner element
// (inline `!important` beats every stylesheet rule no matter the specificity).
// No CSS-variable indirection. Diagnostics object surfaces live state in the
// settings panel so we can see what the observer is seeing without devtools.

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let rescanTimer: number | null = null;
let defaultAvatarWarned = false;
let removeRosterListener: (() => void) | null = null;


/** True if a URL ends in a typical video extension. Used to decide whether to
 *  render as background-image (image) or as a <video> overlay (video). Pure
 *  string heuristic — Content-Type would be more reliable but needs a HEAD
 *  request before render which we'd rather avoid for popout-open latency. */
function isVideoUrl(url: string): boolean {
    return /\.(mp4|webm|mov)(\?|#|$)/i.test(url);
}

/** Wrap an HTTPS video URL through the dm-media:// proxy (registered in
 *  main/dmMediaProxy.ts) to bypass Chromium's Opaque Response Blocking.
 *  ORB blocks cross-origin no-CORS video at the network-service layer
 *  regardless of CSP or response-header injection. The proxy fetches the
 *  bytes from MAIN process (no ORB) and serves them through a same-origin
 *  custom scheme. Already-proxied URLs and non-HTTPS URLs pass through. */
function proxyVideoUrl(url: string): string {
    if (!/^https:\/\//i.test(url)) return url;
    if (url.startsWith("dm-media:")) return url;
    // Use a host segment (`proxy`) because Chromium's <video> URL safety
    // check rejects host-less custom-scheme URLs ("dm-media:///path").
    return `dm-media://proxy/${encodeURIComponent(url)}`;
}

/** True if URL is any animated format (video OR animated image). Drives the
 *  TournamentMode suppression — we want all decode/compositing-cost banners
 *  paused during gaming, not just videos. */
function isAnimatedUrl(url: string): boolean {
    return /\.(mp4|webm|mov|gif|apng)(\?|#|$)/i.test(url);
}

function buildCss(): string {
    return `
        /* Hide Discord's stock banner <img> when we've painted ours over the
           container. The data-attr is set inline by tagPopout. */
        [data-dm-flair-banner-applied] > img:first-child {
            visibility: hidden !important;
        }
        /* Video banner overlay — covers the banner area, click-through, low
           paint cost (one composited surface). */
        .dm-flair-banner-video {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            object-position: center;
            pointer-events: none;
            z-index: 1;
        }

    `;
}

/** Find all profile banner elements page-wide. Modern Discord uses
 *  `banner__<hash>` (verified `banner__68edb` for both the small popout
 *  banner and the full-profile-view banner). Filter by size to skip small
 *  decorative banner SVGs. */
function findAllProfileBanners(): HTMLElement[] {
    const out: HTMLElement[] = [];
    document.querySelectorAll('[class*="banner__"], [class*="profileBanner"], [class*="userProfileBanner"]').forEach(c => {
        const el = c as HTMLElement;
        const r = el.getBoundingClientRect();
        // Real profile banners are ≥200px wide and ≥50px tall. Smaller hits
        // are typically status icons or decorative graphics.
        if (r.width >= 200 && r.height >= 50) {
            out.push(el);
        }
    });
    return out;
}

/** Find every IMG on the page whose src points at the given userId's avatar
 *  on Discord's CDN. Catches all surfaces: profile popout, full profile,
 *  member list rows, chat message authors, voice channel users, DM channel
 *  headers, etc. Discord's URL shape is stable:
 *    https://cdn.discordapp.com/avatars/<userId>/<hash>.<ext>?size=...
 *  We also accept the path-relative form Discord occasionally uses
 *  (`/assets/...`) — but those are anonymous defaults so we skip them.
 *  Returns ALL imgs by user; the caller decides whether to swap them all
 *  for a roster user. */
function findAvatarImgsForUser(userId: string): HTMLImageElement[] {
    if (!userId) return [];
    const out: HTMLImageElement[] = [];
    const needle = `/avatars/${userId}/`;
    document.querySelectorAll("img").forEach(img => {
        const el = img as HTMLImageElement;
        const src = el.currentSrc || el.src || "";
        if (src.includes(needle)) out.push(el);
    });
    return out;
}

/** Profile-view-only avatars (popout 80px, full profile 120px). Used as a
 *  fallback when we couldn't read currentUser?.id yet (very early startup). */
function findProfileViewAvatars(): HTMLImageElement[] {
    const out: HTMLImageElement[] = [];
    document.querySelectorAll('img[class*="avatar__"]').forEach(c => {
        const el = c as HTMLImageElement;
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 60) out.push(el);
    });
    return out;
}

/** Selectors that identify Discord's CHAT message list specifically. A real
 *  profile popout is portaled into a layer and never lives inside the chat, nor
 *  contains it.
 *
 *  These must be chat-ONLY. Do NOT add generic classes like `scrollerInner` —
 *  profile popouts have their own scroller using that class, so it matched
 *  inside the popout, both guards below bailed, and ALL flair silently stopped
 *  rendering (regression caught in v0.7.53-beta.1). */
const MESSAGE_AREA_SEL = '[class*="messagesWrapper"], [class*="chatContent"], [class*="messageListItem"]';

/** `el` is, or sits inside, the chat/message area. */
function isInMessageArea(el: HTMLElement): boolean {
    return !!el.closest(MESSAGE_AREA_SEL);
}

/** `el` CONTAINS the message scroller — so it's the chat/app frame, not a
 *  profile view. Every ancestor above it contains it too, so callers bail. */
function containsMessageArea(el: HTMLElement): boolean {
    return !!el.querySelector(MESSAGE_AREA_SEL);
}

/** Given a banner, resolve the profile popout / full-profile container that we
 *  paint theme colors + banners onto.
 *
 *  BUG THIS GUARDS (2026-07-08): the old version just climbed to the first
 *  ancestor ≥280x300 with no upper bound. Reacting to a message surfaces your
 *  own avatar in the chat; the scanner then resolved YOUR user id, climbed past
 *  the little hover-card, landed on the DM's chat container, and painted your
 *  profile gradient across the whole conversation (`background-color: <p>
 *  !important`). Only showed up in DMs with a flair user, only while the
 *  reaction was rendered. Every viewer toggle has a self-exception, so nothing
 *  could turn it off short of disabling the plugin.
 *
 *  Now: never resolve a container from a banner inside the chat, prefer the
 *  real popout root, and never return anything that contains the message list. */
function findProfileContainerFromBanner(banner: HTMLElement): HTMLElement | null {
    // A banner rendered inside the chat is never a profile-view banner.
    if (isInMessageArea(banner)) return null;

    // The popout root is a BOUND, not the paint target.
    //
    // v0.7.54 painted this root directly. That put our gradient behind every
    // inner layer of the popout: fine on stock Discord (those layers are
    // transparent), but any theme that gives one of them a background buried the
    // flair completely. Regression reported 2026-07-09.
    //
    // Discord paints its own gradient on an INNER container, so that is what we
    // must colour too. Climb to it exactly as before, and use the root only to
    // guarantee we never escape the popout (escaping is how we ended up painting
    // the whole DM chat container in the first place).
    const popoutRoot = banner.closest<HTMLElement>(
        '[class*="user-profile-popout"], [class*="userProfileModal"], [class*="userPopout"], [role="dialog"]'
    );

    let el: HTMLElement | null = banner.parentElement;
    while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r.width >= 280 && r.height >= 300) {
            // Never the chat/app frame.
            if (containsMessageArea(el)) return null;
            // If we know the popout root, the target must live inside it.
            if (popoutRoot && !popoutRoot.contains(el)) return null;
            return el;
        }
        el = el.parentElement;
    }
    return null;
}

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

function validSnowflake(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const id = value.trim();
    return DISCORD_SNOWFLAKE_RE.test(id) ? id : null;
}

/** Discord's profile markup is not stable: some builds expose a data
 *  attribute, some only expose the id in React props, and a default avatar has
 *  no `/avatars/<id>/` CDN URL at all. Walk only user-shaped React fields so
 *  we never mistake a channel/guild id for the profile owner. */
function findUserIdInReactValue(value: unknown, depth = 0, seen = new Set<object>(), budget = { left: 500 }): string | null {
    if (depth > 5 || budget.left-- <= 0 || value == null) return null;
    const direct = validSnowflake(value);
    if (direct) return direct;
    if (typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findUserIdInReactValue(item, depth + 1, seen, budget);
            if (found) return found;
        }
        return null;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["userId", "user_id", "profileUserId", "profile_user_id"]) {
        const found = validSnowflake(record[key]);
        if (found) return found;
    }
    for (const key of ["user", "author", "recipient", "profile", "userData", "props", "memoizedProps", "pendingProps", "children"]) {
        const nested = record[key];
        if (!nested || typeof nested !== "object") continue;
        const nestedRecord = nested as Record<string, unknown>;
        const nestedId = validSnowflake(nestedRecord.id) ?? validSnowflake(nestedRecord.userId);
        if (nestedId) return nestedId;
        const found = findUserIdInReactValue(nested, depth + 1, seen, budget);
        if (found) return found;
    }
    return null;
}

/** Try to identify whose profile a popout/full-profile view belongs to. This
 *  deliberately has several fallbacks because default Discord avatars do not
 *  carry a user id in their CDN URL. The previous avatar-only lookup silently
 *  skipped exactly those users, which is why the stock banner could appear on
 *  one machine while the custom banner worked on another. */
function getUserIdFromContainer(container: Element): string | null {
    // Full-profile views sometimes put the identity marker on the modal root
    // above the element that owns the banner. Check a short ancestor chain
    // before scanning descendants so default-avatar users still resolve.
    let ancestor: Element | null = container;
    for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
        for (const attr of ["data-user-id", "data-userid", "data-profile-user-id", "data-profile-userid"]) {
            const found = validSnowflake(ancestor.getAttribute(attr));
            if (found) return found;
        }
        const ancestorId = ancestor.getAttribute("id") ?? "";
        const ancestorMatch = ancestorId.match(/(?:user|profile)[-_](\d{17,20})/i);
        if (ancestorMatch) return ancestorMatch[1];
    }

    const elements = [container, ...Array.from(container.querySelectorAll("*"))].slice(0, 600);
    for (const el of elements) {
        for (const attr of ["data-user-id", "data-userid", "data-profile-user-id", "data-profile-userid"]) {
            const found = validSnowflake(el.getAttribute(attr));
            if (found) return found;
        }
        const href = el.getAttribute("href") ?? "";
        const hrefMatch = href.match(/\/(?:users?|profile)\/(\d{17,20})(?:\/|$)/i);
        if (hrefMatch) return hrefMatch[1];
        const domId = el.getAttribute("id") ?? "";
        const domMatch = domId.match(/(?:user|profile)[-_](\d{17,20})/i);
        if (domMatch) return domMatch[1];
    }

    // Custom-avatar URLs remain the cheapest and most reliable path when
    // available. Include every IMG class because full-profile and popout
    // avatars use different hashed class names across Discord builds.
    for (const img of container.querySelectorAll("img")) {
        const src = (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src || "";
        const match = src.match(/\/avatars\/(\d{17,20})\//);
        if (match) return match[1];
    }

    for (const el of elements) {
        for (const key of Object.keys(el)) {
            if (!key.startsWith("__reactProps$") && !key.startsWith("__reactFiber$")) continue;
            const found = findUserIdInReactValue((el as any)[key]);
            if (found) return found;
        }
    }
    return null;
}

/** Single point that decides what flair (if any) to render for a given user.
 *  The published roster is authoritative for both self and other users. The
 *  editor's settings are per-install drafts; using them as a self override
 *  made one account render a different banner/gradient on different PCs.
 *  Falls through viewer toggles, hide list, and TournamentMode gates. */
function resolveFlairForUserId(userId: string | null, kind: "banner" | "avatar" | "theme"): ProfileFlair | null {
    const s = settings.store;
    if (!s.showOthersFlair) {
        // Master viewer-toggle is off — still allow your own published roster
        // look, so the setting means "hide other users" rather than "show a
        // different local version of my profile."
        const me = UserStore.getCurrentUser?.();
        if (!me?.id || userId !== me.id) return null;
    }
    if (kind === "banner" && !s.showOthersBanner) {
        const me = UserStore.getCurrentUser?.();
        if (!me?.id || userId !== me.id) return null;
    }
    if (kind === "avatar" && !s.showOthersAvatar) {
        const me = UserStore.getCurrentUser?.();
        if (!me?.id || userId !== me.id) return null;
    }
    if (kind === "theme" && !s.showOthersThemeColors) {
        const me = UserStore.getCurrentUser?.();
        if (!me?.id || userId !== me.id) return null;
    }
    if (userId && isFlairHiddenForUser(userId)) return null;

    const flair = userId ? getRosterProfileFlair(userId) ?? null : null;
    if (!flair) return null;

    if ((kind === "banner" || kind === "avatar") && isTournamentModeActive()) return null;
    return flair;
}

const BANNER_STYLE_PROPS = [
    ["background-image", "dmFlairOriginalBackgroundImage"],
    ["background-size", "dmFlairOriginalBackgroundSize"],
    ["background-position", "dmFlairOriginalBackgroundPosition"],
    ["background-repeat", "dmFlairOriginalBackgroundRepeat"],
    ["position", "dmFlairOriginalPosition"]
] as const;

const THEME_STYLE_PROPS = [
    ["background-image", "dmFlairOriginalThemeBackgroundImage"],
    ["background-color", "dmFlairOriginalThemeBackgroundColor"],
    ["--profile-gradient-primary-color", "dmFlairOriginalThemePrimary"],
    ["--profile-gradient-secondary-color", "dmFlairOriginalThemeSecondary"],
    ["--profile-body-background-color", "dmFlairOriginalThemeBody"]
] as const;

function rememberInlineStyles(
    element: HTMLElement,
    marker: "dmFlairBannerOriginalCaptured" | "dmFlairThemeOriginalCaptured",
    props: ReadonlyArray<readonly [string, string]>
) {
    if (element.dataset[marker]) return;
    element.dataset[marker] = "1";
    for (const [property, key] of props) {
        element.dataset[key] = element.style.getPropertyValue(property);
        element.dataset[`${key}Priority`] = element.style.getPropertyPriority(property);
    }
}

function restoreInlineStyles(
    element: HTMLElement,
    marker: "dmFlairBannerOriginalCaptured" | "dmFlairThemeOriginalCaptured",
    props: ReadonlyArray<readonly [string, string]>
) {
    if (!element.dataset[marker]) return;
    for (const [property, key] of props) {
        const value = element.dataset[key] ?? "";
        const priority = element.dataset[`${key}Priority`] ?? "";
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
        delete element.dataset[key];
        delete element.dataset[`${key}Priority`];
    }
    delete element.dataset[marker];
}

/** Remove all custom banner state and restore the inline declarations that
 *  Discord (or another plugin) had before we painted over the element. */
function clearBanner(banner: HTMLElement) {
    banner.querySelectorAll(".dm-flair-banner-video").forEach(video => video.remove());
    restoreInlineStyles(banner, "dmFlairBannerOriginalCaptured", BANNER_STYLE_PROPS);
    delete banner.dataset.dmFlairBannerUrl;
    banner.removeAttribute("data-dm-flair-banner-applied");
}

function applyBanner(banner: HTMLElement, url: string) {
    const isVideo = isVideoUrl(url);
    const currentUrl = banner.dataset.dmFlairBannerUrl;
    if (currentUrl === url && banner.hasAttribute("data-dm-flair-banner-applied")) {
        const video = banner.querySelector(".dm-flair-banner-video") as HTMLVideoElement | null;
        if (!isVideo || video?.dataset.dmFlairVideoSource === proxyVideoUrl(url)) return;
    }

    // A URL change must restore the old inline state before capturing it again;
    // otherwise a video -> image -> video sequence would permanently retain our
    // temporary `position: relative` declaration.
    clearBanner(banner);
    rememberInlineStyles(banner, "dmFlairBannerOriginalCaptured", BANNER_STYLE_PROPS);
    banner.dataset.dmFlairBannerUrl = url;
    banner.setAttribute("data-dm-flair-banner-applied", "1");

    if (isVideo) {
        // Route through dm-media:// proxy so arbitrary HTTPS MP4 URLs work
        // (Chromium ORB blocks direct cross-origin video; main-process fetch
        // bypasses ORB and serves through a same-origin custom scheme).
        const proxiedUrl = proxyVideoUrl(url);
        banner.style.setProperty("position", "relative");
        const v = document.createElement("video");
        v.className = "dm-flair-banner-video";
        v.dataset.dmFlairVideoSource = proxiedUrl;
        v.src = proxiedUrl;
        v.autoplay = true;
        v.loop = true;
        v.muted = true;
        v.playsInline = true;
        banner.appendChild(v);
        v.play().catch(() => {});
    } else {
        // Inline styles with `important` priority beat every stylesheet rule
        // (theme, Discord's own, anything) — no specificity war.
        banner.style.setProperty("background-image", `url("${url}")`, "important");
        banner.style.setProperty("background-size", "cover", "important");
        banner.style.setProperty("background-position", "center", "important");
        banner.style.setProperty("background-repeat", "no-repeat", "important");
    }
}

/** Accept `RRGGBB`, `#RRGGBB`, or `0xRRGGBB` and emit canonical `#RRGGBB`.
 *  Invalid input returns null so we don't pollute CSS with garbage. */
function normalizeColor(input: string | undefined): string | null {
    if (!input) return null;
    const v = input.trim().replace(/^0x/i, "").replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(v)) return `#${v.toLowerCase()}`;
    if (/^[0-9a-f]{3}$/i.test(v)) {
        // Expand 3-digit shorthand
        return `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`.toLowerCase();
    }
    return null;
}

function clearTheme(container: HTMLElement) {
    restoreInlineStyles(container, "dmFlairThemeOriginalCaptured", THEME_STYLE_PROPS);
    delete container.dataset.dmFlairThemeKey;
    container.removeAttribute("data-dm-flair-theme-applied");
}

function applyTheme(container: HTMLElement, primary?: string, secondary?: string) {
    const p = normalizeColor(primary);
    const s = normalizeColor(secondary);
    if (!p && !s) {
        clearTheme(container);
        return;
    }

    const key = `${p ?? ""}|${s ?? ""}`;
    if (container.dataset.dmFlairThemeKey === key && container.hasAttribute("data-dm-flair-theme-applied")) return;

    clearTheme(container);
    rememberInlineStyles(container, "dmFlairThemeOriginalCaptured", THEME_STYLE_PROPS);
    container.dataset.dmFlairThemeKey = key;

    // Set CSS vars too (in case any Discord child rule consumes them).
    if (p) {
        container.style.setProperty("--profile-gradient-primary-color", p, "important");
        container.style.setProperty("--profile-body-background-color", p, "important");
    }
    if (s) {
        container.style.setProperty("--profile-gradient-secondary-color", s, "important");
    }

    // Probe showed Discord's visual-refresh popout/full-profile DON'T actually
    // paint a gradient from --profile-gradient-* vars on any visible element.
    // So we paint directly: a linear gradient from primary → secondary as the
    // container's background-image. Inline `!important` beats Discord's dark
    // default backgroundColor.
    if (p && s) {
        container.style.setProperty(
            "background-image",
            `linear-gradient(180deg, ${p} 0%, ${s} 100%)`,
            "important"
        );
    } else if (p) {
        container.style.setProperty("background-color", p, "important");
        container.style.setProperty("background-image", "none", "important");
    } else if (s) {
        container.style.setProperty("background-color", s, "important");
        container.style.setProperty("background-image", "none", "important");
    }
    container.setAttribute("data-dm-flair-theme-applied", "1");
}

function applyAvatar(avatar: HTMLImageElement, url: string) {
    // Idempotency MUST compare against the URL we last applied (stashed on the
    // element), NOT against `avatar.src`. The browser normalizes/encodes the
    // src it reads back (dm-media:// scheme, percent-encoding, trailing
    // normalization), so `avatar.src !== url` is almost always true even on
    // the very next scan — which re-assigns src → triggers an image reload →
    // emits a mutation → wakes the observer → re-scans → re-assigns... a
    // self-sustaining CPU/network loop for as long as the avatar is on screen.
    if (avatar.dataset.dmFlairAppliedUrl === url) return;
    // Already proven dead this session — don't reapply a URL that 404s / serves
    // a host's "removed" stub (e.g. a deleted imgur link returns a 503-byte
    // image/png egg). Reapplying would just flash the broken icon every scan.
    if (avatar.dataset.dmFlairFailedUrl === url) return;
    // Stash the original src so we can restore on plugin stop / setting change.
    if (!avatar.dataset.dmFlairOriginalSrc) {
        avatar.dataset.dmFlairOriginalSrc = avatar.src;
    }
    // If the flair URL fails to load, restore the real Discord avatar instead
    // of leaving a broken-image icon. Marks the URL failed so the page-wide
    // scan won't re-apply it on the next mutation/interval pass.
    avatar.onerror = () => {
        avatar.onerror = null;
        avatar.dataset.dmFlairFailedUrl = url;
        const orig = avatar.dataset.dmFlairOriginalSrc;
        if (orig && avatar.src !== orig) avatar.src = orig;
    };
    avatar.src = url;
    avatar.dataset.dmFlairAppliedUrl = url;
    avatar.setAttribute("data-dm-flair-avatar-applied", "1");
}

/** Background-image variant for call surfaces / Stage tiles that render the
 *  avatar as a <div style="background-image: ..."> instead of <img>. Stash
 *  the original inline backgroundImage so stop() can restore it. */
function applyBackgroundAvatar(el: HTMLElement, url: string) {
    const newBg = `url("${url}")`;
    if (el.dataset.dmFlairAppliedBgUrl === url) return;
    if (!el.dataset.dmFlairBgOriginalCaptured) {
        el.dataset.dmFlairBgOriginalCaptured = "1";
        el.dataset.dmFlairOriginalBg = el.style.backgroundImage || "";
        el.dataset.dmFlairOriginalBgPriority = el.style.getPropertyPriority("background-image");
    }
    el.style.setProperty("background-image", newBg, "important");
    el.dataset.dmFlairAppliedBgUrl = url;
    el.setAttribute("data-dm-flair-bg-avatar-applied", "1");
}

function restoreAvatar(avatar: HTMLImageElement) {
    avatar.onerror = null;
    const original = avatar.dataset.dmFlairOriginalSrc;
    if (original && avatar.src !== original) avatar.src = original;
    delete avatar.dataset.dmFlairOriginalSrc;
    delete avatar.dataset.dmFlairAppliedUrl;
    delete avatar.dataset.dmFlairFailedUrl;
    avatar.removeAttribute("data-dm-flair-avatar-applied");
}

function restoreBackgroundAvatar(el: HTMLElement) {
    if (el.dataset.dmFlairBgOriginalCaptured) {
        const original = el.dataset.dmFlairOriginalBg ?? "";
        const priority = el.dataset.dmFlairOriginalBgPriority ?? "";
        if (original) el.style.setProperty("background-image", original, priority);
        else el.style.removeProperty("background-image");
    }
    delete el.dataset.dmFlairBgOriginalCaptured;
    delete el.dataset.dmFlairOriginalBg;
    delete el.dataset.dmFlairOriginalBgPriority;
    delete el.dataset.dmFlairAppliedBgUrl;
    el.removeAttribute("data-dm-flair-bg-avatar-applied");
}

function userIdForAppliedAvatar(element: Element): string | null {
    const original = element instanceof HTMLImageElement
        ? element.dataset.dmFlairOriginalSrc ?? ""
        : element instanceof HTMLElement
            ? element.dataset.dmFlairOriginalBg ?? ""
            : "";
    const fromCdn = original.match(/\/avatars\/(\d{17,20})\//);
    if (fromCdn) return fromCdn[1];

    const profileRoot = element.closest<HTMLElement>(
        '[class*="user-profile-popout"], [class*="userProfileModal"], [class*="userPopout"], [role="dialog"]'
    );
    return profileRoot ? getUserIdFromContainer(profileRoot) : null;
}

/** Reconcile already-painted avatars on every scan. Discord recycles image
 *  nodes and roster entries can expire or lose a field; without this pass a
 *  stale flair stayed visible until the plugin was restarted. */
function cleanupAppliedAvatars(tmActive: boolean) {
    document.querySelectorAll<HTMLImageElement>("[data-dm-flair-avatar-applied]").forEach(avatar => {
        const userId = userIdForAppliedAvatar(avatar);
        const expected = !tmActive && userId
            ? resolveFlairForUserId(userId, "avatar")?.avatarAnimatedUrl
            : undefined;
        if (!expected || expected !== avatar.dataset.dmFlairAppliedUrl) restoreAvatar(avatar);
    });

    document.querySelectorAll<HTMLElement>("[data-dm-flair-bg-avatar-applied]").forEach(element => {
        const userId = userIdForAppliedAvatar(element);
        const expected = !tmActive && userId
            ? resolveFlairForUserId(userId, "avatar")?.avatarAnimatedUrl
            : undefined;
        if (!expected || expected !== element.dataset.dmFlairAppliedBgUrl) restoreBackgroundAvatar(element);
    });
}

function scanForPopouts(_root: ParentNode = document) {
    const me = UserStore.getCurrentUser?.();
    const tmActive = isTournamentModeActive();

    cleanupAppliedAvatars(tmActive);

    // ── Banner + theme (per-popout: identify whose popout, look up their flair) ──
    const banners = findAllProfileBanners();

    for (const banner of banners) {
        const container = findProfileContainerFromBanner(banner);
        if (!container) {
            clearBanner(banner);
            continue;
        }
        // Identify whose popout this is by extracting userId from an avatar
        // img inside (CDN `/avatars/<id>/` URL). We deliberately do NOT fall
        // back to the current user's id when that fails: a target on a DEFAULT
        // Discord avatar yields no CDN id, and the old "no id = me" assumption
        // painted OUR banner + gradient onto THEIR popout — a real flair-leak
        // bug. No id → skip banner/theme for this container. The lookup works
        // in the common case because flair users have a custom avatar (the
        // member-list/chat swap requires one anyway), so it returns their id.
        const userId = getUserIdFromContainer(container);
        if (!userId) {
            clearBanner(banner);
            clearTheme(container);
            continue;
        }

        const bannerFlair = resolveFlairForUserId(userId, "banner");
        const suppressForTM = tmActive && !!bannerFlair?.bannerUrl && isAnimatedUrl(bannerFlair.bannerUrl);
        if (bannerFlair?.bannerUrl && !suppressForTM) applyBanner(banner, bannerFlair.bannerUrl);
        else clearBanner(banner);

        const themeFlair = resolveFlairForUserId(userId, "theme");
        if (themeFlair?.themeColorPrimary || themeFlair?.themeColorSecondary) {
            applyTheme(container, themeFlair.themeColorPrimary, themeFlair.themeColorSecondary);
        } else clearTheme(container);
    }

    // ── Avatar swaps page-wide (member list, chat, voice, calls, DM headers, popout) ──
    // For each <img> whose src is a Discord avatar CDN URL, extract its
    // userId and apply that user's roster avatar flair. This naturally
    // covers self AND other users in one pass — every img tells us whose
    // it is via its src.
    //
    // We deliberately do NOT class-filter (e.g. [class*="avatar__"]) here.
    // Discord uses different class tokens across surfaces — `avatar__` for
    // member-list / chat / popout, but `voiceUserAvatar__`, `callTileAvatar__`,
    // `videoWrapper__`, `userTile__` etc. for voice + video call surfaces.
    // Matching purely by `/avatars/<userId>/` in src is the only invariant
    // that holds everywhere, including the big circular avatar tile shown
    // when a user is in voice with video off, the floating call window, and
    // the connected-users sidebar under the voice channel.
    // Cheap gate before the expensive page-wide scans: if neither self nor any
    // roster user actually has an animated-avatar flair, there is nothing to
    // apply — skip the O(all-images) + O(all-styled-elements) sweep entirely.
    // This is the common case (most users in most servers have no flair), and
    // it's what makes the per-mutation observer affordable.
    const sa = settings.store;
    // The self gate must use the published roster too. Once self rendering is
    // roster-authoritative, a blank per-install draft must not prevent the
    // shared avatar from being scanned when the viewer toggles allow self.
    const selfHasAvatarFlair = !!(me?.id && getRosterProfileFlair(me.id)?.avatarAnimatedUrl);
    const othersAvatarFlair =
        sa.showOthersFlair && sa.showOthersAvatar && rosterHasAnyAvatarFlair();
    const anyAvatarFlair = selfHasAvatarFlair || othersAvatarFlair;

    if (!tmActive && anyAvatarFlair) {
        document.querySelectorAll("img").forEach(img => {
            const el = img as HTMLImageElement;
            const src = el.currentSrc || el.src || "";
            const m = src.match(/\/avatars\/(\d{17,20})\//);
            if (!m) return;
            const userId = m[1];
            const avatarFlair = resolveFlairForUserId(userId, "avatar");
            if (avatarFlair?.avatarAnimatedUrl) {
                applyAvatar(el, avatarFlair.avatarAnimatedUrl);
            }
        });
        // Background-image avatar tiles — some call surfaces (notably the
        // "no video, big circle avatar" user tile in the main call view, and
        // certain Stage/voice-party variants) render the avatar as a
        // <div style="background-image: url(...avatars/<userId>/...)"> rather
        // than as an <img>. Scan every element with an inline backgroundImage
        // that matches the avatar CDN pattern and override the URL.
        document.querySelectorAll<HTMLElement>('[style*="/avatars/"]').forEach(el => {
            const bg = el.style.backgroundImage;
            if (!bg) return;
            const m = bg.match(/\/avatars\/(\d{17,20})\//);
            if (!m) return;
            const userId = m[1];
            const avatarFlair = resolveFlairForUserId(userId, "avatar");
            if (!avatarFlair?.avatarAnimatedUrl) return;
            applyBackgroundAvatar(el, avatarFlair.avatarAnimatedUrl);
        });
        // Profile-view fallback: large avatars (≥60px) that don't have a CDN
        // URL we could match (default-avatar users). Resolve the profile owner
        // and apply that user's published roster avatar too.
        const fallback = findProfileViewAvatars();
        for (const a of fallback) {
            if (a.dataset.dmFlairAvatarApplied) continue;
            const container = findProfileContainerFromBanner(a as any) ?? a.closest('[class*="user-profile-popout"]') ?? a.parentElement;
            const userId = container ? getUserIdFromContainer(container) : null;
            const flair = resolveFlairForUserId(userId, "avatar");
            if (flair?.avatarAnimatedUrl) applyAvatar(a, flair.avatarAnimatedUrl);
        }
        // Warn once if the current user has a default avatar.
        if (me && !me.avatar && selfHasAvatarFlair && !defaultAvatarWarned) {
            defaultAvatarWarned = true;
            toast(
                "⚠ Your Discord avatar is set to the default — your animated avatar will only show on profile popouts + full profile, not member list or chat. Upload any custom Discord avatar to fix.",
                Toasts.Type.MESSAGE,
                10000
            );
        }
    }
}

let scanScheduled = false;
// Coalesce mutation bursts into at most one scan per animation frame. Discord
// emits hundreds of childList mutations per second while chat scrolls or a
// call is live; running the full scan on each one was the plugin's dominant
// CPU cost. rAF batching collapses a burst to a single scan, and because
// applyAvatar/applyBanner are now idempotent, the scan's own mutations don't
// re-trigger an endless rescan loop.
function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
        scanScheduled = false;
        scanForPopouts(document);
    });
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    scanForPopouts(document);
    // Low-frequency safety net for changes the childList observer can't see
    // (e.g. an <img src> swapped in place). 2s is plenty for animated-avatar
    // surfaces and halves the steady-state polling cost vs the old 1s.
    rescanTimer = window.setInterval(() => scanForPopouts(document), 2000);
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
    if (rescanTimer !== null) { clearInterval(rescanTimer); rescanTimer = null; }
    document.querySelectorAll<HTMLElement>("[data-dm-flair-banner-applied], .dm-flair-banner-video").forEach(el => {
        if (el.matches("[data-dm-flair-banner-applied]")) clearBanner(el);
        else el.remove();
    });
    document.querySelectorAll<HTMLElement>("[data-dm-flair-theme-applied]").forEach(clearTheme);
    // Restore original avatar srcs/styles so toggling the plugin off + on does
    // not leave stale flair or discard Discord's own inline declarations.
    document.querySelectorAll<HTMLImageElement>("[data-dm-flair-avatar-applied]").forEach(restoreAvatar);
    document.querySelectorAll<HTMLElement>("[data-dm-flair-bg-avatar-applied]").forEach(restoreBackgroundAvatar);
}

export default definePlugin({
    name: "DMProfileFlair",
    description:
        "Custom profile banner / animated avatar / theme colors, visible only to other Discordmaxxer users. " +
        "Tier-gated server-side. Animated content auto-suppresses when TournamentMode is on.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-profile-flair", managedStyleRootNode);
        style.textContent = buildCss();
        removeRosterListener = onRosterChange(scheduleScan);
        startObserver();
        // Resolve the roster immediately so an already-open profile does not
        // depend on the next profile open or the two-second DOM poll. The
        // listener above repaints when this asynchronous fetch completes.
        refreshRoster().catch(e => console.warn("[DMProfileFlair] roster refresh failed:", e));
    },

    stop() {
        removeRosterListener?.();
        removeRosterListener = null;
        stopObserver();
        style?.remove();
        style = null;
        // Reset the warn-once latch so toggling the plugin off+on re-surfaces
        // the default-avatar warning if it still applies.
        defaultAvatarWarned = false;
    }
});

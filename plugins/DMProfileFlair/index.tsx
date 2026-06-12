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

import { getRosterProfileFlair, ProfileFlair, rosterHasAnyAvatarFlair } from "../_dm-shared/roster";
import { Tier } from "../_dm-shared/vip";
import { readBinding } from "../_dm-shared/vipClaim";

const WORKER_PROFILE_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile";

const PROFILE_FIELD_MIN_TIER: Record<keyof ProfileFlair, Tier> = {
    bannerUrl: Tier.MAXXER,
    avatarAnimatedUrl: Tier.MAXXER_PLUS,
    themeColorPrimary: Tier.MAXXER_PLUS_PLUS,
    themeColorSecondary: Tier.MAXXER_PLUS_PLUS
};

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

/** Local hide list — userIds whose flair the viewer has muted. Stored in
 *  localStorage so a right-click "hide flair" survives restarts. */
const HIDE_LIST_KEY = "dm-profile-flair-hidden";
function readHideList(): Set<string> {
    try {
        const raw = localStorage.getItem(HIDE_LIST_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr.filter(x => typeof x === "string") : []);
    } catch {
        return new Set();
    }
}
function writeHideList(set: Set<string>): void {
    try { localStorage.setItem(HIDE_LIST_KEY, JSON.stringify([...set])); } catch {}
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

    // Self-preview path: when rendering YOUR OWN popout, prefer the local
    // setter-side settings over the roster lookup. Lets you see your flair
    // change as soon as you type a URL — no save, no worker, no claim, no
    // roster cache wait. Renders only the fields you've filled in locally;
    // empty fields fall through to roster (which may have a previously
    // saved version) and then to nothing.
    let flair: ProfileFlair | null = null;
    const me = UserStore.getCurrentUser?.();
    if (me?.id === userId) {
        const local: ProfileFlair = {};
        const b = s.myBannerUrl.trim(); if (b) local.bannerUrl = b;
        const a = s.myAvatarAnimatedUrl.trim(); if (a) local.avatarAnimatedUrl = a;
        const p = s.myThemeColorPrimary.trim(); if (p) local.themeColorPrimary = p;
        const sc = s.myThemeColorSecondary.trim(); if (sc) local.themeColorSecondary = sc;
        if (Object.keys(local).length) flair = local;
    }
    if (!flair) flair = getRosterProfileFlair(userId) ?? null;
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
        claimCode = settings.store.manualClaimCode.trim().toUpperCase().replace(/-/g, "");
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
            toast(`Save failed: ${body?.error ?? res.status}`, Toasts.Type.FAILURE, 5000);
            return false;
        }
        toast("✅ Profile flair saved — other Discordmaxxer users see it within ~5 min");
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
            if (!URL_RE.test(v as string)) return `${k} must be https:// and ≤250 chars`;
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
// Optional, opt-in, one-shot: PATCH the user's REAL Discord profile so that
// flair becomes visible to non-Discordmaxxer users too. Three independent
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
//   PATCH /users/@me/profile  body: { theme_colors: [int, int] }     → free
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
        toast("✅ Theme colors broadcast — visible to everyone (vanilla Discord included).", Toasts.Type.SUCCESS, 5000);
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
        toast("✅ Still-frame banner broadcast — vanilla Discord users now see this image as your banner.", Toasts.Type.SUCCESS, 5000);
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
        toast("Avatar URL must be https:// and ≤250 chars before broadcasting.", Toasts.Type.FAILURE, 5000);
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
        toast("Banner URL must be https:// and ≤250 chars before broadcasting.", Toasts.Type.FAILURE, 5000);
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
                "⚠ Nitro required for a Discord banner upload. (Theme colors broadcast works on free — try that for a free-tier color identity.)",
                Toasts.Type.FAILURE, 8000
            );
        } else {
            toast(`Banner broadcast failed: ${label}`, Toasts.Type.FAILURE, 6000);
        }
        return false;
    }
}

function FlairEditor() {
    const s = settings.store;
    const [busy, setBusy] = React.useState(false);
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
        const proposed: Partial<ProfileFlair> = {
            bannerUrl: s.myBannerUrl.trim() || "",
            avatarAnimatedUrl: s.myAvatarAnimatedUrl.trim() || "",
            themeColorPrimary: normalizeForSave(s.myThemeColorPrimary),
            themeColorSecondary: normalizeForSave(s.myThemeColorSecondary)
        };
        const err = validateLocal(proposed);
        if (err) { toast(err, Toasts.Type.FAILURE, 5000); return; }
        setBusy(true);
        // Replace mode: the editor reflects the user's full intended state,
        // so we replace rather than merge — empty fields clear server-side.
        const ok = await postFlairUpdate(proposed, true);
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

    // ── Vanilla broadcast handlers ──────────────────────────────────────
    // Each handler does its own confirm() and then fires ONCE. We don't
    // batch all three into a single button because each touches a
    // different Discord profile field with different Nitro requirements —
    // batching would conflate the "Nitro required" error and make it
    // ambiguous which field caused the failure.
    const broadcastConfirmCopy = (kind: "theme colors" | "avatar" | "banner", extra = "") =>
        `Broadcast your ${kind} to your REAL Discord profile?\n\n` +
        `This sets the value on your actual Discord account — everyone (vanilla Discord users included) will see it on your profile.\n\n` +
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
        if (!confirm(broadcastConfirmCopy("theme colors", "✅ Works on FREE Discord — no Nitro needed."))) return;
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
        if (!confirm(broadcastConfirmCopy("banner", "⚠ Discord banners require Nitro for any user. Without Nitro this PATCH will fail (we'll show a clear error). Theme colors broadcast works without Nitro — try that first."))) return;
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
                These values are sent to the Discordmaxxer roster and rendered for other
                Discordmaxxer users. Vanilla Discord users see your stock profile.
                Worker validates each field server-side — banner needs MAXXER, animated
                avatar needs MAXXER+, theme colors need MAXXER++.
            </div>
            <div style={btnRow}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onSave} disabled={busy}>
                    💾 Save to Discordmaxxer
                </Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={onClearAll} disabled={busy}>
                    ✕ Clear all my flair
                </Button>
            </div>

            <div style={broadcastWrapStyle}>
                <div style={broadcastTitleStyle}>📡 Broadcast to vanilla Discord (one-time)</div>
                <div style={broadcastNoteStyle}>
                    The buttons above save flair that <b>only other Discordmaxxer users</b> can see.
                    These buttons below PATCH your <b>real Discord profile</b> so <b>everyone</b> sees it —
                    Nitro friends, normies, mobile-only users, the works. Fires once per click; never re-asserts.
                    <br /><br />
                    <b>Theme gradient:</b> PATCH succeeds on free accounts but Discord silently <b>Nitro-gates the render</b> — vanilla viewers see default unless you have Nitro. <b>Static avatar:</b> free. <b>Animated avatar + any banner (incl. still-frame):</b> Nitro required server-side.
                </div>
                <div style={broadcastBtnRow}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastColors} disabled={busy}>
                        📡 Broadcast theme gradient (Nitro-gated render)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastAvatar} disabled={busy}>
                        📡 Broadcast avatar (static = free, animated = Nitro)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastBanner} disabled={busy}>
                        📡 Broadcast banner as-is (Nitro required)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastStillBanner} disabled={busy}>
                        📡 Broadcast banner as still-frame (extract first frame from video/GIF, Nitro required)
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
            "[Channel E · MAXXER+] DIRECT image URL (not a webpage). " +
            "✅ Good: https://i.imgur.com/abc123.png  ❌ Bad: https://imgur.com/gallery/abc123 (HTML page, won't render). " +
            "On imgur: right-click the image → 'Copy image address' to get the direct URL. " +
            "Recommended size: 600×240 (or any 5:2 ratio — Discord's banner slot is 300×120 in popouts, 680×272 in full profile; 2× pixel density looks crispest). " +
            "Supports png/jpg/webp/gif images OR short mp4/webm videos. ≤5MB image / ≤15MB video recommended. " +
            "⚠ Suppressed while TournamentMode is active (any banner — image OR video — is paused; TM exists to free up GPU during matches).",
        default: ""
    },
    myAvatarAnimatedUrl: {
        type: OptionType.STRING,
        description:
            "[Channel F · MAXXER+] DIRECT image/GIF URL (not a webpage). " +
            "Same rules as banner — right-click → Copy image address to get the right URL. " +
            "Recommended size: 160×160 square (1:1 aspect — Discord renders 80×80 in popouts, 120×120 in full profile; 2× density for crisp). " +
            "Renders in profile popouts, full profile, AND member list + chat + voice + DM headers. " +
            "⚠ IMPORTANT — you must have a CUSTOM Discord avatar set on your account (Discord Settings → My Account → upload anything) " +
            "for the swap to work on member list / chat / voice surfaces. " +
            "Discord's DEFAULT avatars (the colored wordmark) aren't on the per-user CDN path we match against, " +
            "so users on default avatars only get the swap on the profile popout + full-profile view. " +
            "Suppressed when TournamentMode is on.",
        default: ""
    },
    myThemeColorPrimary: {
        type: OptionType.STRING,
        description:
            "[Channel G · MAXXER++] Primary theme color — TOP of the profile gradient. " +
            "Accepts #RRGGBB, RRGGBB (no #), or 0xRRGGBB — auto-normalized. " +
            "Default = '#4d1c12' (deep blood red) so you can see the gradient effect on first launch. " +
            "Clear to remove your gradient.",
        default: "#4d1c12"
    },
    myThemeColorSecondary: {
        type: OptionType.STRING,
        description:
            "[Channel G · MAXXER++] Secondary theme color — BOTTOM of the profile gradient. " +
            "Accepts #RRGGBB, RRGGBB (no #), or 0xRRGGBB — auto-normalized. " +
            "Default = '#ff0034' (vivid red). Paired with the default primary above for a nice red gradient demo.",
        default: "#ff0034"
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
    document.querySelectorAll('[class*="banner__"]').forEach(c => {
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
 *  (self-preview) or per-roster-user (live mode). */
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

/** Given a banner, climb the DOM until we find a container big enough to be
 *  a profile popout / full-profile view (≥280px wide AND ≥300px tall). This
 *  is the element we paint theme colors on. */
function findProfileContainerFromBanner(banner: HTMLElement): HTMLElement | null {
    let el: HTMLElement | null = banner.parentElement;
    while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r.width >= 280 && r.height >= 300) return el;
        el = el.parentElement;
    }
    return null;
}

/** Try to identify whose profile a popout/full-profile view belongs to. Modern
 *  Discord doesn't put `data-user-id` on profile containers, so we extract it
 *  from an avatar IMG inside via the CDN URL shape
 *  `cdn.discordapp.com/avatars/<userId>/<hash>.<ext>`. Returns null when the
 *  user has Discord's default avatar (no per-user CDN URL — those use
 *  `/assets/<hash>.png` instead). */
function getUserIdFromContainer(container: Element): string | null {
    const imgs = container.querySelectorAll('img[class*="avatar__"]');
    for (const img of imgs) {
        const src = (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src || "";
        const m = src.match(/\/avatars\/(\d{17,20})\//);
        if (m) return m[1];
    }
    return null;
}

/** Single point that decides what flair (if any) to render for a given user.
 *  - Self (me.id === userId): prefer local plugin settings so saves render
 *    instantly without a worker roundtrip.
 *  - Other users on roster: read their saved flair from `getRosterProfileFlair`.
 *  - Anyone else: return null (no flair).
 *  Falls through viewer toggles, hide list, and TournamentMode gates. */
function resolveFlairForUserId(userId: string | null, kind: "banner" | "avatar" | "theme"): ProfileFlair | null {
    const s = settings.store;
    if (!s.showOthersFlair) {
        // Master viewer-toggle is off — still allow self-preview rendering on
        // your own popout, otherwise the setter UX feels broken (you set a
        // banner and don't see it).
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

    let flair: ProfileFlair | null = null;
    const me = UserStore.getCurrentUser?.();
    if (userId && me?.id === userId) {
        const local: ProfileFlair = {};
        const b = s.myBannerUrl.trim(); if (b) local.bannerUrl = b;
        const a = s.myAvatarAnimatedUrl.trim(); if (a) local.avatarAnimatedUrl = a;
        const p = s.myThemeColorPrimary.trim(); if (p) local.themeColorPrimary = p;
        const sc = s.myThemeColorSecondary.trim(); if (sc) local.themeColorSecondary = sc;
        if (Object.keys(local).length) flair = local;
    } else if (userId) {
        flair = getRosterProfileFlair(userId) ?? null;
    }
    if (!flair) return null;

    if ((kind === "banner" || kind === "avatar") && isTournamentModeActive()) return null;
    return flair;
}

function applyBanner(banner: HTMLElement, url: string) {
    if (isVideoUrl(url)) {
        // Route through dm-media:// proxy so arbitrary HTTPS MP4 URLs work
        // (Chromium ORB blocks direct cross-origin video; main-process fetch
        // bypasses ORB and serves through a same-origin custom scheme).
        const proxiedUrl = proxyVideoUrl(url);
        const existing = banner.querySelector(".dm-flair-banner-video") as HTMLVideoElement | null;
        if (existing) {
            // Already a video here — update src if URL changed, otherwise no-op.
            if (existing.src !== proxiedUrl) {
                existing.src = proxiedUrl;
                existing.load();
                existing.play().catch(() => {});
            }
        } else {
            if (!banner.style.position) banner.style.position = "relative";
            const v = document.createElement("video");
            v.className = "dm-flair-banner-video";
            v.src = proxiedUrl;
            v.autoplay = true;
            v.loop = true;
            v.muted = true;
            v.playsInline = true;
            banner.appendChild(v);
            v.play().catch(() => {});
        }
    } else {
        // Image URL — clean up any leftover <video> element from a previous
        // video URL, then the inline background-image below takes over.
        banner.querySelectorAll(".dm-flair-banner-video").forEach(v => v.remove());
        // Inline styles with `important` priority beat every stylesheet rule
        // (theme, Discord's own, anything) — no specificity war.
        banner.style.setProperty("background-image", `url("${url}")`, "important");
        banner.style.setProperty("background-size", "cover", "important");
        banner.style.setProperty("background-position", "center", "important");
        banner.style.setProperty("background-repeat", "no-repeat", "important");
        banner.setAttribute("data-dm-flair-banner-applied", "1");
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

function applyTheme(container: HTMLElement, primary?: string, secondary?: string) {
    const p = normalizeColor(primary);
    const s = normalizeColor(secondary);
    if (!p && !s) return;

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
    // Stash the original src so we can restore on plugin stop / setting change.
    if (!avatar.dataset.dmFlairOriginalSrc) {
        avatar.dataset.dmFlairOriginalSrc = avatar.src;
    }
    avatar.src = url;
    avatar.dataset.dmFlairAppliedUrl = url;
    avatar.setAttribute("data-dm-flair-avatar-applied", "1");
}

/** Background-image variant for call surfaces / Stage tiles that render the
 *  avatar as a <div style="background-image: ..."> instead of <img>. Stash
 *  the original inline backgroundImage so stop() can restore it. */
function applyBackgroundAvatar(el: HTMLElement, url: string) {
    const newBg = `url("${url}")`;
    if (el.style.backgroundImage === newBg) return;
    if (!el.dataset.dmFlairOriginalBg) {
        el.dataset.dmFlairOriginalBg = el.style.backgroundImage || "";
    }
    el.style.setProperty("background-image", newBg, "important");
    el.setAttribute("data-dm-flair-bg-avatar-applied", "1");
}

function scanForPopouts(_root: ParentNode = document) {
    const me = UserStore.getCurrentUser?.();
    const tmActive = isTournamentModeActive();

    // ── Banner + theme (per-popout: identify whose popout, look up their flair) ──
    const banners = findAllProfileBanners();

    for (const banner of banners) {
        const container = findProfileContainerFromBanner(banner);
        if (!container) continue;
        // Identify whose popout this is by extracting userId from an avatar
        // img inside. Falls back to self-preview when we can't (default-avatar
        // user or extremely fast popout open) so the setter UX still works.
        let userId = getUserIdFromContainer(container);
        if (!userId && me?.id) userId = me.id;

        const bannerFlair = resolveFlairForUserId(userId, "banner");
        if (bannerFlair?.bannerUrl) {
            const suppressForTM = tmActive && isAnimatedUrl(bannerFlair.bannerUrl);
            if (!suppressForTM) {
                applyBanner(banner, bannerFlair.bannerUrl);
            }
        }

        const themeFlair = resolveFlairForUserId(userId, "theme");
        if (themeFlair?.themeColorPrimary || themeFlair?.themeColorSecondary) {
            applyTheme(container, themeFlair.themeColorPrimary, themeFlair.themeColorSecondary);
        }
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
    const selfHasAvatarFlair = !!sa.myAvatarAnimatedUrl.trim();
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
        // URL we could match (default-avatar users). If we're viewing our own
        // popout in self-preview, swap those too.
        const fallback = findProfileViewAvatars();
        for (const a of fallback) {
            if (a.dataset.dmFlairAvatarApplied) continue;
            const container = findProfileContainerFromBanner(a as any) ?? a.closest('[class*="user-profile-popout"]') ?? a.parentElement;
            const userId = container ? getUserIdFromContainer(container) : null;
            const flair = resolveFlairForUserId(userId, "avatar");
            if (flair?.avatarAnimatedUrl) applyAvatar(a, flair.avatarAnimatedUrl);
        }
        // Warn once if the current user has a default avatar.
        if (me && !me.avatar && settings.store.myAvatarAnimatedUrl.trim() && !defaultAvatarWarned) {
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
    document.querySelectorAll("[data-dm-flair-banner-applied]").forEach(el => {
        const e = el as HTMLElement;
        e.style.removeProperty("background-image");
        e.style.removeProperty("background-size");
        e.style.removeProperty("background-position");
        e.style.removeProperty("background-repeat");
        e.removeAttribute("data-dm-flair-banner-applied");
    });
    document.querySelectorAll("[data-dm-flair-theme-applied]").forEach(el => {
        const e = el as HTMLElement;
        e.style.removeProperty("background-image");
        e.style.removeProperty("background-color");
        e.style.removeProperty("--profile-gradient-primary-color");
        e.style.removeProperty("--profile-gradient-secondary-color");
        e.style.removeProperty("--profile-body-background-color");
        e.removeAttribute("data-dm-flair-theme-applied");
    });
    // Restore original avatar srcs so toggling the plugin off + on doesn't
    // leave broken images sitting around.
    document.querySelectorAll("[data-dm-flair-avatar-applied]").forEach(el => {
        const img = el as HTMLImageElement;
        const orig = img.dataset.dmFlairOriginalSrc;
        if (orig) img.src = orig;
        delete img.dataset.dmFlairOriginalSrc;
        delete img.dataset.dmFlairAppliedUrl;
        img.removeAttribute("data-dm-flair-avatar-applied");
    });
    // Same restore path for background-image call/Stage avatar tiles.
    document.querySelectorAll<HTMLElement>("[data-dm-flair-bg-avatar-applied]").forEach(el => {
        const orig = el.dataset.dmFlairOriginalBg;
        if (orig) el.style.setProperty("background-image", orig);
        else el.style.removeProperty("background-image");
        delete el.dataset.dmFlairOriginalBg;
        el.removeAttribute("data-dm-flair-bg-avatar-applied");
    });
    document.querySelectorAll(".dm-flair-banner-video").forEach(v => v.remove());
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
        startObserver();
    },

    stop() {
        stopObserver();
        style?.remove();
        style = null;
        // Reset the warn-once latch so toggling the plugin off+on re-surfaces
        // the default-avatar warning if it still applies.
        defaultAvatarWarned = false;
    }
});

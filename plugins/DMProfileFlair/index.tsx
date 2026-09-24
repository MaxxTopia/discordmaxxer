/*
 * Discordmaxxer — DMProfileFlair plugin (Channels E, F, G)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * User-set profile flair stored in Discordmaxxer's roster and rendered by
 * compatible clients. This does not write those visual fields into the user's
 * Discord account; separate one-time controls update native profile fields.
 *
 *   E) Custom banner — image or short MP4 URL, replaces Discord's banner
 *      in profile popouts. Requires MAXXER.
 *   F) Animated avatar — GIF/image URL, replaces the avatar in popouts (P2)
 *      and member list + chat (P5). Requires MAXXER+. Suppressed when
 *      TournamentMode is active (animated content tanks FPS).
 *   G) Theme colors — primary + secondary hex, patched into Discord's
 *      --profile-gradient-*-color CSS vars on the popout root. Available to
 *      every Discordmaxxer user; a claim code is only needed to sync the
 *      gradient through the shared roster across PCs and other viewers.
 *
 * Phasing:
 *   - This file ships the plumbing: settings UI, worker write call, viewer
 *     toggles, TM state helper, effective-flair accessor. Render hooks for
 *     each channel land in follow-up commits.
 *
 * Anti-abuse:
 *   - URLs validated client- AND worker-side (https://, ≤250 chars total).
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
import * as DataStore from "@api/DataStore";

import { makePersistentValue } from "../_dm-shared/persist";
import {
    getRosterProfileFlair,
    getRosterProfileUpdatedAt,
    getRosterStatus,
    onRosterChange,
    ProfileFlair,
    refreshRoster,
    rosterHasAnyAvatarFlair,
    clearOptimisticProfileFlair,
    setOptimisticProfileFlair
} from "../_dm-shared/roster";
import { decodeProfileLook, encodeProfileLook, ProfileLookConfig } from "../_dm-shared/profileLookShare";
import { isDisplayNameStylePresetId } from "../_dm-shared/displayNameStylePresets";
import { GRADIENT_PRESETS } from "../_dm-shared/gradientPresets";
import { Tier } from "../_dm-shared/vip";
import { normalizeCode, readBinding } from "../_dm-shared/vipClaim";

const WORKER_PROFILE_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile";
const WORKER_PROFILE_MEDIA_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile-media";

const URL_RE = /^https:\/\/[^\s"']{1,242}$/;
// Shared writes stay deliberately strict (the worker stores short URLs), but
// a previously saved local draft may be a little longer — Discord proxy URLs
// commonly are. Keep that draft safe for a self-only preview without allowing
// non-HTTPS schemes or CSS-breaking quotes into the renderer.
const LOCAL_DRAFT_URL_RE = /^https:\/\/[^\s"']{1,2048}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
type ProfileLookComponent = keyof ProfileFlair | "gradient" | "nameStyle";

function profileLookComponentLabel(component: ProfileLookComponent): string {
    if (component === "bannerUrl") return "banner";
    if (component === "avatarAnimatedUrl") return "animated avatar";
    if (component === "gradient") return "gradient";
    return "display-name style";
}

interface LocalRenderMedia {
    url: string;
    isVideo: boolean;
}

// A picked file is intentionally local-only until the user explicitly
// publishes it. Keep a data URI for the renderer so the selected file remains
// visible in the profile itself, not only inside the editor preview. The
// IndexedDB copy is restored into this map when the plugin starts.
const localRenderMedia: Partial<Record<"banner" | "avatar", LocalRenderMedia>> = {};
const sessionLocalMediaPreview = new Set<"banner" | "avatar">();
let sessionThemePreview: ProfileFlair | null | undefined;

function setLocalRenderMedia(kind: "banner" | "avatar", media: LocalRenderMedia, userSelected = false): void {
    localRenderMedia[kind] = media;
    if (userSelected) sessionLocalMediaPreview.add(kind);
}

function clearLocalRenderMedia(kind?: "banner" | "avatar"): void {
    if (kind) {
        delete localRenderMedia[kind];
        sessionLocalMediaPreview.delete(kind);
    }
    else {
        delete localRenderMedia.banner;
        delete localRenderMedia.avatar;
        sessionLocalMediaPreview.clear();
    }
}

/** Lightweight diagnostics for the settings panel and support reports. Keep
 * this in memory only: it describes renderer work, never account data or
 * private media bytes. */
export interface ProfileFlairRenderHealth {
    scanCount: number;
    lastScanAt: number;
    visibleBanners: number;
    visibleAvatars: number;
    appliedBanners: number;
    appliedThemes: number;
    appliedAvatars: number;
    lastFailure?: string;
    lastFailureAt?: number;
}

const profileRenderHealth: ProfileFlairRenderHealth = {
    scanCount: 0,
    lastScanAt: 0,
    visibleBanners: 0,
    visibleAvatars: 0,
    appliedBanners: 0,
    appliedThemes: 0,
    appliedAvatars: 0
};

export function getProfileFlairRenderHealth(): ProfileFlairRenderHealth {
    return { ...profileRenderHealth };
}

function noteProfileFlairFailure(message: string): void {
    profileRenderHealth.lastFailure = message;
    profileRenderHealth.lastFailureAt = Date.now();
    console.warn(`[DMProfileFlair] ${message}`);
}

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
 *  Vencord's plain-settings tree. TournamentMode is the only hard pause for
 *  animated content (banner videos + animated avatars) when the user is
 *  gaming. Windows/Discord reduced-motion preferences deliberately do not
 *  alter profile flair; users asked for the custom look to remain visible. */
export function isTournamentModeActive(): boolean {
    return !!(globalThis as any).Vencord?.PlainSettings?.plugins?.TournamentMode?.manuallyActive;
}

function shouldSuppressAnimatedFlair(): boolean {
    return isTournamentModeActive();
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

function getLocalThemeFlair(): ProfileFlair | undefined {
    const primary = normalizeColor(settings.store.myThemeColorPrimary);
    const secondary = normalizeColor(settings.store.myThemeColorSecondary);
    if (!primary && !secondary) return undefined;
    return {
        ...(primary ? { themeColorPrimary: primary } : {}),
        ...(secondary ? { themeColorSecondary: secondary } : {})
    };
}

function getLocalMediaDraftFlair(): ProfileFlair | undefined {
    const banner = settings.store.myBannerUrl.trim();
    const avatar = settings.store.myAvatarAnimatedUrl.trim();
    const flair: ProfileFlair = {};
    if (LOCAL_DRAFT_URL_RE.test(banner)) flair.bannerUrl = banner;
    if (LOCAL_DRAFT_URL_RE.test(avatar)) flair.avatarAnimatedUrl = avatar;
    return flair.bannerUrl || flair.avatarAnimatedUrl ? flair : undefined;
}

function getLocalMediaValue(kind: "banner" | "avatar"): string | undefined {
    const renderMedia = localRenderMedia[kind];
    if (renderMedia?.url) return renderMedia.url;
    const draft = getLocalMediaDraftFlair();
    return kind === "banner" ? draft?.bannerUrl : draft?.avatarAnimatedUrl;
}

function hasAuthoritativeRosterSnapshot(): boolean {
    const { fetchedAt } = getRosterStatus();
    return typeof fetchedAt === "number" && fetchedAt > 0;
}

function getProfileFlairForRender(userId: string, kind: "banner" | "avatar" | "theme"): ProfileFlair | undefined {
    const shared = getRosterProfileFlair(userId);
    const me = UserStore.getCurrentUser?.();

    if (kind !== "theme") {
        // A published field is canonical on every install. Old local editor
        // URLs / remembered files must not override it, or the same account
        // can show different banners/avatars on two PCs. A local choice is a
        // preview/fallback only until that field has been published.
        const key = kind === "banner" ? "bannerUrl" : "avatarAnimatedUrl";
        if (!me?.id || me.id !== userId) return shared;
        const value = getLocalMediaValue(kind);
        if (sessionLocalMediaPreview.has(kind) && value) return { ...(shared ?? {}), [key]: value };
        if (shared?.[key]) return shared;
        return value ? { ...(shared ?? {}), [key]: value } : shared;
    }

    if (!me?.id || me.id !== userId) return shared;

    // A just-selected preset/editor value should paint immediately, even if
    // this install has an older published gradient. Once the write succeeds,
    // the shared roster takes over again. A null preview is an explicit local
    // clear while an update is pending or when the user clears only this PC.
    if (sessionThemePreview !== undefined) {
        return sessionThemePreview === null
            ? { ...(shared ?? {}), themeColorPrimary: "", themeColorSecondary: "" }
            : { ...(shared ?? {}), ...sessionThemePreview };
    }

    // A roster gradient is shared account state. Per-install color settings
    // are only a local fallback when no shared gradient exists; otherwise an
    // old Cotton Candy draft could mask the account's published Crimson
    // colors on one PC and make identical accounts look different.
    if (shared?.themeColorPrimary || shared?.themeColorSecondary) return shared;

    const local = getLocalThemeFlair();
    if (!local) return shared;
    return local;
}

/** Repaint an already-open profile immediately after a local or optimistic
 * gradient change, then keep the normal observer/animation-frame safety net.
 * The direct scan is user-triggered and infrequent; it removes the confusing
 * "the toast said applied, but the popout changed later" gap. */
function repaintProfileFlairNow(): void {
    try {
        scanForPopouts(document);
    } catch (e) {
        console.warn("[DMProfileFlair] immediate gradient repaint failed:", e);
    }
    scheduleScan();
}

function openNativeProfileSettings(): void {
    try {
        const router = (globalThis as any).Vencord?.Webpack?.Common?.SettingsRouter;
        if (typeof router?.openUserSettings !== "function") {
            toast("Couldn't open Discord's profile editor. Open User Settings → Profiles manually.", Toasts.Type.FAILURE);
            return;
        }
        router.openUserSettings("my_account_panel");
    } catch (e) {
        console.warn("[DMProfileFlair] could not open Discord's profile editor:", e);
        toast("Couldn't open Discord's profile editor. Open User Settings → Profiles manually.", Toasts.Type.FAILURE);
    }
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

    // Published roster values are canonical across installs. A fresh local
    // choice previews immediately for the current user; old per-PC settings
    // are only fallbacks when no shared field exists.
    const flair = getProfileFlairForRender(userId, kind) ?? null;
    if (!flair) return null;

    if ((kind === "banner" || kind === "avatar") && isTournamentModeActive()) {
        // TournamentMode is the only performance pause. Windows/Discord
        // reduced-motion preferences intentionally do not rewrite the media
        // URL, so custom animated flair remains animated outside TournamentMode.
        // Theme colors remain visible in both modes.
        return null;
    }
    return flair;
}

interface ProfileAuth {
    userId: string;
    claimCode: string;
}

function getProfileAuth(showError = true): ProfileAuth | null {
    const me = UserStore.getCurrentUser();
    if (!me?.id) {
        if (showError) toast("Couldn't read your Discord user ID", Toasts.Type.FAILURE);
        return null;
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
        if (showError) {
            toast(
                "Need your VIP claim code — paste it into 'manualClaimCode' in this plugin's settings, or claim one via DiscordmaxxerVipClaim first.",
                Toasts.Type.FAILURE, 6000
            );
        }
        return null;
    }
    return { userId: me.id, claimCode };
}

async function postFlairUpdate(profile: Partial<ProfileFlair>, replace: boolean): Promise<boolean> {
    const auth = getProfileAuth();
    if (!auth) return false;
    const ifUpdatedAt = getRosterProfileUpdatedAt(auth.userId);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
        const res = await fetch(WORKER_PROFILE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                userId: auth.userId,
                claimCode: auth.claimCode,
                profile,
                replace,
                ...(ifUpdatedAt !== undefined ? { ifUpdatedAt } : {})
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const serverError = String(body?.error ?? res.status);
            if (res.status === 409) {
                await refreshRoster();
                toast("Save stopped: this profile changed on another PC. Refresh finished; review the current look and save again.", Toasts.Type.FAILURE, 7000);
                return false;
            }
            const friendlyError = res.status === 410
                ? "Your Discordmaxxer claim has expired. Reclaim it, then try again."
                : res.status === 429
                    ? "Too many profile updates. Wait a moment and try again."
                    : res.status === 403 && /scope|discordmaxxer/i.test(serverError)
                        ? "This claim is for another Maxxtopia product, not Discordmaxxer."
                        : /https|250/i.test(serverError)
                ? "Use a direct HTTPS media URL that is 250 characters or fewer. A webpage link or local file will not work here."
                : serverError;
            toast(`Save failed: ${friendlyError}`, Toasts.Type.FAILURE, 6000);
            return false;
        }
        // The worker returns the complete merged profile. Paint it locally
        // before waiting for the public roster edge/KV path to converge so the
        // sender never experiences a successful-save-but-nothing-changed gap.
        if (replace) clearOptimisticProfileFlair(auth.userId);
        const returnedProfile = body?.profile && typeof body.profile === "object" ? body.profile : {};
        setOptimisticProfileFlair(
            auth.userId,
            returnedProfile as Partial<ProfileFlair>,
            true,
            Number.isFinite(Number(body?.profile?.updatedAt)) ? Number(body.profile.updatedAt) : undefined
        );
        // Refresh now rather than leaving the normal 30-second TTL in place.
        // The optimistic value covers the tiny interval where another worker
        // isolate still has the previous roster snapshot.
        await refreshRoster();
        scheduleScan();
        toast("✅ Profile flair saved and applied here — other Discordmaxxer users will sync shortly");
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
        toast(
            `Save failed: ${(e as any)?.name === "AbortError" ? "the profile service timed out — your local gradient is still applied" : (e as any)?.message ?? "network"}`,
            Toasts.Type.FAILURE,
            6000
        );
        return false;
    } finally {
        window.clearTimeout(timeout);
    }
}

/**
 * Tour-facing gradient action. Gradients are free locally for everyone. When
 * a claim is available, the same action also publishes to the shared roster;
 * the optimistic cache makes a successful shared change paint immediately.
 */
async function applySharedGradient(primary: string, secondary: string, _label?: string): Promise<boolean> {
    const nextPrimary = normalizeColor(primary);
    const nextSecondary = normalizeColor(secondary);
    if (!nextPrimary || !nextSecondary) {
        toast("That gradient contains an invalid color pair.", Toasts.Type.FAILURE, 5000);
        return false;
    }

    const profile: ProfileFlair = {
        themeColorPrimary: nextPrimary,
        themeColorSecondary: nextSecondary
    };

    sessionThemePreview = profile;
    const auth = getProfileAuth(false);
    if (!auth) {
        settings.store.myThemeColorPrimary = nextPrimary;
        settings.store.myThemeColorSecondary = nextSecondary;
        repaintProfileFlairNow();
        recordRecentPicks("", "", nextPrimary, nextSecondary);
        toast(
            `Applied ${_label ?? "gradient"} locally. Add a Discordmaxxer claim code in Profile Flair to sync it across PCs and other users.`,
            Toasts.Type.SUCCESS, 6500
        );
        return true;
    }

    // Update the draft and the local published preview before the network
    // round-trip. A shared write is best-effort because the gradient itself is
    // free and must remain useful even when the claim/service is unavailable.
    settings.store.myThemeColorPrimary = nextPrimary;
    settings.store.myThemeColorSecondary = nextSecondary;
    setOptimisticProfileFlair(auth.userId, profile);
    repaintProfileFlairNow();
    const ok = await postFlairUpdate(profile, false);
    if (!ok) {
        // Gradients are a free local feature. A failed shared write (old
        // worker, expired claim, offline start, or a temporary 403) must not
        // erase the user's working local choice or make the tour appear
        // broken. Keep the local selection, clear only the optimistic shared
        // cache, and explain the sync boundary.
        clearOptimisticProfileFlair(auth.userId);
        repaintProfileFlairNow();
        toast(
            `Applied ${_label ?? "gradient"} locally. Shared sync did not complete; your claim or the profile service may need attention.`,
            Toasts.Type.MESSAGE, 7000
        );
        return true;
    }

    recordRecentPicks("", "", nextPrimary, nextSecondary);
    sessionThemePreview = undefined;
    repaintProfileFlairNow();
    return true;
}

function validateLocal(profile: Partial<ProfileFlair>): string | null {
    for (const [k, v] of Object.entries(profile)) {
        if (!v) continue;
        if (k === "bannerUrl" || k === "avatarAnimatedUrl") {
            if (!URL_RE.test(v as string)) return k + " must be a direct HTTPS media URL of 250 characters or fewer. Page links will not render; use the file picker below or host the file first.";
            if (k === "avatarAnimatedUrl" && isVideoUrl(v as string)) {
                return "Shared animated avatars use GIF/image URLs; video files can still be sent once to real Discord, but Discordmaxxer renders shared avatars as images.";
            }
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
        const proxied = httpsUrl.startsWith("https://")
            ? `dm-media://proxy/${encodeURIComponent(httpsUrl)}`
            : httpsUrl;
        const res = await fetch(proxied, { signal: controller.signal });
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
        if ((e as any)?.name === "AbortError") {
            console.warn("[DMProfileFlair] urlToDataUri timed out");
        }
        console.warn("[DMProfileFlair] urlToDataUri failed:", e);
        return null;
    } finally {
        window.clearTimeout(timeout);
    }
}

/** Read a locally selected media file. Upload only happens after the user
 * explicitly chooses Publish as shared banner; the normal picker still keeps
 * the file local for preview or a one-time Discord broadcast. */
async function blobToDataUri(blob: Blob, mimeOverride?: string): Promise<string | null> {
    try {
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const value = reader.result as string;
                if (!mimeOverride || !value.startsWith("data:")) {
                    resolve(value);
                    return;
                }
                const comma = value.indexOf(",");
                resolve(comma > 0 ? `data:${mimeOverride};base64,${value.slice(comma + 1)}` : value);
            };
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
        const proxied = httpsUrl.startsWith("https://")
            ? `dm-media://proxy/${encodeURIComponent(httpsUrl)}`
            : httpsUrl;
        const res = await fetch(proxied, { signal: controller.signal });
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
        if ((e as any)?.name === "AbortError") {
            console.warn("[DMProfileFlair] extractStillFrame fetch timed out");
        }
        console.warn("[DMProfileFlair] extractStillFrameFromUrl failed:", e);
        return null;
    } finally {
        window.clearTimeout(timeout);
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
        let timer: number;
        const finish = (out: string | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            v.onloadeddata = null;
            v.onerror = null;
            v.removeAttribute("src");
            try { v.load(); } catch { /* detached media element */ }
            resolve(out);
        };
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
        timer = window.setTimeout(() => finish(null), 10000); // hard timeout — Discord PATCH path doesn't deserve to hang
        v.src = blobUrl;
    });
}

function drawImageFirstFrame(blobUrl: string): Promise<string | null> {
    return new Promise(resolve => {
        const img = new Image();
        let settled = false;
        let timer: number;
        const finish = (out: string | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            img.onload = null;
            img.onerror = null;
            img.src = "";
            resolve(out);
        };
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
        timer = window.setTimeout(() => finish(null), 10000);
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
    const nameStyleSettings = readPlainPluginSettings("DMDisplayNameStyle");
    const s = settings.store;
    const primary = normalizeColor(s.myThemeColorPrimary) ?? undefined;
    const secondary = normalizeColor(s.myThemeColorSecondary) ?? undefined;
    const nameStyle = isDisplayNameStylePresetId(nameStyleSettings.preset)
        ? {
            preset: nameStyleSettings.preset,
            ...Object.fromEntries([
                "customPrimary", "customSecondary", "customGlow", "fontFamily", "fontWeight",
                "letterSpacing", "casing", "effect", "motion", "animate"
            ].flatMap(key => nameStyleSettings[key] !== undefined ? [[key, nameStyleSettings[key]]] : []))
        } as ProfileLookConfig["nameStyle"]
        : undefined;

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
        },
        ...(nameStyle ? { nameStyle } : {})
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

function applyProfileLookConfig(config: ProfileLookConfig, only?: ProfileLookComponent): { changed: number; skipped: string[] } {
    const s = settings.store;
    const skipped = new Set<string>();
    let changed = 0;
    const flair: ProfileLookConfig["flair"] = only === "nameStyle"
        ? {}
        : only === "gradient"
            ? {
                ...(config.flair?.themeColorPrimary !== undefined ? { themeColorPrimary: config.flair.themeColorPrimary } : {}),
                ...(config.flair?.themeColorSecondary !== undefined ? { themeColorSecondary: config.flair.themeColorSecondary } : {})
            }
            : only
                ? { [only]: config.flair?.[only] }
                : config.flair ?? {};
    // Share codes are patches, not destructive full-state restores. A
    // banner-only code must not blank the recipient's avatar, and a full look
    // with an intentionally omitted field should leave that field alone.
    if (flair.bannerUrl !== undefined) {
        s.myBannerUrl = flair.bannerUrl;
        sessionLocalMediaPreview.add("banner");
        changed++;
    }
    if (flair.avatarAnimatedUrl !== undefined) {
        s.myAvatarAnimatedUrl = flair.avatarAnimatedUrl;
        sessionLocalMediaPreview.add("avatar");
        changed++;
    }
    if (flair.themeColorPrimary !== undefined) {
        s.myThemeColorPrimary = flair.themeColorPrimary;
        sessionThemePreview = { ...(sessionThemePreview && sessionThemePreview !== null ? sessionThemePreview : {}), themeColorPrimary: flair.themeColorPrimary };
        changed++;
    }
    if (flair.themeColorSecondary !== undefined) {
        s.myThemeColorSecondary = flair.themeColorSecondary;
        sessionThemePreview = { ...(sessionThemePreview && sessionThemePreview !== null ? sessionThemePreview : {}), themeColorSecondary: flair.themeColorSecondary };
        changed++;
    }
    const nameStyle = only === "nameStyle" ? config.nameStyle : only ? undefined : config.nameStyle;
    if (nameStyle) {
        for (const key of [
            "preset", "customPrimary", "customSecondary", "customGlow", "fontFamily", "fontWeight",
            "letterSpacing", "casing", "effect", "motion", "animate"
        ] as const) {
            const value = nameStyle[key];
            if (value !== undefined && writeVencordSetting("DMDisplayNameStyle", key, value, skipped)) changed++;
        }
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
    if (flair.bannerUrl !== undefined || flair.avatarAnimatedUrl !== undefined || flair.themeColorPrimary !== undefined || flair.themeColorSecondary !== undefined) {
        repaintProfileFlairNow();
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
    /** True once the File has been copied into Vencord's local IndexedDB. */
    remembered: boolean;
}

const MAX_LOCAL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_LOCAL_VIDEO_BYTES = 15 * 1024 * 1024;
const LOCAL_MEDIA_KEYS: Record<LocalMediaKind, string> = {
    banner: "dm-profile-flair-banner-file",
    avatar: "dm-profile-flair-avatar-file"
};

function isSupportedLocalMedia(file: File): boolean {
    if (/^image\/(gif|png|jpeg|webp)$/i.test(file.type)) return true;
    if (/^video\/(mp4|webm|quicktime)$/i.test(file.type)) return true;
    return /\.(gif|png|jpe?g|webp|mp4|webm|mov)$/i.test(file.name);
}

function inferLocalMime(file: File): string {
    if (file.type) return file.type.toLowerCase();
    const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    return ({
        gif: "image/gif",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime"
    } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

async function restoreLocalMedia(kind: LocalMediaKind): Promise<LocalMediaSelection | null> {
    try {
        const file = await DataStore.get<File>(LOCAL_MEDIA_KEYS[kind]);
        if (!file || typeof file.size !== "number" || typeof file.name !== "string" || !isSupportedLocalMedia(file)) return null;
        const mime = inferLocalMime(file);
        const isVideo = mime.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(file.name);
        const maxBytes = isVideo ? MAX_LOCAL_VIDEO_BYTES : MAX_LOCAL_IMAGE_BYTES;
        if (file.size > maxBytes) return null;
        const dataUri = await blobToDataUri(file, mime);
        if (!dataUri) return null;
        return {
            kind,
            name: file.name,
            mime,
            isVideo,
            file,
            previewUrl: URL.createObjectURL(file),
            dataUri,
            remembered: true
        };
    } catch (e) {
        console.warn(`[DMProfileFlair] could not restore remembered ${kind} file:`, e);
        return null;
    }
}

async function restoreLocalMediaForRenderer(): Promise<void> {
    for (const kind of ["banner", "avatar"] as const) {
        const restored = await restoreLocalMedia(kind);
        if (!restored) continue;
        setLocalRenderMedia(kind, { url: restored.dataUri, isVideo: restored.isVideo });
        URL.revokeObjectURL(restored.previewUrl);
    }
    repaintProfileFlairNow();
}

async function forgetLocalMedia(kind: LocalMediaKind): Promise<void> {
    clearLocalRenderMedia(kind);
    try {
        await DataStore.del(LOCAL_MEDIA_KEYS[kind]);
    } catch (e) {
        console.warn(`[DMProfileFlair] could not clear remembered ${kind} file:`, e);
    }
}

interface ProfileAppearanceBackupMedia {
    name: string;
    mime: string;
    isVideo: boolean;
    dataUri: string;
}

interface ProfileAppearanceBackup {
    version: 1;
    exportedAt: string;
    flair: ProfileLookConfig["flair"];
    localMedia?: Partial<Record<LocalMediaKind, ProfileAppearanceBackupMedia>>;
}

function dataUriToFile(dataUri: string, name: string, mime: string): File | null {
    const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUri);
    if (!match) return null;
    try {
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new File([bytes], name, { type: mime || match[1] || "application/octet-stream" });
    } catch (e) {
        console.warn("[DMProfileFlair] backup media decode failed:", e);
        return null;
    }
}

function downloadAppearanceBackup(payload: ProfileAppearanceBackup): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "discordmaxxer-profile-appearance-backup.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Upload only after an explicit publish click. The returned URL is then
 * saved through the normal roster profile endpoint, so every Discordmaxxer
 * client resolves the same media instead of keeping it in one install's
 * memory. */
async function uploadLocalMedia(media: LocalMediaSelection): Promise<string | null> {
    const auth = getProfileAuth();
    if (!auth) return null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(WORKER_PROFILE_MEDIA_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                userId: auth.userId,
                claimCode: auth.claimCode,
                kind: media.kind,
                name: media.name,
                mime: media.mime,
                dataUri: media.dataUri
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const serverError = String(body?.error ?? res.status);
            const friendlyError = /storage.*not configured|media storage/i.test(serverError)
                ? "shared local-file publishing is not live on the profile worker yet"
                : serverError;
            toast(`Publish failed: ${friendlyError}`, Toasts.Type.FAILURE, 7000);
            return null;
        }
        const url = String(body?.url ?? "");
        if (!URL_RE.test(url)) {
            toast("Publish failed: the worker returned an invalid media URL.", Toasts.Type.FAILURE, 6000);
            return null;
        }
        return url;
    } catch (e: any) {
        console.warn("[DMProfileFlair] local profile-media upload failed:", e);
        toast(
            `Publish failed: ${e?.name === "AbortError" ? "the media service timed out — try again" : e?.message ?? "network"}`,
            Toasts.Type.FAILURE,
            7000
        );
        return null;
    } finally {
        window.clearTimeout(timeout);
    }
}

function FlairEditor() {
    const s = settings.store;
    const [busy, setBusy] = React.useState(false);
    const [shareCode, setShareCode] = React.useState("");
    const [shareImport, setShareImport] = React.useState("");
    const [shareMessage, setShareMessage] = React.useState("");
    const [restoreMessage, setRestoreMessage] = React.useState("");
    const [localMedia, setLocalMedia] = React.useState<Partial<Record<LocalMediaKind, LocalMediaSelection>>>({});
    const [draggingKind, setDraggingKind] = React.useState<LocalMediaKind | null>(null);
    const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
    const [whyLayer, setWhyLayer] = React.useState<"gradient" | "banner" | "avatar" | null>(null);
    const [health, setHealth] = React.useState(getProfileFlairRenderHealth());
    const [customGradientPrimary, setCustomGradientPrimary] = React.useState(
        normalizeColor(s.myThemeColorPrimary) || GRADIENT_PRESETS[2].primary
    );
    const [customGradientSecondary, setCustomGradientSecondary] = React.useState(
        normalizeColor(s.myThemeColorSecondary) || GRADIENT_PRESETS[2].secondary
    );
    const localMediaRef = React.useRef(localMedia);
    const bannerFileInput = React.useRef<HTMLInputElement>(null);
    const avatarFileInput = React.useRef<HTMLInputElement>(null);
    const backupFileInput = React.useRef<HTMLInputElement>(null);
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
        const id = window.setInterval(() => setHealth(getProfileFlairRenderHealth()), 1000);
        return () => clearInterval(id);
    }, []);

    React.useEffect(() => { localMediaRef.current = localMedia; }, [localMedia]);
    React.useEffect(() => () => {
        Object.values(localMediaRef.current).forEach(media => {
            if (media) URL.revokeObjectURL(media.previewUrl);
        });
    }, []);

    // Match VideoBackground's proven local-file behavior: keep the selected
    // banner/avatar in Vencord's IndexedDB so reopening the editor or
    // restarting Discordmaxxer does not make a prepared file disappear. This
    // is intentionally per-PC; Publish as shared... remains the explicit
    // cross-PC path, and a Windows reinstall still requires the original file.
    React.useEffect(() => {
        let alive = true;
        (async () => {
            for (const kind of ["banner", "avatar"] as const) {
                const restored = await restoreLocalMedia(kind);
                if (!restored) continue;
                if (!alive) {
                    URL.revokeObjectURL(restored.previewUrl);
                    continue;
                }
                const current = localMediaRef.current[kind];
                if (current) {
                    URL.revokeObjectURL(restored.previewUrl);
                    continue;
                }
                const next = { ...localMediaRef.current, [kind]: restored };
                localMediaRef.current = next;
                setLocalMedia(next);
                setLocalRenderMedia(kind, { url: restored.dataUri, isVideo: restored.isVideo });
                repaintProfileFlairNow();
            }
        })();
        return () => { alive = false; };
    }, []);

    const onPickLocalFile = async (kind: LocalMediaKind, file: File) => {
        if (!isSupportedLocalMedia(file)) {
            toast("Choose a GIF, PNG, JPG, WEBP, MP4, or WEBM file.", Toasts.Type.FAILURE, 5000);
            return;
        }
        const mime = inferLocalMime(file);
        const isVideo = mime.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(file.name);
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
        const dataUri = await blobToDataUri(file, mime);
        if (!dataUri) {
            toast("Couldn't read that file.", Toasts.Type.FAILURE, 5000);
            return;
        }
        let remembered = false;
        try {
            await DataStore.set(LOCAL_MEDIA_KEYS[kind], file);
            remembered = true;
        } catch (e) {
            console.warn(`[DMProfileFlair] could not remember local ${kind} file:`, e);
        }
        const previewUrl = URL.createObjectURL(file);
        const old = localMediaRef.current[kind];
        if (old) URL.revokeObjectURL(old.previewUrl);
        const next = {
            ...localMediaRef.current,
            [kind]: { kind, name: file.name, mime, isVideo, file, previewUrl, dataUri, remembered }
        };
        localMediaRef.current = next;
        setLocalMedia(next);
        setLocalRenderMedia(kind, { url: dataUri, isVideo }, true);
        repaintProfileFlairNow();
        toast(kind === "banner"
            ? `Banner file ready${remembered ? " and remembered on this PC" : " for this session"}. Publish it for cross-PC Discordmaxxer sharing, or use a one-time Discord action.`
            : `Avatar file ready${remembered ? " and remembered on this PC" : " for this session"}. Publish it for cross-PC Discordmaxxer sharing, or use the one-time Discord action.`,
             Toasts.Type.SUCCESS, 4500);
    };

    const onExportAppearanceBackup = () => {
        const current = readProfileLookConfig();
        const backup: ProfileAppearanceBackup = {
            version: 1,
            exportedAt: new Date().toISOString(),
            flair: current.flair,
            localMedia: {}
        };
        for (const kind of ["banner", "avatar"] as const) {
            const media = localMedia[kind];
            if (!media) continue;
            backup.localMedia![kind] = {
                name: media.name,
                mime: media.mime,
                isVideo: media.isVideo,
                dataUri: media.dataUri
            };
        }
        try {
            downloadAppearanceBackup(backup);
            setRestoreMessage("Exported a private profile-appearance backup. Keep that JSON file somewhere safe before reinstalling Windows.");
            toast("✅ Appearance backup downloaded — it includes selected local media, not your claim code.", Toasts.Type.SUCCESS, 6000);
        } catch (e) {
            console.warn("[DMProfileFlair] appearance backup export failed:", e);
            toast("Could not download the appearance backup.", Toasts.Type.FAILURE, 5000);
        }
    };

    const onImportAppearanceBackup = async (file: File) => {
        try {
            if (file.size > 30 * 1024 * 1024) {
                toast("That backup is over 30 MB. Exported local media backups should stay under 30 MB.", Toasts.Type.FAILURE, 6000);
                return;
            }
            const raw = JSON.parse(await file.text()) as Partial<ProfileAppearanceBackup>;
            if (raw.version !== 1 || !raw.flair || typeof raw.flair !== "object") {
                toast("That is not a supported Discordmaxxer profile-appearance backup.", Toasts.Type.FAILURE, 6000);
                return;
            }
            // Reuse the share-code sanitizer for HTTPS URLs and colors without
            // exposing the backup format as an account credential format.
            const validated = decodeProfileLook(encodeProfileLook({ flair: raw.flair }));
            if (!validated.ok) {
                toast("The backup has invalid or unsupported flair fields.", Toasts.Type.FAILURE, 6000);
                return;
            }
            const result = applyProfileLookConfig(validated.value);
            let restoredMedia = 0;
            for (const kind of ["banner", "avatar"] as const) {
                const saved = raw.localMedia?.[kind];
                if (!saved || typeof saved !== "object") continue;
                if (typeof saved.name !== "string" || typeof saved.mime !== "string" || typeof saved.dataUri !== "string") continue;
                const importedFile = dataUriToFile(saved.dataUri, saved.name, saved.mime);
                if (!importedFile || !isSupportedLocalMedia(importedFile)) continue;
                await onPickLocalFile(kind, importedFile);
                restoredMedia++;
            }
            repaintProfileFlairNow();
            setRestoreMessage(
                `Imported ${result.changed} flair field${result.changed === 1 ? "" : "s"}` +
                (restoredMedia ? ` and ${restoredMedia} local media file${restoredMedia === 1 ? "" : "s"}` : "") +
                `. Review the editor, then click Save to Discordmaxxer if you want shared roster changes.`
            );
        } catch (e) {
            console.warn("[DMProfileFlair] appearance backup import failed:", e);
            toast("Could not read that appearance backup. It may be truncated or from a newer version.", Toasts.Type.FAILURE, 6000);
        }
    };

    const onDropLocalFile = (kind: LocalMediaKind, event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDraggingKind(null);
        const file = event.dataTransfer.files?.[0];
        if (file) void onPickLocalFile(kind, file);
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
            sessionLocalMediaPreview.clear();
            sessionThemePreview = undefined;
            let restored = 0;
            if (saved.bannerUrl !== undefined) { s.myBannerUrl = saved.bannerUrl; restored++; }
            if (saved.avatarAnimatedUrl !== undefined) { s.myAvatarAnimatedUrl = saved.avatarAnimatedUrl; restored++; }
            if (saved.themeColorPrimary !== undefined) { s.myThemeColorPrimary = saved.themeColorPrimary; restored++; }
            if (saved.themeColorSecondary !== undefined) { s.myThemeColorSecondary = saved.themeColorSecondary; restored++; }
            repaintProfileFlairNow();
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
        if (kind === "banner" && media.isVideo && !stillFrame) {
            toast("A video cannot be sent as a native Discord banner in this action. Use Send first frame, or Publish as shared banner for Discordmaxxer users.", Toasts.Type.FAILURE, 7000);
            return;
        }
        const label = kind === "avatar" ? "avatar" : stillFrame ? "still-frame banner" : "banner";
        if (!confirm(broadcastConfirmCopy(label, stillFrame
            ? "We'll extract the first frame locally, then send one PNG upload to your real Discord profile. Discord banners still require Nitro."
            : "This sends the selected file once to your real Discord profile. It does not save the file to the Discordmaxxer roster."))) return;
        setBusy(true);
        try {
            if (kind === "avatar") {
                await broadcastAvatarDataUri(media.dataUri);
            } else if (stillFrame) {
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

    const onPublishLocalBanner = async () => {
        const media = localMedia.banner;
        if (!media) return;
        if (!confirm(
            "Publish this banner as shared Discordmaxxer media? A copy will be uploaded to MaxxTopia profile media storage and saved to your roster so it can appear on your other PCs and to other Discordmaxxer users. This does not change your Discord account. To update the banner shown by standard Discord clients, use Send banner once or Discord's native profile editor; Discord's own Nitro and format rules still apply."
        )) return;
        setBusy(true);
        try {
            toast("Uploading your shared banner…", Toasts.Type.MESSAGE, 4000);
            const url = await uploadLocalMedia(media);
            if (!url) return;
            const ok = await postFlairUpdate({ bannerUrl: url }, false);
            if (ok) {
                sessionLocalMediaPreview.delete("banner");
                s.myBannerUrl = url;
                recordRecentPicks(url, "", "", "");
                repaintProfileFlairNow();
                toast("✅ Shared banner published — other Discordmaxxer clients can now load it.", Toasts.Type.SUCCESS, 6000);
            }
        } finally {
            setBusy(false);
        }
    };

    const onPublishLocalAvatar = async () => {
        const media = localMedia.avatar;
        if (!media) return;
        if (media.isVideo) {
            toast("Shared Discordmaxxer avatars use GIF/image files. Use Send avatar once for a native Discord video-capable upload.", Toasts.Type.FAILURE, 7000);
            return;
        }
        if (!confirm(
            "Publish this avatar as your shared Discordmaxxer avatar? It will be uploaded to shared profile media storage and appear on your other PCs and to other Discordmaxxer users. This is separate from Send avatar once."
        )) return;
        setBusy(true);
        try {
            toast("Uploading your shared avatar…", Toasts.Type.MESSAGE, 4000);
            const url = await uploadLocalMedia(media);
            if (!url) return;
            const ok = await postFlairUpdate({ avatarAnimatedUrl: url }, false);
            if (ok) {
                sessionLocalMediaPreview.delete("avatar");
                s.myAvatarAnimatedUrl = url;
                recordRecentPicks("", url, "", "");
                repaintProfileFlairNow();
                toast("✅ Shared avatar published — other Discordmaxxer clients can now load it.", Toasts.Type.SUCCESS, 6000);
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
        if (sessionLocalMediaPreview.has("banner") && banner) proposed.bannerUrl = banner;
        if (sessionLocalMediaPreview.has("avatar") && avatar) proposed.avatarAnimatedUrl = avatar;
        if (sessionThemePreview?.themeColorPrimary !== undefined && primary) proposed.themeColorPrimary = primary;
        if (sessionThemePreview?.themeColorSecondary !== undefined && secondary) proposed.themeColorSecondary = secondary;
        if (!Object.keys(proposed).length) {
            toast(
                localMedia.banner
                    ? "Choose Publish as shared banner to upload the selected file, or Restore my published look."
                    : "There is nothing new to save. Use Restore my published look or an explicit Clear button.",
                Toasts.Type.MESSAGE, 5000
            );
            return;
        }
        const err = validateLocal(proposed);
        if (err) { toast(err, Toasts.Type.FAILURE, 5000); return; }

        const auth = getProfileAuth(false);
        const hasMedia = proposed.bannerUrl !== undefined || proposed.avatarAnimatedUrl !== undefined;
        if (!auth) {
            if (hasMedia) {
                // Keep the security boundary explicit: a free user can use a
                // local gradient without a claim, but media needs an
                // authenticated, tier-checked shared write or an upload path.
                getProfileAuth();
                return;
            }
            if (primary) s.myThemeColorPrimary = primary;
            if (secondary) s.myThemeColorSecondary = secondary;
            if (primary || secondary) {
                sessionThemePreview = {
                    ...(primary ? { themeColorPrimary: primary } : {}),
                    ...(secondary ? { themeColorSecondary: secondary } : {})
                };
            }
            repaintProfileFlairNow();
            recordRecentPicks("", "", primary, secondary);
            toast(
                "Saved this gradient locally. Add a Discordmaxxer claim code to sync it across PCs and show it to other Discordmaxxer users.",
                Toasts.Type.SUCCESS, 6500
            );
            return;
        }

        setBusy(true);
        // Paint free theme colors before the shared round-trip. This keeps the
        // editor responsive even when the worker is slow or an older worker
        // still rejects a free-gradient write.
        if (primary) s.myThemeColorPrimary = primary;
        if (secondary) s.myThemeColorSecondary = secondary;
        if (primary || secondary) {
            sessionThemePreview = {
                ...(primary ? { themeColorPrimary: primary } : {}),
                ...(secondary ? { themeColorSecondary: secondary } : {})
            };
        }
        if (primary || secondary) repaintProfileFlairNow();
        const ok = await postFlairUpdate(proposed, false);
        if (ok) {
            if (proposed.bannerUrl) sessionLocalMediaPreview.delete("banner");
            if (proposed.avatarAnimatedUrl) sessionLocalMediaPreview.delete("avatar");
            if (proposed.themeColorPrimary !== undefined || proposed.themeColorSecondary !== undefined) sessionThemePreview = undefined;
            repaintProfileFlairNow();
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

    const onApplyGradientChoice = async (primary: string, secondary: string, label: string) => {
        setCustomGradientPrimary(primary);
        setCustomGradientSecondary(secondary);
        setBusy(true);
        try {
            await applySharedGradient(primary, secondary, label);
        } finally {
            setBusy(false);
        }
    };

    const onClearField = async (field: "bannerUrl" | "avatarAnimatedUrl") => {
        const label = field === "bannerUrl" ? "banner" : "animated avatar";
        if (!confirm("Clear only your saved " + label + "? Your other flair stays unchanged.")) return;
        if (!getProfileAuth(false)) {
            if (field === "bannerUrl") s.myBannerUrl = "";
            else s.myAvatarAnimatedUrl = "";
            void forgetLocalMedia(field === "bannerUrl" ? "banner" : "avatar");
            scheduleScan();
            toast(`Cleared the local ${label} draft. A claim is needed to remove a shared roster value.`, Toasts.Type.MESSAGE, 5500);
            return;
        }
        setBusy(true);
        const update: Partial<ProfileFlair> = field === "bannerUrl"
            ? { bannerUrl: "" }
            : { avatarAnimatedUrl: "" };
        const ok = await postFlairUpdate(update, false);
        if (ok) {
            if (field === "bannerUrl") s.myBannerUrl = "";
            else s.myAvatarAnimatedUrl = "";
            await forgetLocalMedia(field === "bannerUrl" ? "banner" : "avatar");
            repaintProfileFlairNow();
        }
        setBusy(false);
    };

    const onClearGradient = async () => {
        if (!confirm("Clear only your saved profile gradient? Your banner and avatar stay unchanged.")) return;
        if (!getProfileAuth(false)) {
            s.myThemeColorPrimary = "";
            s.myThemeColorSecondary = "";
            sessionThemePreview = null;
            repaintProfileFlairNow();
            toast("Cleared the local profile gradient. Your shared roster gradient is unchanged until you authenticate.", Toasts.Type.MESSAGE, 6000);
            return;
        }
        setBusy(true);
        s.myThemeColorPrimary = "";
        s.myThemeColorSecondary = "";
        sessionThemePreview = null;
        repaintProfileFlairNow();
        const ok = await postFlairUpdate({ themeColorPrimary: "", themeColorSecondary: "" }, false);
        if (ok) {
            sessionThemePreview = undefined;
            repaintProfileFlairNow();
        }
        setBusy(false);
    };

    const onClearAll = async () => {
        if (!confirm("Clear all your custom profile flair (banner, avatar, colors)?")) return;
        if (!getProfileAuth(false)) {
            s.myBannerUrl = "";
            s.myAvatarAnimatedUrl = "";
            s.myThemeColorPrimary = "";
            s.myThemeColorSecondary = "";
            sessionThemePreview = null;
            await Promise.all([forgetLocalMedia("banner"), forgetLocalMedia("avatar")]);
            repaintProfileFlairNow();
            toast("Cleared this install's local profile flair. A claim is needed to clear shared roster flair.", Toasts.Type.MESSAGE, 6000);
            return;
        }
        setBusy(true);
        const ok = await postFlairUpdate({}, true);
        if (ok) {
            s.myBannerUrl = "";
            s.myAvatarAnimatedUrl = "";
            s.myThemeColorPrimary = "";
            s.myThemeColorSecondary = "";
            sessionLocalMediaPreview.clear();
            sessionThemePreview = undefined;
            await Promise.all([forgetLocalMedia("banner"), forgetLocalMedia("avatar")]);
            repaintProfileFlairNow();
        }
        setBusy(false);
    };

    const onCreateProfileLookShare = async (only?: ProfileLookComponent) => {
        try {
            const current = readProfileLookConfig();
            const hasComponent = only === "gradient"
                ? current.flair.themeColorPrimary !== undefined || current.flair.themeColorSecondary !== undefined
                : only === "nameStyle"
                    ? current.nameStyle?.preset !== undefined
                : only
                    ? current.flair[only] !== undefined
                    : true;
            if (only && !hasComponent) {
                setShareMessage("Choose a " + profileLookComponentLabel(only) + " first.");
                return;
            }
            const flair: ProfileLookConfig["flair"] = only === "gradient"
                ? {
                    ...(current.flair.themeColorPrimary ? { themeColorPrimary: current.flair.themeColorPrimary } : {}),
                    ...(current.flair.themeColorSecondary ? { themeColorSecondary: current.flair.themeColorSecondary } : {})
                }
                : only
                    ? { [only]: current.flair[only] }
                    : current.flair;
            const code = only === "nameStyle"
                ? encodeProfileLook({ flair: {}, nameStyle: current.nameStyle })
                : encodeProfileLook(only ? { flair } : current);
            setShareCode(code);
            const copied = await copyProfileLookCode(code);
            setShareMessage(copied
                ? (only ? "Copied a " + profileLookComponentLabel(only) + "-only code." : "Copied the full cosmetic look.")
                : "Code ready below. Clipboard access was unavailable, so copy it from the box.");
        } catch (e) {
            console.warn("[DMProfileFlair] profile-look encode failed:", e);
            setShareMessage("Could not create a profile-look code from the current settings.");
        }
    };

    const onImportProfileLookShare = (only?: ProfileLookComponent) => {
        const decoded = decodeProfileLook(shareImport);
        if (!decoded.ok) {
            setShareMessage(decoded.error);
            return;
        }
        const result = applyProfileLookConfig(decoded.value, only);
        if (only && result.changed === 0) {
            setShareMessage(result.skipped.length
                ? `Could not import ${profileLookComponentLabel(only)}. Enable ${result.skipped.join(" and ")} first.`
                : `That code does not contain a ${profileLookComponentLabel(only)}.`);
            return;
        }
        setShareMessage(only === "nameStyle"
            ? `Imported ${result.changed} local name-style settings. This does not update your real Discord profile.`
            : result.skipped.length
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
    const gradientPickerWrapStyle: React.CSSProperties = {
        marginTop: 12, padding: "10px 11px",
        background: "rgba(226, 91, 255, 0.06)",
        border: "1px solid rgba(226, 91, 255, 0.25)",
        borderRadius: 7
    };
    const gradientGridStyle: React.CSSProperties = {
        display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 6, marginTop: 8
    };
    const gradientChoiceStyle: React.CSSProperties = {
        minHeight: 38, border: "1px solid rgba(255,255,255,0.25)",
        borderRadius: 5, color: "#fff", cursor: "pointer", padding: "4px 5px",
        textShadow: "0 1px 2px rgba(0,0,0,0.8)", fontSize: 10, fontWeight: 700,
        overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis"
    };
    const customGradientRowStyle: React.CSSProperties = {
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 9
    };
    const colorInputStyle: React.CSSProperties = {
        width: 32, height: 26, padding: 1, border: "1px solid rgba(255,255,255,0.3)",
        borderRadius: 4, background: "transparent", cursor: "pointer"
    };

    const currentUser = UserStore.getCurrentUser?.();
    const publishedFlair = currentUser?.id ? getRosterProfileFlair(currentUser.id) : undefined;
    const localTheme = getLocalThemeFlair();
    const rosterReady = hasAuthoritativeRosterSnapshot();
    const hasPublishedTheme = !!(publishedFlair?.themeColorPrimary || publishedFlair?.themeColorSecondary);
    const baseTheme = hasPublishedTheme ? publishedFlair : localTheme;
    const visibleTheme = sessionThemePreview === null
        ? undefined
        : sessionThemePreview !== undefined
            ? { ...(baseTheme ?? {}), ...sessionThemePreview }
            : baseTheme;
    const sourceFor = (kind: "gradient" | "banner" | "avatar"): string => {
        if (kind === "gradient") {
            if (sessionThemePreview !== undefined) return sessionThemePreview === null ? "Local clear • this session" : "Local preview • this session";
            if (hasPublishedTheme) return "Shared roster";
            return localTheme ? "Local fallback • this PC" : "Not set";
        }
        const sharedUrl = publishedFlair?.[kind === "banner" ? "bannerUrl" : "avatarAnimatedUrl"];
        if (sessionLocalMediaPreview.has(kind)) return localMedia[kind] ? "Local file • preview" : "Local URL • preview";
        if (sharedUrl) return "Shared roster";
        if (localMedia[kind]) return "Local file • this PC";
        const draft = kind === "banner" ? s.myBannerUrl.trim() : s.myAvatarAnimatedUrl.trim();
        return draft ? (rosterReady ? "Local URL • this PC" : "Local URL • roster offline") : "Not set";
    };
    const explanationFor = (kind: "gradient" | "banner" | "avatar"): string => {
        if (kind === "gradient") {
            if (sessionThemePreview === null) return "The gradient is cleared in this session. If a shared gradient exists, the published value is unchanged until you clear it while authenticated.";
            if (sessionThemePreview !== undefined) return "This is your instant local preview. Save it to publish the colors; after publishing, the shared roster is canonical on every PC.";
            if (hasPublishedTheme) return "This gradient comes from the shared Discordmaxxer roster and should match on every install. Older per-PC color settings no longer override it.";
            if (localTheme) return "No shared gradient is published, so this saved local fallback appears only on this PC. Pick a preset and save with a claim to sync it.";
            return "No gradient is currently selected. Pick a preset or choose two colors below; the new choice previews immediately.";
        }
        const sharedUrl = publishedFlair?.[kind === "banner" ? "bannerUrl" : "avatarAnimatedUrl"];
        const media = localMedia[kind];
        if (sessionLocalMediaPreview.has(kind)) return media
            ? `${kind === "banner" ? "Banner" : "Avatar"} file is an instant local preview. Publish it for cross-PC Discordmaxxer visibility, or use the one-time native Discord action separately.`
            : `This URL is an instant local preview. Save it to publish; the shared roster becomes canonical across PCs.`;
        if (sharedUrl) return "This media comes from the shared roster and is the same value other Discordmaxxer installs should render. An older URL or remembered file on this PC will not replace it.";
        if (media) return `${kind === "banner" ? "Banner" : "Avatar"} file is saved locally on this PC only. Publish it for cross-PC Discordmaxxer visibility, or use the one-time native Discord action separately.`;
        const draft = kind === "banner" ? s.myBannerUrl.trim() : s.myAvatarAnimatedUrl.trim();
        if (draft && !rosterReady) {
            if (!URL_RE.test(draft)) {
                return "This saved URL is being kept as a local preview on this PC, but it is too long or otherwise invalid for shared roster publishing. Use Choose a file → Publish to share it without hunting for a shorter URL.";
            }
            return "The shared roster is temporarily unavailable, so your saved URL is being shown on this PC only. Save it after roster sync recovers to make it visible to other Discordmaxxer users and your other PC.";
        }
        if (draft) return "This saved URL is a local fallback because the shared roster has no value for this field. Edit it and choose Save to publish the URL.";
        return "No shared media is set. Choose a local file or paste a direct HTTPS URL.";
    };
    const appearanceCenterStyle: React.CSSProperties = {
        marginTop: 10, padding: "10px 11px", borderRadius: 7,
        background: "rgba(72, 184, 255, 0.06)", border: "1px solid rgba(72, 184, 255, 0.28)"
    };
    const appearanceGridStyle: React.CSSProperties = {
        display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 7, marginTop: 8
    };
    const appearanceCardStyle: React.CSSProperties = {
        minWidth: 0, padding: "8px 9px", borderRadius: 6,
        background: "rgba(0, 0, 0, 0.18)", border: "1px solid rgba(255,255,255,0.1)"
    };
    const sourceBadgeStyle: React.CSSProperties = {
        display: "inline-block", marginTop: 4, padding: "2px 5px", borderRadius: 99,
        background: "rgba(155,231,255,0.12)", color: "#9be7ff", fontSize: 9.5
    };
    const whyButtonStyle: React.CSSProperties = {
        marginTop: 7, padding: "3px 6px", borderRadius: 4, cursor: "pointer",
        border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#cbd0e0", fontSize: 10
    };
    const dropZoneStyle = (kind: LocalMediaKind): React.CSSProperties => ({
        flex: 1, minWidth: 190, padding: "7px 9px", borderRadius: 5, textAlign: "center",
        border: `1px dashed ${draggingKind === kind ? "#ff6ec7" : "rgba(155,231,255,0.45)"}`,
        background: draggingKind === kind ? "rgba(255,110,199,0.12)" : "rgba(0,0,0,0.12)",
        color: "#cbd0e0", fontSize: 10.5
    });

    return (
        <div style={wrapStyle}>
            <div style={titleStyle}>🎨 Save your custom flair</div>

            <div style={appearanceCenterStyle} aria-label="Profile Appearance Center">
                <div style={titleStyle}>🧩 Profile Appearance Center</div>
                <div style={{ ...noteStyle, marginBottom: 0 }}>
                    These are three independent layers. The badge tells you where each layer comes from;
                    <b> Why am I seeing this?</b> explains the current local, shared, native, or performance boundary.
                    Published roster fields are canonical across PCs; older per-install drafts are only fallbacks when no shared field exists.
                </div>
                <div role="status" style={{ marginTop: 7, padding: "6px 8px", borderRadius: 5, background: "rgba(155, 231, 255, 0.09)", border: "1px solid rgba(155, 231, 255, 0.28)", color: "#bfefff", fontSize: 10.5, lineHeight: 1.4 }}>
                    Windows/Discord reduced-motion settings do not replace your custom banner or avatar with a still frame. TournamentMode is the only mode that pauses animated flair.
                </div>
                <div style={appearanceGridStyle}>
                    {(["gradient", "banner", "avatar"] as const).map(kind => {
                        const label = kind === "gradient" ? "🌈 Gradient" : kind === "banner" ? "🖼️ Banner" : "👤 Avatar";
                        const preview = kind === "gradient"
                            ? <div style={{ height: 28, borderRadius: 4, background: `linear-gradient(180deg, ${visibleTheme?.themeColorPrimary ?? "#29223a"}, ${visibleTheme?.themeColorSecondary ?? "#17131d"})` }} />
                            : <div style={{ height: 28, borderRadius: 4, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{localMedia[kind] ? (localMedia[kind]!.isVideo ? "🎬 local video" : "🖼️ local file") : sourceFor(kind)}</div>;
                        return (
                            <div key={kind} style={appearanceCardStyle}>
                                <div style={{ fontSize: 11.5, color: "#fbefff", fontWeight: 700 }}>{label}</div>
                                <span style={sourceBadgeStyle}>{sourceFor(kind)}</span>
                                <div style={{ marginTop: 7 }}>{preview}</div>
                                <button
                                    type="button"
                                    style={whyButtonStyle}
                                    aria-expanded={whyLayer === kind}
                                    onClick={() => setWhyLayer(current => current === kind ? null : kind)}
                                >
                                    {whyLayer === kind ? "Hide details" : "Why am I seeing this?"}
                                </button>
                                {whyLayer === kind && <div style={{ marginTop: 6, fontSize: 10.5, lineHeight: 1.4, color: "#cbd0e0" }}>{explanationFor(kind)}</div>}
                            </div>
                        );
                    })}
                </div>
                <button
                    type="button"
                    style={{ ...whyButtonStyle, marginTop: 9 }}
                    aria-expanded={diagnosticsOpen}
                    onClick={() => setDiagnosticsOpen(value => !value)}
                >
                    {diagnosticsOpen ? "Hide renderer health" : "Show renderer health"}
                </button>
                {diagnosticsOpen && (
                    <div role="status" aria-live="polite" style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.45, color: "#cbd0e0" }}>
                        Scans: {health.scanCount} · visible banners: {health.visibleBanners} · visible avatars: {health.visibleAvatars} · applied layers: {health.appliedBanners + health.appliedThemes + health.appliedAvatars}.
                        {health.lastFailure ? <> Last fallback: <b>{health.lastFailure}</b>.</> : " No media fallback failures recorded."}
                        {tmActive ? " TournamentMode is pausing animated media." : " Animated flair is active; Windows/Discord reduced-motion settings do not override it."}
                    </div>
                )}
            </div>

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
                                    onClick={() => {
                                        s.myBannerUrl = url;
                                        sessionLocalMediaPreview.add("banner");
                                        repaintProfileFlairNow();
                                    }}
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
                                    onClick={() => {
                                        s.myAvatarAnimatedUrl = url;
                                        sessionLocalMediaPreview.add("avatar");
                                        repaintProfileFlairNow();
                                    }}
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
                                        onClick={() => {
                                            s.myThemeColorPrimary = p;
                                            s.myThemeColorSecondary = sec;
                                            sessionThemePreview = { themeColorPrimary: p, themeColorSecondary: sec };
                                            repaintProfileFlairNow();
                                        }}
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
                <b>Client-rendered look:</b> these values are saved to the shared roster and
                rendered by compatible Discordmaxxer clients, including yours. These fields are
                per-install drafts until you click Save; the published roster is what
                determines the look on every PC. <b>Real Discord look:</b> the optional
                controls below make separate one-time account changes through Discord's profile system.
                Worker validates each roster field — banner needs MAXXER, animated avatar
                needs MAXXER+, and profile gradients are free for every Discordmaxxer user.
                A valid Discordmaxxer claim is required only to publish shared values
                across PCs and to other Discordmaxxer users; unclaimed gradients stay local.
            </div>
            <div style={gradientPickerWrapStyle}>
                <div style={titleStyle}>🌈 Quick gradient picker</div>
                <div style={{ ...noteStyle, marginBottom: 0 }}>
                    Choose a ready-made blend or make your own. A click applies the gradient to this
                    install immediately; if you have a claim, it also tries to sync it across PCs.
                </div>
                <div style={gradientGridStyle}>
                    {GRADIENT_PRESETS.map(preset => (
                        <button
                            key={preset.id}
                            type="button"
                            title={`Apply ${preset.label}`}
                            aria-label={`Apply ${preset.label} gradient`}
                            style={{ ...gradientChoiceStyle, background: `linear-gradient(165deg, ${preset.primary}, ${preset.secondary})` }}
                            onClick={() => void onApplyGradientChoice(preset.primary, preset.secondary, preset.label)}
                            disabled={busy}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
                <div style={customGradientRowStyle}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#cbd0e0" }}>
                        Top
                        <input
                            type="color"
                            value={customGradientPrimary}
                            aria-label="Custom gradient top color"
                            style={colorInputStyle}
                            onChange={e => setCustomGradientPrimary(e.currentTarget.value)}
                            disabled={busy}
                        />
                    </label>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#cbd0e0" }}>
                        Bottom
                        <input
                            type="color"
                            value={customGradientSecondary}
                            aria-label="Custom gradient bottom color"
                            style={colorInputStyle}
                            onChange={e => setCustomGradientSecondary(e.currentTarget.value)}
                            disabled={busy}
                        />
                    </label>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.BRAND}
                        onClick={() => void onApplyGradientChoice(customGradientPrimary, customGradientSecondary, "Custom blend")}
                        disabled={busy}
                    >
                        Apply custom blend now
                    </Button>
                </div>
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
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => void onClearGradient()} disabled={busy}>
                    Clear gradient only
                </Button>
            </div>
            {restoreMessage && <div style={{ ...noteStyle, marginTop: 7, marginBottom: 0 }}>{restoreMessage}</div>}

            <div style={fileWrapStyle}>
                <div style={titleStyle}>📁 Use a downloaded GIF, image, or video</div>
                <div style={noteStyle}>
                    Choose a local file for a preview, a shared Discordmaxxer banner/avatar, or a
                    one-time real-Discord broadcast. The selected file is remembered on this PC
                    through Discordmaxxer restarts when local storage succeeds; Publish saves a
                    copy to the shared roster across PCs. Export a private backup before a Windows
                    reinstall if you want to restore the local file bytes without hunting for the
                    original again. Local gradients and roster media remain client-rendered; use the
                    separate one-time Discord profile controls for account fields supported by Discord.
                </div>
                <input
                    ref={backupFileInput}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: "none" }}
                    onChange={e => {
                        const file = e.currentTarget.files?.[0];
                        e.currentTarget.value = "";
                        if (file) void onImportAppearanceBackup(file);
                    }}
                />
                <div style={fileRowStyle}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onExportAppearanceBackup} disabled={busy}>
                        ⬇ Export appearance backup
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => backupFileInput.current?.click()} disabled={busy}>
                        ⬆ Import appearance backup
                    </Button>
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
                <div style={fileRowStyle}>
                    {(["banner", "avatar"] as const).map(kind => (
                        <div
                            key={kind}
                            role="button"
                            tabIndex={0}
                            aria-label={`Drop ${kind} file here`}
                            style={dropZoneStyle(kind)}
                            onDragEnter={event => { event.preventDefault(); setDraggingKind(kind); }}
                            onDragOver={event => { event.preventDefault(); setDraggingKind(kind); }}
                            onDragLeave={() => setDraggingKind(current => current === kind ? null : current)}
                            onDrop={event => onDropLocalFile(kind, event)}
                            onKeyDown={event => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                (kind === "banner" ? bannerFileInput : avatarFileInput).current?.click();
                            }}
                        >
                            {draggingKind === kind ? `Release to import ${kind}` : `Drag a ${kind} file here (or focus and press Enter)`}
                        </div>
                    ))}
                </div>
                {localMedia.banner && (
                    <div style={localMediaStyle}>
                        {localMedia.banner.isVideo
                            ? <video src={localMedia.banner.previewUrl} muted loop autoPlay playsInline style={localPreviewStyle} />
                            : <img src={localMedia.banner.previewUrl} alt="" style={localPreviewStyle} />}
                        <div style={{ flex: 1, minWidth: 170 }}>
                            <div style={{ fontSize: 11.5, color: "#fbefff", fontWeight: 700 }}>Banner file ready</div>
                            <div style={{ fontSize: 10.5, color: "#cbd0e0", opacity: 0.8 }}>{localMedia.banner.name}</div>
                            <div style={{ fontSize: 10, color: localMedia.banner.remembered ? "#9be7ff" : "#ffcf70", marginTop: 2 }}>
                                {localMedia.banner.remembered
                                    ? "Remembered on this PC — still local until you publish or send it."
                                    : "Session-only — local storage did not accept this file."}
                            </div>
                            <div style={fileRowStyle}>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.GREEN} onClick={onPublishLocalBanner} disabled={busy}>
                                    Publish as shared banner
                                </Button>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onBroadcastLocal("banner", false)} disabled={busy}>
                                    Send banner once (image/GIF)
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
                            <div style={{ fontSize: 10, color: localMedia.avatar.remembered ? "#9be7ff" : "#ffcf70", marginTop: 2 }}>
                                {localMedia.avatar.remembered
                                    ? "Remembered on this PC — still local until you publish or send it."
                                    : "Session-only — local storage did not accept this file."}
                            </div>
                            <div style={fileRowStyle}>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.GREEN} onClick={onPublishLocalAvatar} disabled={busy || localMedia.avatar.isVideo}>
                                    Publish as shared avatar
                                </Button>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onBroadcastLocal("avatar", false)} disabled={busy}>
                                    Send avatar once
                                </Button>
                            </div>
                            {localMedia.avatar.isVideo && <div style={{ fontSize: 10, color: "#ffcf70", marginTop: 4 }}>Video avatars can be sent once to native Discord, but shared Discordmaxxer avatars use GIF/image rendering.</div>}
                        </div>
                    </div>
                )}
            </div>

            <div style={shareWrapStyle}>
                <div style={broadcastTitleStyle}>🔗 Share your profile look</div>
                <div style={broadcastNoteStyle}>
                    Create a portable code for the whole cosmetic look, or copy just one field.
                    Banner, avatar, gradient, and name-style-only codes touch only that component.
                    Codes contain cosmetic settings only — never your claim code, Discord account id,
                    tier, or worker credentials. Imported profile flair is local until you click Save to Discordmaxxer;
                    name-style settings stay in the local plugin. Neither import changes your real Discord profile.
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
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onCreateProfileLookShare("gradient")} disabled={busy}>
                        Copy gradient only
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => void onCreateProfileLookShare("nameStyle")} disabled={busy}>
                        Copy name style only
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
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => onImportProfileLookShare("gradient")} disabled={busy || !shareImport.trim()}>
                        Import gradient only
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => onImportProfileLookShare("nameStyle")} disabled={busy || !shareImport.trim()}>
                        Import name style only
                    </Button>
                </div>
                {shareMessage && <div style={{ ...noteStyle, marginTop: 8, marginBottom: 0 }}>{shareMessage}</div>}
            </div>

            <div style={broadcastWrapStyle}>
                <div style={broadcastTitleStyle}>📡 Optional: update your real Discord profile</div>
                <div style={broadcastNoteStyle}>
                    Save updates the local overlay settings and, when authenticated, the shared
                    roster for compatible Discordmaxxer clients. It does not save those values to
                    your Discord account. These buttons make separate, one-time changes to fields
                    in your <b>Discord profile</b>; Discord clients can render those account fields,
                    but roster media and local effects are not copied into the account and are never re-asserted.
                    <br /><br />
                    <b>Theme gradient:</b> Nitro-gated when Discord renders it. <b>Static avatar:</b>
                    normally works on free. <b>Animated avatar + any banner:</b> Discord requires Nitro.
                    A still-frame button only converts a GIF/video into a PNG; it does not bypass that requirement.
                    To share a downloaded banner or avatar across PCs, use its green <b>Publish as shared...</b>
                    button above; that is the cross-PC Discordmaxxer path.
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
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={openNativeProfileSettings} disabled={busy}>
                        Open Discord profile editor
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
            "For a downloaded GIF/image/video, use Choose banner file then Publish as shared banner to upload it to the shared roster, " +
            "or use the one-time Discord buttons. Recommended: 600×240; images ≤5MB and videos ≤15MB. " +
            "This is a local draft until Save; profile rendering follows the shared roster on every PC. TournamentMode pauses custom banner rendering.",
        default: "",
        onChange: () => {
            sessionLocalMediaPreview.add("banner");
            repaintProfileFlairNow();
        }
    },
    myAvatarAnimatedUrl: {
        type: OptionType.STRING,
        description:
            "[Channel F · MAXXER+] Paste a DIRECT HTTPS media URL, not a webpage. " +
            "The roster stores the URL (maximum 250 characters), so a downloaded file must be hosted first for cross-PC sharing. " +
            "Use Choose avatar file in the editor for a local preview, shared GIF/image publish, or one-time real-Discord broadcast. " +
            "Recommended size: 160×160 square. Animated avatar rendering is suppressed while TournamentMode is active. " +
            "This is a local draft until Save; profile rendering follows the shared roster on every PC. Member-list/chat/voice replacement also requires you to have a custom Discord avatar rather than Discord's default wordmark.",
        default: "",
        onChange: () => {
            sessionLocalMediaPreview.add("avatar");
            repaintProfileFlairNow();
        }
    },
    myThemeColorPrimary: {
        type: OptionType.STRING,
        description:
            "[Channel G · FREE] Primary theme color — TOP of the profile gradient. " +
            "Accepts #RRGGBB, RRGGBB (no #), or 0xRRGGBB — auto-normalized. " +
            "Empty by default (no gradient) — pick a preset in the welcome screen or set your own here. " +
            "Free for every Discordmaxxer user. Without a claim code it stays on this install; with a claim it syncs through the shared roster. Clear to remove your gradient.",
        default: "",
        onChange: () => {
            const current = sessionThemePreview && sessionThemePreview !== null ? sessionThemePreview : {};
            const raw = settings.store.myThemeColorPrimary.trim();
            sessionThemePreview = { ...current, themeColorPrimary: normalizeColor(raw) ?? raw };
            repaintProfileFlairNow();
        }
    },
    myThemeColorSecondary: {
        type: OptionType.STRING,
        description:
            "[Channel G · FREE] Secondary theme color — BOTTOM of the profile gradient. " +
            "Accepts #RRGGBB, RRGGBB (no #), or 0xRRGGBB — auto-normalized. " +
            "Empty by default (no gradient) — paired with the primary above once both are set. Free for every Discordmaxxer user; a claim is only needed for cross-PC/shared sync.",
        default: "",
        onChange: () => {
            const current = sessionThemePreview && sessionThemePreview !== null ? sessionThemePreview : {};
            const raw = settings.store.myThemeColorSecondary.trim();
            sessionThemePreview = { ...current, themeColorSecondary: normalizeColor(raw) ?? raw };
            repaintProfileFlairNow();
        }
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
    },
    scanOnlyVisibleProfiles: {
        type: OptionType.BOOLEAN,
        description:
            "Performance guard (recommended): inspect only profile banners and avatar surfaces that are visible in the current viewport. " +
            "Turn off only when testing a hidden or off-screen Discord surface.",
        default: true
    },
    respectReducedMotion: {
        type: OptionType.BOOLEAN,
        description:
            "Compatibility setting retained for existing installs. DMProfileFlair intentionally keeps custom banner/avatar animation visible despite Windows or Discord reduced-motion settings; TournamentMode is the only performance pause.",
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
let lastAvatarSweepAt = 0;
const AVATAR_SWEEP_INTERVAL_MS = 750;
let scanTimer: number | null = null;
let scanFrame: number | null = null;
const SCAN_DEBOUNCE_MS = 120;
const onVisibilityChange = () => {
    if (!document.hidden) {
        // A hidden window does not need DOM reconciliation. Force the next
        // visible pass to include avatars that may have changed while Discord
        // was backgrounded.
        lastAvatarSweepAt = 0;
        scheduleScan();
    }
};


/** True if a URL is marked as video media or ends in a typical video extension. Used to decide whether to
 *  render as background-image (image) or as a <video> overlay (video). Pure
 *  string heuristic — Content-Type would be more reliable but needs a HEAD
 *  request before render which we'd rather avoid for popout-open latency. */
function isVideoUrl(url: string): boolean {
    return /^data:video\//i.test(url) ||
        localRenderMedia.banner?.url === url && !!localRenderMedia.banner.isVideo ||
        localRenderMedia.avatar?.url === url && !!localRenderMedia.avatar.isVideo ||
        /(?:[?&]dmx-media=video(?:&|#|$)|\.(mp4|webm|mov)(\?|#|$))/i.test(url);
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
    return /^data:image\/(?:gif|apng)/i.test(url) ||
        isVideoUrl(url) ||
        /(?:[?&]dmx-media=video(?:&|#|$)|\.(mp4|webm|mov|gif|apng)(\?|#|$))/i.test(url);
}

function buildCss(): string {
    return `
        /* Hide Discord's stock banner <img> when we've painted ours over the
           container. The data-attr is set inline by tagPopout. */
        [data-dm-flair-banner-applied] > img:first-child {
            visibility: hidden !important;
        }
        /* Suppress the stock avatar only while a profile-view flair image is
           loading. The fast profile observer swaps the URL before first paint;
           this guard prevents a static-frame flash if the asset needs a beat. */
        [data-dm-flair-avatar-pending="1"] {
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

function isElementVisibleOnScreen(element: Element, includeAriaHidden = false): boolean {
    if (document.hidden) return false;
    const node = element as HTMLElement;
    // Discord marks the <img> inside an accessible avatar wrapper as
    // aria-hidden="true" because the wrapper owns the accessible label. The
    // image is still the visible paint target, so avatar-specific callers opt
    // in after they have verified the URL is a Discord avatar CDN URL.
    if (!includeAriaHidden && node.getAttribute("aria-hidden") === "true") return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
        return false;
    }
    try {
        const computed = window.getComputedStyle(node);
        return computed.display !== "none" && computed.visibility !== "hidden" && computed.opacity !== "0";
    } catch {
        return true;
    }
}

function shouldInspectVisibleElement(element: Element, includeAriaHidden = false): boolean {
    return !settings.store.scanOnlyVisibleProfiles || isElementVisibleOnScreen(element, includeAriaHidden);
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
        if (r.width >= 200 && r.height >= 50 && shouldInspectVisibleElement(el)) {
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
        if (src.includes(needle) && shouldInspectVisibleElement(el, true)) out.push(el);
    });
    return out;
}

// Profile surfaces have changed class names over time. Keep the fast path
// narrower than PROFILE_SURFACE_ROOT_SELECTOR: a generic dialog may be a
// settings modal, while these semantic roots are Discord user profiles.
const PROFILE_FAST_SCAN_ROOT_SELECTOR = [
    '[class*="user-profile-popout"]',
    '[class*="userProfileModal"]',
    '[class*="user-profile-modal"]',
    '[class*="userPopout"]',
    '[class*="user-popout"]',
    '[class*="profileModal"]',
    '[class*="profile-modal"]'
].join(", ");
const PROFILE_BANNER_SELECTOR = '[class*="banner__"], [class*="profileBanner"], [class*="userProfileBanner"]';

function profileFastRootFor(element: Element): HTMLElement | null {
    const semanticRoot = element.closest<HTMLElement>(PROFILE_FAST_SCAN_ROOT_SELECTOR);
    if (semanticRoot) return semanticRoot;

    // Some Discord builds only expose the profile as a dialog. Require a
    // profile banner marker so unrelated dialogs are never treated as users.
    const dialog = element.closest<HTMLElement>('[role="dialog"]');
    return dialog?.querySelector(PROFILE_BANNER_SELECTOR) ? dialog : null;
}

/** Profile-view-only avatars (popout 80px, full profile 120px). */
function findProfileViewAvatars(root: ParentNode = document): HTMLImageElement[] {
    const out: HTMLImageElement[] = [];
    root.querySelectorAll('img[class*="avatar__"]').forEach(c => {
        const el = c as HTMLImageElement;
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 60 && profileFastRootFor(el) && shouldInspectVisibleElement(el, true)) out.push(el);
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

// Discord has used all of these class families for the profile popout and
// full-profile modal. Keep one selector for identity/cleanup so a painted
// avatar is not immediately restored just because this build chose a modal
// class instead of the older popout class.
const PROFILE_SURFACE_ROOT_SELECTOR = [
    '[class*="user-profile-popout"]',
    '[class*="userProfileModal"]',
    '[class*="user-profile-modal"]',
    '[class*="userPopout"]',
    '[class*="user-popout"]',
    '[class*="profileModal"]',
    '[class*="profile-modal"]',
    '[role="dialog"]'
].join(", ");

function profileRootsFromMutations(records: MutationRecord[]): HTMLElement[] {
    const roots = new Set<HTMLElement>();
    const consider = (element: Element) => {
        const root = profileFastRootFor(element);
        if (root) roots.add(root);
        element.querySelectorAll(PROFILE_FAST_SCAN_ROOT_SELECTOR).forEach(candidate => roots.add(candidate as HTMLElement));
        const dialog = element.matches('[role="dialog"]')
            ? element as HTMLElement
            : element.closest<HTMLElement>('[role="dialog"]');
        if (dialog?.querySelector(PROFILE_BANNER_SELECTOR)) roots.add(dialog);
        element.querySelectorAll<HTMLElement>('[role="dialog"]').forEach(candidate => {
            if (candidate.querySelector(PROFILE_BANNER_SELECTOR)) roots.add(candidate);
        });
    };

    for (const record of records) {
        for (const node of record.addedNodes) {
            if (node instanceof Element) consider(node);
            else if (node.parentElement) consider(node.parentElement);
        }
        if (record.target instanceof Element) consider(record.target);
    }

    return [...roots].filter(root =>
        !containsMessageArea(root) && (root.querySelector(PROFILE_BANNER_SELECTOR) || root.querySelector('img[class*="avatar__"]'))
    );
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
    const popoutRoot = banner.closest<HTMLElement>(PROFILE_SURFACE_ROOT_SELECTOR);

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
function findUserIdFromContainerUncached(container: Element): string | null {
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

const profileIdentityCache = new WeakMap<Element, { signature: string; userId: string | null }>();

function profileIdentitySignature(container: Element): string {
    const attrs = ["data-user-id", "data-userid", "data-profile-user-id", "data-profile-userid", "id"]
        .map(key => container.getAttribute(key) ?? "")
        .join("|");
    const avatar = container.querySelector("img") as HTMLImageElement | null;
    return `${attrs}|${avatar?.currentSrc || avatar?.src || ""}|${container.childElementCount}`;
}

/** Identity lookup is one of the more expensive parts of a scan because the
 * React fallback walks a bounded subtree. Cache it per DOM node and invalidate
 * naturally when Discord recycles the node for another profile. */
function getUserIdFromContainer(container: Element): string | null {
    const signature = profileIdentitySignature(container);
    const cached = profileIdentityCache.get(container);
    if (cached?.signature === signature) return cached.userId;
    const userId = findUserIdFromContainerUncached(container);
    profileIdentityCache.set(container, { signature, userId });
    return userId;
}

/** Single point that decides what flair (if any) to render for a given user.
 *  Shared media is preferred for other users, while the current user's local
 *  draft/file is allowed to paint immediately. The current user's theme can
 *  use the local free-gradient selection for instant feedback; other users'
 *  themes still come from the shared roster only. Falls through viewer
 *  toggles, hide list, and TournamentMode gates. */
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

    const flair = userId ? getProfileFlairForRender(userId, kind) ?? null : null;
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
function clearBanner(banner: HTMLElement, preserveFailedUrl = false) {
    banner.querySelectorAll(".dm-flair-banner-video").forEach(video => video.remove());
    restoreInlineStyles(banner, "dmFlairBannerOriginalCaptured", BANNER_STYLE_PROPS);
    delete banner.dataset.dmFlairBannerUrl;
    if (!preserveFailedUrl) delete banner.dataset.dmFlairFailedUrl;
    banner.removeAttribute("data-dm-flair-banner-applied");
}

function applyBanner(banner: HTMLElement, url: string) {
    const isVideo = isVideoUrl(url);
    if (banner.dataset.dmFlairFailedUrl === url) return;
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
        v.onerror = () => {
            clearBanner(banner, true);
            banner.dataset.dmFlairFailedUrl = url;
            noteProfileFlairFailure(`banner media failed and was restored (${url.slice(0, 80)})`);
        };
        banner.appendChild(v);
        v.play().catch(() => {});
    } else {
        // Inline styles with `important` priority beat every stylesheet rule
        // (theme, Discord's own, anything) — no specificity war.
        banner.style.setProperty("background-image", `url("${url}")`, "important");
        banner.style.setProperty("background-size", "cover", "important");
        banner.style.setProperty("background-position", "center", "important");
        banner.style.setProperty("background-repeat", "no-repeat", "important");
        const probe = new Image();
        probe.onload = () => { probe.onload = null; probe.onerror = null; };
        probe.onerror = () => {
            if (banner.dataset.dmFlairBannerUrl !== url) return;
            clearBanner(banner, true);
            banner.dataset.dmFlairFailedUrl = url;
            noteProfileFlairFailure(`banner image failed and was restored (${url.slice(0, 80)})`);
        };
        probe.src = url;
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

function applyAvatar(avatar: HTMLImageElement, url: string, userId?: string) {
    const isProfileView = !!profileFastRootFor(avatar);
    const markPending = () => {
        if (!isProfileView) return;
        avatar.setAttribute("data-dm-flair-avatar-pending", "1");
        const clearPending = () => {
            if (avatar.dataset.dmFlairAppliedUrl === url) avatar.removeAttribute("data-dm-flair-avatar-pending");
        };
        avatar.addEventListener("load", clearPending, { once: true });
        avatar.addEventListener("error", clearPending, { once: true });
    };
    // Idempotency MUST compare against the URL we last applied (stashed on the
    // element), NOT against `avatar.src`. The browser normalizes/encodes the
    // src it reads back (dm-media:// scheme, percent-encoding, trailing
    // normalization), so `avatar.src !== url` is almost always true even on
    // the very next scan — which re-assigns src → triggers an image reload →
    // emits a mutation → wakes the observer → re-scans → re-assigns... a
    // self-sustaining CPU/network loop for as long as the avatar is on screen.
    //
    // Discord's responsive avatar component also supplies `srcset`. Setting
    // only `src` does not necessarily change `currentSrc`, so Chromium can
    // keep painting Discord's static CDN candidate while our data marker says
    // the animated flair was applied. Remove the responsive candidates while
    // flair owns this node, and re-assert that invariant if Discord recycles
    // the attributes onto the same element.
    if (avatar.dataset.dmFlairAppliedUrl === url) {
        // Compare the literal attribute, not the normalized `.src` property.
        // Discord can rewrite the property form for custom schemes, making a
        // stable image look different on every scan and re-triggering loads.
        if (avatar.hasAttribute("srcset") || avatar.hasAttribute("sizes") || avatar.getAttribute("src") !== url) {
            markPending();
            avatar.removeAttribute("srcset");
            avatar.removeAttribute("sizes");
            avatar.src = url;
            if (isProfileView && avatar.complete && avatar.naturalWidth > 0) avatar.removeAttribute("data-dm-flair-avatar-pending");
        }
        return;
    }
    // Already proven dead this session — don't reapply a URL that 404s / serves
    // a host's "removed" stub (e.g. a deleted imgur link returns a 503-byte
    // image/png egg). Reapplying would just flash the broken icon every scan.
    if (avatar.dataset.dmFlairFailedUrl === url) return;
    // Stash the original src so we can restore on plugin stop / setting change.
    if (!avatar.dataset.dmFlairOriginalSrc) {
        avatar.dataset.dmFlairOriginalSrc = avatar.src;
    }
    if (!avatar.dataset.dmFlairOriginalAttrsCaptured) {
        avatar.dataset.dmFlairOriginalAttrsCaptured = "1";
        avatar.dataset.dmFlairOriginalSrcPresent = avatar.hasAttribute("src") ? "1" : "0";
        avatar.dataset.dmFlairOriginalSrcsetPresent = avatar.hasAttribute("srcset") ? "1" : "0";
        avatar.dataset.dmFlairOriginalSizesPresent = avatar.hasAttribute("sizes") ? "1" : "0";
        avatar.dataset.dmFlairOriginalSrcset = avatar.getAttribute("srcset") ?? "";
        avatar.dataset.dmFlairOriginalSizes = avatar.getAttribute("sizes") ?? "";
    }
    // If the flair URL fails to load, restore the real Discord avatar instead
    // of leaving a broken-image icon. Marks the URL failed so the page-wide
    // scan won't re-apply it on the next mutation/interval pass.
    avatar.onerror = () => {
        avatar.onerror = null;
        restoreAvatar(avatar);
        avatar.dataset.dmFlairFailedUrl = url;
        noteProfileFlairFailure(`avatar media failed and was restored (${url.slice(0, 80)})`);
    };
    markPending();
    avatar.removeAttribute("srcset");
    avatar.removeAttribute("sizes");
    avatar.src = url;
    if (userId) avatar.dataset.dmFlairAvatarUserId = userId;
    avatar.dataset.dmFlairAppliedUrl = url;
    avatar.setAttribute("data-dm-flair-avatar-applied", "1");
    if (isProfileView && avatar.complete && avatar.naturalWidth > 0) avatar.removeAttribute("data-dm-flair-avatar-pending");
}

/** Background-image variant for call surfaces / Stage tiles that render the
 *  avatar as a <div style="background-image: ..."> instead of <img>. Stash
 *  the original inline backgroundImage so stop() can restore it. */
function applyBackgroundAvatar(el: HTMLElement, url: string, userId?: string) {
    const newBg = `url("${url}")`;
    if (el.dataset.dmFlairAppliedBgUrl === url) return;
    if (el.dataset.dmFlairFailedBgUrl === url) return;
    if (!el.dataset.dmFlairBgOriginalCaptured) {
        el.dataset.dmFlairBgOriginalCaptured = "1";
        el.dataset.dmFlairOriginalBg = el.style.backgroundImage || "";
        el.dataset.dmFlairOriginalBgPriority = el.style.getPropertyPriority("background-image");
    }
    el.style.setProperty("background-image", newBg, "important");
    if (userId) el.dataset.dmFlairAvatarUserId = userId;
    el.dataset.dmFlairAppliedBgUrl = url;
    el.setAttribute("data-dm-flair-bg-avatar-applied", "1");
    const probe = new Image();
    probe.onload = () => { probe.onload = null; probe.onerror = null; };
    probe.onerror = () => {
        if (el.dataset.dmFlairAppliedBgUrl !== url) return;
        restoreBackgroundAvatar(el);
        el.dataset.dmFlairFailedBgUrl = url;
        noteProfileFlairFailure(`avatar background failed and was restored (${url.slice(0, 80)})`);
    };
    probe.src = url;
}

function restoreAvatar(avatar: HTMLImageElement) {
    avatar.onerror = null;
    if (avatar.dataset.dmFlairOriginalAttrsCaptured) {
        if (avatar.dataset.dmFlairOriginalSrcsetPresent === "1") avatar.setAttribute("srcset", avatar.dataset.dmFlairOriginalSrcset ?? "");
        else avatar.removeAttribute("srcset");
        if (avatar.dataset.dmFlairOriginalSizesPresent === "1") avatar.setAttribute("sizes", avatar.dataset.dmFlairOriginalSizes ?? "");
        else avatar.removeAttribute("sizes");
        if (avatar.dataset.dmFlairOriginalSrcPresent === "1") avatar.setAttribute("src", avatar.dataset.dmFlairOriginalSrc ?? "");
        else avatar.removeAttribute("src");
    } else {
        const original = avatar.dataset.dmFlairOriginalSrc;
        if (original && avatar.src !== original) avatar.src = original;
    }
    delete avatar.dataset.dmFlairOriginalSrc;
    delete avatar.dataset.dmFlairOriginalAttrsCaptured;
    delete avatar.dataset.dmFlairOriginalSrcPresent;
    delete avatar.dataset.dmFlairOriginalSrcsetPresent;
    delete avatar.dataset.dmFlairOriginalSizesPresent;
    delete avatar.dataset.dmFlairOriginalSrcset;
    delete avatar.dataset.dmFlairOriginalSizes;
    delete avatar.dataset.dmFlairAvatarUserId;
    delete avatar.dataset.dmFlairAppliedUrl;
    delete avatar.dataset.dmFlairFailedUrl;
    avatar.removeAttribute("data-dm-flair-avatar-pending");
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
    delete el.dataset.dmFlairAvatarUserId;
    delete el.dataset.dmFlairAppliedBgUrl;
    delete el.dataset.dmFlairFailedBgUrl;
    el.removeAttribute("data-dm-flair-bg-avatar-applied");
}

function userIdForAppliedAvatar(element: Element): string | null {
    const appliedUserId = validSnowflake(element instanceof HTMLElement ? element.dataset.dmFlairAvatarUserId : null);
    if (appliedUserId) return appliedUserId;

    const original = element instanceof HTMLImageElement
        ? element.dataset.dmFlairOriginalSrc ?? ""
        : element instanceof HTMLElement
            ? element.dataset.dmFlairOriginalBg ?? ""
            : "";
    const fromCdn = original.match(/\/avatars\/(\d{17,20})\//);
    if (fromCdn) return fromCdn[1];

    const profileRoot = element.closest<HTMLElement>(PROFILE_SURFACE_ROOT_SELECTOR);
    return profileRoot ? getUserIdFromContainer(profileRoot) : null;
}

/** Reconcile already-painted avatars on every scan. Discord recycles image
 *  nodes and roster entries can expire or lose a field; without this pass a
 *  stale flair stayed visible until the plugin was restarted. */
function cleanupAppliedAvatars(mediaSuppressed: boolean) {
    document.querySelectorAll<HTMLImageElement>("[data-dm-flair-avatar-applied]").forEach(avatar => {
        const userId = userIdForAppliedAvatar(avatar);
        const expected = !mediaSuppressed && userId
            ? resolveFlairForUserId(userId, "avatar")?.avatarAnimatedUrl
            : undefined;
        if (!expected || expected !== avatar.dataset.dmFlairAppliedUrl) restoreAvatar(avatar);
    });

    document.querySelectorAll<HTMLElement>("[data-dm-flair-bg-avatar-applied]").forEach(element => {
        const userId = userIdForAppliedAvatar(element);
        const expected = !mediaSuppressed && userId
            ? resolveFlairForUserId(userId, "avatar")?.avatarAnimatedUrl
            : undefined;
        if (!expected || expected !== element.dataset.dmFlairAppliedBgUrl) restoreBackgroundAvatar(element);
    });
}

function scanProfileSurfaceFast(root: HTMLElement): void {
    if (!root.isConnected || document.hidden || containsMessageArea(root)) return;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return;
    try {
        const computed = window.getComputedStyle(root);
        if (computed.display === "none" || computed.visibility === "hidden") return;
    } catch { /* Continue with DOM identity checks if computed styles are unavailable. */ }

    const mediaSuppressed = shouldSuppressAnimatedFlair();
    let ownerId = getUserIdFromContainer(root);
    const banners: HTMLElement[] = [];
    if (root.matches(PROFILE_BANNER_SELECTOR)) banners.push(root);
    root.querySelectorAll<HTMLElement>(PROFILE_BANNER_SELECTOR).forEach(banner => banners.push(banner));

    for (const banner of banners) {
        const rect = banner.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 50 || !shouldInspectVisibleElement(banner)) continue;
        const container = findProfileContainerFromBanner(banner);
        if (!container) continue;
        const userId = ownerId ?? getUserIdFromContainer(container);
        if (!userId) continue;
        ownerId = userId;

        const bannerFlair = resolveFlairForUserId(userId, "banner");
        const suppressBanner = mediaSuppressed && !!bannerFlair?.bannerUrl && isAnimatedUrl(bannerFlair.bannerUrl);
        if (bannerFlair?.bannerUrl && !suppressBanner) {
            applyBanner(banner, bannerFlair.bannerUrl);
        } else clearBanner(banner);

        const themeFlair = resolveFlairForUserId(userId, "theme");
        if (themeFlair?.themeColorPrimary || themeFlair?.themeColorSecondary) {
            applyTheme(container, themeFlair.themeColorPrimary, themeFlair.themeColorSecondary);
        } else clearTheme(container);
    }

    if (!ownerId) return;
    const avatarFlair = resolveFlairForUserId(ownerId, "avatar");
    if (!avatarFlair?.avatarAnimatedUrl || shouldSuppressAnimatedFlair()) return;
    for (const avatar of findProfileViewAvatars(root)) {
        const src = avatar.currentSrc || avatar.src || "";
        const srcUserId = src.match(/\/avatars\/(\d{17,20})\//)?.[1];
        const userId = srcUserId ?? ownerId;
        if (userId !== ownerId) continue;
        const flair = userId === ownerId ? avatarFlair : resolveFlairForUserId(userId, "avatar");
        if (flair?.avatarAnimatedUrl) applyAvatar(avatar, flair.avatarAnimatedUrl, userId);
    }
}

function scanForPopouts(_root: ParentNode = document) {
    const me = UserStore.getCurrentUser?.();
    const mediaSuppressed = shouldSuppressAnimatedFlair();
    profileRenderHealth.scanCount++;
    profileRenderHealth.lastScanAt = Date.now();
    const flairCache = new Map<string, Partial<Record<"banner" | "avatar" | "theme", ProfileFlair | null>>>();
    const resolveForScan = (userId: string, kind: "banner" | "avatar" | "theme"): ProfileFlair | null => {
        const cached = flairCache.get(userId) ?? {};
        if (Object.prototype.hasOwnProperty.call(cached, kind)) return cached[kind] ?? null;
        const value = resolveFlairForUserId(userId, kind);
        cached[kind] = value;
        flairCache.set(userId, cached);
        return value;
    };

    cleanupAppliedAvatars(mediaSuppressed);

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

        const bannerFlair = resolveForScan(userId, "banner");
        const suppressForMedia = mediaSuppressed && !!bannerFlair?.bannerUrl && isAnimatedUrl(bannerFlair.bannerUrl);
        if (bannerFlair?.bannerUrl && !suppressForMedia) applyBanner(banner, bannerFlair.bannerUrl);
        else clearBanner(banner);

        const themeFlair = resolveForScan(userId, "theme");
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
    // Include the self-only local draft/file so the page-wide avatar sweep is
    // not gated off before it gets a chance to apply the current user's local
    // selection.
    const selfHasAvatarFlair = !!(me?.id && getProfileFlairForRender(me.id, "avatar")?.avatarAnimatedUrl);
    const othersAvatarFlair =
        sa.showOthersFlair && sa.showOthersAvatar && rosterHasAnyAvatarFlair();
    const anyAvatarFlair = selfHasAvatarFlair || othersAvatarFlair;

    const shouldSweepAvatars = Date.now() - lastAvatarSweepAt >= AVATAR_SWEEP_INTERVAL_MS;
    let visibleAvatarCandidates = 0;
    if (!mediaSuppressed && anyAvatarFlair && shouldSweepAvatars) {
        lastAvatarSweepAt = Date.now();
        document.querySelectorAll("img").forEach(img => {
            const el = img as HTMLImageElement;
            if (!shouldInspectVisibleElement(el, true)) return;
            const src = el.currentSrc || el.src || "";
            const m = src.match(/\/avatars\/(\d{17,20})\//);
            if (!m) return;
            visibleAvatarCandidates++;
            const userId = m[1];
            const avatarFlair = resolveForScan(userId, "avatar");
            if (avatarFlair?.avatarAnimatedUrl) {
                applyAvatar(el, avatarFlair.avatarAnimatedUrl, userId);
            }
        });
        // Background-image avatar tiles — some call surfaces (notably the
        // "no video, big circle avatar" user tile in the main call view, and
        // certain Stage/voice-party variants) render the avatar as a
        // <div style="background-image: url(...avatars/<userId>/...)"> rather
        // than as an <img>. Scan every element with an inline backgroundImage
        // that matches the avatar CDN pattern and override the URL.
        document.querySelectorAll<HTMLElement>('[style*="/avatars/"]').forEach(el => {
            if (!shouldInspectVisibleElement(el, true)) return;
            const bg = el.style.backgroundImage;
            if (!bg) return;
            const m = bg.match(/\/avatars\/(\d{17,20})\//);
            if (!m) return;
            visibleAvatarCandidates++;
            const userId = m[1];
            const avatarFlair = resolveForScan(userId, "avatar");
            if (!avatarFlair?.avatarAnimatedUrl) return;
            applyBackgroundAvatar(el, avatarFlair.avatarAnimatedUrl, userId);
        });
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

    // Keep profile-view fallback avatars outside the throttled page-wide sweep.
    // A newly opened popout should not wait up to 750ms, and default Discord
    // avatars have no CDN user id in their src to catch in the sweep above.
    if (!mediaSuppressed) {
        for (const avatar of findProfileViewAvatars()) {
            if (avatar.dataset.dmFlairAvatarApplied) continue;
            const root = profileFastRootFor(avatar);
            const userId = root ? getUserIdFromContainer(root) : null;
            const flair = userId ? resolveForScan(userId, "avatar") : null;
            if (flair?.avatarAnimatedUrl && userId) applyAvatar(avatar, flair.avatarAnimatedUrl, userId);
        }
    }
    profileRenderHealth.visibleBanners = banners.length;
    profileRenderHealth.visibleAvatars = visibleAvatarCandidates;
    profileRenderHealth.appliedBanners = document.querySelectorAll("[data-dm-flair-banner-applied]").length;
    profileRenderHealth.appliedThemes = document.querySelectorAll("[data-dm-flair-theme-applied]").length;
    profileRenderHealth.appliedAvatars = document.querySelectorAll("[data-dm-flair-avatar-applied], [data-dm-flair-bg-avatar-applied]").length;
}

// Coalesce mutation bursts into one trailing scan every 120ms, then hand the
// actual paint to the next animation frame. Discord emits hundreds of
// childList mutations per second while chat scrolls or a call is live; a
// per-frame full-document sweep is still expensive even when mutations are
// batched. The bounded debounce keeps profile changes fast while putting a
// hard ceiling on this plugin's steady-state scan rate.
function scheduleScan() {
    if (document.hidden || scanTimer !== null || scanFrame !== null) return;
    scanTimer = window.setTimeout(() => {
        scanTimer = null;
        if (document.hidden) return;
        scanFrame = window.requestAnimationFrame(() => {
            scanFrame = null;
            if (!document.hidden) scanForPopouts(document);
        });
    }, SCAN_DEBOUNCE_MS);
}

function startObserver() {
    if (observer) return;
    lastAvatarSweepAt = 0;
    document.addEventListener("visibilitychange", onVisibilityChange);
    observer = new MutationObserver(records => {
        // Discord may paint the stock avatar before the regular debounced page
        // scan runs. Only inspect newly affected profile roots synchronously;
        // the expensive page-wide pass remains coalesced below.
        for (const root of profileRootsFromMutations(records)) scanProfileSurfaceFast(root);
        scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanForPopouts(document);
    // Low-frequency safety net for changes the childList observer can't see
    // (e.g. an <img src> swapped in place). 2s is plenty for animated-avatar
    // surfaces and halves the steady-state polling cost vs the old 1s.
    rescanTimer = window.setInterval(() => {
        if (!document.hidden) scanForPopouts(document);
    }, 2000);
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
    lastAvatarSweepAt = 0;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (scanTimer !== null) { clearTimeout(scanTimer); scanTimer = null; }
    if (scanFrame !== null) { window.cancelAnimationFrame(scanFrame); scanFrame = null; }
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
        "Gradients are free; shared media is tier-gated server-side. Animated content auto-suppresses when TournamentMode is on.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-profile-flair", managedStyleRootNode);
        style.textContent = buildCss();
        // DMWelcome uses this bridge so a tour swatch performs the same
        // authenticated publish as the full Profile Flair editor.
        (globalThis as any).__dmApplyProfileGradient = applySharedGradient;
        removeRosterListener = onRosterChange(scheduleScan);
        startObserver();
        // Restore remembered local files independently of the editor so a
        // restart/update does not leave the profile surface blank until the
        // user happens to open Appearance Center.
        void restoreLocalMediaForRenderer();
        // Resolve the roster immediately so an already-open profile does not
        // depend on the next profile open or the two-second DOM poll. The
        // listener above repaints when this asynchronous fetch completes.
        refreshRoster().catch(e => console.warn("[DMProfileFlair] roster refresh failed:", e));
    },

    stop() {
        removeRosterListener?.();
        removeRosterListener = null;
        stopObserver();
        clearLocalRenderMedia();
        style?.remove();
        style = null;
        delete (globalThis as any).__dmApplyProfileGradient;
        // Reset the warn-once latch so toggling the plugin off+on re-surfaces
        // the default-avatar warning if it still applies.
        defaultAvatarWarned = false;
    }
});

/*
 * Discordmaxxer — DMProfileFlair plugin (Channels E, F, G)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * User-set custom profile flair, visible only to other Discordmaxxer clients
 * (same architecture as DiscordmaxxerBadge Channel A — fetched from the public
 * tier roster, rendered client-side, vanilla Discord never sees it). The
 * settings panel also exposes an explicit vanilla share bridge: it copies a
 * normal Discord message card or a PNG still frame, because stock Discord
 * cannot render roster-only fields in a profile.
 *
 *   E) Custom banner — image or short MP4 URL, replaces Discord's banner
 *      in profile popouts. Free for every roster-claimed user.
 *   F) Animated avatar — GIF/image URL, replaces the avatar in popouts (P2);
 *      video avatars stay a native-Discord-only action
 *      and member list + chat (P5). Free for every roster-claimed user.
 *      Suppressed when
 *      TournamentMode is active (animated content tanks FPS).
 *   G) Theme colors — primary + secondary hex, patched into Discord's
 *      --profile-gradient-*-color CSS vars on the popout root. Free for every
 *      roster-claimed user.
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
 *   - Worker authenticates the user-bound claim and validates each field, so
 *     client-side settings cannot bypass roster ownership or media limits.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Button, React, RestAPI, Toasts, UserStore } from "@webpack/common";

import { makePersistentValue } from "../_dm-shared/persist";
import { getRosterProfileFlair, getRosterProfileUpdatedAt, isRosterReady, onRosterChange, ProfileFlair, refreshRoster, rosterHasAnyAvatarFlair } from "../_dm-shared/roster";
import { getMyTier, Tier } from "../_dm-shared/vip";
import { normalizeCode, readBinding } from "../_dm-shared/vipClaim";

const WORKER_PROFILE_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile";
const WORKER_PROFILE_MEDIA_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile-media";
const WORKER_PROFILE_MEDIA_ORIGIN = "https://optmaxxing-vip.maxxtopia.workers.dev";
const VANILLA_SHARE_URL = "https://maxxtopia.com/discordmaxxer";

const PROFILE_FIELD_MIN_TIER: Record<keyof ProfileFlair, Tier> = {
    bannerUrl: Tier.FREE,
    avatarAnimatedUrl: Tier.FREE,
    themeColorPrimary: Tier.FREE,
    themeColorSecondary: Tier.FREE,
    bannerPosition: Tier.MAXXER,
    avatarPosition: Tier.MAXXER,
    bannerFit: Tier.MAXXER_PLUS,
    avatarFit: Tier.MAXXER_PLUS,
    avatarScale: Tier.MAXXER_PLUS,
    mediaEffect: Tier.MAXXER_PLUS_PLUS
};

const URL_RE = /^https:\/\/[^\s]{1,250}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PROFILE_POSITION_VALUES = new Set<NonNullable<ProfileFlair["bannerPosition"]>>(["center", "top", "bottom"]);
const PROFILE_FIT_VALUES = new Set<NonNullable<ProfileFlair["bannerFit"]>>(["cover", "contain"]);
const PROFILE_SCALE_VALUES = new Set<NonNullable<ProfileFlair["avatarScale"]>>(["0.9", "1", "1.1"]);
const PROFILE_EFFECT_VALUES = new Set<NonNullable<ProfileFlair["mediaEffect"]>>(["none", "glow", "scanline"]);

const POSITION_OPTIONS: Array<{ value: NonNullable<ProfileFlair["bannerPosition"]>; label: string }> = [
    { value: "center", label: "Center" },
    { value: "top", label: "Top" },
    { value: "bottom", label: "Bottom" }
];
const FIT_OPTIONS: Array<{ value: NonNullable<ProfileFlair["bannerFit"]>; label: string }> = [
    { value: "cover", label: "Fill / crop" },
    { value: "contain", label: "Show whole image" }
];
const SCALE_OPTIONS: Array<{ value: NonNullable<ProfileFlair["avatarScale"]>; label: string }> = [
    { value: "0.9", label: "90%" },
    { value: "1", label: "100%" },
    { value: "1.1", label: "110%" }
];
const EFFECT_OPTIONS: Array<{ value: NonNullable<ProfileFlair["mediaEffect"]>; label: string }> = [
    { value: "none", label: "Clean" },
    { value: "glow", label: "Soft glow" },
    { value: "scanline", label: "Scanline" }
];

// Only fields actively edited in this session may override the shared owner
// roster for the local self-preview. Persisted settings can be stale after a
// second Discordmaxxer install changes the account, so treating every local
// value as authoritative made cross-PC media and colors appear to revert.
const flairDraftFields = new Set<string>();

function markFlairDraftField(field: string): void {
    flairDraftFields.add(field);
}

function clearFlairDraftFields(): void {
    flairDraftFields.clear();
}

function clearFlairDraftField(field: string): void {
    flairDraftFields.delete(field);
}

function applyLocalDraftField(
    merged: ProfileFlair,
    settingsValue: unknown,
    settingKey: string,
    profileKey: "bannerUrl" | "avatarAnimatedUrl" | "themeColorPrimary" | "themeColorSecondary"
): void {
    if (!flairDraftFields.has(settingKey)) return;
    const value = String(settingsValue ?? "").trim();
    if (value) merged[profileKey] = value;
    else delete merged[profileKey];
}

/** Merge self-preview settings without letting a stale local value bypass the
 * current tier. The worker applies the same rule to the shared roster, but
 * this client-side guard keeps a downgraded account honest before its next
 * roster refresh too. Free users retain the base media and colors; only the
 * optional presentation controls are removed when they are not entitled. */
function mergeLocalPresentationFields(merged: ProfileFlair, s: any): ProfileFlair {
    const tier = getMyTier();
    if (tier >= Tier.MAXXER) {
        if (flairDraftFields.has("myBannerPosition")) {
            const bannerPosition = String(s.myBannerPosition ?? "").trim();
            if (bannerPosition) merged.bannerPosition = bannerPosition as ProfileFlair["bannerPosition"];
            else delete merged.bannerPosition;
        }
        if (flairDraftFields.has("myAvatarPosition")) {
            const avatarPosition = String(s.myAvatarPosition ?? "").trim();
            if (avatarPosition) merged.avatarPosition = avatarPosition as ProfileFlair["avatarPosition"];
            else delete merged.avatarPosition;
        }
    } else {
        delete merged.bannerPosition;
        delete merged.avatarPosition;
    }
    if (tier >= Tier.MAXXER_PLUS) {
        if (flairDraftFields.has("myBannerFit")) {
            const bannerFit = String(s.myBannerFit ?? "").trim();
            if (bannerFit) merged.bannerFit = bannerFit as ProfileFlair["bannerFit"];
            else delete merged.bannerFit;
        }
        if (flairDraftFields.has("myAvatarFit")) {
            const avatarFit = String(s.myAvatarFit ?? "").trim();
            if (avatarFit) merged.avatarFit = avatarFit as ProfileFlair["avatarFit"];
            else delete merged.avatarFit;
        }
        if (flairDraftFields.has("myAvatarScale")) {
            const avatarScale = String(s.myAvatarScale ?? "").trim();
            if (avatarScale) merged.avatarScale = avatarScale as ProfileFlair["avatarScale"];
            else delete merged.avatarScale;
        }
    } else {
        delete merged.bannerFit;
        delete merged.avatarFit;
        delete merged.avatarScale;
    }
    if (tier >= Tier.MAXXER_PLUS_PLUS) {
        if (flairDraftFields.has("myMediaEffect")) {
            const mediaEffect = String(s.myMediaEffect ?? "").trim();
            if (mediaEffect) merged.mediaEffect = mediaEffect as ProfileFlair["mediaEffect"];
            else delete merged.mediaEffect;
        }
    } else {
        delete merged.mediaEffect;
    }
    return merged;
}

function tierLabel(tier: Tier): string {
    return tier === Tier.MAXXER ? "MAXXER" : tier === Tier.MAXXER_PLUS ? "MAXXER+" : "MAXXER++";
}

// The native Discord banner field is deliberately narrower than the
// Discordmaxxer-only banner renderer. Keep the one-click native path
// predictable: animated media goes through the still-frame action instead of
// sending video/GIF bytes to `/users/@me/profile`.
const NATIVE_BANNER_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_NATIVE_BANNER_BYTES = 10 * 1024 * 1024;
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

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        console.warn("[DMProfileFlair] clipboard text write failed:", e);
        return false;
    }
}

function getCurrentDisplayName(): string {
    const me = UserStore.getCurrentUser?.() as any;
    return me?.globalName || me?.username || me?.tag || "A Discordmaxxer user";
}

function buildVanillaShareText(bannerUrl: string, stillFrameUrl: string): string {
    const lines = [
        `✨ ${getCurrentDisplayName()} is using Discordmaxxer`,
        bannerUrl ? `Animated banner preview: ${bannerUrl}` : "",
        stillFrameUrl ? `Vanilla-safe still preview: ${stillFrameUrl}` : "",
        `See how: ${VANILLA_SHARE_URL}`
    ];
    return lines.filter(Boolean).join("\n");
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

    // Self-preview path: when rendering YOUR OWN popout, prefer the local
    // setter-side settings over the roster lookup. Lets you see your flair
    // change as soon as you type a URL — no save, no worker, no claim, no
    // roster cache wait. Renders only the fields you've filled in locally;
    // empty fields fall through to roster (which may have a previously
    // saved version) and then to nothing.
    let flair: ProfileFlair | null = null;
    const me = UserStore.getCurrentUser?.();
    if (me?.id === userId) {
        // Per-field merge: start from your saved roster flair, then let any
        // non-empty LOCAL field override it. This matches the documented
        // intent — an empty local field falls through to your roster value
        // (e.g. a banner you saved earlier but never re-typed locally) instead
        // of being masked to nothing. Filled local fields still preview
        // instantly, no save/worker roundtrip needed.
        const merged: ProfileFlair = { ...(getRosterProfileFlair(userId) ?? {}) };
        applyLocalDraftField(merged, s.myBannerUrl, "myBannerUrl", "bannerUrl");
        applyLocalDraftField(merged, s.myAvatarAnimatedUrl, "myAvatarAnimatedUrl", "avatarAnimatedUrl");
        applyLocalDraftField(merged, s.myThemeColorPrimary, "myThemeColorPrimary", "themeColorPrimary");
        applyLocalDraftField(merged, s.myThemeColorSecondary, "myThemeColorSecondary", "themeColorSecondary");
        mergeLocalPresentationFields(merged, s);
        if (Object.keys(merged).length) flair = merged;
    }
    if (!flair) flair = getRosterProfileFlair(userId) ?? null;
    if (!flair) return null;

    if ((kind === "banner" || kind === "avatar") && isTournamentModeActive()) {
        // Animated content is the whole point of TM suppression — even a
        // banner image is technically a network fetch + decode we don't
        // want during a match. Theme colors are not animated media, so they stay.
        return null;
    }
    return flair;
}

function getProfileClaimCode(): string {
    // Modern Discord can clear localStorage, so the persisted manual code is
    // an intentional fallback for the cross-PC profile-media path.
    const binding = readBinding();
    if (binding?.code) return binding.code;
    const manual = settings.store.manualClaimCode?.trim();
    return manual ? normalizeCode(manual) : "";
}

function isCanonicalProfileMediaUrl(value: string, userId: string, kind: "banner" | "avatar"): boolean {
    try {
        const url = new URL(value);
        return url.origin === WORKER_PROFILE_MEDIA_ORIGIN
            && new RegExp(`^/profile-media/${userId}/${kind}/[0-9a-f-]{36}$`, "i").test(url.pathname);
    } catch {
        return false;
    }
}

function inferProfileMediaMime(sourceUrl: string, fetched: FetchedDataUri): string {
    const reported = fetched.mime.trim().toLowerCase();
    if (reported && reported !== "application/octet-stream") return reported;
    try {
        const pathname = new URL(sourceUrl).pathname.toLowerCase();
        const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1] ?? "";
        const byExtension: Record<string, string> = {
            gif: "image/gif",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            mp4: "video/mp4",
            webm: "video/webm",
            mov: "video/quicktime"
        };
        return byExtension[extension] ?? reported;
    } catch {
        return reported;
    }
}

async function uploadProfileMedia(
    kind: "banner" | "avatar",
    sourceUrl: string,
    userId: string,
    claimCode: string
): Promise<string> {
    const media = await fetchDataUri(sourceUrl);
    if (!media) throw new Error(`Could not download the ${kind} media from its URL`);
    const mime = inferProfileMediaMime(sourceUrl, media);
    if (!mime) throw new Error(`Could not determine the ${kind} media type`);
    const maxBytes = mime.startsWith("video/") ? 15 * 1024 * 1024 : 5 * 1024 * 1024;
    if (media.bytes > maxBytes) {
        throw new Error(`${kind} is ${(media.bytes / (1024 * 1024)).toFixed(1)} MB; the shared limit is ${maxBytes / (1024 * 1024)} MB`);
    }
    const res = await fetch(WORKER_PROFILE_MEDIA_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, claimCode, kind, mime, dataUri: media.dataUri })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `media upload failed (${res.status})`);
    const canonical = String(body?.url ?? "").trim();
    if (!isCanonicalProfileMediaUrl(canonical, userId, kind)) {
        throw new Error("the worker returned an invalid shared media URL");
    }
    return canonical;
}

async function postFlairUpdate(
    profile: Partial<ProfileFlair>,
    replace: boolean,
    announceToast = true,
    ifUpdatedAt?: number
): Promise<boolean> {
    const me = UserStore.getCurrentUser();
    if (!me?.id) {
        if (announceToast) toast("Couldn't read your Discord user ID", Toasts.Type.FAILURE);
        return false;
    }
    const claimCode = getProfileClaimCode();
    if (!claimCode) {
        if (announceToast) {
            toast(
                "Free profile flair is ready, but cross-PC saving needs activation. Open DMHub → Activate free profile, or paste a paid code into 'manualClaimCode'.",
                Toasts.Type.FAILURE, 6000
            );
        }
        return false;
    }
    try {
        const payload: Record<string, unknown> = { userId: me.id, claimCode, profile, replace };
        if (ifUpdatedAt !== undefined && Number.isFinite(ifUpdatedAt)) payload.ifUpdatedAt = ifUpdatedAt;
        const res = await fetch(WORKER_PROFILE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (announceToast) toast(`Save failed: ${body?.error ?? res.status}`, Toasts.Type.FAILURE, 5000);
            else console.warn("[DMProfileFlair] background profile save rejected:", body?.error ?? res.status);
            return false;
        }
        if (announceToast) toast("✅ Profile flair saved — other Discordmaxxer users see it after the next roster refresh");
        // TournamentMode silently suppresses banner + animated avatar (it's
        // the whole point of TM — free up CPU/GPU). The save itself works
        // fine, but the visual won't appear until TM is toggled off, which
        // looks indistinguishable from a broken save. Call it out explicitly.
        if (announceToast && isTournamentModeActive() && (profile.bannerUrl || profile.avatarAnimatedUrl)) {
            toast(
                "⚠ TournamentMode is on — your banner + animated avatar won't render until you toggle TM off. Theme colors still paint.",
                Toasts.Type.MESSAGE, 8000
            );
        }
        return true;
    } catch (e) {
        console.warn("[DMProfileFlair] save failed:", e);
        if (announceToast) toast(`Save failed: ${(e as any)?.message ?? "network"}`, Toasts.Type.FAILURE, 5000);
        return false;
    }
}

async function settleFlairDraftsAfterSave(expected: Partial<ProfileFlair>): Promise<void> {
    await refreshRoster();
    const me = UserStore.getCurrentUser?.();
    const refreshed = me?.id ? getRosterProfileFlair(me.id) : null;
    // Cloudflare may briefly serve the previous roster snapshot while its
    // edge cache expires. Keep the just-saved local draft in that case so the
    // author's own popout does not flash back to stale colors/media. Once the
    // shared roster contains the expected state, persisted local settings can
    // no longer mask another PC.
    if (!refreshed) {
        if (Object.keys(expected).length === 0) clearFlairDraftFields();
        return;
    }
    const matches = (Object.keys(expected) as Array<keyof ProfileFlair>).every(key => {
        const wanted = expected[key];
        const actual = refreshed[key];
        return wanted ? actual === wanted : !actual;
    });
    if (matches) clearFlairDraftFields();
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
        if ((k === "bannerPosition" || k === "avatarPosition") && !PROFILE_POSITION_VALUES.has(v as any)) {
            return `${k} must be center, top, or bottom`;
        }
        if ((k === "bannerFit" || k === "avatarFit") && !PROFILE_FIT_VALUES.has(v as any)) {
            return `${k} must be cover or contain`;
        }
        if (k === "avatarScale" && !PROFILE_SCALE_VALUES.has(v as any)) {
            return `${k} must be 0.9, 1, or 1.1`;
        }
        if (k === "mediaEffect" && !PROFILE_EFFECT_VALUES.has(v as any)) {
            return `${k} must be clean, glow, or scanline`;
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

interface FetchedDataUri {
    dataUri: string;
    mime: string;
    bytes: number;
}

/** Fetch a remote URL's bytes and return a base64 data URI plus response
 * metadata. Routed through the dm-media:// proxy because Chromium ORB blocks
 * cross-origin no-CORS fetches in the renderer for arbitrary HTTPS hosts (same
 * reason banner-video uses it). */
async function fetchDataUri(httpsUrl: string): Promise<FetchedDataUri | null> {
    try {
        const proxied = httpsUrl.startsWith("https://")
            ? `dm-media://proxy/${encodeURIComponent(httpsUrl)}`
            : httpsUrl;
        const res = await fetch(proxied);
        if (!res.ok) {
            console.warn(`[DMProfileFlair] fetchDataUri ${httpsUrl} → ${res.status}`);
            return null;
        }
        const blob = await res.blob();
        const dataUri = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
        return { dataUri, mime: blob.type.trim().toLowerCase(), bytes: blob.size };
    } catch (e) {
        console.warn("[DMProfileFlair] fetchDataUri failed:", e);
        return null;
    }
}

async function urlToDataUri(httpsUrl: string): Promise<string | null> {
    return (await fetchDataUri(httpsUrl))?.dataUri ?? null;
}

function estimateDataUriBytes(dataUri: string): number | null {
    const comma = dataUri.indexOf(",");
    const header = comma >= 0 ? dataUri.slice(0, comma) : "";
    if (comma < 0 || !/;base64$/i.test(header)) return null;
    const encoded = dataUri.slice(comma + 1);
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
}

function nativeBannerMediaError(media: FetchedDataUri): string | null {
    if (!NATIVE_BANNER_IMAGE_MIMES.has(media.mime)) {
        const resolvedAs = media.mime || "an unknown media type";
        return `Native Discord banners need a confirmed static PNG, JPEG, or WebP; this URL resolved as ${resolvedAs}. Use the still-frame action for video or GIF sources.`;
    }
    if (media.bytes > MAX_NATIVE_BANNER_BYTES) {
        return `This banner is ${(media.bytes / (1024 * 1024)).toFixed(1)} MB. Keep the native banner under 10 MB, or use a smaller source.`;
    }
    return null;
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

interface SampledColor {
    r: number;
    g: number;
    b: number;
    count: number;
}

function colorDistance(a: SampledColor, b: SampledColor): number {
    return Math.sqrt(
        Math.pow(a.r - b.r, 2) +
        Math.pow(a.g - b.g, 2) +
        Math.pow(a.b - b.b, 2)
    );
}

function colorToHex(color: SampledColor): string {
    return `#${[color.r, color.g, color.b]
        .map(channel => channel.toString(16).padStart(2, "0"))
        .join("")}`;
}

/**
 * Reduce a rendered banner frame to the two most useful representative
 * colors for Discord's native theme_colors field. This is an approximation:
 * stock Discord can show a gradient, not the original image or animation.
 */
function samplePaletteFromDataUri(dataUri: string): Promise<[string, string] | null> {
    return new Promise(resolve => {
        const image = new Image();
        image.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = 32;
                canvas.height = 16;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) {
                    resolve(null);
                    return;
                }
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                const buckets = new Map<string, SampledColor>();

                for (let i = 0; i < pixels.length; i += 4) {
                    if (pixels[i + 3] < 48) continue;
                    // Quantize to 16 levels per channel so nearby pixels form
                    // stable buckets instead of producing hundreds of noise
                    // colors from compression or animation artifacts.
                    const color: SampledColor = {
                        r: (pixels[i] >> 4) * 17,
                        g: (pixels[i + 1] >> 4) * 17,
                        b: (pixels[i + 2] >> 4) * 17,
                        count: 1
                    };
                    const key = `${color.r},${color.g},${color.b}`;
                    const existing = buckets.get(key);
                    if (existing) existing.count += 1;
                    else buckets.set(key, color);
                }

                const candidates = [...buckets.values()].sort((a, b) => b.count - a.count);
                const primary = candidates[0];
                if (!primary) {
                    resolve(null);
                    return;
                }
                const secondary = candidates.find(color => colorDistance(color, primary) >= 48) ?? primary;
                resolve([colorToHex(primary), colorToHex(secondary)]);
            } catch (error) {
                console.warn("[DMProfileFlair] banner palette sampling failed:", error);
                resolve(null);
            }
        };
        image.onerror = () => resolve(null);
        image.src = dataUri;
    });
}

async function sampleBannerPalette(sourceUrl: string): Promise<[string, string] | null> {
    const stillFrame = await extractStillFrameFromUrl(sourceUrl);
    return stillFrame ? samplePaletteFromDataUri(stillFrame) : null;
}

async function broadcastBannerPalette(sourceUrl: string): Promise<boolean> {
    if (!URL_RE.test(sourceUrl)) {
        toast("Set a valid direct banner or still-frame URL first.", Toasts.Type.FAILURE, 5000);
        return false;
    }
    const pageHint = detectPageHostMistake(sourceUrl);
    if (pageHint) {
        toast(pageHint, Toasts.Type.FAILURE, 8000);
        return false;
    }

    toast("Sampling a representative color pair from your banner…", Toasts.Type.MESSAGE, 3000);
    const palette = await sampleBannerPalette(sourceUrl);
    if (!palette) {
        toast("Couldn't sample the banner. Verify it is a direct image, GIF, or video URL.", Toasts.Type.FAILURE, 6000);
        return false;
    }

    const [primary, secondary] = palette;
    const ok = await broadcastThemeColors(primary, secondary);
    if (ok) {
        toast(
            `Native color test sent: ${primary} → ${secondary}. This is only a color approximation; vanilla visibility still needs a second-account check.`,
            Toasts.Type.MESSAGE,
            8000
        );
    }
    return ok;
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
        const mime = blob.type.trim().toLowerCase();
        try {
            if (mime.startsWith("video/")) return await drawVideoFirstFrame(blobUrl);
            if (mime.startsWith("image/")) return await drawImageFirstFrame(blobUrl);
            console.warn(`[DMProfileFlair] extractStillFrame unsupported MIME: ${mime || "unknown"}`);
            return null;
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    } catch (e) {
        console.warn("[DMProfileFlair] extractStillFrameFromUrl failed:", e);
        return null;
    }
}

/**
 * Copy a rendered still frame to the system clipboard so the user can paste
 * it into an ordinary Discord message. This is the no-Nitro, vanilla-visible
 * path: the pasted attachment is a normal Discord message, not a profile
 * mutation and not a Discordmaxxer-only field.
 */
async function copyVanillaStillFrame(sourceUrl: string): Promise<boolean> {
    if (!URL_RE.test(sourceUrl)) {
        toast("Set a valid direct banner or still-frame URL first.", Toasts.Type.FAILURE, 5000);
        return false;
    }
    const pageHint = detectPageHostMistake(sourceUrl);
    if (pageHint) {
        toast(pageHint, Toasts.Type.FAILURE, 8000);
        return false;
    }

    toast("Extracting a PNG still frame for vanilla Discord…", Toasts.Type.MESSAGE, 3000);
    const dataUri = await extractStillFrameFromUrl(sourceUrl);
    if (!dataUri) {
        toast("Couldn't extract a still frame — use a direct image/video URL.", Toasts.Type.FAILURE, 6000);
        return false;
    }

    try {
        // ClipboardItem is deliberately accessed through globalThis so this
        // stays compatible with older Electron type definitions. Chromium's
        // normal permission prompt, if any, is still respected.
        const clipboard = navigator.clipboard as Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> };
        const ClipboardItemCtor = (globalThis as any).ClipboardItem;
        if (!clipboard?.write || !ClipboardItemCtor) throw new Error("image clipboard API unavailable");
        const blob = await (await fetch(dataUri)).blob();
        await clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
        toast("✅ Still frame copied — paste it into a normal Discord message for vanilla users to see.", Toasts.Type.SUCCESS, 6000);
        return true;
    } catch (e) {
        console.warn("[DMProfileFlair] clipboard image write failed:", e);
        const fallback = await copyText(buildVanillaShareText("", sourceUrl));
        toast(
            fallback
                ? "Image clipboard is unavailable here, so the still-frame link was copied instead."
                : "Clipboard access was blocked. Save the still frame through the browser or copy the URL manually.",
            fallback ? Toasts.Type.MESSAGE : Toasts.Type.FAILURE,
            7000
        );
        return fallback;
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
    const frameBytes = estimateDataUriBytes(dataUri);
    if (frameBytes === null || frameBytes > MAX_NATIVE_BANNER_BYTES) {
        toast("The extracted PNG is over the 10 MB native-banner safety limit. Use a smaller or lower-resolution source.", Toasts.Type.FAILURE, 7000);
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
    const media = await fetchDataUri(url);
    if (!media) {
        toast("Couldn't download the banner URL. Verify it's a direct image link (not a webpage).", Toasts.Type.FAILURE, 6000);
        return false;
    }
    const mediaError = nativeBannerMediaError(media);
    if (mediaError) {
        toast(mediaError, Toasts.Type.FAILURE, 8000);
        return false;
    }
    try {
        await RestAPI.patch({
            url: "/users/@me/profile",
            body: { banner: media.dataUri }
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

type FlairMediaKind = "banner" | "avatar";

interface DirectMediaPreviewProps {
    kind: FlairMediaKind;
    url: string;
    profile?: Pick<ProfileFlair, "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect">;
}

/**
 * Field-local full-source preview for the editor. Keeping this beside the URL
 * input makes it obvious which source is being previewed, while the existing
 * dm-media proxy keeps cross-origin video previews usable in Chromium.
 */
function DirectMediaPreview({ kind, url, profile }: DirectMediaPreviewProps) {
    const [state, setState] = React.useState<"empty" | "loading" | "ready" | "error">("empty");
    const validSource = /^(?:https:\/\/|blob:|data:)/i.test(url);
    const isVideo = isVideoUrl(url);
    const source = isVideo && validSource ? proxyVideoUrl(url) : url;
    const objectPosition = kind === "banner"
        ? profile?.bannerPosition ?? "center"
        : profile?.avatarPosition ?? "center";
    const objectFit = kind === "banner"
        ? profile?.bannerFit ?? "cover"
        : profile?.avatarFit ?? "cover";
    const avatarScale = kind === "avatar" ? Number(profile?.avatarScale ?? "1") : 1;
    const mediaEffect = profile?.mediaEffect ?? "none";

    React.useEffect(() => {
        setState(url && validSource ? "loading" : "empty");
    }, [url, validSource]);

    const frameStyle: React.CSSProperties = {
        position: "relative",
        width: kind === "banner" ? "100%" : 220,
        height: kind === "banner" ? "auto" : 220,
        aspectRatio: kind === "banner" ? "2.83 / 1" : "1 / 1",
        minHeight: kind === "banner" ? 160 : 180,
        maxHeight: kind === "banner" ? 260 : 260,
        maxWidth: "100%",
        overflow: "hidden",
        borderRadius: 6,
        background: "rgba(0, 0, 0, 0.28)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        margin: "8px auto 0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
    };
    const mediaStyle: React.CSSProperties = {
        display: state === "error" ? "none" : "block",
        width: "100%",
        height: "100%",
        objectFit,
        objectPosition,
        background: "#17131d",
        transform: kind === "avatar" ? `scale(${avatarScale})` : undefined,
        filter: mediaEffect === "glow"
            ? "drop-shadow(0 0 10px rgba(226, 91, 255, 0.75))"
            : undefined
    };
    const messageStyle: React.CSSProperties = {
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 12px",
        textAlign: "center",
        color: state === "error" ? "#ffcfda" : "#cbd0e0",
        fontSize: 11,
        lineHeight: 1.35
    };

    if (!url) {
        return <div style={frameStyle} aria-label={`${kind} live preview`}>
            <div style={messageStyle}>Paste a direct HTTPS {kind} image, GIF, or video URL to preview it here.</div>
        </div>;
    }
    if (!validSource) {
        return <div style={frameStyle} aria-label={`${kind} live preview`}>
            <div style={messageStyle}>Preview needs a direct HTTPS media URL, not a webpage link.</div>
        </div>;
    }

    const onReady = () => setState("ready");
    const onError = () => setState("error");

    return (
        <div style={frameStyle} aria-label={`${kind} live preview`}>
            {isVideo ? (
                <video
                    src={source}
                    muted
                    loop
                    autoPlay
                    playsInline
                    preload="metadata"
                    style={mediaStyle}
                    onLoadedData={onReady}
                    onError={onError}
                />
            ) : (
                <img
                    src={source}
                    alt={`${kind} live preview`}
                    referrerPolicy="no-referrer"
                    style={mediaStyle}
                    onLoad={onReady}
                    onError={onError}
                />
            )}
            {mediaEffect === "scanline" && (
                <div
                    aria-hidden="true"
                    style={{
                        position: "absolute",
                        inset: 0,
                        pointerEvents: "none",
                        background: "repeating-linear-gradient(180deg, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px, transparent 4px)",
                        mixBlendMode: "screen",
                        opacity: 0.55
                    }}
                />
            )}
            {state === "loading" && <div style={messageStyle}>Loading preview…</div>}
            {state === "error" && <div style={messageStyle}>Could not load this URL. Use the direct media file link, not a webpage.</div>}
        </div>
    );
}

const settingLabelStyle: React.CSSProperties = {
    color: "#b5b9c9",
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 4
};
const settingDescriptionStyle: React.CSSProperties = {
    color: "#cbd0e0",
    fontSize: 11.5,
    lineHeight: 1.45,
    opacity: 0.85,
    marginBottom: 8
};
const settingInputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid rgba(255, 255, 255, 0.1)",
    background: "#1d2029",
    color: "#dbdee1",
    fontSize: 13,
    outline: "none"
};

interface FlairMediaSettingProps {
    kind: FlairMediaKind;
    value: string;
    profile?: Pick<ProfileFlair, "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect">;
    onChange(value: string): void;
}

function FlairMediaSetting({ kind, value, profile, onChange }: FlairMediaSettingProps) {
    const label = kind === "banner" ? "My Banner URL" : "My Avatar Animated URL";
    const description = kind === "banner"
        ? "[Channel E · FREE] Paste a DIRECT image, GIF, or short MP4/WebM URL — not a webpage. The preview below updates as you type."
        : "[Channel F · FREE] Paste a DIRECT image or GIF URL — not a webpage. Shared avatars accept GIF/image media; video avatars are native-Discord-only. The preview below updates as you type.";

    return (
        <div style={{ margin: "14px 0 16px" }}>
            <div style={settingLabelStyle}>{label}</div>
            <div style={settingDescriptionStyle}>{description}</div>
            <input
                type="text"
                aria-label={label}
                placeholder="https://..."
                value={value}
                style={settingInputStyle}
                onChange={event => onChange(event.currentTarget.value)}
            />
            <DirectMediaPreview kind={kind} url={value.trim()} profile={profile} />
        </div>
    );
}

type ThemeColorKind = "primary" | "secondary";

interface ThemeColorSettingProps {
    kind: ThemeColorKind;
    value: string;
    primary: string;
    secondary: string;
    onChange(value: string): void;
}

function ThemeColorSetting({ kind, value, primary, secondary, onChange }: ThemeColorSettingProps) {
    const color = normalizeColor(value);
    const label = kind === "primary" ? "My Theme Color Primary" : "My Theme Color Secondary";
    const description = kind === "primary"
        ? "[Channel G · FREE] Primary theme color — TOP of the profile gradient. Type #RRGGBB, RRGGBB, or 0xRRGGBB."
        : "[Channel G · FREE] Secondary theme color — BOTTOM of the profile gradient. It pairs with the primary once both are set.";
    const inputColor = color ?? "#cbd0e0";

    return (
        <div style={{ margin: "14px 0 16px" }}>
            <div style={settingLabelStyle}>{label}</div>
            <div style={settingDescriptionStyle}>{description}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                    type="text"
                    aria-label={label}
                    placeholder="#ff00aa"
                    value={value}
                    style={{ ...settingInputStyle, color: inputColor, fontWeight: 700, caretColor: inputColor }}
                    onChange={event => onChange(event.currentTarget.value)}
                />
                <input
                    type="color"
                    aria-label={`${label} color picker`}
                    value={color ?? "#666666"}
                    title="Choose a color"
                    style={{ width: 38, height: 38, padding: 2, border: "1px solid rgba(255,255,255,0.18)", borderRadius: 6, background: "#1d2029", cursor: "pointer" }}
                    onChange={event => onChange(event.currentTarget.value)}
                />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <span style={{ width: 22, height: 22, borderRadius: 5, background: color ?? "#343744", border: "1px solid rgba(255,255,255,0.18)" }} />
                <span style={{ color: inputColor, fontWeight: 700, fontSize: 12 }}>{color ?? "Enter a valid 6-digit hex color"}</span>
            </div>
            {kind === "secondary" && (primary || secondary) && (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: `linear-gradient(180deg, ${primary ?? "#29223a"} 0%, ${secondary ?? "#17131d"} 100%)`, border: "1px solid rgba(255,255,255,0.16)" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>Live profile gradient</div>
                    <div style={{ marginTop: 3, fontSize: 10.5, color: "rgba(255,255,255,0.9)", textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>
                        {primary ?? "primary not set"} → {secondary ?? "secondary not set"}
                    </div>
                </div>
            )}
        </div>
    );
}

interface ProfileEnhancementControlProps {
    label: string;
    description: string;
    value: string;
    minTier: Tier;
    options: Array<{ value: string; label: string }>;
    onChange(value: string): void;
}

/**
 * Paid profile controls intentionally modify presentation only. The media
 * URL and its animation remain identical at FREE; this component just makes
 * the paid upgrade obvious and prevents a lower-tier client from attempting
 * to write fields the worker will reject.
 */
function ProfileEnhancementControl({ label, description, value, minTier, options, onChange }: ProfileEnhancementControlProps) {
    const locked = getMyTier() < minTier;
    return (
        <div style={{ margin: "10px 0 12px", padding: "10px 11px", borderRadius: 7, background: locked ? "rgba(0, 0, 0, 0.16)" : "rgba(88, 101, 242, 0.08)", border: `1px solid ${locked ? "rgba(255,255,255,0.08)" : "rgba(88,101,242,0.3)"}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
                <div style={{ color: "#fbefff", fontSize: 12, fontWeight: 700 }}>{label}</div>
                <span style={{ color: locked ? "#a6abbc" : "#8feaff", fontSize: 10.5, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {locked ? `🔒 ${tierLabel(minTier)}` : "Included"}
                </span>
            </div>
            <div style={{ color: "#cbd0e0", fontSize: 10.5, lineHeight: 1.4, opacity: 0.82, marginBottom: 7 }}>{description}</div>
            <select
                aria-label={label}
                value={locked ? "" : value}
                disabled={locked}
                onChange={event => onChange(event.currentTarget.value)}
                style={{ ...settingInputStyle, cursor: locked ? "not-allowed" : "pointer", opacity: locked ? 0.58 : 1 }}
            >
                <option value="">Default</option>
                {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {locked && <div style={{ color: "#a6abbc", fontSize: 10, marginTop: 5 }}>Your free banner/avatar stays full-quality; this only adds a presentation control in {tierLabel(minTier)}.</div>}
        </div>
    );
}

type FlairActionFeedback = {
    kind: "success" | "error" | "info";
    text: string;
};

function FlairEditor() {
    // Use Vencord's reactive settings hook while the editor is mounted inside
    // the plugin-settings page. The generic ComponentSetting host invokes this
    // function during render, so reading the hook-backed proxy also guarantees
    // defaults are materialized before the editor dereferences URL/color fields.
    const s = settings.use([
        "myBannerUrl",
        "myVanillaStillFrameUrl",
        "myAvatarAnimatedUrl",
        "myThemeColorPrimary",
        "myThemeColorSecondary",
        "myBannerPosition",
        "myAvatarPosition",
        "myBannerFit",
        "myAvatarFit",
        "myAvatarScale",
        "myMediaEffect",
        "manualClaimCode",
        "recentPicksJson"
    ]);
    const [busy, setBusy] = React.useState(false);
    const [actionFeedback, setActionFeedback] = React.useState<FlairActionFeedback | null>(null);
    const announce = (kind: FlairActionFeedback["kind"], text: string) => setActionFeedback({ kind, text });
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
        const myTier = getMyTier();
        const proposed: Partial<ProfileFlair> = {
            bannerUrl: s.myBannerUrl.trim() || "",
            avatarAnimatedUrl: s.myAvatarAnimatedUrl.trim() || "",
            themeColorPrimary: normalizeForSave(s.myThemeColorPrimary),
            themeColorSecondary: normalizeForSave(s.myThemeColorSecondary)
        };
        // Never send a locked control. This keeps a stale local setting from
        // making a free save fail after a tier downgrade, while an empty
        // control on an eligible tier intentionally clears that presentation
        // choice in replace mode.
        if (myTier >= Tier.MAXXER) {
            proposed.bannerPosition = s.myBannerPosition.trim() || undefined;
            proposed.avatarPosition = s.myAvatarPosition.trim() || undefined;
        }
        if (myTier >= Tier.MAXXER_PLUS) {
            proposed.bannerFit = s.myBannerFit.trim() || undefined;
            proposed.avatarFit = s.myAvatarFit.trim() || undefined;
            proposed.avatarScale = s.myAvatarScale.trim() || undefined;
        }
        if (myTier >= Tier.MAXXER_PLUS_PLUS) {
            proposed.mediaEffect = s.myMediaEffect.trim() || undefined;
        }
        const err = validateLocal(proposed);
        if (err) {
            toast(err, Toasts.Type.FAILURE, 5000);
            announce("error", err);
            return;
        }
        setBusy(true);
        const me = UserStore.getCurrentUser?.();
        const claimCode = getProfileClaimCode();
        const needsBannerUpload = !!proposed.bannerUrl && !!me?.id
            && !isCanonicalProfileMediaUrl(proposed.bannerUrl, me.id, "banner");
        const needsAvatarUpload = !!proposed.avatarAnimatedUrl && !!me?.id
            && !isCanonicalProfileMediaUrl(proposed.avatarAnimatedUrl, me.id, "avatar");
        if ((needsBannerUpload || needsAvatarUpload) && (!me?.id || !claimCode)) {
            const message = "Cross-PC media saving needs activation. Open DMHub → Activate free profile, then save again.";
            toast(message, Toasts.Type.FAILURE, 6000);
            announce("error", message);
            setBusy(false);
            return;
        }
        try {
            // External URLs are only local inputs. Upload them once to the
            // owner's Worker namespace before publishing the roster, so every
            // other client receives the same durable bytes instead of a stale
            // or account-local URL. Uploads are sequential and limited to the
            // two fields in this editor; background repair is separately
            // throttled below to avoid quota storms.
            if (needsBannerUpload) {
                announce("info", "Saving your banner to shared Discordmaxxer storage…");
                proposed.bannerUrl = await uploadProfileMedia("banner", proposed.bannerUrl!, me!.id, claimCode);
            }
            if (needsAvatarUpload) {
                announce("info", "Saving your avatar to shared Discordmaxxer storage…");
                proposed.avatarAnimatedUrl = await uploadProfileMedia("avatar", proposed.avatarAnimatedUrl!, me!.id, claimCode);
            }
        } catch (e) {
            const message = `Media upload failed: ${(e as any)?.message ?? "network"}`;
            toast(message, Toasts.Type.FAILURE, 6000);
            announce("error", message);
            setBusy(false);
            return;
        }
        announce("info", "Saving to the shared Discordmaxxer roster…");
        // Replace mode: the editor reflects the user's full intended state,
        // so we replace rather than merge — empty fields clear server-side.
        const ok = await postFlairUpdate(proposed, true);
        if (ok) {
            // Keep the local editor aligned with the canonical Worker URL. It
            // is still a preview setting, but it must not re-upload the same
            // bytes on every restart.
            s.myBannerUrl = String(proposed.bannerUrl ?? "");
            s.myAvatarAnimatedUrl = String(proposed.avatarAnimatedUrl ?? "");
            s.myThemeColorPrimary = String(proposed.themeColorPrimary ?? "");
            s.myThemeColorSecondary = String(proposed.themeColorSecondary ?? "");
            await settleFlairDraftsAfterSave(proposed);
            // Push the just-saved values to the recents history so Diggy can
            // swap back like Discord's recent-avatars picker.
            recordRecentPicks(
                proposed.bannerUrl || "",
                proposed.avatarAnimatedUrl || "",
                proposed.themeColorPrimary || "",
                proposed.themeColorSecondary || ""
            );
            announce("success", "Saved to the shared Discordmaxxer roster. Other updated Discordmaxxer clients will see it after their roster refresh.");
        } else {
            announce("error", "The shared save failed. The error toast above contains the server reason.");
        }
        setBusy(false);
    };

    const onClearAll = async () => {
        if (!confirm("Clear all your custom profile flair (banner, avatar, colors, and presentation choices)?")) return;
        setBusy(true);
        announce("info", "Clearing your shared Discordmaxxer flair…");
        const ok = await postFlairUpdate({}, true);
        if (ok) {
            s.myBannerUrl = "";
            s.myAvatarAnimatedUrl = "";
            s.myThemeColorPrimary = "";
            s.myThemeColorSecondary = "";
            s.myBannerPosition = "";
            s.myAvatarPosition = "";
            s.myBannerFit = "";
            s.myAvatarFit = "";
            s.myAvatarScale = "";
            s.myMediaEffect = "";
            await settleFlairDraftsAfterSave({
                bannerUrl: undefined,
                avatarAnimatedUrl: undefined,
                themeColorPrimary: undefined,
                themeColorSecondary: undefined,
                bannerPosition: undefined,
                avatarPosition: undefined,
                bannerFit: undefined,
                avatarFit: undefined,
                avatarScale: undefined,
                mediaEffect: undefined
            });
            announce("success", "Cleared from the shared Discordmaxxer roster.");
        } else {
            announce("error", "The shared clear failed. The error toast above contains the server reason.");
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
        announce("info", "Sending the one-time native Discord color update…");
        const ok = await broadcastThemeColors(p, sec);
        announce(ok ? "success" : "error", ok
            ? "Discord accepted the native color update. This did not change your Discordmaxxer roster."
            : "Discord did not accept the native color update. The error toast above contains the reason.");
        setBusy(false);
    };

    const onBroadcastBannerPalette = async () => {
        const source = s.myVanillaStillFrameUrl.trim() || s.myBannerUrl.trim();
        if (!source) {
            toast("Set your banner URL above before trying the native color test.", Toasts.Type.FAILURE, 5000);
            return;
        }
        if (!confirm(broadcastConfirmCopy(
            "theme colors",
            "We'll sample the selected banner (or your chosen still-frame URL) and write only two native Discord profile colors. This does not upload the banner, change your avatar, or send a message. Discord may still restrict the render to Nitro accounts, so a vanilla second-account check is required."
        ))) return;
        setBusy(true);
        announce("info", "Sampling the banner and sending the one-time native color update…");
        const ok = await broadcastBannerPalette(source);
        announce(ok ? "success" : "error", ok
            ? "Native color test accepted. This changed the real Discord profile colors only; it did not change the Discordmaxxer roster."
            : "Native color test failed. The error toast above contains the reason.");
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
        announce("info", "Extracting the first frame and sending the one-time native banner update…");
        const ok = await broadcastStillBanner(u);
        announce(ok ? "success" : "error", ok
            ? "Native still-frame banner accepted by Discord. This did not change your Discordmaxxer roster."
            : "Native still-frame banner failed. The error toast above contains the reason.");
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
        announce("info", "Sending the one-time native Discord avatar update…");
        const ok = await broadcastAvatar(u);
        announce(ok ? "success" : "error", ok
            ? "Native Discord avatar accepted. This does not update the Discordmaxxer roster, so other Discordmaxxer clients will not inherit it."
            : "Native Discord avatar failed. The error toast above contains the reason.");
        setBusy(false);
    };

    const onBroadcastBanner = async () => {
        const u = s.myBannerUrl.trim();
        if (!u) {
            toast("Set a banner URL above before broadcasting.", Toasts.Type.FAILURE, 5000);
            return;
        }
        if (!confirm(broadcastConfirmCopy("banner", "⚠ Discord banners require Nitro for any user. This one-click path accepts confirmed static PNG/JPEG/WebP bytes only; use the still-frame action for video or GIF sources. Without Nitro this PATCH will fail (we'll show a clear error). For a no-Nitro identity, set your flair in Discordmaxxer instead — other Discordmaxxer users see your banner + gradient in-app."))) return;
        setBusy(true);
        announce("info", "Sending the one-time native Discord banner update…");
        const ok = await broadcastBanner(u);
        announce(ok ? "success" : "error", ok
            ? "Native Discord banner accepted. This did not change your Discordmaxxer roster."
            : "Native Discord banner failed. The error toast above contains the reason.");
        setBusy(false);
    };

    // ── Vanilla compatibility bridge ─────────────────────────────────────
    // These actions never write to the Discord account. They only place user-
    // chosen media/text on the local clipboard for an explicit paste into a
    // normal Discord message or DM. That is the only reliable no-Nitro route
    // for a stock client to see a roster-only banner.
    const onCopyVanillaCard = async () => {
        const banner = s.myBannerUrl.trim();
        const still = s.myVanillaStillFrameUrl.trim();
        if (!banner && !still) {
            toast("Set a banner URL or a vanilla still-frame URL first.", Toasts.Type.FAILURE, 5000);
            return;
        }
        const ok = await copyText(buildVanillaShareText(banner, still));
        toast(
            ok
                ? "✅ Vanilla share card copied — paste it into a Discord chat."
                : "Clipboard access was blocked; copy the banner link manually from the settings field.",
            ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE,
            6000
        );
    };

    const onCopyVanillaStill = async () => {
        const source = s.myVanillaStillFrameUrl.trim() || s.myBannerUrl.trim();
        if (!source) {
            toast("Set a banner URL or a vanilla still-frame URL first.", Toasts.Type.FAILURE, 5000);
            return;
        }
        setBusy(true);
        announce("info", "Extracting a still frame for the vanilla share path…");
        const ok = await copyVanillaStillFrame(source);
        announce(ok ? "success" : "error", ok
            ? "Vanilla still frame copied. Paste it into a normal Discord chat."
            : "Could not copy the vanilla still frame. The error toast above contains the reason.");
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
    const vanillaBridgeStyle: React.CSSProperties = {
        marginTop: 14, padding: "12px 0 0", borderTop: "1px dashed rgba(226, 91, 255, 0.35)"
    };

    // ── Recent picks UI — Discord-style quick-pick history ─────────────────
    const recents = readRecentPicks();
    const hasAnyRecents = recents.banners.length > 0 || recents.avatars.length > 0 || recents.colors.length > 0;
    const liveProfile: Pick<ProfileFlair, "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect"> = {
        bannerPosition: (s.myBannerPosition || undefined) as ProfileFlair["bannerPosition"],
        avatarPosition: (s.myAvatarPosition || undefined) as ProfileFlair["avatarPosition"],
        bannerFit: (s.myBannerFit || undefined) as ProfileFlair["bannerFit"],
        avatarFit: (s.myAvatarFit || undefined) as ProfileFlair["avatarFit"],
        avatarScale: (s.myAvatarScale || undefined) as ProfileFlair["avatarScale"],
        mediaEffect: (s.myMediaEffect || undefined) as ProfileFlair["mediaEffect"]
    };

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

            <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: "1px dashed rgba(226, 91, 255, 0.35)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#fbefff", marginBottom: 2 }}>
                    Live appearance preview
                </div>
                <div style={{ fontSize: 10.5, color: "#cbd0e0", opacity: 0.8, lineHeight: 1.4, marginBottom: 8 }}>
                    These are the same values used by the Save button. The preview updates while you type; Save to Discordmaxxer pushes the finished look to the roster.
                </div>
                <FlairMediaSetting
                    kind="banner"
                    value={s.myBannerUrl}
                    profile={liveProfile}
                    onChange={value => { s.myBannerUrl = value; markFlairDraftField("myBannerUrl"); }}
                />
                <FlairMediaSetting
                    kind="avatar"
                    value={s.myAvatarAnimatedUrl}
                    profile={liveProfile}
                    onChange={value => { s.myAvatarAnimatedUrl = value; markFlairDraftField("myAvatarAnimatedUrl"); }}
                />
                <div style={{ margin: "4px 0 8px", padding: "10px 11px", borderRadius: 7, background: "rgba(0, 212, 255, 0.05)", border: "1px solid rgba(0, 212, 255, 0.2)" }}>
                    <div style={{ color: "#fbefff", fontSize: 12, fontWeight: 700, marginBottom: 3 }}>Paid presentation enhancements</div>
                    <div style={{ color: "#cbd0e0", fontSize: 10.5, lineHeight: 1.4, opacity: 0.85 }}>
                        Free users keep the exact same animated banner/avatar quality. Paid tiers only add optional framing, scale, and visual-finish controls, and the selected controls travel with your profile to other Discordmaxxer clients.
                    </div>
                </div>
                <ProfileEnhancementControl
                    label="Banner crop anchor"
                    description="Choose which part of a tall or wide banner stays visible when it is cropped."
                    value={s.myBannerPosition}
                    minTier={Tier.MAXXER}
                    options={POSITION_OPTIONS}
                    onChange={value => { s.myBannerPosition = value; markFlairDraftField("myBannerPosition"); }}
                />
                <ProfileEnhancementControl
                    label="Banner fit"
                    description="Fill the banner area or show the whole source with letterboxing."
                    value={s.myBannerFit}
                    minTier={Tier.MAXXER_PLUS}
                    options={FIT_OPTIONS}
                    onChange={value => { s.myBannerFit = value; markFlairDraftField("myBannerFit"); }}
                />
                <ProfileEnhancementControl
                    label="Avatar crop anchor"
                    description="Choose the top, center, or bottom of an animated avatar source."
                    value={s.myAvatarPosition}
                    minTier={Tier.MAXXER}
                    options={POSITION_OPTIONS}
                    onChange={value => { s.myAvatarPosition = value; markFlairDraftField("myAvatarPosition"); }}
                />
                <ProfileEnhancementControl
                    label="Avatar fit + scale"
                    description="Show the whole avatar and adjust its size inside the avatar frame."
                    value={s.myAvatarFit}
                    minTier={Tier.MAXXER_PLUS}
                    options={FIT_OPTIONS}
                    onChange={value => { s.myAvatarFit = value; markFlairDraftField("myAvatarFit"); }}
                />
                <ProfileEnhancementControl
                    label="Avatar scale"
                    description="Fine-tune the animated avatar size without changing the source media."
                    value={s.myAvatarScale}
                    minTier={Tier.MAXXER_PLUS}
                    options={SCALE_OPTIONS}
                    onChange={value => { s.myAvatarScale = value; markFlairDraftField("myAvatarScale"); }}
                />
                <ProfileEnhancementControl
                    label="Media finish"
                    description="Add a subtle glow or scanline finish to your shared banner and avatar."
                    value={s.myMediaEffect}
                    minTier={Tier.MAXXER_PLUS_PLUS}
                    options={EFFECT_OPTIONS}
                    onChange={value => { s.myMediaEffect = value; markFlairDraftField("myMediaEffect"); }}
                />
                <ThemeColorSetting
                    kind="primary"
                    value={s.myThemeColorPrimary}
                    primary={normalizeColor(s.myThemeColorPrimary) ?? ""}
                    secondary={normalizeColor(s.myThemeColorSecondary) ?? ""}
                    onChange={value => { s.myThemeColorPrimary = value; markFlairDraftField("myThemeColorPrimary"); }}
                />
                <ThemeColorSetting
                    kind="secondary"
                    value={s.myThemeColorSecondary}
                    primary={normalizeColor(s.myThemeColorPrimary) ?? ""}
                    secondary={normalizeColor(s.myThemeColorSecondary) ?? ""}
                    onChange={value => { s.myThemeColorSecondary = value; markFlairDraftField("myThemeColorSecondary"); }}
                />
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
                                    onClick={() => { s.myBannerUrl = url; markFlairDraftField("myBannerUrl"); }}
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
                                    onClick={() => { s.myAvatarAnimatedUrl = url; markFlairDraftField("myAvatarAnimatedUrl"); }}
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
                                        onClick={() => { s.myThemeColorPrimary = p; s.myThemeColorSecondary = sec; markFlairDraftField("myThemeColorPrimary"); markFlairDraftField("myThemeColorSecondary"); }}
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
                Worker validates the roster claim and media safety server-side. Profile
                flair is free for every claimed Discordmaxxer user: one active banner,
                one active animated avatar, and the two theme colors. TournamentMode
                pauses animated media while it is active.
            </div>
            <div style={btnRow}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onSave} disabled={busy}>
                    💾 Save to Discordmaxxer
                </Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={onClearAll} disabled={busy}>
                    ✕ Clear all my flair
                </Button>
            </div>
            {actionFeedback && (
                <div
                    role="status"
                    aria-live="polite"
                    style={{
                        marginTop: 9,
                        padding: "8px 10px",
                        borderRadius: 6,
                        background: actionFeedback.kind === "success"
                            ? "rgba(67, 211, 123, 0.12)"
                            : actionFeedback.kind === "error"
                                ? "rgba(237, 66, 69, 0.12)"
                                : "rgba(88, 101, 242, 0.12)",
                        border: `1px solid ${actionFeedback.kind === "success"
                            ? "rgba(67, 211, 123, 0.45)"
                            : actionFeedback.kind === "error"
                                ? "rgba(237, 66, 69, 0.45)"
                                : "rgba(88, 101, 242, 0.45)"}`,
                        color: actionFeedback.kind === "success"
                            ? "#9ff0bb"
                            : actionFeedback.kind === "error"
                                ? "#ffb4b5"
                                : "#c9d0ff",
                        fontSize: 11.5,
                        lineHeight: 1.45
                    }}
                >
                    {actionFeedback.kind === "success" ? "✅ " : actionFeedback.kind === "error" ? "⚠️ " : "ℹ️ "}
                    {actionFeedback.text}
                </div>
            )}

            <div style={broadcastWrapStyle}>
                <div style={broadcastTitleStyle}>📡 Broadcast to vanilla Discord (one-time)</div>
                <div style={broadcastNoteStyle}>
                    The buttons above save flair that <b>only other Discordmaxxer users</b> can see.
                    These buttons below PATCH your <b>real Discord profile</b> so <b>everyone</b> sees it —
                    Nitro friends, normies, mobile-only users, the works. Fires once per click; never re-asserts.
                    <br /><br />
                    <b>Theme gradient:</b> PATCH succeeds on free accounts but Discord silently <b>Nitro-gates the render</b> — vanilla viewers see default unless you have Nitro. <b>Static avatar:</b> free. <b>Any banner (static or still-frame):</b> Nitro required server-side. The new palette button samples your banner into two native colors as a best-effort test; it does not upload the banner or change your avatar.
                    <br /><br />
                    Native broadcast buttons affect the real Discord profile only. They do not update the shared Discordmaxxer roster; use <b>Save to Discordmaxxer</b> when you want other Discordmaxxer clients to see your flair.
                </div>
                <div style={broadcastBtnRow}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastColors} disabled={busy}>
                        📡 Broadcast theme gradient (Nitro-gated render)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onBroadcastBannerPalette} disabled={busy}>
                        🎨 Try banner as native colors (best effort)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastAvatar} disabled={busy}>
                        📡 Broadcast avatar to native Discord (not shared roster)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastBanner} disabled={busy}>
                        📡 Broadcast banner as-is (Nitro required)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onBroadcastStillBanner} disabled={busy}>
                        📡 Broadcast banner as still-frame (extract first frame from video/GIF, Nitro required)
                    </Button>
                </div>
            </div>

            <div style={vanillaBridgeStyle}>
                <div style={broadcastTitleStyle}>🌉 Vanilla compatibility bridge (normal Discord message)</div>
                <div style={broadcastNoteStyle}>
                    Stock Discord cannot render Discordmaxxer-only profile flair, and Nitro is required for a real
                    Discord profile banner. These buttons do not touch your account: they copy a share card or a
                    PNG still frame so you can paste it into a normal Discord channel or DM. That is what vanilla
                    users can actually see. Use the optional still-frame URL below when you want to choose a
                    specific fallback; otherwise the first frame of your banner is used.
                </div>
                <div style={broadcastBtnRow}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onCopyVanillaCard} disabled={busy}>
                        📋 Copy vanilla share card (animated link + install link)
                    </Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onCopyVanillaStill} disabled={busy}>
                        🖼 Copy vanilla still frame (paste into chat)
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
        description: "(Shown in the Live appearance preview below.)",
        default: "",
        hidden: true
    },
    myVanillaStillFrameUrl: {
        type: OptionType.STRING,
        description:
            "Optional vanilla fallback: a direct static PNG/JPG/WebP URL you want to show to stock Discord users. " +
            "The bridge uses this instead of extracting the first frame from myBannerUrl. This stays local and is " +
            "never sent to the Discordmaxxer roster.",
        default: ""
    },
    myAvatarAnimatedUrl: {
        type: OptionType.STRING,
        description: "(Shown in the Live appearance preview below.)",
        default: "",
        hidden: true
    },
    myThemeColorPrimary: {
        type: OptionType.STRING,
        description: "(Shown in the Live appearance preview below.)",
        default: "",
        hidden: true
    },
    myThemeColorSecondary: {
        type: OptionType.STRING,
        description: "(Shown in the Live appearance preview below.)",
        default: "",
        hidden: true
    },
    // Presentation-only controls. The media URLs remain identical for every
    // tier; these values are optional paid enhancements stored alongside the
    // owner's profile so other Discordmaxxer clients can render the same
    // framing/effect instead of falling back to the viewer's settings.
    myBannerPosition: {
        type: OptionType.STRING,
        description: "(Managed by the profile editor.)",
        default: "",
        hidden: true
    },
    myAvatarPosition: {
        type: OptionType.STRING,
        description: "(Managed by the profile editor.)",
        default: "",
        hidden: true
    },
    myBannerFit: {
        type: OptionType.STRING,
        description: "(Managed by the profile editor.)",
        default: "",
        hidden: true
    },
    myAvatarFit: {
        type: OptionType.STRING,
        description: "(Managed by the profile editor.)",
        default: "",
        hidden: true
    },
    myAvatarScale: {
        type: OptionType.STRING,
        description: "(Managed by the profile editor.)",
        default: "",
        hidden: true
    },
    myMediaEffect: {
        type: OptionType.STRING,
        description: "(Managed by the profile editor.)",
        default: "",
        hidden: true
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
let mediaPlaybackObserver: IntersectionObserver | null = null;
let rescanTimer: number | null = null;
let defaultAvatarWarned = false;
let removeRosterListener: (() => void) | null = null;
let lastRosterRefreshAt = 0;
const ROSTER_FOCUS_REFRESH_INTERVAL_MS = 30_000;
const PROFILE_MEDIA_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PROFILE_MEDIA_SYNC_RETRY_MS = 60 * 1000;
let profileMediaSyncTimer: number | null = null;
let profileMediaSyncInFlight: Promise<void> | null = null;
let profileMediaLastSyncAt = 0;
let profileMediaLastSyncSignature = "";

/**
 * Repair the owner's persisted banner/avatar after a client restart. The
 * editor's explicit Save remains the path for unsaved drafts; this background
 * path only handles persisted values that are not already canonical Worker
 * media. That makes the first PC that can see a local banner the publisher,
 * while protecting a newer choice made on another PC with ifUpdatedAt.
 */
async function syncLocalProfileMediaToCloud(): Promise<void> {
    if (profileMediaSyncInFlight) return profileMediaSyncInFlight;
    const task = (async () => {
        const me = UserStore.getCurrentUser?.();
        const claimCode = getProfileClaimCode();
        if (!me?.id || !claimCode) return;

        try {
            await refreshRoster();
            const remote = getRosterProfileFlair(me.id) ?? {};
            const remoteProfileKnown = getRosterProfileUpdatedAt(me.id) !== undefined;
            const remoteUpdatedAt = getRosterProfileUpdatedAt(me.id) ?? 0;
            const remoteBanner = typeof remote.bannerUrl === "string" ? remote.bannerUrl : "";
            const remoteAvatar = typeof remote.avatarAnimatedUrl === "string" ? remote.avatarAnimatedUrl : "";
            const s = settings.store;
            let banner = s.myBannerUrl.trim();
            let avatar = s.myAvatarAnimatedUrl.trim();
            const bannerDraft = flairDraftFields.has("myBannerUrl");
            const avatarDraft = flairDraftFields.has("myAvatarAnimatedUrl");

            // After a second install changes the account, the shared owner
            // record wins over stale persisted local settings unless the user
            // is actively editing that field right now.
            if (!bannerDraft && (remoteProfileKnown ? banner !== remoteBanner : !!remoteBanner && banner !== remoteBanner)) {
                s.myBannerUrl = remoteBanner;
                banner = remoteBanner;
            }
            if (!avatarDraft && (remoteProfileKnown ? avatar !== remoteAvatar : !!remoteAvatar && avatar !== remoteAvatar)) {
                s.myAvatarAnimatedUrl = remoteAvatar;
                avatar = remoteAvatar;
            }

            const signature = `${me.id}|${remoteUpdatedAt}|${banner}|${avatar}|${bannerDraft ? 1 : 0}|${avatarDraft ? 1 : 0}`;
            const now = Date.now();
            if (profileMediaLastSyncSignature === signature
                && now - profileMediaLastSyncAt < PROFILE_MEDIA_SYNC_INTERVAL_MS) return;

            const proposed: Partial<ProfileFlair> = {};
            if (!bannerDraft && banner) {
                if (!isCanonicalProfileMediaUrl(banner, me.id, "banner")) {
                    proposed.bannerUrl = await uploadProfileMedia("banner", banner, me.id, claimCode);
                } else if (banner !== remoteBanner) {
                    proposed.bannerUrl = banner;
                }
            }
            if (!avatarDraft && avatar) {
                if (!isCanonicalProfileMediaUrl(avatar, me.id, "avatar")) {
                    proposed.avatarAnimatedUrl = await uploadProfileMedia("avatar", avatar, me.id, claimCode);
                } else if (avatar !== remoteAvatar) {
                    proposed.avatarAnimatedUrl = avatar;
                }
            }

            if (!Object.keys(proposed).length) {
                profileMediaLastSyncAt = now;
                profileMediaLastSyncSignature = signature;
                return;
            }

            // Passing 0 when no profile timestamp exists is intentional: it
            // makes a concurrent first write conflict with an already-created
            // profile instead of allowing a stale install to win silently.
            const saved = await postFlairUpdate(proposed, false, false, remoteUpdatedAt);
            if (!saved) {
                // A 409 means another PC won. Re-read and adopt the winner;
                // do not retry the stale local bytes in a loop.
                await refreshRoster();
                const latest = getRosterProfileFlair(me.id) ?? {};
                const latestKnown = getRosterProfileUpdatedAt(me.id) !== undefined;
                const latestBanner = typeof latest.bannerUrl === "string" ? latest.bannerUrl : "";
                const latestAvatar = typeof latest.avatarAnimatedUrl === "string" ? latest.avatarAnimatedUrl : "";
                if (!flairDraftFields.has("myBannerUrl") && (latestKnown || latestBanner)) s.myBannerUrl = latestBanner;
                if (!flairDraftFields.has("myAvatarAnimatedUrl") && (latestKnown || latestAvatar)) s.myAvatarAnimatedUrl = latestAvatar;
                profileMediaLastSyncAt = Date.now();
                profileMediaLastSyncSignature = `${me.id}|${getRosterProfileUpdatedAt(me.id) ?? 0}|${s.myBannerUrl}|${s.myAvatarAnimatedUrl}`;
                return;
            }

            if (proposed.bannerUrl) s.myBannerUrl = proposed.bannerUrl;
            if (proposed.avatarAnimatedUrl) s.myAvatarAnimatedUrl = proposed.avatarAnimatedUrl;
            // The worker invalidates its roster memo on a successful write;
            // refresh immediately so the owner's own popout does not show a
            // one-frame stale native banner while waiting for the 30s TTL.
            await refreshRoster();
            profileMediaLastSyncAt = Date.now();
            profileMediaLastSyncSignature = `${me.id}|${getRosterProfileUpdatedAt(me.id) ?? 0}|${s.myBannerUrl}|${s.myAvatarAnimatedUrl}`;
        } catch (e) {
            // Background repair must never interrupt Discord or create a toast
            // storm. It will retry once after a bounded delay when the profile
            // surface is focused again.
            console.warn("[DMProfileFlair] background profile media sync failed:", e);
            profileMediaLastSyncAt = Date.now() - PROFILE_MEDIA_SYNC_INTERVAL_MS + PROFILE_MEDIA_SYNC_RETRY_MS;
        }
    })().finally(() => { profileMediaSyncInFlight = null; });
    profileMediaSyncInFlight = task;
    return task;
}

function scheduleProfileMediaSync(): void {
    if (document.hidden || profileMediaSyncTimer !== null) return;
    profileMediaSyncTimer = window.setTimeout(() => {
        profileMediaSyncTimer = null;
        void syncLocalProfileMediaToCloud();
    }, 1500);
}

function resumeVisibleBannerVideos(): void {
    if (document.hidden) return;
    document.querySelectorAll<HTMLVideoElement>(".dm-flair-banner-video").forEach(video => {
        const rect = video.getBoundingClientRect();
        const inViewport = rect.bottom > 0 && rect.right > 0
            && rect.top < window.innerHeight && rect.left < window.innerWidth;
        if (inViewport) video.play().catch(() => {});
    });
}

function observeBannerMedia(media: HTMLVideoElement | HTMLImageElement): void {
    // Chromium resumes animated images on its own when they become visible;
    // only videos need an explicit play() nudge after background throttling.
    if (!(media instanceof HTMLVideoElement) || !mediaPlaybackObserver) return;
    mediaPlaybackObserver.observe(media);
}

function unobserveBannerMedia(media: Element): void {
    mediaPlaybackObserver?.unobserve(media);
}

function refreshRosterForVisibleSurface(): void {
    if (document.hidden) return;
    scheduleScan();
    const now = Date.now();
    if (now - lastRosterRefreshAt < ROSTER_FOCUS_REFRESH_INTERVAL_MS) return;
    lastRosterRefreshAt = now;
    refreshRoster().catch(e => console.warn("[DMProfileFlair] focused roster refresh failed:", e));
}

const onVisibilityChange = () => {
    if (!document.hidden) {
        resumeVisibleBannerVideos();
        refreshRosterForVisibleSurface();
        scheduleProfileMediaSync();
    }
};
const onRosterFocus = () => {
    resumeVisibleBannerVideos();
    refreshRosterForVisibleSurface();
    scheduleProfileMediaSync();
};


/** True if a URL is explicitly marked or named as a video. Shared profile
 *  media URLs are extensionless, so they must not be assumed to be videos:
 *  the existing Diggyai banner is an animated GIF served from that route. */
function isVideoUrl(url: string): boolean {
    return /^data:video\//i.test(url) ||
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
        /\.(gif|apng)(\?|#|$)/i.test(url) ||
        /\/profile-media\/[^/?#]+\/(?:banner|avatar)(?:\/|[?#]|$)/i.test(url) ||
        /\/avatars\/\d{17,20}\/a_[^/?#]+\.(?:gif|webp|png)(?:[?#]|$)/i.test(url);
}

function buildCss(): string {
    return `
        /* Keep the native media hidden only while our replacement has loaded.
           Discord has used <img>, <picture>, and <video> for this surface over
           time; do not blanket-hide descendants because the avatar may live in
           the same profile root. */
        [data-dm-flair-banner-applied] > img:not(.dm-flair-banner-image),
        [data-dm-flair-banner-applied] > picture,
        [data-dm-flair-banner-applied] > video:not(.dm-flair-banner-video) {
            visibility: hidden !important;
        }
        [data-dm-flair-banner-applied] {
            isolation: isolate;
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
            z-index: 2;
            opacity: 0;
            transition: opacity 120ms ease;
        }
        /* Image overlays are used for static and animated images, including
           extensionless profile-media GIFs. Keeping the overlay transparent
           until its load event prevents a blank banner while the replacement
           is still fetching. */
        .dm-flair-banner-image {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            object-position: center;
            pointer-events: none;
            z-index: 2;
            opacity: 0;
            transition: opacity 120ms ease;
        }

        /* Owner-selected presentation controls. These are layered on top of
           the same full-quality media for every tier; FREE keeps the native
           cover/center defaults and never receives a lower-quality asset. */
        [data-dm-flair-banner-fit="contain"] .dm-flair-banner-video,
        [data-dm-flair-banner-fit="contain"] .dm-flair-banner-image {
            object-fit: contain !important;
        }
        [data-dm-flair-banner-position="top"] .dm-flair-banner-video,
        [data-dm-flair-banner-position="top"] .dm-flair-banner-image {
            object-position: center top !important;
        }
        [data-dm-flair-banner-position="bottom"] .dm-flair-banner-video,
        [data-dm-flair-banner-position="bottom"] .dm-flair-banner-image {
            object-position: center bottom !important;
        }
        [data-dm-flair-media-effect="glow"] .dm-flair-banner-video,
        [data-dm-flair-media-effect="glow"] .dm-flair-banner-image {
            filter: drop-shadow(0 0 12px rgba(226, 91, 255, 0.75));
        }
        [data-dm-flair-media-effect="scanline"]::after {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            z-index: 3;
            background: repeating-linear-gradient(180deg, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px, transparent 4px);
            mix-blend-mode: screen;
            opacity: 0.42;
        }

        img[data-dm-flair-avatar-applied] {
            object-fit: cover !important;
            object-position: center !important;
            transform-origin: center center;
        }
        img[data-dm-flair-avatar-fit="contain"] {
            object-fit: contain !important;
        }
        img[data-dm-flair-avatar-position="top"] {
            object-position: center top !important;
        }
        img[data-dm-flair-avatar-position="bottom"] {
            object-position: center bottom !important;
        }
        img[data-dm-flair-avatar-scale="0.9"] {
            transform: scale(0.9);
        }
        img[data-dm-flair-avatar-scale="1.1"] {
            transform: scale(1.1);
        }
        img[data-dm-flair-avatar-effect="glow"] {
            filter: drop-shadow(0 0 8px rgba(226, 91, 255, 0.75));
        }
        img[data-dm-flair-avatar-effect="scanline"] {
            filter: saturate(1.2) contrast(1.08);
        }
        [data-dm-flair-bg-avatar-applied][data-dm-flair-avatar-fit="contain"] {
            background-size: contain !important;
        }
        [data-dm-flair-bg-avatar-applied][data-dm-flair-avatar-fit="cover"] {
            background-size: cover !important;
        }
        [data-dm-flair-bg-avatar-applied][data-dm-flair-avatar-position="top"] {
            background-position: center top !important;
        }
        [data-dm-flair-bg-avatar-applied][data-dm-flair-avatar-position="bottom"] {
            background-position: center bottom !important;
        }

        [class*="user-profile"] img[data-dm-flair-avatar-applied],
        [role="dialog"] img[data-dm-flair-avatar-applied] {
            position: relative !important;
            z-index: 2 !important;
        }

    `;
}

/** Find all profile banner elements page-wide. Modern Discord uses
 *  `banner__<hash>` (verified `banner__68edb` for both the small popout
 *  banner and the full-profile-view banner). Filter by size to skip small
 *  decorative banner SVGs. */
const PROFILE_FAST_SCAN_ROOT_SELECTOR = [
    '[class*="user-profile-popout"]',
    '[class*="user-profile-sidebar"]',
    '[class*="userProfileSidebar"]',
    '[class*="userProfileModal"]',
    '[class*="user-profile-modal"]',
    '[class*="userPopout"]',
    '[class*="user-popout"]',
    '[class*="profileModal"]',
    '[class*="profile-modal"]'
].join(", ");

const PROFILE_BANNER_SELECTOR = '[class*="banner_"], [class*="profileBanner"], [class*="userProfileBanner"]';

function isProfileBannerWrapper(element: Element): boolean {
    return Array.from(element.classList).some(token => /^banner_[a-z0-9]+$/i.test(token));
}

const PROFILE_VIEW_AVATAR_SELECTOR = [
    ...PROFILE_FAST_SCAN_ROOT_SELECTOR.split(", ").map(selector => `${selector} img[class*="avatar__"]`),
    '[role="dialog"] img[class*="avatar__"]'
].join(", ");

function profileFastRootFor(element: Element): HTMLElement | null {
    const semanticRoot = element.closest<HTMLElement>(PROFILE_FAST_SCAN_ROOT_SELECTOR);
    if (semanticRoot) return semanticRoot;
    const dialog = element.closest<HTMLElement>('[role="dialog"]');
    return dialog?.querySelector(PROFILE_BANNER_SELECTOR) ? dialog : null;
}

function findAllProfileBanners(): HTMLElement[] {
    const out: HTMLElement[] = [];
    document.querySelectorAll(PROFILE_BANNER_SELECTOR).forEach(c => {
        const el = c as HTMLElement;
        const wrapper = el.parentElement?.closest<HTMLElement>('[class*="banner_"]');
        if (!isProfileBannerWrapper(el) && wrapper && isProfileBannerWrapper(wrapper)) return;
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
function findProfileViewAvatars(root: ParentNode = document): HTMLImageElement[] {
    const out: HTMLImageElement[] = [];
    root.querySelectorAll(PROFILE_VIEW_AVATAR_SELECTOR).forEach(c => {
        const el = c as HTMLImageElement;
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 60 && profileFastRootFor(el)) out.push(el);
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
        PROFILE_FAST_SCAN_ROOT_SELECTOR + ', [role="dialog"]'
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

const DISCORD_AVATAR_ID_RE = /\/avatars\/(\d{17,20})\//;

function userIdFromMediaValue(value: string | null | undefined): string | null {
    if (!value) return null;
    const values = [value];
    try {
        const decoded = decodeURIComponent(value);
        if (decoded !== value) values.push(decoded);
    } catch { /* malformed srcset/data attribute — inspect the original */ }
    for (const candidate of values) {
        const match = candidate.match(DISCORD_AVATAR_ID_RE);
        if (match) return match[1];
    }
    return null;
}

function mediaValuesForImage(image: HTMLImageElement): string[] {
    return [
        image.currentSrc,
        image.src,
        image.getAttribute("src"),
        image.getAttribute("srcset"),
        image.getAttribute("data-src"),
        image.getAttribute("data-lazy-src"),
        image.getAttribute("data-original")
    ].filter((value): value is string => Boolean(value));
}

function userIdFromElementMedia(element: Element): string | null {
    for (const attr of ["style", "data-background-image", "data-image-url", "data-src", "data-lazy-src"]) {
        const found = userIdFromMediaValue(element.getAttribute(attr));
        if (found) return found;
    }
    if (element instanceof HTMLImageElement) {
        for (const value of mediaValuesForImage(element)) {
            const found = userIdFromMediaValue(value);
            if (found) return found;
        }
    }
    return null;
}

/** Try to identify whose profile a popout/full-profile view belongs to. Modern
 *  Discord does not consistently put `data-user-id` on profile containers, and
 *  newer surfaces may expose the avatar through `srcset`, lazy-load attributes,
 *  or an inline background instead of the loaded `img.src`. Inspect every
 *  bounded media representation before falling back to React props. */
function getUserIdFromContainerLegacy(container: Element): string | null {
    // Discord has changed the avatar class token across profile-sidebar and
    // popout layouts. The CDN path is the stable identity signal, so inspect
    // every image in this already-bounded profile container instead of
    // requiring the current `avatar__` class name.
    const imgs = container.querySelectorAll("img");
    for (const img of imgs) {
        const found = userIdFromElementMedia(img);
        if (found) return found;
    }
    for (const el of container.querySelectorAll<HTMLElement>("[style], [data-background-image], [data-image-url]")) {
        const found = userIdFromElementMedia(el);
        if (found) return found;
    }
    return null;
}

function validSnowflake(value: unknown): string | null {
    const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
    return /^\d{17,20}$/.test(text) ? text : null;
}

function findUserIdInReactValue(value: unknown, depth = 0, seen = new Set<object>(), budget = { left: 500 }): string | null {
    if (depth > 5 || budget.left-- <= 0 || value == null) return null;
    const direct = validSnowflake(value);
    if (direct) return direct;
    if (typeof value !== "object" || seen.has(value)) return null;
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

function findUserIdFromContainerUncached(container: Element): string | null {
    let ancestor: Element | null = container;
    for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
        for (const attr of ["data-user-id", "data-userid", "data-profile-user-id", "data-profile-userid"]) {
            const found = validSnowflake(ancestor.getAttribute(attr));
            if (found) return found;
        }
        const ancestorMatch = (ancestor.getAttribute("id") ?? "").match(/(?:user|profile)[-_](\d{17,20})/i);
        if (ancestorMatch) return ancestorMatch[1];
    }

    const elements = [container, ...Array.from(container.querySelectorAll("*"))].slice(0, 600);
    for (const el of elements) {
        for (const attr of ["data-user-id", "data-userid", "data-profile-user-id", "data-profile-userid"]) {
            const found = validSnowflake(el.getAttribute(attr));
            if (found) return found;
        }
        const flairAvatarId = validSnowflake(el.getAttribute("data-dm-flair-avatar-user-id"));
        if (flairAvatarId) return flairAvatarId;
        const hrefMatch = (el.getAttribute("href") ?? "").match(/\/(?:users?|profile)\/(\d{17,20})(?:\/|$)/i);
        if (hrefMatch) return hrefMatch[1];
        const domMatch = (el.getAttribute("id") ?? "").match(/(?:user|profile)[-_](\d{17,20})/i);
        if (domMatch) return domMatch[1];
        const mediaMatch = userIdFromElementMedia(el);
        if (mediaMatch) return mediaMatch;
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

const profileIdentityCache = new WeakMap<Element, { signature: string; userId: string | null; checkedAt: number }>();

function profileIdentitySignature(container: Element): string {
    const attrs = ["data-user-id", "data-userid", "data-profile-user-id", "data-profile-userid", "id"]
        .map(key => container.getAttribute(key) ?? "")
        .join("|");
    const media = Array.from(container.querySelectorAll("img"))
        .slice(0, 24)
        .flatMap(img => mediaValuesForImage(img as HTMLImageElement))
        .join("|");
    const flairOwner = container.querySelector("[data-dm-flair-avatar-user-id]")?.getAttribute("data-dm-flair-avatar-user-id") || "";
    return `${attrs}|${media}|${flairOwner}|${container.childElementCount}`;
}

function getUserIdFromContainer(container: Element): string | null {
    // Discord sometimes places the banner in a paint-only inner wrapper while
    // the identity-bearing avatar lives on the semantic profile root. Search
    // that bounded root as a fallback; never widen this to the whole document,
    // which is how a banner in a DM used to inherit the wrong user's flair.
    const roots: Element[] = [container];
    const profileRoot = profileFastRootFor(container);
    if (profileRoot && profileRoot !== container) roots.push(profileRoot);
    const signature = roots.map(profileIdentitySignature).join("||");
    const cached = profileIdentityCache.get(container);
    if (cached?.signature === signature && Date.now() - cached.checkedAt < 1500) return cached.userId;
    let userId: string | null = null;
    for (const root of roots) {
        userId = findUserIdFromContainerUncached(root);
        if (userId) break;
    }
    profileIdentityCache.set(container, { signature, userId, checkedAt: Date.now() });
    return userId;
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
        // Per-field merge (see getEffectiveFlairForUser): roster is the base,
        // and only fields actively edited in this session may override it.
        // Persisted values can belong to another Discordmaxxer install or be
        // an old external URL, so they must never beat the owner's cloud
        // record after a restart.
        const merged: ProfileFlair = { ...(getRosterProfileFlair(userId) ?? {}) };
        applyLocalDraftField(merged, s.myBannerUrl, "myBannerUrl", "bannerUrl");
        applyLocalDraftField(merged, s.myAvatarAnimatedUrl, "myAvatarAnimatedUrl", "avatarAnimatedUrl");
        applyLocalDraftField(merged, s.myThemeColorPrimary, "myThemeColorPrimary", "themeColorPrimary");
        applyLocalDraftField(merged, s.myThemeColorSecondary, "myThemeColorSecondary", "themeColorSecondary");
        mergeLocalPresentationFields(merged, s);
        if (Object.keys(merged).length) flair = merged;
    } else if (userId) {
        flair = getRosterProfileFlair(userId) ?? null;
    }
    if (!flair) return null;

    if ((kind === "banner" || kind === "avatar") && isTournamentModeActive()) return null;
    return flair;
}

/** Remove our banner overlay and put the native Discord banner back. A failed
 * remote media load must not leave the stock banner hidden behind a blank
 * overlay. */
function clearBanner(banner: HTMLElement, failedUrl?: string) {
    banner.removeAttribute("data-dm-flair-banner-applied");
    delete banner.dataset.dmFlairBannerUserId;
    delete banner.dataset.dmFlairBannerOwnerId;
    delete banner.dataset.dmFlairBannerPosition;
    delete banner.dataset.dmFlairBannerFit;
    delete banner.dataset.dmFlairMediaEffect;
    delete banner.dataset.dmFlairBannerAppliedUrl;
    delete banner.dataset.dmFlairBannerLoadingUrl;
    banner.querySelectorAll(".dm-flair-banner-video, .dm-flair-banner-image").forEach(v => {
        unobserveBannerMedia(v);
        v.remove();
    });
    if (banner.hasAttribute("data-dm-flair-original-position")) {
        const originalPosition = banner.dataset.dmFlairOriginalPosition ?? "";
        if (originalPosition) banner.style.position = originalPosition;
        else banner.style.removeProperty("position");
        delete banner.dataset.dmFlairOriginalPosition;
    }
    if (failedUrl) {
        banner.dataset.dmFlairBannerFailedUrl = failedUrl;
        banner.dataset.dmFlairBannerFailedAt = String(Date.now());
    } else {
        delete banner.dataset.dmFlairBannerFailedUrl;
        delete banner.dataset.dmFlairBannerFailedAt;
    }
}

type ProfilePresentation = Pick<ProfileFlair,
    "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect"
>;

function applyBannerPresentation(banner: HTMLElement, flair?: ProfilePresentation) {
    if (flair?.bannerPosition) banner.dataset.dmFlairBannerPosition = flair.bannerPosition;
    else delete banner.dataset.dmFlairBannerPosition;
    if (flair?.bannerFit) banner.dataset.dmFlairBannerFit = flair.bannerFit;
    else delete banner.dataset.dmFlairBannerFit;
    if (flair?.mediaEffect && flair.mediaEffect !== "none") banner.dataset.dmFlairMediaEffect = flair.mediaEffect;
    else delete banner.dataset.dmFlairMediaEffect;
}

function applyBanner(banner: HTMLElement, url: string, userId: string, flair?: ProfilePresentation) {
    const ownerChanged = banner.dataset.dmFlairBannerUserId !== userId;
    if (ownerChanged && (banner.hasAttribute("data-dm-flair-banner-applied")
        || banner.hasAttribute("data-dm-flair-banner-loading-url")
        || banner.querySelector(".dm-flair-banner-video, .dm-flair-banner-image"))) {
        // Discord recycles the same banner node between profile popouts. Never
        // let the previous user's late GIF/video callback paint into the new
        // owner's profile.
        clearBanner(banner);
    }
    banner.dataset.dmFlairBannerUserId = userId;
    banner.dataset.dmFlairBannerOwnerId = userId;
    // Presentation is updated before the idempotency check so a tier upgrade or
    // a changed owner preference repaints the current media without refetching
    // the same GIF/video. Defaults remain Discordmaxxer's existing cover/center
    // rendering, so FREE media is never downgraded.
    applyBannerPresentation(banner, flair);
    const failedUrl = banner.dataset.dmFlairBannerFailedUrl;
    const failedAt = Number(banner.dataset.dmFlairBannerFailedAt ?? 0);
    const isVideo = isVideoUrl(url);
    const selector = isVideo ? ".dm-flair-banner-video" : ".dm-flair-banner-image";
    const appliedOverlay = banner.querySelector(selector);
    // Do not recreate a media element that is already visible or currently
    // loading. The observer runs frequently while a popout is opening.
    if (banner.dataset.dmFlairBannerAppliedUrl === url && appliedOverlay) return;
    if (banner.dataset.dmFlairBannerLoadingUrl === url) return;
    // Avoid recreating a known-dead media URL every 2s. Retry after a short
    // cooldown so a repaired remote asset can recover without a client restart.
    if (failedUrl === url && Date.now() - failedAt < 30_000) return;
    if (failedUrl && failedUrl !== url) {
        delete banner.dataset.dmFlairBannerFailedUrl;
        delete banner.dataset.dmFlairBannerFailedAt;
    }
    // If the source changed, keep the native banner visible until the new
    // media has loaded. This also removes an old overlay without touching
    // Discord's native <img>.
    if (banner.hasAttribute("data-dm-flair-banner-applied")
        || banner.hasAttribute("data-dm-flair-banner-loading-url")
        || banner.querySelector(".dm-flair-banner-video, .dm-flair-banner-image")) {
        clearBanner(banner);
    }
    if (!banner.hasAttribute("data-dm-flair-original-position")) {
        banner.dataset.dmFlairOriginalPosition = banner.style.position || "";
        if (!banner.style.position) banner.style.position = "relative";
    }

    banner.dataset.dmFlairBannerLoadingUrl = url;
    const finish = (media: HTMLVideoElement | HTMLImageElement) => {
        // A newer scan may have replaced or cleared this request. Never let a
        // late load from an old profile paint over the current native banner.
        if (banner.dataset.dmFlairBannerLoadingUrl !== url
            || banner.dataset.dmFlairBannerUserId !== userId) {
            media.remove();
            return;
        }
        delete banner.dataset.dmFlairBannerLoadingUrl;
        delete banner.dataset.dmFlairBannerFailedUrl;
        delete banner.dataset.dmFlairBannerFailedAt;
        media.style.opacity = "1";
        banner.dataset.dmFlairBannerAppliedUrl = url;
        banner.setAttribute("data-dm-flair-banner-applied", "1");
        if (media instanceof HTMLVideoElement) {
            observeBannerMedia(media);
            media.play().catch(() => {});
        }
    };
    const fail = () => {
        if (banner.dataset.dmFlairBannerLoadingUrl !== url
            || banner.dataset.dmFlairBannerUserId !== userId) return;
        console.warn("[DMProfileFlair] Remote banner could not be loaded; restored the native banner.", url);
        clearBanner(banner, url);
    };

    if (isVideo) {
        // Route videos through dm-media:// to bypass Chromium ORB for
        // arbitrary HTTPS MP4/WebM URLs. The native banner stays visible until
        // loadeddata proves that the replacement can actually render.
        const v = document.createElement("video");
        v.className = "dm-flair-banner-video";
        v.autoplay = true;
        v.loop = true;
        v.muted = true;
        v.playsInline = true;
        v.onloadeddata = () => finish(v);
        v.onerror = fail;
        banner.appendChild(v);
        observeBannerMedia(v);
        v.src = proxyVideoUrl(url);
        v.play().catch(() => {});
        return;
    }

    // Use an actual <img> instead of a CSS background. This gives extensionless
    // worker-hosted GIFs a real load/error lifecycle and preserves animation;
    // the old background-image path hid the native banner without knowing
    // whether the GIF had loaded.
    const image = document.createElement("img");
    image.className = "dm-flair-banner-image";
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    image.decoding = "async";
    image.onload = () => finish(image);
    image.onerror = fail;
    banner.appendChild(image);
    image.src = url;
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

function applyTheme(container: HTMLElement, primary?: string, secondary?: string, ownerId?: string) {
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
    if (ownerId) container.dataset.dmFlairThemeOwnerId = ownerId;
}

function clearTheme(container: HTMLElement) {
    if (!container.hasAttribute("data-dm-flair-theme-applied")
        && !container.dataset.dmFlairThemeOwnerId) return;
    container.style.removeProperty("background-image");
    container.style.removeProperty("background-color");
    container.style.removeProperty("--profile-gradient-primary-color");
    container.style.removeProperty("--profile-gradient-secondary-color");
    container.style.removeProperty("--profile-body-background-color");
    container.removeAttribute("data-dm-flair-theme-applied");
    delete container.dataset.dmFlairThemeOwnerId;
}

function applyAvatarPresentation(avatar: HTMLImageElement, flair?: ProfilePresentation) {
    if (flair?.avatarPosition) avatar.dataset.dmFlairAvatarPosition = flair.avatarPosition;
    else delete avatar.dataset.dmFlairAvatarPosition;
    if (flair?.avatarFit) avatar.dataset.dmFlairAvatarFit = flair.avatarFit;
    else delete avatar.dataset.dmFlairAvatarFit;
    if (flair?.avatarScale) avatar.dataset.dmFlairAvatarScale = flair.avatarScale;
    else delete avatar.dataset.dmFlairAvatarScale;
    if (flair?.mediaEffect && flair.mediaEffect !== "none") avatar.dataset.dmFlairAvatarEffect = flair.mediaEffect;
    else delete avatar.dataset.dmFlairAvatarEffect;
}

function clearAvatar(avatar: HTMLImageElement) {
    const hadState = avatar.hasAttribute("data-dm-flair-avatar-applied")
        || Boolean(avatar.dataset.dmFlairLoadingUrl)
        || Boolean(avatar.dataset.dmFlairOriginalSrc);
    if (!hadState) return;
    delete avatar.dataset.dmFlairLoadingUrl;
    delete avatar.dataset.dmFlairAppliedUrl;
    delete avatar.dataset.dmFlairFailedUrl;
    delete avatar.dataset.dmFlairAvatarUserId;
    delete avatar.dataset.dmFlairAvatarPosition;
    delete avatar.dataset.dmFlairAvatarFit;
    delete avatar.dataset.dmFlairAvatarScale;
    delete avatar.dataset.dmFlairAvatarEffect;
    avatar.removeAttribute("data-dm-flair-avatar-applied");
    avatar.onerror = null;
    const original = avatar.dataset.dmFlairOriginalSrc;
    delete avatar.dataset.dmFlairOriginalSrc;
    if (original && avatar.src !== original) avatar.src = original;
}

function applyAvatar(avatar: HTMLImageElement, url: string, userId?: string, flair?: ProfilePresentation) {
    applyAvatarPresentation(avatar, flair);
    // Idempotency MUST compare against the URL we last applied (stashed on the
    // element), NOT against `avatar.src`. The browser normalizes/encodes the
    // src it reads back (dm-media:// scheme, percent-encoding, trailing
    // normalization), so `avatar.src !== url` is almost always true even on
    // the very next scan — which re-assigns src → triggers an image reload →
    // emits a mutation → wakes the observer → re-scans → re-assigns... a
    // self-sustaining CPU/network loop for as long as the avatar is on screen.
    const nativeSourceReturned = /\/avatars\/\d{17,20}\//.test(avatar.currentSrc || avatar.src || "");
    if (avatar.dataset.dmFlairAppliedUrl === url && !nativeSourceReturned) return;
    if (avatar.dataset.dmFlairLoadingUrl === url) return;
    // Already proven dead this session — don't reapply a URL that 404s / serves
    // a host's "removed" stub (e.g. a deleted imgur link returns a 503-byte
    // image/png egg). Reapplying would just flash the broken icon every scan.
    if (avatar.dataset.dmFlairFailedUrl === url) return;
    // Stash the original src so we can restore on plugin stop / setting change.
    if (!avatar.dataset.dmFlairOriginalSrc) {
        avatar.dataset.dmFlairOriginalSrc = avatar.src;
    }
    // Probe off-DOM first. Swapping the real <img> only after onload keeps the
    // native avatar visible while the GIF is fetching and removes the normal-
    // avatar flicker reported when opening another user's profile.
    avatar.dataset.dmFlairLoadingUrl = url;
    const probe = document.createElement("img");
    probe.decoding = "async";
    probe.onload = () => {
        if (avatar.dataset.dmFlairLoadingUrl !== url) return;
        delete avatar.dataset.dmFlairLoadingUrl;
        avatar.onerror = () => {
            avatar.onerror = null;
            avatar.dataset.dmFlairFailedUrl = url;
            delete avatar.dataset.dmFlairAppliedUrl;
            const orig = avatar.dataset.dmFlairOriginalSrc;
            if (orig && avatar.src !== orig) avatar.src = orig;
        };
        avatar.src = url;
        avatar.dataset.dmFlairAppliedUrl = url;
        if (userId) avatar.dataset.dmFlairAvatarUserId = userId;
        avatar.setAttribute("data-dm-flair-avatar-applied", "1");
    };
    probe.onerror = () => {
        if (avatar.dataset.dmFlairLoadingUrl !== url) return;
        delete avatar.dataset.dmFlairLoadingUrl;
        avatar.dataset.dmFlairFailedUrl = url;
        console.warn("[DMProfileFlair] Remote avatar could not be loaded; kept the native avatar.", url);
    };
    probe.src = url;
}

function clearBackgroundAvatar(el: HTMLElement) {
    if (!el.hasAttribute("data-dm-flair-bg-avatar-applied") && !el.dataset.dmFlairOriginalBg) return;
    const original = el.dataset.dmFlairOriginalBg ?? "";
    if (original) el.style.setProperty("background-image", original, "important");
    else el.style.removeProperty("background-image");
    delete el.dataset.dmFlairOriginalBg;
    delete el.dataset.dmFlairAppliedUrl;
    delete el.dataset.dmFlairAvatarUserId;
    delete el.dataset.dmFlairAvatarPosition;
    delete el.dataset.dmFlairAvatarFit;
    delete el.dataset.dmFlairAvatarScale;
    delete el.dataset.dmFlairAvatarEffect;
    el.removeAttribute("data-dm-flair-bg-avatar-applied");
}

function applyBackgroundAvatarPresentation(el: HTMLElement, flair?: ProfilePresentation) {
    if (flair?.avatarPosition) el.dataset.dmFlairAvatarPosition = flair.avatarPosition;
    else delete el.dataset.dmFlairAvatarPosition;
    if (flair?.avatarFit) el.dataset.dmFlairAvatarFit = flair.avatarFit;
    else delete el.dataset.dmFlairAvatarFit;
    if (flair?.avatarScale) el.dataset.dmFlairAvatarScale = flair.avatarScale;
    else delete el.dataset.dmFlairAvatarScale;
    if (flair?.mediaEffect && flair.mediaEffect !== "none") el.dataset.dmFlairAvatarEffect = flair.mediaEffect;
    else delete el.dataset.dmFlairAvatarEffect;
}

function applyBackgroundAvatar(el: HTMLElement, url: string, userId?: string, flair?: ProfilePresentation) {
    applyBackgroundAvatarPresentation(el, flair);
    const newBg = `url("${url}")`;
    if (el.dataset.dmFlairAppliedUrl === url) {
        if (userId) el.dataset.dmFlairAvatarUserId = userId;
        return;
    }
    if (!el.dataset.dmFlairOriginalBg) {
        el.dataset.dmFlairOriginalBg = el.style.backgroundImage || "";
    }
    if (userId) el.dataset.dmFlairAvatarUserId = userId;
    el.dataset.dmFlairAppliedUrl = url;
    el.style.setProperty("background-image", newBg, "important");
    el.setAttribute("data-dm-flair-bg-avatar-applied", "1");
}

function clearAppliedAvatars() {
    document.querySelectorAll<HTMLImageElement>("[data-dm-flair-avatar-applied], [data-dm-flair-loading-url]").forEach(clearAvatar);
    document.querySelectorAll<HTMLElement>("[data-dm-flair-bg-avatar-applied]").forEach(clearBackgroundAvatar);
}

function scanForPopouts(_root: ParentNode = document) {
    const me = UserStore.getCurrentUser?.();
    const tmActive = isTournamentModeActive();
    const rosterReady = isRosterReady();

    // ── Banner + theme (per-popout: identify whose popout, look up their flair) ──
    const banners = findAllProfileBanners();

    for (const banner of banners) {
        const container = findProfileContainerFromBanner(banner);
        if (!container) {
            // Discord can mount the banner shell before its profile container.
            // Leave any already-applied owner decoration in place until the
            // next observer pass can identify the new surface.
            continue;
        }
        // Identify whose popout this is by extracting userId from an avatar
        // img inside (CDN `/avatars/<id>/` URL). We deliberately do NOT fall
        // back to the current user's id when that fails: a target on a DEFAULT
        // Discord avatar yields no CDN id, and the old "no id = me" assumption
        // painted OUR banner + gradient onto THEIR popout — a real flair-leak
        // bug. No id → skip banner/theme for this container. Self-preview still
        // works in the common case because flair users have a custom avatar
        // (the member-list/chat swap requires one anyway), so the lookup
        // returns their real id.
        const userId = getUserIdFromContainer(container);
        if (!userId) {
            // Identity is briefly unavailable while Discord commits the avatar
            // and profile data. Clearing here caused the native banner and
            // default gradient to flash before the same scan could recover.
            // Once identity is available, the normal owner lookup below will
            // clear decorations that do not belong to the new profile.
            continue;
        }

        // Give DMWidget an authoritative owner marker on the profile shell.
        // Banner/theme markers are not guaranteed to exist when a user has
        // only widget flair, so relying on those made foreign cards fall back
        // to the viewer's style or appear unskinned during hydration.
        container.dataset.dmFlairProfileOwnerId = userId;

        // A remote roster refresh is asynchronous. Keep the last known
        // decoration for other users until the replacement response arrives;
        // self-preview can still use its local fields immediately.
        if (!rosterReady && String(me?.id ?? "") !== userId) continue;

        const bannerFlair = resolveFlairForUserId(userId, "banner");
        if (bannerFlair?.bannerUrl) {
            const suppressForTM = tmActive && isAnimatedUrl(bannerFlair.bannerUrl);
            if (!suppressForTM) applyBanner(banner, bannerFlair.bannerUrl, userId, bannerFlair);
            else {
                clearBanner(banner);
            }
        } else {
            clearBanner(banner);
        }

        const themeFlair = resolveFlairForUserId(userId, "theme");
        if (themeFlair?.themeColorPrimary || themeFlair?.themeColorSecondary) {
            applyTheme(container, themeFlair.themeColorPrimary, themeFlair.themeColorSecondary, userId);
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
    const selfId = String(me?.id ?? "");
    const selfHasAvatarFlair = !!sa.myAvatarAnimatedUrl.trim()
        || (!!selfId && !!getRosterProfileFlair(selfId)?.avatarAnimatedUrl);
    const othersAvatarFlair =
        rosterReady && sa.showOthersFlair && sa.showOthersAvatar && rosterHasAnyAvatarFlair();
    const anyAvatarFlair = selfHasAvatarFlair || othersAvatarFlair;

    if (!tmActive && anyAvatarFlair) {
        document.querySelectorAll("img").forEach(img => {
            const el = img as HTMLImageElement;
            const src = el.currentSrc || el.src || "";
            const m = src.match(/\/avatars\/(\d{17,20})\//);
            // Once a flair URL has replaced the native Discord source, keep
            // using the owner id stashed on the element. Without this, the
            // next scan cannot identify the image and a viewer's own flair
            // can be mistaken for the profile being viewed.
            const userId = m?.[1] ?? el.dataset.dmFlairAvatarUserId;
            if (!userId) return;
            if (!rosterReady && String(me?.id ?? "") !== userId) return;
            const avatarFlair = resolveFlairForUserId(userId, "avatar");
            if (avatarFlair?.avatarAnimatedUrl) {
                applyAvatar(el, avatarFlair.avatarAnimatedUrl, userId, avatarFlair);
            } else {
                clearAvatar(el);
            }
        });
        // Background-image avatar tiles — some call surfaces (notably the
        // "no video, big circle avatar" user tile in the main call view, and
        // certain Stage/voice-party variants) render the avatar as a
        // <div style="background-image: url(...avatars/<userId>/...)"> rather
        // than as an <img>. Scan every element with an inline backgroundImage
        // that matches the avatar CDN pattern and override the URL.
        document.querySelectorAll<HTMLElement>('[style*="/avatars/"], [data-dm-flair-bg-avatar-applied]').forEach(el => {
            const bg = el.style.backgroundImage;
            if (!bg) return;
            const m = bg.match(/\/avatars\/(\d{17,20})\//);
            const userId = m?.[1] ?? el.dataset.dmFlairAvatarUserId;
            if (!userId) return;
            if (!rosterReady && String(me?.id ?? "") !== userId) return;
            const avatarFlair = resolveFlairForUserId(userId, "avatar");
            if (avatarFlair?.avatarAnimatedUrl) {
                applyBackgroundAvatar(el, avatarFlair.avatarAnimatedUrl, userId, avatarFlair);
            } else {
                clearBackgroundAvatar(el);
            }
        });
        // Profile-view fallback: large avatars (≥60px) that don't have a CDN
        // URL we could match (default-avatar users). If we're viewing our own
        // popout in self-preview, swap those too.
        const fallback = findProfileViewAvatars();
        for (const a of fallback) {
            const container = findProfileContainerFromBanner(a as any) ?? a.closest('[class*="user-profile-popout"]') ?? a.parentElement;
            const userId = container ? getUserIdFromContainer(container) : null;
            if (!rosterReady && String(me?.id ?? "") !== String(userId ?? "")) continue;
            const flair = resolveFlairForUserId(userId, "avatar");
            if (flair?.avatarAnimatedUrl) applyAvatar(a, flair.avatarAnimatedUrl, userId ?? undefined, flair);
            else clearAvatar(a);
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
    } else if (rosterReady || tmActive) {
        // Clear swaps when TournamentMode is active or the roster/viewer
        // toggle no longer exposes any avatar flair. This also prevents an
        // old remote avatar from remaining visible after a profile change.
        clearAppliedAvatars();
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
    if (document.hidden || scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
        scanScheduled = false;
        scanForPopouts(document);
    });
}

function startObserver() {
    if (observer) return;
    if (typeof IntersectionObserver !== "undefined") {
        mediaPlaybackObserver = new IntersectionObserver(entries => {
            if (document.hidden) return;
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const video = entry.target as HTMLVideoElement;
                if (video instanceof HTMLVideoElement) video.play().catch(() => {});
            }
        }, { threshold: 0.01 });
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onRosterFocus);
    removeRosterListener = onRosterChange(scheduleScan);
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    scanForPopouts(document);
    // Low-frequency safety net for changes the childList observer can't see
    // (e.g. an <img src> swapped in place). 2s is plenty for animated-avatar
    // surfaces and halves the steady-state polling cost vs the old 1s.
    rescanTimer = window.setInterval(() => scanForPopouts(document), 2000);
    refreshRosterForVisibleSurface();
    scheduleProfileMediaSync();
}

function stopObserver() {
    removeRosterListener?.();
    removeRosterListener = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onRosterFocus);
    lastRosterRefreshAt = 0;
    observer?.disconnect();
    observer = null;
    mediaPlaybackObserver?.disconnect();
    mediaPlaybackObserver = null;
    if (rescanTimer !== null) { clearInterval(rescanTimer); rescanTimer = null; }
    if (profileMediaSyncTimer !== null) { clearTimeout(profileMediaSyncTimer); profileMediaSyncTimer = null; }
    document.querySelectorAll("[data-dm-flair-banner-applied]").forEach(el => {
        const e = el as HTMLElement;
        e.removeAttribute("data-dm-flair-banner-applied");
        delete e.dataset.dmFlairBannerUserId;
        delete e.dataset.dmFlairBannerOwnerId;
        delete e.dataset.dmFlairBannerAppliedUrl;
        delete e.dataset.dmFlairBannerLoadingUrl;
        delete e.dataset.dmFlairBannerPosition;
        delete e.dataset.dmFlairBannerFit;
        delete e.dataset.dmFlairMediaEffect;
        if (e.hasAttribute("data-dm-flair-original-position")) {
            const originalPosition = e.dataset.dmFlairOriginalPosition ?? "";
            if (originalPosition) e.style.position = originalPosition;
            else e.style.removeProperty("position");
            delete e.dataset.dmFlairOriginalPosition;
        }
    });
    // A pending load may not have set the applied marker yet. Clear its
    // marker before removing the overlay so a late image/video callback cannot
    // paint after the plugin has been stopped.
    document.querySelectorAll<HTMLElement>("[data-dm-flair-banner-loading-url]").forEach(el => {
        delete el.dataset.dmFlairBannerLoadingUrl;
        delete el.dataset.dmFlairBannerAppliedUrl;
        delete el.dataset.dmFlairBannerUserId;
        delete el.dataset.dmFlairBannerOwnerId;
        delete el.dataset.dmFlairBannerPosition;
        delete el.dataset.dmFlairBannerFit;
        delete el.dataset.dmFlairMediaEffect;
        if (el.hasAttribute("data-dm-flair-original-position")) {
            const originalPosition = el.dataset.dmFlairOriginalPosition ?? "";
            if (originalPosition) el.style.position = originalPosition;
            else el.style.removeProperty("position");
            delete el.dataset.dmFlairOriginalPosition;
        }
    });
    document.querySelectorAll("[data-dm-flair-theme-applied]").forEach(el => {
        const e = el as HTMLElement;
        e.style.removeProperty("background-image");
        e.style.removeProperty("background-color");
        e.style.removeProperty("--profile-gradient-primary-color");
        e.style.removeProperty("--profile-gradient-secondary-color");
        e.style.removeProperty("--profile-body-background-color");
        e.removeAttribute("data-dm-flair-theme-applied");
        delete e.dataset.dmFlairThemeOwnerId;
    });
    document.querySelectorAll<HTMLElement>("[data-dm-flair-profile-owner-id]").forEach(el => {
        delete el.dataset.dmFlairProfileOwnerId;
    });
    // Restore original avatar src/backgrounds and remove owner presentation
    // attributes so toggling the plugin off + on cannot leave stale media or
    // a previous user's crop/effect on the next profile.
    clearAppliedAvatars();
    document.querySelectorAll(".dm-flair-banner-video, .dm-flair-banner-image").forEach(v => v.remove());
    document.querySelectorAll<HTMLElement>("[data-dm-flair-loading-url]").forEach(el => {
        delete el.dataset.dmFlairLoadingUrl;
    });
}

export default definePlugin({
    name: "DMProfileFlair",
    description:
        "Custom profile banner / animated avatar / theme colors, visible only to other Discordmaxxer users. " +
        "Free showcase fields with server-side roster validation. Animated content auto-suppresses when TournamentMode is on.",
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

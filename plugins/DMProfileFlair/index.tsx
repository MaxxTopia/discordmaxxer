/*
 * Discordmaxxer — DMProfileFlair plugin (Channels E, F, G)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * User-set custom profile flair, visible only to other Discordmaxxer clients
 * (same architecture as DiscordmaxxerBadge Channel A — fetched from the public
 * tier roster, rendered client-side, vanilla Discord never sees it). The
 * settings panel keeps the shared roster path separate from the optional,
 * one-click native Discord profile PATCH helpers. Stock Discord cannot render
 * roster-only fields in a profile, so the editor does not pretend a copied
 * chat message is a profile integration.
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
import * as DataStore from "@api/DataStore";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Button, React, RestAPI, Toasts, UserStore } from "@webpack/common";

import { makePersistentValue } from "../_dm-shared/persist";
import { getRosterProfileFlair, isRosterReady, onRosterChange, ProfileFlair, refreshRoster, rosterHasAnyAvatarFlair } from "../_dm-shared/roster";
import { getMyTier, Tier } from "../_dm-shared/vip";
import { activateFreeProfile, getMyHwid, normalizeCode, readBinding, reserveFreeActivationWindow } from "../_dm-shared/vipClaim";

const WORKER_PROFILE_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile";
const WORKER_PROFILE_MEDIA_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/profile-media";
type FlairMediaKind = "banner" | "avatar";

const PROFILE_LOCAL_MEDIA_KEYS = {
    banner: "dm-profile-flair-local-banner",
    avatar: "dm-profile-flair-local-avatar"
} as const;
const MAX_PROFILE_LOCAL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROFILE_LOCAL_VIDEO_BYTES = 15 * 1024 * 1024;
const MAX_PROFILE_MEDIA_DURATION_SECONDS = 20;
const MAX_PROFILE_MEDIA_DIMENSION = 4096;
const MAX_PROFILE_AVATAR_DIMENSION = 2048;
const MAX_PROFILE_STATIC_OPTIMIZE_INPUT_BYTES = 40 * 1024 * 1024;
const OPTIMIZABLE_PROFILE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

interface ProfileMediaMetadata {
    mime: string;
    bytes: number;
    width?: number;
    height?: number;
    duration?: number;
}

interface LocalProfileMedia {
    url: string;
    fileName: string;
    mime: string;
    file?: File;
    metadata?: ProfileMediaMetadata;
    error?: string;
}

const localProfileMedia: Record<FlairMediaKind, LocalProfileMedia> = {
    banner: { url: "", fileName: "", mime: "" },
    avatar: { url: "", fileName: "", mime: "" }
};
const localProfileMediaListeners = new Set<() => void>();
let localProfileMediaHydration: Promise<void> | null = null;

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
    mediaEffect: Tier.MAXXER_PLUS_PLUS,
    mediaSpeed: Tier.MAXXER_PLUS
};

const URL_RE = /^https:\/\/[^\s]{1,250}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PROFILE_POSITION_VALUES = new Set<NonNullable<ProfileFlair["bannerPosition"]>>(["center", "top", "bottom"]);
const PROFILE_FIT_VALUES = new Set<NonNullable<ProfileFlair["bannerFit"]>>(["cover", "contain"]);
const PROFILE_SCALE_VALUES = new Set<NonNullable<ProfileFlair["avatarScale"]>>(["0.9", "1", "1.1"]);
const PROFILE_EFFECT_VALUES = new Set<NonNullable<ProfileFlair["mediaEffect"]>>(["none", "glow", "scanline"]);
const PROFILE_SPEED_VALUES = new Set<NonNullable<ProfileFlair["mediaSpeed"]>>(["0.75", "1", "1.25", "1.5"]);

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
const SPEED_OPTIONS: Array<{ value: NonNullable<ProfileFlair["mediaSpeed"]>; label: string }> = [
    { value: "0.75", label: "75% · slow" },
    { value: "1", label: "100% · normal" },
    { value: "1.25", label: "125% · quick" },
    { value: "1.5", label: "150% · fast" }
];

function isLegacyProfileMediaUrl(value: string): boolean {
    // Older builds stored the worker's collection route without /banner or
    // /avatar. It is a JSON/media lookup route, not a playable file, so never
    // let it keep winning over the current roster value.
    return /\/profile-media\/[^/?#]+\/?$/i.test(value.trim());
}

/** True for the current Worker-owned media file route. These URLs are valid
 * direct media URLs, but keeping them as a renderer-side HTTPS source is
 * fragile in the Discord/Electron renderer: an extensionless GIF/video can
 * be classified by Chromium's media loader before CORS/content sniffing has
 * completed. The main-process dm-media proxy already preserves the upstream
 * Content-Type and gives the preview a same-origin, reliable source. */
function isSharedProfileMediaUrl(value: string): boolean {
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === "https:" &&
            parsed.hostname === "optmaxxing-vip.maxxtopia.workers.dev" &&
            /^\/profile-media\/[^/?#]+\/(?:banner|avatar)\/[0-9a-f-]{36}$/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

// Settings are persisted locally, so a value left over from an older account
// or an earlier device must not silently override the shared roster forever.
// Only fields the user has actively edited in this editor session are local
// drafts. Once Save succeeds and the roster is refreshed, the worker becomes
// the source of truth again. This is what lets another PC converge on the
// same banner, avatar, and gradient without changing the media itself.
const flairDraftFields = new Set<string>();

function markFlairDraftField(field: string): void {
    flairDraftFields.add(field);
}

function clearFlairDraftFields(): void {
    flairDraftFields.clear();
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

/** Merge only active self-preview drafts without letting stale local settings
 * bypass the current tier. The worker applies the same rule to the shared
 * roster, but this client-side guard keeps a downgraded account honest before
 * its next roster refresh too. Free users retain the base media and colors;
 * only the optional presentation controls are removed when they are not
 * entitled. */
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
        if (flairDraftFields.has("myMediaSpeed")) {
            const mediaSpeed = String(s.myMediaSpeed ?? "").trim();
            if (mediaSpeed) merged.mediaSpeed = mediaSpeed as ProfileFlair["mediaSpeed"];
            else delete merged.mediaSpeed;
        }
    } else {
        delete merged.bannerFit;
        delete merged.avatarFit;
        delete merged.avatarScale;
        delete merged.mediaSpeed;
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

function notifyLocalProfileMediaListeners(): void {
    localProfileMediaListeners.forEach(listener => listener());
}

function isAcceptedLocalProfileFile(kind: FlairMediaKind, file: File): boolean {
    const mime = getLocalProfileMediaMime(file);
    if (kind === "avatar") {
        return ["image/gif", "image/apng", "image/png", "image/jpeg", "image/webp"].includes(mime);
    }
    return ["image/gif", "image/apng", "image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "video/quicktime"].includes(mime);
}

function getLocalProfileMediaMime(file: File): string {
    const declared = file.type.trim().toLowerCase();
    if (declared && declared !== "application/octet-stream") return declared;
    const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return ({
        apng: "image/apng",
        gif: "image/gif",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime"
    } as Record<string, string>)[extension ?? ""] ?? declared;
}

function isLocalVideoFile(file: File): boolean {
    return getLocalProfileMediaMime(file).startsWith("video/");
}

function maxLocalProfileMediaBytes(file: File): number {
    return isLocalVideoFile(file) ? MAX_PROFILE_LOCAL_VIDEO_BYTES : MAX_PROFILE_LOCAL_IMAGE_BYTES;
}

function formatMediaBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "size unknown";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMediaDetails(metadata?: ProfileMediaMetadata): string {
    if (!metadata) return "";
    const details = [formatMediaBytes(metadata.bytes)];
    if (metadata.width && metadata.height) details.push(`${metadata.width}×${metadata.height}`);
    if (metadata.duration && Number.isFinite(metadata.duration)) details.push(`${metadata.duration.toFixed(1)}s`);
    return details.join(" · ");
}

function localProfileMediaTypeError(kind: FlairMediaKind, file: File): string | null {
    if (!isAcceptedLocalProfileFile(kind, file)) {
        return kind === "avatar"
            ? "Choose a PNG, JPG, WebP, GIF, or APNG avatar file."
            : "Choose a PNG, JPG, WebP, GIF, APNG, MP4, WEBM, or MOV banner file.";
    }
    return null;
}

function localProfileMediaError(kind: FlairMediaKind, file: File): string | null {
    const typeError = localProfileMediaTypeError(kind, file);
    if (typeError) return typeError;
    const maxBytes = maxLocalProfileMediaBytes(file);
    if (file.size > maxBytes) {
        return `That local ${kind} is over ${isLocalVideoFile(file) ? "15 MB" : "5 MB"}. Choose a smaller file.`;
    }
    return null;
}

function readLocalProfileMediaMetadata(kind: FlairMediaKind, file: File): Promise<ProfileMediaMetadata> {
    const objectUrl = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, metadata?: ProfileMediaMetadata) => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(objectUrl);
            error ? reject(error) : resolve(metadata ?? { mime: getLocalProfileMediaMime(file), bytes: file.size });
        };
        if (isLocalVideoFile(file)) {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.onloadedmetadata = () => {
                const width = video.videoWidth;
                const height = video.videoHeight;
                const duration = video.duration;
                finish(undefined, {
                    mime: getLocalProfileMediaMime(file),
                    bytes: file.size,
                    width,
                    height,
                    ...(Number.isFinite(duration) ? { duration } : {})
                });
            };
            video.onerror = () => finish(new Error("Discordmaxxer could not read that video. Try MP4 or WebM with a valid media track."));
            video.src = objectUrl;
            return;
        }
        const image = new Image();
        image.onload = () => {
            finish(undefined, {
                mime: getLocalProfileMediaMime(file),
                bytes: file.size,
                width: image.naturalWidth,
                height: image.naturalHeight
            });
        };
        image.onerror = () => finish(new Error(`Discordmaxxer could not read that ${kind} image. Try PNG, JPG, WebP, or GIF.`));
        image.src = objectUrl;
    });
}

function inspectLocalProfileMedia(kind: FlairMediaKind, file: File): Promise<ProfileMediaMetadata> {
    return readLocalProfileMediaMetadata(kind, file).then(metadata => {
        const maxDimension = kind === "avatar" ? MAX_PROFILE_AVATAR_DIMENSION : MAX_PROFILE_MEDIA_DIMENSION;
        if ((metadata.width ?? 0) > maxDimension || (metadata.height ?? 0) > maxDimension) {
            throw new Error(`That ${kind} is ${metadata.width}×${metadata.height}. The maximum is ${maxDimension}×${maxDimension}.`);
        }
        if ((metadata.duration ?? 0) > MAX_PROFILE_MEDIA_DURATION_SECONDS) {
            throw new Error(`That ${kind} is ${Math.ceil(metadata.duration ?? 0)} seconds long. Keep animated banners to ${MAX_PROFILE_MEDIA_DURATION_SECONDS} seconds or less.`);
        }
        return metadata;
    });
}

function isOptimizableProfileImage(file: File): boolean {
    return OPTIMIZABLE_PROFILE_IMAGE_MIMES.has(getLocalProfileMediaMime(file));
}

function optimizeRasterProfileImage(kind: FlairMediaKind, file: File): Promise<File> {
    if (!isOptimizableProfileImage(file)) {
        return Promise.reject(new Error("Animated GIFs and videos cannot be compressed in the client yet. Choose a smaller animated file."));
    }
    if (file.size > MAX_PROFILE_STATIC_OPTIMIZE_INPUT_BYTES) {
        return Promise.reject(new Error("That image is too large to optimize safely in the client. Choose an image under 40 MB."));
    }
    const objectUrl = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
        const image = new Image();
        let settled = false;
        const finish = (error?: Error, output?: File) => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(objectUrl);
            error ? reject(error) : output ? resolve(output) : reject(new Error("Could not optimize that image."));
        };
        image.onload = () => {
            const maxDimension = kind === "avatar" ? MAX_PROFILE_AVATAR_DIMENSION : MAX_PROFILE_MEDIA_DIMENSION;
            const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const context = canvas.getContext("2d");
            if (!context) {
                finish(new Error("Your browser could not prepare that image for upload."));
                return;
            }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const qualities = [0.9, 0.78, 0.64, 0.5];
            const attempt = (index: number) => {
                canvas.toBlob(blob => {
                    if (!blob) {
                        finish(new Error("Your browser could not optimize that image."));
                        return;
                    }
                    const outputName = file.name.replace(/\.[^.]+$/, "") || `${kind}-optimized`;
                    const output = new File([blob], `${outputName}.webp`, {
                        type: "image/webp",
                        lastModified: file.lastModified || Date.now()
                    });
                    if (output.size <= MAX_PROFILE_LOCAL_IMAGE_BYTES || index === qualities.length - 1) {
                        finish(undefined, output);
                        return;
                    }
                    attempt(index + 1);
                }, "image/webp", qualities[index]);
            };
            attempt(0);
        };
        image.onerror = () => finish(new Error(`Discordmaxxer could not read that ${kind} image.`));
        image.src = objectUrl;
    });
}

function getLocalProfileMedia(kind: FlairMediaKind): LocalProfileMedia {
    return localProfileMedia[kind];
}

async function hydrateLocalProfileMedia(): Promise<void> {
    if (localProfileMediaHydration) return localProfileMediaHydration;
    localProfileMediaHydration = Promise.all((Object.keys(PROFILE_LOCAL_MEDIA_KEYS) as FlairMediaKind[]).map(async kind => {
        try {
            const value = await DataStore.get<Blob>(PROFILE_LOCAL_MEDIA_KEYS[kind]);
            if (!(value instanceof Blob)) return;
            const sourceFile = value instanceof File
                ? value
                : new File([value], `${kind}-local-media`, { type: value.type || "application/octet-stream" });
            const mime = getLocalProfileMediaMime(sourceFile);
            const file = value instanceof File
                ? new File([value], value.name, { type: mime })
                : new File([value], `${kind}-local-media`, { type: mime });
            const error = localProfileMediaError(kind, file);
            if (error) return;
            const metadata = await inspectLocalProfileMedia(kind, file);
            const url = URL.createObjectURL(file);
            localProfileMedia[kind] = {
                url,
                fileName: String(file.name || `${kind}-local-media`),
                mime,
                file,
                metadata,
                error: undefined
            };
        } catch (error) {
            console.warn(`[DMProfileFlair] could not restore local ${kind}:`, error);
        }
    })).then(() => notifyLocalProfileMediaListeners());
    return localProfileMediaHydration;
}

async function saveLocalProfileMedia(kind: FlairMediaKind, file: File, metadata?: ProfileMediaMetadata): Promise<void> {
    const error = localProfileMediaError(kind, file);
    if (error) throw new Error(error);
    const inspected = metadata ?? await inspectLocalProfileMedia(kind, file);
    const previous = localProfileMedia[kind].url;
    if (previous) URL.revokeObjectURL(previous);
    localProfileMedia[kind] = {
        url: URL.createObjectURL(file),
        fileName: file.name,
        mime: getLocalProfileMediaMime(file),
        file,
        metadata: inspected,
        error: undefined
    };
    notifyLocalProfileMediaListeners();
    try {
        await DataStore.set(PROFILE_LOCAL_MEDIA_KEYS[kind], new File([file], file.name, { type: getLocalProfileMediaMime(file) }));
    } catch (error) {
        console.warn(`[DMProfileFlair] could not persist local ${kind}:`, error);
        toast(`Local ${kind} preview loaded for this session, but Discordmaxxer could not remember the file.`, Toasts.Type.MESSAGE, 5000);
    }
}

async function clearLocalProfileMedia(kind: FlairMediaKind): Promise<void> {
    const previous = localProfileMedia[kind].url;
    if (previous) URL.revokeObjectURL(previous);
    localProfileMedia[kind] = { url: "", fileName: "", mime: "" };
    notifyLocalProfileMediaListeners();
    try {
        await DataStore.del(PROFILE_LOCAL_MEDIA_KEYS[kind]);
    } catch (error) {
        console.warn(`[DMProfileFlair] could not remove local ${kind}:`, error);
    }
}

function setLocalProfileMediaError(kind: FlairMediaKind, error: string | undefined): void {
    localProfileMedia[kind].error = error;
    notifyLocalProfileMediaListeners();
}

function readFileAsDataUri(file: File, onProgress?: (percent: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = event => {
            if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 35));
        };
        reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            if (result.startsWith("data:")) resolve(result);
            else reject(new Error("Could not read the selected file."));
        };
        reader.onerror = () => reject(new Error("Could not read the selected file."));
        reader.onabort = () => reject(new Error("Reading the selected file was cancelled."));
        reader.readAsDataURL(file);
    });
}

function drawVideoPosterFromFile(file: File): Promise<string | undefined> {
    const blobUrl = URL.createObjectURL(file);
    return new Promise(resolve => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        let settled = false;
        const finish = (poster?: string) => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(blobUrl);
            resolve(poster);
        };
        video.onloadeddata = () => {
            try {
                const maxWidth = 960;
                const ratio = video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round((video.videoWidth || 640) * ratio));
                canvas.height = Math.max(1, Math.round((video.videoHeight || 360) * ratio));
                const context = canvas.getContext("2d");
                if (!context) return finish();
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                finish(canvas.toDataURL("image/jpeg", 0.82));
            } catch (error) {
                console.warn("[DMProfileFlair] local video poster generation failed:", error);
                finish();
            }
        };
        video.onerror = () => finish();
        window.setTimeout(() => finish(), 10000);
        video.src = blobUrl;
    });
}

function waitForUploadRetry(delayMs: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, delayMs));
}

interface UploadedProfileMedia {
    url: string;
    posterUrl?: string;
    mime: string;
    bytes: number;
    metadata?: ProfileMediaMetadata;
}

async function uploadProfileMedia(
    kind: FlairMediaKind,
    file: File,
    claimCode: string,
    onProgress?: (percent: number) => void
): Promise<UploadedProfileMedia> {
    const localError = localProfileMediaError(kind, file);
    if (localError) throw new Error(localError);
    await inspectLocalProfileMedia(kind, file);
    onProgress?.(5);
    const dataUri = await readFileAsDataUri(file, percent => onProgress?.(percent));
    const posterDataUri = kind === "banner" && isLocalVideoFile(file)
        ? await drawVideoPosterFromFile(file)
        : undefined;
    onProgress?.(40);
    const me = UserStore.getCurrentUser?.();
    if (!me?.id) throw new Error("Could not read your Discord user ID for the upload.");
    const requestBody = JSON.stringify({
        userId: me.id,
        claimCode,
        kind,
        mime: getLocalProfileMediaMime(file),
        dataUri,
        ...(posterDataUri ? { posterDataUri } : {})
    });
    let lastError = "upload failed";
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const result = await new Promise<UploadedProfileMedia>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("POST", WORKER_PROFILE_MEDIA_URL);
                xhr.timeout = 120_000;
                xhr.setRequestHeader("content-type", "application/json");
                xhr.upload.onprogress = event => {
                    if (event.lengthComputable) onProgress?.(40 + Math.round((event.loaded / event.total) * 60));
                };
                const markRetryable = (message: string) => {
                    const error = new Error(message) as Error & { retryable?: boolean };
                    error.retryable = true;
                    reject(error);
                };
                xhr.onerror = () => markRetryable("network error while uploading media");
                xhr.ontimeout = () => markRetryable("the media upload timed out");
                xhr.onabort = () => reject(new Error("the media upload was cancelled"));
                xhr.onload = () => {
                    let body: any = {};
                    try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* handled below */ }
                    if (xhr.status >= 200 && xhr.status < 300 && body?.url) {
                        resolve({
                            url: body.url,
                            posterUrl: body.posterUrl,
                            mime: body.mime || getLocalProfileMediaMime(file),
                            bytes: Number(body.bytes) || file.size,
                            metadata: body.metadata
                        });
                        return;
                    }
                    const retryable = xhr.status === 408 || xhr.status === 429 || xhr.status >= 500;
                    const error = new Error(body?.error || `server returned ${xhr.status || "no status"}`) as Error & { retryable?: boolean };
                    error.retryable = retryable;
                    reject(error);
                };
                xhr.send(requestBody);
            });
            onProgress?.(100);
            return result;
        } catch (error) {
            lastError = (error as Error)?.message || lastError;
            if (!(error as Error & { retryable?: boolean })?.retryable || attempt === 2) break;
            onProgress?.(40);
            await waitForUploadRetry(500 * (attempt + 1));
        }
    }
    throw new Error(`Media upload failed after retries: ${lastError}`);
}

function isOwnedProfileMediaUrl(value: string, kind: FlairMediaKind, userId: string): boolean {
    try {
        const parsed = new URL(value);
        return parsed.origin === "https://optmaxxing-vip.maxxtopia.workers.dev" &&
            new RegExp(`^/profile-media/${userId}/${kind}/[0-9a-f-]{36}$`, "i").test(parsed.pathname);
    } catch {
        return false;
    }
}

async function importProfileMedia(
    kind: FlairMediaKind,
    sourceUrl: string,
    claimCode: string,
    onProgress?: (percent: number) => void
): Promise<UploadedProfileMedia> {
    const me = UserStore.getCurrentUser?.();
    if (!me?.id) throw new Error("Could not read your Discord user ID for the media import.");
    if (!/^https:\/\/[^\s]+$/i.test(sourceUrl)) {
        throw new Error("Media import needs a direct HTTPS URL.");
    }
    const body = JSON.stringify({ userId: me.id, claimCode, kind, sourceUrl });
    let lastError = "import failed";
    onProgress?.(10);
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch(`${WORKER_PROFILE_MEDIA_URL}/import`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body
            });
            const result = await response.json().catch(() => ({}));
            if (response.ok && result?.url) {
                onProgress?.(100);
                return {
                    url: result.url,
                    posterUrl: result.posterUrl,
                    mime: result.mime || "application/octet-stream",
                    bytes: Number(result.bytes) || 0,
                    metadata: result.metadata
                };
            }
            const error = new Error(result?.error || `media import returned ${response.status || "no status"}`) as Error & { retryable?: boolean };
            error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            throw error;
        } catch (error) {
            lastError = (error as Error)?.message || lastError;
            if (!(error as Error & { retryable?: boolean })?.retryable || attempt === 2) break;
            onProgress?.(20);
            await waitForUploadRetry(500 * (attempt + 1));
        }
    }
    throw new Error(`Media import failed after retries: ${lastError}`);
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

    // Self-preview path: start from the shared roster, then overlay only
    // fields actively edited in this session. Persisted settings are not
    // treated as a permanent override because they may belong to an older
    // device/account state.
    let flair: ProfileFlair | null = null;
    const me = UserStore.getCurrentUser?.();
    if (me?.id === userId) {
        const merged: ProfileFlair = { ...(getRosterProfileFlair(userId) ?? {}) };
        applyLocalDraftField(merged, s.myBannerUrl, "myBannerUrl", "bannerUrl");
        applyLocalDraftField(merged, s.myAvatarAnimatedUrl, "myAvatarAnimatedUrl", "avatarAnimatedUrl");
        applyLocalDraftField(merged, s.myThemeColorPrimary, "myThemeColorPrimary", "themeColorPrimary");
        applyLocalDraftField(merged, s.myThemeColorSecondary, "myThemeColorSecondary", "themeColorSecondary");
        mergeLocalPresentationFields(merged, s);
        if (Object.keys(merged).length) flair = merged;
    }
    if (!flair) flair = me?.id === userId ? null : remoteFlairForRender(userId);
    if (!flair) return null;

    if (kind === "banner" || kind === "avatar") {
        const mediaUrl = kind === "banner" ? flair.bannerUrl : flair.avatarAnimatedUrl;
        if (isTournamentModeActive() && mediaUrl && isAnimatedUrl(mediaUrl)) {
            // TournamentMode pauses animated decode/compositing. Static images
            // remain useful and cheap, so they continue to render.
            return null;
        }
    }
    return flair;
}

async function ensureProfileClaim(): Promise<string | null> {
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
    if (!claimCode && !settings.store.manualClaimCode?.trim()) {
        // The free binding is still identity-checked by Discord OAuth and
        // bound to this PC's HWID. Start it from the user's Save/Clear click
        // so the authorization tab is opened before the first await and is
        // not rejected by Chromium popup protection.
        const authorizationWindow = reserveFreeActivationWindow();
        if (!authorizationWindow) {
            toast("Discord authorization was blocked. Allow the browser window and try again.", Toasts.Type.FAILURE, 6000);
            return null;
        }
        toast("Activating free profile once… authorize Discord in the new window, then your flair will save automatically.", Toasts.Type.MESSAGE, 6000);
        const hwid = await getMyHwid();
        if (!hwid) {
            try { authorizationWindow.close?.(); } catch { /* best effort */ }
            toast("Could not read this PC's HWID yet. Try Save again in a moment, or open DMVipClaim.", Toasts.Type.FAILURE, 6000);
            return null;
        }
        const activation = await activateFreeProfile(hwid, authorizationWindow);
        if (!activation.ok) {
            toast(activation.error || "Free profile activation did not complete.", Toasts.Type.FAILURE, 7000);
            return null;
        }
        claimCode = activation.binding?.code || readBinding()?.code || "";
    }
    if (!claimCode) {
        toast(
            "Free profile activation did not complete. Try Save again, or open DMVipClaim to retry the activation flow.",
            Toasts.Type.FAILURE, 6000
        );
        return null;
    }
    return claimCode;
}

async function postFlairUpdate(profile: Partial<ProfileFlair>, replace: boolean, claimCodeOverride = ""): Promise<boolean> {
    const me = UserStore.getCurrentUser();
    if (!me?.id) {
        toast("Couldn't read your Discord user ID", Toasts.Type.FAILURE);
        return false;
    }
    const claimCode = claimCodeOverride || await ensureProfileClaim();
    if (!claimCode) return false;
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
        const hasAnimatedMedia =
            (profile.bannerUrl ? isAnimatedUrl(profile.bannerUrl) : false) ||
            (profile.avatarAnimatedUrl ? isAnimatedUrl(profile.avatarAnimatedUrl) : false);
        if (isTournamentModeActive() && hasAnimatedMedia) {
            toast(
                "⚠ TournamentMode is on — animated media is paused until you toggle TM off. Static images and theme colors still paint.",
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

async function settleFlairDraftsAfterSave(expected: Partial<ProfileFlair>): Promise<void> {
    await refreshRoster();
    const me = UserStore.getCurrentUser?.();
    const refreshed = me?.id ? getRosterProfileFlair(me.id) : null;
    // Cloudflare may briefly serve the previous roster snapshot while its
    // edge cache expires. Keep the just-saved local draft in that case so the
    // author's own popout does not flash back to stale colors/media. Once the
    // shared roster contains the expected state, the worker is authoritative
    // again and persisted local settings can no longer mask another PC.
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
        if (k === "mediaSpeed" && !PROFILE_SPEED_VALUES.has(v as any)) {
            return `${k} must be 0.75, 1, 1.25, or 1.5`;
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

interface DirectMediaPreviewProps {
    kind: FlairMediaKind;
    url: string;
    isVideoSource?: boolean;
    profile?: Pick<ProfileFlair, "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect" | "mediaSpeed">;
    onPickFile?: () => void;
}

/**
 * Field-local full-source preview for the editor. Keeping this beside the URL
 * input makes it obvious which source is being previewed, while the existing
 * dm-media proxy keeps cross-origin video previews usable in Chromium.
 */
function DirectMediaPreview({ kind, url, isVideoSource = false, profile, onPickFile }: DirectMediaPreviewProps) {
    const [state, setState] = React.useState<"empty" | "loading" | "ready" | "error">("empty");
    const validSource = /^(?:https:\/\/|blob:|data:)/i.test(url);
    const isVideo = isVideoSource || isVideoUrl(url);
    const isSharedMedia = isSharedProfileMediaUrl(url);
    // Worker-owned URLs are direct files, but they are extensionless and can
    // be GIFs or video. Proxy them for both <img> and <video> previews so the
    // renderer receives the server's real Content-Type instead of guessing
    // from the URL path.
    const source = validSource && (isVideo || isSharedMedia) ? proxyVideoUrl(url) : url;
    const objectPosition = kind === "banner"
        ? profile?.bannerPosition ?? "center"
        : profile?.avatarPosition ?? "center";
    const objectFit = kind === "banner"
        ? profile?.bannerFit ?? "cover"
        : profile?.avatarFit ?? "cover";
    const avatarScale = kind === "avatar" ? Number(profile?.avatarScale ?? "1") : 1;
    const mediaEffect = profile?.mediaEffect ?? "none";
    const mediaSpeed = PROFILE_SPEED_VALUES.has(profile?.mediaSpeed as any)
        ? Number(profile?.mediaSpeed)
        : 1;

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

    const previewInteraction = onPickFile ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: onPickFile,
        onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onPickFile();
            }
        },
        "aria-label": `Choose a local ${kind} file`
    } : {};

    if (!url) {
        return <div style={{ ...frameStyle, cursor: onPickFile ? "pointer" : undefined }} aria-label={`${kind} live preview`} {...previewInteraction}>
            <div style={messageStyle}>
                <span>Paste a direct HTTPS {kind} image, GIF, or video URL to preview it here.</span>
                {onPickFile && <span style={{ display: "block", marginTop: 7, color: "#e25bff", fontWeight: 700 }}>or click to choose a local file</span>}
            </div>
        </div>;
    }
    if (!validSource) {
        return <div style={{ ...frameStyle, cursor: onPickFile ? "pointer" : undefined }} aria-label={`${kind} live preview`} {...previewInteraction}>
            <div style={messageStyle}>
                <span>Preview needs a direct HTTPS media URL, not a webpage link.</span>
                {onPickFile && <span style={{ display: "block", marginTop: 7, color: "#e25bff", fontWeight: 700 }}>or click to choose a local file</span>}
            </div>
        </div>;
    }

    const onReady = () => setState("ready");
    const onError = () => setState("error");

    return (
        <div style={{ ...frameStyle, cursor: onPickFile && state === "error" ? "pointer" : undefined }} aria-label={`${kind} live preview`} {...(state === "error" ? previewInteraction : {})}>
            {isVideo ? (
                <video
                    src={source}
                    muted
                    loop
                    autoPlay
                    playsInline
                    preload="metadata"
                    style={mediaStyle}
                    onLoadedData={event => {
                        event.currentTarget.playbackRate = mediaSpeed;
                        event.currentTarget.defaultPlaybackRate = mediaSpeed;
                        onReady();
                    }}
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
            {state === "error" && <div style={messageStyle}>
                <span>{isSharedMedia
                    ? "The saved shared media copy could not be loaded. Choose the original file or paste its direct HTTPS source again, then Save."
                    : "Source did not load. Clear it, choose a local file, or paste a direct HTTPS media URL — not the old `/profile-media/&lt;id&gt;` route."}</span>
                {onPickFile && <span style={{ display: "block", marginTop: 7, color: "#e25bff", fontWeight: 700 }}>click to choose a local file</span>}
            </div>}
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
    profile?: Pick<ProfileFlair, "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect" | "mediaSpeed">;
    onChange(value: string): void;
}

function FlairMediaSetting({ kind, value, profile, onChange }: FlairMediaSettingProps) {
    const [, forceLocalMediaRender] = React.useState(0);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const label = kind === "banner" ? "My Banner URL" : "My Avatar Animated URL";
    const description = kind === "banner"
        ? "[Channel E · FREE] Paste a DIRECT image, GIF, or short MP4/WebM URL — not a webpage. Save imports it into your private shared media, or choose/drag a local banner."
        : "[Channel F · FREE] Paste a DIRECT image or GIF URL — not a webpage. Save imports it into your private shared media, or choose/drag a local image/GIF avatar. Video avatars remain native-Discord-only.";
    const local = getLocalProfileMedia(kind);
    const remoteValue = value.trim();
    const previewUrl = remoteValue || local.url;
    const localIsActive = !remoteValue && Boolean(local.url);

    React.useEffect(() => {
        let alive = true;
        const listener = () => { if (alive) forceLocalMediaRender(version => version + 1); };
        localProfileMediaListeners.add(listener);
        void hydrateLocalProfileMedia();
        return () => {
            alive = false;
            localProfileMediaListeners.delete(listener);
        };
    }, [kind]);

    const pickLocalFile = () => fileInputRef.current?.click();
    const changeRemoteValue = (nextValue: string) => {
        setLocalProfileMediaError(kind, undefined);
        onChange(nextValue);
    };
    const acceptFile = async (file: File | undefined) => {
        if (!file) return;
        const typeError = localProfileMediaTypeError(kind, file);
        if (typeError) {
            setLocalProfileMediaError(kind, typeError);
            toast(typeError, Toasts.Type.FAILURE, 5000);
            return;
        }
        try {
            let candidate = file;
            const rawMetadata = await readLocalProfileMediaMetadata(kind, file);
            const maxDimension = kind === "avatar" ? MAX_PROFILE_AVATAR_DIMENSION : MAX_PROFILE_MEDIA_DIMENSION;
            const needsStaticOptimization = isOptimizableProfileImage(file) && (
                file.size > MAX_PROFILE_LOCAL_IMAGE_BYTES ||
                (rawMetadata.width ?? 0) > maxDimension ||
                (rawMetadata.height ?? 0) > maxDimension
            );
            if (needsStaticOptimization) {
                toast(`Optimizing this static ${kind} for Discordmaxxer…`, Toasts.Type.MESSAGE, 5000);
                candidate = await optimizeRasterProfileImage(kind, file);
            }
            const error = localProfileMediaError(kind, candidate);
            if (error) throw new Error(error);
            const metadata = await inspectLocalProfileMedia(kind, candidate);
            await saveLocalProfileMedia(kind, candidate, metadata);
            changeRemoteValue("");
            const optimizedNotice = candidate !== file ? " It was automatically optimized to fit the shared limits." : "";
            toast(`Local ${kind} preview loaded.${optimizedNotice} Press Save to upload it and share it with other Discordmaxxer users.`, Toasts.Type.MESSAGE, 7000);
        } catch (error) {
            const message = (error as Error)?.message || `Could not load that local ${kind}.`;
            setLocalProfileMediaError(kind, message);
            toast(message, Toasts.Type.FAILURE, 5000);
        }
    };
    const stopEditorEvent = (event: React.SyntheticEvent) => event.stopPropagation();
    const localStatus = local.error
        ? { color: "#ffb4c4", background: "rgba(237, 66, 69, 0.12)", border: "rgba(237, 66, 69, 0.42)", text: local.error }
        : localIsActive && local.metadata
            ? { color: "#b9f7d1", background: "rgba(67, 211, 123, 0.09)", border: "rgba(67, 211, 123, 0.32)", text: `Local file ready · ${formatMediaDetails(local.metadata)}` }
            : null;
    const remoteStatus = remoteValue
        ? isLegacyProfileMediaUrl(remoteValue)
            ? { color: "#ffb4c4", background: "rgba(237, 66, 69, 0.12)", border: "rgba(237, 66, 69, 0.42)", text: "This is an old media collection URL, not a playable file. Paste a direct HTTPS media URL." }
            : !URL_RE.test(remoteValue)
                ? { color: "#ffcfda", background: "rgba(237, 66, 69, 0.1)", border: "rgba(237, 66, 69, 0.32)", text: "Paste a direct HTTPS media URL. The server will verify size, format, dimensions, and duration when you save." }
                : { color: "#cbd0e0", background: "rgba(0, 212, 255, 0.06)", border: "rgba(0, 212, 255, 0.22)", text: "Direct URL ready · the server will validate and import a private shared copy when you save." }
        : null;
    // The local error slot also carries a failed server import. Keeping it in
    // the field makes a rejected URL actionable instead of leaving the user
    // with a toast that disappears while the invalid URL remains in place.
    const status = localIsActive || local.error ? localStatus : remoteStatus;

    return (
        <div
            style={{ margin: "14px 0 16px" }}
            onDragEnter={event => { event.preventDefault(); event.stopPropagation(); }}
            onDragOverCapture={event => { event.preventDefault(); event.stopPropagation(); }}
            onDropCapture={event => { event.preventDefault(); event.stopPropagation(); void acceptFile(event.dataTransfer.files?.[0]); }}
            onPointerDown={stopEditorEvent}
            onContextMenu={stopEditorEvent}
        >
            <div style={settingLabelStyle}>{label}</div>
            <div style={settingDescriptionStyle}>{description}</div>
            <input
                ref={fileInputRef}
                type="file"
                accept={kind === "banner" ? "image/*,video/mp4,video/webm,video/quicktime" : "image/*"}
                style={{ display: "none" }}
                tabIndex={-1}
                onChange={event => { void acceptFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }}
            />
            <input
                type="text"
                aria-label={label}
                placeholder="https://..."
                value={value}
                style={settingInputStyle}
                onChange={event => changeRemoteValue(event.currentTarget.value)}
                onPointerDown={stopEditorEvent}
                onClick={stopEditorEvent}
                onContextMenu={stopEditorEvent}
            />
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 7 }}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={pickLocalFile}>
                    📁 Choose local file
                </Button>
                {remoteValue && <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => changeRemoteValue("")}>
                    Clear URL
                </Button>}
                {localIsActive && <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => { void clearLocalProfileMedia(kind); }}>
                    Remove local preview
                </Button>}
            </div>
            {localIsActive && <div style={{ marginTop: 6, color: "#e5c6ff", fontSize: 10.5 }}>
                Local preview: <b>{local.fileName || "selected file"}</b>. Press Save to upload it, validate it, and share it with other Discordmaxxer clients.
            </div>}
            {status && <div
                role={status === localStatus && local.error ? "alert" : "status"}
                aria-live="polite"
                style={{ marginTop: 7, padding: "7px 9px", borderRadius: 6, color: status.color, background: status.background, border: `1px solid ${status.border}`, fontSize: 10.5, lineHeight: 1.35 }}
            >
                <span aria-hidden="true" style={{ marginRight: 5 }}>{status === localStatus && local.error ? "!" : "●"}</span>{status.text}
            </div>}
            <DirectMediaPreview
                kind={kind}
                url={previewUrl}
                isVideoSource={localIsActive && local.mime.startsWith("video/")}
                profile={profile}
                onPickFile={pickLocalFile}
            />
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

function RecentMediaThumb({ kind, url }: { kind: FlairMediaKind; url: string }) {
    const [mode, setMode] = React.useState<"image" | "video" | "error">(isVideoUrl(url) ? "video" : "image");
    React.useEffect(() => setMode(isVideoUrl(url) ? "video" : "image"), [url]);
    const mediaStyle: React.CSSProperties = {
        width: 46,
        height: 46,
        borderRadius: "50%",
        objectFit: "cover",
        display: "block",
        background: "#222",
        border: "1px solid rgba(255,255,255,0.12)"
    };
    if (mode === "video") {
        return <video
            src={proxyVideoUrl(url)}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            aria-label={`Recent ${kind} video`}
            style={mediaStyle}
            onError={() => setMode("image")}
        />;
    }
    if (mode === "image") {
        return <img
            src={isSharedProfileMediaUrl(url) ? proxyVideoUrl(url) : url}
            alt={`Recent ${kind}`}
            referrerPolicy="no-referrer"
            style={mediaStyle}
            onError={() => setMode("error")}
        />;
    }
    return <span aria-label={`Recent ${kind} unavailable`} style={{ ...mediaStyle, display: "flex", alignItems: "center", justifyContent: "center", color: "#e25bff", fontSize: 18 }}>
        {kind === "banner" ? "▰" : "●"}
    </span>;
}

function FlairEditor() {
    // Use Vencord's reactive settings hook while the editor is mounted inside
    // the plugin-settings page. The generic ComponentSetting host invokes this
    // function during render, so reading the hook-backed proxy also guarantees
    // defaults are materialized before the editor dereferences URL/color fields.
    const s = settings.use([
        "myBannerUrl",
        "myAvatarAnimatedUrl",
        "myThemeColorPrimary",
        "myThemeColorSecondary",
        "myBannerPosition",
        "myAvatarPosition",
        "myBannerFit",
        "myAvatarFit",
        "myAvatarScale",
        "myMediaSpeed",
        "myMediaEffect",
        "manualClaimCode",
        "recentPicksJson"
    ]);
    const [busy, setBusy] = React.useState(false);
    const [actionFeedback, setActionFeedback] = React.useState<FlairActionFeedback | null>(null);
    const announce = (kind: FlairActionFeedback["kind"], text: string) => setActionFeedback({ kind, text });
    const [, forceRosterHydrationRender] = React.useState(0);
    React.useEffect(() => {
        let alive = true;
        void (async () => {
            await hydrateLocalProfileMedia();
            try {
                await refreshRoster();
            } catch (error) {
                console.warn("[DMProfileFlair] editor roster hydration failed:", error);
            }
            if (!alive || !isRosterReady()) return;
            const me = UserStore.getCurrentUser?.();
            const remote = me?.id ? getRosterProfileFlair(me.id) : null;
            if (!remote) return;

            // A persisted field is only a draft after the user edits it in
            // this editor session. This clears the old base /profile-media/:id
            // value seen in older builds and lets the current roster route win
            // on every client without erasing an active unsaved edit.
            const pairs: Array<[string, keyof ProfileFlair]> = [
                ["myBannerUrl", "bannerUrl"],
                ["myAvatarAnimatedUrl", "avatarAnimatedUrl"],
                ["myThemeColorPrimary", "themeColorPrimary"],
                ["myThemeColorSecondary", "themeColorSecondary"],
                ["myBannerPosition", "bannerPosition"],
                ["myAvatarPosition", "avatarPosition"],
                ["myBannerFit", "bannerFit"],
                ["myAvatarFit", "avatarFit"],
                ["myAvatarScale", "avatarScale"],
                ["myMediaSpeed", "mediaSpeed"],
                ["myMediaEffect", "mediaEffect"]
            ];
            let changed = false;
            for (const [settingKey, profileKey] of pairs) {
                if (flairDraftFields.has(settingKey)) continue;
                const localValue = String((settings.store as any)[settingKey] ?? "").trim();
                const remoteValue = String(remote[profileKey] ?? "").trim();
                if (remoteValue || isLegacyProfileMediaUrl(localValue)) {
                    if (localValue !== remoteValue) {
                        (settings.store as any)[settingKey] = remoteValue;
                        changed = true;
                    }
                }
            }
            if (changed && alive) forceRosterHydrationRender(version => version + 1);
        })();
        return () => { alive = false; };
    }, []);
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
        const localUploads: FlairMediaKind[] = [];
        const remoteImports: FlairMediaKind[] = [];
        if (!proposed.bannerUrl && getLocalProfileMedia("banner").file) localUploads.push("banner");
        if (!proposed.avatarAnimatedUrl && getLocalProfileMedia("avatar").file) localUploads.push("avatar");
        const currentUserId = UserStore.getCurrentUser?.()?.id;
        if (currentUserId && proposed.bannerUrl && !isOwnedProfileMediaUrl(proposed.bannerUrl, "banner", currentUserId)) {
            remoteImports.push("banner");
        }
        if (currentUserId && proposed.avatarAnimatedUrl && !isOwnedProfileMediaUrl(proposed.avatarAnimatedUrl, "avatar", currentUserId)) {
            remoteImports.push("avatar");
        }
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
            proposed.mediaSpeed = s.myMediaSpeed.trim() || undefined;
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
        try {
            let claimCode = "";
            if (localUploads.length || remoteImports.length) {
                claimCode = (await ensureProfileClaim()) || "";
                if (!claimCode) {
                    announce("error", "Free profile activation is required once before media can be imported or uploaded.");
                    return;
                }
                for (const kind of localUploads) {
                    const file = getLocalProfileMedia(kind).file;
                    if (!file) throw new Error(`The selected ${kind} file is no longer available. Choose it again and retry.`);
                    try {
                        announce("info", `Uploading ${kind}… 0% (the file stays local until this Save)`);
                        const uploaded = await uploadProfileMedia(kind, file, claimCode, percent => {
                            announce("info", `Uploading ${kind}… ${percent}%`);
                        });
                        setLocalProfileMediaError(kind, undefined);
                        if (kind === "banner") {
                            proposed.bannerUrl = uploaded.url;
                            s.myBannerUrl = uploaded.url;
                        } else {
                            proposed.avatarAnimatedUrl = uploaded.url;
                            s.myAvatarAnimatedUrl = uploaded.url;
                        }
                    } catch (error) {
                        setLocalProfileMediaError(kind, (error as Error)?.message || `Could not upload that ${kind} file.`);
                        throw error;
                    }
                }
                for (const kind of remoteImports) {
                    const sourceUrl = kind === "banner" ? proposed.bannerUrl : proposed.avatarAnimatedUrl;
                    if (!sourceUrl) continue;
                    try {
                        announce("info", `Importing ${kind} URL… the server is checking the file before sharing it`);
                        const imported = await importProfileMedia(kind, sourceUrl, claimCode, percent => {
                            announce("info", `Importing ${kind} URL… ${percent}%`);
                        });
                        setLocalProfileMediaError(kind, undefined);
                        if (kind === "banner") {
                            proposed.bannerUrl = imported.url;
                            s.myBannerUrl = imported.url;
                        } else {
                            proposed.avatarAnimatedUrl = imported.url;
                            s.myAvatarAnimatedUrl = imported.url;
                        }
                    } catch (error) {
                        setLocalProfileMediaError(kind, (error as Error)?.message || `Could not import that ${kind} URL.`);
                        throw error;
                    }
                }
            }
            const postErr = validateLocal(proposed);
            if (postErr) {
                toast(postErr, Toasts.Type.FAILURE, 5000);
                announce("error", postErr);
                return;
            }
            announce("info", localUploads.length || remoteImports.length
                ? "Saving the validated media and profile settings…"
                : "Saving to the shared Discordmaxxer roster…");
            // Replace mode: the editor reflects the user's full intended state,
            // so we replace rather than merge — empty fields clear server-side.
            const ok = await postFlairUpdate(proposed, true, claimCode);
            if (ok) {
                for (const kind of localUploads) await clearLocalProfileMedia(kind);
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
                announce("error", "The shared save failed. The error toast above contains the server reason; your local file is still available to retry.");
            }
        } catch (error) {
            const message = (error as Error)?.message || "The media upload failed.";
            toast(message, Toasts.Type.FAILURE, 7000);
            announce("error", `${message} Your selected file was kept locally so you can retry.`);
        } finally {
            setBusy(false);
        }
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
            s.myMediaSpeed = "";
            s.myMediaEffect = "";
            await Promise.all([clearLocalProfileMedia("banner"), clearLocalProfileMedia("avatar")]);
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
                mediaSpeed: undefined,
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
        const source = s.myBannerUrl.trim();
        if (!source) {
            toast("Set your banner URL above before trying the native color test.", Toasts.Type.FAILURE, 5000);
            return;
        }
        if (!confirm(broadcastConfirmCopy(
            "theme colors",
            "We'll sample the selected banner and write only two native Discord profile colors. This does not upload the banner, change your avatar, or send a message. Discord may still restrict the render to Nitro accounts, so a vanilla second-account check is required."
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
    const liveProfile: Pick<ProfileFlair, "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect" | "mediaSpeed"> = {
        bannerPosition: (s.myBannerPosition || undefined) as ProfileFlair["bannerPosition"],
        avatarPosition: (s.myAvatarPosition || undefined) as ProfileFlair["avatarPosition"],
        bannerFit: (s.myBannerFit || undefined) as ProfileFlair["bannerFit"],
        avatarFit: (s.myAvatarFit || undefined) as ProfileFlair["avatarFit"],
        avatarScale: (s.myAvatarScale || undefined) as ProfileFlair["avatarScale"],
        mediaSpeed: (s.myMediaSpeed || undefined) as ProfileFlair["mediaSpeed"],
        mediaEffect: (s.myMediaEffect || undefined) as ProfileFlair["mediaEffect"]
    };

    const recentsWrap: React.CSSProperties = {
        marginBottom: 12, paddingBottom: 10,
        borderBottom: "1px dashed rgba(226, 91, 255, 0.35)"
    };
    const recentsRowStyle: React.CSSProperties = {
        display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap"
    };
    const recentsLabelStyle: React.CSSProperties = {
        fontSize: 11, fontWeight: 600, color: "#cbd0e0", minWidth: 64
    };
    const thumbButtonStyle: React.CSSProperties = {
        background: "#17131d", border: "1px solid rgba(226, 91, 255, 0.42)",
        borderRadius: "50%", padding: 2, cursor: "pointer", display: "inline-flex",
        transition: "transform 120ms ease, border-color 120ms ease"
    };
    const colorSwatch = (p: string, s: string): React.CSSProperties => ({
        width: 46, height: 46, borderRadius: "50%", display: "inline-block",
        background: `linear-gradient(180deg, ${p} 0%, ${s} 100%)`,
        border: "1px solid rgba(255,255,255,0.12)"
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
                    onChange={value => { markFlairDraftField("myBannerUrl"); s.myBannerUrl = value; }}
                />
                <FlairMediaSetting
                    kind="avatar"
                    value={s.myAvatarAnimatedUrl}
                    profile={liveProfile}
                    onChange={value => { markFlairDraftField("myAvatarAnimatedUrl"); s.myAvatarAnimatedUrl = value; }}
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
                    onChange={value => { markFlairDraftField("myBannerPosition"); s.myBannerPosition = value; }}
                />
                <ProfileEnhancementControl
                    label="Banner fit"
                    description="Fill the banner area or show the whole source with letterboxing."
                    value={s.myBannerFit}
                    minTier={Tier.MAXXER_PLUS}
                    options={FIT_OPTIONS}
                    onChange={value => { markFlairDraftField("myBannerFit"); s.myBannerFit = value; }}
                />
                <ProfileEnhancementControl
                    label="Avatar crop anchor"
                    description="Choose the top, center, or bottom of an animated avatar source."
                    value={s.myAvatarPosition}
                    minTier={Tier.MAXXER}
                    options={POSITION_OPTIONS}
                    onChange={value => { markFlairDraftField("myAvatarPosition"); s.myAvatarPosition = value; }}
                />
                <ProfileEnhancementControl
                    label="Avatar fit + scale"
                    description="Show the whole avatar and adjust its size inside the avatar frame."
                    value={s.myAvatarFit}
                    minTier={Tier.MAXXER_PLUS}
                    options={FIT_OPTIONS}
                    onChange={value => { markFlairDraftField("myAvatarFit"); s.myAvatarFit = value; }}
                />
                <ProfileEnhancementControl
                    label="Avatar scale"
                    description="Fine-tune the animated avatar size without changing the source media."
                    value={s.myAvatarScale}
                    minTier={Tier.MAXXER_PLUS}
                    options={SCALE_OPTIONS}
                    onChange={value => { markFlairDraftField("myAvatarScale"); s.myAvatarScale = value; }}
                />
                <ProfileEnhancementControl
                    label="Media speed"
                    description="Set shared banner video playback speed. GIF timing stays native because changing it would require re-encoding the GIF."
                    value={s.myMediaSpeed}
                    minTier={Tier.MAXXER_PLUS}
                    options={SPEED_OPTIONS}
                    onChange={value => { markFlairDraftField("myMediaSpeed"); s.myMediaSpeed = value; }}
                />
                <ProfileEnhancementControl
                    label="Media finish"
                    description="Add a subtle glow or scanline finish to your shared banner and avatar."
                    value={s.myMediaEffect}
                    minTier={Tier.MAXXER_PLUS_PLUS}
                    options={EFFECT_OPTIONS}
                    onChange={value => { markFlairDraftField("myMediaEffect"); s.myMediaEffect = value; }}
                />
                <ThemeColorSetting
                    kind="primary"
                    value={s.myThemeColorPrimary}
                    primary={normalizeColor(s.myThemeColorPrimary) ?? ""}
                    secondary={normalizeColor(s.myThemeColorSecondary) ?? ""}
                    onChange={value => { markFlairDraftField("myThemeColorPrimary"); s.myThemeColorPrimary = value; }}
                />
                <ThemeColorSetting
                    kind="secondary"
                    value={s.myThemeColorSecondary}
                    primary={normalizeColor(s.myThemeColorPrimary) ?? ""}
                    secondary={normalizeColor(s.myThemeColorSecondary) ?? ""}
                    onChange={value => { markFlairDraftField("myThemeColorSecondary"); s.myThemeColorSecondary = value; }}
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
                                    title="Re-apply recent banner"
                                    style={thumbButtonStyle}
                                    onClick={() => { markFlairDraftField("myBannerUrl"); s.myBannerUrl = url; }}
                                >
                                    <RecentMediaThumb kind="banner" url={url} />
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
                                    title="Re-apply recent avatar"
                                    style={thumbButtonStyle}
                                    onClick={() => { markFlairDraftField("myAvatarAnimatedUrl"); s.myAvatarAnimatedUrl = url; }}
                                >
                                    <RecentMediaThumb kind="avatar" url={url} />
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
                                        title="Re-apply recent gradient"
                                        style={thumbButtonStyle}
                                        onClick={() => { markFlairDraftField("myThemeColorPrimary"); markFlairDraftField("myThemeColorSecondary"); s.myThemeColorPrimary = p; s.myThemeColorSecondary = sec; }}
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
                    🟡 <b>TournamentMode is currently active.</b> Animated banner/avatar media is
                    <b> paused</b> until you toggle TM off (TM exists to free up CPU/GPU). Static
                    images and theme colors still render normally.
                </div>
            )}
            <div style={noteStyle}>
                These values are sent to the Discordmaxxer roster and rendered for other
                Discordmaxxer users. Vanilla Discord users see your stock profile.
                Worker validates the roster claim and media safety server-side. Profile
                flair is free for every claimed Discordmaxxer user: one active banner,
                one active animated avatar, and the two theme colors. TournamentMode
                pauses animated media while it is active; static profile images remain available.
            </div>
            <div style={btnRow}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onSave} disabled={busy}>
                    💾 {((!s.myBannerUrl.trim() && !!getLocalProfileMedia("banner").file) || (!s.myAvatarAnimatedUrl.trim() && !!getLocalProfileMedia("avatar").file)) ? "Upload & Save to Discordmaxxer" : "Save to Discordmaxxer"}
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
                <div style={broadcastTitleStyle}>📡 Optional native Discord profile tools (one-time)</div>
                <div style={broadcastNoteStyle}>
                    The Save button above publishes flair that <b>other Discordmaxxer users</b> can see.
                    These optional buttons PATCH your <b>real Discord profile</b> once when clicked, as a
                    convenience for fields Discord itself supports. You can always make the same changes in
                    Discord's normal Profile settings; these buttons never re-assert or fight your native edits.
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
    myMediaSpeed: {
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
    // Hidden — JSON-stringified history of the last MAX_RECENTS values for
    // banner URL / avatar URL / color pair ("primary|secondary"). Pushed on
    // every successful Save in FlairEditor; surfaced as a quick-pick row at
    // the top of the editor so the user can swap back to a recent flair the
    // way Discord shows your last-uploaded avatars on the avatar picker.
    recentPicksJson: {
        type: OptionType.STRING,
        description: "(hidden) JSON history of recent flair picks — managed by the editor's Save button.",
        default: "{}",
        hidden: true
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
    manualClaimCode: {
        type: OptionType.STRING,
        description:
            "Optional fallback: paste your VIP claim code (the MAXX-XXXX-XXXX-XXXX-XXXX you redeemed) here " +
            "if Save → 'Save to Discordmaxxer' tells you it can't find your binding. Discord disables " +
            "localStorage in modern builds which breaks the normal binding-read path; this setting is " +
            "persisted to disk via Vencord, so it survives. Auto-normalized (dashes + case ignored).",
        default: ""
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
let lastRosterRefreshAt = 0;
const ROSTER_FOCUS_REFRESH_INTERVAL_MS = 30_000;

function refreshRosterForVisibleSurface(): void {
    if (document.hidden) return;
    scheduleScan();
    const now = Date.now();
    if (now - lastRosterRefreshAt < ROSTER_FOCUS_REFRESH_INTERVAL_MS) return;
    lastRosterRefreshAt = now;
    refreshRoster().catch(e => console.warn("[DMProfileFlair] focused roster refresh failed:", e));
}

const onVisibilityChange = () => {
    if (!document.hidden) refreshRosterForVisibleSurface();
};
const onRosterFocus = () => refreshRosterForVisibleSurface();


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

function profileMediaPlaybackRate(value?: string): number {
    return PROFILE_SPEED_VALUES.has(value as any) ? Number(value) : 1;
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
            z-index: 0;
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
            z-index: 0;
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
            z-index: 1;
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

/** Try to identify whose profile a popout/full-profile view belongs to. Modern
 *  Discord doesn't put `data-user-id` on profile containers, so we extract it
 *  from an avatar IMG inside via the CDN URL shape
 *  `cdn.discordapp.com/avatars/<userId>/<hash>.<ext>`. Returns null when the
 *  user has Discord's default avatar (no per-user CDN URL — those use
 *  `/assets/<hash>.png` instead). */
function getUserIdFromContainerLegacy(container: Element): string | null {
    // Discord has changed the avatar class token across profile-sidebar and
    // popout layouts. The CDN path is the stable identity signal, so inspect
    // every image in this already-bounded profile container instead of
    // requiring the current `avatar__` class name.
    const imgs = container.querySelectorAll("img");
    for (const img of imgs) {
        const src = (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src || "";
        const m = src.match(/\/avatars\/(\d{17,20})\//);
        if (m) return m[1];
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
    }

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

const profileIdentityCache = new WeakMap<Element, { signature: string; userId: string | null; checkedAt: number }>();

function profileIdentitySignature(container: Element): string {
    const attrs = ["data-user-id", "data-userid", "data-profile-user-id", "data-profile-userid", "id"]
        .map(key => container.getAttribute(key) ?? "")
        .join("|");
    const avatar = container.querySelector("img") as HTMLImageElement | null;
    return `${attrs}|${avatar?.currentSrc || avatar?.src || ""}|${avatar?.getAttribute("data-dm-flair-avatar-user-id") || ""}|${container.childElementCount}`;
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
    // A null result is usually just the first few frames of a Discord popout
    // mounting. Cache positive identities normally, but keep a null result
    // only briefly so a late avatar/data attribute can be picked up without
    // making the profile flair disappear for a full polling interval.
    const cacheTtl = cached?.userId ? 1500 : 160;
    if (cached?.signature === signature && Date.now() - cached.checkedAt < cacheTtl) return cached.userId;
    let userId: string | null = null;
    for (const root of roots) {
        userId = findUserIdFromContainerUncached(root);
        if (userId) break;
    }
    profileIdentityCache.set(container, { signature, userId, checkedAt: Date.now() });
    return userId;
}

const PROFILE_VISUAL_PENDING_GRACE_MS = 4500;
// Keep the last confirmed remote visual briefly while the roster request or the
// profile popout is hydrating. This prevents a vanilla flash without making stale
// account data permanent.
const REMOTE_PROFILE_VISUAL_GRACE_MS = 120_000;
const remoteFlairLastKnown = new Map<string, { flair: ProfileFlair; savedAt: number }>();

/**
 * Keep a bounded, owner-keyed copy of a foreign user's last verified flair.
 * Discord frequently tears down and remounts a profile surface in several
 * React commits. During that window the roster lookup can briefly return no
 * record even though the owner has not changed. Returning the last record for
 * a bounded period prevents the banner/theme/avatar from flashing to native
 * defaults, while the user ID key prevents one profile from borrowing another
 * profile's cosmetics and the expiry lets a real removal take effect.
 */
function remoteFlairForRender(userId: string): ProfileFlair | null {
    const fresh = getRosterProfileFlair(userId);
    if (fresh) {
        const copy = { ...fresh };
        remoteFlairLastKnown.set(userId, { flair: copy, savedAt: Date.now() });
        return copy;
    }
    const cached = remoteFlairLastKnown.get(userId);
    if (!cached) return null;
    if (Date.now() - cached.savedAt <= REMOTE_PROFILE_VISUAL_GRACE_MS) return cached.flair;
    remoteFlairLastKnown.delete(userId);
    return null;
}

function profileVisualExists(container: HTMLElement, banner: HTMLElement): boolean {
    return banner.hasAttribute("data-dm-flair-banner-applied")
        || banner.hasAttribute("data-dm-flair-banner-loading-url")
        || Boolean(banner.querySelector(".dm-flair-banner-video, .dm-flair-banner-image"))
        || container.hasAttribute("data-dm-flair-theme-applied");
}

/** Keep a known owner's last rendered visuals while the roster or Discord's
 * identity-bearing children are still mounting. This is deliberately short
 * lived and owner-aware: it prevents a flash to native Discord defaults, but
 * never lets a previous user's flair leak into a different profile. */
function preserveProfileVisualDuringPendingRoster(container: HTMLElement, banner: HTMLElement, userId: string | null): boolean {
    // A missing identity can be a short DOM-mount gap even when the roster is
    // already ready. Keep that gap very short; a known identity still waits
    // for the authoritative roster result below.
    if ((userId && isRosterReady()) || !profileVisualExists(container, banner)) return false;
    const bannerOwner = banner.dataset.dmFlairBannerOwnerId;
    const themeOwner = container.dataset.dmFlairThemeOwnerId;
    if (userId && ((bannerOwner && bannerOwner !== userId) || (themeOwner && themeOwner !== userId))) return false;
    const pendingSince = Number(container.dataset.dmFlairPendingSince ?? 0) || Date.now();
    container.dataset.dmFlairPendingSince = String(pendingSince);
    const grace = userId ? PROFILE_VISUAL_PENDING_GRACE_MS : 900;
    return Date.now() - pendingSince <= grace;
}

function clearProfileVisualPending(container: HTMLElement): void {
    delete container.dataset.dmFlairPendingSince;
}

/** Single point that decides what flair (if any) to render for a given user.
 *  - Self (me.id === userId): start with the shared roster and overlay only
 *    fields actively edited in this editor session, so stale persisted values
 *    cannot mask the current cross-PC profile.
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
        const merged: ProfileFlair = { ...(getRosterProfileFlair(userId) ?? {}) };
        applyLocalDraftField(merged, s.myBannerUrl, "myBannerUrl", "bannerUrl");
        applyLocalDraftField(merged, s.myAvatarAnimatedUrl, "myAvatarAnimatedUrl", "avatarAnimatedUrl");
        applyLocalDraftField(merged, s.myThemeColorPrimary, "myThemeColorPrimary", "themeColorPrimary");
        applyLocalDraftField(merged, s.myThemeColorSecondary, "myThemeColorSecondary", "themeColorSecondary");
        mergeLocalPresentationFields(merged, s);
        if (Object.keys(merged).length) flair = merged;
    } else if (userId) {
        flair = remoteFlairForRender(userId);
    }
    if (!flair) return null;

    if (kind === "banner" || kind === "avatar") {
        const mediaUrl = kind === "banner" ? flair.bannerUrl : flair.avatarAnimatedUrl;
        if (isTournamentModeActive() && mediaUrl && isAnimatedUrl(mediaUrl)) return null;
    }
    return flair;
}

/** Remove our banner overlay and put the native Discord banner back. A failed
 * remote media load must not leave the stock banner hidden behind a blank
 * overlay. */
function clearBanner(banner: HTMLElement, failedUrl?: string) {
    const hadOverlay = banner.hasAttribute("data-dm-flair-banner-applied")
        || banner.hasAttribute("data-dm-flair-banner-loading-url")
        || Boolean(banner.querySelector(".dm-flair-banner-video, .dm-flair-banner-image"));
    banner.removeAttribute("data-dm-flair-banner-applied");
    delete banner.dataset.dmFlairBannerPosition;
    delete banner.dataset.dmFlairBannerFit;
    delete banner.dataset.dmFlairMediaSpeed;
    delete banner.dataset.dmFlairMediaEffect;
    delete banner.dataset.dmFlairBannerAppliedUrl;
    delete banner.dataset.dmFlairBannerLoadingUrl;
    delete banner.dataset.dmFlairBannerOwnerId;
    banner.querySelectorAll(".dm-flair-banner-video, .dm-flair-banner-image").forEach(v => v.remove());
    // Do not erase Discord's own inline banner styles when this container was
    // never ours. Only undo properties after we actually painted an overlay.
    if (hadOverlay) {
        banner.style.removeProperty("background-image");
        banner.style.removeProperty("background-size");
        banner.style.removeProperty("background-position");
        banner.style.removeProperty("background-repeat");
    }
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
    "bannerPosition" | "avatarPosition" | "bannerFit" | "avatarFit" | "avatarScale" | "mediaEffect" | "mediaSpeed"
>;

function applyBannerPresentation(banner: HTMLElement, flair?: ProfilePresentation) {
    if (flair?.bannerPosition) banner.dataset.dmFlairBannerPosition = flair.bannerPosition;
    else delete banner.dataset.dmFlairBannerPosition;
    if (flair?.bannerFit) banner.dataset.dmFlairBannerFit = flair.bannerFit;
    else delete banner.dataset.dmFlairBannerFit;
    const speed = profileMediaPlaybackRate(flair?.mediaSpeed);
    if (speed !== 1) banner.dataset.dmFlairMediaSpeed = String(speed);
    else delete banner.dataset.dmFlairMediaSpeed;
    if (flair?.mediaEffect && flair.mediaEffect !== "none") banner.dataset.dmFlairMediaEffect = flair.mediaEffect;
    else delete banner.dataset.dmFlairMediaEffect;
}

function applyBanner(banner: HTMLElement, url: string, flair?: ProfilePresentation, ownerId?: string) {
    // Presentation is updated before the idempotency check so a tier upgrade or
    // a changed owner preference repaints the current media without refetching
    // the same GIF/video. Defaults remain Discordmaxxer's existing cover/center
    // rendering, so FREE media is never downgraded.
    applyBannerPresentation(banner, flair);
    if (ownerId) banner.dataset.dmFlairBannerOwnerId = ownerId;
    const failedUrl = banner.dataset.dmFlairBannerFailedUrl;
    const failedAt = Number(banner.dataset.dmFlairBannerFailedAt ?? 0);
    const isVideo = isVideoUrl(url);
    const selector = isVideo ? ".dm-flair-banner-video" : ".dm-flair-banner-image";
    const appliedOverlay = banner.querySelector(selector);
    // Do not recreate a media element that is already visible or currently
    // loading. The observer runs frequently while a popout is opening.
    if (banner.dataset.dmFlairBannerAppliedUrl === url && appliedOverlay) {
        if (appliedOverlay instanceof HTMLVideoElement) {
            const speed = profileMediaPlaybackRate(flair?.mediaSpeed);
            appliedOverlay.playbackRate = speed;
            appliedOverlay.defaultPlaybackRate = speed;
        }
        return;
    }
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
    if (ownerId) banner.dataset.dmFlairBannerOwnerId = ownerId;
    if (!banner.hasAttribute("data-dm-flair-original-position")) {
        banner.dataset.dmFlairOriginalPosition = banner.style.position || "";
        if (!banner.style.position) banner.style.position = "relative";
    }

    banner.dataset.dmFlairBannerLoadingUrl = url;
    const finish = (media: HTMLVideoElement | HTMLImageElement) => {
        // A newer scan may have replaced or cleared this request. Never let a
        // late load from an old profile paint over the current native banner.
        if (banner.dataset.dmFlairBannerLoadingUrl !== url
            || (ownerId && banner.dataset.dmFlairBannerOwnerId !== ownerId)) {
            media.remove();
            return;
        }
        delete banner.dataset.dmFlairBannerLoadingUrl;
        delete banner.dataset.dmFlairBannerFailedUrl;
        delete banner.dataset.dmFlairBannerFailedAt;
        media.style.opacity = "1";
        banner.dataset.dmFlairBannerAppliedUrl = url;
        if (ownerId) banner.dataset.dmFlairBannerOwnerId = ownerId;
        banner.setAttribute("data-dm-flair-banner-applied", "1");
        if (media instanceof HTMLVideoElement) {
            const speed = profileMediaPlaybackRate(flair?.mediaSpeed);
            media.playbackRate = speed;
            media.defaultPlaybackRate = speed;
            media.play().catch(() => {});
        }
    };
    const fail = () => {
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
        v.playbackRate = profileMediaPlaybackRate(flair?.mediaSpeed);
        v.defaultPlaybackRate = v.playbackRate;
        if (/\/profile-media\/\d{17,20}\/(?:banner|avatar)\/[0-9a-f-]{36}(?:\?|$)/i.test(url)) {
            const posterUrl = `${url}${url.includes("?") ? "&" : "?"}dmx-poster=1`;
            v.poster = isSharedProfileMediaUrl(url) ? proxyVideoUrl(posterUrl) : posterUrl;
        }
        v.onloadeddata = () => finish(v);
        v.onerror = fail;
        banner.appendChild(v);
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
    image.src = isSharedProfileMediaUrl(url) ? proxyVideoUrl(url) : url;
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
    if (!container.hasAttribute("data-dm-flair-theme-applied")) return;
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
    const renderUrl = isSharedProfileMediaUrl(url) ? proxyVideoUrl(url) : url;
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
        avatar.src = renderUrl;
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
    probe.src = renderUrl;
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
    const renderUrl = isSharedProfileMediaUrl(url) ? proxyVideoUrl(url) : url;
    const newBg = `url("${renderUrl}")`;
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
            clearBanner(banner);
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
            if (preserveProfileVisualDuringPendingRoster(container, banner, null)) continue;
            clearBanner(banner);
            clearTheme(container);
            clearProfileVisualPending(container);
            continue;
        }

        // The profile identity is known, but the shared roster may still be
        // fetching. Keep this exact owner's already-rendered media/gradient in
        // place until the authoritative result arrives. If the owner marker
        // belongs to a different user, the helper returns false and we clear
        // it immediately instead of leaking one profile into another.
        if (!rosterReady && preserveProfileVisualDuringPendingRoster(container, banner, userId)) continue;
        clearProfileVisualPending(container);

        const bannerFlair = resolveFlairForUserId(userId, "banner");
        if (bannerFlair?.bannerUrl) {
            const suppressForTM = tmActive && isAnimatedUrl(bannerFlair.bannerUrl);
            if (!suppressForTM) applyBanner(banner, bannerFlair.bannerUrl, bannerFlair, userId);
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
    const selfHasAvatarFlair = !!sa.myAvatarAnimatedUrl.trim();
    const othersAvatarFlair =
        sa.showOthersFlair && sa.showOthersAvatar && (!rosterReady || rosterHasAnyAvatarFlair());
    const anyAvatarFlair = selfHasAvatarFlair || othersAvatarFlair;
    const avatarRosterPending = !rosterReady && sa.showOthersFlair && sa.showOthersAvatar;

    // `resolveFlairForUserId` filters only animated media while TM is active;
    // keep scanning so a static shared avatar still renders during a match.
    if (anyAvatarFlair) {
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
            const avatarFlair = resolveFlairForUserId(userId, "avatar");
            if (avatarFlair?.avatarAnimatedUrl) {
                applyAvatar(el, avatarFlair.avatarAnimatedUrl, userId, avatarFlair);
            } else if (!avatarRosterPending || el.dataset.dmFlairAvatarUserId !== userId) {
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
            const avatarFlair = resolveFlairForUserId(userId, "avatar");
            if (avatarFlair?.avatarAnimatedUrl) {
                applyBackgroundAvatar(el, avatarFlair.avatarAnimatedUrl, userId, avatarFlair);
            } else if (!avatarRosterPending || el.dataset.dmFlairAvatarUserId !== userId) {
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
            const flair = resolveFlairForUserId(userId, "avatar");
            if (flair?.avatarAnimatedUrl) applyAvatar(a, flair.avatarAnimatedUrl, userId ?? undefined, flair);
            else if (!avatarRosterPending || a.dataset.dmFlairAvatarUserId !== userId) clearAvatar(a);
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
    } else {
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
}

function stopObserver() {
    removeRosterListener?.();
    removeRosterListener = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onRosterFocus);
    lastRosterRefreshAt = 0;
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
        delete e.dataset.dmFlairBannerAppliedUrl;
        delete e.dataset.dmFlairBannerLoadingUrl;
        delete e.dataset.dmFlairBannerOwnerId;
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

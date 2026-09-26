/*
 * Discordmaxxer — remote tier roster (Phase 1)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Fetches the project-wide tier roster on app startup and caches it for 30
 * seconds. The roster is a JSON file at a stable URL — see docs/v0.2-tier-
 * roster.md for the design and the migration path to the hub-site domain.
 *
 * NOT a Vencord plugin — just a shared utility imported by vip.ts. Lives
 * under plugins/_dm-shared/ which Vencord's build skips for plugin
 * registration (folders starting with "_") but still includes in the
 * bundle when imported.
 *
 * Phase 1 scope:
 *   - Fetch + parse + cache on first call
 *   - Expiration check (entries past expiresAt are ignored)
 *   - Synchronous read from cache via getRosterTier(userId)
 *   - Silent failure — bad fetch / parse / network = empty roster
 *
 * Phase 2+ adds: "renewing soon" UX, grace period, signed grants,
 * subscription webhook integration. Roadmap in the design doc.
 */

import { Tier } from "./vip";

// Live worker /roster endpoint — same Cloudflare Worker that handles VIP
// claims (see optimizationmaxxing/vip-worker/worker.js). Each /claim writes
// to KV and invalidates the worker's in-memory roster cache, so a freshly
// claimed user appears in the roster within seconds. Worker and client both
// use a 30 second freshness window so profile flair and tier changes converge
// without leaving a viewer on yesterday's cached entitlement.
const ROSTER_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/roster";

const CACHE_TTL_MS = 30 * 1000; // 30 seconds; matches the worker cache
const FETCH_RETRY_DELAY_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** Custom profile flair set by the user — visible only to other Discordmaxxer
 *  clients (channels E/F/G in DiscordmaxxerBadge). All fields optional; absent
 *  fields fall through to Discord's stock rendering. Media fields are
 *  tier-gated at ingest time: banner needs MAXXER and animated avatar needs
 *  MAXXER+. Theme colors are intentionally free for every Discordmaxxer user;
 *  a claim is still required to publish a shared roster value.
 *  Keeping the gates here means every consumer sees the same
 *  entitlement decision, even when an older worker payload contains stale
 *  profile fields after a tier changes. */
export interface ProfileFlair {
    /** https:// URL to image (png/jpg/webp/gif) or video for the
     *  profile-popout banner. 250 char URL cap; viewer plugin HEAD-checks
     *  Content-Length and bails on >5MB image / >15MB video. */
    bannerUrl?: string;
    /** https:// URL to an animated avatar (GIF or image). Replaces the user's
     *  Discord avatar in profile popouts (P2) and member list + chat (P5).
     *  Suppressed when TournamentMode is active. */
    avatarAnimatedUrl?: string;
    /** Hex string `#RRGGBB` — patched into Discord's
     *  `--profile-gradient-primary-color` CSS var on the popout root. */
    themeColorPrimary?: string;
    /** Hex string `#RRGGBB` — patched into `--profile-gradient-secondary-color`. */
    themeColorSecondary?: string;
}

/** Server-side profile-flair contract mirrored by the VIP worker. Keep this
 *  as the single client-side source of truth for the settings copy, roster
 *  sanitizer, and renderer. */
export const PROFILE_FIELD_MIN_TIER: Readonly<Record<keyof ProfileFlair, Tier>> = {
    bannerUrl: Tier.MAXXER,
    avatarAnimatedUrl: Tier.MAXXER_PLUS,
    themeColorPrimary: Tier.FREE,
    themeColorSecondary: Tier.FREE
};

interface RosterEntry {
    tier: Tier;
    via?: "owner" | "subscription" | "grant" | "comp" | "founder";
    grantedAt?: string;
    expiresAt?: string | null; // ISO 8601, null = never expires
    grantedBy?: string;
    /** Founder slot 1-33 if the user claimed a FNDR-prefixed code. Drives
     *  the gold # badge in profile popouts (TierFlair plugin). */
    founderNumber?: number;
    /** v2+ — user-set profile flair (banner / animated avatar / theme colors).
     *  Always optional. Missing on v1 payloads. */
    profile?: ProfileFlair;
    /** Last successful profile write, used for optimistic concurrency across
     *  PCs. */
    profileUpdatedAt?: number;
}

interface RosterPayload {
    version: number;
    issuedAt: string;
    users: Record<string, RosterEntry>;
}

interface CacheState {
    fetchedAt: number;
    retryAt: number;
    users: Record<string, RosterEntry>;
}

let cache: CacheState | null = null;
let inFlight: Promise<void> | null = null;
let avatarFlairFlag: { fetchedAt: number; value: boolean } | null = null;

// A successful profile write should be visible on the sender's own screen
// immediately, even if the next roster request lands on a different worker
// isolate before its KV read has caught up. This is deliberately short-lived:
// the shared roster remains the source of truth for every other viewer, and a
// later refresh naturally takes over once the worker has converged.
const OPTIMISTIC_PROFILE_TTL_MS = 2 * 60 * 1000;
let optimisticProfileCache: Record<string, ProfileFlair> = {};
let optimisticProfileExpiresAt: Record<string, number> = {};
let optimisticProfileUpdatedAt: Record<string, number> = {};
let optimisticProfileReplacesCurrent: Record<string, boolean> = {};

type RosterListener = () => void;
const rosterListeners = new Set<RosterListener>();

function notifyRosterListeners(): void {
    for (const listener of rosterListeners) {
        try { listener(); }
        catch (e) { console.warn("[Discordmaxxer roster] listener failed:", e); }
    }
}

/** Subscribe to a completed roster replacement. Consumers use this to repaint
 *  already-open profiles as soon as the async fetch resolves instead of
 *  waiting for a second profile open or the polling interval. */
export function onRosterChange(listener: RosterListener): () => void {
    rosterListeners.add(listener);
    return () => rosterListeners.delete(listener);
}

function replaceCache(users: Record<string, RosterEntry>): void {
    // A successful roster response is authoritative. Replacing the whole
    // snapshot prevents removed/expired/cleared cosmetic fields from living
    // forever in a side cache and lets a cross-PC delete converge normally.
    const optimisticUsers = new Set([
        ...Object.keys(optimisticProfileCache),
        ...Object.keys(optimisticProfileReplacesCurrent),
        ...Object.keys(optimisticProfileUpdatedAt)
    ]);
    for (const userId of optimisticUsers) {
        const serverUpdatedAt = users[userId]?.profileUpdatedAt;
        const localUpdatedAt = optimisticProfileUpdatedAt[userId];
        if (serverUpdatedAt !== undefined && (localUpdatedAt === undefined || serverUpdatedAt >= localUpdatedAt)) {
            delete optimisticProfileCache[userId];
            delete optimisticProfileExpiresAt[userId];
            delete optimisticProfileUpdatedAt[userId];
            delete optimisticProfileReplacesCurrent[userId];
        }
    }
    cache = { fetchedAt: Date.now(), retryAt: 0, users };
    avatarFlairFlag = null;
    notifyRosterListeners();
}

/** Highest version we know how to read. The worker may emit a lower version
 *  (e.g. v1 before the worker is redeployed with profile-flair support) — those
 *  payloads parse fine, they just have no `profile` field on any entry. We
 *  reject ABOVE this version because that'd be the worker shipping a schema we
 *  haven't taught the client yet. */
const SUPPORTED_VERSION = 2;

// The roster is remote data — even though it comes from our own worker, the
// client must not trust its shape. Validate URLs (https only) and colors at the
// single ingest point so every downstream consumer (DMProfileFlair injects
// these straight into element src / CSS) gets already-sanitized values. A
// non-https URL would otherwise bypass the dm-media:// proxy and a malformed
// one could break out of a CSS value.
const URL_RE = /^https:\/\/[^\s"']{1,242}$/i;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const VALID_TIERS = new Set<number>([Tier.FREE, Tier.MAXXER, Tier.MAXXER_PLUS, Tier.MAXXER_PLUS_PLUS]);

function isVideoProfileUrl(value: string): boolean {
    return /(?:[?&]dmx-media=video(?:&|#|$)|\.(?:mp4|webm|mov)(?:[?#]|$))/i.test(value);
}

function sanitizeProfile(p: any, tier: Tier): ProfileFlair | undefined {
    if (!p || typeof p !== "object") return undefined;
    const out: ProfileFlair = {};
    if (tier >= PROFILE_FIELD_MIN_TIER.bannerUrl && typeof p.bannerUrl === "string" && URL_RE.test(p.bannerUrl)) {
        out.bannerUrl = p.bannerUrl;
    }
    if (tier >= PROFILE_FIELD_MIN_TIER.avatarAnimatedUrl && typeof p.avatarAnimatedUrl === "string" && URL_RE.test(p.avatarAnimatedUrl) && !isVideoProfileUrl(p.avatarAnimatedUrl)) {
        out.avatarAnimatedUrl = p.avatarAnimatedUrl;
    }
    if (tier >= PROFILE_FIELD_MIN_TIER.themeColorPrimary && typeof p.themeColorPrimary === "string" && COLOR_RE.test(p.themeColorPrimary)) {
        out.themeColorPrimary = p.themeColorPrimary;
    }
    if (tier >= PROFILE_FIELD_MIN_TIER.themeColorSecondary && typeof p.themeColorSecondary === "string" && COLOR_RE.test(p.themeColorSecondary)) {
        out.themeColorSecondary = p.themeColorSecondary;
    }
    return Object.keys(out).length ? out : undefined;
}

function sanitizeUsers(raw: Record<string, any>): Record<string, RosterEntry> {
    const out: Record<string, RosterEntry> = {};
    for (const id in raw) {
        const e = raw[id];
        if (!e || typeof e !== "object") continue;
        const founderNumber = typeof e.founderNumber === "number" ? e.founderNumber : undefined;
        const tierNum = typeof e.tier === "number" ? e.tier : Number(e.tier);
        // Founder slots are always MAXXER++, and a higher numeric tier
        // includes every lower-tier benefit.
        const tier: Tier = Number.isInteger(founderNumber) && founderNumber >= 1 && founderNumber <= 33
            ? Tier.MAXXER_PLUS_PLUS
            : VALID_TIERS.has(tierNum)
                ? tierNum
                : tierNum >= Tier.MAXXER_PLUS_PLUS
                    ? Tier.MAXXER_PLUS_PLUS
                    : tierNum >= Tier.MAXXER_PLUS
                        ? Tier.MAXXER_PLUS
                        : tierNum >= Tier.MAXXER
                            ? Tier.MAXXER
                            : Tier.FREE;
        const entry: RosterEntry = { tier };
        if (typeof e.expiresAt === "string" || e.expiresAt === null) entry.expiresAt = e.expiresAt;
        if (typeof e.grantedAt === "string") entry.grantedAt = e.grantedAt;
        if (typeof e.grantedBy === "string") entry.grantedBy = e.grantedBy;
        if (typeof e.via === "string") entry.via = e.via;
        if (founderNumber !== undefined) entry.founderNumber = founderNumber;
        if (Number.isFinite(Number(e.profileUpdatedAt))) entry.profileUpdatedAt = Number(e.profileUpdatedAt);
        const prof = sanitizeProfile(e.profile, tier);
        if (prof) entry.profile = prof;
        out[id] = entry;
    }
    return out;
}

function isExpired(entry: RosterEntry): boolean {
    if (!entry.expiresAt) return false; // null / undefined = never expires
    const t = Date.parse(entry.expiresAt);
    if (isNaN(t)) return false; // bad date treated as never expires (safer than always-expired)
    return t < Date.now();
}

async function doFetch(): Promise<void> {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        const refreshUrl = `${ROSTER_URL}?dmx_refresh=${Date.now()}`;
        try {
            res = await fetch(refreshUrl, {
                cache: "no-store",
                headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
                signal: ctrl.signal
            });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            console.warn(`[Discordmaxxer roster] fetch ${ROSTER_URL} -> ${res.status}`);
            noteFetchFailure();
            return;
        }
        const payload = (await res.json()) as RosterPayload;
        if (typeof payload?.version !== "number" || payload.version > SUPPORTED_VERSION) {
            console.warn(`[Discordmaxxer roster] unsupported version: ${payload?.version}`);
            noteFetchFailure();
            return;
        }
        if (!payload.users || typeof payload.users !== "object") {
            console.warn("[Discordmaxxer roster] missing/invalid users map");
            noteFetchFailure();
            return;
        }
        replaceCache(sanitizeUsers(payload.users));
    } catch (e) {
        // Network error / abort / parse fail — keep the last good snapshot and
        // schedule a bounded retry instead of pretending the old data is new.
        console.warn("[Discordmaxxer roster] fetch failed:", (e as any)?.message ?? e);
        noteFetchFailure();
    }
}

function noteFetchFailure(): void {
    if (cache) cache.retryAt = Date.now() + FETCH_RETRY_DELAY_MS;
    else cache = { fetchedAt: 0, retryAt: Date.now() + FETCH_RETRY_DELAY_MS, users: {} };
}

function ensureFresh() {
    const now = Date.now();
    const stale = !cache || now - cache.fetchedAt > CACHE_TTL_MS;
    if (cache?.retryAt && now < cache.retryAt) return;
    if (!stale || inFlight) return;
    inFlight = doFetch().finally(() => { inFlight = null; });
}

/**
 * Synchronous lookup. Triggers a background refresh if the cache is stale or
 * empty, but always returns the current cached value (Tier.FREE if nothing
 * cached yet). Callers should accept that the very first call after launch
 * may return FREE for a roster-listed user — the next call (after the fetch
 * resolves) will see the elevated tier. UI surfaces that depend on tier
 * (badge, VIP card, presence gate) re-render on Vencord settings changes,
 * which is enough to pick up the roster on second paint.
 */
export function getRosterTier(userId: string): Tier {
    ensureFresh();
    if (!cache) return Tier.FREE;
    const entry = cache.users[userId];
    if (!entry || isExpired(entry)) return Tier.FREE;
    return entry.tier;
}

/** Force-refresh on demand (e.g., from a "Refresh roster" Hub button). */
export function refreshRoster(): Promise<void> {
    // Keep the last good snapshot visible while the refresh is in flight. A
    // transient worker/network failure should not make every open profile
    // fall back to FREE or lose its flair until the next successful fetch.
    if (cache) {
        cache.fetchedAt = 0;
        cache.retryAt = 0;
    }
    avatarFlairFlag = null;
    ensureFresh();
    return inFlight ?? Promise.resolve();
}

/** Diagnostic — used by the VIP card / Hub to show "Last synced: 12 min ago". */
export function getRosterStatus(): { fetchedAt: number | null; userCount: number } {
    return {
        fetchedAt: cache?.fetchedAt ?? null,
        userCount: cache ? Object.keys(cache.users).length : 0
    };
}

/** Fetch the founder number assigned to a user, if any. Used by the
 *  TierFlair plugin to render the gold # badge with the founder's slot. */
export function getRosterFounderNumber(userId: string): number | undefined {
    ensureFresh();
    if (!cache) return undefined;
    const entry = cache.users[userId];
    if (!entry || isExpired(entry)) return undefined;
    return entry.founderNumber;
}

/** Fetch the user-set profile flair for a user (banner, animated avatar, theme
 *  colors) — visible only to other Discordmaxxer clients. Returns undefined if
 *  the user hasn't set any flair or the current roster omitted/expired it. */
export function getRosterProfileFlair(userId: string): ProfileFlair | undefined {
    ensureFresh();
    const current = cache?.users[userId];
    const expiresAt = optimisticProfileExpiresAt[userId];
    if (expiresAt && expiresAt <= Date.now()) {
        delete optimisticProfileExpiresAt[userId];
        delete optimisticProfileCache[userId];
        delete optimisticProfileUpdatedAt[userId];
        delete optimisticProfileReplacesCurrent[userId];
    }
    const optimistic = optimisticProfileCache[userId];
    if (!current && !optimistic) return undefined;
    const merged = {
        ...(current && !optimisticProfileReplacesCurrent[userId] && !isExpired(current) ? (current.profile ?? {}) : {}),
        ...(optimistic ?? {})
    };
    return Object.keys(merged).length ? merged : undefined;
}

/** Last server write timestamp for optimistic concurrency between PCs. */
export function getRosterProfileUpdatedAt(userId: string): number | undefined {
    ensureFresh();
    if (optimisticProfileUpdatedAt[userId] !== undefined) return optimisticProfileUpdatedAt[userId];
    const entry = cache?.users[userId];
    if (!entry || isExpired(entry)) return undefined;
    return entry.profileUpdatedAt;
}

/**
 * Paint a just-saved profile locally before the public roster has converged.
 * Only known profile fields are accepted; callers still need a successful
 * worker response before treating this as published state.
 */
export function setOptimisticProfileFlair(userId: string, profile: Partial<ProfileFlair>, replace = false, updatedAt?: number): void {
    if (replace) optimisticProfileReplacesCurrent[userId] = true;
    if (Number.isFinite(updatedAt)) optimisticProfileUpdatedAt[userId] = updatedAt as number;
    const next = replace ? {} : { ...(optimisticProfileCache[userId] ?? {}) };
    for (const key of ["bannerUrl", "avatarAnimatedUrl", "themeColorPrimary", "themeColorSecondary"] as const) {
        const value = profile[key];
        if (value === undefined) continue;
        if (typeof value === "string" && value.length > 0) next[key] = value;
        else delete next[key];
    }
    if (Object.keys(next).length) {
        optimisticProfileCache[userId] = next;
        optimisticProfileExpiresAt[userId] = Date.now() + OPTIMISTIC_PROFILE_TTL_MS;
    } else if (replace) {
        // An empty full replacement is an intentional clear. Keep the
        // replacement marker until the roster reports the same/newer write so
        // an older cached profile cannot reappear on the sender's screen.
        delete optimisticProfileCache[userId];
        optimisticProfileExpiresAt[userId] = Date.now() + OPTIMISTIC_PROFILE_TTL_MS;
        optimisticProfileReplacesCurrent[userId] = true;
    } else {
        delete optimisticProfileCache[userId];
        delete optimisticProfileExpiresAt[userId];
        delete optimisticProfileUpdatedAt[userId];
        delete optimisticProfileReplacesCurrent[userId];
    }
    notifyRosterListeners();
}

/** Clear the sender-side preview after a failed save or an explicit reset. */
export function clearOptimisticProfileFlair(userId: string): void {
    if (!optimisticProfileCache[userId] && !optimisticProfileExpiresAt[userId]) return;
    delete optimisticProfileCache[userId];
    delete optimisticProfileExpiresAt[userId];
    delete optimisticProfileUpdatedAt[userId];
    delete optimisticProfileReplacesCurrent[userId];
    notifyRosterListeners();
}

/** Cheap, memoized: does ANY non-expired roster user carry an animated-avatar
 *  flair? Lets DMProfileFlair's page-wide <img>/background scan early-out
 *  entirely when nobody (besides possibly self) has avatar flair — the common
 *  case in most servers. The O(n) roster walk runs only when the underlying
 *  cache is replaced (~once/30 sec); every other call is O(1). */
export function rosterHasAnyAvatarFlair(): boolean {
    ensureFresh();
    if (!cache) return false;
    const cacheStamp = cache?.fetchedAt ?? 0;
    if (avatarFlairFlag?.fetchedAt === cacheStamp) return avatarFlairFlag.value;
    let value = false;
    for (const id of Object.keys(cache.users)) {
        const profile = getRosterProfileFlair(id);
        if (profile?.avatarAnimatedUrl) {
            value = true;
            break;
        }
    }
    avatarFlairFlag = { fetchedAt: cacheStamp, value };
    return value;
}

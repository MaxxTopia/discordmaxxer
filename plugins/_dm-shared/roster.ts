/*
 * Discordmaxxer — remote tier roster (Phase 1)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Fetches the project-wide tier roster on app startup and caches it for 1
 * hour. The roster is a JSON file at a stable URL — see docs/v0.2-tier-
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
// claimed user appears in the roster within seconds. Worker caches the
// response for 5 min server-side; client caches for 1 hour locally.
const ROSTER_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/roster";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 8000;

/** Custom profile flair set by the user — visible only to other Discordmaxxer
 *  clients (channels E/F/G in DiscordmaxxerBadge). All fields optional; absent
 *  fields fall through to Discord's stock rendering. Tier-gated at render time:
 *  banner needs MAXXER+; avatar needs MAXXER+; theme colors need MAXXER++. */
export interface ProfileFlair {
    /** https:// URL to image (png/jpg/webp/gif) or short MP4 video for the
     *  profile-popout banner. ~256 char URL cap; viewer plugin HEAD-checks
     *  Content-Length and bails on >5MB image / >15MB video. */
    bannerUrl?: string;
    /** https:// URL to an animated avatar (GIF or MP4). Replaces the user's
     *  Discord avatar in profile popouts (P2) and member list + chat (P5).
     *  Suppressed when TournamentMode is active. */
    avatarAnimatedUrl?: string;
    /** Hex string `#RRGGBB` — patched into Discord's
     *  `--profile-gradient-primary-color` CSS var on the popout root. */
    themeColorPrimary?: string;
    /** Hex string `#RRGGBB` — patched into `--profile-gradient-secondary-color`. */
    themeColorSecondary?: string;
}

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
}

interface RosterPayload {
    version: number;
    issuedAt: string;
    users: Record<string, RosterEntry>;
}

interface CacheState {
    fetchedAt: number;
    users: Record<string, RosterEntry>;
}

let cache: CacheState | null = null;
let inFlight: Promise<void> | null = null;

/** Highest version we know how to read. The worker may emit a lower version
 *  (e.g. v1 before the worker is redeployed with profile-flair support) — those
 *  payloads parse fine, they just have no `profile` field on any entry. We
 *  reject ABOVE this version because that'd be the worker shipping a schema we
 *  haven't taught the client yet. */
const SUPPORTED_VERSION = 2;

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
        try {
            res = await fetch(ROSTER_URL, { cache: "no-cache", signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            console.warn(`[Discordmaxxer roster] fetch ${ROSTER_URL} -> ${res.status}`);
            cache = { fetchedAt: Date.now(), users: cache?.users ?? {} };
            return;
        }
        const payload = (await res.json()) as RosterPayload;
        if (typeof payload?.version !== "number" || payload.version > SUPPORTED_VERSION) {
            console.warn(`[Discordmaxxer roster] unsupported version: ${payload?.version}`);
            cache = { fetchedAt: Date.now(), users: cache?.users ?? {} };
            return;
        }
        if (!payload.users || typeof payload.users !== "object") {
            console.warn("[Discordmaxxer roster] missing/invalid users map");
            cache = { fetchedAt: Date.now(), users: cache?.users ?? {} };
            return;
        }
        cache = { fetchedAt: Date.now(), users: payload.users };
    } catch (e) {
        // Network error / abort / parse fail — keep prior cache if any, just
        // refresh the timestamp so we don't hammer the URL on every read.
        console.warn("[Discordmaxxer roster] fetch failed:", (e as any)?.message ?? e);
        cache = { fetchedAt: Date.now(), users: cache?.users ?? {} };
    }
}

function ensureFresh() {
    const stale = !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
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
    cache = null;
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
 *  the user hasn't set any flair, isn't on the roster, or their roster entry is
 *  expired. v1 worker payloads always return undefined here; v2+ may include. */
export function getRosterProfileFlair(userId: string): ProfileFlair | undefined {
    ensureFresh();
    if (!cache) return undefined;
    const entry = cache.users[userId];
    if (!entry || isExpired(entry)) return undefined;
    return entry.profile;
}

let avatarFlairFlag: { fetchedAt: number; value: boolean } | null = null;
/** Cheap, memoized: does ANY non-expired roster user carry an animated-avatar
 *  flair? Lets DMProfileFlair's page-wide <img>/background scan early-out
 *  entirely when nobody (besides possibly self) has avatar flair — the common
 *  case in most servers. The O(n) roster walk runs only when the underlying
 *  cache is replaced (~once/hour); every other call is O(1). */
export function rosterHasAnyAvatarFlair(): boolean {
    ensureFresh();
    if (!cache) return false;
    if (avatarFlairFlag?.fetchedAt === cache.fetchedAt) return avatarFlairFlag.value;
    let value = false;
    for (const id in cache.users) {
        const e = cache.users[id];
        if (e.profile?.avatarAnimatedUrl && !isExpired(e)) {
            value = true;
            break;
        }
    }
    avatarFlairFlag = { fetchedAt: cache.fetchedAt, value };
    return value;
}

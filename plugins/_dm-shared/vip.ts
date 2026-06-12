/*
 * Discordmaxxer — VIP tier system
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Internal tier ladder (Hypixel-style) for gating premium features. Tiers
 * cascade: a higher tier grants access to all lower-tier features.
 *
 * v0.1: hardcoded supporter list. Real payment integration is its own project.
 *
 * NOT a Vencord plugin — just a shared utility imported by plugins that need
 * tier checks. Lives under plugins/_dm-shared/ which Vencord's build skips
 * (folders starting with "_").
 */

import { UserStore } from "@webpack/common";

import "./migrateLegacySettings";
import { getRosterTier } from "./roster";

export const enum Tier {
    FREE = 0,
    MAXXER = 1,
    MAXXER_PLUS = 2,
    MAXXER_PLUS_PLUS = 3
}

export const TIER_LABELS: Record<Tier, string> = {
    [Tier.FREE]: "FREE",
    [Tier.MAXXER]: "MAXXER",
    [Tier.MAXXER_PLUS]: "MAXXER+",
    [Tier.MAXXER_PLUS_PLUS]: "MAXXER++"
};

// Hardcoded supporter list. Replace with remote-fetched JSON in a later
// session once we have the GitHub-Pages users.json infrastructure live.
const HARDCODED_TIERS: Record<string, Tier> = {
    "426146621424664586": Tier.MAXXER_PLUS_PLUS // Diggy (project owner)
};

// Hardcoded admin list — only these users can use DiscordmaxxerGrant
// (right-click -> Grant Tier) and only their local grants are honored
// when rendering OTHER users' tier badges. Self-tier resolution NEVER
// reads local grants — only HARDCODED_TIERS or a worker-validated
// VipClaim binding. This is the structural fix against settings.json
// editing for self-promotion.
const ADMINS: ReadonlySet<string> = new Set([
    "426146621424664586" // Diggy
]);

export function isAdmin(userId?: string): boolean {
    if (userId) return ADMINS.has(userId);
    try {
        const me = UserStore.getCurrentUser();
        return !!me?.id && ADMINS.has(me.id);
    } catch {
        return false;
    }
}

/** Read tier from the VipClaim binding cache without importing vipClaim.ts
 *  (avoids circular dep — vipClaim imports vip for the Tier enum).
 *
 *  Uses the same `dm-vip-claim` DataStore key as vipClaim.ts. We populate
 *  a local cache on module init; first read before DataStore loads briefly
 *  returns FREE but plugin start happens AFTER DataStore is ready so this
 *  is invisible in practice. */
let claimCache: any = null;
import * as DataStore from "@api/DataStore";
DataStore.get<any>("dm-vip-claim").then(v => {
    if (v && typeof v === "object") claimCache = v;
}).catch(() => {});

/** Push a freshly-written VipClaim binding into this module's cache so
 *  getMyTier() reflects a new claim IMMEDIATELY, without an app restart.
 *  Called by vipClaim.writeBinding() (the existing vipClaim → vip import
 *  direction, so no circular dependency is introduced). Previously vip.ts's
 *  claimCache was populated only once at module init, so a just-redeemed code
 *  left tier-gated features (VideoBackground, DMVotes) locked until relaunch. */
export function setClaimCache(binding: any): void {
    claimCache = binding && typeof binding === "object" ? binding : null;
}

function tierFromClaimCache(): Tier {
    try {
        const b = claimCache;
        if (!b) return Tier.FREE;
        if (typeof b?.tier !== "number") return Tier.FREE;
        // Honor subscription expiry if the binding carries one (mirrors
        // vipClaim.tierFromCachedBinding so both readers agree).
        if (typeof b?.expiresAt === "number" && Date.now() > b.expiresAt) return Tier.FREE;
        const ageMs = Date.now() - (b?.lastValidatedAt ?? 0);
        if (ageMs > 24 * 60 * 60 * 1000) return Tier.FREE; // offline trust window
        return b.tier as Tier;
    } catch {
        return Tier.FREE;
    }
}

// Local grants are managed by the DiscordmaxxerGrant plugin (right-click any
// user -> Grant Discordmaxxer Tier). We read them via Vencord.PlainSettings
// instead of importing the plugin to avoid a circular dep — vip.ts gets
// imported by plugins, including DiscordmaxxerGrant itself.
function getLocalGrants(): Record<string, Tier> {
    try {
        const raw = (globalThis as any).Vencord?.PlainSettings?.plugins?.DiscordmaxxerGrant?.grants;
        if (!raw) return {};
        return JSON.parse(raw) as Record<string, Tier>;
    } catch {
        return {};
    }
}

export function getUserTier(userId: string): Tier {
    // Resolution order:
    //   1. HARDCODED_TIERS — project-owner / fallback baked into the build
    //   2. remote roster   — central source of truth (subscriptions + grants)
    //   3. local grants    — admin-only; ignored for non-admin viewers
    //   4. FREE
    if (HARDCODED_TIERS[userId] !== undefined) return HARDCODED_TIERS[userId];
    const remote = getRosterTier(userId);
    if (remote !== Tier.FREE) return remote;
    if (isAdmin()) {
        const grants = getLocalGrants();
        return grants[userId] ?? Tier.FREE;
    }
    return Tier.FREE;
}

export function getMyTier(): Tier {
    const me = UserStore.getCurrentUser();
    if (!me?.id) return Tier.FREE;
    // Self-tier resolution NEVER reads local grants — that path is only
    // for admins decorating OTHER users' badges. For self, use only:
    //   1. HARDCODED_TIERS  — admin baked into the build
    //   2. claim cache      — worker-validated VIP code binding
    //   3. remote roster    — central source of truth (subscriptions +
    //                        Discord-role auto-grants). Without this,
    //                        users granted a tier via Discord role (no
    //                        in-app code redemption) saw FREE for self
    //                        and got the lockout on tier-gated features
    //                        like VideoBackground.
    //   4. FREE
    if (HARDCODED_TIERS[me.id] !== undefined) return HARDCODED_TIERS[me.id];
    const cached = tierFromClaimCache();
    if (cached !== Tier.FREE) return cached;
    const roster = getRosterTier(me.id);
    if (roster !== Tier.FREE) return roster;
    return Tier.FREE;
}

export function hasTier(required: Tier): boolean {
    return getMyTier() >= required;
}

export function tierGateMessage(required: Tier): string {
    const my = TIER_LABELS[getMyTier()];
    const need = TIER_LABELS[required];
    return `${need} required (you are ${my}). Visit maxxtopia.com/discordmaxxer/vip`;
}

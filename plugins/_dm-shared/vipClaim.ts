/*
 * Discordmaxxer — VIP claim client
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Talks to the Cloudflare Worker that serves as the first-claim-wins
 * ledger for VIP redemption codes. The same worker shared with
 * optimizationmaxxing — codes are interchangeable across products
 * because both compute HWID the same way (BIOS UUID + serial + CPU).
 *
 * Worker contract (POST /claim):
 *   request:  { code, hwid }
 *   response 200 + status="claimed":    new claim, code now bound
 *   response 200 + status="idempotent": same code+hwid as before, OK
 *   response 409:                        code claimed by a different rig
 *   response 400:                        malformed code or hwid
 *
 * Validation strategy: on plugin start, re-POST stored {code, hwid} to
 * the worker. Idempotent response keeps the binding alive. 409 wipes the
 * local binding (someone else claimed it OR we changed rigs). Network
 * failure trusts the cache for 24h before downgrading to FREE.
 */

import * as DataStore from "@api/DataStore";

import { setClaimCache, Tier } from "./vip";

export const WORKER_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/claim";

export interface ClaimBinding {
    /** The 16-char Crockford code (no MAXX- prefix, no dashes). */
    code: string;
    /** The HWID this binding is locked to. */
    hwid: string;
    /** Tier granted by this binding. Reflected from the worker response;
     *  v0.6+ worker derives per-code tier from metadata. Legacy bindings
     *  default to MAXXER_PLUS_PLUS. */
    tier: Tier;
    /** Unix ms when last successfully validated against the worker. */
    lastValidatedAt: number;
    /** Unix ms when the original claim happened. */
    claimedAt: number;
    /** Founder slot number 1-33 if this code came from the Founder pool;
     *  undefined for regular MAXX-* codes. Set by the worker on first claim
     *  via a sequential KV counter; preserved in the local cache so the
     *  TierFlair plugin (v0.6.1+) can render the # badge without a round-trip. */
    founderNumber?: number;
    /** Unix ms when this binding expires (worker-set). Undefined =
     *  lifetime. tierFromCachedBinding() returns FREE once we're past
     *  this without needing a network round-trip. */
    expiresAt?: number;
    /** Product scope from the worker: "om" | "dm" | "both". Diagnostic;
     *  not used for client-side enforcement (worker is authoritative). */
    scope?: string;
}

export const OFFLINE_TRUST_MS = 24 * 60 * 60 * 1000; // 24 hours
export const RE_VALIDATE_AFTER_MS = 60 * 60 * 1000; // 1 hour

const CODE_RE = /^[0-9A-HJKMNP-Z]{16}$/;

/** Strip MAXX- prefix + dashes, uppercase. Matches worker normalization. */
export function normalizeCode(input: string): string {
    return input
        .toUpperCase()
        .replace(/^MAXX-?/, "")
        .replace(/[\s-]/g, "");
}

export function isValidCode(input: string): boolean {
    return CODE_RE.test(normalizeCode(input));
}

export interface ClaimResult {
    ok: boolean;
    status?: "claimed" | "idempotent" | "expired" | "scope-mismatch";
    error?: string;
    boundHwid?: string;
    /** When the worker recognises a Founder code, it assigns the next
     *  sequential number (1-33) and returns it here. Stored in the
     *  ClaimBinding for permanent display by the TierFlair plugin. */
    founderNumber?: number;
    /** Tier the worker granted (1=MAXXER, 2=MAXXER+, 3=MAXXER++). Absent
     *  for legacy worker responses; caller should default to
     *  MAXXER_PLUS_PLUS when missing. */
    tier?: number;
    /** Unix epoch millis when the subscription expires. Absent = lifetime.
     *  Stored in the ClaimBinding; the plugin proactively drops the
     *  binding to FREE once Date.now() > expiresAt without waiting for
     *  the next re-validation cycle. */
    expiresAt?: number;
    /** Product scope: "om" | "dm" | "both". Returned for diagnostics +
     *  to confirm the scope-enforcement layer is engaged. */
    scope?: string;
}

/** First-time claim or idempotent re-claim against the worker. The userId
 *  is the Discord snowflake of the claiming user — required for the worker
 *  to include this binding in the public /roster (drives cross-user tier
 *  flair). Pass undefined only for backfill / re-validation paths where
 *  the caller hasn't loaded the current user yet. */
export async function claimAgainstWorker(code: string, hwid: string, userId?: string): Promise<ClaimResult> {
    try {
        const res = await fetch(WORKER_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                code: normalizeCode(code),
                hwid,
                // Identifies this claim as coming from Discordmaxxer. The
                // worker uses this to enforce code scope: codes minted
                // with scope="om" (Optimizationmaxxing lifetime) get
                // rejected here with status="scope-mismatch". Legacy
                // codes minted before the schema upgrade have no scope
                // metadata and are treated as scope="both", so this
                // field is transparent to them.
                product: "dm",
                ...(userId ? { userId } : {})
            })
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body?.ok) {
            return {
                ok: true,
                status: body.status,
                boundHwid: body.boundHwid,
                founderNumber: typeof body.founderNumber === "number" ? body.founderNumber : undefined,
                tier: typeof body.tier === "number" ? body.tier : undefined,
                expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined,
                scope: typeof body.scope === "string" ? body.scope : undefined,
            };
        }
        // The worker returns 410 for expired subscriptions and 403 for
        // scope mismatches. Surface those distinctly so the caller can
        // wipe the binding (expired) vs show a "wrong product" error
        // (scope-mismatch) instead of generic "claim failed."
        const statusLabel = res.status === 410 ? "expired"
            : res.status === 403 ? "scope-mismatch"
            : undefined;
        return {
            ok: false,
            status: statusLabel,
            error: body?.error || `http ${res.status}`,
            boundHwid: body?.boundHwid,
        };
    } catch (e: any) {
        return { ok: false, error: `network: ${e?.message || e}` };
    }
}

/**
 * Validate an existing binding. Returns:
 *   - true if the worker confirms idempotent re-claim (binding is alive)
 *   - false if the worker rejects (claim was nuked or different hwid)
 *   - null if the network is unreachable (caller decides whether to trust cache)
 *
 * Pass the current Discord userId so pre-2026-05-10 claims (which were
 * stored without userId) get backfilled and start showing up in /roster.
 */
export async function reValidateBinding(b: ClaimBinding, userId?: string): Promise<boolean | null> {
    const r = await claimAgainstWorker(b.code, b.hwid, userId);
    if (r.ok && r.status === "idempotent") return true;
    if (r.ok && r.status === "claimed") return true; // first re-claim after worker KV reset
    if (!r.ok && r.error?.startsWith("network")) return null;
    // Expired or scope-mismatch are both terminal "this binding is no
    // longer valid" — caller wipes the local cache and downgrades to
    // FREE. (Worker schema v0.6+ — older worker responses don't carry
    // these statuses, fall through to false same as today.)
    if (r.status === "expired" || r.status === "scope-mismatch") return false;
    return false;
}

const STORE_KEY = "dm-vip-claim";

/**
 * Storage migration: modern Discord nukes `window.localStorage` (returns
 * undefined) to prevent token theft from injected scripts. The old
 * localStorage-backed binding silently broke — writeBinding's try/catch
 * swallowed the error, claims looked successful but the binding never
 * persisted, leaving every plugin that called readBinding() with a null
 * result.
 *
 * Migration to Vencord's DataStore (IndexedDB-backed). Sync API is
 * preserved via a module-level cache populated on first import; first read
 * before DataStore loads briefly returns null, but plugin start happens
 * after DataStore is available so this is invisible in practice.
 *
 * One-shot legacy migration: on init we check if localStorage somehow
 * still has the old value (older Discord builds, dev contexts, etc) and
 * copy it forward before clearing.
 */
let cache: ClaimBinding | null = null;
let loaded = false;

const validateShape = (b: any): ClaimBinding | null => {
    if (!b || typeof b !== "object") return null;
    if (typeof b.code !== "string" || typeof b.hwid !== "string") return null;
    if (!isValidCode(b.code) || b.hwid.length !== 32) return null;
    return b as ClaimBinding;
};

const initPromise = (async () => {
    // Try DataStore first.
    try {
        const stored = await DataStore.get<ClaimBinding>(STORE_KEY);
        const validated = validateShape(stored);
        if (validated) {
            cache = validated;
            loaded = true;
            return;
        }
    } catch (e) {
        console.warn("[vipClaim] DataStore.get failed:", e);
    }
    // Fall back to legacy localStorage (one-shot migration).
    try {
        const raw = (globalThis as any).localStorage?.getItem?.(STORE_KEY);
        if (raw) {
            const parsed = validateShape(JSON.parse(raw));
            if (parsed) {
                cache = parsed;
                // Forward-migrate so future reads come from DataStore.
                await DataStore.set(STORE_KEY, parsed);
                try { (globalThis as any).localStorage?.removeItem?.(STORE_KEY); } catch {}
                console.log("[vipClaim] migrated binding from localStorage → DataStore");
            }
        }
    } catch (e) {
        // localStorage is undefined in modern Discord — this catches the throw.
    }
    loaded = true;
})();

export function readBinding(): ClaimBinding | null {
    return cache;
}

/** Async version for callers that need to wait for DataStore to load (e.g.
 *  plugin start hooks). Most callers can use the sync readBinding() since
 *  DataStore loads in ~10ms during module init. */
export async function readBindingAsync(): Promise<ClaimBinding | null> {
    if (!loaded) await initPromise;
    return cache;
}

export function writeBinding(b: ClaimBinding | null): void {
    cache = b;
    // Keep vip.ts's separate claim cache in sync so getMyTier() reflects this
    // write immediately — otherwise a freshly-claimed code stays locked out of
    // tier-gated features until the next app restart.
    setClaimCache(b);
    // Persist async. Errors are logged but not surfaced — callers don't
    // typically await the write, and DataStore failures are rare.
    if (b === null) {
        DataStore.del(STORE_KEY).catch(e => console.warn("[vipClaim] DataStore.del:", e));
    } else {
        DataStore.set(STORE_KEY, b).catch(e => console.warn("[vipClaim] DataStore.set:", e));
    }
}

/**
 * Tier resolution from local binding alone (no network). Used for
 * synchronous tier checks. Trusts the cache for OFFLINE_TRUST_MS.
 */
export function tierFromCachedBinding(): Tier {
    const b = readBinding();
    if (!b) return Tier.FREE;
    // Subscription expiry (v0.6 worker schema). If the worker stamped
    // an expiresAt on this binding and we're past it, drop to FREE
    // without waiting for the next re-validation cycle.
    if (typeof b.expiresAt === "number" && Date.now() > b.expiresAt) {
        return Tier.FREE;
    }
    const ageMs = Date.now() - b.lastValidatedAt;
    if (ageMs < OFFLINE_TRUST_MS) return b.tier;
    return Tier.FREE;
}

/** Refresh a binding's lastValidatedAt without changing other fields. */
export function bumpValidatedAt(b: ClaimBinding): ClaimBinding {
    return { ...b, lastValidatedAt: Date.now() };
}

/** Async HWID retrieval via the VesktopNative bridge. */
export async function getMyHwid(): Promise<string | null> {
    try {
        const native = (globalThis as any).VesktopNative?.hwid;
        if (!native?.get) return null;
        const r = await native.get();
        if (r?.ok && typeof r.hwid === "string") return r.hwid;
        return null;
    } catch {
        return null;
    }
}

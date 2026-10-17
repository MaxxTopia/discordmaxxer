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
 * Validation strategy: on plugin start, POST stored {code, hwid} to the
 * worker's read-only /validate route. A successful response keeps the
 * binding alive and refreshes expiry metadata. Network failure trusts the
 * cache for 24h before downgrading to FREE; explicit server rejection is
 * terminal and clears the local binding.
 */

import * as DataStore from "@api/DataStore";

import { setClaimCache, Tier } from "./vip";

export const WORKER_URL = "https://optmaxxing-vip.maxxtopia.workers.dev/claim";
export const VALIDATE_URL = WORKER_URL.replace(/\/claim$/, "/validate");
export const FREE_CLAIM_START_URL = WORKER_URL.replace(/\/claim$/, "/free-claim/start");
export const FREE_CLAIM_STATUS_URL = WORKER_URL.replace(/\/claim$/, "/free-claim/status");

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
    expiresAt?: number | null;
    /** Product scope from the worker: "om" | "dm" | "both". Diagnostic;
     *  not used for client-side enforcement (worker is authoritative). */
    scope?: string;
    /** Last local wall-clock observation used to fail closed on rollback. */
    lastClientClockAt?: number;
}

export const OFFLINE_TRUST_MS = 24 * 60 * 60 * 1000; // 24 hours
export const RE_VALIDATE_AFTER_MS = 60 * 60 * 1000; // 1 hour

// Crockford base32 alphabet excludes I, L, O, AND U. The old class (…P-Z)
// admitted U; tighten to P-T,V-Z so the validator matches the alphabet exactly.
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

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
    status?: string;
    error?: string;
    boundHwid?: string;
    /** When the worker recognises a Founder code, it assigns the next
     *  sequential number (1-33) and returns it here. Stored in the
     *  ClaimBinding for permanent display by the TierFlair plugin. */
    founderNumber?: number;
    /** Tier the worker granted (0=FREE, 1=MAXXER, 2=MAXXER+, 3=MAXXER++). Absent
     *  for legacy worker responses; caller should default to
     *  MAXXER_PLUS_PLUS when missing. */
    tier?: number;
    /** Unix epoch millis when the subscription expires. Absent = lifetime.
     *  Stored in the ClaimBinding; the plugin proactively drops the
     *  binding to FREE once Date.now() > expiresAt without waiting for
     *  the next re-validation cycle. */
    expiresAt?: number | null;
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
                expiresAt: Object.prototype.hasOwnProperty.call(body, "expiresAt")
                    ? (typeof body.expiresAt === "number" ? body.expiresAt : null)
                    : undefined,
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

/** Read-only validation of an existing binding. */
export async function validateAgainstWorker(code: string, hwid: string): Promise<ClaimResult> {
    try {
        const res = await fetch(VALIDATE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: normalizeCode(code), hwid, product: "dm" })
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body?.ok) {
            return {
                ok: true,
                status: typeof body.status === "string" ? body.status : "valid",
                boundHwid: body.boundHwid,
                tier: typeof body.tier === "number" ? body.tier : undefined,
                expiresAt: Object.prototype.hasOwnProperty.call(body, "expiresAt")
                    ? (typeof body.expiresAt === "number" ? body.expiresAt : null)
                    : undefined,
                scope: typeof body.scope === "string" ? body.scope : undefined,
            };
        }
        return {
            ok: false,
            status: typeof body?.status === "string" ? body.status : (
                res.status === 410 ? "expired" :
                res.status === 404 ? "unclaimed" :
                res.status === 403 ? "scope_mismatch" :
                res.status === 409 ? "hwid_mismatch" : undefined
            ),
            error: body?.error || `http ${res.status}`,
            boundHwid: body?.boundHwid,
        };
    } catch (e: any) {
        return { ok: false, error: `network: ${e?.message || e}` };
    }
}

/**
 * Validate an existing binding without mutating the server ledger.
 * Returns null only when the network is unreachable, so the caller can use
 * the bounded offline grace window. Explicit Worker responses are returned
 * unchanged and are terminal when ok=false.
 */
export async function reValidateBinding(b: ClaimBinding): Promise<ClaimResult | null> {
    const r = await validateAgainstWorker(b.code, b.hwid);
    if (!r.ok && r.error?.startsWith("network")) return null;
    return r;
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

export interface FreeActivationResult {
    ok: boolean;
    binding?: ClaimBinding;
    status?: string;
    error?: string;
}

/**
 * Reserve the OAuth window while the user is still inside the click handler.
 * The activation request itself is asynchronous, so opening it later can be
 * rejected by normal popup protection. The caller keeps this handle and
 * activateFreeProfile navigates it after the worker creates the session.
 */
export function reserveFreeActivationWindow(): any | null {
    const openExternal = (globalThis as any).open;
    if (typeof openExternal !== "function") return null;
    try {
        // Do not pass `noopener,noreferrer` here: Chromium may return null for
        // that form, which prevents us from navigating the user-authorized tab.
        return openExternal.call(globalThis, "about:blank", "_blank") ?? null;
    } catch {
        return null;
    }
}

/**
 * Start the identity-checked free profile activation flow.
 *
 * The worker deliberately does not accept a userId from this request: the
 * caller could otherwise claim another person's visible Discord snowflake.
 * Instead, the worker creates a short-lived OAuth session, the browser asks
 * Discord who is authorizing it, and the client polls until the worker returns
 * the Tier 0 binding for this HWID.
 */
export async function activateFreeProfile(hwid: string, activationWindow?: any | null): Promise<FreeActivationResult> {
    const normalizedHwid = typeof hwid === "string" ? hwid.toLowerCase() : "";
    if (!/^[a-f0-9]{32}$/.test(normalizedHwid)) {
        try { activationWindow?.close?.(); } catch { /* best effort */ }
        return { ok: false, error: "HWID is not ready or has an invalid shape." };
    }

    const existing = readBinding();
    if (existing?.hwid?.toLowerCase() === normalizedHwid && existing.tier === Tier.FREE) {
        try { activationWindow?.close?.(); } catch { /* best effort */ }
        return { ok: true, status: "already-active", binding: existing };
    }

    try {
        // DMHub reserves this during its click handler. The dedicated claim
        // panel has no asynchronous work before calling us, so reserve here
        // when it did not receive a handle from its caller.
        const authorizationWindow = activationWindow ?? reserveFreeActivationWindow();
        if (!authorizationWindow) {
            return { ok: false, error: "Discord authorization was blocked. Allow the browser window and try again." };
        }

        const startResponse = await fetch(FREE_CLAIM_START_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hwid: normalizedHwid }),
            cache: "no-store",
        });
        const start = await startResponse.json().catch(() => ({}));
        if (!startResponse.ok || !start?.ok || typeof start.session !== "string" || typeof start.authorizeUrl !== "string") {
            try { authorizationWindow.close?.(); } catch { /* best effort */ }
            return { ok: false, error: start?.error || `free activation start failed (http ${startResponse.status})` };
        }

        try {
            authorizationWindow.location.href = start.authorizeUrl;
        } catch {
            try { authorizationWindow.close?.(); } catch { /* best effort */ }
            return { ok: false, error: "Could not navigate the Discord authorization window." };
        }

        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            const statusResponse = await fetch(
                `${FREE_CLAIM_STATUS_URL}?session=${encodeURIComponent(start.session)}`,
                { method: "GET", cache: "no-store" },
            );
            const status = await statusResponse.json().catch(() => ({}));
            if (status?.status === "claimed" && typeof status.code === "string" && isValidCode(status.code)) {
                const now = Date.now();
                const binding: ClaimBinding = {
                    code: normalizeCode(status.code),
                    hwid: normalizedHwid,
                    tier: Tier.FREE,
                    claimedAt: typeof status.claimedAt === "number" ? status.claimedAt : now,
                    lastValidatedAt: now,
                    scope: "dm",
                    lastClientClockAt: now,
                };
                writeBinding(binding);
                return { ok: true, status: "claimed", binding };
            }
            if (status?.status === "error" || status?.status === "expired" || statusResponse.status === 410) {
                return { ok: false, status: status.status, error: status.error || "free activation did not complete" };
            }
        }
        return { ok: false, status: "timeout", error: "Still waiting for Discord authorization. Open DMVipClaim and try again if you cancelled the browser step." };
    } catch (error: any) {
        return { ok: false, error: `network: ${error?.message || error}` };
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
    const now = Date.now();
    if (typeof b.lastClientClockAt === "number" && now + 5 * 60 * 1000 < b.lastClientClockAt) {
        return Tier.FREE;
    }
    const ageMs = now - b.lastValidatedAt;
    if (ageMs < OFFLINE_TRUST_MS) return b.tier;
    return Tier.FREE;
}

/** Refresh a binding's lastValidatedAt without changing other fields. */
export function bumpValidatedAt(
    b: ClaimBinding,
    validation?: Pick<ClaimResult, "tier" | "expiresAt" | "scope">,
): ClaimBinding {
    const now = Date.now();
    const rolledBack = typeof b.lastClientClockAt === "number"
        && now + 5 * 60 * 1000 < b.lastClientClockAt;
    return {
        ...b,
        lastValidatedAt: now,
        lastClientClockAt: rolledBack ? b.lastClientClockAt : now,
        ...(typeof validation?.tier === "number" && validation.tier >= Tier.FREE && validation.tier <= Tier.MAXXER_PLUS_PLUS
            ? { tier: validation.tier as Tier }
            : {}),
        ...(validation?.expiresAt !== undefined
            ? { expiresAt: validation.expiresAt ?? undefined }
            : {}),
        ...(validation?.scope !== undefined ? { scope: validation.scope } : {}),
    };
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

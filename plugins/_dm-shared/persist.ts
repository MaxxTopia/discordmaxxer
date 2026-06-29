/*
 * Discordmaxxer — shared persistent-value helper
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Modern Discord deletes `window.localStorage` (returns undefined) to prevent
 * token theft from injected scripts, so any plugin that persisted state via
 * localStorage silently broke — writes no-op'd and reads always returned the
 * fallback. This wraps Vencord's DataStore (IndexedDB-backed) behind a sync
 * read cache, mirroring the proven pattern in _dm-shared/vipClaim.ts.
 *
 * Usage:
 *   const slots = makePersistentValue<SavedSlot[]>("dm-video-bg-slots", [], validate);
 *   slots.get();          // sync read of the in-memory cache
 *   slots.set(next);      // updates cache + persists async
 *   await slots.ready;    // resolves once the initial DataStore load is done
 *
 * The cache is populated during module init (~10ms). A read before `ready`
 * resolves returns the fallback; React consumers should re-read after `ready`
 * (see VideoBackground's SavedSlotsPanel) so first paint isn't stale.
 */

import * as DataStore from "@api/DataStore";

export interface PersistentValue<T> {
    /** Sync read of the in-memory cache. */
    get(): T;
    /** Update the cache and persist asynchronously (errors are logged). */
    set(v: T): void;
    /** Resolves once the initial DataStore load (+ legacy migration) is done. */
    ready: Promise<void>;
}

export function makePersistentValue<T>(
    key: string,
    fallback: T,
    /** Optional validator/normalizer. Return null to reject the stored value
     *  (falls back). Defaults to accepting any non-null value as-is. */
    validate?: (raw: any) => T | null
): PersistentValue<T> {
    let cache: T = fallback;

    const accept = (raw: any): T | null => {
        if (raw == null) return null;
        return validate ? validate(raw) : (raw as T);
    };

    const ready = (async () => {
        // Prefer DataStore.
        try {
            const stored = await DataStore.get<T>(key);
            const v = accept(stored);
            if (v !== null) { cache = v; return; }
        } catch (e) {
            console.warn(`[persist:${key}] DataStore.get failed:`, e);
        }
        // One-shot legacy migration from localStorage (older Discord builds /
        // dev contexts where it still exists).
        try {
            const raw = (globalThis as any).localStorage?.getItem?.(key);
            if (raw) {
                const v = accept(JSON.parse(raw));
                if (v !== null) {
                    cache = v;
                    await DataStore.set(key, v);
                    try { (globalThis as any).localStorage?.removeItem?.(key); } catch {}
                    console.log(`[persist:${key}] migrated from localStorage → DataStore`);
                }
            }
        } catch {
            // localStorage is undefined in modern Discord — this catches the throw.
        }
    })();

    return {
        get: () => cache,
        set: (v: T) => {
            cache = v;
            DataStore.set(key, v).catch(e => console.warn(`[persist:${key}] DataStore.set:`, e));
        },
        ready
    };
}

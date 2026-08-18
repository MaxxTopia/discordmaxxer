/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Discordmaxxer — remote resilience config (client side of the failover system)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The client half of the one-tap voice-failover system (see the repo
 * `discordmaxxer-resilience` worker + RESILIENCE.md). On launch we read a tiny
 * JSON the worker serves and let it push a mitigation to every client WITHOUT a
 * new release — e.g. re-disable the zstd feature that once killed voice, roll a
 * bad plugin off, or show a "known issue" banner.
 *
 * IRON RULE: FAIL-OPEN. Every path here swallows its own errors and falls back
 * to the last cached config, then to a do-nothing default. This code runs at
 * startup, so a bug here must NEVER be able to block or slow launch — the safety
 * system can't be allowed to become the outage.
 *
 * Timing: Chromium feature flags must be set before the engine initialises, but
 * the fetch is async over the network. So we CACHE the fetched config to disk
 * and apply the CACHED copy synchronously at the next launch. A pushed flag fix
 * therefore lands on the launch after the one that fetched it (users are told to
 * restart anyway). Runtime bits (banner, disable_plugins) can apply same-launch.
 */

import { app } from "electron";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

import { IpcEvents } from "../shared/IpcEvents";
import { DATA_DIR } from "./constants";
import { handle } from "./utils/ipcWrappers";

const BASE = "https://discordmaxxer-resilience.maxxtopia.workers.dev";
const CONFIG_URL = BASE + "/config";
const INCIDENT_URL = BASE + "/incident";
const CACHE_PATH = join(DATA_DIR, "dm-resilience-config.json");
const FETCH_TIMEOUT_MS = 6000;
const MAX_LIST_ITEMS = 64;
const MAX_LIST_ITEM_LENGTH = 120;
const MAX_BANNER_TEXT_LENGTH = 600;
const MAX_URL_LENGTH = 2048;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_VERSION = /^v?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/;

export interface RemoteConfig {
    launch_flags_add: string[];
    launch_flags_remove: string[];
    disable_plugins: string[];
    banner: { level: string; text: string; url: string };
    min_supported_version?: string;
    force_update?: boolean;
}

const DEFAULT: RemoteConfig = {
    launch_flags_add: [],
    launch_flags_remove: [],
    disable_plugins: [],
    banner: { level: "none", text: "", url: "" }
};

function safeList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string" && SAFE_NAME.test(item))
        .map(item => item.slice(0, MAX_LIST_ITEM_LENGTH))
        .slice(0, MAX_LIST_ITEMS);
}

function safeHttpsUrl(value: unknown): string {
    if (typeof value !== "string") return "";
    const url = value.trim().slice(0, MAX_URL_LENGTH);
    return /^https:\/\//i.test(url) ? url : "";
}

/** Keep only the small, typed config surface the client actually consumes. */
function normalizeConfig(raw: unknown): RemoteConfig | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const rawBanner = value.banner && typeof value.banner === "object" ? (value.banner as Record<string, unknown>) : {};
    const rawVersion = typeof value.min_supported_version === "string" ? value.min_supported_version.trim() : "";
    const rawLevel = typeof rawBanner.level === "string" ? rawBanner.level : "none";
    const level = ["none", "info", "warn", "critical"].includes(rawLevel) ? rawLevel : "none";
    const rawText = typeof rawBanner.text === "string" ? rawBanner.text.trim() : "";

    return {
        launch_flags_add: safeList(value.launch_flags_add),
        launch_flags_remove: safeList(value.launch_flags_remove),
        disable_plugins: safeList(value.disable_plugins),
        banner: {
            level,
            text: rawText.slice(0, MAX_BANNER_TEXT_LENGTH),
            url: safeHttpsUrl(rawBanner.url)
        },
        ...(SAFE_VERSION.test(rawVersion) ? { min_supported_version: rawVersion } : {}),
        force_update: value.force_update === true
    };
}

/** Replace the cache as one filesystem operation; a partial write must not
 * destroy the last-known-good launch config. Failure leaves the old cache. */
function writeCachedConfig(config: RemoteConfig): void {
    const tempPath = `${CACHE_PATH}.tmp`;
    try {
        writeFileSync(tempPath, JSON.stringify(config), "utf8");
        renameSync(tempPath, CACHE_PATH);
    } catch {
        try {
            if (existsSync(tempPath)) unlinkSync(tempPath);
        } catch {
            /* best-effort cleanup; startup remains fail-open */
        }
    }
}

/** SYNC read of the on-disk cache. Never throws — returns DEFAULT on anything
 *  unexpected (missing file, bad JSON, partial shape). */
export function readCachedConfig(): RemoteConfig {
    try {
        if (!existsSync(CACHE_PATH)) return DEFAULT;
        return normalizeConfig(JSON.parse(readFileSync(CACHE_PATH, "utf8"))) ?? DEFAULT;
    } catch {
        return DEFAULT;
    }
}

/** Merge the cached config's Chromium feature-flag overrides into the
 *  disable-features set during init(), before the switch is applied.
 *    launch_flags_add    -> add these to disable-features (turn the feature OFF)
 *    launch_flags_remove -> stop disabling these (e.g. drop the zstd workaround
 *                           once Electron handles it, pushed remotely to test)
 *  Fail-open: any error leaves the built-in flags exactly as they were. */
export function applyRemoteLaunchFlags(disabledFeatures: Set<string>): void {
    try {
        const cfg = readCachedConfig();
        for (const f of cfg.launch_flags_add) if (typeof f === "string" && f) disabledFeatures.add(f);
        for (const f of cfg.launch_flags_remove) if (typeof f === "string" && f) disabledFeatures.delete(f);
    } catch {
        /* fail-open — never let this touch startup */
    }
}

/** ASYNC: fetch the fresh config after app-ready and cache it for next launch.
 *  Best-effort, time-boxed, never throws, never blocks the main flow. */
export async function refreshRemoteConfig(): Promise<void> {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(CONFIG_URL, { signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) return;
        const cfg = normalizeConfig(await res.json());
        if (cfg) writeCachedConfig(cfg);
    } catch {
        /* keep last-known-good cache; the system must never depend on the fetch */
    }
}

/** Report an anonymous voice-failure signature (count only — no user data).
 *  Used by the renderer detector via IPC (phase 2). Best-effort. */
export async function reportIncident(sig: string): Promise<void> {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            await fetch(INCIDENT_URL, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sig, ver: app.getVersion() }),
                signal: ctrl.signal
            });
        } finally {
            clearTimeout(timer);
        }
    } catch {
        /* best-effort */
    }
}

/** Runtime accessors for same-launch application (renderer banner / plugin kill). */
export function getResilienceBanner(): RemoteConfig["banner"] {
    return readCachedConfig().banner;
}
export function getRemotelyDisabledPlugins(): string[] {
    return readCachedConfig().disable_plugins;
}

/** Numeric dotted-version compare. -1 if a<b, 0 if equal, 1 if a>b. Tolerant of
 *  a leading "v" and differing segment counts; non-numeric segments count as 0. */
function versionCompare(a: string, b: string): number {
    const pa = String(a)
        .replace(/^v/i, "")
        .split(".")
        .map(n => parseInt(n, 10) || 0);
    const pb = String(b)
        .replace(/^v/i, "")
        .split(".")
        .map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}

const RELEASES_URL = "https://github.com/MaxxTopia/discordmaxxer/releases/latest";

export interface ResilienceState {
    banner: RemoteConfig["banner"];
    /** THIS build is below the remotely-declared minimum supported version. */
    versionOutdated: boolean;
    /** …and the remote is forcing everyone to update off this build. */
    forceUpdate: boolean;
    updateUrl: string;
}

/** The full same-launch resilience state for the renderer: the known-issue
 *  banner + whether this build is below min_supported_version (and whether the
 *  remote is forcing an update off it). Lets the failover system pull every
 *  client off a known-bad build without a new release. Fail-open → inert. */
export function getResilienceState(): ResilienceState {
    try {
        const cfg = readCachedConfig();
        let versionOutdated = false;
        if (typeof cfg.min_supported_version === "string" && cfg.min_supported_version) {
            versionOutdated = versionCompare(app.getVersion(), cfg.min_supported_version) < 0;
        }
        return {
            banner: cfg.banner,
            versionOutdated,
            forceUpdate: versionOutdated && cfg.force_update === true,
            updateUrl: cfg.banner.url || RELEASES_URL
        };
    } catch {
        return { banner: DEFAULT.banner, versionOutdated: false, forceUpdate: false, updateUrl: RELEASES_URL };
    }
}

// The renderer voice-fail detector (rtcStats.ts) can't POST to the worker
// directly — Discord's CSP blocks a cross-origin fetch from the renderer. So it
// hands the signature to the main process over IPC and we do the POST here.
// Registered at import (index.ts imports this module); best-effort, never throws.
handle(IpcEvents.DM_REPORT_INCIDENT, (_e, sig: string) => {
    void reportIncident(String(sig ?? "").slice(0, 40));
});

// The renderer asks for the same-launch resilience state (known-issue banner +
// forced-update verdict) so it can surface a Vencord notice. Sync + fail-open.
handle(IpcEvents.DM_GET_RESILIENCE_STATE, () => getResilienceState());

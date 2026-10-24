/*
 * Discordmaxxer — Playlistmaxxing Rich Presence plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Broadcasts "Listening to music.maxxtopia.com" on your Discord profile with
 * the live song title, artist, live progress bar, and album artwork when
 * broadcasting from Playlistmaxxing (music.maxxtopia.com) via Streammaxxing.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

const SOCKET_ID = "Playlistmaxxing";
const APP_ID = "1502451778426372116"; // Discordmaxxer asset resolver app
const SOURCE_LABEL = "music.maxxtopia.com";
const NAME = SOURCE_LABEL;
const URL = "https://music.maxxtopia.com";
const HUB_EVENTS = "http://127.0.0.1:4747/events";
const HUB_SNAPSHOT = "http://127.0.0.1:4747/nowplaying";
const POLL_INTERVAL_MS = 4_000;
const ACTIVITY_TYPE_LISTENING = 2;

type Song = {
    title?: string;
    artist?: string;
    art?: string;
    source?: string;
    durationMs?: number;
    progressMs?: number;
    playing?: boolean;
};

let current: Song | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let es: EventSource | null = null;
let refreshGeneration = 0;
let lastHeartbeat = 0;
let hubOfflineFailures = 0;
const assetCache = new Map<string, string>();

const settings = definePluginSettings({
    liveSync: {
        type: OptionType.BOOLEAN,
        description: "Live-sync the song you're playing in Playlistmaxxing (Broadcast on in web app + streammaxxing running).",
        default: true,
        onChange: () => reconnect()
    },
    showWhenIdle: {
        type: OptionType.BOOLEAN,
        description: "Keep showing presence even when no song is playing (off by default so it only appears when actively listening).",
        default: false,
        onChange: () => refresh()
    }
});

async function resolveAsset(url?: string): Promise<string | undefined> {
    if (!url) return undefined;
    const cached = assetCache.get(url);
    if (cached) return cached;
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(APP_ID, [url]);
        const id = ids?.[0] || url;
        assetCache.set(url, id);
        return id;
    } catch {
        return url;
    }
}

function setActivity(activity: any | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

async function buildActivity(): Promise<any | null> {
    const s = settings.store;
    const song = current;
    if (!song && !s.showWhenIdle) return null;
    if (song && !song.playing && !s.showWhenIdle) return null;

    const assets: Record<string, string> = {};
    if (song?.art) {
        const id = await resolveAsset(song.art);
        if (id) {
            assets.large_image = id;
            assets.large_text = song.title ? `${song.title}${song.artist ? ` by ${song.artist}` : ""}` : NAME;
        }
    }

    let timestamps: { start: number; end?: number } | undefined;
    if (song?.playing && song.durationMs && song.durationMs > 0) {
        const start = Date.now() - (song.progressMs || 0);
        timestamps = { start, end: start + song.durationMs };
    } else if (song?.playing) {
        timestamps = { start: Date.now() - (song.progressMs || 0) };
    }

    const details = song?.title || "Every platform. One playlist.";
    const state = song?.artist ? `${song.artist} • ${SOURCE_LABEL}` : SOURCE_LABEL;

    return {
        name: NAME,
        type: ACTIVITY_TYPE_LISTENING,
        details,
        state,
        flags: 1, // INSTANCE — keeps the entry stable
        assets: Object.keys(assets).length ? assets : undefined,
        timestamps,
        details_url: URL,
        state_url: URL
    };
}

async function refresh() {
    const generation = ++refreshGeneration;
    try {
        const activity = await buildActivity();
        if (generation === refreshGeneration) setActivity(activity);
    } catch { /* ignore */ }
}

function applyNowPlaying(d: any) {
    if (!d || d.t !== "nowplaying") return;
    if (d.kind === "idle" || d.is_playing === false) {
        current = null;
        lastHeartbeat = 0;
        void refresh();
        return;
    }
    if (d.kind !== "track") return;
    current = {
        title: d.title,
        artist: d.artist,
        art: d.art_url,
        source: d.source,
        durationMs: Number(d.duration_ms) || 0,
        progressMs: Number(d.progress_ms) || 0,
        playing: d.is_playing !== false
    };
    lastHeartbeat = Date.now();
    void refresh();
}

async function syncSnapshot() {
    if (!settings.store.liveSync) return;
    // If SSE EventSource is OPEN, it delivers instant track updates over push.
    // Avoid redundant HTTP fetch polling when SSE is already connected.
    if (es && es.readyState === EventSource.OPEN) {
        hubOfflineFailures = 0;
        return;
    }
    // If Discord is minimized or in background and nothing is playing, sleep
    if (document.hidden && !current?.playing) {
        return;
    }
    // If the local Streammaxxing hub is offline (127.0.0.1:4747), back off
    // polling to once every ~32 seconds to avoid constant rejected promise churn.
    if (hubOfflineFailures > 2 && (hubOfflineFailures % 8 !== 0)) {
        hubOfflineFailures++;
        return;
    }
    try {
        const response = await fetch(HUB_SNAPSHOT, { cache: "no-store" });
        if (!response.ok) {
            hubOfflineFailures++;
            handleHubDisconnect();
            return;
        }
        hubOfflineFailures = 0;
        applyNowPlaying(await response.json());
    } catch {
        hubOfflineFailures++;
        handleHubDisconnect();
    }
}

function handleHubDisconnect() {
    // If we were playing but haven't had a heartbeat in 15 seconds, clear the activity
    if (current && Date.now() - lastHeartbeat > 15_000 && !settings.store.showWhenIdle) {
        current = null;
        void refresh();
    }
}

function disconnect() {
    if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
}

function connect() {
    disconnect();
    if (!settings.store.liveSync) return;
    try {
        es = new EventSource(HUB_EVENTS);
        es.onmessage = (e: MessageEvent) => {
            let d: any;
            try { d = JSON.parse(e.data); } catch { return; }
            applyNowPlaying(d);
        };
        es.onerror = () => { /* EventSource auto-reconnects */ };
    } catch { /* EventSource unavailable */ }
}

function reconnect() {
    hubOfflineFailures = 0;
    connect();
    void syncSnapshot().finally(() => refresh());
}

export default definePlugin({
    name: "PlaylistmaxxingPresence",
    description: "Shows \"Listening to music.maxxtopia.com\" on your Discord — live-syncs the current song, artist, and album art when you Broadcast from Playlistmaxxing.",
    authors: [{ name: "Diggy", id: 0n }],
    enabledByDefault: true,
    settings,

    start() {
        void syncSnapshot().finally(() => refresh());
        pollTimer = setInterval(syncSnapshot, POLL_INTERVAL_MS);
        connect();
    },

    stop() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        disconnect();
        setActivity(null);
    }
});

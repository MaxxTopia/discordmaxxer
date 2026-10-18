import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

/* Playlistmaxxing rich presence.
   Shows "Listening to Playlistmaxxing" on your Discord profile (green LISTENING
   status, like Spotify). Static by default; if the streammaxxing hub is running
   and you've hit Broadcast in the web app, it live-upgrades to the current song
   (title / artist / album art / progress). The client listens for live SSE events
   and also polls a tiny current-track snapshot so starting the plugin after a
   song is already playing still catches up. */

const SOCKET_ID = "Playlistmaxxing";
const APP_ID = "1502451778426372116"; // Maxxtopia / discordmaxxer Discord application
const NAME = "Playlistmaxxing";
const BUTTON_LABEL = "Listen along";
const BUTTON_URL = "https://music.maxxtopia.com";
const HUB_EVENTS = "http://127.0.0.1:4747/events";
const HUB_NOWPLAYING = "http://127.0.0.1:4747/nowplaying";
const REFRESH_MS = 60_000;
const SNAPSHOT_REFRESH_MS = 10_000;
const ACTIVITY_TYPE_LISTENING = 2;

type Song = { title?: string; artist?: string; art?: string; durationMs?: number; progressMs?: number; playing?: boolean; };

let current: Song | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let es: EventSource | null = null;
const assetCache = new Map<string, string>();

const settings = definePluginSettings({
    liveSync: {
        type: OptionType.BOOLEAN,
        description: "Live-sync the song you're playing in Playlistmaxxing (needs streammaxxing running + Broadcast on in the web app).",
        default: true,
        onChange: () => reconnect()
    },
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show a \"Listen along\" button that opens music.maxxtopia.com.",
        default: true,
        onChange: () => refresh()
    },
    showWhenIdle: {
        type: OptionType.BOOLEAN,
        description: "Keep the static \"Listening to Playlistmaxxing\" card visible when no song is detected. It does not hide a live track.",
        default: true,
        onChange: () => refresh()
    }
});

async function resolveAsset(url?: string): Promise<string | undefined> {
    if (!url) return undefined;
    const cached = assetCache.get(url);
    if (cached) return cached;
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(APP_ID, [url]);
        const id = ids?.[0];
        if (id) assetCache.set(url, id);
        return id;
    } catch {
        return undefined;
    }
}

function setActivity(activity: any | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

async function buildActivity(): Promise<any | null> {
    const s = settings.store;
    const song = current;
    if (!song && !s.showWhenIdle) return null;

    const assets: Record<string, string> = {};
    if (song?.art) {
        // Playlistmaxxing already provides the exact public artwork shown in
        // its popout. Discord Rich Presence accepts public HTTP(S) artwork and
        // media-proxies it for viewers; treating the URL as an application
        // asset key made every track silently fall back to the app icon.
        if (/^https?:\/\//i.test(song.art)) {
            assets.large_image = song.art;
            assets.large_text = song.title || NAME;
        } else {
            const id = await resolveAsset(song.art);
            if (id) { assets.large_image = id; assets.large_text = song.title || NAME; }
        }
    }

    let timestamps: { start: number; end?: number; } | undefined;
    if (song?.playing && song.durationMs && song.durationMs > 0) {
        const start = Date.now() - (song.progressMs || 0);
        timestamps = { start, end: start + song.durationMs };
    }

    return {
        application_id: APP_ID,
        name: NAME,
        type: ACTIVITY_TYPE_LISTENING,
        details: song ? (song.title || "Now playing") : "Every platform. One playlist.",
        state: song ? (song.artist || undefined) : undefined,
        flags: 1, // INSTANCE — keeps the entry stable
        assets: Object.keys(assets).length ? assets : undefined,
        timestamps,
        buttons: s.showButton ? [BUTTON_LABEL] : undefined,
        metadata: s.showButton ? { button_urls: [BUTTON_URL] } : undefined
    };
}

async function refresh() {
    try { setActivity(await buildActivity()); } catch { /* ignore */ }
}

function disconnect() {
    if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
}

function applyNowPlaying(d: any) {
    if (!d || d.t !== "nowplaying") return;
    if (d.kind === "idle") {
        current = null;
        void refresh();
        return;
    }
    if (d.kind !== "track") return;
    current = {
        title: typeof d.title === "string" ? d.title : undefined,
        artist: typeof d.artist === "string" ? d.artist : undefined,
        art: typeof d.art_url === "string" ? d.art_url : undefined,
        durationMs: Number(d.duration_ms) || 0,
        progressMs: Number(d.progress_ms) || 0,
        playing: d.is_playing !== false
    };
    void refresh();
}

async function syncNowPlayingSnapshot() {
    if (!settings.store.liveSync) return;
    try {
        const response = await fetch(`${HUB_NOWPLAYING}?_=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        applyNowPlaying(await response.json());
    } catch {
        // The companion hub may not be running yet. Keep the static activity
        // behavior and let the next poll/EventSource reconnect recover it.
    }
}

function stopSnapshotPolling() {
    if (snapshotTimer) clearInterval(snapshotTimer);
    snapshotTimer = null;
}

function startSnapshotPolling() {
    stopSnapshotPolling();
    if (!settings.store.liveSync) return;
    void syncNowPlayingSnapshot();
    snapshotTimer = setInterval(() => { void syncNowPlayingSnapshot(); }, SNAPSHOT_REFRESH_MS);
}

function connect() {
    disconnect();
    if (!settings.store.liveSync) return;
    try {
        es = new EventSource(HUB_EVENTS);
        es.onopen = () => { void syncNowPlayingSnapshot(); };
        es.onmessage = (e: MessageEvent) => {
            let d: any;
            try { d = JSON.parse(e.data); } catch { return; }
            applyNowPlaying(d);
        };
        es.onerror = () => { void syncNowPlayingSnapshot(); };
    } catch { /* EventSource unavailable — static only */ }
}

function reconnect() {
    connect();
    startSnapshotPolling();
    if (!settings.store.liveSync) {
        current = null;
    }
    void refresh();
}

export default definePlugin({
    name: "PlaylistmaxxingPresence",
    description: "Shows \"Listening to Playlistmaxxing\" on your Discord — live-syncs the current song when you Broadcast from music.maxxtopia.com.",
    authors: [{ name: "Diggy", id: 0n }],
    enabledByDefault: true,
    settings,

    start() {
        refresh();
        timer = setInterval(refresh, REFRESH_MS);
        connect();
        startSnapshotPolling();
    },

    stop() {
        if (timer) clearInterval(timer);
        timer = null;
        stopSnapshotPolling();
        disconnect();
        current = null;
        setActivity(null);
    }
});

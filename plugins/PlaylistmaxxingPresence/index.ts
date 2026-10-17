import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

/* Playlistmaxxing rich presence.
   Shows "Listening to Playlistmaxxing" on your Discord profile (green LISTENING
   status, like Spotify). Static by default; if the streammaxxing hub is running
   and you've hit Broadcast in the web app, it live-upgrades to the current song
   (title / artist / album art / progress). The live path is best-effort — Discord
   runs over https, so a plain http://127.0.0.1 feed can be blocked; when it is,
   the static "Listening to Playlistmaxxing" badge still shows. */

const SOCKET_ID = "Playlistmaxxing";
const APP_ID = "1502451778426372116"; // Maxxtopia / discordmaxxer Discord application
const NAME = "Playlistmaxxing";
const BUTTON_LABEL = "Listen along";
const BUTTON_URL = "https://music.maxxtopia.com";
const HUB_EVENTS = "http://127.0.0.1:4747/events";
const REFRESH_MS = 60_000;
const ACTIVITY_TYPE_LISTENING = 2;

type Song = { title?: string; artist?: string; art?: string; durationMs?: number; progressMs?: number; playing?: boolean; };

let current: Song | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
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
        description: "Keep showing \"Listening to Playlistmaxxing\" even when no song is detected.",
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
        const id = await resolveAsset(song.art);
        if (id) { assets.large_image = id; assets.large_text = song.title || NAME; }
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

function connect() {
    disconnect();
    if (!settings.store.liveSync) return;
    try {
        es = new EventSource(HUB_EVENTS);
        es.onmessage = (e: MessageEvent) => {
            let d: any;
            try { d = JSON.parse(e.data); } catch { return; }
            if (!d || d.t !== "nowplaying") return;
            if (d.kind === "idle") { current = null; refresh(); return; }
            if (d.kind === "track") {
                current = {
                    title: d.title,
                    artist: d.artist,
                    art: d.art_url,
                    durationMs: Number(d.duration_ms) || 0,
                    progressMs: Number(d.progress_ms) || 0,
                    playing: d.is_playing !== false
                };
                refresh();
            }
        };
        es.onerror = () => { /* hub unreachable / blocked — keep the static badge */ };
    } catch { /* EventSource unavailable — static only */ }
}

function reconnect() { connect(); refresh(); }

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
    },

    stop() {
        if (timer) clearInterval(timer);
        timer = null;
        disconnect();
        setActivity(null);
    }
});

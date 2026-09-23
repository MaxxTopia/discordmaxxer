/*
 * Discordmaxxer — preset bundles (one-click enable a curated set)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Bundle {
    id: string;
    title: string;
    emoji: string;
    blurb: string;
    /** Vencord plugin ids to flip enabled:true on click. */
    plugins: string[];
}

export const BUNDLES: Bundle[] = [
    {
        id: "music",
        title: "Music & Vibes",
        emoji: "🎵",
        blurb: "Spotify mini-player above your username + share track commands.",
        plugins: ["SpotifyControls", "SpotifyShareCommands", "FixSpotifyEmbeds"]
    },
    {
        id: "streamer",
        title: "Streamer Loadout",
        emoji: "🎮",
        blurb: "Drops Discord's CPU/GPU load while gaming, hides clutter, fixes screenshare bugs.",
        plugins: [
            "TournamentMode",
            "CompactView",
            "WebScreenShareFixes"
        ]
    },
    {
        id: "privacy",
        title: "Privacy & Anti-track",
        emoji: "🛡️",
        blurb: "Kills Discord's analytics endpoints, strips tracking from links, stops the idle-disconnect heartbeat, and hides typing presence.",
        plugins: [
            "NoTrack",
            "ClearURLs",
            "DisableCallIdle",
            "SilentTyping"
        ]
    }
];

export function getBundle(id: string): Bundle | undefined {
    return BUNDLES.find(b => b.id === id);
}

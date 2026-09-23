/*
 * Discordmaxxer — featured plugin registry (used by DMWelcome's tour)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Hand-curated list of plugins to surface in the welcome modal + DMHub tour.
 * Each entry is a plain-English pitch that beats Vencord's cryptic descriptions.
 */

import { Tier } from "./vip";

export interface FeaturedPlugin {
    /** Vencord plugin id — matches the key under Vencord.Settings.plugins. */
    id: string;
    /** Display title shown on the card. */
    title: string;
    /** One-line plain-English pitch — what it does, why anyone cares. */
    oneLiner: string;
    /** Optional location hint ("above your username", "Ctrl+Shift+M"). */
    where?: string;
    /** Path under static/, served via vesktop://static/<path>. Optional. */
    gif?: string;
    /** Tier gate. If set, card shows a 🔒 badge for users without entitlement. */
    tier?: Tier;
    /** Emoji shown when no GIF is present (most cards). */
    emoji: string;
}

export const FEATURED_PLUGINS: FeaturedPlugin[] = [
    {
        id: "SpotifyControls",
        title: "Spotify in Discord",
        oneLiner: "Adds a Spotify mini-player above your username — skip tracks, scrub, and see what's playing without leaving Discord.",
        where: "Above your username, bottom-left.",
        emoji: "🎵",
        gif: "featured/spotifycontrols.gif"
    },
    {
        id: "DMProfileFlair",
        title: "Custom banners, animated PFPs + profile themes",
        oneLiner: "Choose a free local gradient or local media. Shared media needs the profile-media service and an eligible claim; native Discord changes are separate one-time actions. Other Discordmaxxer users see shared flair; vanilla Discord does not render Discordmaxxer-only flair.",
        where: "Open Profile Flair for Publish as shared..., Copy banner only, and the native Discord actions.",
        emoji: "✨",
        gif: "featured/dmprofileflair.gif"
    },
    {
        id: "FakeNitro",
        title: "Send any emoji, sticker, stream HD",
        oneLiner: "Adds client-side emoji and sticker conveniences where Discord allows them. It cannot unlock server-enforced Nitro limits; non-modded friends receive a clean fallback link when needed.",
        where: "Just send normally — auto-handled.",
        emoji: "🎉"
    },
    {
        id: "MessageLogger",
        title: "See deleted & edited messages",
        oneLiner: "Discord deletes are local-only on your end — messages stay visible with a 'deleted' tag. Edits show the previous version on hover.",
        where: "Greyed-out in the channel where it was deleted.",
        emoji: "👁️"
    },
    {
        id: "TournamentMode",
        title: "Gaming Mode",
        oneLiner: "One toggle lowers Discord's process priority, pauses costly background work, and disables rich-presence polling. A 30 FPS request is best-effort and may be ignored in normal windowed mode.",
        where: "Ctrl+Alt+T, or the DM Hub button.",
        emoji: "🎮"
    },
    {
        id: "VolumeBooster",
        title: "Boost user volume past 200%",
        oneLiner: "Right-click any user → adjust volume up to 500% if they're too quiet. Saves you yelling 'TURN UP YOUR MIC' all night.",
        where: "Right-click user → User Volume slider.",
        emoji: "🔊"
    },
    {
        id: "CompactView",
        title: "Compact View",
        oneLiner: "One hotkey hides the server list, channel list, and member list — just the chat. Made for vertical-monitor screenshare and minimal-clutter setups.",
        where: "Ctrl+Alt+H, or the DM Hub button.",
        emoji: "📐"
    },
    {
        id: "NoTrack",
        title: "Block Discord telemetry",
        oneLiner: "Discord pings /science and /tracking endpoints constantly with analytics. This kills those requests — saves bandwidth and shuts down the data hose.",
        where: "Silent — works in the background.",
        emoji: "🛡️"
    },
];

export function getFeatured(id: string): FeaturedPlugin | undefined {
    return FEATURED_PLUGINS.find(p => p.id === id);
}

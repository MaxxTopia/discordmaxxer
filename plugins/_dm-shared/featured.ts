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
    /** Built-in preview when a static image is a better fit than an asset. */
    preview?: "spotify" | "displayName";
    /** Related plugin ids controlled together by this card. */
    plugins?: string[];
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
        preview: "spotify",
        plugins: ["SpotifyControls", "SpotifyShareCommands", "FixSpotifyEmbeds"]
    },
    {
        id: "DMProfileFlair",
        title: "Animated PFPs + Custom Banners",
        oneLiner: "Use animated avatars, banners, and profile themes for free. Paid tiers add cross-PC publishing, faster sync, and extra presentation controls.",
        where: "Configure in Discordmaxxer settings → Profile Flair.",
        emoji: "✨",
        gif: "featured/dmprofileflair-2s.gif"
    },
    {
        id: "DMDisplayNameStyle",
        title: "Style your display name",
        oneLiner: "Browse 30 local looks with different fonts, colors, finishes, and motion. It changes how names are painted in Discordmaxxer; your real account name stays unchanged.",
        where: "DM Hub → Browse display-name looks.",
        emoji: "Aa",
        preview: "displayName"
    },
    {
        id: "FakeNitro",
        title: "Emoji, sticker & stream helpers",
        oneLiner: "Use eligible external emoji and stickers with normal send controls, plus Discordmaxxer's screen-share quality controls. Server-enforced Nitro limits still apply; non-modded friends get a clean fallback link.",
        where: "Send normally; choose resolution and FPS in the stream picker.",
        emoji: "🎉",
        plugins: ["FakeNitro", "GifPaste", "StickerPaste", "WebScreenShareFix"]
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
        title: "Gaming mode (Tournament Mode)",
        oneLiner: "The gaming-performance switch: lowers Discord's process priority, caps its renderer at 30 FPS, and pauses decorative animations so more headroom goes to your game.",
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

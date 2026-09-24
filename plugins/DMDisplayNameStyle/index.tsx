/*
 * Discordmaxxer — Display Name Style plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A local identity layer for Discord's rendered display-name labels. It
 * changes how a name is painted inside Discordmaxxer without changing the
 * Discord account name, user ID, mentions, search, accessibility text, or
 * what vanilla Discord users receive. Discord's own account-level Display
 * Name Styles are available separately through the native profile editor.
 *
 * The observer deliberately targets visible leaf labels inside known user
 * surfaces. It does not patch webpack modules or rewrite message contents.
 * Tournament Mode automatically disables name animation while leaving the
 * chosen colors and typography intact. The plugin does not follow the OS
 * reduced-motion preference.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { React, UserStore } from "@webpack/common";

import { DISPLAY_NAME_STYLE_PRESET_IDS, isDisplayNameStylePresetId } from "../_dm-shared/displayNameStylePresets";

const ROOT_ID = "dm-display-name-style-root";
const TARGET_ATTR = "data-dm-display-name-style";
const SURFACE_ATTR = "data-dm-display-name-surface";
const MOTION_ATTR = "data-dm-display-name-motion";
const MOTION_BLOCKED_ATTR = "data-dm-display-name-motion-blocked";
const ORNAMENT_ATTR = "data-dm-display-name-ornament";
const IGNORE_ATTR = "data-dm-display-name-style-ignore";

type Surface = "self" | "profile" | "member" | "message" | "dm" | "unknown";
type Effect = "clean" | "soft" | "neon" | "outline" | "holo" | "fire";
type Motion = "none" | "breathe" | "shimmer" | "scan" | "flicker" | "twinkle" | "electric";
type Ornament = "none" | "swash" | "flame" | "spark";
type PresetId = keyof typeof PRESETS;
type StyleCategory = "all" | "script" | "flame" | "gothic" | "arcade" | "luxe" | "dream";

interface StyleProfile {
    primary: string;
    secondary: string;
    highlight: string;
    glow: string;
    fontFamily: string;
    fontStyle?: "normal" | "italic";
    fontWeight: number;
    letterSpacing: string;
    textTransform: "none" | "uppercase";
    smallCaps: boolean;
    decoration: "none" | "underline" | "overline";
    effect: Effect;
    motion: Motion;
    ornament?: Ornament;
}

const FONT_FAMILIES = {
    system: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
    display: "\"Trebuchet MS\", \"Segoe UI\", sans-serif",
    rounded: "\"Arial Rounded MT Bold\", \"Trebuchet MS\", sans-serif",
    mono: "\"Cascadia Code\", Consolas, monospace",
    serif: "Georgia, \"Times New Roman\", serif",
    pixel: "\"Arial Black\", Impact, sans-serif",
    script: "\"DM Great Vibes\", \"Segoe Script\", \"Monotype Corsiva\", cursive",
    gothic: "\"DM Unifraktur Cook\", \"Old English Text MT\", fantasy",
    comic: "\"DM Bangers\", Impact, \"Arial Black\", sans-serif",
    hand: "\"Segoe Print\", \"Comic Sans MS\", cursive",
    future: "Bahnschrift, \"Agency FB\", \"Segoe UI\", sans-serif",
    western: "Rockwell, Georgia, serif"
} as const;

const PRESETS = {
    cottonCandy: {
        label: "Cotton Candy",
        blurb: "Pink-to-cobalt sweetness",
        primary: "#ff6ec7",
        secondary: "#4a73ff",
        highlight: "#fff4ff",
        glow: "rgba(255, 110, 199, 0.6)",
        fontFamily: FONT_FAMILIES.rounded,
        fontWeight: 750,
        letterSpacing: "0.01em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "soft",
        motion: "breathe"
    },
    neonArcade: {
        label: "Neon Arcade",
        blurb: "Cyan cabinet lights + violet glow",
        primary: "#00f5ff",
        secondary: "#9b5cff",
        highlight: "#ffffff",
        glow: "rgba(0, 245, 255, 0.72)",
        fontFamily: FONT_FAMILIES.display,
        fontWeight: 800,
        letterSpacing: "0.045em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "neon",
        motion: "shimmer"
    },
    holoChrome: {
        label: "Holo Chrome",
        blurb: "Iridescent silver with a light sweep",
        primary: "#f8fbff",
        secondary: "#8a7dff",
        highlight: "#b9fff4",
        glow: "rgba(185, 255, 244, 0.55)",
        fontFamily: FONT_FAMILIES.system,
        fontWeight: 700,
        letterSpacing: "0.02em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "holo",
        motion: "shimmer"
    },
    ember: {
        label: "Ember",
        blurb: "Hot gold fading into pink fire",
        primary: "#ffe08a",
        secondary: "#ff3d6e",
        highlight: "#fff7d1",
        glow: "rgba(255, 61, 110, 0.62)",
        fontFamily: FONT_FAMILIES.pixel,
        fontWeight: 800,
        letterSpacing: "0.015em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "neon",
        motion: "breathe"
    },
    toxic: {
        label: "Toxic Bloom",
        blurb: "Acid lime + mint, impossible to miss",
        primary: "#d8ff4f",
        secondary: "#00e5a8",
        highlight: "#f5ffd0",
        glow: "rgba(0, 229, 168, 0.62)",
        fontFamily: FONT_FAMILIES.display,
        fontWeight: 800,
        letterSpacing: "0.035em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "underline",
        effect: "neon",
        motion: "scan"
    },
    aurora: {
        label: "Aurora",
        blurb: "Northern lights over deep blue",
        primary: "#7dffcb",
        secondary: "#6ea8ff",
        highlight: "#efffff",
        glow: "rgba(125, 255, 203, 0.56)",
        fontFamily: FONT_FAMILIES.system,
        fontWeight: 700,
        letterSpacing: "0.012em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "holo",
        motion: "shimmer"
    },
    sakura: {
        label: "Sakura Static",
        blurb: "Swash-script petals with a pink-to-rose fade",
        primary: "#ffd2e9",
        secondary: "#ff5ca8",
        highlight: "#fff7fb",
        glow: "rgba(255, 92, 168, 0.52)",
        fontFamily: FONT_FAMILIES.script,
        fontWeight: 400,
        letterSpacing: "0.018em",
        textTransform: "none",
        smallCaps: false,
        decoration: "underline",
        effect: "soft",
        motion: "breathe"
    },
    midnight: {
        label: "Midnight Scholar",
        blurb: "Lavender ink with quiet authority",
        primary: "#d8d0ff",
        secondary: "#5865f2",
        highlight: "#ffffff",
        glow: "rgba(88, 101, 242, 0.5)",
        fontFamily: FONT_FAMILIES.serif,
        fontWeight: 700,
        letterSpacing: "0.005em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "soft",
        motion: "none"
    },
    bloodMoon: {
        label: "Blood Moon",
        blurb: "Crimson eclipse with gothic weight",
        primary: "#ff9898",
        secondary: "#73001f",
        highlight: "#ffe3e3",
        glow: "rgba(255, 47, 91, 0.58)",
        fontFamily: FONT_FAMILIES.serif,
        fontWeight: 750,
        letterSpacing: "0.02em",
        textTransform: "none",
        smallCaps: false,
        decoration: "overline",
        effect: "neon",
        motion: "breathe"
    },
    royal: {
        label: "Royal Relic",
        blurb: "Antique gold over amethyst",
        primary: "#ffe99a",
        secondary: "#9b5cff",
        highlight: "#fffbea",
        glow: "rgba(255, 206, 92, 0.58)",
        fontFamily: FONT_FAMILIES.serif,
        fontWeight: 750,
        letterSpacing: "0.025em",
        textTransform: "none",
        smallCaps: true,
        decoration: "none",
        effect: "holo",
        motion: "shimmer"
    },
    terminal: {
        label: "Terminal",
        blurb: "Green phosphor, monospace confidence",
        primary: "#b5ffca",
        secondary: "#00a86b",
        highlight: "#e4ffe9",
        glow: "rgba(0, 229, 168, 0.62)",
        fontFamily: FONT_FAMILIES.mono,
        fontWeight: 650,
        letterSpacing: "0.055em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "neon",
        motion: "scan"
    },
    pixel: {
        label: "Pixel Boss",
        blurb: "Arcade-yellow score text with hot pink",
        primary: "#fff36a",
        secondary: "#ff5d9e",
        highlight: "#ffffff",
        glow: "rgba(255, 243, 106, 0.64)",
        fontFamily: FONT_FAMILIES.pixel,
        fontWeight: 900,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "outline",
        motion: "shimmer"
    },
    oceanic: {
        label: "Oceanic",
        blurb: "Tidal cyan rolling into royal blue",
        primary: "#8beaff",
        secondary: "#0066ff",
        highlight: "#effcff",
        glow: "rgba(0, 162, 255, 0.58)",
        fontFamily: FONT_FAMILIES.display,
        fontWeight: 700,
        letterSpacing: "0.015em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "soft",
        motion: "breathe"
    },
    cobaltFlame: {
        label: "Cobalt Flame",
        blurb: "Electric blue under a gold flash",
        primary: "#fff29a",
        secondary: "#204bff",
        highlight: "#ffffff",
        glow: "rgba(32, 75, 255, 0.68)",
        fontFamily: FONT_FAMILIES.system,
        fontWeight: 850,
        letterSpacing: "0.02em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "neon",
        motion: "shimmer"
    },
    plasma: {
        label: "Plasma",
        blurb: "Hot magenta colliding with cyan",
        primary: "#ff5dfd",
        secondary: "#00f0ff",
        highlight: "#ffffff",
        glow: "rgba(255, 93, 253, 0.68)",
        fontFamily: FONT_FAMILIES.rounded,
        fontWeight: 800,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "holo",
        motion: "shimmer"
    },
    monoInk: {
        label: "Mono Ink",
        blurb: "Black-and-white editorial minimalism",
        primary: "#ffffff",
        secondary: "#8f97a8",
        highlight: "#ffffff",
        glow: "rgba(255, 255, 255, 0.28)",
        fontFamily: FONT_FAMILIES.system,
        fontWeight: 650,
        letterSpacing: "0.025em",
        textTransform: "none",
        smallCaps: true,
        decoration: "underline",
        effect: "outline",
        motion: "none"
    },
    goldLeaf: {
        label: "Gold Leaf",
        blurb: "Warm foil lettering for a trophy profile",
        primary: "#fff3b0",
        secondary: "#ba791e",
        highlight: "#fffdf1",
        glow: "rgba(255, 197, 71, 0.62)",
        fontFamily: FONT_FAMILIES.serif,
        fontWeight: 750,
        letterSpacing: "0.018em",
        textTransform: "none",
        smallCaps: true,
        decoration: "none",
        effect: "holo",
        motion: "breathe"
    },
    voidBloom: {
        label: "Void Bloom",
        blurb: "Lilac light escaping a black hole",
        primary: "#e3b5ff",
        secondary: "#1e072f",
        highlight: "#fff4ff",
        glow: "rgba(191, 99, 255, 0.62)",
        fontFamily: FONT_FAMILIES.serif,
        fontWeight: 700,
        letterSpacing: "0.02em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "neon",
        motion: "breathe"
    },
    velvetScript: {
        label: "Velvet Script",
        blurb: "Long, looping calligraphy in rose-gold light",
        primary: "#ffd0e8",
        secondary: "#b66eff",
        highlight: "#fff5df",
        glow: "rgba(255, 126, 195, 0.42)",
        fontFamily: FONT_FAMILIES.script,
        fontWeight: 400,
        letterSpacing: "0.005em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "soft",
        motion: "none",
        ornament: "swash"
    },
    moonlitScript: {
        label: "Moonlit Script",
        blurb: "Silver-blue calligraphy with a moonlit sweep",
        primary: "#e6f5ff",
        secondary: "#8a7dff",
        highlight: "#ffffff",
        glow: "rgba(130, 194, 255, 0.48)",
        fontFamily: FONT_FAMILIES.script,
        fontWeight: 400,
        letterSpacing: "0.012em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "holo",
        motion: "twinkle",
        ornament: "spark"
    },
    streetMarker: {
        label: "Street Marker",
        blurb: "Hand-drawn tags with a punchy underline",
        primary: "#ffe66d",
        secondary: "#ff4f81",
        highlight: "#fff8cf",
        glow: "rgba(255, 79, 129, 0.56)",
        fontFamily: FONT_FAMILIES.hand,
        fontWeight: 900,
        letterSpacing: "0.025em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "underline",
        effect: "outline",
        motion: "none"
    },
    wildfire: {
        label: "Wildfire",
        blurb: "Comic-book lettering with a living flame tip",
        primary: "#ff642e",
        secondary: "#b90d30",
        highlight: "#fff0a1",
        glow: "rgba(255, 75, 30, 0.72)",
        fontFamily: FONT_FAMILIES.comic,
        fontWeight: 400,
        letterSpacing: "0.035em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "fire",
        motion: "flicker",
        ornament: "flame"
    },
    dragonfire: {
        label: "Dragonfire",
        blurb: "Molten crimson with a gold-hot core",
        primary: "#e43125",
        secondary: "#5f102e",
        highlight: "#ffe08a",
        glow: "rgba(255, 48, 23, 0.64)",
        fontFamily: FONT_FAMILIES.future,
        fontWeight: 900,
        letterSpacing: "0.018em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "fire",
        motion: "breathe",
        ornament: "flame"
    },
    gothicInk: {
        label: "Gothic Ink",
        blurb: "True Fraktur blackletter with a blood-red edge",
        primary: "#ffd0d7",
        secondary: "#951536",
        highlight: "#fff4e5",
        glow: "rgba(180, 28, 64, 0.5)",
        fontFamily: FONT_FAMILIES.gothic,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "none",
        smallCaps: true,
        decoration: "overline",
        effect: "outline",
        motion: "none"
    },
    futureRunner: {
        label: "Future Runner",
        blurb: "Condensed Bahnschrift with an electric scan",
        primary: "#a9fff1",
        secondary: "#1f65ff",
        highlight: "#ffffff",
        glow: "rgba(0, 226, 255, 0.64)",
        fontFamily: FONT_FAMILIES.future,
        fontWeight: 800,
        letterSpacing: "0.085em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "neon",
        motion: "scan"
    },
    speedLine: {
        label: "Speedline",
        blurb: "Italic racing type in red, white, and carbon",
        primary: "#fff4f0",
        secondary: "#ff294d",
        highlight: "#ffffff",
        glow: "rgba(255, 41, 77, 0.54)",
        fontFamily: FONT_FAMILIES.future,
        fontStyle: "italic",
        fontWeight: 900,
        letterSpacing: "0.065em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "underline",
        effect: "outline",
        motion: "shimmer"
    },
    storybook: {
        label: "Storybook Gold",
        blurb: "Elegant italic serif with antique foil",
        primary: "#fff0ae",
        secondary: "#9a591d",
        highlight: "#fffdf1",
        glow: "rgba(255, 197, 71, 0.48)",
        fontFamily: FONT_FAMILIES.western,
        fontStyle: "italic",
        fontWeight: 700,
        letterSpacing: "0.015em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "holo",
        motion: "breathe"
    },
    comicBurst: {
        label: "Comic Burst",
        blurb: "Big B-movie lettering with a four-point spark",
        primary: "#fff27a",
        secondary: "#ff3b72",
        highlight: "#ffffff",
        glow: "rgba(255, 90, 93, 0.72)",
        fontFamily: FONT_FAMILIES.comic,
        fontWeight: 400,
        letterSpacing: "0.025em",
        textTransform: "uppercase",
        smallCaps: false,
        decoration: "none",
        effect: "outline",
        motion: "electric",
        ornament: "spark"
    },
    flamekissed: {
        label: "Flamekissed",
        blurb: "Calligraphy crossing from gold into molten red",
        primary: "#fff0a1",
        secondary: "#e32636",
        highlight: "#fff9d6",
        glow: "rgba(255, 91, 35, 0.72)",
        fontFamily: FONT_FAMILIES.script,
        fontWeight: 400,
        letterSpacing: "0.005em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "fire",
        motion: "flicker",
        ornament: "flame"
    },
    custom: {
        label: "Custom Lab",
        blurb: "Use your own two-color recipe",
        primary: "#ff6ec7",
        secondary: "#4a73ff",
        highlight: "#ffffff",
        glow: "rgba(255, 110, 199, 0.58)",
        fontFamily: FONT_FAMILIES.system,
        fontWeight: 700,
        letterSpacing: "0.01em",
        textTransform: "none",
        smallCaps: false,
        decoration: "none",
        effect: "soft",
        motion: "breathe"
    }
} satisfies Record<string, StyleProfile & { label: string; blurb: string }>;

const PRESET_ORDER: PresetId[] = [...DISPLAY_NAME_STYLE_PRESET_IDS];

const STYLE_CATEGORIES: { id: StyleCategory; label: string }[] = [
    { id: "all", label: "All" },
    { id: "script", label: "Script" },
    { id: "flame", label: "Flame" },
    { id: "gothic", label: "Gothic" },
    { id: "arcade", label: "Arcade" },
    { id: "luxe", label: "Luxe" },
    { id: "dream", label: "Dream" }
];

const CATEGORY_PRESETS: Record<Exclude<StyleCategory, "all">, PresetId[]> = {
    script: ["sakura", "velvetScript", "moonlitScript", "flamekissed"],
    flame: ["ember", "cobaltFlame", "wildfire", "dragonfire", "flamekissed"],
    gothic: ["bloodMoon", "voidBloom", "gothicInk"],
    arcade: ["neonArcade", "toxic", "terminal", "pixel", "comicBurst", "streetMarker", "futureRunner", "speedLine"],
    luxe: ["holoChrome", "midnight", "royal", "monoInk", "goldLeaf", "storybook"],
    dream: ["cottonCandy", "aurora", "oceanic", "plasma", "custom"]
};

const PRESET_SELECT_OPTIONS = PRESET_ORDER.map(id => ({
    label: `${PRESETS[id].label} — ${PRESETS[id].blurb}`,
    value: id,
    default: id === "cottonCandy"
}));

const HEX_RE = /^#[0-9a-f]{6}$/i;

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let scanRaf = 0;
let motionTimer: ReturnType<typeof setInterval> | null = null;
let lastMotionAllowed: boolean | null = null;

function vencord(): any {
    return (globalThis as any).Vencord;
}

function readString(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
}

function normalizeHex(value: unknown, fallback: string): string {
    const candidate = readString(value, fallback).trim();
    return HEX_RE.test(candidate) ? candidate.toLowerCase() : fallback;
}

function getPresetId(): PresetId {
    const value = readString(settings.store.preset, "cottonCandy");
    return isDisplayNameStylePresetId(value) && Object.prototype.hasOwnProperty.call(PRESETS, value)
        ? value
        : "cottonCandy";
}

function getProfile(): StyleProfile {
    const id = getPresetId();
    const base = PRESETS[id];
    const custom = id === "custom";
    const fontOverride = readString(settings.store.fontFamily, "preset");
    const weightOverride = readString(settings.store.fontWeight, "preset");
    const spacingOverride = readString(settings.store.letterSpacing, "preset");
    const casingOverride = readString(settings.store.casing, "preset");
    const effectOverride = readString(settings.store.effect, "preset") as Effect | "preset";
    const motionOverride = readString(settings.store.motion, "preset") as Motion | "preset";

    const fontFamily = fontOverride === "preset"
        ? base.fontFamily
        : FONT_FAMILIES[fontOverride as keyof typeof FONT_FAMILIES] ?? base.fontFamily;
    const fontWeight = weightOverride === "preset"
        ? base.fontWeight
        : Number(weightOverride) || base.fontWeight;
    const letterSpacing = spacingOverride === "preset" ? base.letterSpacing : spacingOverride;
    const casing = casingOverride === "preset" ? base.textTransform : casingOverride;
    const effect = effectOverride === "preset" ? base.effect : effectOverride;
    const motion = motionOverride === "preset" ? base.motion : motionOverride;

    return {
        ...base,
        primary: custom ? normalizeHex(settings.store.customPrimary, base.primary) : base.primary,
        secondary: custom ? normalizeHex(settings.store.customSecondary, base.secondary) : base.secondary,
        glow: custom ? `rgba(255, 110, 199, ${readString(settings.store.customGlow, "0.58")})` : base.glow,
        fontFamily,
        fontWeight,
        letterSpacing,
        textTransform: casing === "uppercase" ? "uppercase" : "none",
        smallCaps: casing === "smallCaps" ? true : casing === "preset" ? base.smallCaps : false,
        effect: ["clean", "soft", "neon", "outline", "holo", "fire"].includes(effect) ? effect as Effect : base.effect,
        motion: ["none", "breathe", "shimmer", "scan", "flicker", "twinkle", "electric"].includes(motion) ? motion as Motion : base.motion
    };
}

function isTournamentModeActive(): boolean {
    return vencord()?.PlainSettings?.plugins?.TournamentMode?.manuallyActive === true;
}

function motionAllowed(): boolean {
    return settings.store.animate !== false && !isTournamentModeActive();
}

function gradientForProfile(profile: StyleProfile): string {
    if (profile.effect === "fire") {
        return `linear-gradient(0deg, ${profile.secondary} 2%, ${profile.primary} 64%, ${profile.highlight} 100%)`;
    }
    return profile.effect === "holo"
        ? `linear-gradient(110deg, ${profile.primary}, ${profile.highlight}, ${profile.secondary}, ${profile.primary})`
        : `linear-gradient(105deg, ${profile.primary}, ${profile.secondary})`;
}

function shadowForProfile(profile: StyleProfile): string {
    if (profile.effect === "fire") {
        return `0 0 2px ${profile.highlight}, 0 -3px 6px ${profile.highlight}, 0 -8px 14px ${profile.primary}, 0 4px 9px ${profile.secondary}`;
    }
    if (profile.effect === "neon") return `0 0 4px ${profile.glow}, 0 0 11px ${profile.glow}`;
    if (profile.effect === "soft" || profile.effect === "holo") return `0 0 8px ${profile.glow}`;
    return "none";
}

function ornamentSelector(ornament: Exclude<Ornament, "none">): string {
    return `[${TARGET_ATTR}][${ORNAMENT_ATTR}="${ornament}"]::after, [data-dm-display-name-preview-ornament="${ornament}"]::after`;
}

function cssForProfile(profile: StyleProfile): string {
    const gradient = gradientForProfile(profile);
    const clean = profile.effect === "clean";
    const outline = profile.effect === "outline"
        ? `-webkit-text-stroke: 0.32px ${profile.secondary};`
        : "";
    const shadow = shadowForProfile(profile);
    const previewMotion = (motion: Motion) =>
        `html:not([${MOTION_BLOCKED_ATTR}]) [data-dm-display-name-preview-motion="${motion}"]`;

    return `
        @font-face {
            font-family: "DM Great Vibes";
            src: url("vesktop://static/fonts/display-name-style/great-vibes-latin.woff2") format("woff2");
            font-style: normal;
            font-weight: 400;
            font-display: swap;
        }
        @font-face {
            font-family: "DM Unifraktur Cook";
            src: url("vesktop://static/fonts/display-name-style/unifraktur-cook-latin.woff2") format("woff2");
            font-style: normal;
            font-weight: 700;
            font-display: swap;
        }
        @font-face {
            font-family: "DM Bangers";
            src: url("vesktop://static/fonts/display-name-style/bangers-latin.woff2") format("woff2");
            font-style: normal;
            font-weight: 400;
            font-display: swap;
        }
        #${ROOT_ID} { display: none; }
        [${TARGET_ATTR}] {
            ${clean ? `color: ${profile.primary} !important; -webkit-text-fill-color: ${profile.primary};` : `background-image: ${gradient}; background-size: 180% 100%; background-clip: text; -webkit-background-clip: text; color: ${profile.primary} !important; -webkit-text-fill-color: transparent;`}
            font-family: ${profile.fontFamily} !important;
            font-style: ${profile.fontStyle ?? "normal"} !important;
            font-weight: ${profile.fontWeight} !important;
            letter-spacing: ${profile.letterSpacing} !important;
            text-transform: ${profile.textTransform} !important;
            font-variant: ${profile.smallCaps ? "small-caps" : "normal"} !important;
            text-decoration-line: ${profile.decoration} !important;
            text-decoration-thickness: 1px;
            text-underline-offset: 2px;
            text-shadow: ${shadow};
            ${outline}
            transition: color 140ms ease, text-shadow 140ms ease, filter 140ms ease;
        }
        ${ornamentSelector("swash")} {
            content: "";
            display: inline-block;
            width: .78em;
            height: .22em;
            margin-left: .12em;
            vertical-align: middle;
            border-bottom: .1em solid var(--dm-name-secondary, ${profile.secondary});
            border-radius: 0 0 75% 80%;
            box-shadow: 0 2px 0 -1px var(--dm-name-primary, ${profile.primary});
            transform: skewX(-30deg) rotate(-7deg);
            opacity: .92;
        }
        ${ornamentSelector("flame")} {
            content: "";
            display: inline-block;
            width: .38em;
            height: .7em;
            margin-left: .1em;
            vertical-align: -.04em;
            background: linear-gradient(0deg, var(--dm-name-secondary, ${profile.secondary}) 4%, var(--dm-name-primary, ${profile.primary}) 58%, var(--dm-name-highlight, ${profile.highlight}) 100%);
            clip-path: polygon(48% 0, 63% 22%, 84% 34%, 73% 49%, 96% 61%, 83% 84%, 62% 100%, 31% 97%, 13% 82%, 7% 63%, 26% 48%, 34% 29%, 41% 17%);
            filter: drop-shadow(0 0 .12em var(--dm-name-primary, ${profile.primary}));
            transform-origin: 50% 100%;
        }
        ${ornamentSelector("spark")} {
            content: "";
            display: inline-block;
            width: .42em;
            height: .42em;
            margin-left: .16em;
            vertical-align: .03em;
            background: linear-gradient(135deg, var(--dm-name-highlight, ${profile.highlight}), var(--dm-name-primary, ${profile.primary}) 52%, var(--dm-name-secondary, ${profile.secondary}));
            clip-path: polygon(50% 0, 61% 38%, 100% 50%, 61% 62%, 50% 100%, 39% 62%, 0 50%, 39% 38%);
            filter: drop-shadow(0 0 .1em var(--dm-name-primary, ${profile.primary}));
        }
        [${TARGET_ATTR}][${ORNAMENT_ATTR}="flame"][${MOTION_ATTR}="flicker"]::after,
        ${previewMotion("flicker")}[data-dm-display-name-preview-ornament="flame"]::after {
            animation: dm-display-name-flame 680ms ease-in-out infinite alternate;
        }
        @keyframes dm-display-name-flame {
            from { transform: rotate(-8deg) scale(.94); filter: drop-shadow(0 0 .08em var(--dm-name-primary, ${profile.primary})); }
            to { transform: rotate(8deg) scale(1.08); filter: drop-shadow(0 0 .22em var(--dm-name-highlight, ${profile.highlight})); }
        }
        [${TARGET_ATTR}][${MOTION_ATTR}="shimmer"],
        ${previewMotion("shimmer")} {
            animation: dm-display-name-shimmer 3.8s linear infinite;
        }
        [${TARGET_ATTR}][${MOTION_ATTR}="breathe"],
        ${previewMotion("breathe")} {
            animation: dm-display-name-breathe 2.8s ease-in-out infinite;
        }
        [${TARGET_ATTR}][${MOTION_ATTR}="scan"],
        ${previewMotion("scan")} {
            animation: dm-display-name-scan 2.6s ease-in-out infinite;
        }
        [${TARGET_ATTR}][${MOTION_ATTR}="flicker"],
        ${previewMotion("flicker")} {
            animation: dm-display-name-fire 1.45s ease-in-out infinite alternate;
        }
        [${TARGET_ATTR}][${MOTION_ATTR}="electric"],
        ${previewMotion("electric")} {
            animation: dm-display-name-electric 2.4s steps(1, end) infinite;
        }
        [${TARGET_ATTR}][${ORNAMENT_ATTR}="spark"][${MOTION_ATTR}="twinkle"]::after,
        [${TARGET_ATTR}][${ORNAMENT_ATTR}="spark"][${MOTION_ATTR}="electric"]::after,
        ${previewMotion("twinkle")}[data-dm-display-name-preview-ornament="spark"]::after,
        ${previewMotion("electric")}[data-dm-display-name-preview-ornament="spark"]::after {
            animation: dm-display-name-twinkle 1.35s ease-in-out infinite alternate;
        }
        @keyframes dm-display-name-shimmer {
            0%, 100% { background-position: 0% 50%; filter: saturate(1); }
            50% { background-position: 100% 50%; filter: saturate(1.3) brightness(1.12); }
        }
        @keyframes dm-display-name-breathe {
            0%, 100% { text-shadow: ${shadow}; filter: saturate(1); }
            50% { text-shadow: 0 0 12px ${profile.glow}; filter: saturate(1.18) brightness(1.08); }
        }
        @keyframes dm-display-name-scan {
            0%, 100% { transform: translateX(0); opacity: .92; }
            50% { transform: translateX(1px); opacity: 1; }
        }
        @keyframes dm-display-name-fire {
            0%, 100% { filter: saturate(1.08) brightness(.98); text-shadow: ${shadow}; }
            42% { filter: saturate(1.35) brightness(1.12); text-shadow: 0 0 3px ${profile.highlight}, 0 -4px 8px ${profile.primary}, 0 -10px 17px ${profile.secondary}; }
            73% { filter: saturate(1.22) brightness(1.04); text-shadow: 0 0 2px ${profile.highlight}, 0 -2px 5px ${profile.primary}, 0 -7px 12px ${profile.secondary}; }
        }
        @keyframes dm-display-name-twinkle {
            from { opacity: .55; transform: rotate(-12deg) scale(.78); filter: drop-shadow(0 0 .06em var(--dm-name-primary, ${profile.primary})); }
            to { opacity: 1; transform: rotate(12deg) scale(1.18); filter: drop-shadow(0 0 .24em var(--dm-name-highlight, ${profile.highlight})); }
        }
        @keyframes dm-display-name-electric {
            0%, 82%, 100% { filter: saturate(1); text-shadow: ${shadow}; }
            84% { filter: saturate(1.8) brightness(1.45); text-shadow: 0 0 2px #fff, 0 0 7px var(--dm-name-highlight, ${profile.highlight}), 0 0 15px var(--dm-name-primary, ${profile.primary}); }
            86% { filter: saturate(1.1); text-shadow: ${shadow}; }
            91% { filter: saturate(1.65) brightness(1.28); text-shadow: 0 0 2px #fff, 0 0 6px var(--dm-name-primary, ${profile.primary}), 0 0 12px var(--dm-name-secondary, ${profile.secondary}); }
            93% { filter: saturate(1); text-shadow: ${shadow}; }
        }
    `;
}

function escapeAttributeValue(value: string): string {
    return value.replace(/[^a-z0-9_-]/gi, "");
}

function semanticText(element: HTMLElement): string {
    const className = typeof element.className === "string" ? element.className : "";
    return `${className} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("role") ?? ""}`.toLowerCase();
}

function getSurface(element: HTMLElement): Surface | null {
    let current: HTMLElement | null = element;
    let depth = 0;
    while (current && depth < 8) {
        const semantic = semanticText(current);
        if (/user.?popout|user.?profile|profile.?modal|profile.?header/.test(semantic)) return "profile";
        if (/message|chat.?content|markup|reply/.test(semantic)) return "message";
        if (/member|guild.?member|people|friend/.test(semantic)) return "member";
        if (/recipient|private.?channel|dm.?channel|channel.?header|dm.?header/.test(semantic)) return "dm";
        if (/panels|user.?panel|account.?panel|account.?details/.test(semantic)) return "self";
        current = current.parentElement;
        depth++;
    }

    // A user-id root is a useful fallback for Discord surfaces whose hashed
    // class names no longer contain an obvious semantic hint.
    return element.closest("[data-user-id]") ? "unknown" : null;
}

function userIdFor(element: HTMLElement): string | null {
    const root = element.closest<HTMLElement>("[data-user-id]");
    return root?.getAttribute("data-user-id") ?? null;
}

function isOwnName(element: HTMLElement, surface: Surface): boolean {
    const currentId = UserStore.getCurrentUser()?.id;
    const userId = userIdFor(element);
    if (currentId && userId) return currentId === userId;
    return surface === "self";
}

function surfaceEnabled(surface: Surface): boolean {
    switch (surface) {
        case "self": return settings.store.selfPanel !== false;
        case "profile": return settings.store.profilePopouts !== false;
        case "member": return settings.store.memberList !== false;
        case "message": return settings.store.messages === true;
        case "dm": return settings.store.dmList !== false;
        case "unknown": return settings.store.memberList !== false;
    }
}

function hasNameClass(element: HTMLElement): boolean {
    const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
    return /username|display.?name|user.?tag/.test(className)
        || (element.hasAttribute("data-text-variant") && Boolean(element.closest("[class*='panelTitleContainer']")));
}

function isVisibleLeafName(element: HTMLElement): boolean {
    if (!element.isConnected || !hasNameClass(element)) return false;
    if (element.closest<HTMLElement>(`#${ROOT_ID}, [${IGNORE_ATTR}], input, textarea, [contenteditable="true"]`)) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (element.children.length > 0 && element.querySelector<HTMLElement>(candidateSelector())) return false;

    const text = element.textContent?.trim() ?? "";
    if (!text || text.length > 64 || /\r|\n/.test(text)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function shouldApply(element: HTMLElement): { surface: Surface } | null {
    if (!settings.store.active || !isVisibleLeafName(element)) return null;
    const surface = getSurface(element);
    if (!surface || !surfaceEnabled(surface)) return null;
    const automaticOtherNameSurface = surface === "profile" || surface === "member" || surface === "dm";
    if (settings.store.styleOtherNames !== true && !automaticOtherNameSurface && !isOwnName(element, surface)) return null;
    return { surface };
}

function clearTarget(element: HTMLElement) {
    element.removeAttribute(TARGET_ATTR);
    element.removeAttribute(SURFACE_ATTR);
    element.removeAttribute(MOTION_ATTR);
    element.removeAttribute(ORNAMENT_ATTR);
    for (const name of ["--dm-name-primary", "--dm-name-secondary", "--dm-name-highlight", "--dm-name-glow"]) {
        element.style.removeProperty(name);
    }
}

function applyTarget(element: HTMLElement, surface: Surface, profile: StyleProfile) {
    element.setAttribute(TARGET_ATTR, escapeAttributeValue(getPresetId()));
    element.setAttribute(SURFACE_ATTR, surface);
    element.setAttribute(MOTION_ATTR, motionAllowed() ? profile.motion : "none");
    if (profile.ornament && profile.ornament !== "none") element.setAttribute(ORNAMENT_ATTR, profile.ornament);
    else element.removeAttribute(ORNAMENT_ATTR);
    element.style.setProperty("--dm-name-primary", profile.primary);
    element.style.setProperty("--dm-name-secondary", profile.secondary);
    element.style.setProperty("--dm-name-highlight", profile.highlight);
    element.style.setProperty("--dm-name-glow", profile.glow);
}

function candidateSelector(): string {
    return "[class*='username'],[class*='displayName'],[class*='userTag'],[class*='panelTitleContainer'] [data-text-variant],[class*='nameContainer'] [class*='name'],[class*='nameTag'] [class*='title'],[class*='nameTag'] [class*='name']";
}

function scanRoot(root: ParentNode) {
    const profile = getProfile();
    const candidates: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches(candidateSelector())) candidates.push(root);
    root.querySelectorAll<HTMLElement>(candidateSelector()).forEach(element => candidates.push(element));

    const seen = new Set<HTMLElement>();
    for (const element of candidates) {
        if (seen.has(element)) continue;
        seen.add(element);
        const result = shouldApply(element);
        if (result) applyTarget(element, result.surface, profile);
        else if (element.hasAttribute(TARGET_ATTR)) clearTarget(element);
    }

    document.querySelectorAll<HTMLElement>(`[${TARGET_ATTR}]`).forEach(element => {
        if (!shouldApply(element)) clearTarget(element);
        else applyTarget(element, getSurface(element) ?? "unknown", profile);
    });
}

function scheduleScan() {
    if (scanRaf || !document.body) return;
    scanRaf = requestAnimationFrame(() => {
        scanRaf = 0;
        scanRoot(document);
    });
}

function syncMotionState() {
    const next = motionAllowed();
    document.documentElement?.toggleAttribute(MOTION_BLOCKED_ATTR, !next);
    if (next === lastMotionAllowed) return;
    lastMotionAllowed = next;
    document.querySelectorAll<HTMLElement>(`[${TARGET_ATTR}]`).forEach(element => {
        const profile = getProfile();
        element.setAttribute(MOTION_ATTR, next ? profile.motion : "none");
    });
}

function clearAllTargets() {
    document.querySelectorAll<HTMLElement>(`[${TARGET_ATTR}]`).forEach(clearTarget);
}

function refresh() {
    if (style) style.textContent = settings.store.active === false ? "" : cssForProfile(getProfile());
    lastMotionAllowed = null;
    scheduleScan();
}

function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(mutations => {
        if (mutations.some(m => m.type === "childList" || m.attributeName === "class" || m.attributeName === "data-user-id")) {
            scheduleScan();
        }
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "data-user-id", "aria-hidden"]
    });
    scanRoot(document);
    syncMotionState();
    motionTimer = setInterval(syncMotionState, 1200);
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
    if (scanRaf) {
        cancelAnimationFrame(scanRaf);
        scanRaf = 0;
    }
    if (motionTimer) {
        clearInterval(motionTimer);
        motionTimer = null;
    }
    clearAllTargets();
    document.documentElement?.removeAttribute(MOTION_BLOCKED_ATTR);
    lastMotionAllowed = null;
}

function applyPreset(id: PresetId) {
    settings.store.preset = id;
    refresh();
}

function previewStyle(profile: StyleProfile): Record<string, string> {
    const clean = profile.effect === "clean";
    return {
        backgroundImage: gradientForProfile(profile),
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: clean ? profile.primary : "transparent",
        color: profile.primary,
        fontFamily: profile.fontFamily,
        fontStyle: profile.fontStyle ?? "normal",
        fontWeight: String(profile.fontWeight),
        letterSpacing: profile.letterSpacing,
        textTransform: profile.textTransform,
        fontVariant: profile.smallCaps ? "small-caps" : "normal",
        textDecorationLine: profile.decoration,
        textDecorationThickness: "1px",
        textUnderlineOffset: "2px",
        textShadow: shadowForProfile(profile),
        "--dm-name-primary": profile.primary,
        "--dm-name-secondary": profile.secondary,
        "--dm-name-highlight": profile.highlight,
        "--dm-name-glow": profile.glow,
        WebkitTextStroke: profile.effect === "outline" ? `0.55px ${profile.secondary}` : "0 transparent",
        display: "inline-block"
    };
}

function StylePicker() {
    const [category, setCategory] = React.useState<StyleCategory>("all");
    const [, forceRender] = React.useState(0);
    const selected = getPresetId();
    const selectedProfile = getProfile();
    const visiblePresets = category === "all" ? PRESET_ORDER : CATEGORY_PRESETS[category];
    const cards = visiblePresets.map(id => {
        const preset = PRESETS[id];
        const active = selected === id;
        return React.createElement(
            "button",
            {
                key: id,
                type: "button",
                "data-dm-display-name-style-ignore": "true",
                "aria-pressed": active,
                "aria-label": `${preset.label}: ${preset.blurb}`,
                title: preset.blurb,
                onClick: () => {
                    applyPreset(id);
                    forceRender(value => value + 1);
                },
                style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 6,
                    minHeight: 92,
                    padding: "9px 10px",
                    textAlign: "left",
                    borderRadius: 9,
                    border: `1px solid ${active ? preset.primary : "rgba(255,255,255,0.14)"}`,
                    boxShadow: active ? `0 0 0 2px ${preset.primary}33, 0 0 16px ${preset.glow}` : "none",
                    background: active ? "rgba(40, 35, 52, 0.88)" : "rgba(0,0,0,0.22)",
                    color: "#f2f3f5",
                    cursor: "pointer",
                    transition: "border-color 140ms ease, box-shadow 140ms ease"
                }
            },
            React.createElement("span", {
                "data-dm-display-name-preview-ornament": preset.ornament ?? "none",
                style: {
                    display: "block",
                    minHeight: 24,
                    fontSize: 19,
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                    ...previewStyle(preset)
                }
            }, "Your Name"),
            React.createElement("span", { style: { fontSize: 12, fontWeight: 750, lineHeight: 1.1 } }, `${active ? "✓ " : ""}${preset.label}`),
            React.createElement("span", { style: { fontSize: 10.5, color: "#cbd0e0", lineHeight: 1.2 } }, preset.blurb)
        );
    });

    return React.createElement(
        "div",
        {
            "data-dm-display-name-style-ignore": "true",
            style: {
                marginTop: 10,
                padding: "13px",
                borderRadius: 10,
                background: "linear-gradient(135deg, rgba(255,110,199,0.09), rgba(0,229,255,0.08))",
                border: "1px solid rgba(255,110,199,0.24)"
            }
        },
        React.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 } },
            React.createElement("div", { style: { fontSize: 13, fontWeight: 750, color: "#f2f3f5" } }, "✦ Choose a name style"),
            React.createElement("span", {
                "data-dm-display-name-preview-ornament": selectedProfile.ornament ?? "none",
                "data-dm-display-name-preview-motion": selectedProfile.motion,
                style: { fontSize: 21, lineHeight: 1.3, ...previewStyle(selectedProfile) }
            }, "Your Name")
        ),
        React.createElement("div", { style: { fontSize: 11.5, color: "#cbd0e0", lineHeight: 1.45, margin: "5px 0 10px" } },
            `Preview ${PRESET_ORDER.length} looks by mood. Some animate with shimmer, flame, twinkle, or electric flashes. Tournament Mode automatically pauses motion; use the Animate toggle or choose Still for manual control.`
        ),
        React.createElement("div", {
            role: "group",
            "aria-label": "Filter name styles by mood",
            style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }
        }, STYLE_CATEGORIES.map(item => {
            const active = category === item.id;
            const count = item.id === "all" ? PRESET_ORDER.length : CATEGORY_PRESETS[item.id].length;
            return React.createElement("button", {
                key: item.id,
                type: "button",
                "data-dm-display-name-style-ignore": "true",
                "aria-pressed": active,
                onClick: () => setCategory(item.id),
                style: {
                    border: `1px solid ${active ? "#ff6ec7" : "rgba(255,255,255,0.14)"}`,
                    borderRadius: 999,
                    padding: "5px 9px",
                    background: active ? "rgba(255,110,199,0.16)" : "rgba(0,0,0,0.18)",
                    color: active ? "#ffe8f6" : "#cbd0e0",
                    fontSize: 10.5,
                    fontWeight: active ? 700 : 550,
                    cursor: "pointer"
                }
            }, `${item.label} · ${count}`);
        })
        ),
        React.createElement("div", {
            style: {
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 7,
                alignItems: "stretch"
            }
        }, cards)
    );
}

const settings = definePluginSettings({
    picker: {
        type: OptionType.COMPONENT,
        description: "",
        component: StylePicker
    },
    active: {
        type: OptionType.BOOLEAN,
        description: "Show the selected style locally. Turn this off for a quick plain-name fallback without disabling the plugin.",
        default: true,
        onChange: () => {
            if (settings.store.active === false) clearAllTargets();
            refresh();
        }
    },
    preset: {
        type: OptionType.SELECT,
        description: "Keyboard-friendly preset selector. The visual grid above is the easiest way to browse the same presets.",
        default: "cottonCandy",
        options: PRESET_SELECT_OPTIONS,
        onChange: () => refresh()
    },
    customPrimary: {
        type: OptionType.STRING,
        description: "Custom Lab primary color as #RRGGBB. Used when the preset is Custom Lab.",
        default: "#ff6ec7",
        onChange: () => refresh()
    },
    customSecondary: {
        type: OptionType.STRING,
        description: "Custom Lab secondary color as #RRGGBB. Used when the preset is Custom Lab.",
        default: "#4a73ff",
        onChange: () => refresh()
    },
    customGlow: {
        type: OptionType.SELECT,
        description: "Custom Lab glow strength. This is constrained to safe presets instead of accepting arbitrary CSS.",
        default: "0.58",
        options: [
            { label: "Soft glow", value: "0.28", default: false },
            { label: "Balanced glow", value: "0.58", default: true },
            { label: "Loud glow", value: "0.82", default: false }
        ],
        onChange: () => refresh()
    },
    fontFamily: {
        type: OptionType.SELECT,
        description: "Typography override. The bundled script, blackletter, and comic faces work offline on every install.",
        default: "preset",
        options: [
            { label: "Preset choice", value: "preset", default: true },
            { label: "Clean system", value: "system" },
            { label: "Display / arcade", value: "display" },
            { label: "Rounded", value: "rounded" },
            { label: "Cursive script", value: "script" },
            { label: "Fraktur blackletter", value: "gothic" },
            { label: "Comic-book display", value: "comic" },
            { label: "Handwritten marker", value: "hand" },
            { label: "Futuristic / condensed", value: "future" },
            { label: "Western serif", value: "western" },
            { label: "Monospace terminal", value: "mono" },
            { label: "Editorial serif", value: "serif" },
            { label: "Heavy pixel", value: "pixel" }
        ],
        onChange: () => refresh()
    },
    fontWeight: {
        type: OptionType.SELECT,
        description: "Weight override. Preset keeps each preset's intended weight.",
        default: "preset",
        options: [
            { label: "Preset choice", value: "preset", default: true },
            { label: "Medium", value: "550" },
            { label: "Semibold", value: "650" },
            { label: "Bold", value: "750" },
            { label: "Black", value: "900" }
        ],
        onChange: () => refresh()
    },
    letterSpacing: {
        type: OptionType.SELECT,
        description: "Spacing override for compact, airy, or arcade-style names.",
        default: "preset",
        options: [
            { label: "Preset choice", value: "preset", default: true },
            { label: "Tight", value: "-0.015em" },
            { label: "Natural", value: "0em" },
            { label: "Airy", value: "0.04em" },
            { label: "Arcade", value: "0.075em" }
        ],
        onChange: () => refresh()
    },
    casing: {
        type: OptionType.SELECT,
        description: "Letter casing override. Preset keeps its intended casing.",
        default: "preset",
        options: [
            { label: "Preset choice", value: "preset", default: true },
            { label: "Normal case", value: "normal" },
            { label: "ALL CAPS", value: "uppercase" },
            { label: "Small caps", value: "smallCaps" }
        ],
        onChange: () => refresh()
    },
    effect: {
        type: OptionType.SELECT,
        description: "Finish override: clean solid, soft glow, neon, outline, holographic sweep, or flame-lit.",
        default: "preset",
        options: [
            { label: "Preset choice", value: "preset", default: true },
            { label: "Clean solid", value: "clean" },
            { label: "Soft glow", value: "soft" },
            { label: "Neon halo", value: "neon" },
            { label: "Ink outline", value: "outline" },
            { label: "Holographic", value: "holo" },
            { label: "Fire glow", value: "fire" }
        ],
        onChange: () => refresh()
    },
    motion: {
        type: OptionType.SELECT,
        description: "Choose the preset's motion effect. Tournament Mode automatically pauses animation; choose Still to keep this style static.",
        default: "preset",
        options: [
            { label: "Preset choice", value: "preset", default: true },
            { label: "Still", value: "none" },
            { label: "Breathing glow", value: "breathe" },
            { label: "Color shimmer", value: "shimmer" },
            { label: "Terminal scan", value: "scan" },
            { label: "Fire flicker", value: "flicker" },
            { label: "Twinkle spark", value: "twinkle" },
            { label: "Electric arc flash", value: "electric" }
        ],
        onChange: () => refresh()
    },
    animate: {
        type: OptionType.BOOLEAN,
        description: "Allow the selected preset's animation. Tournament Mode pauses it automatically; this plugin does not follow the OS reduced-motion preference.",
        default: true,
        onChange: () => {
            lastMotionAllowed = null;
            syncMotionState();
        }
    },
    styleOtherNames: {
        type: OptionType.BOOLEAN,
        description: "Also style other visible names on message and less-common Discord surfaces. Profile popouts, member/right-side lists, and DM headers are styled automatically when their own surface toggle is on.",
        default: false,
        onChange: () => scheduleScan()
    },
    selfPanel: {
        type: OptionType.BOOLEAN,
        description: "Apply to your own account name in the bottom-left account panel.",
        default: true,
        onChange: () => scheduleScan()
    },
    profilePopouts: {
        type: OptionType.BOOLEAN,
        description: "Apply to names in profile popouts and profile modals.",
        default: true,
        onChange: () => scheduleScan()
    },
    memberList: {
        type: OptionType.BOOLEAN,
        description: "Apply automatically to member lists, friend lists, and right-side user rows. Style other names is not required for these surfaces.",
        default: true,
        onChange: () => scheduleScan()
    },
    dmList: {
        type: OptionType.BOOLEAN,
        description: "Apply automatically to DM recipient rows and DM/channel headers. Style other names is not required for these surfaces.",
        default: true,
        onChange: () => scheduleScan()
    },
    messages: {
        type: OptionType.BOOLEAN,
        description: "Apply to message author labels. Off by default to keep chat dense and readable; enable Style other names too if you want broad styling on other uncommon surfaces.",
        default: false,
        onChange: () => scheduleScan()
    }
});

export default definePlugin({
    name: "DMDisplayNameStyle",
    description:
        `Creative local display-name styling with ${PRESET_ORDER.length} presets, bundled offline Great Vibes, Fraktur, and comic typefaces, flame/swash/spark ornaments, Custom Lab colors, and per-surface scope. Profile popouts, member/right-side lists, and DM headers style other users automatically; message authors remain opt-in. Motion does not follow the OS reduced-motion preference; Tournament Mode pauses it automatically. This does not edit your account; open Discord's native profile editor for the separate account-level Display Name Styles feature.`,
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-display-name-style", managedStyleRootNode);
        refresh();
        if (document.body) startObserver();
        else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
        (globalThis as any).__dmDisplayNameStyle = {
            getPreset: () => getPresetId(),
            setPreset: (value: unknown) => {
                if (!isDisplayNameStylePresetId(value) || !Object.prototype.hasOwnProperty.call(PRESETS, value)) return false;
                settings.store.preset = value;
                return true;
            },
            getProfile: () => getProfile(),
            scan: () => scanRoot(document)
        };
    },

    stop() {
        stopObserver();
        style?.remove();
        style = null;
        delete (globalThis as any).__dmDisplayNameStyle;
    }
});

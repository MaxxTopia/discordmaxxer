/*
 * Discordmaxxer — theme registry
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Eight named themes, each a complete Discord color-palette override.
 * Five free (maxxer/val/sonic/dmc/bo3); three MAXXER+ exclusives
 * (akatsuki/dmcdt/eminence) added v0.6.4.
 *
 * Each theme covers Discord's full var graph: brand, background,
 * text, header, channels, interactive, scrollbar. Cosmetic-only —
 * does not change layout or hide elements.
 */

import { Tier } from "./vip";

export type ThemeId = "maxxer" | "val" | "sonic" | "dmc" | "bo3" | "akatsuki" | "dmcdt" | "eminence";

export interface ThemePalette {
    /** Primary brand accent (button fills, links, mention pings). */
    brand: string;
    /** Lighter variant for hover states. */
    brandSoft: string;
    /** Darker variant for active/pressed states. */
    brandDark: string;
    /** Translucent overlay for selected items. */
    brandTrans: string;

    /** Main message-area background. */
    bgPrimary: string;
    /** Channel sidebar background. */
    bgSecondary: string;
    /** Slightly dimmer than secondary; used for nested panels. */
    bgSecondaryAlt: string;
    /** Server-rail / content-card background. */
    bgTertiary: string;
    /** Popover / dropdown / modal background. */
    bgFloating: string;
    /** Message-input background. */
    bgInput: string;

    /** Default body text. */
    textNormal: string;
    /** Secondary / metadata text. */
    textMuted: string;
    /** Disabled / placeholder text. */
    textSubtle: string;
    /** Hyperlink color. */
    textLink: string;

    /** Channel-list link color (default state). */
    channelText: string;
    /** Channel-list link color (hover). */
    channelTextHover: string;

    /** Subtle border / divider line. */
    border: string;
    /** Brighter border for focus / active. */
    borderGlow: string;
}

export interface Theme {
    id: ThemeId;
    label: string;
    blurb: string;
    bodyClass: string;
    /** Two-color swatch for the picker UI. */
    swatch: { primary: string; secondary: string };
    palette: ThemePalette;
    /** Optional font-family override for headings (DMC uses serif). */
    headingFont?: string;
    /** Minimum tier required to apply. Undefined = free. */
    tierGate?: Tier;
}

const FONT_BODY = "-apple-system, 'Segoe UI', Roboto, sans-serif";

export const THEMES: Record<ThemeId, Theme> = {
    maxxer: {
        id: "maxxer",
        label: "Maxxer",
        blurb: "The original — magenta + cobalt. Default Discordmaxxer brand.",
        bodyClass: "dm-theme-maxxer",
        swatch: { primary: "#e25bff", secondary: "#4c51f7" },
        palette: {
            brand: "#e25bff",
            brandSoft: "#ec80ff",
            brandDark: "#b81bd6",
            brandTrans: "rgba(226, 91, 255, 0.18)",
            bgPrimary: "#15101e",
            bgSecondary: "#1a1428",
            bgSecondaryAlt: "#120c1a",
            bgTertiary: "#0a0612",
            bgFloating: "#1c1530",
            bgInput: "#241a3a",
            textNormal: "#fbefff",
            textMuted: "#c8a8e6",
            textSubtle: "#8b6aad",
            textLink: "#e25bff",
            channelText: "#a890c4",
            channelTextHover: "#fbefff",
            border: "rgba(226, 91, 255, 0.18)",
            borderGlow: "rgba(226, 91, 255, 0.45)"
        }
    },
    val: {
        id: "val",
        label: "Val",
        blurb: "Tactical. Red + cream. Inspired by Valorant.",
        bodyClass: "dm-theme-val",
        swatch: { primary: "#ff4655", secondary: "#0f1923" },
        palette: {
            brand: "#ff4655",
            brandSoft: "#ff7a87",
            brandDark: "#b3303c",
            brandTrans: "rgba(255, 70, 85, 0.2)",
            bgPrimary: "#0d1418",
            bgSecondary: "#16252c",
            bgSecondaryAlt: "#0a0f12",
            bgTertiary: "#08111a",
            bgFloating: "#1a2a32",
            bgInput: "#1e2f38",
            textNormal: "#ece8e1",
            textMuted: "#c8b89a",
            textSubtle: "#8e8579",
            textLink: "#ff7a87",
            channelText: "#a8a094",
            channelTextHover: "#ff4655",
            border: "rgba(255, 70, 85, 0.18)",
            borderGlow: "rgba(255, 70, 85, 0.4)"
        }
    },
    sonic: {
        id: "sonic",
        label: "Sonic",
        blurb: "Speed. Cobalt + gold. Bright and kinetic.",
        bodyClass: "dm-theme-sonic",
        swatch: { primary: "#ffd700", secondary: "#007aff" },
        palette: {
            brand: "#ffd700",
            brandSoft: "#ffea66",
            brandDark: "#cca400",
            brandTrans: "rgba(255, 215, 0, 0.22)",
            bgPrimary: "#051e3e",
            bgSecondary: "#0a3a73",
            bgSecondaryAlt: "#031530",
            bgTertiary: "#020a1a",
            bgFloating: "#0f4080",
            bgInput: "#114a8e",
            textNormal: "#ffffff",
            textMuted: "#c5d6f0",
            textSubtle: "#7e9ec8",
            textLink: "#ffd700",
            channelText: "#9bb4d8",
            channelTextHover: "#ffd700",
            border: "rgba(255, 215, 0, 0.22)",
            borderGlow: "rgba(255, 215, 0, 0.5)"
        }
    },
    dmc: {
        id: "dmc",
        label: "DMC",
        blurb: "Gothic. Blood red + bone + obsidian. Devil May Cry energy.",
        bodyClass: "dm-theme-dmc",
        swatch: { primary: "#b3000c", secondary: "#6b2737" },
        palette: {
            brand: "#b3000c",
            brandSoft: "#e63946",
            brandDark: "#7a0008",
            brandTrans: "rgba(179, 0, 12, 0.22)",
            bgPrimary: "#0a0506",
            bgSecondary: "#1a0e10",
            bgSecondaryAlt: "#070304",
            bgTertiary: "#040202",
            bgFloating: "#241318",
            bgInput: "#2a161c",
            textNormal: "#f4ecd8",
            textMuted: "#c4b89a",
            textSubtle: "#8a7c66",
            textLink: "#e63946",
            channelText: "#a89878",
            channelTextHover: "#b3000c",
            border: "rgba(179, 0, 12, 0.22)",
            borderGlow: "rgba(179, 0, 12, 0.55)"
        },
        headingFont: "'Cormorant Garamond', Georgia, serif"
    },
    bo3: {
        id: "bo3",
        label: "Black Ops 3",
        blurb: "Military / cyber. Olive + neon orange + matte black.",
        bodyClass: "dm-theme-bo3",
        swatch: { primary: "#ff6b1a", secondary: "#5a6840" },
        palette: {
            brand: "#ff6b1a",
            brandSoft: "#ffa14d",
            brandDark: "#b34a0e",
            brandTrans: "rgba(255, 107, 26, 0.22)",
            bgPrimary: "#0e0f0a",
            bgSecondary: "#1c1d15",
            bgSecondaryAlt: "#080905",
            bgTertiary: "#040402",
            bgFloating: "#252618",
            bgInput: "#2c2d1c",
            textNormal: "#e9e8df",
            textMuted: "#b3b09e",
            textSubtle: "#7e7c6c",
            textLink: "#ff6b1a",
            channelText: "#9b9989",
            channelTextHover: "#ff6b1a",
            border: "rgba(255, 107, 26, 0.22)",
            borderGlow: "rgba(255, 107, 26, 0.5)"
        }
    },

    /* ───── MAXXER+ exclusives (v0.6.4) ───── */

    akatsuki: {
        id: "akatsuki",
        label: "Akatsuki",
        blurb: "Hidden organization. Bone + blood + void. Red clouds on black.",
        bodyClass: "dm-theme-akatsuki",
        swatch: { primary: "#c8332b", secondary: "#0a0709" },
        tierGate: Tier.MAXXER_PLUS,
        palette: {
            brand: "#c8332b",
            brandSoft: "#e54a3f",
            brandDark: "#7e1f18",
            brandTrans: "rgba(200, 51, 43, 0.22)",
            bgPrimary: "#0a0709",
            bgSecondary: "#15101a",
            bgSecondaryAlt: "#070406",
            bgTertiary: "#020203",
            bgFloating: "#1c1620",
            bgInput: "#221823",
            textNormal: "#f0e4d8",
            textMuted: "#a08770",
            textSubtle: "#6c5a4c",
            textLink: "#e54a3f",
            channelText: "#7a6a5e",
            channelTextHover: "#c8332b",
            border: "rgba(200, 51, 43, 0.20)",
            borderGlow: "rgba(200, 51, 43, 0.50)"
        },
        headingFont: "'Cinzel', 'Cormorant Garamond', Georgia, serif"
    },

    dmcdt: {
        id: "dmcdt",
        label: "DMC: Devil Trigger",
        blurb: "Dante's coat + Sparda's blue. Devil Trigger pulse — premium.",
        bodyClass: "dm-theme-dmcdt",
        swatch: { primary: "#cc1430", secondary: "#3a8eff" },
        tierGate: Tier.MAXXER_PLUS,
        palette: {
            brand: "#cc1430",
            brandSoft: "#ff3050",
            brandDark: "#7a0a1c",
            brandTrans: "rgba(204, 20, 48, 0.24)",
            bgPrimary: "#0c0608",
            bgSecondary: "#1c1014",
            bgSecondaryAlt: "#080405",
            bgTertiary: "#040203",
            bgFloating: "#28161c",
            bgInput: "#2e1820",
            textNormal: "#f8efe0",
            textMuted: "#c2b29a",
            textSubtle: "#8a7a64",
            textLink: "#3a8eff",
            channelText: "#a89678",
            channelTextHover: "#cc1430",
            border: "rgba(204, 20, 48, 0.25)",
            borderGlow: "rgba(58, 142, 255, 0.45)"
        },
        headingFont: "'Cinzel', 'Cormorant Garamond', Georgia, serif"
    },

    eminence: {
        id: "eminence",
        label: "Eminence in Shadow",
        blurb: "Slime magenta + atomic-blue lightning + void. I am... atomic.",
        bodyClass: "dm-theme-eminence",
        swatch: { primary: "#d63aff", secondary: "#5ae3ff" },
        tierGate: Tier.MAXXER_PLUS,
        palette: {
            brand: "#d63aff",
            brandSoft: "#e96bff",
            brandDark: "#8a1cb0",
            brandTrans: "rgba(214, 58, 255, 0.22)",
            bgPrimary: "#080608",
            bgSecondary: "#15101c",
            bgSecondaryAlt: "#050306",
            bgTertiary: "#020103",
            bgFloating: "#1e1830",
            bgInput: "#241c38",
            textNormal: "#ece6f5",
            textMuted: "#a89cba",
            textSubtle: "#766a8a",
            textLink: "#5ae3ff",
            channelText: "#7e7290",
            channelTextHover: "#d63aff",
            border: "rgba(214, 58, 255, 0.20)",
            borderGlow: "rgba(90, 227, 255, 0.50)"
        },
        headingFont: "'Cinzel Decorative', 'Cinzel', Georgia, serif"
    }
};

export const THEME_ORDER: ThemeId[] = ["maxxer", "val", "sonic", "dmc", "bo3", "akatsuki", "dmcdt", "eminence"];
export const DEFAULT_THEME: ThemeId = "maxxer";

/**
 * Build the full CSS-variable override for a given theme. Maps the small
 * palette to Discord's full CSS-var namespace (background-*, text-*,
 * header-*, channels-*, interactive-*, scrollbar-*, brand-*).
 */
export function themeCss(theme: Theme): string {
    const p = theme.palette;
    return `
    :root, body.${theme.bodyClass} {
        /* Brand — both legacy + modern Discord var systems */
        --brand-experiment: ${p.brand};
        --brand-experiment-100: ${p.brandSoft};
        --brand-experiment-200: ${p.brandSoft};
        --brand-experiment-300: ${p.brandSoft};
        --brand-experiment-400: ${p.brand};
        --brand-experiment-500: ${p.brand};
        --brand-experiment-560: ${p.brandDark};
        --brand-experiment-600: ${p.brandDark};
        --brand-experiment-700: ${p.brandDark};
        --brand-experiment-05a: ${p.brandTrans};
        --brand-experiment-10a: ${p.brandTrans};
        --brand-experiment-15a: ${p.brandTrans};
        --brand-experiment-20a: ${p.brandTrans};
        --brand-experiment-30a: ${p.brandTrans};
        --brand-500: ${p.brand};
        --brand-360: ${p.brandSoft};
        --brand-400: ${p.brand};
        --brand-460: ${p.brand};
        --brand-560: ${p.brandDark};
        --brand-600: ${p.brandDark};

        /* Background */
        --background-primary: ${p.bgPrimary};
        --background-secondary: ${p.bgSecondary};
        --background-secondary-alt: ${p.bgSecondaryAlt};
        --background-tertiary: ${p.bgTertiary};
        --background-floating: ${p.bgFloating};
        --background-message-hover: ${p.brandTrans};
        --background-modifier-hover: ${p.brandTrans};
        --background-modifier-selected: ${p.brandTrans};
        --background-modifier-active: ${p.brandTrans};
        --background-modifier-accent: ${p.borderGlow};
        --bg-overlay-1: ${p.bgFloating};
        --bg-overlay-2: ${p.bgSecondary};
        --bg-overlay-3: ${p.bgSecondaryAlt};
        --bg-overlay-chat: ${p.bgPrimary};
        --bg-overlay-app-frame: ${p.bgTertiary};

        /* Text */
        --text-normal: ${p.textNormal};
        --text-default: ${p.textNormal};
        --text-muted: ${p.textMuted};
        --text-secondary: ${p.textMuted};
        --text-tertiary: ${p.textSubtle};
        --text-subtle: ${p.textSubtle};
        --text-link: ${p.textLink};
        --text-link-low-saturation: ${p.textLink};
        --header-primary: ${p.textNormal};
        --header-secondary: ${p.textMuted};

        /* Channels list */
        --channels-default: ${p.channelText};
        --channeltextarea-background: ${p.bgInput};
        --channel-icon: ${p.channelText};
        --interactive-normal: ${p.channelText};
        --interactive-hover: ${p.channelTextHover};
        --interactive-active: ${p.textNormal};
        --interactive-muted: ${p.textSubtle};

        /* Status / accents */
        --status-positive: #65d16e;
        --status-warning: ${p.brandSoft};
        --status-danger: ${p.brand};

        /* Scrollbars */
        --scrollbar-thin-thumb: ${p.brandTrans};
        --scrollbar-thin-track: transparent;
        --scrollbar-auto-thumb: ${p.brandTrans};
        --scrollbar-auto-track: ${p.bgSecondaryAlt};
    }
    ${theme.headingFont ? `
    body.${theme.bodyClass} h1, body.${theme.bodyClass} h2, body.${theme.bodyClass} h3 {
        font-family: ${theme.headingFont};
    }` : ""}
    `;
}

/* ──────────────────────────────────────────────────────────────────────
 * Theme flair — layout density, animations, custom typing dots, and
 * per-theme character traits. Layered ON TOP of the palette CSS so
 * themes can be played with independently.
 *
 * Each theme has a personality:
 *   maxxer  — soft, glowy, default brand. Subtle magenta pulse.
 *   val     — tactical, sharp corners, cream-on-charcoal, scanline cursor blink.
 *   sonic   — speed, ultra-rounded, gold sparkle on hover, fast transitions.
 *   dmc     — gothic, sharp angled corners, bloody drips, slow ominous fades.
 *   bo3     — military stencil, blocky corners, neon orange glow, HUD typing.
 * ─────────────────────────────────────────────────────────────────── */
export function themeFlairCss(theme: Theme): string {
    const p = theme.palette;
    const cls = theme.bodyClass;

    const SHARED_KEYFRAMES = `
        @keyframes dm-pulse-${theme.id} {
            0%, 100% { box-shadow: 0 0 0 0 ${p.brandTrans}; }
            50% { box-shadow: 0 0 0 6px transparent; }
        }
        @keyframes dm-typing-${theme.id} {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.45; }
            30% { transform: translateY(-3px); opacity: 1; }
        }
        @keyframes dm-mention-glow-${theme.id} {
            0%, 100% { box-shadow: inset 2px 0 0 ${p.brand}; }
            50% { box-shadow: inset 2px 0 0 ${p.brandSoft}, 0 0 8px ${p.brandTrans}; }
        }
        @keyframes dm-drip-${theme.id} {
            0% { transform: translateY(-4px); opacity: 0; }
            40% { opacity: 1; }
            100% { transform: translateY(2px); opacity: 0; }
        }
    `;

    // Per-theme rule blocks
    const PERSONALITY: Record<ThemeId, string> = {
        maxxer: `
            /* Soft glow on mention badges, subtle pulse on unread pings */
            body.${cls} [class*="mentionsBadge_"], body.${cls} [class*="numberBadge_"] {
                animation: dm-pulse-${theme.id} 2.4s ease-in-out infinite;
            }
            /* Gentle 6px corners — keeps Discord shape but softer */
            body.${cls} [class*="chat_"] [class*="messageContent_"],
            body.${cls} [class*="container_"] [class*="bar_"] {
                border-radius: 6px;
            }
            body.${cls} [class*="typing_"] [class*="dot_"] {
                background-color: ${p.brand} !important;
                animation: dm-typing-${theme.id} 1.2s ease-in-out infinite;
            }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(2) { animation-delay: 0.15s; }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(3) { animation-delay: 0.30s; }
        `,

        val: `
            /* Tactical: sharp 2px corners, no rounding, scanline cursor */
            body.${cls} [class*="messageContent_"],
            body.${cls} [class*="card_"],
            body.${cls} [class*="modal_"],
            body.${cls} button,
            body.${cls} [class*="categoryItem_"] { border-radius: 2px !important; }
            /* Inset bracket on hovered messages — Val UI motif */
            body.${cls} [class*="messageListItem_"]:hover {
                box-shadow: inset 3px 0 0 ${p.brand}, inset -3px 0 0 ${p.brand};
            }
            /* Mention strip = brand-red instead of yellow */
            body.${cls} [class*="mentioned_"] [class*="content_"] {
                box-shadow: inset 2px 0 0 ${p.brand};
                animation: dm-mention-glow-${theme.id} 1.6s ease-in-out infinite;
            }
            /* Replace dots with tactical bracket — '[ • • • ]' */
            body.${cls} [class*="typing_"] [class*="dot_"] {
                width: 4px; height: 4px; background-color: ${p.brand} !important;
                animation: dm-typing-${theme.id} 0.9s steps(2, end) infinite;
            }
            /* Cream-on-charcoal headers */
            body.${cls} h1, body.${cls} h2, body.${cls} h3 {
                font-family: 'Tungsten', 'Bebas Neue', 'Anton', Impact, sans-serif;
                letter-spacing: 0.04em; text-transform: uppercase;
            }
            /* Caret color — cream */
            body.${cls} [class*="textArea_"] [class*="slateContainer_"] { caret-color: ${p.textNormal}; }
        `,

        sonic: `
            /* Speed — ultra-rounded, fast transitions, gold sparkle on hover */
            body.${cls} [class*="messageContent_"],
            body.${cls} [class*="card_"],
            body.${cls} button,
            body.${cls} [class*="modal_"],
            body.${cls} [class*="container_"] [class*="popout_"] { border-radius: 14px !important; }
            body.${cls} [class*="avatar_"] { border-radius: 50% !important; }
            body.${cls} * { transition-duration: 80ms !important; }
            body.${cls} [class*="messageListItem_"]:hover {
                background: linear-gradient(90deg, ${p.brandTrans} 0%, transparent 12%);
            }
            /* Gold lightning bolt on unread badge */
            body.${cls} [class*="mentionsBadge_"] {
                background: linear-gradient(135deg, ${p.brand}, ${p.brandSoft}) !important;
                box-shadow: 0 0 10px ${p.brandTrans};
            }
            body.${cls} [class*="typing_"] [class*="dot_"] {
                background-color: ${p.brand} !important;
                animation: dm-typing-${theme.id} 0.6s ease-in-out infinite;
                box-shadow: 0 0 6px ${p.brandTrans};
            }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(2) { animation-delay: 0.10s; }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(3) { animation-delay: 0.20s; }
        `,

        dmc: `
            /* Gothic: sharp angled corners (clip-path on cards), serif accents */
            body.${cls} [class*="messageContent_"] {
                border-radius: 0 !important;
                position: relative;
            }
            body.${cls} [class*="card_"], body.${cls} [class*="modal_"] {
                border-radius: 0 !important;
                clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));
            }
            body.${cls} h1, body.${cls} h2, body.${cls} h3, body.${cls} h4 {
                font-family: ${theme.headingFont || "'Cormorant Garamond', Georgia, serif"};
                letter-spacing: 0.02em;
            }
            /* Bloody drip on mention border */
            body.${cls} [class*="mentioned_"] [class*="content_"]::before {
                content: ""; position: absolute; left: 0; top: 100%;
                width: 2px; height: 6px; background: ${p.brand};
                animation: dm-drip-${theme.id} 1.8s ease-in infinite;
            }
            body.${cls} [class*="mentioned_"] [class*="content_"] {
                box-shadow: inset 2px 0 0 ${p.brand};
                position: relative;
            }
            /* (Removed per-message fade-in: Discord recycles message nodes on
               scroll, so the animation re-fired on every recycled row →
               continuous repaint cost, ironically fighting TournamentMode. Pure
               CSS can't distinguish a genuinely new message from a recycled one.) */
            body.${cls} [class*="typing_"] [class*="dot_"] {
                background-color: ${p.brand} !important;
                animation: dm-typing-${theme.id} 1.6s ease-in-out infinite;
                box-shadow: 0 0 4px ${p.brandTrans};
            }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(2) { animation-delay: 0.30s; }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(3) { animation-delay: 0.60s; }
        `,

        bo3: `
            /* Military stencil: blocky corners, neon orange glow on accents */
            body.${cls} [class*="messageContent_"],
            body.${cls} [class*="card_"],
            body.${cls} [class*="modal_"],
            body.${cls} button { border-radius: 1px !important; }
            body.${cls} h1, body.${cls} h2, body.${cls} h3 {
                font-family: 'Tungsten', 'Oswald', 'Bebas Neue', Impact, sans-serif;
                letter-spacing: 0.05em; text-transform: uppercase;
            }
            /* HUD-style underline on usernames */
            body.${cls} [class*="messageListItem_"]:hover [class*="username_"] {
                text-shadow: 0 0 4px ${p.brandTrans};
                border-bottom: 1px solid ${p.brand};
            }
            /* Mention badge: angled stencil notch */
            body.${cls} [class*="mentionsBadge_"], body.${cls} [class*="numberBadge_"] {
                clip-path: polygon(6% 0, 100% 0, 94% 100%, 0 100%);
                background: ${p.brand} !important;
                box-shadow: 0 0 8px ${p.brandTrans};
            }
            /* Typing — three vertical bars instead of dots, like a HUD scan */
            body.${cls} [class*="typing_"] [class*="dot_"] {
                width: 2px !important; height: 8px !important; border-radius: 0 !important;
                background-color: ${p.brand} !important;
                animation: dm-typing-${theme.id} 1.0s ease-in-out infinite;
                box-shadow: 0 0 6px ${p.brandTrans};
            }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(2) { animation-delay: 0.12s; }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(3) { animation-delay: 0.24s; }
        `,

        akatsuki: `
            /* Cloud-soft mention badges — Akatsuki cloud silhouette feel */
            body.${cls} [class*="mentionsBadge_"], body.${cls} [class*="numberBadge_"] {
                border-radius: 50% / 60% !important;
                background: radial-gradient(circle at 30% 30%, ${p.brandSoft}, ${p.brandDark}) !important;
                box-shadow: 0 0 8px ${p.brandTrans}, inset 0 1px 0 rgba(255,255,255,0.18);
            }
            /* Headband-scratch sweep across mention strip */
            body.${cls} [class*="mentioned_"] [class*="content_"] {
                box-shadow: inset 2px 0 0 ${p.brand};
                position: relative; overflow: hidden;
            }
            body.${cls} [class*="mentioned_"] [class*="content_"]::after {
                content: ""; position: absolute; left: 0; top: 50%;
                width: 100%; height: 1px; transform: translateY(-50%) rotate(-1.5deg);
                background: linear-gradient(90deg, transparent, ${p.brandTrans} 30%, ${p.brand} 50%, ${p.brandTrans} 70%, transparent);
                opacity: 0.6;
                animation: dm-akatsuki-scratch 4.2s ease-in-out infinite;
            }
            @keyframes dm-akatsuki-scratch {
                0%, 100% { opacity: 0.0; transform: translate(-30%, -50%) rotate(-1.5deg); }
                50% { opacity: 0.7; transform: translate(20%, -50%) rotate(-1.5deg); }
            }
            body.${cls} h1, body.${cls} h2, body.${cls} h3, body.${cls} h4 {
                font-family: ${theme.headingFont || "'Cinzel', Georgia, serif"};
                letter-spacing: 0.04em; text-transform: uppercase;
            }
            /* (Removed per-message fade-in — see dmc note: recycled message
               nodes re-fired it on every scroll, a needless repaint cost.) */
            /* Bloody dripping typing dots */
            body.${cls} [class*="typing_"] [class*="dot_"] {
                background-color: ${p.brand} !important;
                animation: dm-typing-${theme.id} 1.4s ease-in-out infinite;
                box-shadow: 0 2px 4px ${p.brandTrans};
            }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(2) { animation-delay: 0.25s; }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(3) { animation-delay: 0.50s; }
            /* Sharp-cornered cards (like a torn scroll) */
            body.${cls} [class*="card_"], body.${cls} [class*="modal_"] {
                border-radius: 0 !important;
                clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%);
            }
        `,

        dmcdt: `
            /* Devil Trigger pulse — red→blue→red shimmer on mention badges */
            body.${cls} [class*="mentionsBadge_"], body.${cls} [class*="numberBadge_"] {
                background: ${p.brand} !important;
                animation: dm-devil-trigger 1.8s ease-in-out infinite;
                clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
                box-shadow: 0 0 10px ${p.brandTrans};
            }
            @keyframes dm-devil-trigger {
                0%, 100% { background: ${p.brand}; box-shadow: 0 0 10px ${p.brandTrans}; }
                50% { background: ${p.textLink}; box-shadow: 0 0 14px ${p.borderGlow}; }
            }
            /* SDT corona on hovered messages — dual-tone red+blue glow */
            body.${cls} [class*="messageListItem_"]:hover {
                background: linear-gradient(90deg, ${p.brandTrans} 0%, transparent 8%);
                box-shadow: inset 2px 0 0 ${p.brand}, inset 0 -1px 0 ${p.borderGlow};
            }
            /* Mention strip — red border with Sparda-blue glow drip */
            body.${cls} [class*="mentioned_"] [class*="content_"] {
                box-shadow: inset 2px 0 0 ${p.brand}, 0 0 12px -4px ${p.borderGlow};
                position: relative;
            }
            body.${cls} [class*="mentioned_"] [class*="content_"]::before {
                content: ""; position: absolute; left: 0; top: 100%;
                width: 2px; height: 8px;
                background: linear-gradient(${p.brand}, ${p.textLink});
                animation: dm-drip-${theme.id} 1.6s ease-in infinite;
            }
            /* Heavy serif headings — gothic-aggressive */
            body.${cls} h1, body.${cls} h2, body.${cls} h3 {
                font-family: ${theme.headingFont || "'Cinzel', Georgia, serif"};
                letter-spacing: 0.03em; font-weight: 700;
                text-shadow: 0 0 4px ${p.brandTrans};
            }
            /* Sharp angled corners on cards */
            body.${cls} [class*="card_"], body.${cls} [class*="modal_"] {
                border-radius: 0 !important;
                clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
            }
            body.${cls} [class*="messageContent_"] { border-radius: 0 !important; }
            /* Typing — red embers with blue cores */
            body.${cls} [class*="typing_"] [class*="dot_"] {
                background-color: ${p.brand} !important;
                animation: dm-typing-${theme.id} 1.2s ease-in-out infinite;
                box-shadow: 0 0 4px ${p.brandTrans}, inset 0 0 2px ${p.textLink};
            }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(2) { animation-delay: 0.20s; }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(3) { animation-delay: 0.40s; }
        `,

        eminence: `
            /* Atomic pulse — slow expand on mention badges with cyan halo */
            body.${cls} [class*="mentionsBadge_"], body.${cls} [class*="numberBadge_"] {
                background: ${p.brand} !important;
                animation: dm-atomic-${theme.id} 2.6s ease-in-out infinite;
                box-shadow: 0 0 8px ${p.brandTrans};
            }
            @keyframes dm-atomic-${theme.id} {
                0%, 100% { box-shadow: 0 0 6px ${p.brandTrans}, 0 0 0 0 ${p.borderGlow}; }
                50% { box-shadow: 0 0 14px ${p.brandTrans}, 0 0 20px 2px ${p.borderGlow}; }
            }
            /* Lightning-crackle border on mention strip */
            body.${cls} [class*="mentioned_"] [class*="content_"] {
                box-shadow: inset 2px 0 0 ${p.brand};
                position: relative; overflow: hidden;
            }
            body.${cls} [class*="mentioned_"] [class*="content_"]::after {
                content: ""; position: absolute; left: 0; top: 0;
                width: 2px; height: 100%;
                background: ${p.textLink};
                animation: dm-lightning-${theme.id} 1.4s steps(8, end) infinite;
                opacity: 0;
            }
            @keyframes dm-lightning-${theme.id} {
                0%, 92%, 100% { opacity: 0; transform: translateY(0); }
                93% { opacity: 1; transform: translateY(-3px); box-shadow: 0 0 6px ${p.textLink}; }
                95% { opacity: 0.4; transform: translateY(2px); }
                97% { opacity: 1; transform: translateY(-1px); box-shadow: 0 0 10px ${p.textLink}; }
            }
            /* Slime-drip hover — purple-to-cyan gradient streak */
            body.${cls} [class*="messageListItem_"]:hover {
                background: linear-gradient(90deg, ${p.brandTrans} 0%, rgba(90, 227, 255, 0.06) 6%, transparent 14%);
            }
            /* Theatrical heading — Cid's "I am... Shadow" energy */
            body.${cls} h1, body.${cls} h2, body.${cls} h3 {
                font-family: ${theme.headingFont || "'Cinzel Decorative', Georgia, serif"};
                letter-spacing: 0.06em;
                text-shadow: 0 0 8px ${p.brandTrans}, 0 0 16px ${p.borderGlow};
            }
            /* Soft 8px corners — slime-soft, not gothic */
            body.${cls} [class*="messageContent_"],
            body.${cls} [class*="card_"],
            body.${cls} [class*="modal_"] { border-radius: 8px !important; }
            /* Cyan electric typing flicker */
            body.${cls} [class*="typing_"] [class*="dot_"] {
                background-color: ${p.textLink} !important;
                animation: dm-typing-${theme.id} 0.8s steps(3, end) infinite;
                box-shadow: 0 0 6px ${p.borderGlow};
            }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(2) { animation-delay: 0.12s; }
            body.${cls} [class*="typing_"] [class*="dot_"]:nth-child(3) { animation-delay: 0.24s; }
        `
    };

    return `${SHARED_KEYFRAMES}\n${PERSONALITY[theme.id] || ""}`;
}

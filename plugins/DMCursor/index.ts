/*
 * Discordmaxxer — DiscordmaxxerCursor plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Custom anime cursors ported from the maxxer suite (clipmaxxing's
 * AnimeCursor.tsx, originally from fortnite-dropmap). Six skins:
 * sharingan, rinnegan, rasengan, chidori, dragonsword, stiiizy.
 *
 * Behavior:
 *   - Hides the OS cursor while active (via .anime-cursor-active class
 *     on the document root)
 *   - Tracks mousemove, renders the cursor SVG at pointer position
 *   - Stiiizy emits smoke particles on movement
 *
 * Off by default — opt-in via plugin toggle. Skin chosen via setting.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import { Toasts } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

import { hasTier, Tier, TIER_LABELS } from "../_dm-shared/vip";

type CursorSkin = "sharingan" | "rinnegan" | "rasengan" | "chidori" | "dragonsword" | "stiiizy";

// Free teaser: Dragon Sword (simplest, no animation loops). All five
// flashy/animated skins gate behind MAXXER — matches the tier-ladder
// promise of "5 cursor skins" in the marquee perk.
const SKIN_TIER: Record<CursorSkin, Tier> = {
    dragonsword: Tier.FREE,
    sharingan:   Tier.MAXXER,
    rinnegan:    Tier.MAXXER,
    rasengan:    Tier.MAXXER,
    chidori:     Tier.MAXXER,
    stiiizy:     Tier.MAXXER
};

const FREE_FALLBACK: CursorSkin | "off" = "off";

function lockedLabel(label: string, tier: Tier): string {
    return tier === Tier.FREE ? label : `🔒 ${label} (${TIER_LABELS[tier]})`;
}

const CURSOR_SVGS: Record<CursorSkin, string> = {
    sharingan: `<svg width="32" height="32" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="16" fill="none" stroke="#cc0000" stroke-width="2.5" class="sharingan-outer"/>
        <circle cx="20" cy="20" r="15" fill="#8B0000" opacity="0.8"/>
        <circle cx="20" cy="20" r="10" fill="none" stroke="#000" stroke-width="1.5"/>
        <circle cx="20" cy="20" r="4" fill="#000"/>
        <g class="sharingan-tomoe">
            <circle cx="20" cy="9" r="2.5" fill="#000"/>
            <path d="M20 9 Q24 12 20 14" fill="#000" opacity="0.8"/>
            <circle cx="29.5" cy="25.5" r="2.5" fill="#000"/>
            <path d="M29.5 25.5 Q25 27 24 23" fill="#000" opacity="0.8"/>
            <circle cx="10.5" cy="25.5" r="2.5" fill="#000"/>
            <path d="M10.5 25.5 Q15 27 16 23" fill="#000" opacity="0.8"/>
        </g>
    </svg>`,
    rinnegan: `<svg width="34" height="34" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="18" fill="#2d0a4e" stroke="#7b2d8e" stroke-width="2"/>
        <circle cx="21" cy="21" r="15" fill="none" stroke="#9b4dca" stroke-width="1.2" opacity="0.8"/>
        <circle cx="21" cy="21" r="12" fill="none" stroke="#9b4dca" stroke-width="1.2" opacity="0.7"/>
        <circle cx="21" cy="21" r="9" fill="none" stroke="#9b4dca" stroke-width="1.2" opacity="0.6"/>
        <circle cx="21" cy="21" r="6" fill="none" stroke="#9b4dca" stroke-width="1.2" opacity="0.5"/>
        <circle cx="21" cy="21" r="3" fill="#1a0030"/>
        <circle cx="21" cy="21" r="1.5" fill="#000"/>
        <circle cx="21" cy="6" r="1.5" fill="#000" class="rinnegan-dot"/>
        <circle cx="33" cy="15" r="1.5" fill="#000" class="rinnegan-dot"/>
        <circle cx="33" cy="27" r="1.5" fill="#000" class="rinnegan-dot"/>
        <circle cx="21" cy="36" r="1.5" fill="#000" class="rinnegan-dot"/>
        <circle cx="9" cy="27" r="1.5" fill="#000" class="rinnegan-dot"/>
        <circle cx="9" cy="15" r="1.5" fill="#000" class="rinnegan-dot"/>
    </svg>`,
    rasengan: `<svg width="32" height="32" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="6" fill="rgba(120,180,255,0.9)" class="rasengan-core-svg"/>
        <circle cx="20" cy="20" r="6" fill="none" stroke="rgba(200,230,255,0.8)" stroke-width="1"/>
        <circle cx="20" cy="20" r="11" fill="none" stroke="rgba(100,160,255,0.5)" stroke-width="1.5" class="rasengan-ring-1"/>
        <circle cx="20" cy="20" r="15" fill="none" stroke="rgba(80,140,255,0.3)" stroke-width="1" stroke-dasharray="4 3" class="rasengan-ring-2"/>
        <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(60,120,255,0.2)" stroke-width="0.8" class="rasengan-ring-3"/>
    </svg>`,
    chidori: `<svg width="36" height="36" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="8" fill="rgba(100,180,255,0.3)"/>
        <circle cx="22" cy="22" r="4" fill="rgba(200,230,255,0.9)"/>
        <path d="M22 14 L24 8 L20 12 L22 4" fill="none" stroke="#4fc3f7" stroke-width="1.5" class="chidori-bolt"/>
        <path d="M30 22 L36 20 L32 24 L40 22" fill="none" stroke="#4fc3f7" stroke-width="1.5" class="chidori-bolt" style="animation-delay: 0.1s"/>
        <path d="M22 30 L20 36 L24 32 L22 40" fill="none" stroke="#4fc3f7" stroke-width="1.5" class="chidori-bolt" style="animation-delay: 0.2s"/>
        <path d="M14 22 L8 24 L12 20 L4 22" fill="none" stroke="#4fc3f7" stroke-width="1.5" class="chidori-bolt" style="animation-delay: 0.15s"/>
        <path d="M28 14 L34 8" fill="none" stroke="#81d4fa" stroke-width="1" class="chidori-bolt" style="animation-delay: 0.05s"/>
        <path d="M14 28 L8 34" fill="none" stroke="#81d4fa" stroke-width="1" class="chidori-bolt" style="animation-delay: 0.25s"/>
    </svg>`,
    stiiizy: `<svg width="14" height="44" viewBox="0 0 14 44">
        <rect x="2" y="8" width="10" height="32" rx="3" fill="#1a1a1a" stroke="#333" stroke-width="0.5"/>
        <rect x="2" y="8" width="10" height="3" rx="1.5" fill="#888"/>
        <rect x="3" y="9" width="8" height="1" rx="0.5" fill="#ccc" opacity="0.5"/>
        <rect x="3" y="2" width="8" height="7" rx="2.5" fill="#222" stroke="#444" stroke-width="0.5"/>
        <circle cx="7" cy="37" r="1.5" fill="#4ade80" class="stiiizy-led"/>
        <text x="7" y="26" text-anchor="middle" fill="#555" font-size="3" font-weight="700" font-family="sans-serif">STZY</text>
    </svg>`,
    dragonsword: `<svg width="40" height="40" viewBox="0 0 50 50" style="transform: rotate(-45deg)">
        <path d="M25 2 L28 20 L25 22 L22 20 Z" fill="#c0c0c0" stroke="#888" stroke-width="0.5"/>
        <path d="M25 4 L26.5 18 L25 20 L23.5 18 Z" fill="#e0e0e0" opacity="0.6"/>
        <path d="M16 22 Q20 18 25 22 Q30 18 34 22 L30 24 L25 23 L20 24 Z" fill="#4a2800" stroke="#8B6914" stroke-width="0.5"/>
        <rect x="23" y="24" width="4" height="14" rx="1" fill="#3a1f00"/>
        <rect x="23.5" y="26" width="3" height="2" rx="0.5" fill="#8B6914" opacity="0.6"/>
        <rect x="23.5" y="30" width="3" height="2" rx="0.5" fill="#8B6914" opacity="0.6"/>
        <rect x="23.5" y="34" width="3" height="2" rx="0.5" fill="#8B6914" opacity="0.6"/>
        <circle cx="25" cy="40" r="3.5" fill="#4a2800" stroke="#8B6914" stroke-width="0.5"/>
        <circle cx="24" cy="39" r="1" fill="#ff4444" opacity="0.7"/>
        <circle cx="26" cy="39" r="1" fill="#ff4444" opacity="0.7"/>
        <circle cx="25" cy="12" r="2" fill="none" stroke="#ff4444" stroke-width="0.8" opacity="0.5"/>
    </svg>`
};

const CURSOR_CSS = `
    html.anime-cursor-active,
    html.anime-cursor-active body,
    html.anime-cursor-active *,
    html.anime-cursor-active *::before,
    html.anime-cursor-active *::after { cursor: none !important; }
    .anime-cursor {
        position: fixed;
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 2147483647;
    }
    .anime-cursor--rinnegan { filter: drop-shadow(0 0 8px rgba(155,77,202,0.7)) drop-shadow(0 0 16px rgba(123,45,142,0.4)); }
    .anime-cursor--rinnegan svg { animation: dmCursorRotateSlow 8s linear infinite; }
    .anime-cursor--rinnegan svg circle:nth-child(3) { animation: dmCursorRing 2s ease-in-out infinite; }
    .anime-cursor--rinnegan svg circle:nth-child(4) { animation: dmCursorRing 2s ease-in-out infinite 0.3s; }
    .anime-cursor--rinnegan svg circle:nth-child(5) { animation: dmCursorRing 2s ease-in-out infinite 0.6s; }
    .anime-cursor--rinnegan svg circle:nth-child(6) { animation: dmCursorRing 2s ease-in-out infinite 0.9s; }
    .rinnegan-dot { animation: dmCursorRinneganDot 1.5s ease-in-out infinite alternate; }
    .anime-cursor--sharingan { filter: drop-shadow(0 0 6px rgba(200,0,0,0.6)) drop-shadow(0 0 12px rgba(150,0,0,0.3)); }
    .sharingan-outer { animation: dmCursorPulseRed 2s ease-in-out infinite alternate; }
    .sharingan-tomoe { transform-origin: 20px 20px; animation: dmCursorSpin 1.5s linear infinite; }
    .anime-cursor--rasengan { filter: drop-shadow(0 0 8px rgba(100,160,255,0.7)) drop-shadow(0 0 16px rgba(60,120,255,0.4)); }
    .rasengan-core-svg { animation: dmCursorPulseBlue 1s ease-in-out infinite alternate; }
    .rasengan-ring-1 { transform-origin: 20px 20px; animation: dmCursorSpin 0.8s linear infinite; }
    .rasengan-ring-2 { transform-origin: 20px 20px; animation: dmCursorSpin 1.2s linear infinite reverse; }
    .rasengan-ring-3 { transform-origin: 20px 20px; animation: dmCursorSpin 0.5s linear infinite; }
    .anime-cursor--chidori { filter: drop-shadow(0 0 8px rgba(79,195,247,0.7)); }
    .chidori-bolt { animation: dmCursorFlicker 0.3s steps(2) infinite; }
    .anime-cursor--stiiizy { filter: drop-shadow(0 0 4px rgba(74,222,128,0.4)); }
    .stiiizy-led { animation: dmCursorStiiizyLed 2s ease-in-out infinite; }
    .anime-cursor--dragonsword { filter: drop-shadow(0 0 4px rgba(200,150,50,0.5)); }
    .stiiizy-smoke {
        position: fixed;
        width: var(--smoke-size, 12px);
        height: var(--smoke-size, 12px);
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255,255,255,0.55), rgba(245,245,245,0.3), rgba(230,230,230,0.1), transparent);
        pointer-events: none;
        z-index: 2147483646;
        animation: dmCursorSmokeDrift 1.5s ease-out forwards;
    }
    @keyframes dmCursorSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes dmCursorRotateSlow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes dmCursorPulseRed { 0% { fill: #8B0000; filter: brightness(0.8); } 100% { fill: #cc0000; filter: brightness(1.3); } }
    @keyframes dmCursorPulseBlue { 0% { fill: rgba(100,160,255,0.7); } 100% { fill: rgba(160,210,255,1); } }
    @keyframes dmCursorRing { 0%, 100% { stroke-opacity: 0.4; stroke-width: 1.2; } 50% { stroke-opacity: 1; stroke-width: 2; } }
    @keyframes dmCursorRinneganDot { 0% { r: 1.5; fill: #000; } 100% { r: 2; fill: #6b2fa0; } }
    @keyframes dmCursorFlicker { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
    @keyframes dmCursorStiiizyLed { 0%, 100% { fill: #4ade80; opacity: 1; } 50% { fill: #22c55e; opacity: 0.5; } }
    @keyframes dmCursorSmokeDrift {
        0%   { transform: translate(0, 0) scale(0.3); opacity: 0.7; filter: blur(1px); }
        30%  { transform: translate(calc(var(--smoke-dx, 0px) * 0.3), calc(var(--smoke-dy, -20px) * 0.3)) scale(0.8); opacity: 0.55; filter: blur(2px); }
        60%  { transform: translate(calc(var(--smoke-dx, 0px) * 0.6), calc(var(--smoke-dy, -20px) * 0.6)) scale(1.4); opacity: 0.3; filter: blur(3px); }
        100% { transform: translate(var(--smoke-dx, 0px), var(--smoke-dy, -30px)) scale(2.5); opacity: 0; filter: blur(5px); }
    }
`;

const CURSOR_ID = "dm-cursor";
let cursorEl: HTMLDivElement | null = null;
let style: HTMLStyleElement;
let mousemoveHandler: ((e: MouseEvent) => void) | null = null;
let fullscreenHandler: (() => void) | null = null;
let lastX = -100;
let lastY = -100;

const settings = definePluginSettings({
    skin: {
        type: OptionType.SELECT,
        description: "Cursor skin — ported from the maxxer-suite anime cursors. Dragon Sword is free; the five animated skins require MAXXER (we'll fall back to Off if you don't qualify).",
        default: "off",
        options: [
            { label: "Off (Discord default)", value: "off", default: true },
            { label: lockedLabel("Sharingan — red eye, spinning tomoe", Tier.MAXXER), value: "sharingan" },
            { label: lockedLabel("Rinnegan — purple ringed eye", Tier.MAXXER), value: "rinnegan" },
            { label: lockedLabel("Rasengan — spinning blue ball", Tier.MAXXER), value: "rasengan" },
            { label: lockedLabel("Chidori — lightning bolts", Tier.MAXXER), value: "chidori" },
            { label: "Dragon Sword — silver blade", value: "dragonsword" },
            { label: lockedLabel("Stiiizy — smoke trail (most chaotic)", Tier.MAXXER), value: "stiiizy" }
        ],
        onChange: (value: string) => applySkin(value as CursorSkin | "off")
    }
});

function deactivate() {
    document.documentElement.classList.remove("anime-cursor-active");
    document.documentElement.style.removeProperty("cursor");
    document.body?.style.removeProperty("cursor");
}

function applySkin(skin: CursorSkin | "off") {
    teardownTracking();

    if (skin === "off") {
        deactivate();
        return;
    }

    // Tier gate — match DiscordmaxxerTheme: fall back to Off + toast.
    const required = SKIN_TIER[skin];
    if (required !== Tier.FREE && !hasTier(required)) {
        const tierStr = TIER_LABELS[required];
        console.warn(`[DiscordmaxxerCursor] skin="${skin}" requires ${tierStr} — falling back to ${FREE_FALLBACK}`);
        try {
            Toasts.show({
                message: `🔒 "${skin}" cursor requires ${tierStr} — using Discord default instead`,
                id: Toasts.genId(),
                type: Toasts.Type.MESSAGE,
                options: { duration: 4000 }
            });
        } catch { /* toast may not be ready during start() */ }
        deactivate();
        return;
    }

    // Never hide the OS cursor before we know we can append a replacement —
    // if document.body is somehow absent, bail rather than leave the user with
    // no visible cursor at all.
    if (!document.body) {
        deactivate();
        return;
    }

    document.documentElement.classList.add("anime-cursor-active");
    // Belt-and-suspenders: set inline cursor:none with !important on root
    // and body. Beats any Discord rule that matches with higher specificity.
    document.documentElement.style.setProperty("cursor", "none", "important");
    document.body.style.setProperty("cursor", "none", "important");

    cursorEl = document.createElement("div");
    cursorEl.id = CURSOR_ID;
    cursorEl.className = `anime-cursor anime-cursor--${skin}`;
    cursorEl.style.left = "-100px";
    cursorEl.style.top = "-100px";
    cursorEl.innerHTML = CURSOR_SVGS[skin];
    document.body.appendChild(cursorEl);

    mousemoveHandler = (e: MouseEvent) => {
        if (!cursorEl) return;
        lastX = e.clientX;
        lastY = e.clientY;
        cursorEl.style.left = e.clientX + "px";
        cursorEl.style.top = e.clientY + "px";

        // Stiiizy: smoke trail. Append to the cursor's parent (fullscreen
        // element when active, otherwise body) so trails don't fall behind
        // the top-layer fullscreen content.
        if (skin === "stiiizy" && Math.random() > 0.35) {
            const smoke = document.createElement("div");
            smoke.className = "stiiizy-smoke";
            smoke.style.left = e.clientX + (Math.random() * 6 - 3) + "px";
            smoke.style.top = e.clientY - 22 + "px";
            smoke.style.setProperty("--smoke-dx", Math.random() * 24 - 12 + "px");
            smoke.style.setProperty("--smoke-dy", -25 - Math.random() * 35 + "px");
            smoke.style.setProperty("--smoke-size", 10 + Math.random() * 16 + "px");
            (cursorEl.parentElement ?? document.body).appendChild(smoke);
            setTimeout(() => smoke.remove(), 1500);
        }
    };
    window.addEventListener("mousemove", mousemoveHandler);

    // Fullscreen API moves the fullscreen element into the browser's top
    // layer. Anything outside that element (including a cursor div on
    // document.body) renders BELOW the top layer and is invisible. Discord
    // uses requestFullscreen() on call-view video tiles and screenshare
    // previews, so during fullscreen the custom cursor vanishes and the OS
    // cursor stays hidden by our `cursor: none` rule — leaving no cursor
    // visible until ~1s after exit. Fix: reparent the cursor div to the
    // fullscreen element while active so it lives in the top layer too,
    // and snap it back to last known coords on transition.
    fullscreenHandler = () => {
        if (!cursorEl) return;
        const target = document.fullscreenElement ?? document.body;
        if (cursorEl.parentElement !== target) target.appendChild(cursorEl);
        cursorEl.style.left = lastX + "px";
        cursorEl.style.top = lastY + "px";
    };
    document.addEventListener("fullscreenchange", fullscreenHandler);
}

function teardownTracking() {
    if (mousemoveHandler) {
        window.removeEventListener("mousemove", mousemoveHandler);
        mousemoveHandler = null;
    }
    if (fullscreenHandler) {
        document.removeEventListener("fullscreenchange", fullscreenHandler);
        fullscreenHandler = null;
    }
    cursorEl?.remove();
    cursorEl = null;
}

export default definePlugin({
    name: "DMCursor",
    description:
        "Custom anime cursors ported from the maxxer suite (clipmaxxing/dropmap origin). Six skins — Sharingan, Rinnegan, Rasengan, Chidori, Dragon Sword, Stiiizy (smoke trail). Pick via settings; toggling the plugin off restores Discord's default cursor.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-cursor-style", managedStyleRootNode);
        style.textContent = CURSOR_CSS;
        applySkin(settings.store.skin as CursorSkin | "off");
    },

    stop() {
        teardownTracking();
        deactivate();
        style?.remove();
    }
});

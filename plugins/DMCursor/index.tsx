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
 *   - Stiiizy emits smoke particles on movement into an isolated container
 *
 * Off by default — opt-in via plugin toggle. Skin chosen via setting.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import { React, Toasts } from "@webpack/common";
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
    sharingan: `<svg width="40" height="40" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="16" fill="none" stroke="#cc0000" stroke-width="2.5" class="sharingan-outer-ring"/>
        <circle cx="20" cy="20" r="15" fill="#8B0000" opacity="0.85" class="sharingan-pupil-bg"/>
        <circle cx="20" cy="20" r="10" fill="none" stroke="#000" stroke-width="1.5"/>
        <circle cx="20" cy="20" r="3.5" fill="#000"/>
        <g class="sharingan-tomoe">
            <animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="2.2s" repeatCount="indefinite"/>
            <circle cx="20" cy="9" r="2.5" fill="#000"/>
            <path d="M20 9 Q24 12 20 14" fill="#000" opacity="0.85"/>
            <circle cx="29.5" cy="25.5" r="2.5" fill="#000"/>
            <path d="M29.5 25.5 Q25 27 24 23" fill="#000" opacity="0.85"/>
            <circle cx="10.5" cy="25.5" r="2.5" fill="#000"/>
            <path d="M10.5 25.5 Q15 27 16 23" fill="#000" opacity="0.85"/>
        </g>
    </svg>`,
    rinnegan: `<svg width="42" height="42" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="18" fill="#2d0a4e" stroke="#7b2d8e" stroke-width="2"/>
        <circle cx="21" cy="21" r="15" fill="none" stroke="#9b4dca" stroke-width="1.3" class="rinnegan-ring rinnegan-ring-1"/>
        <circle cx="21" cy="21" r="12" fill="none" stroke="#9b4dca" stroke-width="1.3" class="rinnegan-ring rinnegan-ring-2"/>
        <circle cx="21" cy="21" r="9" fill="none" stroke="#9b4dca" stroke-width="1.3" class="rinnegan-ring rinnegan-ring-3"/>
        <circle cx="21" cy="21" r="6" fill="none" stroke="#9b4dca" stroke-width="1.3" class="rinnegan-ring rinnegan-ring-4"/>
        <circle cx="21" cy="21" r="3" fill="#1a0030"/>
        <circle cx="21" cy="21" r="1.5" fill="#000"/>
        <g class="rinnegan-dots">
            <animateTransform attributeName="transform" type="rotate" from="0 21 21" to="360 21 21" dur="14s" repeatCount="indefinite"/>
            <circle cx="21" cy="6" r="1.8" fill="#000" class="rinnegan-dot"/>
            <circle cx="33" cy="15" r="1.8" fill="#000" class="rinnegan-dot"/>
            <circle cx="33" cy="27" r="1.8" fill="#000" class="rinnegan-dot"/>
            <circle cx="21" cy="36" r="1.8" fill="#000" class="rinnegan-dot"/>
            <circle cx="9" cy="27" r="1.8" fill="#000" class="rinnegan-dot"/>
            <circle cx="9" cy="15" r="1.8" fill="#000" class="rinnegan-dot"/>
        </g>
    </svg>`,
    rasengan: `<svg width="40" height="40" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="6" fill="rgba(140,200,255,0.95)" class="rasengan-core-svg"/>
        <circle cx="20" cy="20" r="6" fill="none" stroke="rgba(220,240,255,0.9)" stroke-width="1.2"/>
        <g class="rasengan-spin-1">
            <animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="0.8s" repeatCount="indefinite"/>
            <circle cx="20" cy="20" r="10" fill="none" stroke="rgba(120,185,255,0.7)" stroke-width="1.5" stroke-dasharray="14 6" class="rasengan-ring-1"/>
        </g>
        <g class="rasengan-spin-2">
            <animateTransform attributeName="transform" type="rotate" from="360 20 20" to="0 20 20" dur="1.2s" repeatCount="indefinite"/>
            <circle cx="20" cy="20" r="14" fill="none" stroke="rgba(90,160,255,0.6)" stroke-width="1.3" stroke-dasharray="8 4 16 4" class="rasengan-ring-2"/>
        </g>
        <g class="rasengan-spin-3">
            <animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="0.6s" repeatCount="indefinite"/>
            <circle cx="20" cy="20" r="17" fill="none" stroke="rgba(60,130,255,0.45)" stroke-width="1" stroke-dasharray="16 8" class="rasengan-ring-3"/>
        </g>
    </svg>`,
    chidori: `<svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="8" fill="rgba(100,180,255,0.3)" class="chidori-glow"/>
        <circle cx="22" cy="22" r="4.5" fill="rgba(220,245,255,0.95)" class="chidori-core"/>
        <path d="M22 14 L24 8 L20 12 L22 4" fill="none" stroke="#4fc3f7" stroke-width="1.6" class="chidori-bolt chidori-bolt-1"/>
        <path d="M30 22 L36 20 L32 24 L40 22" fill="none" stroke="#4fc3f7" stroke-width="1.6" class="chidori-bolt chidori-bolt-2"/>
        <path d="M22 30 L20 36 L24 32 L22 40" fill="none" stroke="#4fc3f7" stroke-width="1.6" class="chidori-bolt chidori-bolt-3"/>
        <path d="M14 22 L8 24 L12 20 L4 22" fill="none" stroke="#4fc3f7" stroke-width="1.6" class="chidori-bolt chidori-bolt-4"/>
        <path d="M28 14 L34 8" fill="none" stroke="#81d4fa" stroke-width="1.3" class="chidori-bolt chidori-bolt-5"/>
        <path d="M14 28 L8 34" fill="none" stroke="#81d4fa" stroke-width="1.3" class="chidori-bolt chidori-bolt-6"/>
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
    html.anime-cursor-active * {
        cursor: none !important;
    }
    .anime-cursor {
        position: fixed;
        top: 0;
        left: 0;
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: translate3d(-100px, -100px, 0) translate(-50%, -50%);
        pointer-events: none;
        z-index: 2147483647;
        will-change: transform;
        contain: strict;
        backface-visibility: hidden;
    }
    .dm-cursor-smoke-container {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 2147483646;
        overflow: hidden;
    }
    .anime-cursor,
    .anime-cursor * {
        pointer-events: none !important;
    }
    .anime-cursor--sharingan { filter: drop-shadow(0 0 6px rgba(220, 0, 0, 0.75)); }
    .sharingan-pupil-bg { animation: dmCursorPulseRed 2s ease-in-out infinite alternate; }
    .sharingan-outer-ring { animation: dmCursorPulseRing 2s ease-in-out infinite alternate; }

    .anime-cursor--rinnegan { filter: drop-shadow(0 0 6px rgba(155, 77, 202, 0.75)); }
    .rinnegan-ring-1 { animation: dmCursorRinneganRing 2s ease-in-out infinite; }
    .rinnegan-ring-2 { animation: dmCursorRinneganRing 2s ease-in-out infinite 0.35s; }
    .rinnegan-ring-3 { animation: dmCursorRinneganRing 2s ease-in-out infinite 0.7s; }
    .rinnegan-ring-4 { animation: dmCursorRinneganRing 2s ease-in-out infinite 1.05s; }
    .rinnegan-dot { animation: dmCursorRinneganDot 1.8s ease-in-out infinite alternate; }

    .anime-cursor--rasengan { filter: drop-shadow(0 0 8px rgba(100, 160, 255, 0.8)); }
    .rasengan-core-svg { animation: dmCursorPulseBlue 1s ease-in-out infinite alternate; }

    .anime-cursor--chidori { filter: drop-shadow(0 0 6px rgba(79, 195, 247, 0.8)); }
    .chidori-core { transform-origin: 22px 22px; animation: dmCursorChidoriCore 0.4s ease-in-out infinite alternate; }
    .chidori-glow { transform-origin: 22px 22px; animation: dmCursorChidoriGlow 0.3s ease-in-out infinite alternate; }
    .chidori-bolt-1 { animation: dmCursorLightning 0.28s steps(2) infinite; }
    .chidori-bolt-2 { animation: dmCursorLightning 0.32s steps(2) infinite 0.08s; }
    .chidori-bolt-3 { animation: dmCursorLightning 0.26s steps(2) infinite 0.16s; }
    .chidori-bolt-4 { animation: dmCursorLightning 0.30s steps(2) infinite 0.10s; }
    .chidori-bolt-5 { animation: dmCursorLightning 0.24s steps(2) infinite 0.04s; }
    .chidori-bolt-6 { animation: dmCursorLightning 0.34s steps(2) infinite 0.20s; }

    .anime-cursor--stiiizy { filter: drop-shadow(0 0 4px rgba(74, 222, 128, 0.45)); }
    .stiiizy-led { animation: dmCursorStiiizyLed 1.8s ease-in-out infinite; }

    .anime-cursor--dragonsword { filter: drop-shadow(0 0 4px rgba(200, 150, 50, 0.55)); }

    .stiiizy-smoke {
        position: fixed;
        width: var(--smoke-size, 12px);
        height: var(--smoke-size, 12px);
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255,255,255,0.6), rgba(245,245,245,0.35), rgba(230,230,230,0.1), transparent);
        pointer-events: none;
        will-change: transform, opacity;
        animation: dmCursorSmokeDrift 1s ease-out forwards;
    }

    @keyframes dmCursorSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes dmCursorRotateSlow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes dmCursorPulseRed { 0% { fill: #6b0000; } 100% { fill: #c00000; } }
    @keyframes dmCursorPulseRing { 0% { stroke: #990000; opacity: 0.7; } 100% { stroke: #ff1a1a; opacity: 1; } }
    @keyframes dmCursorPulseBlue { 0% { fill: rgba(100,160,255,0.7); opacity: 0.8; } 100% { fill: rgba(180,225,255,1); opacity: 1; } }
    @keyframes dmCursorRinneganRing { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; stroke-width: 1.5; } }
    @keyframes dmCursorRinneganDot { 0% { fill: #000; opacity: 0.7; } 100% { fill: #9b4dca; opacity: 1; } }
    @keyframes dmCursorLightning {
        0%, 100% { opacity: 1; stroke: #4fc3f7; }
        20% { opacity: 0.15; }
        40% { opacity: 1; stroke: #ffffff; }
        60% { opacity: 0.3; }
        80% { opacity: 0.95; stroke: #81d4fa; }
    }
    @keyframes dmCursorChidoriCore { 0% { transform: scale(0.9); opacity: 0.85; } 100% { transform: scale(1.15); opacity: 1; } }
    @keyframes dmCursorChidoriGlow { 0% { opacity: 0.2; } 100% { opacity: 0.5; } }
    @keyframes dmCursorStiiizyLed { 0%, 100% { fill: #4ade80; opacity: 1; } 50% { fill: #22c55e; opacity: 0.4; } }
    @keyframes dmCursorSmokeDrift {
        0%   { transform: translate(0, 0) scale(0.3); opacity: 0.7; }
        40%  { transform: translate(calc(var(--smoke-dx, 0px) * 0.4), calc(var(--smoke-dy, -20px) * 0.4)) scale(0.9); opacity: 0.5; }
        100% { transform: translate(var(--smoke-dx, 0px), var(--smoke-dy, -30px)) scale(2.2); opacity: 0; }
    }
`;

const CURSOR_ID = "dm-cursor";
let activeSkin: CursorSkin | "off" = "off";
let cursorEl: HTMLDivElement | null = null;
let smokeContainer: HTMLDivElement | null = null;
let style: HTMLStyleElement;
let mousemoveHandler: ((e: MouseEvent) => void) | null = null;
let mouseRafId = 0;
let fullscreenHandler: (() => void) | null = null;
let lastX = -100;
let lastY = -100;
let lastSmokeTime = 0;
let lastSmokeX = -100;
let lastSmokeY = -100;

function emitSmokeIfNeeded(x: number, y: number) {
    if (!smokeContainer) return;
    if (Boolean((globalThis as any).__dmTournamentModeActive)) return;
    const now = performance.now();
    const dx = x - lastSmokeX;
    const dy = y - lastSmokeY;
    if (now - lastSmokeTime > 45 && (dx * dx + dy * dy > 80)) {
        lastSmokeTime = now;
        lastSmokeX = x;
        lastSmokeY = y;

        const smoke = document.createElement("div");
        smoke.className = "stiiizy-smoke";
        smoke.style.left = (x + (Math.random() * 6 - 3)) + "px";
        smoke.style.top = (y - 20) + "px";
        smoke.style.setProperty("--smoke-dx", (Math.random() * 24 - 12) + "px");
        smoke.style.setProperty("--smoke-dy", (-20 - Math.random() * 30) + "px");
        smoke.style.setProperty("--smoke-size", (10 + Math.random() * 14) + "px");
        smokeContainer.appendChild(smoke);
        setTimeout(() => smoke.remove(), 1000);
    }
}

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

    activeSkin = skin;
    document.documentElement.classList.add("anime-cursor-active");
    // Belt-and-suspenders: set inline cursor:none with !important on root
    // and body. Beats any Discord rule that matches with higher specificity.
    document.documentElement.style.setProperty("cursor", "none", "important");
    document.body.style.setProperty("cursor", "none", "important");

    if (skin === "stiiizy") {
        smokeContainer = document.createElement("div");
        smokeContainer.id = "dm-cursor-smoke-container";
        smokeContainer.className = "dm-cursor-smoke-container";
        document.body.appendChild(smokeContainer);
    }

    cursorEl = document.createElement("div");
    cursorEl.id = CURSOR_ID;
    cursorEl.className = `anime-cursor anime-cursor--${skin}`;
    if (lastX >= 0 && lastY >= 0) {
        cursorEl.style.transform = `translate3d(${lastX}px, ${lastY}px, 0) translate(-50%, -50%)`;
    } else {
        cursorEl.style.opacity = "0";
    }
    cursorEl.innerHTML = CURSOR_SVGS[skin];
    document.body.appendChild(cursorEl);

    mousemoveHandler = (e: MouseEvent) => {
        lastX = e.clientX;
        lastY = e.clientY;
        if (!mouseRafId) {
            mouseRafId = requestAnimationFrame(() => {
                mouseRafId = 0;
                if (cursorEl) {
                    cursorEl.style.opacity = "1";
                    cursorEl.style.transform = `translate3d(${lastX}px, ${lastY}px, 0) translate(-50%, -50%)`;
                }
                if (activeSkin === "stiiizy") {
                    emitSmokeIfNeeded(lastX, lastY);
                }
            });
        }
    };
    window.addEventListener("mousemove", mousemoveHandler, { passive: true });

    // Fullscreen API moves the fullscreen element into the browser's top
    // layer. Reparent the cursor div and smoke container to the fullscreen element while active.
    fullscreenHandler = () => {
        if (!cursorEl) return;
        const target = document.fullscreenElement ?? document.body;
        if (cursorEl.parentElement !== target) target.appendChild(cursorEl);
        if (smokeContainer && smokeContainer.parentElement !== target) target.appendChild(smokeContainer);
        cursorEl.style.transform = `translate3d(${lastX}px, ${lastY}px, 0) translate(-50%, -50%)`;
    };
    document.addEventListener("fullscreenchange", fullscreenHandler);
}

function teardownTracking() {
    activeSkin = "off";
    if (mouseRafId) {
        cancelAnimationFrame(mouseRafId);
        mouseRafId = 0;
    }
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
    smokeContainer?.remove();
    smokeContainer = null;
}

function CursorSettingsAbout() {
    const currentSkin = (settings.store.skin || "off") as CursorSkin | "off";
    const [selected, setSelected] = React.useState<CursorSkin | "off">(currentSkin);

    const skins: { id: CursorSkin | "off"; name: string; tier: string }[] = [
        { id: "off", name: "Off (Default)", tier: "Default" },
        { id: "dragonsword", name: "Dragon Sword", tier: "FREE" },
        { id: "sharingan", name: "Sharingan", tier: "MAXXER" },
        { id: "rinnegan", name: "Rinnegan", tier: "MAXXER" },
        { id: "rasengan", name: "Rasengan", tier: "MAXXER" },
        { id: "chidori", name: "Chidori", tier: "MAXXER" },
        { id: "stiiizy", name: "Stiiizy", tier: "MAXXER" }
    ];

    return (
        <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, color: "var(--header-primary)" }}>
                Click Any Skin to Equip:
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
                {skins.map(s => {
                    const isEquipped = selected === s.id;
                    return (
                        <div
                            key={s.id}
                            onClick={() => {
                                setSelected(s.id);
                                settings.store.skin = s.id;
                                applySkin(s.id);
                            }}
                            style={{
                                padding: "10px 12px",
                                borderRadius: 8,
                                border: isEquipped ? "2px solid #5865F2" : "1px solid var(--border-subtle)",
                                background: isEquipped ? "rgba(88, 101, 242, 0.18)" : "var(--background-secondary)",
                                cursor: "pointer",
                                textAlign: "center",
                                transition: "all 0.15s ease",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 6,
                                position: "relative"
                            }}
                        >
                            <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                {s.id === "off" ? (
                                    <span style={{ fontSize: 26 }}>🖱️</span>
                                ) : (
                                    <div dangerouslySetInnerHTML={{ __html: CURSOR_SVGS[s.id as CursorSkin] }} />
                                )}
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: isEquipped ? "#5865F2" : "var(--text-normal)" }}>
                                {s.name}
                            </div>
                            <span style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: "2px 6px",
                                borderRadius: 4,
                                background: isEquipped ? "#5865F2" : s.tier === "FREE" ? "rgba(74, 222, 128, 0.2)" : s.tier === "MAXXER" ? "rgba(168, 85, 247, 0.2)" : "rgba(255,255,255,0.1)",
                                color: isEquipped ? "#ffffff" : s.tier === "FREE" ? "#4ade80" : s.tier === "MAXXER" ? "#c084fc" : "var(--text-muted)"
                            }}>
                                {isEquipped ? "✓ EQUIPPED" : s.tier}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default definePlugin({
    name: "DMCursor",
    description:
        "Custom anime cursors ported from the maxxer suite (clipmaxxing/dropmap origin). Six skins — Sharingan, Rinnegan, Rasengan, Chidori, Dragon Sword, Stiiizy (smoke trail). Pick via settings; toggling the plugin off restores Discord's default cursor.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,
    settingsAboutComponent: CursorSettingsAbout,

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

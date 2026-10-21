/*
 * Discordmaxxer — Welcome / Plugin Tour
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One-shot first-launch modal (and re-openable from DMHub) that helps users
 * discover plugins they'd otherwise have to dig through settings to find.
 * Three sections:
 *   1. Identity — DMBadge channels A/C/D consent toggles
 *   2. Quick-enable bundles — Music & Vibes, Streamer Loadout, Privacy & Anti-track
 *   3. Featured plugins — curated cards with plain-English copy + GIFs
 *
 * Persistence: settings.store.seenVersion. Modal auto-shows when
 * seenVersion < WELCOME_VERSION, then writes the new version on dismiss.
 * Bump WELCOME_VERSION when adding new featured plugins to re-trigger the
 * modal on the next launch so existing users see what's new.
 */

import { managedStyleRootNode } from "@api/Styles";
import { definePluginSettings } from "@api/Settings";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Toasts, UserStore } from "@webpack/common";

import { BUNDLES } from "../_dm-shared/bundles";
import { FEATURED_PLUGINS } from "../_dm-shared/featured";
import { GRADIENT_PRESETS } from "../_dm-shared/gradientPresets";
import { hasTier, Tier, TIER_LABELS } from "../_dm-shared/vip";
import { BADGE_ICON } from "../DMBadge";

// Bump this when new featured plugins are added to force the modal to re-show
// on launch so existing users see the additions. Major content updates only —
// not tiny copy tweaks.
const WELCOME_VERSION = 4;

const ROOT_ID = "dm-welcome-root";
const MODAL_ID = "dm-welcome-modal";
const INITIAL_GRADIENT_COUNT = 8;

const BRAND_MARK =
    "data:image/png;base64,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";

const settings = definePluginSettings({
    seenVersion: {
        type: OptionType.NUMBER,
        description: "Internal: tracks which welcome-modal version this user has dismissed. Set to 0 to force re-show on next launch.",
        default: 0
    },
    autoOpenOnUpdate: {
        type: OptionType.BOOLEAN,
        description: "Auto-open the plugin tour when Discordmaxxer ships new featured plugins. Off = you only see it via DM Hub → Plugin Tour.",
        default: true
    }
});

function toast(msg: string, type: any = Toasts.Type.SUCCESS) {
    Toasts.show({
        message: msg,
        type,
        id: Toasts.genId(),
        options: { duration: 2500, position: Toasts.Position.TOP }
    });
}

function vencord(): any {
    return (globalThis as any).Vencord;
}

function isPluginEnabled(name: string): boolean {
    return !!vencord()?.PlainSettings?.plugins?.[name]?.enabled;
}

function setPluginEnabled(name: string, value: boolean): boolean {
    const v = vencord();
    if (!v?.Settings?.plugins) return false;
    if (!v.Settings.plugins[name]) v.Settings.plugins[name] = {};
    v.Settings.plugins[name].enabled = value;

    // Start / stop the plugin so the change takes effect immediately. Stock
    // Vencord defers until restart, but for a tour where you click "enable"
    // and want to SEE the effect, eager start matters.
    const pluginObj = v.Plugins?.plugins?.[name];
    if (!pluginObj) {
        console.warn(`[DMWelcome] ${name} is not registered; setting was saved but could not be applied live.`);
        return false;
    }
    try {
        if (value) v.Plugins.startPlugin?.(pluginObj);
        else v.Plugins.stopPlugin?.(pluginObj);
        return true;
    } catch (e) {
        console.warn(`[DMWelcome] ${value ? "start" : "stop"}Plugin(${name}) threw:`, e);
        return false;
    }
}

function getPluginSetting(plugin: string, key: string): boolean {
    return !!vencord()?.PlainSettings?.plugins?.[plugin]?.[key];
}

function setPluginSetting(plugin: string, key: string, value: boolean): boolean {
    const v = vencord();
    if (!v?.Settings?.plugins?.[plugin]) return false;
    v.Settings.plugins[plugin][key] = value;
    return true;
}

function getPluginSettingString(plugin: string, key: string): string {
    const v = vencord()?.PlainSettings?.plugins?.[plugin]?.[key];
    return typeof v === "string" ? v : "";
}

function setPluginSettingString(plugin: string, key: string, value: string): boolean {
    const v = vencord();
    if (!v?.Settings?.plugins?.[plugin]) return false;
    v.Settings.plugins[plugin][key] = value;
    return true;
}

const CSS = `
    /* Modal scrim — soft dim, click outside to dismiss */
    #${ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 9999999;
        background: rgba(8, 4, 24, 0.65);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
        animation: dmw-fade 0.18s ease-out;
    }
    #${ROOT_ID}.hidden { display: none; }
    @keyframes dmw-fade {
        from { opacity: 0; }
        to { opacity: 1; }
    }

    #${MODAL_ID} {
        width: min(640px, calc(100vw - 40px));
        max-height: calc(100vh - 80px);
        overflow-y: auto;
        scrollbar-gutter: stable;
        background: linear-gradient(165deg, #150a28, #1f0a36);
        border: 1px solid rgba(226,91,255,0.45);
        border-radius: 16px;
        padding: 22px 24px 18px;
        color: #fbefff;
        box-shadow: 0 24px 60px rgba(0,0,0,0.6), 0 0 40px rgba(226,91,255,0.22);
    }

    .dmw-head {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 4px;
    }
    .dmw-mark {
        width: 32px; height: 32px;
        background: linear-gradient(135deg, var(--brand-experiment, #e25bff), var(--brand-experiment-700, #4c51f7));
        border-radius: 7px;
        display: inline-flex; align-items: center; justify-content: center;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.18) inset;
        flex-shrink: 0;
    }
    .dmw-mark img { display: block; }
    .dmw-title-block { flex: 1; }
    .dmw-title { font-size: 18px; font-weight: 800; letter-spacing: 0.2px; }
    .dmw-sub { font-size: 12px; color: #ddb1ff; opacity: 0.85; margin-top: 2px; }
    .dmw-scroll-cue {
        margin-top: 10px;
        padding: 7px 10px;
        border: 1px solid rgba(226,91,255,0.22);
        border-radius: 8px;
        color: #d7b9ec;
        background: rgba(42,9,95,0.28);
        font-size: 11px;
        line-height: 1.35;
        text-align: center;
    }
    .dmw-close {
        background: transparent;
        border: none;
        color: #ddb1ff;
        font-size: 22px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
    }
    .dmw-close:hover { color: #fff; }

    .dmw-section {
        margin-top: 18px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 1.4px;
        color: #ddb1ff;
        text-transform: uppercase;
        opacity: 0.7;
    }

    /* Identity row — compact 3-toggle line for DMBadge consent */
    .dmw-identity {
        display: grid;
        gap: 8px;
        margin-top: 6px;
    }

    /* Bundle buttons — 3 stacked or grid, each clickable */
    .dmw-bundles {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 10px;
        margin-top: 8px;
    }
    @media (max-width: 540px) { .dmw-bundles { grid-template-columns: 1fr; } }
    .dmw-bundle {
        background: linear-gradient(135deg, rgba(226,91,255,0.18), rgba(76,81,247,0.18));
        border: 1px solid rgba(226,91,255,0.35);
        border-radius: 10px;
        padding: 12px 12px 10px;
        text-align: left;
        color: #fbefff;
        cursor: pointer;
        transition: transform 0.12s, box-shadow 0.12s, filter 0.12s;
        font-family: inherit;
    }
    .dmw-bundle:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 18px rgba(226,91,255,0.25);
        filter: brightness(1.1);
    }
    .dmw-bundle-title {
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 4px;
    }
    .dmw-bundle-blurb {
        font-size: 11px;
        color: #ddb1ff;
        opacity: 0.85;
        line-height: 1.35;
    }
    .dmw-bundle.enabled {
        background: linear-gradient(135deg, rgba(76,247,138,0.18), rgba(76,210,247,0.18));
        border-color: rgba(76,247,138,0.45);
    }
    .dmw-bundle.enabled .dmw-bundle-title::after {
        content: " ✓";
        color: #4cf78a;
    }
    .dmw-bundle.partial {
        border-color: rgba(243,175,25,0.5);
        background: linear-gradient(135deg, rgba(243,175,25,0.13), rgba(76,81,247,0.16));
    }
    .dmw-bundle-status {
        display: block;
        margin-top: 6px;
        color: #cbb3de;
        font-size: 10px;
        line-height: 1.3;
    }
    .dmw-bundle.partial .dmw-bundle-status { color: #f3af19; }

    /* Featured cards — bigger, with GIF/emoji preview */
    .dmw-cards { display: grid; gap: 10px; margin-top: 6px; }
    .dmw-card {
        display: grid;
        grid-template-columns: 80px 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 10px 12px;
        background: rgba(42,9,95,0.4);
        border: 1px solid rgba(226,91,255,0.18);
        border-radius: 10px;
    }
    .dmw-card.vip {
        border-color: rgba(243,175,25,0.45);
        background: linear-gradient(135deg, rgba(243,175,25,0.08), rgba(226,91,255,0.08));
    }
    .dmw-preview {
        width: 80px; height: 60px;
        border-radius: 6px;
        overflow: hidden;
        background: rgba(0,0,0,0.3);
        display: flex; align-items: center; justify-content: center;
        font-size: 30px;
        flex-shrink: 0;
        position: relative;
    }
    .dmw-preview img {
        width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .dmw-asset-preview {
        width: 100%; height: 100%; position: relative;
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, rgba(226,91,255,0.18), rgba(76,81,247,0.22));
    }
    .dmw-asset-preview img { position: absolute; inset: 0; }
    .dmw-asset-fallback {
        display: grid; place-items: center; width: 100%; height: 100%;
        font-size: 30px; color: #fbefff;
    }
    .dmw-preview-ui {
        width: 100%; height: 100%;
        display: flex; flex-direction: column; justify-content: space-between;
        padding: 7px 8px; box-sizing: border-box;
        color: #fbefff;
        font-size: 9px;
        line-height: 1.1;
    }
    .dmw-spotify-preview {
        background: linear-gradient(145deg, #102719, #10200f 55%, #1d4725);
    }
    .dmw-spotify-top {
        display: flex; align-items: center; gap: 5px;
        font-weight: 800; color: #83f28c; font-size: 10px;
    }
    .dmw-spotify-disc {
        width: 13px; height: 13px; border-radius: 50%;
        background: radial-gradient(circle at center, #102719 0 2px, #67e879 2px 3px, #19b83d 3px 100%);
        box-shadow: 0 0 8px rgba(30,215,96,0.6);
    }
    .dmw-spotify-track { font-weight: 700; color: #fff; }
    .dmw-spotify-bars {
        display: flex; align-items: flex-end; gap: 2px; height: 13px;
    }
    .dmw-spotify-bars i {
        display: block; width: 3px; border-radius: 2px; background: #56db6b;
    }
    .dmw-spotify-bars i:nth-child(1) { height: 6px; }
    .dmw-spotify-bars i:nth-child(2) { height: 11px; }
    .dmw-spotify-bars i:nth-child(3) { height: 8px; }
    .dmw-spotify-bars i:nth-child(4) { height: 13px; }
    .dmw-name-preview {
        background: linear-gradient(135deg, #241044, #151b4a);
        gap: 3px;
        justify-content: center;
    }
    .dmw-name-sample { font-size: 13px; font-weight: 800; line-height: 1; }
    .dmw-name-sample.one { color: #ff6ec7; text-shadow: 0 0 8px rgba(255,110,199,0.65); font-family: "Trebuchet MS", sans-serif; }
    .dmw-name-sample.two { color: #7dffcb; letter-spacing: 0.04em; font-family: "Cascadia Code", Consolas, monospace; }
    .dmw-name-sample.three { color: #ffe08a; font-style: italic; font-family: Georgia, serif; }
    .dmw-name-caption { color: #cbb3de; font-size: 8px; }
    .dmw-badge-preview { position: relative; overflow: hidden; }
    .dmw-badge-preview img { width: 42px; height: 42px; object-fit: contain; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.45)); }
    .dmw-card-body { min-width: 0; }
    .dmw-card-title {
        font-size: 14px; font-weight: 700; margin-bottom: 3px;
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .dmw-card-tag {
        font-size: 9px;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(243,175,25,0.25);
        color: #f3af19;
        font-weight: 700;
        letter-spacing: 0.4px;
    }
    .dmw-card-body p {
        margin: 0;
        font-size: 12px;
        color: #ddb1ff;
        opacity: 0.9;
        line-height: 1.4;
    }
    .dmw-where {
        font-size: 11px;
        color: #f3af19;
        opacity: 0.85;
        margin-top: 4px;
    }
    .dmw-toggle {
        width: 36px;
        height: 20px;
        border-radius: 10px;
        background: rgba(255,255,255,0.1);
        position: relative;
        cursor: pointer;
        transition: background 0.15s;
        flex-shrink: 0;
        border: none;
        padding: 0;
    }
    .dmw-toggle.on { background: linear-gradient(135deg, #e25bff, #4c51f7); }
    .dmw-toggle::after {
        content: "";
        position: absolute;
        top: 2px; left: 2px;
        width: 16px; height: 16px;
        border-radius: 50%;
        background: #fbefff;
        transition: left 0.15s;
    }
    .dmw-toggle.on::after { left: 18px; }
    .dmw-toggle.locked { opacity: 0.4; cursor: not-allowed; }

    .dmw-footer {
        margin-top: 18px;
        padding-top: 12px;
        border-top: 1px solid rgba(226,91,255,0.18);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }
    .dmw-footer-note { font-size: 11px; color: #8b6aad; }
    .dmw-done {
        background: linear-gradient(135deg, #e25bff, #4c51f7);
        color: #fbefff;
        border: none;
        border-radius: 6px;
        padding: 8px 18px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: filter 0.12s, transform 0.12s;
        font-family: inherit;
    }
    .dmw-done:hover { filter: brightness(1.12); transform: translateY(-1px); }

    .dmw-warn {
        font-size: 10px;
        color: #f3af19;
        opacity: 0.9;
        margin-top: 3px;
    }

    /* Profile gradient preset swatches */
    .dmw-grads {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-top: 8px;
    }
    @media (max-width: 540px) { .dmw-grads { grid-template-columns: repeat(2, 1fr); } }
    .dmw-grad {
        height: 54px;
        border: 1px solid rgba(226,91,255,0.25);
        border-radius: 8px;
        padding: 0;
        position: relative;
        overflow: hidden;
        cursor: pointer;
        font-family: inherit;
        transition: transform 0.12s, filter 0.12s, box-shadow 0.12s;
    }
    .dmw-grad:hover { transform: translateY(-2px); filter: brightness(1.1); box-shadow: 0 6px 16px rgba(0,0,0,0.35); }
    .dmw-grad.sel { outline: 2px solid #fbefff; outline-offset: 1px; }
    .dmw-grad-label {
        position: absolute;
        left: 0; right: 0; bottom: 0;
        font-size: 10px;
        font-weight: 700;
        color: #fff;
        background: rgba(0,0,0,0.42);
        padding: 2px 5px;
        text-align: left;
        text-shadow: 0 1px 2px rgba(0,0,0,0.7);
    }
    .dmw-grad.sel .dmw-grad-label::after { content: " ✓"; }
    .dmw-gradient-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 8px;
        flex-wrap: wrap;
    }
    .dmw-gradient-count { font-size: 10px; color: #b994d0; }
    .dmw-gradient-more {
        border: 1px solid rgba(226,91,255,0.38);
        border-radius: 6px;
        padding: 5px 9px;
        color: #fbefff;
        background: rgba(226,91,255,0.12);
        font: 700 11px inherit;
        cursor: pointer;
    }
    .dmw-gradient-more:hover { filter: brightness(1.15); }
    .dmw-grad-hint {
        font-size: 11px;
        color: #ddb1ff;
        opacity: 0.88;
        margin-top: 9px;
        line-height: 1.45;
    }
    .dmw-grad-hint a { color: #f3af19; cursor: pointer; text-decoration: underline; }
`;

let style: HTMLStyleElement | null = null;
let rootEl: HTMLDivElement | null = null;
let showAllGradients = false;
// Auto-open timers, tracked so stop() can cancel them — otherwise a pending
// timer fires after the plugin (or Discord renderer) is torn down and
// resurrects the modal, re-appending rootEl to a body we already cleaned up.
const autoOpenTimers: number[] = [];

// ---- Identity (DMBadge channels A / C / D) -----------------------------------

const IDENTITY_ROWS: Array<{
    key: string;
    badgeSetting: string;
    title: string;
    blurb: string;
    risk?: string;
}> = [
    {
        key: "badge",
        badgeSetting: "showOnOwnProfile",
        title: "💎 Show DM badge on your profile",
        blurb: "Mod-only — only other Discordmaxxer users see it. Vanilla Discord users see nothing different."
    }
];

// ---- Rendering ---------------------------------------------------------------

function bundleEnabledCount(plugins: string[]): number {
    return plugins.reduce((n, p) => n + (isPluginEnabled(p) ? 1 : 0), 0);
}

function featuredPluginIds(plugin: (typeof FEATURED_PLUGINS)[number]): string[] {
    return plugin.plugins?.length ? plugin.plugins : [plugin.id];
}

function featuredEnabled(plugin: (typeof FEATURED_PLUGINS)[number]): boolean {
    return featuredPluginIds(plugin).every(isPluginEnabled);
}

function renderFeaturedPreview(plugin: (typeof FEATURED_PLUGINS)[number]): string {
    if (plugin.preview === "spotify") {
        return `<div class="dmw-preview-ui dmw-spotify-preview">
            <div class="dmw-spotify-top"><span class="dmw-spotify-disc"></span><span>Spotify</span></div>
            <span class="dmw-spotify-track">Playing now</span>
            <span class="dmw-spotify-bars"><i></i><i></i><i></i><i></i></span>
        </div>`;
    }
    if (plugin.preview === "displayName") {
        return `<div class="dmw-preview-ui dmw-name-preview">
            <span class="dmw-name-sample one">Diggy T</span>
            <span class="dmw-name-sample two">DIGGYAI</span>
            <span class="dmw-name-sample three">maxx</span>
            <span class="dmw-name-caption">font · color · motion</span>
        </div>`;
    }
    if (plugin.gif) {
        return `<div class="dmw-asset-preview">
            <img src="vesktop://static/${plugin.gif}" alt="" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false" />
            <span class="dmw-asset-fallback" aria-hidden="true" hidden>${plugin.emoji}</span>
        </div>`;
    }
    return plugin.emoji;
}

function gradientSectionHTML(): string {
    const curP = getPluginSettingString("DMProfileFlair", "myThemeColorPrimary").toLowerCase();
    const curS = getPluginSettingString("DMProfileFlair", "myThemeColorSecondary").toLowerCase();
    const current = GRADIENT_PRESETS.find(g => g.primary.toLowerCase() === curP && g.secondary.toLowerCase() === curS);
    const visible = showAllGradients
        ? GRADIENT_PRESETS
        : (() => {
            const first = GRADIENT_PRESETS.slice(0, INITIAL_GRADIENT_COUNT);
            if (current && !first.includes(current) && first.length > 0) first[first.length - 1] = current;
            return first;
        })();
    const swatches = visible.map(g => {
        const sel = g.primary.toLowerCase() === curP && g.secondary.toLowerCase() === curS;
        return `<button class="dmw-grad ${sel ? "sel" : ""}" data-grad="${g.id}"
            style="background:linear-gradient(180deg, ${g.primary} 0%, ${g.secondary} 100%)"
            title="${g.label}">
            <span class="dmw-grad-label">${g.label}</span>
        </button>`;
    }).join("");
    const more = GRADIENT_PRESETS.length > INITIAL_GRADIENT_COUNT
        ? `<button class="dmw-gradient-more" data-action="toggle-gradients">${showAllGradients ? "Show fewer gradients" : `Show all ${GRADIENT_PRESETS.length} gradients`}</button>`
        : "";
    const count = GRADIENT_PRESETS.length > INITIAL_GRADIENT_COUNT
        ? `<span class="dmw-gradient-count">${showAllGradients ? `Showing all ${GRADIENT_PRESETS.length}` : `Showing ${visible.length} of ${GRADIENT_PRESETS.length}`} · pick one to preview it</span>`
        : `<span class="dmw-gradient-count">Pick a preset to preview it</span>`;
    return `<div class="dmw-grads">${swatches}</div>
        <div class="dmw-gradient-toolbar">${count}${more}</div>
        <div class="dmw-grad-hint">Primary on top, accent on bottom. Picking one sets your gradient — then <a data-action="open-flair">open Profile Flair</a> to save it or choose your own custom colors. Heads up: profile gradients show to other <b>Discordmaxxer</b> users, not to people on vanilla Discord.</div>`;
}

function renderModalHTML(): string {
    const identityRows = IDENTITY_ROWS.map(r => {
        const on = getPluginSetting("DMBadge", r.badgeSetting);
        const risk = r.risk ? `<div class="dmw-warn">⚠ ${r.risk}</div>` : "";
        return `<div class="dmw-card">
            <div class="dmw-preview dmw-badge-preview" aria-label="Discordmaxxer badge preview"><img src="${BADGE_ICON}" alt="Discordmaxxer badge" /></div>
            <div class="dmw-card-body">
                <div class="dmw-card-title">${r.title}</div>
                <p>${r.blurb}</p>
                ${risk}
            </div>
            <button class="dmw-toggle ${on ? "on" : ""}" data-identity="${r.badgeSetting}" aria-label="Toggle"></button>
        </div>`;
    }).join("");

    const bundleHTML = BUNDLES.map(b => {
        const total = b.plugins.length;
        const on = bundleEnabledCount(b.plugins);
        const fullyEnabled = on === total;
        const partiallyEnabled = on > 0 && !fullyEnabled;
        const status = fullyEnabled
            ? `Ready · all ${total} enabled`
            : on > 0
                ? `${on} of ${total} enabled · click to finish`
                : `Not enabled · click to enable all`;
        return `<button class="dmw-bundle ${fullyEnabled ? "enabled" : partiallyEnabled ? "partial" : ""}" data-bundle="${b.id}" aria-label="${b.title}: ${status}">
            <div class="dmw-bundle-title">${b.emoji} ${b.title}</div>
            <div class="dmw-bundle-blurb">${b.blurb}</div>
            <span class="dmw-bundle-status">${status}</span>
        </button>`;
    }).join("");

    const cardHTML = FEATURED_PLUGINS.map(p => {
        const gated = p.tier !== undefined && !hasTier(p.tier);
        const enabled = featuredEnabled(p);
        const tierBadge = p.tier !== undefined
            ? `<span class="dmw-card-tag">🔒 ${TIER_LABELS[p.tier]}</span>`
            : "";
        const where = p.where
            ? `<div class="dmw-where">📍 ${p.where}</div>`
            : "";
        const preview = renderFeaturedPreview(p);
        return `<div class="dmw-card ${p.tier !== undefined ? "vip" : ""}">
            <div class="dmw-preview">${preview}</div>
            <div class="dmw-card-body">
                <div class="dmw-card-title">${p.title} ${tierBadge}</div>
                <p>${p.oneLiner}</p>
                ${where}
            </div>
            <button class="dmw-toggle ${enabled ? "on" : ""} ${gated ? "locked" : ""}"
                data-plugin="${p.id}"
                ${gated ? 'data-locked="true"' : ""}
                aria-label="${enabled ? "Disable" : "Enable"} ${p.title}"
                aria-pressed="${enabled}"></button>
        </div>`;
    }).join("");

    return `<div id="${MODAL_ID}">
        <div class="dmw-head">
            <div class="dmw-mark"><img src="${BRAND_MARK}" width="22" height="22" alt=""/></div>
            <div class="dmw-title-block">
                <div class="dmw-title">Welcome to Discordmaxxer</div>
                <div class="dmw-sub">A quick tour of what you can turn on. You can re-open this anytime from the DM Hub.</div>
            </div>
            <button class="dmw-close" data-action="close" title="Close">×</button>
        </div>
        <div class="dmw-scroll-cue">Choose a gradient, use a bundle to finish setup, then scroll down for featured plugins ↓</div>

        <div class="dmw-section">Identity (optional)</div>
        <div class="dmw-identity">${identityRows}</div>

        <div class="dmw-section">Profile gradient</div>
        ${gradientSectionHTML()}

        <div class="dmw-section">Quick-enable bundles</div>
        <div class="dmw-bundles">${bundleHTML}</div>

        <div class="dmw-section">Featured plugins</div>
        <div class="dmw-cards">${cardHTML}</div>

        <div class="dmw-footer">
            <div class="dmw-footer-note">More plugins in Discord settings → Discordmaxxer → Plugins.</div>
            <button class="dmw-done" data-action="done">Done</button>
        </div>
    </div>`;
}

function enableBundle(bundleId: string) {
    const bundle = BUNDLES.find(b => b.id === bundleId);
    if (!bundle) return { added: 0, applied: 0, failed: 0 };
    let added = 0;
    let applied = 0;
    let failed = 0;
    for (const id of bundle.plugins) {
        if (!isPluginEnabled(id)) {
            if (setPluginEnabled(id, true)) {
                added++;
                applied++;
            } else {
                failed++;
            }
        } else {
            applied++;
        }
    }
    if (failed > 0) {
        toast(`${bundle.title}: ${applied} of ${bundle.plugins.length} ready; ${failed} need a restart or are unavailable.`, Toasts.Type.FAILURE);
    } else {
        toast(added === 0
            ? `${bundle.title}: already on ✓`
            : `${bundle.title}: enabled ${added} plugin${added === 1 ? "" : "s"} ✨`);
    }
    return { added, applied, failed };
}

function repairFeaturedPreviewImages(): void {
    if (!rootEl) return;
    rootEl.querySelectorAll<HTMLImageElement>(".dmw-asset-preview img").forEach(image => {
        const fallback = image.parentElement?.querySelector<HTMLElement>(".dmw-asset-fallback");
        const showFallback = () => {
            image.hidden = true;
            fallback?.removeAttribute("hidden");
        };
        const showImage = () => {
            image.hidden = false;
            fallback?.setAttribute("hidden", "");
        };
        image.addEventListener("error", showFallback, { once: true });
        image.addEventListener("load", showImage, { once: true });
        if (image.complete) {
            if (image.naturalWidth > 0) showImage();
            else showFallback();
        }
    });
}

function renderIntoRoot(): void {
    if (!rootEl) return;
    const previousModal = rootEl.querySelector<HTMLElement>(`#${MODAL_ID}`);
    const scrollTop = previousModal?.scrollTop ?? 0;
    rootEl.innerHTML = renderModalHTML();
    repairFeaturedPreviewImages();
    const nextModal = rootEl.querySelector<HTMLElement>(`#${MODAL_ID}`);
    if (nextModal) nextModal.scrollTop = scrollTop;
}

function handleClick(e: Event) {
    const rawTarget = e.target as HTMLElement;

    // Dismiss when clicking outside the modal box (scrim only)
    if (rawTarget.id === ROOT_ID) {
        closeModal(true);
        return;
    }

    // Walk up to the nearest element carrying a relevant data attribute or
    // class — covers clicks landing on child nodes inside a button (bundle
    // cards, etc.).
    const actionEl = rawTarget.closest<HTMLElement>("[data-action]");
    if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === "close" || action === "done") {
            closeModal(true);
            return;
        }
        if (action === "open-flair") {
            toast("Settings → Discordmaxxer → DMProfileFlair to save your gradient or pick custom colors", Toasts.Type.MESSAGE);
            return;
        }
        if (action === "toggle-gradients") {
            showAllGradients = !showAllGradients;
            renderIntoRoot();
            return;
        }
    }

    const gradEl = rawTarget.closest<HTMLElement>("[data-grad]");
    if (gradEl) {
        const preset = GRADIENT_PRESETS.find(g => g.id === gradEl.dataset.grad);
        if (preset) {
            // Gate the success toast on the write actually landing — if
            // DMProfileFlair's settings bag isn't initialized the setters no-op,
            // and a "set ✨" toast would be a lie.
            const okA = setPluginSettingString("DMProfileFlair", "myThemeColorPrimary", preset.primary);
            const okB = setPluginSettingString("DMProfileFlair", "myThemeColorSecondary", preset.secondary);
            if (okA && okB) {
                toast(`Gradient "${preset.label}" set — save it in Profile Flair to share it ✨`);
                renderIntoRoot();
            } else {
                toast("Couldn't set gradient — open Profile Flair once, then retry.", Toasts.Type.FAILURE);
            }
        }
        return;
    }

    const bundleEl = rawTarget.closest<HTMLElement>("[data-bundle]");
    if (bundleEl) {
        enableBundle(bundleEl.dataset.bundle!);
        renderIntoRoot();
        return;
    }

    const toggleEl = rawTarget.closest<HTMLElement>(".dmw-toggle");
    if (toggleEl && !toggleEl.dataset.locked) {
        if (toggleEl.dataset.identity) {
            const key = toggleEl.dataset.identity;
            const current = getPluginSetting("DMBadge", key);
            const next = !current;
            const applied = setPluginSetting("DMBadge", key, next);
            if (applied) {
                toggleEl.classList.toggle("on", next);
                toast(`DMBadge ${key}: ${next ? "enabled" : "disabled"}`);
            } else {
                toast("Couldn't save that DMBadge setting — open DMBadge once, then retry.", Toasts.Type.FAILURE);
            }
            return;
        }
        if (toggleEl.dataset.plugin) {
            const id = toggleEl.dataset.plugin;
            const plugin = FEATURED_PLUGINS.find(p => p.id === id);
            if (!plugin) return;
            const next = !featuredEnabled(plugin);
            const ids = featuredPluginIds(plugin);
            const results = ids.map(pluginId => setPluginEnabled(pluginId, next));
            const applied = results.filter(Boolean).length;
            if (applied === ids.length) {
                toast(`${plugin.title}: ${next ? "enabled" : "disabled"}`);
            } else {
                toast(`${plugin.title}: ${applied} of ${ids.length} plugins applied; restart or check the plugin list.`, Toasts.Type.FAILURE);
            }
            renderIntoRoot();
            return;
        }
    }
}

function ensureRoot() {
    if (rootEl) return;
    rootEl = document.createElement("div");
    rootEl.id = ROOT_ID;
    rootEl.classList.add("hidden");
    rootEl.addEventListener("click", handleClick);
    document.body.appendChild(rootEl);
}

export function openWelcome() {
    ensureRoot();
    if (!rootEl) return;
    // A pending first-launch retry must not replace an already-open tour. The
    // old replacement reset the scroll position several seconds after a user
    // opened the modal manually, which looked like a random jump to the top.
    if (!rootEl.classList.contains("hidden") && rootEl.querySelector(`#${MODAL_ID}`)) return;
    showAllGradients = false;
    renderIntoRoot();
    rootEl.classList.remove("hidden");
}

function closeModal(markSeen: boolean) {
    if (rootEl) rootEl.classList.add("hidden");
    if (markSeen) settings.store.seenVersion = WELCOME_VERSION;
}

// Expose for DMHub re-open
function exposeGlobalReopen() {
    (globalThis as any).__dmReopenWelcome = openWelcome;
}

function shouldAutoOpen(): boolean {
    if (settings.store.seenVersion >= WELCOME_VERSION) return false;
    // Allow users to disable auto-open while keeping the manual re-open path.
    // First-time users (seenVersion === 0) still get the modal even if
    // autoOpenOnUpdate is off — the flag only controls update-driven re-shows.
    if (!settings.store.autoOpenOnUpdate && settings.store.seenVersion > 0) return false;
    return true;
}

export default definePlugin({
    name: "DMWelcome",
    description:
        "First-launch plugin tour: identity consent (DMBadge channels), one-click bundles (Music & Vibes / Streamer Loadout / Privacy & Anti-track), and a curated card list of featured plugins with plain-English copy. Re-openable from the DM Hub anytime; auto-shows again when new featured plugins ship.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-welcome", managedStyleRootNode);
        style.textContent = CSS;
        exposeGlobalReopen();

        if (!shouldAutoOpen()) return;

        // Wait for Discord to settle — login, ready event, FluxDispatcher cold
        // start. Same delay DMPrivacy uses (8s). Skip if the user isn't logged
        // in yet; DMHub etc. handle the same edge case by polling for the
        // user-panel toolbar.
        autoOpenTimers.push(
            window.setTimeout(() => {
                const me = UserStore.getCurrentUser();
                if (!me) {
                    // Still on login screen — try again in another 8s, then give up.
                    autoOpenTimers.push(
                        window.setTimeout(() => {
                            if (UserStore.getCurrentUser() && shouldAutoOpen()) openWelcome();
                        }, 8000)
                    );
                    return;
                }
                openWelcome();
            }, 6000)
        );
    },

    stop() {
        autoOpenTimers.forEach(clearTimeout);
        autoOpenTimers.length = 0;
        showAllGradients = false;
        rootEl?.remove();
        rootEl = null;
        style?.remove();
        style = null;
        delete (globalThis as any).__dmReopenWelcome;
    }
});

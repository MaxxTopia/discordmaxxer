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

// Bump this when new featured plugins are added to force the modal to re-show
// on launch so existing users see the additions. Major content updates only —
// not tiny copy tweaks.
const WELCOME_VERSION = 2;

const ROOT_ID = "dm-welcome-root";
const MODAL_ID = "dm-welcome-modal";

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

function setPluginEnabled(name: string, value: boolean) {
    const v = vencord();
    if (!v) return;
    if (!v.Settings.plugins[name]) v.Settings.plugins[name] = {};
    v.Settings.plugins[name].enabled = value;

    // Start / stop the plugin so the change takes effect immediately. Stock
    // Vencord defers until restart, but for a tour where you click "enable"
    // and want to SEE the effect, eager start matters.
    const pluginObj = v.Plugins?.plugins?.[name];
    if (!pluginObj) return;
    try {
        if (value) v.Plugins.startPlugin?.(pluginObj);
        else v.Plugins.stopPlugin?.(pluginObj);
    } catch (e) {
        console.warn(`[DMWelcome] ${value ? "start" : "stop"}Plugin(${name}) threw:`, e);
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
    }
    .dmw-preview img {
        width: 100%; height: 100%; object-fit: cover; display: block;
    }
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

function gradientSectionHTML(): string {
    const curP = getPluginSettingString("DMProfileFlair", "myThemeColorPrimary").toLowerCase();
    const curS = getPluginSettingString("DMProfileFlair", "myThemeColorSecondary").toLowerCase();
    const swatches = GRADIENT_PRESETS.map(g => {
        const sel = g.primary.toLowerCase() === curP && g.secondary.toLowerCase() === curS;
        return `<button class="dmw-grad ${sel ? "sel" : ""}" data-grad="${g.id}"
            style="background:linear-gradient(180deg, ${g.primary} 0%, ${g.secondary} 100%)"
            title="${g.label}">
            <span class="dmw-grad-label">${g.label}</span>
        </button>`;
    }).join("");
    return `<div class="dmw-grads">${swatches}</div>
        <div class="dmw-grad-hint">Primary on top, accent on bottom. Picking one sets your gradient — then <a data-action="open-flair">open Profile Flair</a> to save it or choose your own custom colors. Heads up: profile gradients show to other <b>Discordmaxxer</b> users, not to people on vanilla Discord.</div>`;
}

function renderModalHTML(): string {
    const identityRows = IDENTITY_ROWS.map(r => {
        const on = getPluginSetting("DMBadge", r.badgeSetting);
        const risk = r.risk ? `<div class="dmw-warn">⚠ ${r.risk}</div>` : "";
        return `<div class="dmw-card">
            <div class="dmw-preview" aria-hidden="true">🪪</div>
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
        return `<button class="dmw-bundle ${fullyEnabled ? "enabled" : ""}" data-bundle="${b.id}">
            <div class="dmw-bundle-title">${b.emoji} ${b.title}</div>
            <div class="dmw-bundle-blurb">${b.blurb}</div>
            <div class="dmw-bundle-blurb" style="margin-top:6px;opacity:0.7;">
                ${fullyEnabled ? "All enabled" : `${on} / ${total} on — click to enable all`}
            </div>
        </button>`;
    }).join("");

    const cardHTML = FEATURED_PLUGINS.map(p => {
        const gated = p.tier !== undefined && !hasTier(p.tier);
        const enabled = isPluginEnabled(p.id);
        const tierBadge = p.tier !== undefined
            ? `<span class="dmw-card-tag">🔒 ${TIER_LABELS[p.tier]}</span>`
            : "";
        const where = p.where
            ? `<div class="dmw-where">📍 ${p.where}</div>`
            : "";
        const preview = p.gif
            ? `<img src="vesktop://static/${p.gif}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'), { textContent: '${p.emoji}' }))" />`
            : p.emoji;
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
                aria-label="Toggle"></button>
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
    if (!bundle) return;
    let added = 0;
    for (const id of bundle.plugins) {
        if (!isPluginEnabled(id)) {
            setPluginEnabled(id, true);
            added++;
        }
    }
    toast(added === 0
        ? `${bundle.title}: already on ✓`
        : `${bundle.title}: enabled ${added} plugin${added === 1 ? "" : "s"} ✨`);
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
                if (rootEl) rootEl.innerHTML = renderModalHTML();
            } else {
                toast("Couldn't set gradient — open Profile Flair once, then retry.", Toasts.Type.FAILURE);
            }
        }
        return;
    }

    const bundleEl = rawTarget.closest<HTMLElement>("[data-bundle]");
    if (bundleEl) {
        enableBundle(bundleEl.dataset.bundle!);
        if (rootEl) rootEl.innerHTML = renderModalHTML();
        return;
    }

    const toggleEl = rawTarget.closest<HTMLElement>(".dmw-toggle");
    if (toggleEl && !toggleEl.dataset.locked) {
        if (toggleEl.dataset.identity) {
            const key = toggleEl.dataset.identity;
            const current = getPluginSetting("DMBadge", key);
            const next = !current;
            setPluginSetting("DMBadge", key, next);
            toggleEl.classList.toggle("on", next);
            return;
        }
        if (toggleEl.dataset.plugin) {
            const id = toggleEl.dataset.plugin;
            const next = !isPluginEnabled(id);
            setPluginEnabled(id, next);
            toggleEl.classList.toggle("on", next);
            toast(`${id}: ${next ? "enabled" : "disabled"}`);
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
    rootEl.innerHTML = renderModalHTML();
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
        rootEl?.remove();
        rootEl = null;
        style?.remove();
        style = null;
        delete (globalThis as any).__dmReopenWelcome;
    }
});

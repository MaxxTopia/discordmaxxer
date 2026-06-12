/*
 * Discordmaxxer — Hub plugin (clickable quick-access panel, in-toolbar)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Injects a DM button into Discord's user-panel toolbar (next to your
 * username, before the mic icon). Click opens a panel with VIP tier badge,
 * VIP features section, and quick toggles for our custom plugins.
 *
 * Toggle UX: writes the Vencord setting AND re-runs the plugin's start/stop
 * so that onChange-style side effects (like CSS injection) actually take
 * effect immediately, not just persist to disk.
 */

import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin from "@utils/types";

import { getMyTier, hasTier, Tier, TIER_LABELS } from "../_dm-shared/vip";

const FAB_ID = "dm-hub-fab";
const PANEL_ID = "dm-hub-panel";
const PANEL_ROOT_ID = "dm-hub-panel-root";

// Horror-Clyde mark, NO bullet holes — Variant B (cream body, black outline,
// red eyes, devil horns, speech-tail). Same source as build/tray-source.png.
// Used at 26x26 in the FAB toolbar button (next to the mic mute) AND at 14x14
// in the panel header. v0.7.22 (2026-05-12): swapped from the bullet-holes
// mark to the no-holes Variant B for consistency with v0.7.20's shortcut-icon
// change — bullet-holes mark survives at 256px+ but reads as noise on small
// chrome surfaces (taskbar 32px, FAB 26px). Branded-art renders still use the
// bullet-holes version (build/icon-source.png).
//
// REVERT RECIPE: if Diggy wants the bullet-holes mark back here, the old
// base64 lives in git history at commit 3453308 (v0.7.20) and earlier — the
// declaration starts with `iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocK` for
// the holes version vs `iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4` for the
// no-holes version below. `git show 3453308:plugins/DMHub/index.ts | grep -A1 FAB_LOGO_DATA`
// pulls it out.
const FAB_LOGO_DATA =
    "data:image/png;base64,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";

let panelRoot: HTMLDivElement | null = null;
let style: HTMLStyleElement;
let observer: MutationObserver | null = null;

const HUB_CSS = `
    /* Toolbar button — renders the locked primary v1 mark on a transparent
       background so the actual Discordmaxxer logo shows (not a colored chip).
       Hover glow tints with the active theme via --brand-experiment. */
    #${FAB_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin: 0 2px;
        padding: 0;
        border-radius: 50%;
        background: transparent;
        border: none;
        cursor: pointer;
        transition: filter 0.15s, box-shadow 0.15s, transform 0.15s;
    }
    #${FAB_ID}:hover {
        filter: brightness(1.08);
        transform: scale(1.06);
        box-shadow: 0 0 12px var(--brand-experiment-30a, rgba(226,91,255,0.45));
    }

    /* Floating panel anchored bottom-left, above user panel */
    #${PANEL_ROOT_ID} {
        position: fixed;
        left: 12px;
        bottom: 64px;
        z-index: 999999;
        font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    #${PANEL_ROOT_ID}.hidden {
        display: none;
    }
    #${PANEL_ID} {
        width: 320px;
        background: linear-gradient(160deg, #110a20, #1a0a2e);
        border: 1px solid rgba(226,91,255,0.4);
        border-radius: 14px;
        padding: 14px 14px 12px;
        color: #fbefff;
        box-shadow: 0 14px 40px rgba(0,0,0,0.55), 0 0 30px rgba(226,91,255,0.2);
        backdrop-filter: blur(16px);
        max-height: calc(100vh - 200px);
        overflow-y: auto;
    }
    .dm-hub-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
    }
    .dm-hub-title { font-weight: 700; font-size: 15px; }
    .dm-hub-tier {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.5px;
        background: linear-gradient(135deg, #e25bff, #4c51f7);
        color: #fbefff;
        margin-bottom: 10px;
    }
    .dm-hub-tier.free {
        background: rgba(139,106,173,0.3);
        color: #ddb1ff;
    }
    .dm-hub-section {
        margin-top: 10px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1px;
        color: #ddb1ff;
        text-transform: uppercase;
        opacity: 0.7;
    }
    .dm-hub-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        margin: 4px 0;
        background: rgba(42,9,95,0.4);
        border: 1px solid rgba(226,91,255,0.18);
        border-radius: 8px;
        font-size: 13px;
    }
    .dm-hub-row.vip {
        border-color: rgba(243,175,25,0.45);
        background: linear-gradient(135deg, rgba(243,175,25,0.08), rgba(226,91,255,0.08));
    }
    .dm-hub-row-label {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .dm-hub-row-tag {
        font-size: 9px;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(243,175,25,0.25);
        color: #f3af19;
        font-weight: 700;
        letter-spacing: 0.4px;
    }
    .dm-hub-toggle {
        width: 36px;
        height: 20px;
        border-radius: 10px;
        background: rgba(255,255,255,0.1);
        position: relative;
        cursor: pointer;
        transition: background 0.15s;
        flex-shrink: 0;
    }
    .dm-hub-toggle.on { background: linear-gradient(135deg, #e25bff, #4c51f7); }
    .dm-hub-toggle::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fbefff;
        transition: left 0.15s;
    }
    .dm-hub-toggle.on::after { left: 18px; }
    .dm-hub-toggle.locked { opacity: 0.4; cursor: not-allowed; }
    .dm-hub-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        margin-right: 8px;
        background: linear-gradient(135deg, var(--brand-experiment, #e25bff), var(--brand-experiment-700, #4c51f7));
        border-radius: 5px;
        vertical-align: middle;
        cursor: help;
        transition: transform 0.18s, box-shadow 0.18s;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.18) inset;
    }
    .dm-hub-mark:hover {
        transform: scale(1.12) rotate(-3deg);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.3) inset, 0 0 14px var(--brand-experiment-30a, rgba(226,91,255,0.7));
    }
    .dm-hub-mark svg, .dm-hub-mark img { display: block; }
    .dm-hub-action-btn {
        background: linear-gradient(135deg, rgba(226,91,255,0.25), rgba(76,81,247,0.25));
        color: #fbefff;
        border: 1px solid rgba(226,91,255,0.45);
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: filter 0.12s;
    }
    .dm-hub-action-btn:hover { filter: brightness(1.2); }
    .dm-hub-info {
        font-size: 11px;
        color: #ddb1ff;
        opacity: 0.8;
        margin: 6px 0;
        line-height: 1.4;
    }
    /* When a note immediately follows a row, bind it visually to that row
     * (left-border + tight margins + indent) so it can't be mistaken for a
     * section header that applies to subsequent rows. */
    .dm-hub-row + .dm-hub-info {
        margin: -2px 10px 4px 10px;
        padding: 2px 0 2px 8px;
        border-left: 2px solid rgba(226,91,255,0.4);
        opacity: 0.75;
    }
    .dm-hub-footer {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid rgba(226,91,255,0.18);
        font-size: 11px;
        color: #8b6aad;
        text-align: center;
    }
    .dm-hub-close {
        background: transparent;
        border: none;
        color: #ddb1ff;
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
    }
`;

interface QuickToggle {
    plugin: string;
    label: string;
    settingKey?: string;
    minTier?: Tier;
    note?: string;
    /** When true, skip the plugin restart on toggle (the setting's onChange
     *  handles runtime state cleanly without needing a full stop/start
     *  cycle). Used for live-state mirrors like TM/CompactView's
     *  manuallyActive — restarting them would re-register hotkeys, which is
     *  expensive + visible (toast spam). */
    noRestart?: boolean;
}

const QUICK_TOGGLES: QuickToggle[] = [
    { plugin: "VideoBackground", label: "🌟 Video Background", settingKey: "enable", minTier: Tier.MAXXER_PLUS, note: "Set URL in Discordmaxxer plugin settings" },
    { plugin: "DMTheme", label: "🎨 Maxxer Theme", settingKey: "enable" },
    { plugin: "TournamentMode", label: "🎮 Tournament Mode", settingKey: "manuallyActive", note: "Or press Ctrl+Alt+T", noRestart: true },
    { plugin: "CompactView", label: "📐 Compact View", settingKey: "manuallyActive", note: "Or press Ctrl+Alt+H", noRestart: true },
    { plugin: "MassDelete", label: "🗑️ Mass-Delete menu", settingKey: "enableContextMenu", note: "OPT-IN — TOS risk" },
    { plugin: "DMBadge", label: "💎 Profile Badge", settingKey: "showOnOwnProfile" },
    { plugin: "DMStreamMute", label: "🔇 Mute screenshare audio", settingKey: "muted", note: "Or press Ctrl+Shift+M", noRestart: true }
];

function vencord(): any {
    return (globalThis as any).Vencord;
}

function isPluginEnabled(name: string): boolean {
    return !!vencord()?.PlainSettings?.plugins?.[name]?.enabled;
}

function getSetting(plugin: string, key: string): boolean {
    return !!vencord()?.PlainSettings?.plugins?.[plugin]?.[key];
}

function setSetting(plugin: string, key: string, value: boolean, noRestart?: boolean) {
    const v = vencord();
    if (!v?.Settings?.plugins?.[plugin]) return;

    // 1) Persist the value through Vencord's settings proxy.
    v.Settings.plugins[plugin][key] = value;

    // 2) noRestart: setting's onChange handles runtime state cleanly (e.g.,
    //    TournamentMode's manuallyActive flips active+CSS without needing
    //    a full plugin re-init). Skip the heavy restart in that case.
    if (noRestart) return;

    // 3) Otherwise re-init the plugin so its start() reads the new value and
    //    onChange-style side effects (CSS injection, badge re-registration,
    //    hotkey re-binding) actually take effect.
    const pluginObj = v.Plugins?.plugins?.[plugin];
    if (!pluginObj) return;

    try {
        v.Plugins.stopPlugin?.(pluginObj);
    } catch (e) {
        console.warn(`[DiscordmaxxerHub] stopPlugin(${plugin}) threw:`, e);
    }
    try {
        v.Plugins.startPlugin?.(pluginObj);
    } catch (e) {
        console.warn(`[DiscordmaxxerHub] startPlugin(${plugin}) threw:`, e);
    }
}

function renderPanelHTML(): string {
    const tier = getMyTier();
    const tierLabel = TIER_LABELS[tier];
    const tierClass = tier === Tier.FREE ? "free" : "";

    const rows = QUICK_TOGGLES.map(t => {
        if (!isPluginEnabled(t.plugin)) {
            return `<div class="dm-hub-row" style="opacity:0.5">
                <div class="dm-hub-row-label">${t.label}</div>
                <span style="font-size:10px;color:#8b6aad">disabled</span>
            </div>`;
        }
        if (t.minTier && !hasTier(t.minTier)) {
            return `<div class="dm-hub-row vip">
                <div class="dm-hub-row-label">${t.label}<span class="dm-hub-row-tag">${TIER_LABELS[t.minTier]}</span></div>
                <div class="dm-hub-toggle locked" data-locked="true"></div>
            </div>`;
        }
        if (!t.settingKey) {
            return `<div class="dm-hub-row">
                <div class="dm-hub-row-label">${t.label}</div>
                <span style="font-size:10px;color:#8b6aad">hotkey</span>
            </div>`;
        }
        const on = getSetting(t.plugin, t.settingKey);
        const tag = t.minTier ? `<span class="dm-hub-row-tag">${TIER_LABELS[t.minTier]}</span>` : "";
        const note = t.note ? `<div class="dm-hub-info">${t.note}</div>` : "";
        return `<div class="dm-hub-row${t.minTier ? " vip" : ""}">
            <div class="dm-hub-row-label">${t.label}${tag}</div>
            <div class="dm-hub-toggle ${on ? "on" : ""}" data-plugin="${t.plugin}" data-key="${t.settingKey}"></div>
        </div>${note}`;
    }).join("");

    return `<div id="${PANEL_ID}">
        <div class="dm-hub-header">
            <div class="dm-hub-title"><span class="dm-hub-mark" title="Discordmaxxer — Discord, optimized"><img src="${FAB_LOGO_DATA}" width="14" height="14" alt=""/></span> Discordmaxxer</div>
            <button class="dm-hub-close" data-action="close" title="Close">×</button>
        </div>
        <div class="dm-hub-tier ${tierClass}">${tierLabel}</div>
        ${tier === Tier.FREE
            ? `<div class="dm-hub-info">⭐ Upgrade to MAXXER+ for video backgrounds and premium themes.</div>`
            : `<div class="dm-hub-info">Welcome back, ${tierLabel}.</div>`}
        <div class="dm-hub-section">Quick toggles</div>
        ${rows}
        <div class="dm-hub-section">Discover</div>
        <div class="dm-hub-row">
            <div class="dm-hub-row-label">✨ Plugin Tour</div>
            <button class="dm-hub-action-btn" data-action="open-tour">Open</button>
        </div>
        <div class="dm-hub-info">Browse featured plugins, enable bundles, and see what each one actually does — no settings-digging required.</div>
        <div class="dm-hub-section">Maintenance</div>
        <div class="dm-hub-row">
            <div class="dm-hub-row-label">♻️ Reload Discord (frees RAM)</div>
            <button class="dm-hub-action-btn" data-action="reload-renderer">Reload</button>
        </div>
        <div class="dm-hub-info">Use this if Discord starts feeling sluggish after hours of uptime. Login state survives.</div>
        <div class="dm-hub-footer">Full settings → Discord settings → Discordmaxxer → Plugins</div>
    </div>`;
}

function ensurePanelRoot() {
    if (panelRoot) return;
    panelRoot = document.createElement("div");
    panelRoot.id = PANEL_ROOT_ID;
    panelRoot.classList.add("hidden");
    document.body.appendChild(panelRoot);

    panelRoot.addEventListener("click", (e: any) => {
        const t = e.target as HTMLElement;
        if (t.dataset.action === "close") {
            panelRoot!.classList.add("hidden");
            return;
        }
        if (t.dataset.action === "reload-renderer") {
            panelRoot!.classList.add("hidden");
            location.reload();
            return;
        }
        if (t.dataset.action === "open-tour") {
            panelRoot!.classList.add("hidden");
            const reopen = (globalThis as any).__dmReopenWelcome;
            if (typeof reopen === "function") reopen();
            return;
        }
        if (t.classList.contains("dm-hub-toggle") && !t.dataset.locked) {
            const plugin = t.dataset.plugin!;
            const key = t.dataset.key!;
            const next = !getSetting(plugin, key);
            const entry = QUICK_TOGGLES.find(e => e.plugin === plugin && e.settingKey === key);
            setSetting(plugin, key, next, entry?.noRestart);
            // Re-render after setting
            panelRoot!.innerHTML = renderPanelHTML();
        }
    });
}

function togglePanel() {
    ensurePanelRoot();
    const wasHidden = panelRoot!.classList.contains("hidden");
    if (wasHidden) {
        panelRoot!.innerHTML = renderPanelHTML();
        panelRoot!.classList.remove("hidden");
    } else {
        panelRoot!.classList.add("hidden");
    }
}

// Inject the FAB button into Discord's user-panel toolbar, immediately to the
// LEFT of the mic mute button. The toolbar re-renders on focus changes, so we
// re-inject from a MutationObserver.
function injectButton() {
    const mic = document.querySelector('button[aria-label*="ute" i]') as HTMLButtonElement | null;
    if (!mic) return;
    const micParent = mic.parentElement; // audioButtonParent__5e764
    const buttonsRow = micParent?.parentElement; // buttons__37e49
    if (!buttonsRow || buttonsRow.querySelector(`#${FAB_ID}`)) return;

    const fab = document.createElement("button");
    fab.id = FAB_ID;
    fab.title = "Discordmaxxer — quick toggles";
    fab.innerHTML = `<img src="${FAB_LOGO_DATA}" width="26" height="26" alt="Discordmaxxer" style="display:block;pointer-events:none;border-radius:50%"/>`;
    fab.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
    });

    buttonsRow.insertBefore(fab, micParent ?? buttonsRow.firstChild);
}

let injectScheduled = false;
// Coalesce mutation bursts to one injectButton() per frame. The toolbar only
// re-renders on focus changes, but the body observer fires on every DOM
// mutation app-wide — running two querySelectors on each was needless steady
// overhead during chat scroll / calls.
function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
        injectScheduled = false;
        injectButton();
    });
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleInject);
    observer.observe(document.body, { childList: true, subtree: true });
    injectButton(); // initial pass
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
    document.getElementById(FAB_ID)?.remove();
    panelRoot?.remove();
    panelRoot = null;
}

export default definePlugin({
    name: "DMHub",
    description:
        "DM button injected into Discord's user-panel toolbar (next to username, before the mic icon). " +
        "Click for VIP tier badge, premium features, and quick toggles for all Discordmaxxer custom plugins. " +
        "Toggling a setting here also re-initializes the affected plugin so changes take effect immediately.",
    authors: [{ name: "Diggy", id: 0n }],

    start() {
        style = createAndAppendStyle("dm-hub", managedStyleRootNode);
        style.textContent = HUB_CSS;
        if (document.body) startObserver();
        else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    },

    stop() {
        stopObserver();
        style?.remove();
    }
});

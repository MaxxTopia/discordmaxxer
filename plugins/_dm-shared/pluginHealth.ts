/*
 * Discordmaxxer — plugin health registry
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This is intentionally a small, honest status layer rather than a claim that
 * a plugin has passed every possible Discord runtime test. It answers the
 * useful questions a user has in the moment: is the plugin present, is it
 * enabled, and does it depend on a service, account, or risky operation?
 */

type HealthKind = "ready" | "conditional" | "best-effort" | "experimental" | "caution";

interface CustomPluginHealth {
    id: string;
    label: string;
    kind: HealthKind;
    note: string;
}

export interface PluginHealthRow {
    id: string;
    label: string;
    status: "loaded" | "off" | "conditional" | "best-effort" | "experimental" | "caution" | "unavailable";
    statusLabel: string;
    note: string;
}

export interface PluginHealthSnapshot {
    registryReady: boolean;
    runtimePluginCount: number;
    enabledPluginCount: number;
    customRows: PluginHealthRow[];
    unavailable: Array<{ id: string; note: string }>;
    summary: string;
}

/**
 * These are the custom plugins shipped by the current overlay. Keep the list
 * explicit so a user can see the important conditional/risky boundaries in
 * one place without scrolling through every upstream Vencord plugin.
 */
export const CUSTOM_PLUGIN_HEALTH: readonly CustomPluginHealth[] = [
    { id: "CompactView", label: "Compact View", kind: "ready", note: "Local layout toggle; no account or service dependency." },
    { id: "DMBadge", label: "Profile Badge", kind: "conditional", note: "The cross-user badge depends on the public roster; native profile writes are optional and one-time." },
    { id: "DMBeta", label: "Beta Channel", kind: "experimental", note: "For MAXXER++ testers only; prerelease updates can be less stable." },
    { id: "DMCursor", label: "Cursor Skins", kind: "ready", note: "Cosmetic local preference; animated skins can use extra GPU time." },
    { id: "DMGrant", label: "Grant Tier", kind: "caution", note: "Admin-only entitlement UI. Never use it as proof that a remote claim succeeded." },
    { id: "DMHub", label: "DM Hub", kind: "ready", note: "Local quick-access panel for Discordmaxxer controls." },
    { id: "DMPresence", label: "Rich Presence", kind: "conditional", note: "Requires the local Rich Presence path; Tournament Mode intentionally disables arRPC." },
    { id: "DMPrivacy", label: "Privacy Controls", kind: "ready", note: "Local consent and privacy settings; remote configuration must fail open." },
    { id: "DMProfileFlair", label: "Profile Flair", kind: "conditional", note: "Local gradients work offline; shared media needs the profile-media service and an eligible claim." },
    { id: "DMDisplayNameStyle", label: "Display Name Style", kind: "ready", note: "Local-only name styling with bundled offline script, Fraktur, and comic typefaces; the real Discord name is unchanged." },
    { id: "DMStreamMute", label: "Stream Audio Mute", kind: "conditional", note: "Applies to supported incoming screenshare audio paths; verify in a real call." },
    { id: "DMTheme", label: "Maxxer Theme", kind: "ready", note: "Local cosmetic theme picker." },
    { id: "DMTierFlair", label: "Tier Flair", kind: "conditional", note: "Uses the sanitized roster and current entitlement state." },
    { id: "DMTrim", label: "Discord Trim", kind: "ready", note: "Local declutter rules for Discord UI surfaces." },
    { id: "DMTyping", label: "Typing Flair", kind: "conditional", note: "Depends on the visible tier state and only affects Discordmaxxer rendering." },
    { id: "DMVipClaim", label: "VIP Claim", kind: "conditional", note: "The worker remains the authority for code validity, binding, and expiry." },
    { id: "DMVoiceGuard", label: "Voice Guard", kind: "ready", note: "Detects suspicious voice failures and surfaces a report; it cannot repair every upstream break." },
    { id: "DMVoiceKeybinds", label: "Voice Keybinds", kind: "conditional", note: "Global shortcuts need OS registration; the focused-window fallback is used when registration is unavailable." },
    { id: "DMVotes", label: "Feature Votes", kind: "conditional", note: "Requires the poll endpoint and MAXXER++ access." },
    { id: "DMWelcome", label: "Plugin Tour", kind: "ready", note: "Local onboarding and discovery UI." },
    { id: "DMWidget", label: "Profile Widgets", kind: "experimental", note: "Uses an undocumented Discord profile surface plus external game-stat providers." },
    { id: "MassDelete", label: "Mass Delete", kind: "caution", note: "Destructive and opt-in; use only in a disposable test channel." },
    { id: "TournamentMode", label: "Tournament Mode", kind: "best-effort", note: "Changes process priority and pauses costly work; the 30 FPS request may be ignored by normal windowed Chromium." },
    { id: "VideoBackground", label: "Video Background", kind: "caution", note: "Cosmetic and potentially GPU-heavy; Tournament Mode intentionally pauses it." }
];

/** IDs retained only so the health panel can explain an old/stale setting. */
const LEGACY_ALIASES: ReadonlyArray<{ id: string; replacement: string }> = [
    { id: "MoreQuickReact", replacement: "MoreQuickReactions" },
    { id: "WebScreenShareFix", replacement: "WebScreenShareFixes" }
];

/** Features mentioned by older builds but not present in this Vencord pin. */
const NOT_BUNDLED: ReadonlyArray<{ id: string; note: string }> = [
    { id: "SelfForward", note: "Not present in the pinned Vencord source; it is not enabled by current defaults." },
    { id: "ThemeLibrary", note: "Not present in the pinned Vencord source; use bundled Discordmaxxer themes instead." },
    { id: "FavoriteGifSearch", note: "Not present in the pinned Vencord source; the feature is hidden from the tour and defaults." },
    { id: "BlockKrispWeb", note: "Not present in the pinned Vencord source; use Discordmaxxer/OS noise controls instead." }
];

function vencord(): any {
    return (globalThis as any).Vencord;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[ch]!));
}

function statusLabel(status: PluginHealthRow["status"]): string {
    switch (status) {
        case "loaded": return "Loaded";
        case "off": return "Off";
        case "conditional": return "Needs a service/account";
        case "best-effort": return "Best effort";
        case "experimental": return "Experimental";
        case "caution": return "Use with care";
        case "unavailable": return "Not bundled";
    }
}

function rowFor(entry: CustomPluginHealth, registry: Record<string, any>, settings: Record<string, any>): PluginHealthRow {
    if (!registry[entry.id]) {
        return {
            id: entry.id,
            label: entry.label,
            status: "unavailable",
            statusLabel: statusLabel("unavailable"),
            note: "This custom plugin is missing from the running overlay. Rebuild the overlay before relying on it."
        };
    }

    if (!settings[entry.id]?.enabled) {
        return {
            id: entry.id,
            label: entry.label,
            status: "off",
            statusLabel: statusLabel("off"),
            note: entry.note
        };
    }

    return {
        id: entry.id,
        label: entry.label,
        status: entry.kind === "ready" ? "loaded" : entry.kind,
        statusLabel: statusLabel(entry.kind === "ready" ? "loaded" : entry.kind),
        note: entry.note
    };
}

export function getPluginHealthSnapshot(): PluginHealthSnapshot {
    const v = vencord();
    const registry = (v?.Plugins?.plugins ?? {}) as Record<string, any>;
    const settings = (v?.PlainSettings?.plugins ?? {}) as Record<string, any>;
    const registryReady = Boolean(v?.Plugins?.plugins);
    const runtimePluginCount = Object.keys(registry).length;
    const enabledPluginCount = Object.keys(settings).filter(name => settings[name]?.enabled === true).length;
    const customRows = CUSTOM_PLUGIN_HEALTH.map(entry => rowFor(entry, registry, settings));

    const unavailable = NOT_BUNDLED
        .filter(item => settings[item.id]?.enabled || settings[item.id] || LEGACY_ALIASES.some(alias => alias.id === item.id))
        .map(item => ({ id: item.id, note: item.note }));

    for (const alias of LEGACY_ALIASES) {
        if (settings[alias.id]) {
            unavailable.push({
                id: alias.id,
                note: `Old setting name detected. This build uses ${alias.replacement}; restart once to migrate it.`
            });
        }
    }

    const unknownEnabled = Object.keys(settings)
        .filter(name => settings[name]?.enabled === true && !registry[name])
        .filter(name => !unavailable.some(item => item.id === name));
    for (const id of unknownEnabled) {
        unavailable.push({ id, note: "Enabled in settings but absent from the running plugin registry." });
    }

    const loadedCustom = customRows.filter(row => row.status !== "unavailable").length;
    const unavailableCount = customRows.filter(row => row.status === "unavailable").length + unavailable.length;
    const summary = !registryReady
        ? "Plugin registry is not ready yet — reload Discordmaxxer if this persists."
        : `${loadedCustom}/${customRows.length} custom plugins present · ${enabledPluginCount} enabled plugins detected · ${unavailableCount} unavailable/stale entries`;

    return {
        registryReady,
        runtimePluginCount,
        enabledPluginCount,
        customRows,
        unavailable,
        summary
    };
}

export function getPluginHealthSummary(): string {
    return getPluginHealthSnapshot().summary;
}

export function renderPluginHealthHTML(): string {
    const snapshot = getPluginHealthSnapshot();
    const rows = snapshot.customRows.map(row => `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(226,91,255,0.1)">
        <span style="width:8px;height:8px;border-radius:50%;margin-top:5px;flex:0 0 auto;background:${row.status === "loaded" ? "#55e69a" : row.status === "off" ? "#8b6aad" : row.status === "unavailable" ? "#ff657a" : "#f3af19"}" title="${escapeHtml(row.statusLabel)}"></span>
        <div style="min-width:0;flex:1"><b>${escapeHtml(row.label)}</b><div style="font-size:10px;opacity:.72">${escapeHtml(row.statusLabel)} · ${escapeHtml(row.note)}</div></div>
    </div>`).join("");
    const stale = snapshot.unavailable.length
        ? `<div style="margin-top:10px;padding:8px;border-radius:7px;background:rgba(255,101,122,.08);border:1px solid rgba(255,101,122,.25)">
            <b style="color:#ff9baa">Not bundled / stale settings</b>
            ${snapshot.unavailable.map(item => `<div style="font-size:10px;margin-top:5px"><b>${escapeHtml(item.id)}</b> — ${escapeHtml(item.note)}</div>`).join("")}
        </div>`
        : "";

    return `<div class="dm-hub-health" style="margin-top:8px;padding:9px 10px;border-radius:8px;background:rgba(15,5,35,.55);border:1px solid rgba(226,91,255,.2)">
        <div style="font-size:11px;line-height:1.45">${escapeHtml(snapshot.summary)}</div>
        <div style="font-size:10px;opacity:.68;margin:4px 0 6px">Runtime registry: ${snapshot.registryReady ? `${snapshot.runtimePluginCount} plugins detected` : "not ready"}. “Loaded” means present and enabled; service/account features still need their real external path.</div>
        ${rows}
        ${stale}
        <div style="display:flex;gap:8px;margin-top:9px">
            <button class="dm-hub-action-btn" data-action="refresh-health">Refresh status</button>
            <button class="dm-hub-action-btn" data-action="open-plugin-settings">Open plugin settings</button>
        </div>
    </div>`;
}

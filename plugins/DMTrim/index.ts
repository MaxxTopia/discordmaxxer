/*
 * Discordmaxxer — DiscordmaxxerTrim plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Hides Discord UI surfaces that don't belong in a power-user / gamer
 * client. CSS-only — no patches, no rendering changes, just `display:
 * none` on aria-label-matched selectors.
 *
 * Targets:
 *   - Family Center (parental controls — irrelevant for our user base)
 *   - "Get Nitro!" promotional banners + Nitro upsell tabs
 *   - HypeSquad (deprecated)
 *   - Server Boosts promo (the standalone "boost a server" prompts; the
 *     real boost icon on a server stays visible)
 *
 * Each item is a per-setting toggle so users can selectively keep stuff.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";

let style: HTMLStyleElement;

function buildCss(): string {
    const parts: string[] = [];

    if (settings.store.hideFamilyCenter) {
        parts.push(`
            /* Family Center — sidebar nav + settings tab */
            [aria-label*="Family Center" i],
            [aria-label*="family-center" i],
            [class*="familyCenter" i],
            [data-list-item-id*="family" i] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hideNitroPromos) {
        parts.push(`
            /* Get-Nitro upsells: friends-list banner, settings tab, profile prompts */
            [aria-label*="Nitro" i][role="tab"],
            [class*="premiumPromoCard" i],
            [class*="upsellContainer" i],
            [class*="nitroPromo" i],
            [data-list-item-id*="nitro" i] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hideHypeSquad) {
        parts.push(`
            [aria-label*="HypeSquad" i],
            [class*="hypeSquad" i] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hideServerBoostPromos) {
        parts.push(`
            /* Standalone boost-a-server promo cards (NOT the boost icon on servers) */
            [class*="boostPromo" i],
            [class*="premiumGuildSubscription" i][class*="banner" i] {
                display: none !important;
            }
        `);
    }

    return parts.join("\n");
}

const settings = definePluginSettings({
    hideFamilyCenter: {
        type: OptionType.BOOLEAN,
        description: "Hide Family Center (parental controls). Recommended ON — most users don't need this.",
        default: true,
        onChange: () => refresh()
    },
    hideNitroPromos: {
        type: OptionType.BOOLEAN,
        description: "Hide 'Get Nitro!' promotional banners and upsell prompts (the Nitro tab in user settings stays so you can manage existing subs).",
        default: true,
        onChange: () => refresh()
    },
    hideHypeSquad: {
        type: OptionType.BOOLEAN,
        description: "Hide HypeSquad (mostly deprecated by Discord — leftover UI).",
        default: true,
        onChange: () => refresh()
    },
    hideServerBoostPromos: {
        type: OptionType.BOOLEAN,
        description: "Hide standalone 'boost a server' promo cards. The boost icon on individual servers remains.",
        default: true,
        onChange: () => refresh()
    }
});

function refresh() {
    if (style) style.textContent = buildCss();
}

export default definePlugin({
    name: "DMTrim",
    description:
        "Declutters Discord without changing messages or servers: hide Family Center, Nitro upsells, HypeSquad, and standalone boost promos independently. CSS-only, reversible, and the real Nitro/boost settings remain available.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-trim", managedStyleRootNode);
        refresh();
    },

    stop() {
        style?.remove();
    }
});

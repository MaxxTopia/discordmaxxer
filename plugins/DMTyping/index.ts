/*
 * Discordmaxxer — DiscordmaxxerTyping plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * MAXXER tier marquee perk — typing prefix. When a Discordmaxxer subscriber
 * is typing, their name in the typing indicator gets a Hypixel-style bracket
 * tag prefix ([VIP] / [MVP] / [MVP++]) in their tier color, so EVERY user's
 * "X is typing..." line surfaces our roster.
 *
 * Implementation: piggybacks on Vencord's TypingTweaks (which we ship default-
 * on). TypingTweaks renders each typing user as a <strong class="vc-typing-user">
 * with an Avatar img child. The avatar URL is shape:
 *   https://cdn.discordapp.com/avatars/{USER_ID}/{HASH}.{ext}?size=128
 * We MutationObserver the typing indicator container, parse user IDs out of
 * the avatar URLs, look up tier from the public roster, and prepend a styled
 * bracket-tag span. Re-runs on every DOM update (Discord re-renders when the
 * typing user set changes).
 *
 * No webpack patches — survives Discord UI churn. If TypingTweaks is disabled
 * the strong elements still exist (Discord's native ones), but without the
 * `.vc-typing-user` class — we skip those rather than risk false-prefixing.
 *
 * Tier gate: read-only — the prefix shows for ANY tagged user we observe,
 * not just the current user. That's the point of a status flex. Plugin is
 * MAXXER+ subscriber-visible AND propagates as ambient brand on free users
 * who see paid users typing.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";

import { getRosterTier } from "../_dm-shared/roster";
import { Tier, TIER_LABELS } from "../_dm-shared/vip";

const PREFIX_CLASS = "dm-typing-prefix";
const PREFIX_DATA_ATTR = "data-dm-typing-prefix";
// Tracks WHICH userId a node was decorated for, so a recycled typing element
// reused for a different user gets re-evaluated instead of keeping a stale tag.
const USER_DATA_ATTR = "data-dm-typing-user";

// Brackets follow the same Hypixel-style mapping used by TierFlair / VipCard.
const TIER_BRACKETS: Record<Tier, string> = {
    [Tier.FREE]: "",
    [Tier.MAXXER]: "[VIP]",
    [Tier.MAXXER_PLUS]: "[VIP+]",
    [Tier.MAXXER_PLUS_PLUS]: "[MVP++]"
};

const TIER_COLORS: Record<Tier, string> = {
    [Tier.FREE]: "",
    [Tier.MAXXER]: "#55FF55",
    [Tier.MAXXER_PLUS]: "#55FFFF",
    [Tier.MAXXER_PLUS_PLUS]: "#FFAA00"
};

const TYPING_PREFIX_CSS = `
    .${PREFIX_CLASS} {
        display: inline-block;
        margin-right: 4px;
        font-family: "Tungsten Bold", "Bebas Neue", "Oswald", "Arial Black", sans-serif;
        font-weight: 800;
        font-size: 0.92em;
        letter-spacing: 0.02em;
        text-shadow: 0 1px 0 #000;
        vertical-align: baseline;
    }
    .${PREFIX_CLASS}--MAXXER          { color: #55FF55; }
    .${PREFIX_CLASS}--MAXXER_PLUS     { color: #55FFFF; }
    .${PREFIX_CLASS}--MAXXER_PLUS_PLUS { color: #FFAA00; }
`;

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;

// Avatar URL shape: ".../avatars/{userId}/{hash}.png?size=128" — the user ID
// is the segment immediately after "/avatars/". Default avatars use a numeric
// "/embed/avatars/{discrim}.png" path; those users have no custom avatar and
// also won't have a roster entry yet, so we can safely ignore them.
function userIdFromAvatarUrl(url: string | null): string | null {
    if (!url) return null;
    const match = /\/avatars\/(\d+)\//.exec(url);
    return match ? match[1] : null;
}

function decorateTypingUser(strong: HTMLElement) {
    const img = strong.querySelector("img[src*='/avatars/']") as HTMLImageElement | null;
    const userId = userIdFromAvatarUrl(img?.src ?? null);

    const camelUser = toCamel(USER_DATA_ATTR);
    const decoratedFor = strong.dataset[camelUser] ?? "";
    // Already decorated for THIS exact user — nothing to do.
    if (decoratedFor === (userId ?? "")) return;

    // Node was recycled for a different user (or none): strip our prior bracket
    // and tags before re-evaluating, so we never leave the wrong tier showing.
    strong.querySelector(`span.${PREFIX_CLASS}`)?.remove();
    delete strong.dataset[toCamel(PREFIX_DATA_ATTR)];
    if (!userId) {
        delete strong.dataset[camelUser];
        return;
    }
    strong.dataset[camelUser] = userId;

    const tier = getRosterTier(userId);
    if (tier === Tier.FREE) return;

    const tierKey = TIER_LABELS[tier].replace("+", "_PLUS").replace(" ", "_");
    const cls = `${PREFIX_CLASS} ${PREFIX_CLASS}--${
        tier === Tier.MAXXER ? "MAXXER" : tier === Tier.MAXXER_PLUS ? "MAXXER_PLUS" : "MAXXER_PLUS_PLUS"
    }`;

    const span = document.createElement("span");
    span.className = cls;
    span.textContent = TIER_BRACKETS[tier];
    strong.insertBefore(span, strong.firstChild);
    strong.dataset[toCamel(PREFIX_DATA_ATTR)] = tierKey;
}

function toCamel(dataAttr: string): string {
    // "data-dm-typing-prefix" -> "dmTypingPrefix"
    return dataAttr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function scanRoot(root: ParentNode = document) {
    root.querySelectorAll<HTMLElement>(".vc-typing-user").forEach(decorateTypingUser);
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.classList?.contains("vc-typing-user")) {
                    decorateTypingUser(node as HTMLElement);
                }
                scanRoot(node);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanRoot(document);
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
    document.querySelectorAll<HTMLElement>(`[${PREFIX_DATA_ATTR}], [${USER_DATA_ATTR}]`).forEach(el => {
        el.querySelector(`.${PREFIX_CLASS}`)?.remove();
        delete el.dataset[toCamel(PREFIX_DATA_ATTR)];
        delete el.dataset[toCamel(USER_DATA_ATTR)];
    });
}

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description:
            "Show Hypixel-style [VIP] / [VIP+] / [MVP++] prefix in front of paid Discordmaxxer subscribers' names in the typing indicator. Requires TypingTweaks to be enabled (it is, by default).",
        default: true,
        onChange: (on: boolean) => {
            if (on) startObserver();
            else stopObserver();
        }
    }
});

export default definePlugin({
    name: "DMTyping",
    description:
        "MAXXER tier perk — Hypixel-style [VIP]/[VIP+]/[MVP++] bracket prefix in the typing indicator for paid Discordmaxxer subscribers. Pure DOM observer (no webpack patches), works on top of TypingTweaks.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-typing-prefix-style", managedStyleRootNode);
        style.textContent = TYPING_PREFIX_CSS;
        if (settings.store.enabled !== false) startObserver();
    },

    stop() {
        stopObserver();
        style?.remove();
        style = null;
    }
});

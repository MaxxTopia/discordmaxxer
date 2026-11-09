/*
 * Discordmaxxer — DiscordmaxxerTrim plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Hides Discord UI surfaces that don't belong in a power-user / gamer
 * client. CSS-first — the normal path is still a small managed stylesheet.
 * A bounded, throttled observer handles ad cards whose class names are
 * obfuscated and therefore cannot be selected reliably with CSS alone. Keep
 * this stylesheet free of relational `:has()` selectors: they add expensive
 * stylesheet recalculation work and a larger crash surface while Discord is
 * recovering or mounting UI.
 *
 * Targets:
 *   - Family Center (parental controls — irrelevant for our user base)
 *   - "Get Nitro!" promotional banners + Nitro upsell tabs
 *   - HypeSquad (deprecated)
 *   - Server Boosts promo (the standalone "boost a server" prompts; the
 *     real boost icon on a server stays visible)
 *   - Sponsored/reward ad cards (including Fanduel's "Get Reward!" card)
 *
 * Each item is a per-setting toggle so users can selectively keep stuff.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";

let style: HTMLStyleElement | undefined;
let promoObserver: MutationObserver | undefined;
let promoScanTimer: ReturnType<typeof setTimeout> | undefined;
const promoInitialScanTimers: ReturnType<typeof setTimeout>[] = [];
const pendingPromoNodes = new Set<Node>();

const PROMO_TEXT_NODE_LIMIT = 420;
const PROMO_ANCESTOR_LIMIT = 10;

const PROMO_SELECTOR = [
    '[aria-label*="Sponsored" i]',
    '[aria-label*="Advertisement" i]',
    '[aria-label*="Promoted" i]',
    '[data-testid*="sponsored" i]',
    '[data-testid*="promoted" i]',
    '[class*="adContainer" i]',
    '[class*="adCard" i]',
    '[class*="advert" i]',
    '[class*="sponsor" i]',
    '[class*="promoted" i]'
].join(",");

const PROMO_MARKER = "data-dmtrim-hidden-promo";
const PROMO_BRAND_RE = /\bfanduel\b/i;
const PROMO_LABEL_RE = /\b(?:sponsored|promoted|advertisement|ad choices)\b/i;
const PROMO_ACTION_RE = /\b(?:get reward|watch\s+\d+\s*(?:s|sec|seconds)?|unlock(?:\s+\d+(?:\.\d+)?x)?|learn more)\b/i;
const PROMO_ATTRIBUTE_RE = /(?:fanduel|sponsor|promot|advert|adcontainer|adcard|reward)/i;

function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function hasPromotionalSignal(value: string): boolean {
    const text = normalizeText(value);
    return PROMO_BRAND_RE.test(text) || PROMO_LABEL_RE.test(text) || PROMO_ACTION_RE.test(text);
}

function isPromotionalCard(element: Element): boolean {
    const text = normalizeText(element.textContent ?? "");
    if (text.length < 4 || text.length > 900) return false;

    // Some reward placements omit the Sponsored/Promoted label and rotate
    // their brand text, but still combine a reward CTA with a media/control
    // element. Require all three signals for this fallback so an ordinary
    // message that merely mentions a reward is left alone.
    const hasAction = PROMO_ACTION_RE.test(text);
    if (!hasAction) return false;
    if (PROMO_BRAND_RE.test(text) || PROMO_LABEL_RE.test(text)) return true;

    return element.querySelector("img, video, button, a, [role=\"button\"]") !== null;
}

function findPromotionalTarget(element: Element): HTMLElement | null {
    let candidate: HTMLElement | null = element instanceof HTMLElement ? element : element.parentElement;
    let depth = 0;
    const candidates: HTMLElement[] = [];

    while (candidate && candidate !== document.body && depth++ < PROMO_ANCESTOR_LIMIT) {
        const rect = candidate.getBoundingClientRect();
        if (isPromotionalCard(candidate) && rect.width >= 180 && rect.height >= 48 && rect.height <= 420) {
            candidates.push(candidate);
        }
        candidate = candidate.parentElement;
    }

    if (!candidates.length) return null;

    // Prefer a stable semantic ad card when Discord exposes one. Otherwise
    // choose the smallest coherent visible card: this avoids marking only a
    // CTA button while also avoiding a whole message panel or profile column.
    return candidates.sort((left, right) => {
        const leftSemantic = left.matches(PROMO_SELECTOR) ? 1 : 0;
        const rightSemantic = right.matches(PROMO_SELECTOR) ? 1 : 0;
        if (leftSemantic !== rightSemantic) return rightSemantic - leftSemantic;

        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
    })[0];
}

function hidePromotionalCard(element: Element): void {
    if (!isPromotionalCard(element)) return;

    const target = findPromotionalTarget(element);
    target?.setAttribute(PROMO_MARKER, "true");
}

function hidePromotionalTextNode(node: Node): void {
    const parent = node.parentElement;
    if (!parent) return;

    const target = findPromotionalTarget(parent);
    target?.setAttribute(PROMO_MARKER, "true");
}

function scanPromotionalNode(node: Node): void {
    const root = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

    const rootElement = root as Element;
    hidePromotionalCard(rootElement);

    // Only inspect semantic ad hooks beneath a newly-mounted root. A full
    // descendant/class scan made this safety net needlessly expensive on
    // Discord's large message tree.
    let inspected = 0;
    for (const element of root.querySelectorAll<HTMLElement>(PROMO_SELECTOR)) {
        if (++inspected > 24) break;
        hidePromotionalCard(element);
    }

    // Some ad placements have fully obfuscated classes and no semantic
    // attributes. Walk only a small number of text nodes whose text could be
    // promotional, then climb a short ancestor chain to find the card. This
    // catches cards such as Fanduel without rescanning Discord's full message
    // tree on every mount.
    // Avoid walking ordinary Discord content at all. Obfuscated promos are
    // only worth checking when their newly-mounted subtree contains a known
    // brand/label/action marker; this keeps the fallback cheap in normal use.
    const rootText = normalizeText((rootElement.textContent ?? "").slice(0, 12000));
    if (!hasPromotionalSignal(rootText)) return;

    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);
    let textNodes = 0;
    let current: Node | null = walker.nextNode();
    while (current && textNodes++ < PROMO_TEXT_NODE_LIMIT) {
        const text = normalizeText(current.nodeValue ?? "");
        if (hasPromotionalSignal(text)) hidePromotionalTextNode(current);
        current = walker.nextNode();
    }
}

function clearPromotionalMarkers(): void {
    document.querySelectorAll<HTMLElement>(`[${PROMO_MARKER}]`).forEach(element => element.removeAttribute(PROMO_MARKER));
}

function flushPromotionalScan(): void {
    try {
        promoScanTimer = undefined;
        const nodes = [...pendingPromoNodes];
        pendingPromoNodes.clear();

        for (const node of nodes.slice(0, 40)) scanPromotionalNode(node);
    } catch (error) {
        promoScanTimer = undefined;
        console.warn("[DMTrim] promotional scan ignored during navigation:", error);
    }
}

function schedulePromotionalScan(nodes: Node[]): void {
    nodes.forEach(node => pendingPromoNodes.add(node));
    if (promoScanTimer !== undefined) return;

    promoScanTimer = setTimeout(() => {
        try {
            flushPromotionalScan();
        } catch (error) {
            promoScanTimer = undefined;
            console.warn("[DMTrim] promotional scan timer ignored during navigation:", error);
        }
    }, 100);
}

function stopPromotionalObserver(): void {
    promoObserver?.disconnect();
    promoObserver = undefined;

    if (promoScanTimer !== undefined) {
        clearTimeout(promoScanTimer);
        promoScanTimer = undefined;
    }

    while (promoInitialScanTimers.length) {
        const timer = promoInitialScanTimers.pop();
        if (timer !== undefined) clearTimeout(timer);
    }

    pendingPromoNodes.clear();
    clearPromotionalMarkers();
}

function startPromotionalObserver(): void {
    stopPromotionalObserver();
    if (settings.store.hidePromotedAds === false || !document.body || typeof MutationObserver === "undefined") return;

    // Catch semantic cards and already-mounted obfuscated cards before the
    // observer attaches. The delayed passes cover reward cards whose text is
    // filled in after Discord has mounted the shell.
    const existing = [...document.querySelectorAll<HTMLElement>(PROMO_SELECTOR)].slice(-160);
    schedulePromotionalScan([document.body, ...existing]);

    for (const delay of [350, 1200]) {
        promoInitialScanTimers.push(
            setTimeout(() => {
                try {
                    if (document.visibilityState !== "hidden" && document.body) schedulePromotionalScan([document.body]);
                } catch (error) {
                    console.warn("[DMTrim] initial promotional scan ignored during navigation:", error);
                }
            }, delay)
        );
    }

    promoObserver = new MutationObserver(records => {
        try {
            const nodes: Node[] = [];
            for (const record of records) {
                if (record.type === "childList") {
                    for (const node of record.addedNodes) {
                        if (node.nodeType === Node.TEXT_NODE) {
                            if (hasPromotionalSignal(node.nodeValue ?? "")) nodes.push(node.parentElement ?? node);
                        } else {
                            nodes.push(node);
                        }
                    }
                } else if (record.type === "characterData") {
                    if (hasPromotionalSignal(record.target.nodeValue ?? "")) {
                        nodes.push(record.target.parentElement ?? record.target);
                    }
                } else if (record.type === "attributes" && record.target instanceof Element) {
                    const value = record.target.getAttribute(record.attributeName ?? "") ?? "";
                    if (PROMO_ATTRIBUTE_RE.test(value)) nodes.push(record.target);
                }
            }
            if (nodes.length) schedulePromotionalScan(nodes);
        } catch (error) {
            console.warn("[DMTrim] promotional observer ignored during navigation:", error);
        }
    });
    promoObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-label", "class", "data-testid"]
    });
}

function buildCss(): string {
    const parts: string[] = [];

    if (settings.store.hideFamilyCenter !== false) {
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

    if (settings.store.hideNitroPromos !== false) {
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

    if (settings.store.hideHypeSquad !== false) {
        parts.push(`
            [aria-label*="HypeSquad" i],
            [class*="hypeSquad" i] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hideServerBoostPromos !== false) {
        parts.push(`
            /* Standalone boost-a-server promo cards (NOT the boost icon on servers) */
            [class*="boostPromo" i],
            [class*="premiumGuildSubscription" i][class*="banner" i] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hideQuests !== false) {
        parts.push(`
            /* Quests: bottom-left promoted quest card above user bar + sidebar tab */
            div[class*="questsContainer"],
            div[class*="questBar"],
            div[class*="questPrompt"],
            div[class*="questDock"],
            div[class*="questCard"],
            div[class*="questPromotion"],
            div[class*="questNotice"],
            div[class*="questBanner"],
            div[class*="questProgress"],
            [class*="promotedContainer"],
            [class*="promotedTag"],
            div[class*="container_"][class*="quest"],
            div[class*="wrapper_"][class*="quest"],
            a[href="/quest-home"],
            a[href*="/quests"],
            div[class*="questTab_"],
            div[class*="questHome_"],
            [data-list-item-id*="quests" i],
            [data-list-item-id*="quest-home" i] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hidePromotedAds !== false) {
        parts.push(`
            /* Sponsored/reward cards. The observer covers cards with obfuscated class names. */
            ${PROMO_SELECTOR} {
                display: none !important;
            }
            [${PROMO_MARKER}] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hideShop !== false) {
        parts.push(`
            /* Shop: sidebar Shop tab in Direct Messages */
            a[href="/shop"],
            [data-list-item-id*="shop" i] {
                display: none !important;
            }
        `);
    }

    return parts.join("\n");
}

const settings = definePluginSettings({
    hideQuests: {
        type: OptionType.BOOLEAN,
        description: "Hide sponsored Quest promotional cards above the user panel and the Quests tab in Direct Messages.",
        default: true,
        onChange: () => refresh()
    },
    hidePromotedAds: {
        type: OptionType.BOOLEAN,
        description: "Hide sponsored/reward ad cards such as Fanduel's 'Get Reward!' card. Normal messages remain visible.",
        default: true,
        onChange: () => {
            refresh();
            startPromotionalObserver();
        }
    },
    hideShop: {
        type: OptionType.BOOLEAN,
        description: "Hide the Nitro Shop tab in Direct Messages.",
        default: true,
        onChange: () => refresh()
    },
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
    if (!style?.isConnected) return;

    try {
        style.textContent = buildCss();
    } catch (error) {
        console.warn("[DMTrim] Failed to refresh stylesheet", error);
    }
}

export default definePlugin({
    name: "DMTrim",
    description:
        "Declutters Discord without changing messages or servers: hide Family Center, sponsored Quests and ad cards, Shop, Nitro upsells, HypeSquad, and standalone boost promos independently. CSS-first, bounded, reversible, and the real Nitro/boost settings remain available.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-trim", managedStyleRootNode);
        refresh();
        startPromotionalObserver();
    },

    stop() {
        stopPromotionalObserver();
        style?.remove();
        style = undefined;
    }
});

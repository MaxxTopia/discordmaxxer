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
    '[data-testid="quest-bar-container"]',
    '[data-testid*="quest-bar" i]',
    '[data-testid*="quest" i]',
    '[aria-label*="Quest" i]',
    '[class*="adContainer" i]',
    '[class*="adCard" i]',
    '[class*="advert" i]',
    '[class*="sponsor" i]',
    '[class*="promoted" i]',
    '[class*="questBar" i]',
    '[class*="questsContainer" i]',
    '[class*="questPrompt" i]',
    '[class*="questDock" i]',
    '[class*="questCard" i]',
    '[class*="questPromotion" i]',
    '[class*="questNotice" i]',
    '[class*="questBanner" i]',
    '[class*="questProgress" i]'
].join(",");

// SpotifyControls mounts immediately above the account panel, which is also
// where Discord has placed sponsored/reward cards in some client builds. Keep
// the ad cleanup path explicitly separate from that player. This is both a
// runtime guard and a cheap way to avoid hiding a player wrapper when a
// Discord class name happens to contain "advert" or "sponsor".
const SPOTIFY_SURFACE_SELECTOR = [
    "#vc-spotify-player",
    ".vc-spotify-player",
    ".vc-spotify-fallback",
    "[data-dm-spotify-player]",
    "[data-dm-spotify-surface]",
    "[data-dm-spotify-slot]",
    "[id*='spotify' i]",
    "[class*='spotify' i]"
].join(",");

// Critical user surfaces that must never be hidden or marked by ad-cleaning logic.
const PROTECTED_SURFACE_SELECTOR = [
    // Spotify controls
    "#vc-spotify-player",
    ".vc-spotify-player",
    ".vc-spotify-fallback",
    "[data-dm-spotify-player]",
    "[data-dm-spotify-surface]",
    "[data-dm-spotify-slot]",
    "[id*='spotify' i]",
    "[class*='spotify' i]",
    // User account panel: avatar, nametag, settings buttons
    '[class*="panels_"] > [class*="container_"]',
    '[class*="panels_"] [class*="avatarWrapper_"]',
    '[class*="panels_"] [class*="nameTag_"]',
    '[class*="panels_"] button[aria-label*="Mute" i]',
    '[class*="panels_"] button[aria-label*="Deafen" i]',
    '[class*="panels_"] button[aria-label*="User Settings" i]',
    // Voice call controls
    'div[class*="connection_"]',
    'div[class*="voice_"]',
    '[class*="videoControls_"]',
    // Chat content and messages
    '[class*="chatContent" i]',
    '[class*="messageListItem" i]',
    '[id^="chat-messages-"]'
].join(",");

function isProtectedSurface(element: Element | null): boolean {
    if (!element) return false;
    try {
        return element.matches(PROTECTED_SURFACE_SELECTOR) || element.closest(PROTECTED_SURFACE_SELECTOR) !== null;
    } catch {
        return true;
    }
}

// Keep the stylesheet on stable semantic hooks only. Obfuscated class names
// are handled by the bounded observer below, where the Spotify guard can run
// before a node is marked. A broad CSS class selector cannot inspect its
// descendants and was therefore capable of hiding the Spotify slot.
const PROMO_CSS_SELECTOR = [
    '[aria-label*="Sponsored" i]',
    '[aria-label*="Advertisement" i]',
    '[aria-label*="Promoted" i]',
    '[data-testid*="sponsored" i]',
    '[data-testid*="promoted" i]',
    '[class*="promotedContainer" i]',
    '[class*="promotedTag" i]',
    '[class*="adContainer" i]',
    '[class*="adCard" i]'
].join(",");

const PROMO_MARKER = "data-dmtrim-hidden-promo";
const PROMO_BRAND_RE = /\b(?:fanduel|violent night)\b/i;
const PROMO_LABEL_RE = /\b(?:sponsored|promoted|advertisement|ad choices|quest)\b/i;
const PROMO_ACTION_RE = /\b(?:get reward|claim reward|start quest|accept quest|view quest|watch\s+\d+\s*(?:s|sec|seconds)?|unlock(?:\s+\d+(?:\.\d+)?x)?)\b/i;
const PROMO_ATTRIBUTE_RE = /(?:fanduel|sponsor|promot|advert|adcontainer|adcard|reward|quest)/i;

function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function hasPromotionalSignal(value: string): boolean {
    const text = normalizeText(value);
    return PROMO_BRAND_RE.test(text) || PROMO_LABEL_RE.test(text) || PROMO_ACTION_RE.test(text);
}

function hasPromotionalStructure(element: Element): boolean {
    try {
        return element.matches(PROMO_SELECTOR)
            || [...element.attributes].some(attribute => PROMO_ATTRIBUTE_RE.test(`${attribute.name} ${attribute.value}`));
    } catch {
        // DOM nodes can be replaced during navigation. If their attributes
        // cannot be inspected, keep the content visible.
        return false;
    }
}

function isSpotifySurface(element: Element | null): boolean {
    if (!element) return false;

    try {
        return element.matches(SPOTIFY_SURFACE_SELECTOR) || element.closest(SPOTIFY_SURFACE_SELECTOR) !== null;
    } catch {
        // A navigation/unmount can invalidate a selector target between the
        // mutation callback and this check. Fail safe: never hide a node when
        // we cannot prove that it is an ordinary promotional surface.
        return true;
    }
}

function containsSpotifySurface(element: Element): boolean {
    if (isSpotifySurface(element)) return true;

    try {
        return element.querySelector(SPOTIFY_SURFACE_SELECTOR) !== null;
    } catch {
        // A selector failure must not let the ad observer hide the account
        // panel that contains Spotify while Discord is changing routes.
        return true;
    }
}

function isPromotionalCard(element: Element): boolean {
    if (containsSpotifySurface(element)) return false;
    if (isProtectedSurface(element)) return false;
    // Real chat messages in channels or DMs are never ad promos.
    if (element.closest('[class*="messageListItem" i], [id^="chat-messages-"], [class*="chatContent" i]')) return false;

    const text = normalizeText(element.textContent ?? "");
    if (text.length < 4 || text.length > 900) return false;

    // Keep the fallback limited to ad-specific actions and ad-specific
    // markup. Generic CTAs such as "Learn more" appear in normal product
    // announcements; a link or image alone is not evidence that a message is
    // an advertisement.
    const hasAction = PROMO_ACTION_RE.test(text);
    if (!hasAction) return false;
    if (PROMO_BRAND_RE.test(text) || PROMO_LABEL_RE.test(text)) return true;

    return hasPromotionalStructure(element)
        && element.querySelector("img, video, button, a, [role=\"button\"]") !== null;
}

function findPromotionalTarget(element: Element): HTMLElement | null {
    let candidate: HTMLElement | null = element instanceof HTMLElement ? element : element.parentElement;
    let depth = 0;
    const candidates: HTMLElement[] = [];

    while (candidate && candidate !== document.body && depth++ < PROMO_ANCESTOR_LIMIT) {
        const rect = candidate.getBoundingClientRect();
        if (!isProtectedSurface(candidate) && !containsSpotifySurface(candidate) && isPromotionalCard(candidate) && rect.width >= 160 && rect.height >= 32 && rect.height <= 480) {
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

function checkAndDismissPromotionalDialog(root: Element): void {
    if (settings.store.hideQuests === false && settings.store.hidePromotedAds === false) return;

    const dialogs: Element[] = [];
    if (root.getAttribute("role") === "dialog") {
        dialogs.push(root);
    }
    dialogs.push(...Array.from(root.querySelectorAll('[role="dialog"]')));

    for (const dialog of dialogs) {
        if (!(dialog instanceof HTMLElement)) continue;
        if (isProtectedSurface(dialog)) continue;
        // Never touch settings or user profile or normal dialogs
        if (dialog.querySelector('[class*="standardSidebarView" i], [class*="userProfileModal" i]')) continue;

        const ariaLabel = dialog.getAttribute("aria-label") ?? "";
        const testId = dialog.getAttribute("data-testid") ?? "";
        const text = normalizeText((dialog.textContent ?? "").slice(0, 1500));

        const isQuest = /quest/i.test(ariaLabel) || /quest/i.test(testId) || dialog.querySelector('[class*="quest" i], [data-testid*="quest" i]') !== null;
        const isPromo = (hasPromotionalSignal(text) && /\b(?:quest|promoted|orbs?)\b/i.test(text)) || hasPromotionalStructure(dialog);

        if (isQuest || isPromo) {
            dialog.setAttribute(PROMO_MARKER, "true");
            // Attempt to trigger normal close via close button first
            const closeBtn = dialog.querySelector<HTMLElement>(
                'button[aria-label*="close" i], [aria-label*="close" i], button[class*="closeButton" i], [class*="closeButton" i]'
            );
            if (closeBtn) {
                closeBtn.click();
            } else {
                const escEvent = new KeyboardEvent("keydown", {
                    key: "Escape",
                    code: "Escape",
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true
                });
                dialog.dispatchEvent(escEvent);
                window.dispatchEvent(escEvent);
            }

            // Immediately neutralize the backdrop & layer so clicks pass through without delay
            const layer = dialog.closest<HTMLElement>('[class*="layer_"], [class*="layerContainer_"]');
            if (layer) {
                layer.style.pointerEvents = "none";
                const backdrop = layer.parentElement?.querySelector<HTMLElement>('[class*="backdrop_"]')
                    ?? layer.querySelector<HTMLElement>('[class*="backdrop_"]');
                if (backdrop) backdrop.style.display = "none";
                dialog.style.display = "none";
            }
        }
    }
}

function scanPromotionalNode(node: Node): void {
    const root = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

    const rootElement = root as Element;
    checkAndDismissPromotionalDialog(rootElement);
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
    if (settings.store.hidePromotedAds === false && settings.store.hideQuests === false) return;
    if (!document.body || typeof MutationObserver === "undefined") return;

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
                        if (node instanceof Element && node.closest?.('[role="textbox"], form, [class*="channelTextArea" i], [contenteditable="true"]')) {
                            continue;
                        }
                        if (node.nodeType === Node.TEXT_NODE) {
                            if (node.parentElement?.closest?.('[role="textbox"], form, [class*="channelTextArea" i], [contenteditable="true"]')) {
                                continue;
                            }
                            if (hasPromotionalSignal(node.nodeValue ?? "")) nodes.push(node.parentElement ?? node);
                        } else {
                            nodes.push(node);
                        }
                    }
                } else if (record.type === "characterData") {
                    if (record.target.parentElement?.closest?.('[role="textbox"], form, [class*="channelTextArea" i], [contenteditable="true"]')) {
                        continue;
                    }
                    if (hasPromotionalSignal(record.target.nodeValue ?? "")) {
                        nodes.push(record.target.parentElement ?? record.target);
                    }
                } else if (record.type === "attributes" && record.target instanceof Element) {
                    if (record.target.closest?.('[role="textbox"], form, [class*="channelTextArea" i], [contenteditable="true"]')) {
                        continue;
                    }
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
            /* Quests: bottom-left promoted quest card above user bar + sidebar tab + dialog */
            [data-testid="quest-bar-container"],
            [data-testid*="quest-bar" i],
            [data-testid*="quest" i],
            div[class*="questBar" i],
            div[class*="questBar_"],
            div[class*="questsContainer" i],
            div[class*="questsContainer_"],
            div[class*="questPrompt" i],
            div[class*="questDock" i],
            div[class*="questCard" i],
            div[class*="questCard_"],
            div[class*="questPromotion" i],
            div[class*="questNotice" i],
            div[class*="questBanner" i],
            div[class*="questBanner_"],
            div[class*="questProgress" i],
            div[class*="questProgress_"],
            div[class*="questChannelCallHeader" i],
            div[class*="quest_" i],
            [class*="promotedContainer" i],
            [class*="promotedTag" i],
            div[class*="container_"][class*="quest" i],
            div[class*="wrapper_"][class*="quest" i],
            [class*="panels_"] [class*="quest" i],
            [class*="panels_"] [data-testid*="quest" i],
            [class*="panels_"] [class*="reward" i],
            [role="dialog"][class*="quest" i],
            [role="dialog"][aria-label*="Quest" i],
            [role="dialog"][data-testid*="quest" i],
            div[class*="questModal" i],
            a[href="/quest-home"],
            a[href*="/quests"],
            div[class*="questTab_" i],
            div[class*="questHome_" i],
            [data-list-item-id*="quests" i],
            [data-list-item-id*="quest-home" i] {
                display: none !important;
            }
        `);
    }

    if (settings.store.hidePromotedAds !== false) {
        parts.push(`
            /* Sponsored/reward cards. The observer covers cards with obfuscated class names. */
            ${PROMO_CSS_SELECTOR} {
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
        onChange: () => {
            refresh();
            startPromotionalObserver();
        }
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

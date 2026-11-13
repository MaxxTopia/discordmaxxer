/*
 * Discordmaxxer — Top Bar Branding
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Keeps the Discordmaxxer brand logo & wordmark visible at the very top left
 * of the top bar in both Visual Refresh and classic titlebar layouts.
 */

export const DM_TOPBAR_LOGO_DATA =
    "data:image/png;base64,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";

const STYLE_ID = "dm-topbar-style";
const BRAND_ID = "dm-topbar-brand";

const CSS = `
#${BRAND_ID} {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 24px;
    padding: 2px 8px 2px 10px;
    margin-right: 6px;
    cursor: pointer;
    user-select: none;
    border-radius: 6px;
    transition: background 0.15s ease, filter 0.15s ease, transform 0.1s ease;
    -webkit-app-region: no-drag;
    flex-shrink: 0;
}
#${BRAND_ID}:hover {
    background: rgba(226, 91, 255, 0.14);
    filter: brightness(1.15);
}
#${BRAND_ID}:active {
    transform: scale(0.97);
}
#${BRAND_ID} .dm-topbar-icon {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: block;
    object-fit: contain;
    filter: drop-shadow(0 0 5px rgba(226, 91, 255, 0.65));
    flex-shrink: 0;
}
#${BRAND_ID} .dm-topbar-text {
    font-family: var(--font-display, "gg sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.6px;
    line-height: 18px;
    background: linear-gradient(90deg, #e25bff, #00d4ff);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-transform: uppercase;
    white-space: nowrap;
}

/* Classic titlebar wordmark replacement */
[class*="wordmark"] > svg {
    display: none !important;
}
[class*="wordmark"] {
    display: inline-flex !important;
    align-items: center !important;
    gap: 7px !important;
    height: 100% !important;
    padding-left: 10px !important;
    opacity: 0.9 !important;
    transition: opacity 0.15s ease !important;
    cursor: pointer !important;
    -webkit-app-region: drag !important;
}
[class*="wordmark"]:hover {
    opacity: 1 !important;
}
[class*="wordmark"]::before {
    content: "" !important;
    display: inline-block !important;
    width: 16px !important;
    height: 16px !important;
    background: url("${DM_TOPBAR_LOGO_DATA}") center/contain no-repeat !important;
    border-radius: 50% !important;
    flex-shrink: 0 !important;
    filter: drop-shadow(0 0 5px rgba(226, 91, 255, 0.65)) !important;
}
[class*="wordmark"]::after {
    content: "DISCORDMAXXER" !important;
    display: inline-block !important;
    font-family: var(--font-display, "gg sans", -apple-system, BlinkMacSystemFont, sans-serif) !important;
    font-size: 11px !important;
    font-weight: 800 !important;
    letter-spacing: 0.6px !important;
    line-height: 16px !important;
    background: linear-gradient(90deg, #e25bff, #00d4ff) !important;
    -webkit-background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    text-transform: uppercase !important;
}
`;

function injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
}

function handleBrandClick(e: MouseEvent): void {
    e.stopPropagation();
    const hubBtn = document.getElementById("dm-hub-fab");
    if (hubBtn) {
        hubBtn.click();
    } else {
        const settingsBtn = document.querySelector<HTMLElement>('button[aria-label="User Settings"]');
        settingsBtn?.click();
    }
}

function createBrandElement(): HTMLElement {
    const brand = document.createElement("div");
    brand.id = BRAND_ID;
    brand.className = "dm-topbar-brand";
    brand.title = "Discordmaxxer — Discord, optimized";

    const icon = document.createElement("img");
    icon.className = "dm-topbar-icon";
    icon.src = DM_TOPBAR_LOGO_DATA;
    icon.alt = "Discordmaxxer";

    const text = document.createElement("span");
    text.className = "dm-topbar-text";
    text.textContent = "Discordmaxxer";

    brand.appendChild(icon);
    brand.appendChild(text);

    brand.addEventListener("click", handleBrandClick);
    return brand;
}

export function ensureTopBarBrand(): void {
    injectStyle();

    if (document.getElementById(BRAND_ID)) return;

    // Visual Refresh top bar leading section (very top left)
    const leading = document.querySelector<HTMLElement>('[class*="leading_"]');
    if (leading) {
        const brand = createBrandElement();
        leading.insertBefore(brand, leading.firstChild);
        return;
    }

    // Fallback: top window chrome bar
    const bar = document.querySelector<HTMLElement>('[data-window-chrome="true"]');
    if (bar && !bar.querySelector(`#${BRAND_ID}`)) {
        const brand = createBrandElement();
        bar.insertBefore(brand, bar.firstChild);
    }
}

function init(): void {
    injectStyle();
    ensureTopBarBrand();

    // Observe DOM mutations to keep top bar brand mounted across page/channel transitions
    const observer = new MutationObserver(() => {
        if (!document.getElementById(BRAND_ID)) {
            ensureTopBarBrand();
        }
    });

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
    init();
}

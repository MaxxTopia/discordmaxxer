/*
 * Discordmaxxer - safe attachment image context menu
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Discord's desktop image context-menu route has regressed more than once in
 * the overlay. Keep this handler narrow and always available: it only claims
 * a real Discord attachment image, and leaves ordinary message menus alone.
 */

import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { saveFile } from "@utils/web";
import { ContextMenuApi, Menu, React } from "@webpack/common";

const DISCORD_CDN_HOSTS = new Set([
    "cdn.discordapp.com",
    "media.discordapp.net",
    "images-ext-1.discordapp.net"
]);

type ImageMenuActions = {
    copyImage(url: string): Promise<void>;
    saveImage(url: string): Promise<void>;
};

let imageContextMenuHandler: ((event: MouseEvent) => void) | null = null;

// Discord can dispatch events from a different DOM realm, especially from
// the fullscreen media viewer. Cross-realm instanceof checks are unreliable.
function domElementFromTarget(target: EventTarget | null): Element | null {
    if (!target || typeof target !== "object") return null;
    return (target as { nodeType?: unknown }).nodeType === 1 ? target as Element : null;
}

function isImageElement(value: Element | null): value is HTMLImageElement {
    return value?.tagName?.toLowerCase() === "img";
}

function imageFromTarget(target: EventTarget | null): HTMLImageElement | null {
    const element = domElementFromTarget(target);
    if (!element) return null;
    if (isImageElement(element)) return element;

    const ancestorImage = element.closest("img");
    if (isImageElement(ancestorImage)) return ancestorImage;

    // Attachment previews can put an invisible original-link anchor over the
    // placeholder image. Resolve the image from the same Discord wrapper.
    const wrapper = element.closest<HTMLElement>("[class*='imageWrapper' i]");
    const wrapperImage = wrapper?.querySelector("img");
    if (isImageElement(wrapperImage)) return wrapperImage;

    // The fullscreen viewer may deliver the event to a media container.
    const descendants = element.querySelectorAll("img");
    return descendants.length === 1 && isImageElement(descendants[0])
        ? descendants[0] as HTMLImageElement
        : null;
}

function isDiscordAttachmentUrl(value: string): string | null {
    try {
        const url = new URL(value, location.href);
        const host = url.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();
        const allowedHost = DISCORD_CDN_HOSTS.has(host)
            || host.endsWith(".discordapp.com")
            || host.endsWith(".discordapp.net");
        const attachmentPath = path.includes("/attachments/") || path.includes("/ephemeral-attachments/");
        return allowedHost && attachmentPath ? url.toString() : null;
    } catch {
        return null;
    }
}

function attachmentUrlFromTarget(target: EventTarget | null): string | null {
    const element = domElementFromTarget(target);
    const image = imageFromTarget(target);
    if (!element && !image) return null;

    // Lazy previews use a data URL while the sibling original-link anchor
    // already has the real CDN URL. Prefer that link over the placeholder.
    const wrapper = image?.closest<HTMLElement>("[class*='imageWrapper' i]")
        ?? element?.closest<HTMLElement>("[class*='imageWrapper' i]");
    const originalLink = wrapper?.querySelector<HTMLAnchorElement>("a[data-role='img'][href]")
        ?? image?.closest<HTMLAnchorElement>("a[data-role='img'][href]")
        ?? element?.closest<HTMLAnchorElement>("a[data-role='img'][href]");

    const candidates = [
        image?.currentSrc,
        image?.src,
        image?.getAttribute("data-src"),
        image?.getAttribute("data-original"),
        image?.getAttribute("data-original-src"),
        image?.getAttribute("data-media-src"),
        originalLink?.href
    ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        const url = isDiscordAttachmentUrl(candidate);
        if (url) return url;
    }

    return null;
}

function imageMenu(url: string, actions: ImageMenuActions) {
    const MenuComponent = (Menu as any)?.Menu;
    const MenuItem = (Menu as any)?.MenuItem;
    if (!MenuComponent || !MenuItem) throw new Error("Discord image menu components are unavailable");

    return React.createElement(
        MenuComponent,
        {
            navId: "dm-image-context-safe",
            onClose: ContextMenuApi.closeContextMenu,
            "aria-label": "Image actions"
        },
        React.createElement(MenuItem, {
            id: "dm-copy-image",
            label: "Copy Image",
            action: () => void actions.copyImage(url)
        }),
        React.createElement(MenuItem, {
            id: "dm-copy-image-link",
            label: "Copy Image Link",
            action: () => void copyToClipboard(url)
        }),
        React.createElement(MenuItem, {
            id: "dm-save-image",
            label: "Save Image As...",
            action: () => void actions.saveImage(url)
        })
    );
}

async function copyImage(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);

    let imageData = await response.blob();
    if (!imageData || imageData.size === 0) throw new Error("Image response was empty");

    if (imageData.type !== "image/png") {
        const bitmap = await createImageBitmap(imageData);
        try {
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas context unavailable");
            context.drawImage(bitmap, 0, 0);
            imageData = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(data => data ? resolve(data) : reject(new Error("PNG conversion failed")), "image/png");
            });
        } finally {
            bitmap.close();
        }
    }

    // Prefer Discord/Vesktop's native bridge so the result is a real image
    // on the OS clipboard, not merely a copied URL.
    const nativeClipboards = [
        (globalThis as any).VesktopNative?.clipboard,
        (globalThis as any).DiscordNative?.clipboard
    ];
    for (const nativeClipboard of nativeClipboards) {
        if (typeof nativeClipboard?.copyImage !== "function") continue;
        await nativeClipboard.copyImage(await imageData.arrayBuffer(), url);
        return;
    }

    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": imageData })]);
        return;
    }

    throw new Error("No image clipboard bridge is available");
}

async function saveImage(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    const data = await response.blob();
    const name = new URL(url).pathname.split("/").pop() || "discord-image";
    saveFile(new File([data], name, { type: data.type }));
}

export default definePlugin({
    name: "DMImageContext",
    description: "Restores a safe native-style Copy Image menu for Discord attachments without replacing message menus.",
    tags: ["Utility"],
    authors: [Devs.Ven],
    hidden: true,
    required: true,

    start() {
        if (imageContextMenuHandler) {
            window.removeEventListener("contextmenu", imageContextMenuHandler, true);
        }

        const actions: ImageMenuActions = {
            copyImage: async url => {
                try {
                    await copyImage(url);
                } catch (error) {
                    console.error("[Discordmaxxer] Copy Image failed", error);
                    // A URL fallback is safer than crashing or swallowing the
                    // user's action when a platform clipboard bridge is absent.
                    await copyToClipboard(url).catch(fallbackError => {
                        console.error("[Discordmaxxer] Copy Image link fallback failed", fallbackError);
                    });
                }
            },
            saveImage: async url => {
                try {
                    await saveImage(url);
                } catch (error) {
                    console.error("[Discordmaxxer] Save Image failed", error);
                }
            }
        };

        imageContextMenuHandler = event => {
            const url = attachmentUrlFromTarget(event.target);
            if (!url) return;

            // Capture before Discord's own window handler. This event is only
            // claimed for attachment images; message replies and reactions
            // continue through Discord's native route unchanged.
            event.preventDefault();
            event.stopImmediatePropagation();
            try {
                ContextMenuApi.openContextMenu(event as any, () => imageMenu(url, actions));
            } catch (error) {
                console.error("[Discordmaxxer] safe image menu failed to open", error);
            }
        };

        window.addEventListener("contextmenu", imageContextMenuHandler, true);
    },

    stop() {
        if (!imageContextMenuHandler) return;
        window.removeEventListener("contextmenu", imageContextMenuHandler, true);
        imageContextMenuHandler = null;
    }
});

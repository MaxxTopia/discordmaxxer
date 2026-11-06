/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Discordmaxxer — visible status surface for renderer-owned messages
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Toasts } from "@vencord/types/webpack/common";

const STATUS_TOAST_ID = "discordmaxxer-visible-status-toast";

let statusToast: HTMLDivElement | null = null;
let statusToastTimer: number | null = null;

function hideStatusToast(): void {
    if (statusToastTimer !== null) {
        window.clearTimeout(statusToastTimer);
        statusToastTimer = null;
    }
    statusToast?.remove();
    statusToast = null;
}

/**
 * Keep Discordmaxxer-owned status messages readable even when Discord's
 * internal toast surface is reduced to an empty marker by a theme/layout.
 * This intentionally shares the same DOM id and visual contract as the
 * user-plugin helper in plugins/_dm-shared/statusToast.ts.
 */
export function showDiscordmaxxerStatusToast(message: string, type: any = Toasts.Type.MESSAGE, duration = 3200): void {
    if (typeof document === "undefined") return;
    const mount = document.body ?? document.documentElement;
    if (!mount) return;

    if (statusToastTimer !== null) {
        window.clearTimeout(statusToastTimer);
        statusToastTimer = null;
    }

    if (!statusToast || !statusToast.isConnected) {
        statusToast = document.getElementById(STATUS_TOAST_ID) as HTMLDivElement | null;
    }
    if (!statusToast || !statusToast.isConnected) {
        statusToast = document.createElement("div");
        statusToast.id = STATUS_TOAST_ID;
        statusToast.setAttribute("role", "status");
        statusToast.setAttribute("aria-live", "polite");
        statusToast.style.position = "fixed";
        statusToast.style.top = "24px";
        statusToast.style.right = "24px";
        statusToast.style.zIndex = "100000";
        statusToast.style.maxWidth = "min(440px, calc(100vw - 48px))";
        statusToast.style.padding = "12px 16px";
        statusToast.style.border = "1px solid rgba(255, 255, 255, 0.16)";
        statusToast.style.borderRadius = "10px";
        statusToast.style.boxSizing = "border-box";
        statusToast.style.color = "#fff";
        statusToast.style.fontFamily = "var(--font-primary, sans-serif)";
        statusToast.style.fontSize = "14px";
        statusToast.style.fontWeight = "600";
        statusToast.style.lineHeight = "1.35";
        statusToast.style.letterSpacing = "0.01em";
        statusToast.style.boxShadow = "0 10px 28px rgba(0, 0, 0, 0.38)";
        statusToast.style.pointerEvents = "none";
        statusToast.style.opacity = "0";
        statusToast.style.transform = "translateY(-8px)";
        statusToast.style.transition = "opacity 160ms ease, transform 160ms ease";
        mount.appendChild(statusToast);
    }

    const failure = type === Toasts.Type.FAILURE;
    const success = type === Toasts.Type.SUCCESS;
    statusToast.textContent = message;
    statusToast.style.background = failure
        ? "linear-gradient(135deg, #8e2632, #5b1824)"
        : success
          ? "linear-gradient(135deg, #237a58, #14513d)"
          : "linear-gradient(135deg, #4b3c8f, #29234f)";
    statusToast.style.borderColor = failure
        ? "rgba(255, 130, 143, 0.7)"
        : success
          ? "rgba(111, 255, 194, 0.55)"
          : "rgba(190, 176, 255, 0.55)";
    statusToast.style.opacity = "1";
    statusToast.style.transform = "translateY(0)";

    statusToastTimer = window.setTimeout(
        () => {
            if (!statusToast) return;
            statusToast.style.opacity = "0";
            statusToast.style.transform = "translateY(-8px)";
            statusToastTimer = window.setTimeout(hideStatusToast, 180);
        },
        Math.max(800, duration)
    );
}

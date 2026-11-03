import { Toasts } from "@webpack/common";

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
 * Render a Discordmaxxer-owned status message.
 *
 * Discord's native toast surface can be reduced to an empty grey marker by
 * some Discord themes/layouts. This small shared surface is intentionally
 * independent of that internal DOM, so actions such as widget skin updates
 * and Tournament Mode changes remain readable.
 */
export function showDiscordmaxxerStatusToast(message: string, type: any, duration = 3200): void {
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

    statusToastTimer = window.setTimeout(() => {
        if (!statusToast) return;
        statusToast.style.opacity = "0";
        statusToast.style.transform = "translateY(-8px)";
        statusToastTimer = window.setTimeout(hideStatusToast, 180);
    }, duration);
}

export function hideDiscordmaxxerStatusToast(): void {
    hideStatusToast();
}

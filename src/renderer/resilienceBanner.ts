/*
 * Discordmaxxer — resilience banner (renderer side of the failover system)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Reads the same-launch resilience state from the main process (the known-issue
 * banner the worker pushed + whether this build is below min_supported_version /
 * force_update) and, if there's something to say, surfaces it as a Vencord
 * notice bar at the top of the client. This is the last leg of "recover every
 * client without a new release": a pushed banner / forced-update reaches users
 * on their next launch.
 *
 * IRON RULE (same as the main side): FAIL-OPEN. Every path swallows its own
 * errors — the safety layer must never be able to break the client.
 */

const RELEASES_FALLBACK = "https://github.com/MaxxTopia/discordmaxxer/releases/latest";

/** Resolve once Vencord's Notices API is live (it boots async), or give up. */
function waitForNotices(): Promise<any> {
    return new Promise(resolve => {
        let tries = 0;
        const iv = setInterval(() => {
            const notices = (Vencord as any)?.Api?.Notices;
            if (notices?.showNotice || ++tries > 40) {
                clearInterval(iv);
                resolve(notices?.showNotice ? notices : null);
            }
        }, 500);
    });
}

async function showResilienceNotice() {
    try {
        const state = await VesktopNative.resilience.getState();
        if (!state) return;

        const forced = state.forceUpdate === true;
        const level = state.banner?.level ?? "none";
        const text = String(state.banner?.text ?? "").trim();
        const hasBanner = level !== "none" && text.length > 0;
        if (!forced && !hasBanner) return;

        const message = forced
            ? text ||
              "A required Discordmaxxer update is available — please update to keep voice and features working."
            : text;
        const url = state.updateUrl || state.banner?.url || RELEASES_FALLBACK;

        const Notices = await waitForNotices();
        if (!Notices) {
            console.warn("[Discordmaxxer] resilience (no Notices API):", message, url);
            return;
        }
        Notices.showNotice(message, forced ? "Update now" : url ? "Details" : "OK", () => {
            try {
                Notices.popNotice?.();
            } catch {
                /* ignore */
            }
            if (url) {
                try {
                    window.open(url, "_blank");
                } catch {
                    /* ignore */
                }
            }
        });
    } catch (e) {
        console.warn("[Discordmaxxer] resilience banner failed (ignored):", e);
    }
}

// Defer so Vencord + Discord have booted before we poke the Notices API.
setTimeout(() => void showResilienceNotice(), 4000);

/*
 * Discordmaxxer — DiscordmaxxerPrivacy plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One-shot privacy preset: on first launch (per local applied flag), prompts
 * the user to disable Discord's data-collection toggles. If consented,
 * PATCHes /users/@me/settings to flip the analytics + game-detection +
 * personalization flags off, then never asks again.
 *
 * Anti-self-bot rule: applied ONCE per user-clicked consent. We never
 * re-PATCH on subsequent launches, even if the user has since re-enabled
 * the flags via Discord's UI. The bright line vs. self-botting.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Alerts, RestAPI, Toasts } from "@webpack/common";

let promptTimer: ReturnType<typeof setTimeout> | null = null;

// Discord's user-settings privacy flags. ONLY the two that map to what the
// consent dialog promises and are unambiguously privacy-hardening. (The old
// body also set allow_activity_party_privacy_* = true, which ENABLES activity
// visibility — the opposite of privacy — and friend_source_flags:{all:true},
// which is maximally permissive. Both removed: a privacy preset must not flip
// settings the wrong way or touch things it doesn't advertise.)
const PRIVACY_PATCH_BODY = {
    detect_platform_accounts: false,         // Auto-detect installed games
    contact_sync_enabled: false              // Phone contact sync
};

// Analytics + personalization live on the CONSENT endpoint, not user settings.
// The previous body never sent these, so the dialog's promise to disable
// "analytics / personalization" was unfulfilled. Revoke them here.
const CONSENT_REVOKE = ["usage_statistics", "personalization"];

async function applyPrivacyPreset(): Promise<{ ok: boolean; err?: string }> {
    const errs: string[] = [];
    // 1) User settings — installed-game detection + contact sync off.
    try {
        await RestAPI.patch({ url: "/users/@me/settings", body: PRIVACY_PATCH_BODY });
    } catch (e: any) {
        errs.push(`settings: ${e?.message ?? e}`);
    }
    // 2) Consent — revoke analytics (usage_statistics) + personalization.
    try {
        await RestAPI.post({
            url: "/users/@me/consent",
            body: { grant: [], revoke: CONSENT_REVOKE }
        });
    } catch (e: any) {
        errs.push(`consent: ${e?.message ?? e}`);
    }
    return errs.length ? { ok: false, err: errs.join("; ") } : { ok: true };
}

const settings = definePluginSettings({
    applied: {
        type: OptionType.BOOLEAN,
        description:
            "Internal: tracks whether the privacy preset has been offered to this user. " +
            "Set this back to false (and disable+enable the plugin) to re-prompt.",
        default: false
    },
    showOnNextLaunch: {
        type: OptionType.BOOLEAN,
        description: "Force-show the prompt on next launch (overrides the 'applied' flag).",
        default: false
    }
});

function showConsentPrompt() {
    Alerts.show({
        title: "Discordmaxxer — Privacy Preset",
        body:
            "Discord collects data on your usage by default: analytics, installed-game " +
            "detection, contact sync, personalization. None of this is required for the app " +
            "to work — it only feeds Discord's recommendations.\n\n" +
            "Click \"Apply\" to disable these toggles in one shot. You can re-enable any of " +
            "them later via Discord → Settings → Privacy & Safety.",
        confirmText: "Apply Privacy Preset",
        cancelText: "Skip",
        onConfirm: async () => {
            const r = await applyPrivacyPreset();
            settings.store.applied = true;
            settings.store.showOnNextLaunch = false;
            Toasts.show({
                message: r.ok ? "✅ Privacy preset applied to your Discord settings." : `Failed to apply: ${r.err}`,
                type: r.ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE,
                id: Toasts.genId(),
                options: { duration: 4000, position: Toasts.Position.TOP }
            });
        },
        onCancel: () => {
            settings.store.applied = true;
            settings.store.showOnNextLaunch = false;
            Toasts.show({
                message: "Skipped. You can re-prompt anytime from this plugin's settings.",
                type: Toasts.Type.MESSAGE,
                id: Toasts.genId(),
                options: { duration: 3000, position: Toasts.Position.TOP }
            });
        }
    });
}

export default definePlugin({
    name: "DMPrivacy",
    description:
        "First-launch consent prompt to disable Discord's data-collection toggles (analytics, game detection, contact sync, personalization). One-shot: PATCHes once on user click, never re-asserts. Fire it again from settings if you want to re-prompt.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        // Defer until app fully loaded — RestAPI / UserStore not available immediately
        promptTimer = setTimeout(() => {
            promptTimer = null;
            if (!settings.store.applied || settings.store.showOnNextLaunch) {
                showConsentPrompt();
            }
        }, 8000);
    },

    stop() {
        // Clear the deferred prompt so it can't fire (and PATCH account settings)
        // after the plugin was disabled within the 8s window.
        if (promptTimer) {
            clearTimeout(promptTimer);
            promptTimer = null;
        }
    }
});

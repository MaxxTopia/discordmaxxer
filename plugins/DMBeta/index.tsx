/*
 * Discordmaxxer — DiscordmaxxerBeta plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * MAXXER++ tier perk — beta-builds opt-in. Toggles electron-updater's
 * `allowPrerelease` flag so the auto-updater accepts GitHub prerelease
 * tags (vX.Y.Z-beta.N) in addition to stable. Diggy publishes betas by
 * marking releases as "Pre-release" in GitHub; users on this channel
 * see them, stable users don't.
 *
 * The toggle persists across launches via Vesktop's State.store
 * (allowPrerelease key — see src/shared/settings.d.ts) and re-applies
 * on app startup in src/main/updater.ts.
 *
 * Tier gate: MAXXER++ at runtime. Plugin loads for everyone but the UI
 * surfaces the gate inline when a non-MAXXER++ user opens the panel.
 */

import { definePluginSettings } from "@api/Settings";
import { Toasts } from "@webpack/common";
import { React } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

import { hasTier, Tier, tierGateMessage } from "../_dm-shared/vip";

const VIP_GATE = Tier.MAXXER_PLUS_PLUS;

declare global {
    interface Window {
        VesktopNative: {
            beta?: {
                getAllowPrerelease: () => Promise<boolean>;
                setAllowPrerelease: (on: boolean) => Promise<void>;
            };
        };
    }
}

function BetaPanel() {
    const [enabled, setEnabled] = React.useState<boolean>(false);
    const [loaded, setLoaded] = React.useState<boolean>(false);
    const allowed = hasTier(VIP_GATE);

    React.useEffect(() => {
        let alive = true;
        window.VesktopNative?.beta?.getAllowPrerelease()
            .then(v => { if (alive) { setEnabled(!!v); setLoaded(true); } })
            .catch(() => { if (alive) setLoaded(true); });
        return () => { alive = false; };
    }, []);

    const onToggle = async () => {
        if (!allowed) {
            Toasts.show({
                message: `🔒 ${tierGateMessage(VIP_GATE)}`,
                id: Toasts.genId(),
                type: Toasts.Type.MESSAGE,
                options: { duration: 4000 }
            });
            return;
        }
        const next = !enabled;
        setEnabled(next);
        try {
            await window.VesktopNative?.beta?.setAllowPrerelease(next);
            Toasts.show({
                message: next
                    ? "✅ Beta channel enabled — the next published -beta.N build can auto-update."
                    : "Stable channel restored.",
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS,
                options: { duration: 4000 }
            });
        } catch (e) {
            console.error("[DiscordmaxxerBeta] setAllowPrerelease failed:", e);
            setEnabled(!next); // revert
            Toasts.show({
                message: "Failed to switch update channel — check console.",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                options: { duration: 4000 }
            });
        }
    };

    if (!loaded) return null;

    const trackColor = enabled ? "#FFAA00" : "rgba(255,255,255,0.18)";
    const knobX = enabled ? 22 : 2;

    return (
        <div style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "10px 12px",
            borderRadius: "6px",
            border: `1px solid ${allowed ? "rgba(255,170,0,0.35)" : "rgba(255,255,255,0.10)"}`,
            background: allowed
                ? "linear-gradient(90deg, rgba(255,170,0,0.06), transparent)"
                : "rgba(0,0,0,0.10)",
            opacity: allowed ? 1 : 0.65
        }}>
            <button
                onClick={onToggle}
                aria-label="Toggle beta channel"
                style={{
                    position: "relative",
                    width: "44px",
                    height: "22px",
                    borderRadius: "11px",
                    border: "none",
                    background: trackColor,
                    cursor: allowed ? "pointer" : "not-allowed",
                    flexShrink: 0,
                    padding: 0,
                    transition: "background 0.15s ease"
                }}
            >
                <span style={{
                    position: "absolute",
                    top: "2px",
                    left: `${knobX}px`,
                    width: "18px",
                    height: "18px",
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left 0.15s ease",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.4)"
                }} />
            </button>
            <div style={{ flex: 1 }}>
                <div style={{ fontSize: "13px", fontWeight: 600, color: allowed ? "#FFD27A" : "#9aa1ad" }}>
                    Beta channel {allowed ? "" : "🔒 (MAXXER++ required)"}
                </div>
                <div style={{ fontSize: "11.5px", color: "#a0a6b4", marginTop: "2px", lineHeight: 1.4 }}>
                    {allowed
                        ? "Auto-update from GitHub pre-releases (vX.Y.Z-beta.N). Get features earlier; expect bugs."
                        : "Upgrade to MAXXER++ to opt into early features at https://maxxtopia.com/discordmaxxer/vip"}
                </div>
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        description: "",
        component: BetaPanel
    }
});

export default definePlugin({
    name: "DMBeta",
    description:
        "MAXXER++ perk — opt into separately published GitHub pre-release builds such as 0.7.91-beta.1. This does not turn your current stable build into a beta; it only changes which published updater releases you can receive.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() { /* purely UI — no DOM or event subscriptions */ },
    stop() {}
});

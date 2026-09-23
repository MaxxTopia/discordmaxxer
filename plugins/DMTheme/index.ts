/*
 * Discordmaxxer — DiscordmaxxerTheme plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Multi-theme system. Eight named palettes covering Discord's full
 * CSS-variable graph (brand, background, text, header, channels,
 * interactive, scrollbar). Switch via the `selected` setting.
 *
 * Free themes:
 *   - maxxer (default): magenta + cobalt
 *   - val: Valorant red + cream
 *   - sonic: gold + cobalt
 *   - dmc: blood red + bone (gothic, serif headings)
 *   - bo3: Black Ops 3 olive + neon orange
 *
 * MAXXER+ exclusives (v0.6.4):
 *   - akatsuki: bone + blood + void, red-cloud Akatsuki organization vibe
 *   - dmcdt: DMC: Devil Trigger — Dante's coat red + Sparda blue, devil-trigger pulse
 *   - eminence: slime magenta + atomic-blue lightning, "I am Shadow" theatrical
 *
 * Off by default — opt-in via plugin toggle.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import { React, Toasts } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

import { DEFAULT_THEME, THEME_ORDER, themeCss, themeFlairCss, THEMES, ThemeId } from "../_dm-shared/themes";
import { hasTier, TIER_LABELS } from "../_dm-shared/vip";

let style: HTMLStyleElement;
let flairStyle: HTMLStyleElement;
let appliedBodyClass: string | null = null;

function applyTheme(id: ThemeId) {
    let theme = THEMES[id] ?? THEMES[DEFAULT_THEME];

    // Tier gate — if the chosen theme requires a tier the user doesn't
    // hold, fall back to the default theme and surface a toast. We never
    // silently apply a different theme without telling the user.
    if (theme.tierGate !== undefined && !hasTier(theme.tierGate)) {
        const required = TIER_LABELS[theme.tierGate];
        console.warn(`[DiscordmaxxerTheme] theme="${id}" requires ${required} — falling back to ${DEFAULT_THEME}`);
        try {
            Toasts.show({
                message: `🔒 "${theme.label}" requires ${required} — using ${THEMES[DEFAULT_THEME].label} instead`,
                id: Toasts.genId(),
                type: Toasts.Type.MESSAGE,
                options: { duration: 4000 }
            });
        } catch { /* toast may not be ready during start() */ }
        theme = THEMES[DEFAULT_THEME];
    }

    if (style) style.textContent = themeCss(theme);
    if (flairStyle) flairStyle.textContent = settings.store.enableFlair === false ? "" : themeFlairCss(theme);

    // Body-class swap so per-theme component overrides can scope cleanly
    if (appliedBodyClass) document.body.classList.remove(appliedBodyClass);
    document.body.classList.add(theme.bodyClass);
    appliedBodyClass = theme.bodyClass;

    console.log(`[DiscordmaxxerTheme] applied theme=${theme.id} flair=${settings.store.enableFlair !== false}`);
}

function optionLabel(id: ThemeId): string {
    const t = THEMES[id];
    if (t.tierGate !== undefined) {
        const tierStr = TIER_LABELS[t.tierGate];
        return `🔒 ${t.label} (${tierStr}) — ${t.blurb}`;
    }
    return `${t.label} — ${t.blurb}`;
}

/**
 * A visual companion to the legacy select. Theme names are useful for
 * keyboard users, but a swatch + one-line preview makes the choice obvious
 * without requiring anyone to understand a palette registry.
 */
function ThemePicker() {
    const selected = settings.store.selected as ThemeId;
    const cards = THEME_ORDER.map(id => {
        const theme = THEMES[id];
        const locked = theme.tierGate !== undefined && !hasTier(theme.tierGate);
        const isSelected = selected === id && !locked;

        return React.createElement(
            "button",
            {
                key: id,
                type: "button",
                disabled: locked,
                "aria-pressed": isSelected,
                "aria-label": `${theme.label}${locked ? " locked" : ""}: ${theme.blurb}`,
                title: locked ? `${theme.label} requires ${TIER_LABELS[theme.tierGate!]}` : `Use ${theme.label}`,
                onClick: () => {
                    if (locked) return;
                    settings.store.selected = id;
                    applyTheme(id);
                },
                style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    minHeight: 70,
                    padding: "8px 9px",
                    textAlign: "left",
                    borderRadius: 8,
                    border: `1px solid ${isSelected ? theme.swatch.primary : "rgba(255,255,255,0.14)"}`,
                    boxShadow: isSelected ? `0 0 0 2px ${theme.swatch.primary}33` : "none",
                    background: "rgba(0,0,0,0.22)",
                    color: "#fbefff",
                    cursor: locked ? "not-allowed" : "pointer",
                    opacity: locked ? 0.58 : 1,
                    transition: "border-color 120ms ease, box-shadow 120ms ease"
                }
            },
            React.createElement("span", {
                style: {
                    display: "block",
                    height: 22,
                    borderRadius: 5,
                    background: `linear-gradient(135deg, ${theme.swatch.primary}, ${theme.swatch.secondary})`,
                    boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.18)`
                }
            }),
            React.createElement(
                "span",
                { style: { fontSize: 12, fontWeight: 700, lineHeight: 1.1 } },
                `${locked ? "🔒 " : isSelected ? "✓ " : ""}${theme.label}`
            ),
            React.createElement(
                "span",
                { style: { fontSize: 10.5, color: "#cbd0e0", lineHeight: 1.25 } },
                locked ? `${TIER_LABELS[theme.tierGate!]} required` : theme.blurb
            )
        );
    });

    return React.createElement(
        "div",
        {
            style: {
                marginTop: 10,
                padding: "11px 12px",
                borderRadius: 9,
                background: "linear-gradient(135deg, rgba(226,91,255,0.08), rgba(76,81,247,0.08))",
                border: "1px solid rgba(226,91,255,0.25)"
            }
        },
        React.createElement(
            "div",
            { style: { fontSize: 13, fontWeight: 700, color: "#fbefff", marginBottom: 3 } },
            "🎨 Pick a theme by look"
        ),
        React.createElement(
            "div",
            { style: { fontSize: 11.5, color: "#cbd0e0", opacity: 0.88, lineHeight: 1.45, marginBottom: 8 } },
            "Click a swatch to apply it instantly. The full color palette and optional theme flair update together."
        ),
        React.createElement(
            "div",
            {
                style: {
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 7
                }
            },
            cards
        )
    );
}

const settings = definePluginSettings({
    picker: {
        type: OptionType.COMPONENT,
        description: "",
        component: ThemePicker
    },
    selected: {
        type: OptionType.SELECT,
        description: "Keyboard-friendly theme selector. The visual picker above is the easiest way to choose; both controls stay in sync.",
        default: DEFAULT_THEME,
        options: THEME_ORDER.map(id => ({
            label: optionLabel(id),
            value: id,
            default: id === DEFAULT_THEME
        })),
        onChange: (value: ThemeId) => applyTheme(value)
    },
    enableFlair: {
        type: OptionType.BOOLEAN,
        description: "Enable theme character — layout (corners, density), custom typing dots, mention animations, hover effects. Turn off to keep colors only.",
        default: true,
        onChange: () => applyTheme(settings.store.selected as ThemeId)
    }
});

export default definePlugin({
    name: "DMTheme",
    description:
        "Eight-theme system. Free: Maxxer (magenta+cobalt), Val (Valorant), Sonic (gold+cobalt), DMC (gothic), BO3 (military). MAXXER+ exclusives: Akatsuki (bone+blood+void), DMC: Devil Trigger (Dante red + Sparda blue + DT pulse), Eminence in Shadow (slime+atomic-lightning). Each overrides Discord's full color graph + adds personality flair (typing dots, mention animations, hover effects).",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-theme", managedStyleRootNode);
        flairStyle = createAndAppendStyle("dm-theme-flair", managedStyleRootNode);
        applyTheme(settings.store.selected as ThemeId);
    },

    stop() {
        style?.remove();
        flairStyle?.remove();
        if (appliedBodyClass) {
            document.body.classList.remove(appliedBodyClass);
            appliedBodyClass = null;
        }
    }
});

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

function ThemePicker() {
    const initial = settings.store.selected as ThemeId;
    const [selected, setSelected] = React.useState<ThemeId>(THEMES[initial] ? initial : DEFAULT_THEME);
    const theme = THEMES[selected] ?? THEMES[DEFAULT_THEME];

    function choose(value: ThemeId) {
        setSelected(value);
        settings.store.selected = value;
        applyTheme(value);
    }

    return (
        <div style={{
            border: "1px solid var(--background-modifier-accent)",
            borderRadius: "8px",
            padding: "12px",
            background: "var(--background-secondary-alt)",
            marginBottom: "12px"
        }}>
            <div style={{ fontSize: "14px", fontWeight: 700, marginBottom: "6px" }}>Choose your theme</div>
            <div style={{ color: "var(--text-muted)", fontSize: "12px", lineHeight: 1.45, marginBottom: "10px" }}>
                The native selector below is deliberately simple and reliable. Pick a palette, then use the swatches and description to confirm what it looks like.
            </div>
            <select
                aria-label="Discordmaxxer theme"
                value={selected}
                onChange={event => choose(event.currentTarget.value as ThemeId)}
                style={{
                    width: "100%",
                    boxSizing: "border-box",
                    borderRadius: "5px",
                    border: "1px solid var(--background-modifier-accent)",
                    background: "var(--background-tertiary)",
                    color: "var(--text-normal)",
                    padding: "9px 10px",
                    fontSize: "13px",
                    cursor: "pointer"
                }}
            >
                {THEME_ORDER.map(id => {
                    const item = THEMES[id];
                    const gate = item.tierGate === undefined ? "FREE" : TIER_LABELS[item.tierGate];
                    return <option key={id} value={id}>{`${item.label} · ${gate}`}</option>;
                })}
            </select>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "10px" }}>
                <span style={{ width: "18px", height: "18px", borderRadius: "4px", background: theme.swatch.primary, boxShadow: `0 0 0 1px ${theme.swatch.primary}` }} />
                <span style={{ width: "18px", height: "18px", borderRadius: "4px", background: theme.swatch.secondary, boxShadow: `0 0 0 1px ${theme.swatch.secondary}` }} />
                <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>{theme.blurb}</span>
            </div>
            {theme.tierGate !== undefined && (
                <div style={{ color: "#ffcc66", fontSize: "12px", marginTop: "8px" }}>
                    {TIER_LABELS[theme.tierGate]} required. If your tier is lower, Discordmaxxer safely uses the default palette.
                </div>
            )}
        </div>
    );
}

const settings = definePluginSettings({
    themePicker: {
        type: OptionType.COMPONENT,
        description: "",
        component: ThemePicker
    },
    selected: {
        type: OptionType.SELECT,
        description: "Stored theme value used by Discordmaxxer. Use the picker above.",
        default: DEFAULT_THEME,
        hidden: true,
        options: THEME_ORDER.map(id => ({
            label: THEMES[id].label,
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

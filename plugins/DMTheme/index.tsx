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
import { React, showToast, Toasts } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

import {
    DEFAULT_THEME,
    THEME_ORDER,
    THEME_SOURCE_OPTIONS,
    THEME_VISIBILITY_OPTIONS,
    themeCss,
    themeFlairCss,
    themeVisibilityCss,
    THEMES,
    ThemeId,
    ThemeSource,
    ThemeVisibility
} from "../_dm-shared/themes";
import { hasTier, TIER_LABELS } from "../_dm-shared/vip";

let style: HTMLStyleElement;
let flairStyle: HTMLStyleElement;
let appliedBodyClass: string | null = null;
let tournamentHandler: (() => void) | null = null;

function isThemeVisibility(value: unknown): value is ThemeVisibility {
    return THEME_VISIBILITY_OPTIONS.some(option => option.value === value);
}

function isThemeSource(value: unknown): value is ThemeSource {
    return THEME_SOURCE_OPTIONS.some(option => option.value === value);
}

function isTournamentMinimalVisualsActive(): boolean {
    return document.documentElement?.hasAttribute("data-dm-tournament-minimal") === true;
}

function renderThemeFlair(theme: typeof THEMES[ThemeId], visibility: ThemeVisibility): void {
    if (!flairStyle) return;
    const enabled = settings.store.enableFlair !== false && !isTournamentMinimalVisualsActive();
    flairStyle.textContent = enabled ? themeFlairCss(theme, visibility) : "";
}

function themeIsAvailable(id: ThemeId): boolean {
    const theme = THEMES[id];
    return !!theme && (theme.tierGate === undefined || hasTier(theme.tierGate));
}

function showThemeToast(message: string, type: any = Toasts.Type.MESSAGE, duration = 4000): void {
    try {
        showToast(message, type, { duration });
    } catch (error) {
        console.warn("[DiscordmaxxerTheme] status toast failed:", error);
        try {
            Toasts.show({ message, id: Toasts.genId(), type, options: { duration } });
        } catch (fallbackError) {
            console.warn("[DiscordmaxxerTheme] legacy status toast fallback failed:", fallbackError);
        }
    }
}

function applyTheme(id: ThemeId): ThemeId {
    const source = isThemeSource(settings.store.source) ? settings.store.source : "discordmaxxer";
    const visibility = isThemeVisibility(settings.store.visibility) ? settings.store.visibility : "balanced";

    if (source === "external") {
        if (style) style.textContent = themeVisibilityCss(visibility);
        if (flairStyle) flairStyle.textContent = "";
        if (appliedBodyClass) {
            document.body.classList.remove(appliedBodyClass);
            appliedBodyClass = null;
        }
        console.log(`[DiscordmaxxerTheme] applied external theme visibility=${visibility}`);
        return settings.store.selected as ThemeId;
    }

    let theme = THEMES[id] ?? THEMES[DEFAULT_THEME];

    // Tier gate — if the chosen theme requires a tier the user doesn't
    // hold, fall back to the default theme and surface a toast. We never
    // silently apply a different theme without telling the user.
    if (theme.tierGate !== undefined && !hasTier(theme.tierGate)) {
        const required = TIER_LABELS[theme.tierGate];
        console.warn(`[DiscordmaxxerTheme] theme="${id}" requires ${required} — falling back to ${DEFAULT_THEME}`);
        try {
            showThemeToast(`🔒 "${theme.label}" requires ${required} — using ${THEMES[DEFAULT_THEME].label} instead`);
        } catch { /* toast may not be ready during start() */ }
        theme = THEMES[DEFAULT_THEME];
    }

    if (settings.store.selected !== theme.id) settings.store.selected = theme.id;

    if (style) style.textContent = themeCss(theme, visibility);
    renderThemeFlair(theme, visibility);

    // Body-class swap so per-theme component overrides can scope cleanly
    if (appliedBodyClass) document.body.classList.remove(appliedBodyClass);
    document.body.classList.add(theme.bodyClass);
    appliedBodyClass = theme.bodyClass;

    console.log(`[DiscordmaxxerTheme] applied theme=${theme.id} source=${source} visibility=${visibility} flair=${settings.store.enableFlair !== false && !isTournamentMinimalVisualsActive()}`);
    return theme.id;
}

function ThemePicker() {
    const initial = settings.store.selected as ThemeId;
    const [selected, setSelected] = React.useState<ThemeId>(themeIsAvailable(initial) ? initial : DEFAULT_THEME);
    const initialSource = isThemeSource(settings.store.source) ? settings.store.source : "discordmaxxer";
    const [source, setSource] = React.useState<ThemeSource>(initialSource);
    const initialVisibility = isThemeVisibility(settings.store.visibility) ? settings.store.visibility : "balanced";
    const [visibility, setVisibility] = React.useState<ThemeVisibility>(initialVisibility);
    const theme = THEMES[selected] ?? THEMES[DEFAULT_THEME];

    function choose(value: ThemeId) {
        const next = THEMES[value];
        if (!next || !themeIsAvailable(value)) {
            const required = next?.tierGate === undefined ? "a paid tier" : TIER_LABELS[next.tierGate];
            showThemeToast(`🔒 "${next?.label ?? value}" is locked — ${required} is required.`);
            const current = settings.store.selected as ThemeId;
            setSelected(themeIsAvailable(current) ? current : DEFAULT_THEME);
            return;
        }
        settings.store.source = "discordmaxxer";
        setSource("discordmaxxer");
        const applied = applyTheme(value);
        setSelected(applied);
    }

    function chooseSource(value: ThemeSource) {
        settings.store.source = value;
        setSource(value);
        applyTheme(selected);
    }

    function chooseVisibility(value: ThemeVisibility) {
        settings.store.visibility = value;
        setVisibility(value);
        applyTheme(selected);
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
                Five palettes are free. The three MAXXER+ palettes are shown for discovery and stay visibly locked until the tier is active.
            </div>
            <div style={{
                border: "1px solid var(--background-modifier-accent)",
                borderRadius: "8px",
                padding: "10px",
                marginBottom: "10px",
                background: "var(--background-tertiary)"
            }}>
                <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "3px" }}>Appearance source</div>
                <div style={{ color: "var(--text-muted)", fontSize: "11px", lineHeight: 1.4, marginBottom: "8px" }}>
                    Keep your current BetterDiscord/local theme, or use a Discordmaxxer palette. External mode never replaces your theme artwork or colors.
                </div>
                <div role="radiogroup" aria-label="Theme appearance source" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
                    {THEME_SOURCE_OPTIONS.map(option => {
                        const active = source === option.value;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => chooseSource(option.value)}
                                style={{
                                    minHeight: "62px",
                                    padding: "8px",
                                    textAlign: "left",
                                    borderRadius: "6px",
                                    border: `1px solid ${active ? "var(--brand-experiment)" : "var(--background-modifier-accent)"}`,
                                    background: active ? "var(--background-modifier-selected)" : "var(--background-secondary)",
                                    color: "var(--text-normal)",
                                    cursor: "pointer",
                                    boxShadow: active ? "0 0 0 1px var(--brand-experiment)" : "none"
                                }}
                            >
                                <span style={{ display: "block", fontSize: "11px", fontWeight: 700 }}>{option.label}</span>
                                <span style={{ display: "block", color: "var(--text-muted)", fontSize: "10px", lineHeight: 1.25, marginTop: "3px" }}>{option.description}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            {source === "external" && (
                <div style={{ color: "var(--text-normal)", fontSize: "11px", lineHeight: 1.4, marginBottom: "8px" }}>
                    Visibility-only mode is active. Your current external theme stays in control; Strong and Showcase affect only themes that expose compatible transparency variables.
                </div>
            )}
            <div
                role="listbox"
                aria-label="Discordmaxxer themes"
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "8px"
                }}
            >
                {THEME_ORDER.map(id => {
                    const item = THEMES[id];
                    const gate = item.tierGate === undefined ? "FREE" : TIER_LABELS[item.tierGate];
                    const locked = !themeIsAvailable(id);
                    const active = source === "discordmaxxer" && selected === id;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="option"
                            aria-selected={active}
                            aria-label={`${item.label} · ${gate}${locked ? " · locked" : ""}`}
                            aria-disabled={locked}
                            onClick={() => choose(id)}
                            style={{
                                minHeight: "86px",
                                padding: "10px",
                                textAlign: "left",
                                borderRadius: "8px",
                                border: `1px solid ${active ? item.swatch.primary : "var(--background-modifier-accent)"}`,
                                background: active
                                    ? `linear-gradient(135deg, ${item.swatch.primary}22, var(--background-tertiary) 58%)`
                                    : "var(--background-tertiary)",
                                color: "var(--text-normal)",
                                opacity: locked ? 0.62 : source === "external" ? 0.72 : 1,
                                cursor: locked ? "not-allowed" : "pointer",
                                boxShadow: active ? `0 0 0 1px ${item.swatch.primary}55, 0 0 14px ${item.swatch.primary}22` : "none",
                                transition: "border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease"
                            }}
                        >
                            <span style={{ display: "flex", gap: "5px", marginBottom: "7px" }} aria-hidden="true">
                                <span style={{ width: "28px", height: "6px", borderRadius: "999px", background: item.swatch.primary }} />
                                <span style={{ width: "18px", height: "6px", borderRadius: "999px", background: item.swatch.secondary }} />
                            </span>
                            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", fontSize: "13px", fontWeight: 700 }}>
                                <span>{item.label}</span>
                                <span style={{ color: locked ? "#ffcc66" : "var(--text-muted)", fontSize: "10px", fontWeight: 600 }}>{locked ? "🔒" : gate}</span>
                            </span>
                            <span style={{ display: "block", color: "var(--text-muted)", fontSize: "11px", lineHeight: 1.3, marginTop: "4px" }}>{item.blurb}</span>
                        </button>
                    );
                })}
            </div>
            <div style={{
                border: "1px solid var(--background-modifier-accent)",
                borderRadius: "8px",
                padding: "10px",
                marginTop: "10px",
                background: "var(--background-tertiary)"
            }}>
                <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "3px" }}>Theme visibility</div>
                <div style={{ color: "var(--text-muted)", fontSize: "11px", lineHeight: 1.4, marginBottom: "8px" }}>
                    Make dark themes and compatible local background artwork easier to see. Balanced preserves the current look; this never uses a blurry global brightness filter.
                </div>
                <div role="radiogroup" aria-label="Theme visibility" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
                    {THEME_VISIBILITY_OPTIONS.map(option => {
                        const active = visibility === option.value;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => chooseVisibility(option.value)}
                                style={{
                                    minHeight: "58px",
                                    padding: "7px",
                                    textAlign: "left",
                                    borderRadius: "6px",
                                    border: `1px solid ${active ? theme.swatch.primary : "var(--background-modifier-accent)"}`,
                                    background: active ? `linear-gradient(135deg, ${theme.swatch.primary}22, var(--background-secondary))` : "var(--background-secondary)",
                                    color: "var(--text-normal)",
                                    cursor: "pointer",
                                    boxShadow: active ? `0 0 0 1px ${theme.swatch.primary}44` : "none"
                                }}
                            >
                                <span style={{ display: "block", fontSize: "11px", fontWeight: 700 }}>{option.label}</span>
                                <span style={{ display: "block", color: "var(--text-muted)", fontSize: "10px", lineHeight: 1.25, marginTop: "3px" }}>{option.description}</span>
                            </button>
                        );
                    })}
                </div>
                <div style={{ color: "var(--text-subtle)", fontSize: "10px", lineHeight: 1.35, marginTop: "8px" }}>
                    Live mode: {THEME_VISIBILITY_OPTIONS.find(option => option.value === visibility)?.label ?? "Balanced"}{source === "external" ? " · current external theme" : ""}. Strong and Showcase also bridge common local-theme transparency variables.
                </div>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "10px" }}>
                <span style={{ width: "18px", height: "18px", borderRadius: "4px", background: theme.swatch.primary, boxShadow: `0 0 0 1px ${theme.swatch.primary}` }} />
                <span style={{ width: "18px", height: "18px", borderRadius: "4px", background: theme.swatch.secondary, boxShadow: `0 0 0 1px ${theme.swatch.secondary}` }} />
                <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>Selected: {theme.blurb}</span>
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
    source: {
        type: OptionType.SELECT,
        description: "Choose a Discordmaxxer palette or keep the current external theme and use visibility-only mode.",
        default: "discordmaxxer",
        hidden: true,
        options: THEME_SOURCE_OPTIONS.map(option => ({
            label: option.label,
            value: option.value,
            default: option.value === "discordmaxxer"
        })),
        onChange: () => applyTheme(settings.store.selected as ThemeId)
    },
    visibility: {
        type: OptionType.SELECT,
        description: "Controls theme surface contrast and compatible local-theme background overlay strength.",
        default: "balanced",
        hidden: true,
        options: THEME_VISIBILITY_OPTIONS.map(option => ({
            label: option.label,
            value: option.value,
            default: option.value === "balanced"
        })),
        onChange: () => applyTheme(settings.store.selected as ThemeId)
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
        tournamentHandler = () => {
            const selected = THEMES[settings.store.selected as ThemeId] ?? THEMES[DEFAULT_THEME];
            const visibility = isThemeVisibility(settings.store.visibility) ? settings.store.visibility : "balanced";
            renderThemeFlair(selected, visibility);
        };
        window.addEventListener("discordmaxxer:tournament-mode-changed", tournamentHandler);
        applyTheme(settings.store.selected as ThemeId);
    },

    stop() {
        if (tournamentHandler) {
            window.removeEventListener("discordmaxxer:tournament-mode-changed", tournamentHandler);
            tournamentHandler = null;
        }
        style?.remove();
        flairStyle?.remove();
        if (appliedBodyClass) {
            document.body.classList.remove(appliedBodyClass);
            appliedBodyClass = null;
        }
    }
});

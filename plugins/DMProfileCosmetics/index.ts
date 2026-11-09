/*
 * Discordmaxxer - ProfileCosmetics plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A small, presentation-only layer for Discord profile popouts. It makes the
 * action section (Edit Profile, status, Badges, and Orbs) feel like part of
 * the active Discordmaxxer theme without replacing Discord's controls.
 *
 * The plugin deliberately does not copy, re-host, or fake Discord's native
 * avatar decorations, profile effects, frames, or nameplates. It leaves those
 * nodes in place, gives them room to paint outside the shell when necessary,
 * and keeps them above our optional local effect layer.
 *
 * The local effects are CSS-only and bounded to visible profile surfaces. No
 * canvas, per-frame JavaScript, media fetch, or webpack patch is used. This is
 * important for Tournament Mode and for the normal idle cost of the client.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import { React } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

import { WIDGET_STYLE_PRESETS, type WidgetStylePreset, widgetStylePreset } from "../_dm-shared/widgetStylePresets";

type ProfileControl = "edit" | "status" | "badges" | "orbs" | "switchAccounts" | "copyUserId";
type EffectPreset = "none" | "aurora" | "emberfall" | "frost" | "neonRain" | "roseDrift" | "starlight" | "inkBloom" | "gildedDust";
type EffectIntensity = "subtle" | "balanced" | "full";
type EffectSpeed = "slow" | "standard" | "fast";
type ProfileVisualSource = "skin" | "profile" | "widget";

interface ProfileSkinPreset {
    id: string;
    name: string;
    family: "featured" | "botanical" | "cosmic" | "fantasy" | "retro" | "noir" | "cozy" | "tech";
    primary: string;
    secondary: string;
    panel: string;
    glow: string;
    blurb: string;
}

type ResolvedProfileVisual = ProfileSkinPreset & { widgetStyle?: WidgetStylePreset };

// These are original palettes and motifs rather than copied film/game assets.
// The shared DOM stays readable and stable while the surface gets a distinct
// mood. Keeping the catalog data-only also makes adding a future skin cheap.
const PROFILE_SKIN_PRESETS: readonly ProfileSkinPreset[] = [
    { id: "auroraGlass", name: "Aurora Glass", family: "featured", primary: "#61e7ff", secondary: "#b887ff", panel: "#101926", glow: "#61e7ff66", blurb: "polar light over smoked glass" },
    { id: "shadowNight", name: "Shadow Night", family: "noir", primary: "#9fb2ff", secondary: "#465b8c", panel: "#070b12", glow: "#9fb2ff66", blurb: "moonlit glass over a quiet black field" },
    { id: "obsidianGlass", name: "Obsidian Glass", family: "noir", primary: "#e4b8c7", secondary: "#dce5f3", panel: "#080b11", glow: "#e4b8c766", blurb: "soft rose light across black glass" },
    { id: "roseChapel", name: "Rose Chapel", family: "botanical", primary: "#ff789e", secondary: "#ffd1df", panel: "#26131e", glow: "#ff789e66", blurb: "velvet, roses, and candlelight" },
    { id: "snowboundSignal", name: "Snowbound Signal", family: "cosmic", primary: "#b9f4ff", secondary: "#7d9cff", panel: "#111a2d", glow: "#b9f4ff66", blurb: "winter radio under a blue moon" },
    { id: "emberCrown", name: "Ember Crown", family: "fantasy", primary: "#ff966b", secondary: "#ffc45c", panel: "#281518", glow: "#ff966b66", blurb: "warm metal and a fearless spark" },
    { id: "neonArcade", name: "Neon Arcade", family: "retro", primary: "#ff58d2", secondary: "#53f6e8", panel: "#17132a", glow: "#ff58d266", blurb: "late-night cabinet glow" },
    { id: "starlitVoyage", name: "Starlit Voyage", family: "cosmic", primary: "#9cbbff", secondary: "#72e0d0", panel: "#0c1428", glow: "#9cbbff66", blurb: "quiet constellations and orbit lines" },
    { id: "moonlitArchive", name: "Moonlit Archive", family: "noir", primary: "#c8b5ff", secondary: "#8dd9d0", panel: "#181724", glow: "#c8b5ff66", blurb: "dark academia after midnight" },
    { id: "crimsonManor", name: "Crimson Manor", family: "noir", primary: "#ff5c72", secondary: "#d9a66b", panel: "#211217", glow: "#ff5c7266", blurb: "gothic velvet with a gold key" },
    { id: "oceanOracle", name: "Ocean Oracle", family: "fantasy", primary: "#57d9e9", secondary: "#7e9dff", panel: "#0b1b26", glow: "#57d9e966", blurb: "deep water, glass, and prophecy" },
    { id: "desertMirage", name: "Desert Mirage", family: "fantasy", primary: "#ffca7a", secondary: "#ef7d69", panel: "#251a18", glow: "#ffca7a66", blurb: "sunset dunes and hidden ruins" },
    { id: "forestFable", name: "Forest Fable", family: "botanical", primary: "#aee184", secondary: "#7ed8b0", panel: "#122016", glow: "#aee18466", blurb: "storybook moss and fireflies" },
    { id: "lavenderDream", name: "Lavender Dream", family: "cozy", primary: "#d39cff", secondary: "#8fd9ff", panel: "#1c1730", glow: "#d39cff66", blurb: "soft clouds with a midnight edge" },
    { id: "cherryComet", name: "Cherry Comet", family: "cosmic", primary: "#ff78b8", secondary: "#ffcf8e", panel: "#25152a", glow: "#ff78b866", blurb: "pink starlight with a fast tail" },
    { id: "midnightVinyl", name: "Midnight Vinyl", family: "noir", primary: "#77d9ff", secondary: "#e2a7ff", panel: "#121822", glow: "#77d9ff66", blurb: "blue-hour lounge and soft reverb" },
    { id: "goldenQuest", name: "Golden Quest", family: "fantasy", primary: "#ffd36a", secondary: "#a7e4bd", panel: "#211c14", glow: "#ffd36a66", blurb: "a map, a lantern, and one more room" },
    { id: "pixelBloom", name: "Pixel Bloom", family: "retro", primary: "#ff8fc0", secondary: "#a8ffcf", panel: "#1a1926", glow: "#ff8fc066", blurb: "cozy-game color with tiny sparks" },
    { id: "dragonWake", name: "Dragon Wake", family: "fantasy", primary: "#ff6f55", secondary: "#a98cff", panel: "#21131c", glow: "#ff6f5566", blurb: "scaled shadow and violet flame" },
    { id: "witchlight", name: "Witchlight", family: "fantasy", primary: "#c48cff", secondary: "#86f1c1", panel: "#171329", glow: "#c48cff66", blurb: "herbs, moonwater, and a green flame" },
    { id: "cloudCity", name: "Cloud City", family: "cosmic", primary: "#8bdcff", secondary: "#f0c4ff", panel: "#14202c", glow: "#8bdcff66", blurb: "skyline haze above the weather" },
    { id: "venomGarden", name: "Venom Garden", family: "botanical", primary: "#b5e85e", secondary: "#e47cff", panel: "#151c19", glow: "#b5e85e66", blurb: "beautiful leaves with a dangerous edge" },
    { id: "copperCircuit", name: "Copper Circuit", family: "tech", primary: "#f2a66c", secondary: "#76e2d1", panel: "#1e1816", glow: "#f2a66c66", blurb: "brass, teal, and mechanical rhythm" },
    { id: "sapphireRift", name: "Sapphire Rift", family: "cosmic", primary: "#6cb5ff", secondary: "#b18cff", panel: "#101a2e", glow: "#6cb5ff66", blurb: "a clean blue portal through the void" },
    { id: "velvetReactor", name: "Velvet Reactor", family: "tech", primary: "#ff709a", secondary: "#74f1d4", panel: "#21151e", glow: "#ff709a66", blurb: "soft fabric wrapped around hard light" },
    { id: "honeyMoon", name: "Honey Moon", family: "cozy", primary: "#ffd477", secondary: "#ff9d9d", panel: "#251d16", glow: "#ffd47766", blurb: "warm tea, gold dust, and a blush sky" },
    { id: "phantomOpera", name: "Phantom Opera", family: "noir", primary: "#f1e2c0", secondary: "#c276a5", panel: "#1b1720", glow: "#f1e2c066", blurb: "theatre curtains and a silver mask" },
    { id: "paperLantern", name: "Paper Lantern", family: "cozy", primary: "#ffb66d", secondary: "#ff7f9e", panel: "#241817", glow: "#ffb66d66", blurb: "quiet festival light after rain" },
    { id: "silverScreen", name: "Silver Screen", family: "noir", primary: "#dbe7ff", secondary: "#9daeff", panel: "#151922", glow: "#dbe7ff66", blurb: "monochrome drama with a blue tint" },
    { id: "glitchCathedral", name: "Glitch Cathedral", family: "tech", primary: "#67f4e9", secondary: "#ff5dd5", panel: "#101822", glow: "#67f4e966", blurb: "sacred geometry in a broken signal" },
    { id: "coralTide", name: "Coral Tide", family: "botanical", primary: "#ff9e93", secondary: "#73e0dc", panel: "#171c24", glow: "#ff9e9366", blurb: "reef color under a blue surface" },
    { id: "lunarEclipse", name: "Lunar Eclipse", family: "cosmic", primary: "#ff6d98", secondary: "#9a8cff", panel: "#171425", glow: "#ff6d9866", blurb: "a red moon over violet shadow" },
    { id: "thunderRun", name: "Thunder Run", family: "tech", primary: "#9fe8ff", secondary: "#ffd166", panel: "#111a25", glow: "#9fe8ff66", blurb: "storm charge and fast-lane light" },
    { id: "mossyQuest", name: "Mossy Quest", family: "cozy", primary: "#b6d982", secondary: "#f5be78", panel: "#182017", glow: "#b6d98266", blurb: "an old trail through friendly green" },
    { id: "scarletComet", name: "Scarlet Comet", family: "cosmic", primary: "#ff637e", secondary: "#ffbd6b", panel: "#241319", glow: "#ff637e66", blurb: "red velocity across a black sky" },
    { id: "opalHaven", name: "Opal Haven", family: "fantasy", primary: "#8ae6da", secondary: "#e5b7ff", panel: "#162024", glow: "#8ae6da66", blurb: "iridescent shelter at the edge of day" },
    { id: "blueHour", name: "Blue Hour", family: "noir", primary: "#83b9ff", secondary: "#c5d5ff", panel: "#121a2a", glow: "#83b9ff66", blurb: "city lights before the night settles" },
    { id: "wildflower", name: "Wildflower", family: "botanical", primary: "#ff86b7", secondary: "#a6e77d", panel: "#1a1f18", glow: "#ff86b766", blurb: "pink petals, green stems, open sky" },
    { id: "solarFlare", name: "Solar Flare", family: "cosmic", primary: "#ffe08a", secondary: "#f07e6e", panel: "#251814", glow: "#ffe08a66", blurb: "hot light at the edge of orbit" },
    { id: "rainCity", name: "Rain City", family: "noir", primary: "#79e2f2", secondary: "#b39bff", panel: "#121923", glow: "#79e2f266", blurb: "wet streets and electric reflections" },
    { id: "koiPond", name: "Koi Pond", family: "botanical", primary: "#ff9478", secondary: "#7edbd0", panel: "#17201e", glow: "#ff947866", blurb: "slow water, bright fins, calm focus" },
    { id: "fairytaleInk", name: "Fairytale Ink", family: "fantasy", primary: "#e2b5ff", secondary: "#ffd28c", panel: "#20182a", glow: "#e2b5ff66", blurb: "storybook ink with a golden ending" },
    { id: "mapleEmber", name: "Maple Ember", family: "cozy", primary: "#ff9a61", secondary: "#d6b06c", panel: "#251a16", glow: "#ff9a6166", blurb: "autumn leaves around a small fire" },
    { id: "crystalCave", name: "Crystal Cave", family: "fantasy", primary: "#8ef0ff", secondary: "#d39dff", panel: "#14192b", glow: "#8ef0ff66", blurb: "faceted light under the mountain" },
    { id: "dreamFactory", name: "Dream Factory", family: "tech", primary: "#f48bff", secondary: "#82f0c5", panel: "#1a1828", glow: "#f48bff66", blurb: "surreal machinery making soft clouds" },
    { id: "shadowSignal", name: "Shadow Signal", family: "noir", primary: "#9cb1ff", secondary: "#d5e1ff", panel: "#111721", glow: "#9cb1ff66", blurb: "a coded message in the dark" },
    { id: "starlightDiner", name: "Starlight Diner", family: "retro", primary: "#ff9fbe", secondary: "#8ee5ff", panel: "#211725", glow: "#ff9fbe66", blurb: "chrome booths under a pink sky" },
    { id: "frostGarden", name: "Frost Garden", family: "botanical", primary: "#c7f6ff", secondary: "#99b4ff", panel: "#15202c", glow: "#c7f6ff66", blurb: "frozen petals and blue glass" },
    { id: "roseQuartz", name: "Rose Quartz", family: "botanical", primary: "#ff9cc4", secondary: "#e7c7ff", panel: "#241926", glow: "#ff9cc466", blurb: "soft crystal, pink light, clean edges" },
    { id: "volcanicGlass", name: "Volcanic Glass", family: "fantasy", primary: "#ff7f62", secondary: "#9d8cff", panel: "#1d1519", glow: "#ff7f6266", blurb: "black stone with molten seams" },
    { id: "electricMeadow", name: "Electric Meadow", family: "botanical", primary: "#9dff83", secondary: "#6be4ff", panel: "#132019", glow: "#9dff8366", blurb: "fireflies wired to a synth line" },
    { id: "celestialLibrary", name: "Celestial Library", family: "noir", primary: "#c8d7ff", secondary: "#e8b9ff", panel: "#171828", glow: "#c8d7ff66", blurb: "constellations between old shelves" },
    { id: "marshmallowOrbit", name: "Marshmallow Orbit", family: "cozy", primary: "#ffb6da", secondary: "#a9e7ff", panel: "#211a29", glow: "#ffb6da66", blurb: "playful pastel planets" },
    { id: "blackPearl", name: "Black Pearl", family: "noir", primary: "#9fe4e8", secondary: "#d6b0ff", panel: "#12191d", glow: "#9fe4e866", blurb: "salt air and a polished dark shine" },
    { id: "orchardMoon", name: "Orchard Moon", family: "cozy", primary: "#ffd487", secondary: "#9ee6ae", panel: "#1d2017", glow: "#ffd48766", blurb: "ripe fruit beneath a quiet moon" },
    { id: "inkAndGold", name: "Ink & Gold", family: "noir", primary: "#f4d38a", secondary: "#9db7ff", panel: "#1d1a17", glow: "#f4d38a66", blurb: "classic pages with a midnight margin" },
    { id: "prismStage", name: "Prism Stage", family: "retro", primary: "#ff78c8", secondary: "#75f4ff", panel: "#1c1628", glow: "#ff78c866", blurb: "spotlights, glass, and curtain shimmer" },
    { id: "fairyCircuit", name: "Fairy Circuit", family: "tech", primary: "#baf27f", secondary: "#ee9fff", panel: "#172019", glow: "#baf27f66", blurb: "tiny wings inside a bright machine" }
];

const PROFILE_SKIN_MAP = new Map(PROFILE_SKIN_PRESETS.map(preset => [preset.id, preset]));
const DEFAULT_PROFILE_SKIN = PROFILE_SKIN_PRESETS[0].id;
const PROFILE_GRADIENT_DEFAULT_MIGRATION = "profileGradientDefaultV2Migrated";
const PROFILE_VISUAL_SOURCE_OPTIONS: readonly ProfileVisualSource[] = ["profile", "skin", "widget"];
const PROFILE_SKIN_FAMILIES = [
    { id: "all", label: "All" },
    { id: "featured", label: "Featured" },
    { id: "botanical", label: "Botanical" },
    { id: "cosmic", label: "Cosmic" },
    { id: "fantasy", label: "Fantasy" },
    { id: "retro", label: "Retro" },
    { id: "noir", label: "Noir" },
    { id: "cozy", label: "Cozy" },
    { id: "tech", label: "Tech" }
] as const;

function profileSkin(id: string): ProfileSkinPreset {
    return PROFILE_SKIN_MAP.get(id) ?? PROFILE_SKIN_MAP.get(DEFAULT_PROFILE_SKIN)!;
}

function normalizeVisualSource(value: unknown): ProfileVisualSource {
    return PROFILE_VISUAL_SOURCE_OPTIONS.includes(value as ProfileVisualSource)
        ? value as ProfileVisualSource
        : "profile";
}

function readHexColor(value: unknown): string | null {
    const candidate = String(value ?? "").trim();
    const hex = candidate.match(/^#([\da-f]{3}|[\da-f]{6})(?:[\da-f]{2})?$/i);
    if (hex) {
        const value = hex[1].length === 3
            ? hex[1].split("").map(channel => channel + channel).join("")
            : hex[1];
        return `#${value.toLowerCase()}`;
    }
    // Computed custom properties can be exposed as rgb()/rgba() rather than
    // the literal hex entered in Discord's profile editor. Convert that
    // rendered color to the same canonical six-digit form used by DMProfileFlair.
    const rgb = candidate.match(/^rgba?\(\s*([^)]*)\)$/i);
    if (!rgb) return null;
    const channels = rgb[1].split(",").slice(0, 3).map(channel => Number.parseFloat(channel.trim()));
    if (channels.length !== 3 || channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
    return `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function profileGradientPreset(primary: string, secondary: string, panel = primary): ProfileSkinPreset {
    return {
        id: "profileGradient",
        name: "Profile gradient",
        family: "featured",
        primary,
        secondary,
        panel,
        glow: hexToRgba(primary, .4),
        blurb: `the native profile gradient, carried into the action groups · ${primary} → ${secondary}`
    };
}

function readProfileGradientFromElement(candidate: HTMLElement, allowDefaultBlack = false): ProfileSkinPreset | null {
    try {
        const computed = getComputedStyle(candidate);
        const readProperty = (name: string) => readHexColor(candidate.style.getPropertyValue(name))
            ?? readHexColor(computed.getPropertyValue(name));
        const primary = readProperty("--profile-gradient-primary-color");
        const secondary = readProperty("--profile-gradient-secondary-color");
        if (!primary || !secondary) return null;
        // Discord exposes black custom-property defaults on document/body even
        // when no profile gradient is active. Do not mistake those defaults
        // for the user's palette. DMProfileFlair's marked surface is trusted
        // because it explicitly owns the values it applies.
        if (!allowDefaultBlack && primary === "#000000" && secondary === "#000000") return null;
        return profileGradientPreset(primary, secondary, readProperty("--profile-body-background-color") ?? primary);
    } catch {
        // Discord can tear down the profile portal while it is being read.
        return null;
    }
}

function profileGradientVisual(surface?: HTMLElement): ProfileSkinPreset | null {
    const candidates: HTMLElement[] = [];
    if (surface) candidates.push(surface);
    if (surface) {
        let parent = surface.parentElement;
        for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) candidates.push(parent);

        // DMProfileFlair paints the canonical palette on the profile-content
        // node, which can sit below the outer popout surface. Prefer marked
        // descendants from this surface before generic document/body values;
        // this keeps another open profile from donating its colors.
        try {
            if (surface.matches("[data-dm-flair-theme-applied]")) candidates.unshift(surface);
            candidates.unshift(...Array.from(surface.querySelectorAll<HTMLElement>("[data-dm-flair-theme-applied]")));
        } catch {
            // Discord may remove the portal during a concurrent render.
        }
    }
    if (!surface) candidates.push(...findProfileSurfaces());
    if (typeof document !== "undefined") {
        candidates.push(document.documentElement, document.body);
    }

    // A DMProfileFlair-marked surface is the most precise source for a live
    // popout, including another user's shared roster palette. Read it before
    // any generic Discord root so a stale document default cannot win.
    const trustedCandidates = candidates.filter(candidate => candidate.hasAttribute("data-dm-flair-theme-applied"));
    for (const candidate of trustedCandidates) {
        const visual = readProfileGradientFromElement(candidate, true);
        if (visual) return visual;
    }

    // The native profile surface may not be mounted while the settings page is
    // open. DMProfileFlair keeps the user's exact six-digit values in its
    // hidden settings fields, so use them as the canonical no-surface source.
    // This must run before document/body fallbacks: those often expose the
    // harmless #000000 defaults shown in the old showroom bug.
    const flairSettings = (globalThis as any).Vencord?.PlainSettings?.plugins?.DMProfileFlair;
    const primary = readHexColor(flairSettings?.myThemeColorPrimary);
    const secondary = readHexColor(flairSettings?.myThemeColorSecondary);
    if (primary && secondary) return profileGradientPreset(primary, secondary);

    // Finally support native Discord/custom surfaces when DMProfileFlair has
    // no saved palette. Ignore unmarked all-black defaults, but keep any real
    // rendered palette available to the local cosmetics layer.
    for (const candidate of candidates) {
        const visual = readProfileGradientFromElement(candidate);
        if (visual) return visual;
    }
    return null;
}

function validWidgetStyleId(value: unknown): string | null {
    const id = String(value ?? "");
    return WIDGET_STYLE_PRESETS.some(preset => preset.id === id) ? id : null;
}

function currentWidgetStyleId(): string {
    return validWidgetStyleId((globalThis as any).Vencord?.PlainSettings?.plugins?.DMWidget?.widgetStyle)
        ?? WIDGET_STYLE_PRESETS[0].id;
}

function profileWidgetStyleId(): string {
    return validWidgetStyleId(readSetting("profileWidgetStyle", "")) ?? currentWidgetStyleId();
}

function initializeProfileWidgetStyleSnapshot(): void {
    const store = settings.store as Record<string, unknown>;
    if (store.profileWidgetStyleSnapshotInitialized === true) return;

    // Migrate the old live-follow behavior once, preserving the visual the
    // user already had without keeping the two settings coupled forever.
    store.profileWidgetStyle = currentWidgetStyleId();
    store.profileWidgetStyleSnapshotInitialized = true;
}

function migrateProfileVisualSourceDefault(): void {
    const store = settings.store as Record<string, unknown>;
    if (store.profileVisualSourceDefaultMigrated !== true) {
        // The first public release of this plugin defaulted to the boxed local
        // palette. That setting was not user-visible yet, so migrate the old
        // default to the native profile gradient once while preserving explicit
        // choices made after this release.
        if (store.visualSource == null || store.visualSource === "skin") {
            store.visualSource = "profile";
        }
        store.profileVisualSourceDefaultMigrated = true;
    }

    // v2 makes the migration safe for clients that already recorded the first
    // marker before the default was corrected. Only the old Aurora/skin pair
    // is converted; an explicitly selected non-default palette or widget
    // snapshot remains untouched.
    if (store[PROFILE_GRADIENT_DEFAULT_MIGRATION] !== true) {
        const storedSource = normalizeVisualSource(store.visualSource);
        const storedSkin = String(store.skinPreset ?? DEFAULT_PROFILE_SKIN);
        if (storedSource === "skin" && storedSkin === DEFAULT_PROFILE_SKIN) {
            store.visualSource = "profile";
        }
        store[PROFILE_GRADIENT_DEFAULT_MIGRATION] = true;
    }
}

function effectiveVisualSource(): ProfileVisualSource {
    const source = normalizeVisualSource(readSetting("visualSource", "profile"));
    const skinPreset = String(readSetting("skinPreset", DEFAULT_PROFILE_SKIN));
    const store = settings.store as Record<string, unknown>;

    // Settings can be read by the showroom before the plugin start hook has
    // run. Keep the same one-time compatibility rule there so the preview and
    // the real popout cannot disagree about what "Default" means.
    if (store[PROFILE_GRADIENT_DEFAULT_MIGRATION] !== true && source === "skin" && skinPreset === DEFAULT_PROFILE_SKIN) {
        store.visualSource = "profile";
        store[PROFILE_GRADIENT_DEFAULT_MIGRATION] = true;
        return "profile";
    }
    return source;
}

function widgetStyleVisual(styleId = profileWidgetStyleId()): ResolvedProfileVisual {
    const preset = widgetStylePreset(styleId);
    return {
        id: preset.id,
        widgetStyle: preset,
        name: preset.name,
        family: preset.family,
        primary: preset.accent,
        secondary: preset.secondary,
        panel: preset.surface,
        glow: `${preset.accent}66`,
        blurb: preset.blurb
    };
}

function resolveProfileVisual(base: ProfileSkinPreset, source: ProfileVisualSource, surface?: HTMLElement): ResolvedProfileVisual {
    if (source === "profile") return profileGradientVisual(surface) ?? base;
    if (source === "widget") return widgetStyleVisual(profileWidgetStyleId());
    return base;
}

function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace("#", "");
    const value = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function effectLabel(effect: EffectPreset): string {
    return {
        none: "Still · no particles",
        aurora: "Aurora veil",
        emberfall: "Emberfall",
        frost: "Frost dust",
        neonRain: "Neon rain",
        roseDrift: "Rose drift",
        starlight: "Starlight",
        inkBloom: "Ink bloom",
        gildedDust: "Gilded dust"
    }[effect];
}

const PROFILE_SURFACE_SELECTOR = [
    '[class*="user-profile-popout"]',
    '[class*="userPopout"]',
    '[class*="user-popout"]',
    '[class*="profilePopout"]',
    '[class*="profile-popout"]',
    '[class*="accountPopout"]'
].join(", ");

const PROFILE_EDITOR_SELECTOR = [
    '[class*="user-profile-sidebar"]',
    '[class*="userProfileSidebar"]',
    '[class*="userProfileModal"]',
    '[class*="user-profile-modal"]',
    '[class*="profileModal"]',
    '[class*="profile-modal"]'
].join(", ");

const CONTROL_CANDIDATE_SELECTOR = [
    "button",
    '[role="button"]',
    '[role="menuitem"]',
    "a",
    '[class*="item_"]',
    '[class*="row_"]',
    '[class*="action_"]',
    '[class*="clickable_"]'
].join(", ");

// These are intentionally name-based hints rather than hard-coded Discord
// hashes. The class names change frequently, while the accessible labels and
// visible copy are stable enough for this small, capped pass.
const NATIVE_COSMETIC_SELECTOR = [
    '[class*="profileEffect"]',
    '[class*="profile-effect"]',
    '[class*="avatarDecoration"]',
    '[class*="avatar-decoration"]',
    '[class*="profileFrame"]',
    '[class*="profile-frame"]',
    '[class*="nameplate"]',
    '[data-testid*="profileEffect"]',
    '[data-testid*="profile-effect"]',
    '[aria-label*="Avatar Decoration"]',
    '[aria-label*="Profile Effect"]',
    '[aria-label*="Profile Frame"]',
    '[aria-label*="Nameplate"]'
].join(", ");

const SURFACE_LIMIT = 8;
const CONTROL_LIMIT = 6;
const SURFACE_MARKER = "data-dm-profile-cosmetics";
const EFFECT_LAYER_MARKER = "data-dm-profile-effect-layer";
const PROFILE_SKIN_VARIABLES = [
    "--dm-profile-skin-primary",
    "--dm-profile-skin-secondary",
    "--dm-profile-skin-panel",
    "--dm-profile-skin-glow"
];

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let motionQuery: MediaQueryList | null = null;
let visibilityHandler: (() => void) | null = null;
let started = false;

function readSetting<T>(key: string, fallback: T): T {
    try {
        const value = (settings.store as Record<string, unknown>)[key];
        return (value as T) ?? fallback;
    } catch {
        return fallback;
    }
}

function tournamentModeActive(): boolean {
    // Prefer TournamentMode's persisted runtime mirror when it is available.
    // The global flag is useful during the tiny startup window before that
    // plugin exposes its settings, but it can otherwise outlive a renderer
    // reload and falsely label this showroom as paused while Tournament Mode
    // is actually off.
    const mirrored = (globalThis as any).Vencord?.PlainSettings?.plugins?.TournamentMode?.manuallyActive;
    if (typeof mirrored === "boolean") return mirrored;
    return (globalThis as Record<string, unknown>).__dmTournamentModeActive === true;
}

function reducedMotionEnabled(): boolean {
    try {
        return motionQuery?.matches === true;
    } catch {
        return false;
    }
}

function motionPaused(): boolean {
    return (readSetting("pauseInTournamentMode", true) && tournamentModeActive())
        || (readSetting("respectReducedMotion", true) && reducedMotionEnabled());
}

function showroomMotionPaused(): boolean {
    // The showroom must never promise motion that the real profile surface
    // will suppress. This keeps Tournament Mode and reduced-motion previews
    // honest while the status badge explains which safeguard is active.
    return motionPaused();
}

function normalizedText(element: Element): string {
    return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function visible(element: HTMLElement): boolean {
    try {
        const rect = element.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 20 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
        const computed = window.getComputedStyle(element);
        return computed.display !== "none" && computed.visibility !== "hidden" && Number(computed.opacity) > 0;
    } catch {
        return false;
    }
}

function isProfileSurface(element: HTMLElement): boolean {
    const className = typeof element.className === "string" ? element.className : "";
    const signal = `${className} ${element.getAttribute("aria-label") ?? ""}`;
    if (!/profile|popout|account/i.test(signal)) return false;

    const text = normalizedText(element).slice(0, 1200).toLowerCase();
    // Discord's full profile editor can share profile/popout class fragments
    // with the read-only popout. It owns the banner/avatar layout and must
    // never receive our surface marker or effect layer.
    if (/\bmain profile\b|avatar\s*&\s*decoration|banner\s+colour|profile\s+effect\s*&\s*frame|display\s+name\s+style|preview\s+nitro|save\s+changes/.test(text)) return false;
    const hasProfileVisual = Boolean(element.querySelector(
        '[class*="avatar"], [class*="banner"], [class*="userInfo"], [data-user-id]'
    ));
    const hasProfileAction = /edit profile|badges?|\borbs?\b|\bonline\b|do not disturb|invisible/.test(text);
    return hasProfileVisual && hasProfileAction;
}

function isProfileEditorSurface(element: HTMLElement): boolean {
    const text = normalizedText(element).slice(0, 1800).toLowerCase();
    return /\bmain profile\b|avatar\s*&\s*decoration|banner\s+colour|profile\s+effect\s*&\s*frame|display\s+name\s+style|preview\s+nitro|save\s+changes/.test(text);
}

function findProfileSurfaces(): HTMLElement[] {
    if (!document.body || document.hidden) return [];

    const result: HTMLElement[] = [];
    try {
        for (const candidate of Array.from(document.querySelectorAll<HTMLElement>(PROFILE_SURFACE_SELECTOR)).slice(0, 32)) {
            if (!candidate.isConnected || !visible(candidate) || !isProfileSurface(candidate)) continue;
            // Discord often mounts several nested wrappers with profile-like
            // names. Reconcile the outer visible surface once.
            if (result.some(surface => surface.contains(candidate))) continue;
            result.push(candidate);
            if (result.length >= SURFACE_LIMIT) break;
        }
    } catch {
        // Discord can replace a portal between querySelectorAll and layout.
    }
    return result;
}

function controlMatches(kind: ProfileControl, text: string): boolean {
    if (text.length === 0 || text.length > 96) return false;
    switch (kind) {
        case "edit":
            return /^edit profile$/i.test(text);
        case "badges":
            return /^badges?$/i.test(text);
        case "orbs":
            return /^(?:\d+\s*)?orbs?$/i.test(text);
        case "status":
            return /^(online|idle|do not disturb|invisible|offline)(?:\s|$)/i.test(text);
        case "switchAccounts":
            return /^switch accounts$/i.test(text);
        case "copyUserId":
            return /^copy user id$/i.test(text);
    }
}

function rowForControl(element: HTMLElement, surface: HTMLElement): HTMLElement {
    let current: HTMLElement | null = element;
    for (let depth = 0; current && depth < 5 && current !== surface; depth++, current = current.parentElement) {
        const role = current.getAttribute("role") ?? "";
        const className = typeof current.className === "string" ? current.className : "";
        if (current.matches('button, [role="button"], [role="menuitem"], a') || /(?:item|row|action|clickable|status)/i.test(className) || role === "menuitem") {
            return current;
        }
    }
    return element;
}

function findControlRows(surface: HTMLElement): Map<ProfileControl, HTMLElement> {
    const rows = new Map<ProfileControl, HTMLElement>();
    const candidates = Array.from(surface.querySelectorAll<HTMLElement>(CONTROL_CANDIDATE_SELECTOR)).slice(0, 220);

    for (const kind of ["edit", "status", "badges", "orbs", "switchAccounts", "copyUserId"] as ProfileControl[]) {
        let best: HTMLElement | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
            const text = normalizedText(candidate);
            if (!controlMatches(kind, text)) continue;
            const row = rowForControl(candidate, surface);
            const semanticBonus = row.matches("button, [role=button], [role=menuitem], a") ? -40 : 0;
            const score = text.length + semanticBonus;
            if (score < bestScore) {
                best = row;
                bestScore = score;
            }
        }
        if (best) rows.set(kind, best);
        if (rows.size >= CONTROL_LIMIT) break;
    }
    return rows;
}

function removeOwnedMarkers(surface: HTMLElement, removeEffectLayer = true): void {
    surface.removeAttribute(SURFACE_MARKER);
    surface.removeAttribute("data-dm-profile-effect");
    surface.removeAttribute("data-dm-profile-effect-intensity");
    surface.removeAttribute("data-dm-profile-effect-speed");
    surface.removeAttribute("data-dm-profile-motion-paused");
    surface.removeAttribute("data-dm-profile-skin");
    surface.removeAttribute("data-dm-profile-skin-family");
    surface.removeAttribute("data-dm-profile-visual-source");
    surface.removeAttribute("data-dm-profile-widget-style");
    surface.removeAttribute("data-dm-native-cosmetics");
    surface.removeAttribute("data-dm-profile-control");
    surface.removeAttribute("data-dm-profile-controls-shell");
    surface.removeAttribute("data-dm-profile-controls-surface");
    PROFILE_SKIN_VARIABLES.forEach(property => surface.style.removeProperty(property));
    surface.querySelectorAll<HTMLElement>(`[${SURFACE_MARKER}="true"]`).forEach(node => {
        node.removeAttribute(SURFACE_MARKER);
        node.removeAttribute("data-dm-profile-effect");
        node.removeAttribute("data-dm-profile-effect-intensity");
        node.removeAttribute("data-dm-profile-effect-speed");
        node.removeAttribute("data-dm-profile-motion-paused");
        node.removeAttribute("data-dm-profile-skin");
        node.removeAttribute("data-dm-profile-skin-family");
        node.removeAttribute("data-dm-profile-visual-source");
        node.removeAttribute("data-dm-profile-widget-style");
        node.removeAttribute("data-dm-native-cosmetics");
        PROFILE_SKIN_VARIABLES.forEach(property => node.style.removeProperty(property));
    });
    surface.querySelectorAll<HTMLElement>('[data-dm-profile-control], [data-dm-profile-controls-shell], [data-dm-profile-controls-surface]').forEach(node => {
        node.removeAttribute("data-dm-profile-control");
        node.removeAttribute("data-dm-profile-controls-shell");
        node.removeAttribute("data-dm-profile-controls-surface");
    });
    if (removeEffectLayer) {
        surface.querySelectorAll<HTMLElement>(`[${EFFECT_LAYER_MARKER}="true"]`).forEach(layer => layer.remove());
    }
}

function ensureEffectLayer(surface: HTMLElement): HTMLElement {
    let layer = surface.querySelector<HTMLElement>(`:scope > [${EFFECT_LAYER_MARKER}="true"]`);
    if (!layer) {
        layer = document.createElement("div");
        layer.setAttribute(EFFECT_LAYER_MARKER, "true");
        layer.setAttribute("aria-hidden", "true");
        surface.insertBefore(layer, surface.firstChild);
    }
    return layer;
}

function markControlRows(surface: HTMLElement): void {
    const rows = findControlRows(surface);
    for (const [kind, row] of rows) row.setAttribute("data-dm-profile-control", kind);

    // Discord keeps the primary actions and account actions in two separate
    // lists. Give each list the same widget-inspired shell rather than
    // forcing both groups into one wrapper that would never exist in the DOM.
    const groups: ProfileControl[][] = [
        ["edit", "status", "badges", "orbs"],
        ["switchAccounts", "copyUserId"]
    ];
    for (const group of groups) {
        const controls = group.map(kind => rows.get(kind)).filter((row): row is HTMLElement => Boolean(row));
        if (controls.length < 2) continue;
        let shell: HTMLElement | null = controls[0].parentElement;
        for (let depth = 0; shell && depth < 6 && shell !== surface; depth++, shell = shell.parentElement) {
            if (!controls.every(control => shell?.contains(control))) continue;
            const text = normalizedText(shell);
            if (text.length <= 320) break;
        }
        if (shell && shell !== surface && controls.every(control => shell.contains(control))) {
            shell.setAttribute("data-dm-profile-controls-shell", "true");

            // In some Discord builds the visible dark card is the shell's
            // parent, while in others the shell itself owns the background.
            // Mark only a small ancestor that contains this group and no more
            // than the action copy, so the profile-gradient treatment reaches
            // the actual card without flattening widgets or the whole popout.
            const panel = shell.parentElement;
            if (panel && panel !== surface && controls.every(control => panel.contains(control)) && normalizedText(panel).length <= 420) {
                panel.setAttribute("data-dm-profile-controls-surface", "true");
            }
        }
    }
}

function nativeCosmeticsPresent(surface: HTMLElement): boolean {
    try {
        return Boolean(surface.querySelector(NATIVE_COSMETIC_SELECTOR));
    } catch {
        return false;
    }
}

function reconcileSurface(surface: HTMLElement): void {
    // Keep the existing layer node when a profile subtree changes. Recreating
    // it on every Discord child commit would add needless DOM churn and would
    // wake this observer again for no visual benefit.
    removeOwnedMarkers(surface, false);

    const controlsSkin = readSetting("controlsSkin", true);
    const localEffects = readSetting("localEffects", false);
    const effectPreset = readSetting<EffectPreset>("effectPreset", "aurora");
    const intensity = readSetting<EffectIntensity>("effectIntensity", "balanced");
    const effectSpeed = readSetting<EffectSpeed>("effectSpeed", "standard");
    const baseSkin = profileSkin(String(readSetting("skinPreset", DEFAULT_PROFILE_SKIN)));
    const visualSource = effectiveVisualSource();
    const skin = resolveProfileVisual(baseSkin, visualSource, surface);
    const widgetStyle = visualSource === "widget" ? widgetStyleVisual(profileWidgetStyleId()).widgetStyle.id : "";
    const native = readSetting("preserveNativeCosmetics", true) && nativeCosmeticsPresent(surface);
    const effectsPaused = motionPaused();

    if (!controlsSkin && !localEffects) return;

    surface.setAttribute(SURFACE_MARKER, "true");
    surface.setAttribute("data-dm-native-cosmetics", native ? "true" : "false");
    surface.setAttribute("data-dm-profile-motion-paused", effectsPaused ? "true" : "false");
    surface.setAttribute("data-dm-profile-skin", skin.id);
    surface.setAttribute("data-dm-profile-skin-family", skin.family);
    surface.setAttribute("data-dm-profile-visual-source", visualSource);
    if (widgetStyle) surface.setAttribute("data-dm-profile-widget-style", widgetStyle);
    surface.setAttribute("data-dm-profile-effect-speed", effectSpeed);
    surface.style.setProperty("--dm-profile-skin-primary", skin.primary);
    surface.style.setProperty("--dm-profile-skin-secondary", skin.secondary);
    surface.style.setProperty("--dm-profile-skin-panel", skin.panel);
    surface.style.setProperty("--dm-profile-skin-glow", skin.glow);

    if (controlsSkin) markControlRows(surface);

    // Tournament Mode already suppresses visual motion in CSS. Do not create
    // the hidden layer in the first place: this keeps the profile observer
    // from tracking a DOM node that cannot be seen, while normal mode and the
    // showroom preview continue to use the same effect presets unchanged.
    if (localEffects && effectPreset !== "none" && !effectsPaused) {
        surface.setAttribute("data-dm-profile-effect", effectPreset);
        surface.setAttribute("data-dm-profile-effect-intensity", intensity);
        ensureEffectLayer(surface);
    } else {
        surface.querySelectorAll<HTMLElement>(`[${EFFECT_LAYER_MARKER}="true"]`).forEach(layer => layer.remove());
    }
}

function restoreAll(): void {
    document.querySelectorAll<HTMLElement>(`[${SURFACE_MARKER}="true"]`).forEach(removeOwnedMarkers);
    document.querySelectorAll<HTMLElement>(`[${EFFECT_LAYER_MARKER}="true"]`).forEach(layer => layer.remove());
}

function cleanupProfileEditorArtifacts(): void {
    try {
        for (const editor of Array.from(document.querySelectorAll<HTMLElement>(PROFILE_EDITOR_SELECTOR)).slice(0, 12)) {
            if (isProfileEditorSurface(editor)) removeOwnedMarkers(editor);
        }
    } catch {
        // Discord can replace the editor portal while it is mounting.
    }
}

function reconcileAll(): void {
    if (!started || document.hidden) return;
    cleanupProfileEditorArtifacts();
    const surfaces = findProfileSurfaces();
    const seen = new Set(surfaces);
    for (const surface of surfaces) reconcileSurface(surface);
    document.querySelectorAll<HTMLElement>(`[${SURFACE_MARKER}="true"]`).forEach(surface => {
        if (!seen.has(surface) || !surface.isConnected) removeOwnedMarkers(surface);
    });
}

function scheduleReconcile(delay = 80): void {
    if (!started || reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        try {
            reconcileAll();
        } catch (error) {
            console.warn("[DMProfileCosmetics] guarded route reconciliation", error);
        }
    }, delay);
}

function handleDocumentVisibilityChange(): void {
    if (document.hidden) {
        if (reconcileTimer) clearTimeout(reconcileTimer);
        reconcileTimer = null;
        return;
    }
    scheduleReconcile(0);
}

function mutationLooksRelevant(record: MutationRecord): boolean {
    if (record.type !== "childList") return false;
    const target = record.target instanceof Element ? record.target : null;
    const ownNodesOnly = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].every(node => {
        return node instanceof Element && Boolean(node.matches(`[${EFFECT_LAYER_MARKER}="true"]`) || node.closest(`[${EFFECT_LAYER_MARKER}="true"]`));
    });
    if (ownNodesOnly) return false;
    if (target?.closest(PROFILE_SURFACE_SELECTOR)) return true;
    return Array.from(record.addedNodes).slice(0, 8).some(node => {
        if (!(node instanceof Element)) return false;
        const className = typeof (node as HTMLElement).className === "string" ? (node as HTMLElement).className : "";
        return /profile|popout|accountPopout|userPopout/i.test(`${className} ${node.getAttribute("role") ?? ""}`);
    });
}

type AnimatedEffect = Exclude<EffectPreset, "none">;

// Keep the showroom and the real popout on one renderer path. The preview
// effect is a direct child of its mock profile card, just like the real layer
// is a direct child of a discovered profile surface.
const EFFECT_LAYER_TARGET = `:is([${SURFACE_MARKER}="true"] > [${EFFECT_LAYER_MARKER}="true"], .dm-profile-preview-card > .dm-profile-preview-effect)`;
const effectTarget = (effect: AnimatedEffect): string => `:is([${SURFACE_MARKER}="true"][data-dm-profile-effect="${effect}"] > [${EFFECT_LAYER_MARKER}="true"], .dm-profile-preview-card[data-dm-profile-effect="${effect}"] > .dm-profile-preview-effect)`;
const intensityTarget = (intensity: EffectIntensity): string => `:is([${SURFACE_MARKER}="true"][data-dm-profile-effect-intensity="${intensity}"] > [${EFFECT_LAYER_MARKER}="true"], .dm-profile-preview-card[data-dm-profile-effect-intensity="${intensity}"] > .dm-profile-preview-effect)`;
const speedTarget = (speed: EffectSpeed): string => `:is([${SURFACE_MARKER}="true"][data-dm-profile-effect-speed="${speed}"] > [${EFFECT_LAYER_MARKER}="true"], .dm-profile-preview-card[data-dm-profile-effect-speed="${speed}"] > .dm-profile-preview-effect)`;
const pausedTarget = `:is([${SURFACE_MARKER}="true"][data-dm-profile-motion-paused="true"] > [${EFFECT_LAYER_MARKER}="true"], .dm-profile-preview-effect[data-paused="true"])`;

function buildCss(): string {
    return `
        [${SURFACE_MARKER}="true"] {
            --dm-profile-cosmetics-accent: #b887ff;
            --dm-profile-cosmetics-cyan: #4de7ff;
            --dm-profile-skin-primary: #b887ff;
            --dm-profile-skin-secondary: #4de7ff;
            --dm-profile-skin-panel: #101926;
            --dm-profile-skin-glow: rgba(184, 135, 255, .4);
            position: relative;
            isolation: isolate;
        }

        /* Native Discord cosmetics remain visible and above our local layer.
         * We only relax clipping on a profile shell that actually contains a
         * known native cosmetic node; ordinary popouts keep their own bounds. */
        [${SURFACE_MARKER}="true"][data-dm-native-cosmetics="true"] {
            overflow: visible !important;
        }
        [${SURFACE_MARKER}="true"] [class*="profileEffect"],
        [${SURFACE_MARKER}="true"] [class*="profile-effect"],
        [${SURFACE_MARKER}="true"] [class*="avatarDecoration"],
        [${SURFACE_MARKER}="true"] [class*="avatar-decoration"],
        [${SURFACE_MARKER}="true"] [class*="profileFrame"],
        [${SURFACE_MARKER}="true"] [class*="profile-frame"],
        [${SURFACE_MARKER}="true"] [class*="nameplate"] {
            z-index: 4 !important;
        }

        ${EFFECT_LAYER_TARGET} {
            position: absolute;
            inset: 0;
            z-index: 0;
            contain: paint;
            overflow: hidden;
            pointer-events: none;
            border-radius: inherit;
            opacity: .68;
            background: transparent;
            mix-blend-mode: screen;
            --dm-profile-effect-primary: var(--dm-profile-skin-primary);
            --dm-profile-effect-secondary: var(--dm-profile-skin-secondary);
            --dm-profile-effect-panel: var(--dm-profile-skin-panel);
        }
        ${intensityTarget("subtle")} { opacity: .46; }
        ${intensityTarget("balanced")} { opacity: .68; }
        ${intensityTarget("full")} { opacity: .94; }
        ${speedTarget("slow")}::before,
        ${speedTarget("slow")}::after { animation-duration: 18s !important; }
        ${speedTarget("standard")}::before,
        ${speedTarget("standard")}::after { animation-duration: 11s !important; }
        ${speedTarget("fast")}::before,
        ${speedTarget("fast")}::after { animation-duration: 6s !important; }

        /* One widget-like shell keeps the Discord actions together. It uses
         * the active profile palette and framing language, but it deliberately
         * has no default particle layer: a clean skin must stay clean. */
        [data-dm-profile-controls-shell="true"] {
            position: relative;
            overflow: hidden;
            margin: 4px 6px;
            padding: 3px;
            border: 1px solid color-mix(in srgb, var(--dm-profile-skin-primary) 38%, rgba(255,255,255,.12));
            border-radius: 12px;
            background:
                linear-gradient(138deg, color-mix(in srgb, var(--dm-profile-skin-primary) 16%, transparent), transparent 35%),
                linear-gradient(318deg, color-mix(in srgb, var(--dm-profile-skin-secondary) 12%, transparent), transparent 46%),
                color-mix(in srgb, var(--dm-profile-skin-panel) 88%, #090d14);
            box-shadow:
                inset 0 1px 0 rgba(255,255,255,.08),
                inset 0 -12px 24px color-mix(in srgb, var(--dm-profile-skin-primary) 4%, transparent),
                0 8px 22px var(--dm-profile-skin-glow);
        }
        [data-dm-profile-controls-shell="true"]::before {
            content: "";
            position: absolute;
            inset: 0 12px auto;
            height: 1px;
            pointer-events: none;
            opacity: .9;
            background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--dm-profile-skin-primary) 78%, white) 22%, color-mix(in srgb, var(--dm-profile-skin-secondary) 72%, white) 78%, transparent);
            box-shadow: 0 0 12px color-mix(in srgb, var(--dm-profile-skin-primary) 32%, transparent);
        }
        [data-dm-profile-controls-shell="true"]::after {
            content: "";
            position: absolute;
            inset: 2px;
            pointer-events: none;
            border: 1px solid color-mix(in srgb, var(--dm-profile-skin-secondary) 10%, transparent);
            border-radius: 10px;
            opacity: .9;
        }
        [data-dm-profile-controls-shell="true"] > * {
            position: relative;
            z-index: 1;
        }

        /* The native profile gradient is the default visual language. In that
         * mode the action groups should read as part of the profile itself,
         * not as two dark cards pasted on top of it. Keep the native spacing
         * and readable row separators while removing the extra frame. */
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-shell="true"],
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-surface="true"],
        [data-dm-profile-visual-source="profile"][data-dm-profile-controls-shell="true"],
        [data-dm-profile-visual-source="profile"][data-dm-profile-controls-surface="true"] {
            margin: 2px 0 !important;
            padding: 0 !important;
            border: 0 !important;
            border-radius: 0;
            background: transparent !important;
            box-shadow: none !important;
        }
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-shell="true"]::before,
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-shell="true"]::after,
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-surface="true"]::before,
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-surface="true"]::after,
        [data-dm-profile-visual-source="profile"][data-dm-profile-controls-shell="true"]::before,
        [data-dm-profile-visual-source="profile"][data-dm-profile-controls-shell="true"]::after,
        [data-dm-profile-visual-source="profile"][data-dm-profile-controls-surface="true"]::before,
        [data-dm-profile-visual-source="profile"][data-dm-profile-controls-surface="true"]::after {
            content: none;
            display: none;
        }
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-shell="true"] [data-dm-profile-control] {
            border: 0 !important;
            border-radius: 0;
            border-left: 2px solid transparent !important;
            background: transparent !important;
            box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--dm-profile-skin-secondary) 24%, transparent);
        }
        /* If Discord changes the wrapper depth and the bounded row scan cannot
         * find a shared shell, keep the rows themselves integrated with the
         * profile gradient instead of falling back to stock dark tiles. */
        [data-dm-profile-visual-source="profile"] [data-dm-profile-control] {
            border-radius: 0;
            border-left: 2px solid transparent !important;
            background: transparent !important;
            box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--dm-profile-skin-secondary) 24%, transparent) !important;
        }
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-shell="true"] [data-dm-profile-control]:last-child {
            box-shadow: none;
        }
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-shell="true"] [data-dm-profile-control]:hover,
        [data-dm-profile-visual-source="profile"] [data-dm-profile-controls-shell="true"] [data-dm-profile-control]:focus-visible {
            border-left-color: color-mix(in srgb, var(--dm-control-accent) 86%, white) !important;
            background: linear-gradient(90deg, color-mix(in srgb, var(--dm-control-accent) 13%, transparent), transparent 72%) !important;
            box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--dm-profile-skin-secondary) 28%, transparent) !important;
        }

        /* Widget-card language is a frame treatment, not another particle
         * layer. These small rails borrow the existing DMWidget silhouettes
         * without importing its private DOM or making the clean/Still choice
         * sprout dots again. */
        [data-dm-profile-visual-source="widget"] [data-dm-profile-controls-shell="true"] {
            border-radius: 10px;
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="neonCircuit"] [data-dm-profile-controls-shell="true"]::before {
            height: 2px;
            inset-inline: 8px;
            background: repeating-linear-gradient(112deg, transparent 0 18px, color-mix(in srgb, var(--dm-profile-skin-primary) 82%, white) 19px 21px, transparent 22px 38px);
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="emberProtocol"] [data-dm-profile-controls-shell="true"]::before {
            height: 2px;
            inset-inline: 16px;
            background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--dm-profile-skin-secondary) 78%, white), color-mix(in srgb, var(--dm-profile-skin-primary) 76%, white), transparent);
            box-shadow: 0 0 15px color-mix(in srgb, var(--dm-profile-skin-primary) 38%, transparent);
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="cottonCandy"] [data-dm-profile-controls-shell="true"] {
            border-radius: 15px;
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="frostedGlass"] [data-dm-profile-controls-shell="true"] {
            background: linear-gradient(135deg, color-mix(in srgb, white 8%, transparent), color-mix(in srgb, var(--dm-profile-skin-secondary) 9%, transparent) 48%, color-mix(in srgb, var(--dm-profile-skin-panel) 90%, #090d14));
            backdrop-filter: blur(8px);
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="championRun"] [data-dm-profile-controls-shell="true"] {
            border-width: 2px;
            border-radius: 8px;
            box-shadow: inset 0 1px 0 rgba(255,255,255,.11), 0 8px 24px var(--dm-profile-skin-glow);
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="deepSpace"] [data-dm-profile-controls-shell="true"]::before {
            inset-inline: 24px;
            background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--dm-profile-skin-secondary) 70%, white), transparent);
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="voidBloom"] [data-dm-profile-controls-shell="true"] {
            border-radius: 16px 10px 16px 10px;
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="pixelOverdrive"] [data-dm-profile-controls-shell="true"] {
            border-style: dashed;
            border-radius: 7px;
        }
        [data-dm-profile-visual-source="widget"][data-dm-profile-widget-style="solarFlare"] [data-dm-profile-controls-shell="true"]::before {
            height: 2px;
            inset-inline: 4px;
            background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--dm-profile-skin-primary) 86%, white) 18%, color-mix(in srgb, var(--dm-profile-skin-secondary) 82%, white) 82%, transparent);
            box-shadow: 0 0 18px color-mix(in srgb, var(--dm-profile-skin-primary) 42%, transparent);
        }
        [data-dm-profile-control] {
            --dm-control-accent: var(--dm-profile-skin-primary);
            position: relative;
            box-sizing: border-box;
            border-radius: 8px;
            border: 1px solid transparent;
            border-left: 0;
            background: transparent;
            box-shadow: inset 2px 0 0 color-mix(in srgb, var(--dm-control-accent) 46%, transparent);
            transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, color 140ms ease;
        }
        [data-dm-profile-control="edit"] { --dm-control-accent: var(--dm-profile-skin-primary); }
        [data-dm-profile-control="status"] { --dm-control-accent: color-mix(in srgb, var(--dm-profile-skin-primary) 42%, #53d98c); }
        [data-dm-profile-control="badges"] { --dm-control-accent: color-mix(in srgb, var(--dm-profile-skin-secondary) 66%, #ffd166); }
        [data-dm-profile-control="orbs"] { --dm-control-accent: var(--dm-profile-skin-secondary); }
        [data-dm-profile-control="switchAccounts"] { --dm-control-accent: color-mix(in srgb, var(--dm-profile-skin-primary) 54%, var(--dm-profile-skin-secondary)); }
        [data-dm-profile-control="copyUserId"] { --dm-control-accent: color-mix(in srgb, var(--dm-profile-skin-secondary) 68%, white); }
        [data-dm-profile-control]:hover,
        [data-dm-profile-control]:focus-visible {
            border-color: color-mix(in srgb, var(--dm-control-accent) 22%, transparent);
            background: linear-gradient(90deg, color-mix(in srgb, var(--dm-control-accent) 10%, transparent), rgba(255,255,255,.018) 80%);
            box-shadow: inset 3px 0 0 color-mix(in srgb, var(--dm-control-accent) 72%, transparent), 0 0 0 1px color-mix(in srgb, var(--dm-control-accent) 8%, transparent);
        }
        [data-dm-profile-control]:focus-visible {
            outline: 2px solid color-mix(in srgb, var(--dm-control-accent) 72%, white);
            outline-offset: 2px;
        }

        /* The effect renderer is shared by the real popout layer and the
         * showroom layer. Each effect has a quiet atmosphere plus a moving
         * signature detail, so the preview and the result cannot drift apart.
         * Every atmosphere is mixed from the selected skin instead of
         * painting an unrelated neon preset over the user's profile. */
        ${effectTarget("aurora")} {
            background: radial-gradient(ellipse at 12% 0%, color-mix(in srgb, var(--dm-profile-effect-primary) 38%, transparent), transparent 42%), radial-gradient(ellipse at 92% 88%, color-mix(in srgb, var(--dm-profile-effect-secondary) 34%, transparent), transparent 48%), linear-gradient(118deg, color-mix(in srgb, var(--dm-profile-effect-primary) 8%, transparent), transparent 48%, color-mix(in srgb, var(--dm-profile-effect-secondary) 12%, transparent));
        }
        ${effectTarget("aurora")}::before {
            content: "";
            position: absolute;
            inset: -45%;
            background: conic-gradient(from 205deg, transparent 0 18%, color-mix(in srgb, var(--dm-profile-effect-primary) 24%, transparent) 30%, transparent 43%, color-mix(in srgb, var(--dm-profile-effect-secondary) 25%, transparent) 57%, transparent 74%);
            filter: blur(18px);
            animation: dm-profile-cosmetics-aurora 13s ease-in-out infinite alternate;
        }
        ${effectTarget("aurora")}::after {
            content: "";
            position: absolute;
            inset: -20%;
            background: linear-gradient(108deg, transparent 35%, color-mix(in srgb, white 13%, var(--dm-profile-effect-secondary)) 48%, transparent 61%);
            animation: dm-profile-cosmetics-aurora-shimmer 8s ease-in-out infinite;
        }

        ${effectTarget("emberfall")} {
            background: radial-gradient(ellipse at 82% 0%, color-mix(in srgb, var(--dm-profile-effect-primary) 42%, #ffc579 58%), transparent 44%), linear-gradient(135deg, color-mix(in srgb, var(--dm-profile-effect-panel) 90%, #180e16), color-mix(in srgb, var(--dm-profile-effect-primary) 16%, transparent) 55%, color-mix(in srgb, var(--dm-profile-effect-secondary) 12%, transparent) 86%);
        }
        ${effectTarget("emberfall")}::before {
            content: "";
            position: absolute;
            inset: -24%;
            background: repeating-linear-gradient(122deg, transparent 0 20px, color-mix(in srgb, var(--dm-profile-effect-primary) 24%, #ffd28f) 21px 22px, transparent 23px 64px);
            transform: rotate(-6deg);
            animation: dm-profile-cosmetics-embers 9s linear infinite;
        }
        ${effectTarget("emberfall")}::after {
            content: "";
            position: absolute;
            inset: -10%;
            background-image: radial-gradient(circle at 12% 22%, color-mix(in srgb, white 72%, var(--dm-profile-effect-primary)) 0 1px, transparent 2px), radial-gradient(circle at 66% 68%, color-mix(in srgb, var(--dm-profile-effect-primary) 76%, #ff8f58) 0 1px, transparent 2px), radial-gradient(circle at 84% 34%, color-mix(in srgb, var(--dm-profile-effect-secondary) 68%, #ffd06c) 0 1px, transparent 2px);
            background-size: 74px 86px, 92px 108px, 58px 72px;
            animation: dm-profile-cosmetics-ember-spark 6s linear infinite;
        }

        ${effectTarget("frost")} {
            background: radial-gradient(ellipse at 18% 0%, color-mix(in srgb, var(--dm-profile-effect-primary) 38%, white 18%), transparent 46%), radial-gradient(ellipse at 100% 100%, color-mix(in srgb, var(--dm-profile-effect-secondary) 34%, white 12%), transparent 50%), linear-gradient(145deg, color-mix(in srgb, white 9%, var(--dm-profile-effect-panel)), transparent 55%);
        }
        ${effectTarget("frost")}::before {
            content: "";
            position: absolute;
            inset: -25%;
            background: conic-gradient(from 35deg at 24% 26%, transparent 0 12%, color-mix(in srgb, white 24%, var(--dm-profile-effect-secondary)) 14%, transparent 18% 39%, color-mix(in srgb, var(--dm-profile-effect-primary) 24%, white) 41%, transparent 45% 100%);
            filter: blur(2px);
            animation: dm-profile-cosmetics-frost 16s linear infinite;
        }
        ${effectTarget("frost")}::after {
            content: "";
            position: absolute;
            inset: 0;
            background-image: radial-gradient(circle, color-mix(in srgb, white 66%, var(--dm-profile-effect-secondary)) 0 1px, transparent 1.7px), radial-gradient(circle, color-mix(in srgb, var(--dm-profile-effect-primary) 62%, white) 0 1px, transparent 1.8px);
            background-size: 34px 34px, 57px 57px;
            animation: dm-profile-cosmetics-frost-dust 18s linear infinite;
        }

        ${effectTarget("neonRain")} {
            background: linear-gradient(125deg, color-mix(in srgb, var(--dm-profile-effect-primary) 18%, transparent), color-mix(in srgb, var(--dm-profile-effect-secondary) 20%, transparent) 48%, color-mix(in srgb, var(--dm-profile-effect-primary) 10%, transparent));
        }
        ${effectTarget("neonRain")}::before {
            content: "";
            position: absolute;
            inset: -55% 0;
            background: repeating-linear-gradient(105deg, transparent 0 26px, color-mix(in srgb, var(--dm-profile-effect-secondary) 28%, white) 27px 29px, transparent 30px 64px);
            animation: dm-profile-cosmetics-rain 10s linear infinite;
        }
        ${effectTarget("neonRain")}::after {
            content: "";
            position: absolute;
            inset: -30% -20%;
            background: linear-gradient(90deg, transparent 40%, color-mix(in srgb, white 18%, var(--dm-profile-effect-primary)) 48%, transparent 56%);
            transform: rotate(-12deg);
            animation: dm-profile-cosmetics-neon-scan 7s ease-in-out infinite;
        }

        ${effectTarget("roseDrift")} {
            background: radial-gradient(ellipse at 18% 18%, color-mix(in srgb, var(--dm-profile-effect-primary) 42%, #ffb9cf 30%), transparent 42%), radial-gradient(ellipse at 82% 74%, color-mix(in srgb, var(--dm-profile-effect-secondary) 34%, white 20%), transparent 44%), linear-gradient(135deg, color-mix(in srgb, var(--dm-profile-effect-primary) 15%, transparent), color-mix(in srgb, var(--dm-profile-effect-secondary) 7%, transparent) 58%, transparent);
        }
        ${effectTarget("roseDrift")}::before {
            content: "";
            position: absolute;
            inset: -30%;
            background: radial-gradient(ellipse at 35% 30%, color-mix(in srgb, var(--dm-profile-effect-primary) 27%, #ff9fbe), transparent 34%), radial-gradient(ellipse at 72% 68%, color-mix(in srgb, var(--dm-profile-effect-secondary) 23%, white), transparent 30%);
            filter: blur(12px);
            animation: dm-profile-cosmetics-rose 14s ease-in-out infinite alternate;
        }
        ${effectTarget("roseDrift")}::after {
            content: "";
            position: absolute;
            inset: -10%;
            background-image: radial-gradient(ellipse 5px 3px at 18% 28%, color-mix(in srgb, white 70%, var(--dm-profile-effect-primary)) 0 45%, transparent 50%), radial-gradient(ellipse 4px 2px at 70% 64%, color-mix(in srgb, var(--dm-profile-effect-primary) 65%, white) 0 45%, transparent 50%), radial-gradient(ellipse 3px 5px at 84% 22%, color-mix(in srgb, var(--dm-profile-effect-secondary) 62%, white) 0 45%, transparent 50%);
            background-size: 86px 92px, 112px 126px, 74px 88px;
            animation: dm-profile-cosmetics-rose-petal 12s ease-in-out infinite;
        }

        ${effectTarget("starlight")} {
            background: radial-gradient(ellipse at 20% 14%, color-mix(in srgb, var(--dm-profile-effect-primary) 28%, white 8%), transparent 40%), radial-gradient(ellipse at 86% 78%, color-mix(in srgb, var(--dm-profile-effect-secondary) 28%, white 8%), transparent 44%), linear-gradient(145deg, color-mix(in srgb, white 5%, var(--dm-profile-effect-panel)), transparent 55%);
        }
        ${effectTarget("starlight")}::before {
            content: "";
            position: absolute;
            inset: -20%;
            background-image: radial-gradient(circle, color-mix(in srgb, white 82%, var(--dm-profile-effect-secondary)) 0 1px, transparent 1.7px), radial-gradient(circle, color-mix(in srgb, var(--dm-profile-effect-primary) 68%, white) 0 1px, transparent 1.8px);
            background-size: 44px 44px, 71px 71px;
            animation: dm-profile-cosmetics-stars 12s ease-in-out infinite;
        }
        ${effectTarget("starlight")}::after {
            content: "";
            position: absolute;
            inset: -25%;
            background: linear-gradient(115deg, transparent 38%, color-mix(in srgb, white 18%, var(--dm-profile-effect-secondary)) 50%, transparent 62%);
            animation: dm-profile-cosmetics-star-sweep 9s ease-in-out infinite;
        }

        ${effectTarget("inkBloom")} {
            background: radial-gradient(ellipse at 18% 78%, color-mix(in srgb, var(--dm-profile-effect-primary) 38%, transparent), transparent 42%), radial-gradient(ellipse at 82% 22%, color-mix(in srgb, var(--dm-profile-effect-secondary) 34%, transparent), transparent 44%), linear-gradient(135deg, color-mix(in srgb, var(--dm-profile-effect-panel) 88%, #100e24), transparent 60%);
        }
        ${effectTarget("inkBloom")}::before {
            content: "";
            position: absolute;
            inset: -28%;
            background: radial-gradient(ellipse at 30% 40%, color-mix(in srgb, var(--dm-profile-effect-primary) 30%, transparent), transparent 28%), radial-gradient(ellipse at 65% 58%, color-mix(in srgb, var(--dm-profile-effect-secondary) 25%, transparent), transparent 30%);
            filter: blur(20px);
            animation: dm-profile-cosmetics-ink 15s ease-in-out infinite alternate;
        }
        ${effectTarget("inkBloom")}::after {
            content: "";
            position: absolute;
            inset: -20%;
            background: repeating-linear-gradient(164deg, transparent 0 34px, color-mix(in srgb, var(--dm-profile-effect-secondary) 18%, white) 35px 36px, transparent 37px 80px);
            animation: dm-profile-cosmetics-ink-ripple 13s ease-in-out infinite;
        }

        ${effectTarget("gildedDust")} {
            background: linear-gradient(135deg, color-mix(in srgb, var(--dm-profile-effect-primary) 24%, #ffdc91), color-mix(in srgb, var(--dm-profile-effect-panel) 88%, #241a10) 48%, color-mix(in srgb, var(--dm-profile-effect-secondary) 20%, #ffb85e));
        }
        ${effectTarget("gildedDust")}::before {
            content: "";
            position: absolute;
            inset: -40%;
            background-image: radial-gradient(circle, color-mix(in srgb, var(--dm-profile-effect-primary) 78%, #fff0b0) 0 1px, transparent 1.8px), radial-gradient(circle, color-mix(in srgb, var(--dm-profile-effect-secondary) 56%, #fff7d2) 0 1px, transparent 1.8px);
            background-size: 36px 36px, 64px 58px;
            animation: dm-profile-cosmetics-gild 10s linear infinite;
        }
        ${effectTarget("gildedDust")}::after {
            content: "";
            position: absolute;
            inset: -25%;
            background: linear-gradient(115deg, transparent 35%, color-mix(in srgb, white 22%, var(--dm-profile-effect-primary)) 48%, transparent 59%);
            animation: dm-profile-cosmetics-gild-glint 9s ease-in-out infinite;
        }

        ${pausedTarget}::before,
        ${pausedTarget}::after {
            animation-play-state: paused !important;
        }

        @keyframes dm-profile-cosmetics-aurora {
            from { transform: translate3d(-8%, -3%, 0) rotate(-5deg) scale(1); }
            50% { transform: translate3d(3%, 4%, 0) rotate(5deg) scale(1.05); }
            to { transform: translate3d(10%, 7%, 0) rotate(10deg) scale(1.1); }
        }
        @keyframes dm-profile-cosmetics-aurora-shimmer {
            from { transform: translate3d(-35%, 4%, 0) rotate(8deg); opacity: .2; }
            50% { opacity: .65; }
            to { transform: translate3d(35%, -3%, 0) rotate(8deg); opacity: .22; }
        }
        @keyframes dm-profile-cosmetics-embers {
            from { background-position: 0 0; opacity: .35; }
            to { background-position: 64px 96px; opacity: .9; }
        }
        @keyframes dm-profile-cosmetics-ember-spark {
            from { transform: translate3d(0, -12%, 0); opacity: .35; }
            50% { opacity: .86; }
            to { transform: translate3d(3%, 14%, 0); opacity: .3; }
        }
        @keyframes dm-profile-cosmetics-frost {
            from { transform: translate3d(-5%, -3%, 0) rotate(0deg); }
            to { transform: translate3d(8%, 6%, 0) rotate(6deg); }
        }
        @keyframes dm-profile-cosmetics-frost-dust {
            from { background-position: 0 0, 0 0; opacity: .4; }
            50% { opacity: .86; }
            to { background-position: 34px 52px, -57px 71px; opacity: .46; }
        }
        @keyframes dm-profile-cosmetics-rain {
            from { transform: translate3d(0, -18%, 0); }
            to { transform: translate3d(0, 18%, 0); }
        }
        @keyframes dm-profile-cosmetics-neon-scan {
            from { transform: translate3d(-34%, 2%, 0) rotate(-12deg); opacity: .15; }
            50% { opacity: .72; }
            to { transform: translate3d(34%, -2%, 0) rotate(-12deg); opacity: .16; }
        }
        @keyframes dm-profile-cosmetics-rose {
            from { transform: translate3d(-5%, 3%, 0) rotate(-3deg) scale(1); }
            to { transform: translate3d(7%, -4%, 0) rotate(5deg) scale(1.1); }
        }
        @keyframes dm-profile-cosmetics-rose-petal {
            from { transform: translate3d(-4%, -3%, 0) rotate(-2deg); opacity: .35; }
            50% { opacity: .78; }
            to { transform: translate3d(7%, 9%, 0) rotate(8deg); opacity: .4; }
        }
        @keyframes dm-profile-cosmetics-stars {
            from { transform: translate3d(-10%, 5%, 0); opacity: .5; }
            50% { opacity: .98; }
            to { transform: translate3d(10%, -5%, 0); opacity: .64; }
        }
        @keyframes dm-profile-cosmetics-star-sweep {
            from { transform: translate3d(-38%, 4%, 0) rotate(8deg); opacity: .12; }
            50% { opacity: .66; }
            to { transform: translate3d(38%, -4%, 0) rotate(8deg); opacity: .12; }
        }
        @keyframes dm-profile-cosmetics-ink {
            from { transform: translate3d(-6%, 4%, 0) scale(.96); }
            to { transform: translate3d(7%, -5%, 0) scale(1.12); }
        }
        @keyframes dm-profile-cosmetics-ink-ripple {
            from { transform: translate3d(-6%, 3%, 0) rotate(-2deg); opacity: .18; }
            50% { opacity: .58; }
            to { transform: translate3d(8%, -4%, 0) rotate(3deg); opacity: .2; }
        }
        @keyframes dm-profile-cosmetics-gild {
            from { transform: translate3d(-5%, -5%, 0); }
            to { transform: translate3d(8%, 8%, 0); }
        }
        @keyframes dm-profile-cosmetics-gild-glint {
            from { transform: translate3d(-38%, 5%, 0) rotate(8deg); opacity: .12; }
            50% { opacity: .64; }
            to { transform: translate3d(38%, -5%, 0) rotate(8deg); opacity: .12; }
        }

        @media (prefers-reduced-motion: reduce) {
            ${EFFECT_LAYER_TARGET}::before,
            ${EFFECT_LAYER_TARGET}::after {
                animation: none !important;
            }
            [data-dm-profile-control] { transition: none; }
        }

        /* Keep the live card in view while the catalog is being browsed. A
         * single-column fallback keeps the settings panel usable at narrow
         * widths and avoids forcing horizontal scrolling. */
        .dm-profile-showroom-main {
            grid-column: 1 / -1;
            display: grid;
            grid-template-columns: minmax(220px, 1.05fr) minmax(260px, .95fr);
            gap: 12px;
            align-items: start;
        }
        .dm-profile-showroom-preview {
            grid-column: 1;
            position: sticky;
            top: 12px;
            align-self: start;
        }
        .dm-profile-showroom-motion,
        .dm-profile-showroom-catalog {
            grid-column: 2;
            min-width: 0;
        }
        .dm-profile-showroom-catalog {
            align-self: start;
            max-height: min(68vh, 640px);
            overflow-y: auto;
            padding-right: 4px;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,.25) transparent;
        }
        @media (max-width: 720px) {
            .dm-profile-showroom-root,
            .dm-profile-showroom-main { grid-template-columns: minmax(0, 1fr) !important; }
            .dm-profile-showroom-preview,
            .dm-profile-showroom-motion,
            .dm-profile-showroom-catalog {
                grid-column: 1;
            }
            .dm-profile-showroom-preview { position: relative; top: auto; }
            .dm-profile-showroom-catalog {
                max-height: none;
                overflow-y: visible;
                padding-right: 0;
            }
        }
    `;
}

function onTournamentModeChange(): void {
    scheduleReconcile(0);
}

function onReducedMotionChange(): void {
    scheduleReconcile(0);
}

function scheduleAfterSettingsChange(): void {
    if (style) style.textContent = buildCss();
    scheduleReconcile(0);
}

const EFFECT_OPTIONS: readonly EffectPreset[] = ["none", "aurora", "emberfall", "frost", "neonRain", "roseDrift", "starlight", "inkBloom", "gildedDust"];
const INTENSITY_OPTIONS: readonly EffectIntensity[] = ["subtle", "balanced", "full"];
const SPEED_OPTIONS: readonly EffectSpeed[] = ["slow", "standard", "fast"];

function ProfileCosmeticsShowroom() {
    const [, forceRender] = React.useState(0);
    const [family, setFamily] = React.useState<(typeof PROFILE_SKIN_FAMILIES)[number]["id"]>("all");
    const [query, setQuery] = React.useState("");
    const [widgetStyleOverride, setWidgetStyleOverride] = React.useState<string | null>(null);
    React.useEffect(() => {
        const syncMotionState = () => forceRender(value => value + 1);
        window.addEventListener("discordmaxxer:tournament-mode-changed", syncMotionState);
        motionQuery?.addEventListener?.("change", syncMotionState);
        return () => {
            window.removeEventListener("discordmaxxer:tournament-mode-changed", syncMotionState);
            motionQuery?.removeEventListener?.("change", syncMotionState);
        };
    }, []);
    const live = settings.use([
        "controlsSkin", "localEffects", "skinPreset", "visualSource", "profileWidgetStyle", "effectPreset", "effectIntensity", "effectSpeed", "pauseInTournamentMode", "respectReducedMotion"
    ]);
    const previewPaused = showroomMotionPaused();
    const tournamentPaused = readSetting("pauseInTournamentMode", true) && tournamentModeActive();
    const baseSkin = profileSkin(String(live.skinPreset ?? DEFAULT_PROFILE_SKIN));
    const visualSource = effectiveVisualSource();
    // Keep the surrounding profile preview on the same profile-only snapshot
    // as the widget-inspired controls below. The snapshot shares the palette
    // definitions with DMWidget but never writes DMWidget's active selection.
    const profileWidgetId = widgetStyleOverride
        ?? validWidgetStyleId(live.profileWidgetStyle)
        ?? profileWidgetStyleId();
    const skin = visualSource === "widget"
        ? widgetStyleVisual(profileWidgetId)
        : resolveProfileVisual(baseSkin, visualSource);
    const widgetStyle = visualSource === "widget" ? widgetStyleVisual(profileWidgetId) : null;
    const effect = EFFECT_OPTIONS.includes(String(live.effectPreset) as EffectPreset)
        ? String(live.effectPreset) as EffectPreset
        : "aurora";
    const intensity = INTENSITY_OPTIONS.includes(String(live.effectIntensity) as EffectIntensity)
        ? String(live.effectIntensity) as EffectIntensity
        : "balanced";
    const speed = SPEED_OPTIONS.includes(String(live.effectSpeed) as EffectSpeed)
        ? String(live.effectSpeed) as EffectSpeed
        : "standard";
    const localEffects = live.localEffects !== false;
    const cleanQuery = query.trim().toLowerCase();
    const profileIntegrated = visualSource === "profile";
    const visiblePresets = PROFILE_SKIN_PRESETS.filter(preset => {
        const familyMatch = family === "all" || preset.family === family;
        const queryMatch = !cleanQuery || `${preset.name} ${preset.family} ${preset.blurb}`.toLowerCase().includes(cleanQuery);
        return familyMatch && queryMatch;
    });

    const visualSourceOptions: Array<{ value: ProfileVisualSource; label: string; detail: string }> = [
        { value: "profile", label: "Profile gradient (default)", detail: skin.id === "profileGradient"
            ? `Use the exact native hex palette · ${skin.primary} → ${skin.secondary}`
            : "Use the native gradient when available" },
        { value: "skin", label: "Original palette", detail: `Browse the ${PROFILE_SKIN_PRESETS.length} local skins` },
        { value: "widget", label: "Widget card", detail: widgetStyle ? `Profile-only snapshot · ${widgetStyle.name}` : "Use a profile-only widget-inspired snapshot" }
    ];

    const setPreference = (key: string, value: unknown) => {
        (settings.store as Record<string, unknown>)[key] = value;
        forceRender(value => value + 1);
    };
    const chooseWidgetStyle = (styleId: string) => {
        const preset = widgetStylePreset(styleId);
        setWidgetStyleOverride(preset.id);
        // This is a profile-only snapshot. It intentionally does not call
        // DMWidget's setter: browsing cosmetics must never rewrite Fortnite,
        // Valorant, or another attached widget's saved skin.
        setPreference("profileWidgetStyle", preset.id);
    };
    const segmentedButton = (label: string, value: string, selected: boolean, onClick: () => void, key: string) => React.createElement("button", {
        key,
        type: "button",
        "data-dm-profile-cosmetics-showroom": "true",
        "aria-pressed": selected,
        onClick,
        style: {
            border: `1px solid ${selected ? skin.primary : "rgba(255,255,255,0.14)"}`,
            borderRadius: 999,
            padding: "5px 9px",
            background: selected ? hexToRgba(skin.primary, .17) : "rgba(0,0,0,.2)",
            color: selected ? "#fff" : "#cbd0e0",
            fontSize: 10.5,
            fontWeight: selected ? 750 : 550,
            cursor: "pointer",
            transition: "border-color 140ms ease, background 140ms ease, color 140ms ease"
        }
    }, label);
    const actionRow = (label: string, icon: string, accent: string, key: string) => React.createElement("div", {
        key,
        style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 27,
            padding: "4px 7px",
            borderRadius: 7,
            border: profileIntegrated ? "0" : `1px solid ${hexToRgba(skin.primary, .16)}`,
            borderLeft: profileIntegrated ? `2px solid ${accent}` : `3px solid ${accent}`,
            background: profileIntegrated ? "transparent" : "rgba(255,255,255,.035)",
            boxShadow: profileIntegrated ? `inset 0 -1px 0 ${hexToRgba(skin.secondary, .24)}` : "none",
            color: "#edf0f7",
            fontSize: 11.5,
            fontWeight: 650
        }
    }, React.createElement("span", { style: { color: accent, width: 14, textAlign: "center" } }, icon), label);

    const effectLabels: Record<EffectIntensity, string> = { subtle: "Subtle", balanced: "Balanced", full: "Full" };
    const speedLabels: Record<EffectSpeed, string> = { slow: "Slow", standard: "Standard", fast: "Fast" };
    const effectPicker = React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        EFFECT_OPTIONS.map(option => segmentedButton(effectLabel(option), option, effect === option, () => setPreference("effectPreset", option), `effect-${option}`))
    );
    const intensityPicker = React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        INTENSITY_OPTIONS.map(option => segmentedButton(effectLabels[option], option, intensity === option, () => setPreference("effectIntensity", option), `intensity-${option}`))
    );
    const speedPicker = React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        SPEED_OPTIONS.map(option => segmentedButton(speedLabels[option], option, speed === option, () => setPreference("effectSpeed", option), `speed-${option}`))
    );
    const previewStatus = previewPaused
        ? (tournamentPaused ? "Tournament paused" : "Reduced motion")
        : effect === "none"
            ? "Still · no particles"
            : `Live · ${speedLabels[speed]}`;

    return React.createElement(
        "div",
        {
            className: "dm-profile-showroom-root",
            "data-dm-profile-cosmetics-showroom": "true",
            style: {
                // Keep the outer shell a normal block. The preview/catalog
                // rail below owns the only grid; making the settings shell a
                // grid too lets Discord's settings CSS create narrow implicit
                // tracks and collapse the copy to one word per line.
                display: "block",
                gap: 12,
                marginTop: 10,
                padding: 13,
                borderRadius: 12,
                border: `1px solid ${hexToRgba(skin.primary, .28)}`,
                background: `linear-gradient(135deg, ${hexToRgba(skin.primary, .1)}, ${hexToRgba(skin.secondary, .06)} 52%, rgba(8, 12, 20, .28))`,
                color: "#f2f3f5"
            }
        },
        React.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, gridColumn: "1 / -1" } },
            React.createElement("div", { style: { fontSize: 14, fontWeight: 800 } }, "✦ Profile cosmetics showroom"),
            React.createElement("span", { style: { fontSize: 10.5, color: skin.secondary, fontWeight: 750 } }, visualSource === "profile"
                ? "native profile gradient · live preview"
                : visualSource === "widget"
                    ? `${widgetStyle?.name ?? "widget card"} language · live preview`
                    : `${PROFILE_SKIN_PRESETS.length} original skins · live preview`)
        ),
        React.createElement("div", { style: { marginTop: 5, fontSize: 11.5, lineHeight: 1.45, color: "#cbd0e0", gridColumn: "1 / -1" } },
            "Pick the visual language first, then tune the effect beside it. The preview stays in view while you browse and uses the same skin, finish, speed, and motion safeguards as the real profile popout."
        ),
        React.createElement("div", {
            className: "dm-profile-showroom-main",
            style: {
                marginTop: 12,
                gridColumn: "1 / -1"
            }
        },
        React.createElement("div", {
            className: `dm-profile-preview-card dm-profile-showroom-preview${widgetStyle ? " dm-widget-style-preview" : ""}`,
            "data-dm-profile-skin": skin.id,
            "data-dm-profile-skin-family": skin.family,
            "data-dm-profile-visual-source": visualSource,
            ...(visualSource === "profile" && skin.id === "profileGradient" ? {
                "data-dm-profile-gradient-primary": skin.primary,
                "data-dm-profile-gradient-secondary": skin.secondary
            } : {}),
            ...(widgetStyle ? {
                "data-dm-profile-widget-style": widgetStyle.widgetStyle.id,
                "data-dm-widget-card-root": "true",
                // The showroom is an intentional live preview. The shared
                // DMWidget stylesheet keeps real cards quiet when Discord is
                // idle, but should not freeze this card while it is being
                // used to compare presets.
                "data-dm-widget-preview": "true",
                "data-dm-widget-skin": widgetStyle.widgetStyle.id,
                "data-dm-widget-frame": widgetStyle.widgetStyle.frame,
                "data-dm-widget-ornament": widgetStyle.widgetStyle.ornament,
                "data-dm-widget-motion": widgetStyle.widgetStyle.motion,
                "data-dm-widget-motion-paused": previewPaused ? "true" : "false",
                "data-dm-widget-app-id": "dm-profile-cosmetics-preview",
                "data-dm-widget-top-layout": widgetStyle.widgetStyle.topLayout,
                "data-dm-widget-bottom-layout": widgetStyle.widgetStyle.bottomLayout,
                "data-style": widgetStyle.widgetStyle.id,
                "data-motion": widgetStyle.widgetStyle.motion,
                "data-motion-paused": previewPaused ? "true" : "false",
                "data-frame": widgetStyle.widgetStyle.frame,
                "data-ornament": widgetStyle.widgetStyle.ornament
            } : {}),
            "data-dm-profile-effect": effect,
            "data-dm-profile-effect-intensity": intensity,
            "data-dm-profile-effect-speed": speed,
            style: {
                overflow: "hidden",
                minHeight: 305,
                borderRadius: 13,
                border: `1px solid ${hexToRgba(skin.primary, .56)}`,
                background: visualSource === "profile"
                    ? `linear-gradient(180deg, ${skin.primary} 0%, ${skin.secondary} 100%)`
                    : `linear-gradient(160deg, ${skin.panel}, #0c1119)`,
                boxShadow: `0 10px 28px ${hexToRgba(skin.primary, .13)}`,
                position: "relative",
                isolation: "isolate",
                "--dm-profile-skin-primary": skin.primary,
                "--dm-profile-skin-secondary": skin.secondary,
                "--dm-profile-skin-panel": skin.panel,
                "--dm-profile-skin-glow": skin.glow,
                "--dm-profile-widget-style": widgetStyle?.widgetStyle.id ?? "",
                ...(widgetStyle ? {
                    "--dmw-skin-accent": widgetStyle.widgetStyle.accent,
                    "--dmw-skin-secondary": widgetStyle.widgetStyle.secondary,
                    "--dmw-skin-surface": widgetStyle.widgetStyle.surface
                } : {})
            } as React.CSSProperties
        },
        React.createElement("div", {
            className: "dm-profile-preview-effect",
            "data-paused": previewPaused ? "true" : "false",
            "aria-hidden": "true"
        }),
        React.createElement("div", {
            style: {
                position: "relative",
                zIndex: 1,
                height: 76,
                overflow: "hidden",
                background: visualSource === "profile" ? "transparent" : `linear-gradient(120deg, ${skin.primary}cc, ${skin.secondary}75 52%, #0b1018)`,
                borderBottom: `1px solid ${hexToRgba(skin.primary, .38)}`
            }
        },
        React.createElement("span", { style: { position: "absolute", zIndex: 2, left: 11, top: 9, fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,.9)" } }, skin.name),
        React.createElement("span", { style: { position: "absolute", zIndex: 2, right: 10, top: 9, padding: "3px 6px", borderRadius: 999, background: "rgba(0,0,0,.3)", color: "#fff", fontSize: 9 } }, previewStatus)
        ),
        React.createElement("div", { style: { position: "relative", zIndex: 1, padding: "0 12px 12px" } },
            React.createElement("div", {
                style: {
                    width: 55,
                    height: 55,
                    marginTop: -25,
                    borderRadius: "50%",
                    border: `3px solid ${skin.panel}`,
                    background: `radial-gradient(circle at 35% 30%, ${skin.secondary}, ${skin.primary} 47%, #151b29 48%)`,
                    boxShadow: `0 0 0 2px ${hexToRgba(skin.primary, .68)}, 0 0 18px ${skin.glow}`,
                    display: "grid",
                    placeItems: "center",
                    color: "#11151f",
                    fontWeight: 900,
                    fontSize: 18
                }
            }, "D"),
            React.createElement("div", { style: { marginTop: 7, fontSize: 15, fontWeight: 850 } }, "Diggy T"),
            React.createElement("div", { style: { marginTop: 2, color: skin.secondary, fontSize: 10.5 } }, "unique profile surface · live preview"),
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: profileIntegrated ? "1fr" : "1fr 1fr", gap: 7, marginTop: 10 } },
                React.createElement("div", { style: { padding: profileIntegrated ? 0 : 7, borderRadius: 9, border: profileIntegrated ? "0" : `1px solid ${hexToRgba(skin.primary, .18)}`, background: profileIntegrated ? "transparent" : "rgba(255,255,255,.035)" } },
                    React.createElement("div", { style: { display: profileIntegrated ? "none" : "block", fontSize: 9, color: "#9da7bc", textTransform: "uppercase", letterSpacing: ".08em" } }, "Primary group"),
                    React.createElement("div", { style: { display: "grid", gap: 4, marginTop: 5 } },
                        actionRow("Edit Profile", "✎", skin.primary, "preview-edit"),
                        actionRow("Online", "●", "#53d98c", "preview-status"),
                        actionRow("Badges", "✥", skin.secondary, "preview-badges"),
                        actionRow("0 Orbs", "◇", skin.primary, "preview-orbs")
                    )
                ),
                React.createElement("div", { style: { padding: profileIntegrated ? 0 : 7, borderRadius: 9, border: profileIntegrated ? "0" : `1px solid ${hexToRgba(skin.secondary, .18)}`, background: profileIntegrated ? "transparent" : "rgba(255,255,255,.035)" } },
                    React.createElement("div", { style: { display: profileIntegrated ? "none" : "block", fontSize: 9, color: "#9da7bc", textTransform: "uppercase", letterSpacing: ".08em" } }, "Secondary group"),
                    React.createElement("div", { style: { display: "grid", gap: 4, marginTop: 5 } },
                        actionRow("Switch Accounts", "⇄", skin.secondary, "preview-switch"),
                        actionRow("Copy User ID", "ID", skin.primary, "preview-copy")
                    )
                )
            )
        )
        ),
        React.createElement("div", {
            className: "dm-profile-showroom-motion",
            style: {
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: 11,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,.11)",
                background: "rgba(5, 8, 14, .22)"
            }
        },
            React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
                React.createElement("div", { style: { fontSize: 12, fontWeight: 800 } }, "Motion & finish"),
                React.createElement("span", { style: { fontSize: 10, color: previewPaused ? "#ffd166" : "#79e2a4" } }, tournamentPaused ? "Tournament paused" : previewPaused ? "Reduced motion" : "Live motion")
            ),
            React.createElement("div", { style: { fontSize: 11, lineHeight: 1.35, color: "#aeb8ca", marginTop: 2 } }, "Visual language"),
            React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
                visualSourceOptions.map(option => segmentedButton(option.label, option.value, visualSource === option.value, () => setPreference("visualSource", option.value), `visual-source-${option.value}`))
            ),
            React.createElement("div", { style: { fontSize: 10.5, lineHeight: 1.35, color: "#8f9aaf" } }, visualSourceOptions.find(option => option.value === visualSource)?.detail),
            visualSource === "profile" && skin.id === "profileGradient" && React.createElement("div", {
                style: {
                    padding: "7px 8px",
                    borderRadius: 8,
                    border: `1px solid ${hexToRgba(skin.primary, .28)}`,
                    background: `linear-gradient(100deg, ${hexToRgba(skin.primary, .13)}, ${hexToRgba(skin.secondary, .11)})`,
                    color: "#dce6f8",
                    fontSize: 10.5,
                    lineHeight: 1.35
                }
            },
                React.createElement("strong", { style: { color: skin.primary } }, "Exact profile palette · "),
                `${skin.primary} → ${skin.secondary}`
            ),
            visualSource === "widget" && widgetStyle && React.createElement("div", {
                role: "group",
                "aria-label": "Choose widget skin",
                style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 7,
                    padding: 8,
                    borderRadius: 9,
                    border: `1px solid ${hexToRgba(widgetStyle.widgetStyle.accent, .3)}`,
                    background: `linear-gradient(135deg, ${hexToRgba(widgetStyle.widgetStyle.surface, .72)}, ${hexToRgba(widgetStyle.widgetStyle.accent, .08)})`
                }
            },
                React.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 } },
                    React.createElement("span", { style: { fontSize: 11, fontWeight: 800 } }, "Widget-inspired profile skin · independent"),
                    React.createElement("span", { style: { fontSize: 9.5, color: widgetStyle.widgetStyle.secondary, fontWeight: 750 } }, widgetStyle.widgetStyle.id)
                ),
                React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 } },
                    WIDGET_STYLE_PRESETS.map(preset => {
                        const selected = preset.id === widgetStyle.widgetStyle.id;
                        return React.createElement("button", {
                            key: `widget-style-${preset.id}`,
                            type: "button",
                            "data-dm-profile-cosmetics-showroom": "true",
                            "data-dm-widget-style-choice": preset.id,
                            "aria-label": `Use ${preset.name} widget skin`,
                            "aria-pressed": selected,
                            onClick: () => chooseWidgetStyle(preset.id),
                            style: {
                                minWidth: 0,
                                minHeight: 48,
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                padding: "7px 8px",
                                textAlign: "left",
                                borderRadius: 8,
                                border: `1px solid ${selected ? preset.accent : "rgba(255,255,255,.12)"}`,
                                background: selected
                                    ? `linear-gradient(135deg, ${hexToRgba(preset.surface, .95)}, ${hexToRgba(preset.accent, .2)} 58%, ${hexToRgba(preset.secondary, .17)})`
                                    : "rgba(0,0,0,.16)",
                                boxShadow: selected ? `0 0 0 1px ${hexToRgba(preset.accent, .24)}, 0 0 12px ${hexToRgba(preset.accent, .16)}` : "none",
                                color: "#f2f3f5",
                                cursor: "pointer"
                            }
                        },
                            React.createElement("span", {
                                "aria-hidden": "true",
                                style: {
                                    width: 27,
                                    height: 27,
                                    flex: "0 0 auto",
                                    display: "grid",
                                    placeItems: "center",
                                    borderRadius: 7,
                                    background: `linear-gradient(135deg, ${preset.surface}, ${hexToRgba(preset.accent, .55)} 58%, ${hexToRgba(preset.secondary, .62)})`,
                                    border: `1px solid ${hexToRgba(preset.accent, .48)}`,
                                    color: "#fff",
                                    fontSize: 14,
                                    boxShadow: `0 0 8px ${hexToRgba(preset.accent, .22)}`
                                }
                            }, preset.glyph),
                            React.createElement("span", { style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } },
                                React.createElement("span", { style: { fontSize: 10.5, fontWeight: 750, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, `${selected ? "✓ " : ""}${preset.name}`),
                                React.createElement("span", { style: { fontSize: 9, color: "#aeb8ca", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, preset.mood)
                            )
                        );
                    })
                ),
                React.createElement("div", { style: { fontSize: 10, lineHeight: 1.35, color: "#8f9aaf" } },
                    `Profile snapshot: ${widgetStyle.widgetStyle.name} · ${widgetStyle.widgetStyle.accent} → ${widgetStyle.widgetStyle.secondary}. This uses the shared widget palette without changing Fortnite or other attached widget cards.`
                )
            ),
            React.createElement("div", { style: { fontSize: 11, lineHeight: 1.35, color: "#aeb8ca" } }, `Effect · ${effectLabel(effect)}`),
            effectPicker,
            React.createElement("div", { style: { fontSize: 11, lineHeight: 1.35, color: "#aeb8ca", marginTop: 2 } }, `Intensity · ${effectLabels[intensity]}`),
            intensityPicker,
            React.createElement("div", { style: { fontSize: 11, lineHeight: 1.35, color: "#aeb8ca", marginTop: 2 } }, `Speed · ${speedLabels[speed]}`),
            speedPicker,
            React.createElement("button", {
                type: "button",
                "data-dm-profile-cosmetics-showroom": "true",
                onClick: () => setPreference("localEffects", !localEffects),
                style: {
                    marginTop: 2,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${localEffects ? skin.primary : "rgba(255,255,255,.15)"}`,
                    background: localEffects ? hexToRgba(skin.primary, .14) : "rgba(0,0,0,.2)",
                    color: localEffects ? "#fff" : "#cbd0e0",
                    fontSize: 11,
                    fontWeight: 750,
                    cursor: "pointer",
                    textAlign: "left"
                }
            }, localEffects ? "✓ Effects enabled on profile popouts" : "Enable this effect on profile popouts"),
            React.createElement("div", { style: { fontSize: 10.5, lineHeight: 1.35, color: "#8f9aaf" } },
                "These are the live controls. The preview uses the same skin, effect, intensity, speed, and motion safeguards as profile popouts, so Tournament Mode and reduced motion pause both instead of showing a misleading animation."
            )
        )
        ),
        React.createElement("div", { className: "dm-profile-showroom-catalog" },
        React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" } },
            React.createElement("div", { style: { fontSize: 12.5, fontWeight: 800 } }, "Choose an action-group skin"),
            React.createElement("input", {
                type: "search",
                value: query,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.currentTarget.value),
                placeholder: "Search roses, snow, neon...",
                "aria-label": "Search profile skins",
                style: { minWidth: 160, flex: "1 1 180px", maxWidth: 250, padding: "7px 9px", borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(0,0,0,.25)", color: "#f2f3f5", fontSize: 11 }
            })
        ),
        React.createElement("div", { role: "group", "aria-label": "Filter profile skins", style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 } },
            PROFILE_SKIN_FAMILIES.map(item => segmentedButton(`${item.label} · ${item.id === "all" ? PROFILE_SKIN_PRESETS.length : PROFILE_SKIN_PRESETS.filter(preset => preset.family === item.id).length}`, item.id, family === item.id, () => setFamily(item.id), `family-${item.id}`))
        ),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 7, marginTop: 9 } },
            visiblePresets.map(preset => {
                const active = preset.id === baseSkin.id;
                return React.createElement("button", {
                    key: preset.id,
                    type: "button",
                    "data-dm-profile-cosmetics-showroom": "true",
                    "aria-pressed": active,
                    "aria-label": `${preset.name}: ${preset.blurb}`,
                    title: preset.blurb,
                    onClick: () => setPreference("skinPreset", preset.id),
                    style: {
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: 5,
                        minHeight: 78,
                        padding: "8px 9px",
                        textAlign: "left",
                        borderRadius: 9,
                        border: `1px solid ${active ? preset.primary : "rgba(255,255,255,.13)"}`,
                        boxShadow: active ? `0 0 0 2px ${preset.primary}33, 0 0 15px ${preset.glow}` : "none",
                        background: active ? `linear-gradient(135deg, ${preset.panel}, ${preset.primary}18)` : "rgba(0,0,0,.18)",
                        color: "#f2f3f5",
                        cursor: "pointer",
                        transition: "border-color 140ms ease, box-shadow 140ms ease"
                    }
                },
                React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 750 } },
                    React.createElement("span", { style: { width: 22, height: 10, borderRadius: 999, background: `linear-gradient(90deg, ${preset.primary}, ${preset.secondary})`, boxShadow: `0 0 9px ${preset.glow}` } }),
                    `${active ? "✓ " : ""}${preset.name}`
                ),
                React.createElement("span", { style: { fontSize: 10, color: "#aeb8ca", lineHeight: 1.25 } }, preset.blurb)
                );
            })
        ),
        visiblePresets.length === 0 && React.createElement("div", { style: { padding: 12, borderRadius: 8, color: "#aeb8ca", background: "rgba(0,0,0,.18)", fontSize: 11 } }, "No skins match that search yet. Try a mood, color, or motif.")
        )
    );
}

const settings = definePluginSettings({
    showroom: {
        type: OptionType.COMPONENT,
        description: "",
        component: ProfileCosmeticsShowroom
    },
    controlsSkin: {
        type: OptionType.BOOLEAN,
        description: "Skin both profile popout action groups (Edit Profile, status, Badges, Orbs, Switch Accounts, and Copy User ID) while keeping Discord's native actions and labels. Use the showroom above to preview every variation.",
        default: true,
        onChange: scheduleAfterSettingsChange
    },
    skinPreset: {
        type: OptionType.SELECT,
        description: "The selected action-group skin. The visual showroom above is the recommended way to browse it.",
        default: DEFAULT_PROFILE_SKIN,
        options: PROFILE_SKIN_PRESETS.map(preset => ({ label: preset.name, value: preset.id, default: preset.id === DEFAULT_PROFILE_SKIN })),
        hidden: true,
        onChange: scheduleAfterSettingsChange
    },
    profileWidgetStyle: {
        type: OptionType.SELECT,
        description: "The profile-only widget-inspired palette used when the visual source is Widget card. This snapshot does not change any DMWidget skin.",
        default: WIDGET_STYLE_PRESETS[0].id,
        options: WIDGET_STYLE_PRESETS.map(preset => ({ label: preset.name, value: preset.id, default: preset.id === WIDGET_STYLE_PRESETS[0].id })),
        hidden: true,
        onChange: scheduleAfterSettingsChange
    },
    profileWidgetStyleSnapshotInitialized: {
        type: OptionType.BOOLEAN,
        description: "Internal migration marker for the profile-only widget palette.",
        default: false,
        hidden: true
    },
    profileVisualSourceDefaultMigrated: {
        type: OptionType.BOOLEAN,
        description: "Internal migration marker for the profile-gradient default.",
        default: false,
        hidden: true
    },
    profileGradientDefaultV2Migrated: {
        type: OptionType.BOOLEAN,
        description: "Internal migration marker for the corrected default profile-gradient surface.",
        default: false,
        hidden: true
    },
    visualSource: {
        type: OptionType.SELECT,
        description: "Choose whether the action groups follow the selected local palette, the native profile gradient, or an independent snapshot of the DMWidget card language.",
        default: "profile",
        options: [
            { label: "Match profile gradient", value: "profile", default: true },
            { label: "Original palette", value: "skin" },
            { label: "Widget card snapshot", value: "widget" }
        ],
        hidden: true,
        onChange: scheduleAfterSettingsChange
    },
    preserveNativeCosmetics: {
        type: OptionType.BOOLEAN,
        description: "Protect and preserve Discord's own avatar decorations, profile effects, frames, and nameplates. This never fakes or re-hosts paid Discord cosmetics.",
        default: true,
        onChange: scheduleAfterSettingsChange
    },
    localEffects: {
        type: OptionType.BOOLEAN,
        description: "Optionally add one lightweight Discordmaxxer visual layer to explicit profile popouts. Disabled by default so Discord's native profile layout stays untouched; CSS-only, with no media downloads.",
        default: false,
        onChange: scheduleAfterSettingsChange
    },
    effectPreset: {
        type: OptionType.SELECT,
        description: "Stored compatibility setting. Choose the effect from the live Profile cosmetics showroom above.",
        default: "aurora",
        options: [
            { label: "Aurora veil", value: "aurora", default: true },
            { label: "Emberfall", value: "emberfall" },
            { label: "Frost dust", value: "frost" },
            { label: "Neon rain", value: "neonRain" },
            { label: "Rose drift", value: "roseDrift" },
            { label: "Starlight", value: "starlight" },
            { label: "Ink bloom", value: "inkBloom" },
            { label: "Gilded dust", value: "gildedDust" },
            { label: "None", value: "none" }
        ],
        hidden: true,
        onChange: scheduleAfterSettingsChange
    },
    effectIntensity: {
        type: OptionType.SELECT,
        description: "Stored compatibility setting. Choose the intensity from the live Profile cosmetics showroom above.",
        default: "balanced",
        options: [
            { label: "Subtle", value: "subtle" },
            { label: "Balanced", value: "balanced", default: true },
            { label: "Full", value: "full" }
        ],
        hidden: true,
        onChange: scheduleAfterSettingsChange
    },
    effectSpeed: {
        type: OptionType.SELECT,
        description: "Stored compatibility setting. Choose the speed from the live Profile cosmetics showroom above.",
        default: "standard",
        options: [
            { label: "Slow", value: "slow" },
            { label: "Standard", value: "standard", default: true },
            { label: "Fast", value: "fast" }
        ],
        hidden: true,
        onChange: scheduleAfterSettingsChange
    },
    pauseInTournamentMode: {
        type: OptionType.BOOLEAN,
        description: "Pause Discordmaxxer profile-effect motion while Tournament Mode is active. Native Discord cosmetics remain owned and rendered by Discord.",
        default: true,
        onChange: scheduleAfterSettingsChange
    },
    respectReducedMotion: {
        type: OptionType.BOOLEAN,
        description: "Pause local profile-effect motion when Windows or Discord requests reduced motion.",
        default: true,
        onChange: scheduleAfterSettingsChange
    }
});

export default definePlugin({
    name: "DMProfileCosmetics",
    description: `Polishes profile-popout controls with a live cosmetics showroom, ${PROFILE_SKIN_PRESETS.length} original action-group skins, optional bounded CSS effects, and Tournament Mode/reduced-motion safeguards.`,
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        migrateProfileVisualSourceDefault();
        initializeProfileWidgetStyleSnapshot();
        started = true;
        style = createAndAppendStyle("dm-profile-cosmetics", managedStyleRootNode);
        style.textContent = buildCss();

        motionQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
            ? window.matchMedia("(prefers-reduced-motion: reduce)")
            : null;
        motionQuery?.addEventListener?.("change", onReducedMotionChange);
        window.addEventListener("discordmaxxer:tournament-mode-changed", onTournamentModeChange);

        observer = new MutationObserver(records => {
            try {
                if (document.hidden) return;
                if (records.some(mutationLooksRelevant)) scheduleReconcile();
            } catch (error) {
                console.warn("[DMProfileCosmetics] observer ignored during navigation:", error);
            }
        });
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
        visibilityHandler = () => document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
        scheduleReconcile(0);
    },

    stop() {
        started = false;
        if (reconcileTimer) clearTimeout(reconcileTimer);
        reconcileTimer = null;
        observer?.disconnect();
        observer = null;
        visibilityHandler?.();
        visibilityHandler = null;
        motionQuery?.removeEventListener?.("change", onReducedMotionChange);
        motionQuery = null;
        window.removeEventListener("discordmaxxer:tournament-mode-changed", onTournamentModeChange);
        restoreAll();
        style?.remove();
        style = null;
    }
});

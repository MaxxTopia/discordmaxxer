/*
 * Stable Display Name Style preset ids shared by the plugin and portable
 * profile-look codes. Keep this allowlist aligned with DMDisplayNameStyle's
 * visual preset catalog; imported codes may only select one of these ids.
 */

export const DISPLAY_NAME_STYLE_PRESET_IDS = [
    "cottonCandy", "velvetScript", "flamekissed", "comicBurst", "wildfire", "gothicInk", "streetMarker", "futureRunner",
    "moonlitScript", "neonArcade", "holoChrome", "ember", "toxic", "aurora",
    "sakura", "midnight", "bloodMoon", "royal", "terminal", "pixel", "dragonfire",
    "oceanic", "cobaltFlame", "plasma", "monoInk", "goldLeaf", "voidBloom", "speedLine",
    "storybook", "custom"
] as const;

export type DisplayNameStylePresetId = typeof DISPLAY_NAME_STYLE_PRESET_IDS[number];

export function isDisplayNameStylePresetId(value: unknown): value is DisplayNameStylePresetId {
    return typeof value === "string" && (DISPLAY_NAME_STYLE_PRESET_IDS as readonly string[]).includes(value);
}

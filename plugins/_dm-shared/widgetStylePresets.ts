/*
 * Shared DMWidget visual tokens.
 *
 * DMWidget owns the cards, while other client-side surfaces can borrow the
 * same visual language. Keeping the preset data here prevents a second copy
 * from slowly drifting away from the actual widget skin.
 */

export type WidgetStylePreset = {
    id: string;
    name: string;
    mood: string;
    glyph: string;
    family: "featured" | "fantasy" | "cozy" | "cosmic" | "noir" | "botanical" | "retro";
    blurb: string;
    accent: string;
    secondary: string;
    surface: string;
    topLayout: "hero" | "contained";
    bottomLayout: "stats" | "progress";
    motion: "none" | "scan" | "embers" | "aurora" | "glint" | "laurel" | "orbit" | "bloom" | "glitch" | "solar" | "blood" | "pursuit";
    frame: "rail" | "ember" | "dream" | "glass" | "relic" | "horizon" | "bloom" | "crt" | "halo" | "velvet" | "nocturne";
    ornament: "prism" | "cinder" | "ribbon" | "shard" | "crown" | "orbit" | "petal" | "pixel" | "flare" | "medallion" | "fang";
};

// Layout values map to the widget schema. The remaining fields are the
// Discordmaxxer renderer's shared palette and art direction for that card.
export const WIDGET_STYLE_PRESETS: WidgetStylePreset[] = [
    { id: "neonCircuit", name: "Prism Relay", mood: "Kinetic / chromatic", glyph: "⟡", family: "featured", blurb: "chromatic rails from the widget card", accent: "#55f6e8", secondary: "#ff4fc8", surface: "#0b1420", topLayout: "hero", bottomLayout: "stats", motion: "scan", frame: "rail", ornament: "prism" },
    { id: "emberProtocol", name: "Mothlight Reliquary", mood: "Nocturnal / lantern-lit", glyph: "❈", family: "fantasy", blurb: "lantern warmth and small cinders", accent: "#ffd36a", secondary: "#b9f08b", surface: "#121a19", topLayout: "contained", bottomLayout: "stats", motion: "embers", frame: "ember", ornament: "cinder" },
    { id: "cottonCandy", name: "Cotton Candy", mood: "Dream / pastel", glyph: "✧", family: "cozy", blurb: "soft dream light with arcade energy", accent: "#ff6ec7", secondary: "#4a73ff", surface: "#1a1425", topLayout: "hero", bottomLayout: "stats", motion: "aurora", frame: "dream", ornament: "ribbon" },
    { id: "frostedGlass", name: "Frosted Glass", mood: "Glacier / refracted light", glyph: "◇", family: "cosmic", blurb: "refracted ice and clean edges", accent: "#d8f3ff", secondary: "#7586a9", surface: "#121a25", topLayout: "contained", bottomLayout: "stats", motion: "glint", frame: "glass", ornament: "shard" },
    { id: "championRun", name: "Sanguine Court", mood: "Velvet / blood-lust", glyph: "♛", family: "noir", blurb: "velvet contrast with a trophy-metal glint", accent: "#ff526e", secondary: "#e9b36b", surface: "#150912", topLayout: "hero", bottomLayout: "progress", motion: "blood", frame: "velvet", ornament: "medallion" },
    { id: "deepSpace", name: "Event Horizon", mood: "Starfield / nocturne", glyph: "✦", family: "cosmic", blurb: "quiet orbit light over deep space", accent: "#b8cbff", secondary: "#78e0da", surface: "#060914", topLayout: "contained", bottomLayout: "progress", motion: "orbit", frame: "horizon", ornament: "orbit" },
    { id: "voidBloom", name: "Void Bloom", mood: "Bioluminescent / alien garden", glyph: "✿", family: "botanical", blurb: "bioluminescent petals in the dark", accent: "#d173ff", secondary: "#79f0cf", surface: "#170e24", topLayout: "hero", bottomLayout: "stats", motion: "bloom", frame: "bloom", ornament: "petal" },
    { id: "pixelOverdrive", name: "Vesper Hunt", mood: "Midnight / lantern chase", glyph: "✶", family: "retro", blurb: "lantern chase with a midnight pulse", accent: "#ff6a8f", secondary: "#ffd36a", surface: "#0c0d1a", topLayout: "contained", bottomLayout: "stats", motion: "pursuit", frame: "nocturne", ornament: "fang" },
    { id: "solarFlare", name: "Solar Cathedral", mood: "Noon king / radiant", glyph: "☼", family: "fantasy", blurb: "radiant rays and warm metal", accent: "#ffe3a0", secondary: "#f06b4d", surface: "#24100d", topLayout: "hero", bottomLayout: "stats", motion: "solar", frame: "halo", ornament: "flare" }
];

export function widgetStylePreset(id: unknown): WidgetStylePreset {
    return WIDGET_STYLE_PRESETS.find(preset => preset.id === String(id ?? "")) ?? WIDGET_STYLE_PRESETS[0];
}

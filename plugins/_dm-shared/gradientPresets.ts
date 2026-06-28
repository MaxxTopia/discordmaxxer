/*
 * Discordmaxxer — profile gradient presets
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Curated two-color profile-gradient presets surfaced in the first-launch
 * picker (DMWelcome) and reusable anywhere a quick "pick a gradient" UI is
 * wanted. `primary` paints the TOP of the profile, `secondary` the BOTTOM
 * (matches Discord's profile-theme primary/accent ordering). Setting these
 * writes DMProfileFlair.myThemeColor{Primary,Secondary}; the user then saves
 * / broadcasts from DMProfileFlair (which owns the worker + native-PATCH
 * paths). All hex are canonical #RRGGBB so they pass DMProfileFlair's
 * COLOR_RE without normalization.
 */

export interface GradientPreset {
    id: string;
    label: string;
    primary: string; // #RRGGBB — top of the gradient
    secondary: string; // #RRGGBB — bottom of the gradient
}

export const GRADIENT_PRESETS: GradientPreset[] = [
    // The two Diggy called out by name come first.
    { id: "crimson", label: "Crimson", primary: "#ff2d3f", secondary: "#7a0a12" },
    { id: "cottoncandy", label: "Cotton Candy", primary: "#ff6ec7", secondary: "#4a73ff" },
    // House + crowd-pleasers.
    { id: "maxxer", label: "Maxxer", primary: "#e25bff", secondary: "#4c51f7" },
    { id: "sunset", label: "Sunset", primary: "#ff7e5f", secondary: "#feb47b" },
    { id: "ocean", label: "Ocean", primary: "#2193b0", secondary: "#6dd5ed" },
    { id: "emerald", label: "Emerald", primary: "#11998e", secondary: "#38ef7d" },
    { id: "gold", label: "Gold", primary: "#f3af19", secondary: "#8a5a00" },
    { id: "void", label: "Void", primary: "#7a1fff", secondary: "#0a0014" }
];

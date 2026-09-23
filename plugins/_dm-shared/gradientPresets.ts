/*
 * Discordmaxxer — profile gradient presets
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Curated two-color profile-gradient presets surfaced in the first-launch
 * picker (DMWelcome) and reusable anywhere a quick "pick a gradient" UI is
 * wanted. `primary` paints the TOP of the profile, `secondary` the BOTTOM
 * (matches Discord's profile-theme primary/accent ordering). The plugin tour
 * applies these locally for every user and publishes them through
 * DMProfileFlair's shared-roster path when a claim is available; the full
 * Profile Flair editor also owns the worker + optional native-PATCH paths.
 * All hex are canonical #RRGGBB so they pass DMProfileFlair's COLOR_RE
 * without normalization.
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
    { id: "void", label: "Void", primary: "#7a1fff", secondary: "#0a0014" },
    // More quick mixes so users do not need to understand hex before they
    // can get a profile that feels like theirs.
    { id: "aurora", label: "Aurora", primary: "#00f5a0", secondary: "#00d9f5" },
    { id: "berry", label: "Berry", primary: "#ff4d8d", secondary: "#8f00ff" },
    { id: "fire", label: "Fire", primary: "#ff512f", secondary: "#dd2476" },
    { id: "mint", label: "Mint", primary: "#d9f99d", secondary: "#14b8a6" },
    { id: "arctic", label: "Arctic", primary: "#c2e9fb", secondary: "#81a4cd" },
    { id: "lavender", label: "Lavender", primary: "#e0c3fc", secondary: "#8ec5fc" },
    { id: "neon", label: "Neon", primary: "#00f2fe", secondary: "#4facfe" },
    { id: "rosegold", label: "Rose Gold", primary: "#fbc2eb", secondary: "#a6c1ee" },
    { id: "plasma", label: "Plasma", primary: "#f953c6", secondary: "#b91d73" },
    { id: "tropical", label: "Tropical", primary: "#43cea2", secondary: "#185a9d" },
    { id: "citrus", label: "Citrus", primary: "#f7971e", secondary: "#ffd200" },
    { id: "midnight", label: "Midnight", primary: "#232526", secondary: "#414345" },
    { id: "plum", label: "Plum", primary: "#cc2b5e", secondary: "#753a88" },
    { id: "icefire", label: "Icefire", primary: "#00c6ff", secondary: "#f77062" },
    { id: "sakura", label: "Sakura", primary: "#fbc8d4", secondary: "#9796f0" },
    { id: "toxic", label: "Toxic", primary: "#b6f492", secondary: "#20bf55" }
];

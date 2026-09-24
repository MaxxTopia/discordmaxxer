/*
 * Discordmaxxer — portable profile-look share codes
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A share code contains only cosmetic settings. It never contains a claim
 * code, HWID, Discord user id, or any other account credential. The versioned
 * envelope and checksum make pasted configs self-describing and reject a
 * truncated or hand-edited value before it reaches Vencord settings.
 */

import { DisplayNameStylePresetId, isDisplayNameStylePresetId } from "./displayNameStylePresets";

export const PROFILE_LOOK_SHARE_PREFIX = "DMLOOK1:";
const SHARE_VERSION = 1;
const MAX_CODE_LENGTH = 6000;
const HTTPS_URL_RE = /^https:\/\/[^\s"']+$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const THEME_ID_RE = /^[a-z0-9_-]{1,40}$/i;
const ACTIVITY_RE = /^(playing|watching|competing)$/;
const NAME_STYLE_CHOICES = {
    customGlow: ["0.28", "0.58", "0.82"],
    fontFamily: ["preset", "system", "display", "rounded", "script", "gothic", "comic", "hand", "future", "western", "mono", "serif", "pixel"],
    fontWeight: ["preset", "550", "650", "750", "900"],
    letterSpacing: ["preset", "-0.015em", "0em", "0.04em", "0.075em"],
    casing: ["preset", "normal", "uppercase", "smallCaps"],
    effect: ["preset", "clean", "soft", "neon", "outline", "holo", "fire"],
    motion: ["preset", "none", "breathe", "shimmer", "scan", "flicker", "twinkle", "electric"]
} as const;

export interface SharedProfileFlair {
    bannerUrl?: string;
    avatarAnimatedUrl?: string;
    themeColorPrimary?: string;
    themeColorSecondary?: string;
}

export interface SharedProfilePresence {
    enabled?: boolean;
    activityType?: "playing" | "watching" | "competing";
    name?: string;
    details?: string;
    state?: string;
    showElapsed?: boolean;
    showButton?: boolean;
}

export interface SharedDisplayNameStyle {
    preset: DisplayNameStylePresetId;
    customPrimary?: string;
    customSecondary?: string;
    customGlow?: typeof NAME_STYLE_CHOICES.customGlow[number];
    fontFamily?: typeof NAME_STYLE_CHOICES.fontFamily[number];
    fontWeight?: typeof NAME_STYLE_CHOICES.fontWeight[number];
    letterSpacing?: typeof NAME_STYLE_CHOICES.letterSpacing[number];
    casing?: typeof NAME_STYLE_CHOICES.casing[number];
    effect?: typeof NAME_STYLE_CHOICES.effect[number];
    motion?: typeof NAME_STYLE_CHOICES.motion[number];
    animate?: boolean;
}

export interface ProfileLookConfig {
    version: 1;
    flair: SharedProfileFlair;
    theme?: {
        selected?: string;
        enableFlair?: boolean;
    };
    presence?: SharedProfilePresence;
    nameStyle?: SharedDisplayNameStyle;
}

export type DecodeProfileLookResult =
    | { ok: true; value: ProfileLookConfig }
    | { ok: false; error: string };

function checksum(value: string): string {
    // FNV-1a gives a small, deterministic typo/truncation guard without
    // pretending that a share code is a cryptographic signature.
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function toBase64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function boundedText(value: unknown, max: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function cleanHttps(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length > 250 || !HTTPS_URL_RE.test(value)) return undefined;
    try {
        return new URL(value).protocol === "https:" ? value : undefined;
    } catch {
        return undefined;
    }
}

function cleanColor(value: unknown): string | undefined {
    return typeof value === "string" && COLOR_RE.test(value) ? value.toLowerCase() : undefined;
}

function sanitizeConfig(raw: any): ProfileLookConfig | null {
    if (!raw || typeof raw !== "object" || raw.version !== SHARE_VERSION) return null;

    const flair: SharedProfileFlair = {};
    for (const key of ["bannerUrl", "avatarAnimatedUrl"] as const) {
        const value = cleanHttps(raw.flair?.[key]);
        if (value) flair[key] = value;
    }
    for (const key of ["themeColorPrimary", "themeColorSecondary"] as const) {
        const value = cleanColor(raw.flair?.[key]);
        if (value) flair[key] = value;
    }

    const theme: ProfileLookConfig["theme"] = {};
    if (typeof raw.theme?.selected === "string" && THEME_ID_RE.test(raw.theme.selected)) {
        theme.selected = raw.theme.selected;
    }
    if (typeof raw.theme?.enableFlair === "boolean") theme.enableFlair = raw.theme.enableFlair;

    const presence: SharedProfilePresence = {};
    if (typeof raw.presence?.enabled === "boolean") presence.enabled = raw.presence.enabled;
    if (typeof raw.presence?.activityType === "string" && ACTIVITY_RE.test(raw.presence.activityType)) {
        presence.activityType = raw.presence.activityType;
    }
    for (const key of ["name", "details", "state"] as const) {
        const value = boundedText(raw.presence?.[key], 128);
        if (value) presence[key] = value;
    }
    for (const key of ["showElapsed", "showButton"] as const) {
        if (typeof raw.presence?.[key] === "boolean") presence[key] = raw.presence[key];
    }

    const nameStyle: Partial<SharedDisplayNameStyle> = {};
    if (raw.nameStyle && typeof raw.nameStyle === "object" && isDisplayNameStylePresetId(raw.nameStyle.preset)) {
        nameStyle.preset = raw.nameStyle.preset;
        for (const key of ["customPrimary", "customSecondary"] as const) {
            const value = cleanColor(raw.nameStyle[key]);
            if (value) nameStyle[key] = value;
        }
        for (const key of Object.keys(NAME_STYLE_CHOICES) as Array<keyof typeof NAME_STYLE_CHOICES>) {
            const value = raw.nameStyle[key];
            if (typeof value === "string" && (NAME_STYLE_CHOICES[key] as readonly string[]).includes(value)) {
                (nameStyle as any)[key] = value;
            }
        }
        if (typeof raw.nameStyle.animate === "boolean") nameStyle.animate = raw.nameStyle.animate;
    }

    return {
        version: 1,
        flair,
        ...(Object.keys(theme).length ? { theme } : {}),
        ...(Object.keys(presence).length ? { presence } : {}),
        ...(Object.keys(nameStyle).length ? { nameStyle: nameStyle as SharedDisplayNameStyle } : {})
    };
}

/** Encode cosmetic profile settings into a portable, versioned code. */
export function encodeProfileLook(input: Omit<ProfileLookConfig, "version"> | ProfileLookConfig): string {
    const clean = sanitizeConfig({ ...input, version: SHARE_VERSION });
    if (!clean) throw new Error("Profile look is not valid");
    const body = toBase64Url(JSON.stringify(clean));
    return PROFILE_LOOK_SHARE_PREFIX + body + "." + checksum(body);
}

/** Decode and validate a profile-look share code. Unknown fields are dropped. */
export function decodeProfileLook(code: string): DecodeProfileLookResult {
    const raw = typeof code === "string" ? code.trim() : "";
    if (!raw.startsWith(PROFILE_LOOK_SHARE_PREFIX)) return { ok: false, error: "Not a DMLOOK1 profile-look code." };
    if (raw.length > MAX_CODE_LENGTH) return { ok: false, error: "Profile-look code is too long." };
    const rest = raw.slice(PROFILE_LOOK_SHARE_PREFIX.length);
    const dot = rest.lastIndexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return { ok: false, error: "Profile-look code is incomplete." };
    const body = rest.slice(0, dot);
    const supplied = rest.slice(dot + 1).toLowerCase();
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[0-9a-f]{8}$/.test(supplied)) {
        return { ok: false, error: "Profile-look code has an invalid envelope." };
    }
    if (checksum(body) !== supplied) return { ok: false, error: "Profile-look code failed its checksum." };
    try {
        const parsed = JSON.parse(fromBase64Url(body));
        const value = sanitizeConfig(parsed);
        return value ? { ok: true, value } : { ok: false, error: "Profile-look code has an unsupported version or fields." };
    } catch {
        return { ok: false, error: "Profile-look code is not valid UTF-8 JSON." };
    }
}

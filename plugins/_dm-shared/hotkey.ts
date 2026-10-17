/*
 * Discordmaxxer — shared hotkey parsing and recording helpers
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Keep the renderer fallback and Electron globalShortcut path speaking the
 * same small human-readable format: ctrl+alt+h. The recorder deliberately
 * requires a modifier so a shortcut cannot quietly steal normal typing.
 */

export interface ParsedHotkey {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    key: string;
}

const KEY_ALIASES: Record<string, string> = {
    " ": "space",
    spacebar: "space",
    esc: "escape",
    escape: "escape",
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    pageup: "pageup",
    pagedown: "pagedown",
    printscreen: "printscreen",
    capslock: "capslock",
    numlock: "numlock",
    scrolllock: "scrolllock",
    "+": "plus"
};

const MODIFIER_KEYS = new Set(["ctrl", "control", "alt", "shift", "meta", "cmd", "win", "super"]);

export function normalizeHotkeyKey(input: string): string {
    const value = String(input ?? "").trim().toLowerCase();
    return KEY_ALIASES[value] ?? value;
}

export function parseHotkey(hotkey: string): ParsedHotkey {
    const parts = String(hotkey ?? "")
        .toLowerCase()
        .split("+")
        .map(part => part.trim())
        .filter(Boolean);
    const keyPart = [...parts].reverse().find(part => !MODIFIER_KEYS.has(part)) ?? "";

    return {
        ctrl: parts.includes("ctrl") || parts.includes("control"),
        alt: parts.includes("alt"),
        shift: parts.includes("shift"),
        meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("win") || parts.includes("super"),
        key: normalizeHotkeyKey(keyPart)
    };
}

export function matchesHotkey(event: KeyboardEvent, hotkey: ParsedHotkey): boolean {
    return (
        event.ctrlKey === hotkey.ctrl &&
        event.altKey === hotkey.alt &&
        event.shiftKey === hotkey.shift &&
        event.metaKey === hotkey.meta &&
        normalizeHotkeyKey(event.key) === hotkey.key
    );
}

/** Return a canonical hotkey string, or null when the keypress is unsafe. */
export function captureHotkey(event: KeyboardEvent): string | null {
    // Super/Windows shortcuts are owned by the OS and are not portable across
    // the Electron + window fallback paths.
    if (event.metaKey) return null;

    const key = normalizeHotkeyKey(event.key);
    if (!key || key === "unidentified" || MODIFIER_KEYS.has(key)) return null;
    if (!event.ctrlKey && !event.altKey && !event.shiftKey) return null;

    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("ctrl");
    if (event.altKey) modifiers.push("alt");
    if (event.shiftKey) modifiers.push("shift");
    return [...modifiers, key].join("+");
}

export function isUsableHotkey(hotkey: string): boolean {
    const parsed = parseHotkey(hotkey);
    return Boolean(parsed.key) && !parsed.meta && (parsed.ctrl || parsed.alt || parsed.shift);
}

function displayKey(key: string): string {
    if (key === "plus") return "+";
    if (key === "space") return "Space";
    if (key.length === 1) return key.toUpperCase();
    return key.charAt(0).toUpperCase() + key.slice(1);
}

export function formatHotkeyForDisplay(hotkey: string): string {
    const parsed = parseHotkey(hotkey);
    if (!parsed.key) return "Not set";
    const modifiers = [
        parsed.ctrl ? "Ctrl" : "",
        parsed.alt ? "Alt" : "",
        parsed.shift ? "Shift" : "",
        parsed.meta ? "Win" : ""
    ].filter(Boolean);
    return [...modifiers, displayKey(parsed.key)].join(" + ");
}

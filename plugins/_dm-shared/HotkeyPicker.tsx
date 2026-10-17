/*
 * Discordmaxxer — visual hotkey recorder
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { captureHotkey, formatHotkeyForDisplay, isUsableHotkey } from "./hotkey";

export interface HotkeyPickerProps {
    value: string;
    defaultValue: string;
    label: string;
    description: string;
    onChange: (value: string) => void;
}

/**
 * A recorder for the common path, with the existing string setting still
 * available below it for advanced users and backwards compatibility.
 */
export function HotkeyPicker({ value, defaultValue, label, description, onChange }: HotkeyPickerProps) {
    const [draft, setDraft] = React.useState(value);
    const [recording, setRecording] = React.useState(false);
    const [message, setMessage] = React.useState("");

    React.useEffect(() => {
        setDraft(value);
    }, [value]);

    React.useEffect(() => {
        if (!recording) return;

        const onKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();

            if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey) {
                setRecording(false);
                setMessage("Recording canceled.");
                return;
            }

            const next = captureHotkey(event);
            if (!next) {
                setMessage("Use Ctrl, Alt, or Shift plus another key. Plain keys are rejected so they cannot steal typing.");
                return;
            }

            setDraft(next);
            onChange(next);
            setRecording(false);
            setMessage(`Saved ${formatHotkeyForDisplay(next)} — it is active now.`);
        };

        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [onChange, recording]);

    const saveDefault = () => {
        setDraft(defaultValue);
        onChange(defaultValue);
        setRecording(false);
        setMessage(`Reset to ${formatHotkeyForDisplay(defaultValue)}.`);
    };

    const currentIsUsable = isUsableHotkey(draft);

    return (
        <div
            style={{
                marginTop: 10,
                padding: "11px 12px",
                borderRadius: 9,
                background: "linear-gradient(135deg, rgba(226,91,255,0.08), rgba(76,81,247,0.08))",
                border: "1px solid rgba(226,91,255,0.25)",
                color: "#eaeef9",
                fontSize: 12,
                lineHeight: 1.4
            }}
        >
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fbefff" }}>⌨️ {label}</div>
            <div style={{ marginTop: 3, color: "#cbd0e0", opacity: 0.88 }}>{description}</div>
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                    type="button"
                    onClick={() => {
                        setRecording(true);
                        setMessage("Press Ctrl, Alt, or Shift plus the key you want…");
                    }}
                    style={{
                        padding: "8px 12px",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.16)",
                        background: recording ? "rgba(255,110,199,0.22)" : "rgba(0,0,0,0.28)",
                        color: "#fff",
                        fontWeight: 700,
                        cursor: "pointer"
                    }}
                >
                    {recording ? "Listening…" : "Record shortcut"}
                </button>
                <button
                    type="button"
                    onClick={saveDefault}
                    disabled={draft === defaultValue}
                    style={{
                        padding: "8px 12px",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "transparent",
                        color: draft === defaultValue ? "#707789" : "#cbd0e0",
                        cursor: draft === defaultValue ? "not-allowed" : "pointer"
                    }}
                >
                    Use default
                </button>
                <span style={{ color: currentIsUsable ? "#65e6a5" : "#ff9c9c", fontWeight: 700 }}>
                    Current: {formatHotkeyForDisplay(draft)}
                </span>
            </div>
            {message && <div style={{ marginTop: 7, color: "#a9b6ff" }}>{message}</div>}
        </div>
    );
}

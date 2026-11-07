/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

import { DATA_DIR } from "./constants";

const STARTUP_LOG_PATH = join(DATA_DIR, "startup.log");
const MAX_DETAIL_LENGTH = 1200;

function safeDetail(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function describeStartupError(error: unknown): string {
    return safeDetail(error)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, MAX_DETAIL_LENGTH);
}

export function getStartupLogPath() {
    return STARTUP_LOG_PATH;
}

export function recordStartupEvent(stage: string, detail?: unknown) {
    const entry = {
        at: new Date().toISOString(),
        version: app.getVersion(),
        pid: process.pid,
        stage,
        ...(detail === undefined ? {} : { detail: describeStartupError(detail) })
    };

    console.log(`[Discordmaxxer startup] ${stage}${detail === undefined ? "" : `: ${entry.detail}`}`);

    try {
        mkdirSync(DATA_DIR, { recursive: true });
        appendFileSync(STARTUP_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
        console.warn("[Discordmaxxer startup] Could not write startup.log:", describeStartupError(error));
    }
}

/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { statfs } from "node:fs/promises";

import type { UpdateInfo } from "electron-updater";

const BYTES_PER_GIB = 1024 ** 3;

// NSIS needs room for the downloaded installer and the unpacked app payload in
// %TEMP%. A one-GiB floor prevents the generic Windows "This app can't run on
// your PC" dialog when the real failure is simply a full system drive.
export const MIN_UPDATE_FREE_BYTES = BYTES_PER_GIB;
const NSIS_SPACE_MULTIPLIER = 3;

function formatBytes(bytes: number) {
    return `${(bytes / BYTES_PER_GIB).toFixed(1)} GB`;
}

export function getUpdateInstallerBytes(update: Pick<UpdateInfo, "files">) {
    return Math.max(0, ...update.files.map(file => file.size ?? 0));
}

export function getRequiredUpdateFreeBytes(update: Pick<UpdateInfo, "files">) {
    return Math.max(MIN_UPDATE_FREE_BYTES, Math.ceil(getUpdateInstallerBytes(update) * NSIS_SPACE_MULTIPLIER));
}

/**
 * Check the volumes used by the updater before electron-updater downloads the
 * installer. If a volume cannot be inspected, fail open and let the updater
 * report its normal error; a diagnostic check must never block updates by
 * itself.
 */
export async function getUpdateStorageError(
    update: Pick<UpdateInfo, "version" | "files">,
    paths: readonly string[]
): Promise<string | null> {
    const requiredBytes = getRequiredUpdateFreeBytes(update);
    const checkedPaths = new Set<string>();

    for (const path of paths) {
        if (checkedPaths.has(path)) continue;
        checkedPaths.add(path);

        try {
            const stats = await statfs(path);
            const freeBytes = Number(stats.bavail) * Number(stats.bsize);
            if (freeBytes >= requiredBytes) continue;

            return (
                `Not enough free space to install Discordmaxxer ${update.version}. ` +
                `The updater must download and unpack the installer temporarily. ` +
                `${formatBytes(freeBytes)} is free at ${path}, but at least ` +
                `${formatBytes(requiredBytes)} is recommended. Free space and try again. ` +
                `Windows can show a misleading "This app can't run on your PC" message when this ` +
                `temporary extraction fails.`
            );
        } catch (error) {
            console.warn(`[Discordmaxxer updater] Could not inspect free space at ${path}:`, error);
        }
    }

    return null;
}

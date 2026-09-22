/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "child_process";

import type { ChromeWindowOcclusionStatus } from "../shared/IpcEvents";
import { State } from "./settings";

const POLICY_NAME = "WindowOcclusionEnabled";
const USER_POLICY_KEY = "HKCU\\Software\\Policies\\Google\\Chrome";
const MACHINE_POLICY_KEYS = [
    "HKLM\\Software\\Policies\\Google\\Chrome",
    "HKLM\\Software\\WOW6432Node\\Policies\\Google\\Chrome"
] as const;

function runReg(args: string[]) {
    return new Promise<string>((resolve, reject) => {
        execFile("reg.exe", args, { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
            if (!error) return resolve(stdout);

            // reg.exe uses exit code 1 when a key or value does not exist.
            // The caller checks for the exact policy value in stdout.
            if (error.code === 1) return resolve(stdout);

            const detail = stderr.trim() || stdout.trim() || error.message;
            reject(new Error(`Could not access Chrome's Windows policy: ${detail}`));
        });
    });
}

async function readPolicyValue(key: string): Promise<number | undefined> {
    const output = await runReg(["query", key, "/v", POLICY_NAME]);
    const line = output.split(/\r?\n/).find(value => value.trim().toLowerCase().startsWith(POLICY_NAME.toLowerCase()));
    if (!line) return undefined;

    const match = line.match(/\s+REG_DWORD\s+(?:0x([\da-f]+)|(\d+))\s*$/i);
    if (!match)
        throw new Error(`Chrome policy ${POLICY_NAME} exists but is not a REG_DWORD; Discordmaxxer left it unchanged.`);

    return Number.parseInt(match[1] ?? match[2], match[1] ? 16 : 10);
}

function makeStatus(
    machineValues: Array<number | undefined>,
    userValue: number | undefined
): ChromeWindowOcclusionStatus {
    const managedByDiscordmaxxer = State.store.chromeWindowOcclusionPolicyManaged === true && userValue === 0;
    const machineValue = machineValues.find(value => value !== undefined);
    const hasMachinePolicy = machineValue !== undefined;
    const hasExternalUserPolicy = userValue !== undefined && !managedByDiscordmaxxer;
    const enabled = (hasMachinePolicy ? machineValue : userValue) === 0;

    if (hasMachinePolicy) {
        return {
            enabled,
            managedByDiscordmaxxer,
            canChange: false,
            message: "A system-level Chrome policy controls this setting. Discordmaxxer will not override it."
        };
    }

    if (hasExternalUserPolicy) {
        return {
            enabled,
            managedByDiscordmaxxer: false,
            canChange: false,
            message: "A Chrome policy already controls this setting. Discordmaxxer will not overwrite it."
        };
    }

    return {
        enabled,
        managedByDiscordmaxxer,
        canChange: true,
        message: managedByDiscordmaxxer
            ? "Discordmaxxer added this per-user Chrome policy. Fully exit and reopen Chrome for it to take effect. It applies to this Windows account and may increase CPU, GPU, and power use."
            : "Let Chrome keep rendering windows covered by other apps. Fully exit and reopen Chrome for this to take effect. It applies to this Windows account and may increase CPU, GPU, and power use."
    };
}

function readPolicyValues() {
    return Promise.all([Promise.all(MACHINE_POLICY_KEYS.map(readPolicyValue)), readPolicyValue(USER_POLICY_KEY)]);
}

export async function getChromeWindowOcclusionStatus(): Promise<ChromeWindowOcclusionStatus> {
    if (process.platform !== "win32") {
        return {
            enabled: false,
            managedByDiscordmaxxer: false,
            canChange: false,
            message: "This setting is only available on Windows."
        };
    }

    const [machineValues, userValue] = await readPolicyValues();

    return makeStatus(machineValues, userValue);
}

export async function setChromeWindowOcclusionEnabled(enabled: boolean): Promise<ChromeWindowOcclusionStatus> {
    if (typeof enabled !== "boolean") throw new TypeError("Chrome window occlusion must be enabled or disabled.");
    if (process.platform !== "win32") return getChromeWindowOcclusionStatus();

    const [machineValues, userValue] = await readPolicyValues();
    const status = makeStatus(machineValues, userValue);
    if (!status.canChange) throw new Error(status.message);

    const managedByDiscordmaxxer = State.store.chromeWindowOcclusionPolicyManaged === true && userValue === 0;

    if (enabled) {
        if (userValue !== undefined && !managedByDiscordmaxxer) {
            throw new Error("A Chrome policy appeared while applying the setting. Discordmaxxer left it unchanged.");
        }

        if (!managedByDiscordmaxxer) {
            await runReg(["add", USER_POLICY_KEY, "/v", POLICY_NAME, "/t", "REG_DWORD", "/d", "0", "/f"]);
            State.store.chromeWindowOcclusionPolicyManaged = true;
        }
    } else {
        if (!managedByDiscordmaxxer) {
            State.store.chromeWindowOcclusionPolicyManaged = false;
            return getChromeWindowOcclusionStatus();
        }

        await runReg(["delete", USER_POLICY_KEY, "/v", POLICY_NAME, "/f"]);
        State.store.chromeWindowOcclusionPolicyManaged = false;
    }

    return getChromeWindowOcclusionStatus();
}

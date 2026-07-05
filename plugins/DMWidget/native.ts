/*
 * Discordmaxxer — DMWidget plugin (native / main process)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The one call in the whole widget flow that must be sent "header-clean":
 *   PATCH /applications/{appId}/users/{userId}/identities/0/profile
 * This "finalizes"/claims the widget onto the user's profile identity so it
 * renders for OTHER viewers (not just the owner's own board). It needs
 * `Authorization: Bot {token}` — but Discord REJECTS a Bot-auth request that
 * carries browser fingerprint headers (Origin / Referer / Sec-Fetch-*) with
 * `403 code 40333 "internal network error"`. A renderer fetch always adds
 * those, so the request goes out from the main process via Node https, which
 * sends none of them (the same reason the reference tools shell out to
 * PowerShell / a background script for this step).
 *
 * The bot token is the user's OWN (minted from an app they own via
 * /bot/reset, which is why it needs their 2FA); it's passed in per-call and
 * never stored here.
 */

import { request } from "https";

import type { IpcMainInvokeEvent } from "electron";

const USER_AGENT = "DiscordBot (https://maxxtopia.com, 1.0.0)";

export async function setWidgetProfile(
    _: IpcMainInvokeEvent,
    appId: string,
    userId: string,
    botToken: string,
    dataJson: string
): Promise<{ ok: true; } | { error: string; }> {
    if (!appId || !userId || !botToken) return { error: "missing appId/userId/botToken" };
    return new Promise(resolve => {
        const payload = Buffer.from(dataJson, "utf8");
        const req = request(
            {
                method: "PATCH",
                host: "discord.com",
                path: `/api/v9/applications/${appId}/users/${userId}/identities/0/profile`,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bot ${botToken}`,
                    "User-Agent": USER_AGENT,
                    "Content-Length": payload.byteLength
                }
            },
            res => {
                let buf = "";
                res.on("data", d => (buf += d));
                res.on("end", () => {
                    const code = res.statusCode ?? 0;
                    if (code >= 200 && code < 300) resolve({ ok: true });
                    else resolve({ error: `HTTP ${code}: ${buf.slice(0, 300)}` });
                });
            }
        );
        req.setTimeout(15000, () => req.destroy(new Error("request timed out after 15s")));
        req.on("error", e => resolve({ error: String((e as any)?.message ?? e) }));
        req.write(payload);
        req.end();
    });
}

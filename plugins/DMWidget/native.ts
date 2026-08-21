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

import { existsSync, readFileSync, writeFileSync } from "fs";
import { request } from "https";
import { join } from "path";

import { app, safeStorage } from "electron";
import type { IpcMainInvokeEvent } from "electron";

const USER_AGENT = "DiscordBot (https://maxxtopia.com, 1.0.0)";

// ---- encrypted bot-token store (for dynamic stat pushes) -------------------
// Mechanism B keeps the app's bot token so refreshes don't re-prompt 2FA. It's
// encrypted at rest with the OS keychain (Electron safeStorage / DPAPI) and only
// ever decrypted in this main process at push time. A "PLAIN:" prefix is the
// fallback when safeStorage is unavailable (rare headless case) so we never
// silently store a bare token as if it were encrypted.
function tokenPath(): string {
    return join(app.getPath("userData"), "dm-widget-token.bin");
}
export async function storeWidgetToken(_: IpcMainInvokeEvent, token: string): Promise<{ ok: true; } | { error: string; }> {
    try {
        if (!token) return { error: "empty token" };
        const buf = safeStorage.isEncryptionAvailable()
            ? safeStorage.encryptString(token)
            : Buffer.from("PLAIN:" + token, "utf8");
        writeFileSync(tokenPath(), buf);
        return { ok: true };
    } catch (e) { return { error: String((e as any)?.message ?? e) }; }
}
function readWidgetToken(): string | null {
    try {
        const p = tokenPath();
        if (!existsSync(p)) return null;
        const buf = readFileSync(p);
        if (buf.subarray(0, 6).toString("utf8") === "PLAIN:") return buf.subarray(6).toString("utf8");
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : null;
    } catch { return null; }
}
export async function hasWidgetToken(): Promise<boolean> {
    return readWidgetToken() !== null;
}

// Pull an image through the main process (no CORS) → base64, so a hero image
// can come from ANY host (fortnite-api.com renders, etc.), not just CORS-open ones.
export async function fetchImageData(
    _: IpcMainInvokeEvent, url: string
): Promise<{ ok: true; dataBase64: string; contentType: string; } | { error: string; }> {
    if (!url || !/^https?:\/\//i.test(url)) return { error: "not a valid http(s) image URL" };
    return new Promise(resolve => {
        const req = request(url, { method: "GET", headers: { "User-Agent": USER_AGENT } }, res => {
            const code = res.statusCode ?? 0;
            if (code >= 300 && code < 400 && res.headers.location) { res.resume(); return resolve({ error: "image URL redirects — use the direct link (" + res.headers.location.slice(0, 80) + ")" }); }
            if (code !== 200) { res.resume(); return resolve({ error: "image download failed: HTTP " + code }); }
            const chunks: Buffer[] = []; let size = 0;
            res.on("data", (d: Buffer) => { size += d.length; if (size > 9_000_000) { req.destroy(); resolve({ error: "image too large (>9MB)" }); return; } chunks.push(d); });
            res.on("end", () => resolve({ ok: true, dataBase64: Buffer.concat(chunks).toString("base64"), contentType: String(res.headers["content-type"] ?? "image/png") }));
        });
        req.setTimeout(12000, () => req.destroy(new Error("image request timed out")));
        req.on("error", e => resolve({ error: String((e as any)?.message ?? e) }));
        req.end();
    });
}

// Small GET-JSON helper (native = no CORS) shared by the stat fetchers.
function httpsJson(host: string, path: string, headers: Record<string, string>): Promise<{ status: number; json: any; }> {
    return new Promise(resolve => {
        const req = request({
            method: "GET",
            host,
            path,
            headers: {
                "User-Agent": USER_AGENT,
                "Cache-Control": "no-cache, no-store",
                Pragma: "no-cache",
                ...headers
            }
        }, res => {
            let buf = "";
            res.on("data", d => (buf += d));
            res.on("end", () => { let json: any = null; try { json = JSON.parse(buf); } catch { /* leave null */ } resolve({ status: res.statusCode ?? 0, json }); });
        });
        req.setTimeout(12000, () => req.destroy(new Error("request timed out")));
        req.on("error", () => resolve({ status: 0, json: null }));
        req.end();
    });
}

// ---- Valorant stats (HenrikDev — MMR is v3, matches are v4) -----------------
export async function fetchValorantStats(
    _: IpcMainInvokeEvent, name: string, tag: string, region: string, platform: string, apiKey: string
): Promise<{ ok: true; name: string; overall: Record<string, any>; } | { error: string; }> {
    if (!name || !tag || !apiKey) return { error: "missing Riot ID (Name#Tag) or API key" };
    const auth = { Authorization: apiKey };
    const enc = encodeURIComponent;
    const plat = platform || "pc";
    const reg = region || "na";
    // HenrikDev is normally quick, but an intermediary can otherwise hand a
    // manual refresh the same cached MMR response. Keep the request fresh
    // without changing the provider or account lookup.
    const refresh = Date.now().toString(36);

    const mmr = await httpsJson("api.henrikdev.xyz", `/valorant/v3/mmr/${enc(reg)}/${plat}/${enc(name)}/${enc(tag)}?refresh=${refresh}`, auth);
    if (mmr.status !== 200 || !mmr.json?.data) {
        const msg = mmr.json?.errors?.[0]?.message ?? (typeof mmr.json?.status === "string" ? mmr.json.status : `HTTP ${mmr.status}`);
        return { error: `Valorant MMR: ${msg} (check Riot ID, region + that the key is valid)` };
    }
    const cur = mmr.json.data.current ?? {};
    const peak = mmr.json.data.peak ?? {};
    const overall: Record<string, any> = { rank: cur.tier?.name ?? "Unrated", rr: cur.rr, peak: peak.tier?.name ?? "—", fetchedAt: Date.now() };

    // Matches (v4) → most-used agent + recent win-rate + avg K/D (best-effort).
    const m = await httpsJson("api.henrikdev.xyz", `/valorant/v4/matches/${enc(reg)}/${plat}/${enc(name)}/${enc(tag)}?size=10&refresh=${refresh}`, auth);
    if (m.status === 200 && Array.isArray(m.json?.data)) {
        const agents: Record<string, number> = {};
        let wins = 0, games = 0, kills = 0, deaths = 0;
        for (const mm of m.json.data) {
            const players: any[] = Array.isArray(mm?.players) ? mm.players : (mm?.players?.all_players ?? []);
            const me = players.find(p => String(p?.name).toLowerCase() === name.toLowerCase() && String(p?.tag).toLowerCase() === tag.toLowerCase());
            if (!me) continue;
            games++;
            const ag = me.agent?.name ?? me.character;
            if (ag) agents[ag] = (agents[ag] ?? 0) + 1;
            kills += me.stats?.kills ?? 0;
            deaths += me.stats?.deaths ?? 0;
            const myTeam = (Array.isArray(mm?.teams) ? mm.teams : []).find((t: any) => t?.team_id === me.team_id);
            if (myTeam?.won) wins++;
        }
        const top = Object.entries(agents).sort((a, b) => b[1] - a[1])[0];
        overall.mainAgent = top ? top[0] : "—";
        if (games) overall.recentWR = Math.round((wins / games) * 100);
        if (deaths) overall.avgKD = +(kills / deaths).toFixed(2);
    }
    return { ok: true, name: `${name}#${tag}`, overall };
}

// ---- Fortnite stats fetch (native = no CORS, no browser fingerprint) -------
export async function fetchFortniteStats(
    _: IpcMainInvokeEvent, name: string, apiKey: string, accountType: string
): Promise<{ ok: true; name: string; overall: Record<string, number>; } | { error: string; }> {
    if (!name || !apiKey) return { error: "missing IGN or API key" };
    return new Promise(resolve => {
        const path = `/v2/stats/br/v2?name=${encodeURIComponent(name)}&accountType=${encodeURIComponent(accountType || "epic")}&timeWindow=lifetime`;
        const req = request(
            { method: "GET", host: "fortnite-api.com", path, headers: { Authorization: apiKey, "User-Agent": USER_AGENT } },
            res => {
                let buf = "";
                res.on("data", d => (buf += d));
                res.on("end", () => {
                    try {
                        const j = JSON.parse(buf);
                        if (j.status && j.status !== 200) return resolve({ error: `${j.status}: ${j.error ?? "stats unavailable (is the account name exact + stats public?)"}` });
                        const o = j?.data?.stats?.all?.overall ?? {};
                        resolve({ ok: true, name: j?.data?.account?.name ?? name, overall: { wins: o.wins, kills: o.kills, kd: o.kd, winRate: o.winRate, matches: o.matches, top1: o.top1, killsPerMatch: o.killsPerMatch, minutesPlayed: o.minutesPlayed } });
                    } catch { resolve({ error: "couldn't parse the stats response" }); }
                });
            }
        );
        req.setTimeout(12000, () => req.destroy(new Error("stats request timed out")));
        req.on("error", e => resolve({ error: String((e as any)?.message ?? e) }));
        req.end();
    });
}

// The header-clean identity PATCH shared by the initial claim and every dynamic
// stat push (a browser fetch's Origin/Referer/Sec-Fetch-* headers make Discord
// reject a Bot-auth call with 403 code 40333, so it must originate here).
function identityPatch(appId: string, userId: string, botToken: string, dataJson: string): Promise<{ ok: true; } | { error: string; }> {
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

// Initial claim — the renderer passes the freshly-minted bot token once.
export async function setWidgetProfile(
    _: IpcMainInvokeEvent, appId: string, userId: string, botToken: string, dataJson: string
): Promise<{ ok: true; } | { error: string; }> {
    if (!appId || !userId || !botToken) return { error: "missing appId/userId/botToken" };
    return identityPatch(appId, userId, botToken, dataJson);
}

// Refresh push — uses the STORED (encrypted) token, so live stat updates need no
// 2FA. `dynamicJson` is the `data.dynamic` array (e.g. [{type,name,value}, …]).
export async function pushWidgetDynamic(
    _: IpcMainInvokeEvent, appId: string, userId: string, dynamicJson: string
): Promise<{ ok: true; } | { error: string; }> {
    if (!appId || !userId) return { error: "missing appId/userId" };
    const token = readWidgetToken();
    if (!token) return { error: "no stored bot token — run Create/claim once first" };
    let dynamic: any;
    try { dynamic = JSON.parse(dynamicJson); } catch { return { error: "bad dynamic payload" }; }
    return identityPatch(appId, userId, token, JSON.stringify({ data: { dynamic } }));
}

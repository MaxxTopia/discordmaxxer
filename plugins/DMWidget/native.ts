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
// ever decrypted in this main process at push time. If OS encryption is not
// available, fail closed rather than silently writing a reusable bot token.
function tokenPath(): string {
    return join(app.getPath("userData"), "dm-widget-token.bin");
}
export async function storeWidgetToken(_: IpcMainInvokeEvent, token: string): Promise<{ ok: true; } | { error: string; }> {
    try {
        if (!token) return { error: "empty token" };
        if (!safeStorage.isEncryptionAvailable()) return { error: "OS encryption is unavailable; token was not stored" };
        const buf = safeStorage.encryptString(token);
        writeFileSync(tokenPath(), buf);
        return { ok: true };
    } catch (e) { return { error: String((e as any)?.message ?? e) }; }
}
function readWidgetToken(): string | null {
    try {
        const p = tokenPath();
        if (!existsSync(p)) return null;
        const buf = readFileSync(p);
        // Refuse the legacy plaintext format. Leave the file untouched so a
        // user can recover or delete it deliberately, but never use it.
        if (buf.subarray(0, 6).toString("utf8") === "PLAIN:") return null;
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
function httpsJson(host: string, path: string, headers: Record<string, string> = {}, maxBytes = 512_000): Promise<{ status: number; json: any; }> {
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
            let size = 0;
            let oversized = false;
            res.on("data", d => {
                size += Buffer.byteLength(d);
                if (size <= maxBytes) buf += d;
                else oversized = true;
            });
            res.on("end", () => {
                if (oversized) return resolve({ status: 0, json: null });
                let json: any = null;
                try { json = JSON.parse(buf); } catch { /* leave null */ }
                resolve({ status: res.statusCode ?? 0, json });
            });
        });
        req.setTimeout(12000, () => req.destroy(new Error("request timed out")));
        req.on("error", () => resolve({ status: 0, json: null }));
        req.end();
    });
}

// Provider credentials stay in the server-side Worker. The optional key
// arguments below are personal advanced overrides only; they are never a
// built-in/shared credential and are used only if the proxy cannot answer.
const STATS_PROXY_HOST = "discordmaxxer-stats.maxxtopia.workers.dev";

function statsProxyError(label: string, status: number): string {
    if (status === 404) return `${label} player was not found or the stats are private`;
    if (status === 429) return `${label} stats service is busy; try again shortly`;
    return `${label} stats service is unavailable; try again later or add a personal key as a fallback`;
}

function providerError(label: string, status: number): string {
    if (status === 404) return `${label} player was not found or the stats are private`;
    if (status === 401 || status === 403) return `${label} rejected the personal key`;
    if (status === 429) return `${label} provider rate limit reached`;
    return `${label} provider is unavailable`;
}

function validStatsProxyResponse(json: any): boolean {
    return json?.ok === true && typeof json.name === "string" && json.overall && typeof json.overall === "object";
}

function normalizeFortniteAuth(key: string): string {
    return /^ApiKey\s/i.test(key) ? key : `ApiKey ${key}`;
}

// ---- Valorant stats (HenrikDev — MMR is v3, matches are v4) -----------------
export async function fetchValorantStats(
    _: IpcMainInvokeEvent, name: string, tag: string, region: string, platform: string, apiKey: string
): Promise<{ ok: true; name: string; overall: Record<string, any>; } | { error: string; }> {
    if (!name || !tag) return { error: "missing Riot ID (Name#Tag)" };
    const enc = encodeURIComponent;
    const plat = platform || "pc";
    const reg = region || "na";
    const proxy = await httpsJson(STATS_PROXY_HOST, `/v1/valorant/stats?name=${enc(name)}&tag=${enc(tag)}&region=${enc(reg)}&platform=${enc(plat)}`);
    if (validStatsProxyResponse(proxy.json)) return { ok: true, name: proxy.json.name, overall: proxy.json.overall };

    const personalKey = String(apiKey || "").trim();
    if (!personalKey) return { error: statsProxyError("Valorant", proxy.status) };
    const auth = { Authorization: personalKey };
    // HenrikDev is normally quick, but an intermediary can otherwise hand a
    // manual refresh the same cached MMR response. Keep the request fresh
    // without changing the provider or account lookup.
    const refresh = Date.now().toString(36);

    const mmr = await httpsJson("api.henrikdev.xyz", `/valorant/v3/mmr/${enc(reg)}/${plat}/${enc(name)}/${enc(tag)}?refresh=${refresh}`, auth);
    if (mmr.status !== 200 || !mmr.json?.data) {
        return { error: providerError("Valorant MMR", mmr.status) };
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
    if (!name) return { error: "missing Epic display name (IGN)" };
    const type = accountType || "epic";
    const enc = encodeURIComponent;
    const proxy = await httpsJson(STATS_PROXY_HOST, `/v1/fortnite/stats?name=${enc(name)}&accountType=${enc(type)}`);
    if (validStatsProxyResponse(proxy.json)) return { ok: true, name: proxy.json.name, overall: proxy.json.overall };

    const personalKey = String(apiKey || "").trim();
    if (!personalKey) return { error: statsProxyError("Fortnite", proxy.status) };
    const path = `/v2/stats/br/v2?name=${enc(name)}&accountType=${enc(type)}&timeWindow=lifetime`;
    const direct = await httpsJson("fortnite-api.com", path, { Authorization: normalizeFortniteAuth(personalKey) });
    const providerStatus = Number(direct.json?.status) || direct.status;
    if (direct.status !== 200 || providerStatus !== 200) return { error: providerError("Fortnite", providerStatus) };
    const raw = direct.json?.data?.stats?.all?.overall ?? {};
    const overall: Record<string, number> = {};
    for (const key of ["wins", "kills", "kd", "winRate", "matches", "top1", "killsPerMatch", "minutesPlayed"]) {
        const value = Number(raw[key]);
        if (Number.isFinite(value)) overall[key] = value;
    }
    if (!Object.keys(overall).length) return { error: "Fortnite player was not found or the stats are private" };
    return { ok: true, name: typeof direct.json?.data?.account?.name === "string" ? direct.json.data.account.name : name, overall };
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

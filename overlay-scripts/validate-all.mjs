/*
 * Discordmaxxer — full-suite validator
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Tour script: connects to a running `pnpm start:dev:debug` and validates
 * every custom plugin end-to-end, including account-mutating channels of
 * DMBadge (caller authorized; burner account).
 *
 * Phases (run in order, can skip with --skip <name>):
 *   inventory   read-only Vencord plugin state
 *   visual      Hub FAB / panel / Theme / Branding DOM checks
 *   hotkeys     CompactView + TournamentMode toggle (uses renderer fallback path)
 *   badge       Channels A/B/C/D — flips toggles, observes API + toast
 *   massdelete  enables context menu, observes menu wires up; does NOT delete
 *
 * Outputs:
 *   overlay-scripts/screenshots/validate-<ts>-<label>.png
 *   overlay-scripts/reports/validate-<ts>.json
 *   stdout: per-phase pass/fail summary
 */

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, "screenshots");
const REPORTS_DIR = resolve(__dirname, "reports");
const RUN_TS = Date.now();
const DEBUG_URL = process.env.DM_DEBUG_URL || "http://localhost:9222";

const PHASE_NAMES = ["inventory", "visual", "hotkeys", "badge", "massdelete"];
const skips = new Set();
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--skip") skips.add(process.argv[++i]);
}

mkdirSync(SCREENSHOTS_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const report = { runTs: RUN_TS, phases: {} };
const log = (...a) => console.log("[validate]", ...a);
const err = (...a) => console.error("[validate]", ...a);

async function shot(page, label) {
    const path = join(SCREENSHOTS_DIR, `validate-${RUN_TS}-${label}.png`);
    await page.screenshot({ path, type: "png" });
    return path;
}

async function connect() {
    const browser = await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null });
    const pages = await browser.pages();
    const discord = pages.find(p => p.url().includes("discord.com")) ?? pages[0];
    if (!discord) throw new Error("No Discord page found at " + DEBUG_URL);
    return { browser, page: discord };
}

async function waitForVencord(page, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await page.evaluate(() =>
            !!(globalThis.Vencord && Vencord.Plugins && Vencord.Plugins.plugins && Object.keys(Vencord.Plugins.plugins).length > 0)
        );
        if (ready) return true;
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

async function waitForUserStore(page, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const has = await page.evaluate(() => {
            try {
                const c = Vencord.Webpack?.Common?.UserStore?.getCurrentUser?.();
                return !!c?.id;
            } catch { return false; }
        });
        if (has) return true;
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

// ── Phase: inventory ───────────────────────────────────────────────────────
async function phaseInventory(page) {
    const out = await page.evaluate(() => {
        const v = globalThis.Vencord;
        if (!v) return { error: "Vencord global missing" };
        const plugins = v.Plugins?.plugins ?? {};
        const settings = v.PlainSettings?.plugins ?? {};
        const watch = [
            "TournamentMode", "CompactView", "MassDelete",
            "DMBadge", "DMHub", "DMTheme", "DMWelcome", "VideoBackground",
            "BetterGifPicker",
            "FakeNitro", "MessageLogger", "PinDMs", "VolumeBooster",
            "ClearURLs", "AlwaysTrust", "BetterFolders", "MentionAvatars",
            "NoReplyMention", "TextReplace", "ImageZoom", "TypingTweaks"
        ];
        const me = v.Webpack?.Common?.UserStore?.getCurrentUser?.();
        return {
            vencordPresent: true,
            me: me ? { id: me.id, username: me.username, hasBio: !!me.bio, pronouns: me.pronouns ?? "" } : null,
            totalPlugins: Object.keys(plugins).length,
            enabledCount: Object.values(settings).filter(p => p?.enabled).length,
            seededCount: v.PlainSettings?.discordmaxxerSeededPlugins?.length ?? null,
            watch: Object.fromEntries(watch.map(n => [n, {
                inRegistry: n in plugins,
                enabled: settings[n]?.enabled === true
            }]))
        };
    });
    return out;
}

// ── Phase: visual ──────────────────────────────────────────────────────────
async function phaseVisual(page) {
    const out = await page.evaluate(() => {
        const result = {};
        const fab = document.getElementById("dm-hub-fab");
        result.hubFab = {
            present: !!fab,
            ariaLabel: fab?.getAttribute?.("aria-label") ?? null,
            visible: fab ? fab.offsetParent !== null : false
        };
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        result.theme = {
            brandExperiment: cs.getPropertyValue("--brand-experiment").trim(),
            brand500: cs.getPropertyValue("--brand-500").trim()
        };
        result.title = document.title;
        result.styleTags = Array.from(document.head.querySelectorAll("style"))
            .map(s => s.id || s.getAttribute("data-vencord-pluginname") || "(no-id)")
            .filter(id => id.toLowerCase().includes("dm-") || id.toLowerCase().includes("discordmaxxer") || id.toLowerCase().includes("compact") || id.toLowerCase().includes("tournament") || id.toLowerCase().includes("hub") || id.toLowerCase().includes("theme"));
        return result;
    });

    out.screenshotBefore = await shot(page, "visual-before-fab-click");

    if (out.hubFab.present) {
        try {
            await page.click("#dm-hub-fab", { delay: 50 });
            await new Promise(r => setTimeout(r, 400));
            const after = await page.evaluate(() => {
                const root = document.getElementById("dm-hub-panel-root");
                const panel = document.getElementById("dm-hub-panel");
                return {
                    panelRootPresent: !!root,
                    panelOpen: !!root && !root.classList.contains("hidden"),
                    panelPresent: !!panel,
                    panelHTMLLength: panel?.innerHTML?.length ?? 0,
                    tierBadge: panel?.querySelector?.('[class*="tier" i], [data-tier]')?.textContent ?? null
                };
            });
            out.hubPanel = after;
            out.screenshotPanel = await shot(page, "visual-hub-panel-open");
            // Close through the plugin's own action so the plugin-owned root
            // remains attached and the next validation run starts cleanly.
            out.hubPanel.closedByPluginAction = await page.evaluate(() => {
                const close = document.querySelector('#dm-hub-panel [data-action="close"]');
                if (!(close instanceof HTMLElement)) return false;
                close.click();
                return true;
            });
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            out.hubPanel = { error: String(e) };
        }
    }
    return out;
}

// ── Phase: hotkeys (CompactView + TournamentMode) ──────────────────────────
async function activateViaRestart(page, name) {
    // Set enabledOnStart=true and restart the plugin. This exercises setActive(true)
    // through the same code path the hotkey would, without needing OS-level key sim.
    return await page.evaluate(async (n) => {
        const p = Vencord.Plugins.plugins[n];
        if (!p) return { error: `Plugin ${n} not loaded` };
        const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        Vencord.PlainSettings.plugins[n] = Vencord.PlainSettings.plugins[n] || { enabled: true };
        Vencord.PlainSettings.plugins[n].enabledOnStart = true;
        // Mirror to the live store too
        if (p.settings?.store) p.settings.store.enabledOnStart = true;
        try { await Vencord.Plugins.stopPlugin(p); await settle(250); } catch (e) { return { error: "stop failed: " + e.message }; }
        try { await Vencord.Plugins.startPlugin(p); await settle(500); } catch (e) { return { error: "start failed: " + e.message }; }
        return { ok: true };
    }, name);
}

async function deactivateAndCleanup(page, name) {
    return await page.evaluate(async (n) => {
        const p = Vencord.Plugins.plugins[n];
        if (!p) return;
        const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        if (Vencord.PlainSettings.plugins[n]) Vencord.PlainSettings.plugins[n].enabledOnStart = false;
        if (p.settings?.store) p.settings.store.enabledOnStart = false;
        try { await Vencord.Plugins.stopPlugin(p); } catch {}
        await settle(250);
        try { await Vencord.Plugins.startPlugin(p); } catch {}
        await settle(500);
    }, name);
}

async function readStyleLen(page, id) {
    return await page.evaluate((sid) => {
        const matches = [...document.querySelectorAll("style")].filter(s => s.id === sid);
        const s = matches.at(-1);
        return {
            id: s?.id ?? null,
            count: matches.length,
            len: s?.textContent?.length ?? 0,
            sample: s?.textContent?.slice(0, 100) ?? ""
        };
    }, id);
}

async function phaseHotkeys(page) {
    const out = {};

    // CompactView
    const compactBefore = await shot(page, "compact-before");
    const cvStyleBefore = await readStyleLen(page, "dm-compact-view");
    out.compactView = { activate: await activateViaRestart(page, "CompactView") };
    await new Promise(r => setTimeout(r, 600));
    const cvStyleAfter = await readStyleLen(page, "dm-compact-view");
    const compactAfter = await shot(page, "compact-after");
    await deactivateAndCleanup(page, "CompactView");
    await new Promise(r => setTimeout(r, 400));
    const compactRestored = await shot(page, "compact-restored");
    out.compactView.styleBefore = cvStyleBefore;
    out.compactView.styleAfter = cvStyleAfter;
    out.compactView.toggledOnDetected = cvStyleAfter.len > cvStyleBefore.len;
    out.compactView.screenshots = { before: compactBefore, after: compactAfter, restored: compactRestored };

    // TournamentMode
    const tmBefore = await readStyleLen(page, "dm-tournament-mode");
    out.tournamentMode = { activate: await activateViaRestart(page, "TournamentMode") };
    await new Promise(r => setTimeout(r, 600));
    const tmAfter = await readStyleLen(page, "dm-tournament-mode");
    const tmShot = await shot(page, "tournament-on");
    await deactivateAndCleanup(page, "TournamentMode");
    out.tournamentMode.styleBefore = tmBefore;
    out.tournamentMode.styleAfter = tmAfter;
    out.tournamentMode.toggledOnDetected = tmAfter.len > tmBefore.len;
    out.tournamentMode.screenshot = tmShot;

    return out;
}

// ── Phase: badge (Channels A/B/C/D) ────────────────────────────────────────
async function flipBadgeToggle(page, settingKey) {
    return await page.evaluate(async (key) => {
        const p = Vencord.Plugins.plugins.DMBadge;
        if (!p) return { error: "DMBadge not loaded" };
        const def = p.settings?.def?.[key];
        const store = p.settings?.store;
        if (!def || !store) return { error: "settings shape unexpected", hasDef: !!def, hasStore: !!store };
        const before = store[key];
        store[key] = true;
        Vencord.PlainSettings.plugins.DMBadge = Vencord.PlainSettings.plugins.DMBadge || { enabled: true };
        Vencord.PlainSettings.plugins.DMBadge[key] = true;
        try {
            if (typeof def.onChange === "function") def.onChange(true);
            return { ok: true, before, after: true };
        } catch (e) {
            return { error: String(e), before };
        }
    }, settingKey);
}

async function fetchOwnProfile(page) {
    return await page.evaluate(async () => {
        try {
            const me = Vencord.Webpack.Common.UserStore.getCurrentUser();
            const res = await Vencord.Webpack.Common.RestAPI.get({
                url: `/users/${me.id}/profile?with_mutual_guilds=false`
            });
            const u = res?.body?.user ?? {};
            const up = res?.body?.user_profile ?? {};
            return {
                id: me.id,
                username: u.username ?? me.username,
                bio: up.bio ?? "",
                pronouns: up.pronouns ?? "",
                accentColor: up.accent_color ?? null,
                fullKeys: Object.keys(res?.body ?? {})
            };
        } catch (e) {
            return { err: e?.text ?? e?.body ?? String(e), status: e?.status };
        }
    });
}

async function fetchOwnSettings(page) {
    return await page.evaluate(async () => {
        try {
            const res = await Vencord.Webpack.Common.RestAPI.get({ url: "/users/@me/settings" });
            return { ok: true, custom_status: res?.body?.custom_status ?? null };
        } catch (e) {
            return { err: e?.text ?? e?.body ?? String(e), status: e?.status };
        }
    });
}

async function phaseBadge(page) {
    const out = {};
    out.profileBefore = await fetchOwnProfile(page);
    out.settingsBefore = await fetchOwnSettings(page);

    // Channel A — read badge registration via _getBadges()
    out.channelA = await page.evaluate(() => {
        try {
            const me = Vencord.Webpack.Common.UserStore.getCurrentUser();
            const badges = Vencord.Api.Badges._getBadges?.({ userId: me.id, guildId: undefined }) ?? [];
            const dmBadge = badges.find(b => b?.id === "discordmaxxer-user");
            return {
                pluginEnabled: Vencord.PlainSettings.plugins.DMBadge?.enabled === true,
                meId: me?.id,
                badgesShownForMe: badges.length,
                badgeIds: badges.map(b => b.id),
                discordmaxxerBadgePresent: !!dmBadge
            };
        } catch (e) {
            return { error: String(e) };
        }
    });

    // Channel B — custom status
    out.channelB = { flip: await flipBadgeToggle(page, "customStatusOnce") };
    await new Promise(r => setTimeout(r, 1500));
    out.channelB.settingsAfter = await fetchOwnSettings(page);

    // Channel C — bio append
    out.channelC = { flip: await flipBadgeToggle(page, "bioAppendOnce") };
    await new Promise(r => setTimeout(r, 1500));
    out.channelC.profileAfter = await fetchOwnProfile(page);

    // Channel D — pronouns
    out.channelD = { flip: await flipBadgeToggle(page, "pronounsOnce") };
    await new Promise(r => setTimeout(r, 1500));
    out.channelD.profileAfter = await fetchOwnProfile(page);

    out.screenshot = await shot(page, "badge-after");
    return out;
}

// ── Phase: massdelete (context menu wiring only — no destructive run) ──────
async function phaseMassDelete(page) {
    const out = {};
    out.beforeFlip = await page.evaluate(() => ({
        enableContextMenu: Vencord.PlainSettings.plugins.MassDelete?.enableContextMenu === true,
        enabled: Vencord.PlainSettings.plugins.MassDelete?.enabled === true
    }));

    // Flip enableContextMenu on, restart plugin so context menu patch attaches
    await page.evaluate(() => {
        Vencord.PlainSettings.plugins.MassDelete = Vencord.PlainSettings.plugins.MassDelete || { enabled: true };
        Vencord.PlainSettings.plugins.MassDelete.enableContextMenu = true;
        const p = Vencord.Plugins.plugins.MassDelete;
        if (p) {
            try { Vencord.Plugins.stopPlugin(p); } catch {}
            try { Vencord.Plugins.startPlugin(p); } catch {}
        }
    });
    await new Promise(r => setTimeout(r, 500));

    out.afterFlip = await page.evaluate(() => ({
        enableContextMenu: Vencord.PlainSettings.plugins.MassDelete?.enableContextMenu === true
    }));

    // Verify context menu API has our patches registered
    out.patches = await page.evaluate(() => {
        const cm = Vencord.Api?.ContextMenu;
        const patches = cm?.navPatches ?? cm?._navContextMenuPatches ?? cm?.contextMenuPatches ?? null;
        if (!patches) return { error: "ContextMenu API shape unexpected", keys: Object.keys(cm ?? {}) };
        const targets = ["channel-context", "thread-context", "user-context", "gdm-context", "message"];
        const map = {};
        for (const t of targets) {
            const set = patches.get?.(t) ?? patches[t];
            map[t] = set ? (set.size ?? set.length ?? "present") : "absent";
        }
        return map;
    });

    // Restore the caller's prior setting; this validator must not silently
    // change a user's MassDelete preference just because it inspected wiring.
    await page.evaluate((wasEnabled) => {
        Vencord.PlainSettings.plugins.MassDelete.enableContextMenu = wasEnabled;
        const p = Vencord.Plugins.plugins.MassDelete;
        if (p) {
            try { Vencord.Plugins.stopPlugin(p); } catch {}
            try { Vencord.Plugins.startPlugin(p); } catch {}
        }
    }, out.beforeFlip.enableContextMenu);

    return out;
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
    let browser;
    try {
        const conn = await connect();
        browser = conn.browser;
        const { page } = conn;

        log("Connected. URL:", page.url());
        log("Waiting for Vencord init...");
        const vReady = await waitForVencord(page);
        if (!vReady) throw new Error("Vencord did not become ready within 60s");
        const userReady = await waitForUserStore(page);
        if (!userReady) log("WARN: UserStore did not populate (logged out?). Continuing — some checks will be limited.");

        for (const phase of PHASE_NAMES) {
            if (skips.has(phase)) {
                log(`SKIP phase: ${phase}`);
                continue;
            }
            log(`▶ ${phase}`);
            try {
                if (phase === "inventory") report.phases.inventory = await phaseInventory(page);
                else if (phase === "visual") report.phases.visual = await phaseVisual(page);
                else if (phase === "hotkeys") report.phases.hotkeys = await phaseHotkeys(page);
                else if (phase === "badge") report.phases.badge = await phaseBadge(page);
                else if (phase === "massdelete") report.phases.massdelete = await phaseMassDelete(page);
                log(`  ✓ ${phase} done`);
            } catch (e) {
                err(`  ✗ ${phase} failed:`, e.message);
                report.phases[phase] = { error: e.message, stack: e.stack };
            }
        }

        const reportPath = join(REPORTS_DIR, `validate-${RUN_TS}.json`);
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
        log(`Report written: ${reportPath}`);
        console.log("\n=== SUMMARY ===");
        console.log(JSON.stringify(report, null, 2));
        process.exit(0);
    } catch (e) {
        err("FATAL:", e.message);
        if (browser) try { browser.disconnect(); } catch {}
        process.exit(1);
    }
})();

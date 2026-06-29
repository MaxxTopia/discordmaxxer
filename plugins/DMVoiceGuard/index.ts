/*
 * Discordmaxxer — DMVoiceGuard
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Safeguard against SILENT voice breakage.
 *
 * When Discord ships a server-side change the current build can't handle, voice
 * can quietly loop "Authenticating -> Disconnected" forever with no user-facing
 * signal — users assume the app is dead and go back to vanilla Discord. That is
 * exactly what happened with Discord's mandatory DAVE E2EE rollout (the DAVE
 * wasm was served zstd-encoded, which Electron's intercepted response path
 * couldn't decode -> RTC close code 4017 -> endless loop). It went unnoticed
 * for a while because nothing told the user *why*.
 *
 * This watcher reads the voice connection's own console output (Discord's
 * stable RTCConnection / RTCControlSocket / LibDaveManager log lines — not
 * webpack internals, so it survives UI churn) and, when it detects the
 * fail-and-retry pattern or a definitive DAVE/encryption failure, surfaces a
 * dismissible banner with "Check for updates" + "Copy report" so the failure is
 * LOUD and self-fixable — even with no developer in the loop.
 *
 * See TROUBLESHOOTING.md for the close-code -> cause -> fix runbook.
 */

import definePlugin from "@utils/types";
import { FluxDispatcher, Toasts } from "@webpack/common";

const FAIL_WINDOW_MS = 30_000;
const FAIL_THRESHOLD = 3; // repeated generic voice-socket closes within the window
const RING_MAX = 80;

// Where users send reports. Opening this is user-initiated (a button click) and
// the report only ever lives on their clipboard — nothing is sent automatically.
// Keeps the "zero outbound calls" promise; just gives the manual report a home.
const MAXXTOPIA_DISCORD = "https://discord.gg/S78eecbWdx";

// Definitive "voice is broken, the build is behind" signals — fire immediately.
const FATAL_RE = /Failed to initialize DAVE|DAVE preload failed|E2EE\/DAVE protocol required/i;
// Generic abnormal voice-gateway closes (4xxx) — fire only if repeated in-call.
const CLOSE_RE = /(WS CLOSED|Disconnected from RTC server)[^]*code:\s*4\d{3}/i;
// Lines worth keeping in the diagnostics report.
const CAPTURE_RE = /\bRTC\w*\b|discord\.media|DAVE|E2EE|wasm|CONTENT_DECODING|voice/i;
const VERSION_RE = /Discordmaxxer v([\d.]+)/i;

let inVoice = false;
let failTimes: number[] = [];
let ring: string[] = [];
let appVersion = "";
let bannerShown = false;
let voiceSelectHandler: ((e: any) => void) | null = null;

type ConsoleMethod = "log" | "info" | "warn" | "error";
const originals: Partial<Record<ConsoleMethod, (...a: any[]) => void>> = {};
// The exact wrapper we installed, per method — so restoreConsole only unwraps
// when OURS is still the active console method. If another plugin wrapped on
// top of us, blindly writing back `orig` would clobber their wrapper.
const wrappers: Partial<Record<ConsoleMethod, (...a: any[]) => void>> = {};

function flatten(args: any[]): string {
    try {
        return args
            .map(a => {
                if (typeof a === "string") return a;
                try {
                    return JSON.stringify(a);
                } catch {
                    return String(a);
                }
            })
            .join(" ");
    } catch {
        return "";
    }
}

function observe(line: string) {
    if (!line) return;

    const vm = VERSION_RE.exec(line);
    if (vm) appVersion = vm[1];

    if (CAPTURE_RE.test(line)) {
        ring.push(`${new Date().toISOString()}  ${line.slice(0, 300)}`);
        if (ring.length > RING_MAX) ring.shift();
    }

    // Definitive failure (DAVE/encryption) — can fire even before the user
    // joins a call, which is ideal: warn them up front.
    if (FATAL_RE.test(line)) {
        showBanner();
        return;
    }

    // Generic repeated voice-socket failures while in a channel.
    if (inVoice && CLOSE_RE.test(line)) {
        const t = Date.now();
        failTimes.push(t);
        failTimes = failTimes.filter(x => t - x <= FAIL_WINDOW_MS);
        if (failTimes.length >= FAIL_THRESHOLD) showBanner();
    }
}

function wrapConsole() {
    (["log", "info", "warn", "error"] as ConsoleMethod[]).forEach(m => {
        if (originals[m]) return;
        const orig = (console as any)[m].bind(console);
        originals[m] = orig;
        const wrapped = (...args: any[]) => {
            try {
                observe(flatten(args));
            } catch {
                /* never break the console */
            }
            return orig(...args);
        };
        wrappers[m] = wrapped;
        (console as any)[m] = wrapped;
    });
}

function restoreConsole() {
    (Object.keys(originals) as ConsoleMethod[]).forEach(m => {
        const orig = originals[m];
        // Only restore if OUR wrapper is still the active method. If another
        // plugin wrapped console after us, leave the chain intact rather than
        // clobber their wrapper with our saved original.
        if (orig && (console as any)[m] === wrappers[m]) {
            (console as any)[m] = orig;
        }
        delete originals[m];
        delete wrappers[m];
    });
}

function buildReport(): string {
    let v = appVersion;
    if (!v) {
        try {
            v = (globalThis as any).VesktopNative?.app?.getVersion?.() ?? "?";
        } catch {
            v = "?";
        }
    }
    return [
        "Discordmaxxer voice diagnostics",
        `version: ${v}`,
        `captured: ${new Date().toISOString()}`,
        "",
        "recent voice / RTC log:",
        ...(ring.length ? ring.slice(-40) : ["(no voice log captured)"])
    ].join("\n");
}

let bannerEl: HTMLDivElement | null = null;
let styleEl: HTMLStyleElement | null = null;

const STYLE = `
.dm-voiceguard {
    position: fixed; top: 0; left: 50%; transform: translateX(-50%);
    z-index: 100000; margin-top: 8px; max-width: 560px; width: calc(100% - 32px);
    display: flex; align-items: center; gap: 12px;
    padding: 12px 14px; border-radius: 10px;
    background: #1b0d12; color: #f5e6ea;
    border: 1px solid #e25b6a; box-shadow: 0 8px 28px rgba(0,0,0,.55);
    font-size: 13.5px; line-height: 1.35;
}
.dm-voiceguard b { color: #ff8a98; }
.dm-voiceguard .dm-vg-msg { flex: 1; }
.dm-voiceguard button {
    border: 0; border-radius: 6px; padding: 7px 11px; cursor: pointer;
    font-weight: 600; font-size: 12.5px; white-space: nowrap;
}
.dm-voiceguard .dm-vg-update { background: #e25b6a; color: #fff; }
.dm-voiceguard .dm-vg-copy { background: #3a2b30; color: #f5e6ea; }
.dm-voiceguard .dm-vg-x { background: transparent; color: #c9b3b9; padding: 7px 9px; }
.dm-voiceguard button:hover { filter: brightness(1.12); }
`;

function showBanner() {
    if (bannerShown) return;
    bannerShown = true;

    try {
        styleEl = document.createElement("style");
        styleEl.textContent = STYLE;
        document.head.appendChild(styleEl);

        bannerEl = document.createElement("div");
        bannerEl.className = "dm-voiceguard";
        bannerEl.setAttribute("role", "alert");

        const msg = document.createElement("div");
        msg.className = "dm-vg-msg";
        msg.innerHTML =
            "<b>Voice isn't connecting.</b> This is usually a sign Discordmaxxer needs an update — " +
            "Discord changes can break voice until the app catches up.";

        const update = document.createElement("button");
        update.className = "dm-vg-update";
        update.textContent = "Check for updates";
        update.onclick = () => {
            try {
                (globalThis as any).VesktopNative?.app?.openUpdater?.();
            } catch {
                /* ignore */
            }
        };

        const copy = document.createElement("button");
        copy.className = "dm-vg-copy";
        copy.textContent = "Report a bug";
        copy.title =
            "Copies a diagnostics report to your clipboard and opens the Maxxtopia Discord so you can paste it. Nothing is sent automatically.";
        copy.onclick = () => {
            const report = buildReport();
            const go = () => {
                try {
                    window.open(MAXXTOPIA_DISCORD, "_blank");
                } catch {
                    /* ignore */
                }
                Toasts.show({
                    message: "Report copied — paste it in the Maxxtopia Discord to send it.",
                    type: Toasts.Type.SUCCESS,
                    id: Toasts.genId(),
                    options: { duration: 4000, position: Toasts.Position.BOTTOM }
                });
            };
            try {
                navigator.clipboard.writeText(report).then(go, go);
            } catch {
                go();
            }
        };

        const close = document.createElement("button");
        close.className = "dm-vg-x";
        close.textContent = "✕";
        close.setAttribute("aria-label", "Dismiss");
        close.onclick = () => hideBanner();

        bannerEl.append(msg, update, copy, close);
        document.body.appendChild(bannerEl);
    } catch {
        /* if the DOM isn't ready / injection fails, don't crash */
    }
}

function hideBanner() {
    bannerShown = false;
    bannerEl?.remove();
    styleEl?.remove();
    bannerEl = null;
    styleEl = null;
    failTimes = [];
}

export default definePlugin({
    name: "DMVoiceGuard",
    description:
        "Safeguard: detects when voice calls silently fail to connect (e.g. a Discord change the build can't handle yet) and shows an actionable banner with Check-for-updates + Copy-report, so the failure is visible and fixable instead of silent.",
    authors: [{ name: "Diggy", id: 0n }],

    start() {
        wrapConsole();
        voiceSelectHandler = (e: any) => {
            try {
                inVoice = !!e?.channelId;
                if (!inVoice) hideBanner(); // left voice — clear the warning
            } catch {
                /* ignore */
            }
        };
        FluxDispatcher.subscribe("VOICE_CHANNEL_SELECT", voiceSelectHandler);
    },

    stop() {
        restoreConsole();
        if (voiceSelectHandler) FluxDispatcher.unsubscribe("VOICE_CHANNEL_SELECT", voiceSelectHandler);
        voiceSelectHandler = null;
        hideBanner();
        ring = [];
        failTimes = [];
        inVoice = false;
    }
});

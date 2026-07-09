/*
 * Discordmaxxer — VideoBackground plugin (VIP+ feature)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Plays an MP4 (or any browser-supported video) as a full-window background
 * behind Discord's UI, with adjustable opacity and blur. Discord chrome stays
 * fully usable on top.
 *
 * VIP+ feature — gated by Tier.MAXXER_PLUS. Plugin loads for all users so the
 * settings panel shows the upgrade message; actual video injection only fires
 * when the tier check passes.
 *
 * Sources: http(s):// URL field, OR an "Upload local video" button that uses
 * URL.createObjectURL on a user-picked file (blob: URLs satisfy Discord's CSP).
 * Local picks are runtime-only — not persisted across reloads.
 */

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Button, React, Toasts } from "@webpack/common";

import { makePersistentValue } from "../_dm-shared/persist";
import { getMyTier, hasTier, Tier, TIER_LABELS, tierGateMessage } from "../_dm-shared/vip";

const REQUIRED_TIER = Tier.MAXXER_PLUS;
const VIDEO_ID = "dm-video-bg";

// Saved video bg slots — persisted via DataStore (IndexedDB). Tier-gated max:
//   FREE = 1 (funnel: gives a taste, friction to swap pushes upgrade)
//   MAXXER = 5 · MAXXER+ = 20 · MAXXER++ = unlimited
// Local file uploads (blob: URLs) stay runtime-only — those are scratchpad
// content, can't survive relaunch anyway, so they don't count toward slots.
// (Was localStorage, which modern Discord nukes → slots silently never saved.)
const SLOTS_KEY = "dm-video-bg-slots";

interface SavedSlot {
    id: string;
    name: string;
    url: string;
    opacity?: number;
    blur?: number;
    sidebarOpacity?: number;
    savedAt: number;
}

function tierSlotCap(tier: Tier): number {
    switch (tier) {
        case Tier.MAXXER_PLUS_PLUS: return Infinity;
        case Tier.MAXXER_PLUS: return 20;
        case Tier.MAXXER: return 5;
        default: return 1;
    }
}

const slotStore = makePersistentValue<SavedSlot[]>(SLOTS_KEY, [], raw => {
    if (!Array.isArray(raw)) return null;
    return raw.filter(s => s && typeof s.id === "string" && typeof s.url === "string" && s.url.length > 0);
});

function readSlots(): SavedSlot[] {
    return slotStore.get();
}

function writeSlots(slots: SavedSlot[]): void {
    slotStore.set(slots);
}

function newSlotId(): string {
    return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Public test video — known-good HTTPS source, ~1MB MP4.
const SAMPLE_VIDEO_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

let videoEl: HTMLVideoElement | null = null;
let style: HTMLStyleElement | null = null;
// Runtime-only blob URL when the user picks a local file. NOT persisted.
let localBlobUrl: string | null = null;
// Set true while we're intentionally pulling the src out from under the
// <video>. The browser fires an `error` event on src removal which the
// onerror handler would otherwise mistake for a real hard failure and
// auto-clear the URL — making toggle-off then toggle-on look broken.
let tearingDown = false;

// TournamentMode integration: a full-window looping video keeps the GPU
// decoding during a match — exactly the cost TM exists to kill (the rest of the
// suite pauses animated content in TM; this brings VideoBackground in line). We
// PAUSE rather than tear down, so leaving TM resumes instantly with no re-buffer,
// and the last frame stays behind the chrome (avoids the "transparent chrome with
// nothing behind = looks like a crash" trap). A light poll flips it back on TM
// off. Mirrors DMProfileFlair's TM read.
let tmPollTimer: ReturnType<typeof setInterval> | null = null;
function isTournamentModeActive(): boolean {
    return !!(globalThis as any).Vencord?.PlainSettings?.plugins?.TournamentMode?.manuallyActive;
}
function reconcileTournamentMode() {
    if (!videoEl) return;
    const tm = isTournamentModeActive();
    if (tm && !videoEl.paused) {
        videoEl.pause();
    } else if (!tm && videoEl.paused && settings.store.enable && hasTier(REQUIRED_TIER)) {
        videoEl.play().catch(() => { /* autoplay policy — harmless, user can toggle */ });
    }
}

function buildCss() {
    const opacity = Math.max(0, Math.min(100, settings.store.opacity)) / 100;
    const blur = Math.max(0, Math.min(40, settings.store.blur));
    const sidebarAlpha = Math.max(0, Math.min(100, settings.store.sidebarOpacity)) / 100;
    return `
        /* Override Discord's themed background CSS variables so the chat
           area shows the video through. Sidebars stay semi-opaque (driven
           by sidebarOpacity setting) for text readability. Selectors are
           prefixed with html. to bump specificity above theme rules that
           tend to use multi-class selectors. */
        html,
        html:root,
        html.theme-dark,
        html.theme-light,
        html.theme-darker,
        html.visual-refresh,
        html.theme-dark.visual-refresh,
        html.theme-light.visual-refresh,
        html.theme-darker.visual-refresh {
            /* Legacy chrome vars */
            --background-primary: transparent !important;
            --background-secondary: rgba(0, 0, 0, ${sidebarAlpha * 0.55}) !important;
            --background-secondary-alt: rgba(0, 0, 0, ${sidebarAlpha * 0.65}) !important;
            --background-tertiary: rgba(0, 0, 0, ${sidebarAlpha * 0.7}) !important;
            --background-floating: rgba(0, 0, 0, ${sidebarAlpha * 0.85}) !important;
            --background-accent: transparent !important;
            --background-modifier-accent: rgba(255, 255, 255, 0.04) !important;
            /* Visual-refresh chrome vars */
            --bg-overlay-chat: transparent !important;
            --bg-overlay-app-frame: transparent !important;
            --bg-overlay-1: transparent !important;
            --bg-overlay-2: rgba(0, 0, 0, ${sidebarAlpha * 0.35}) !important;
            --bg-overlay-3: rgba(0, 0, 0, ${sidebarAlpha * 0.4}) !important;
            --bg-overlay-floating: rgba(0, 0, 0, ${sidebarAlpha * 0.85}) !important;
            --bg-base-primary: transparent !important;
            --bg-base-secondary: rgba(0, 0, 0, ${sidebarAlpha * 0.6}) !important;
            --bg-base-tertiary: rgba(0, 0, 0, ${sidebarAlpha * 0.7}) !important;
            --bg-base-low: rgba(0, 0, 0, ${sidebarAlpha * 0.45}) !important;
            --bg-surface-overlay: rgba(0, 0, 0, ${sidebarAlpha * 0.55}) !important;
            --bg-surface-overlay-tinted: rgba(0, 0, 0, ${sidebarAlpha * 0.55}) !important;
            --bg-surface-raised: rgba(0, 0, 0, ${sidebarAlpha * 0.65}) !important;
            --bg-app-frame: transparent !important;
        }

        /* Class-selector fallback for structural divs Discord paints
           backgrounds on directly. html prefix raises specificity above
           single-class theme rules; html body chain raises further. */
        html,
        html body,
        html body [class^="appMount"],
        html body [class*=" appMount"],
        html body [class^="app-"],
        html body [class*=" app-"],
        html body [class^="layers"],
        html body [class*=" layers"],
        html body [class^="layer"]:first-child,
        html body [class*=" layer"]:first-child,
        html body [class^="bg-"],
        html body [class*=" bg-"],
        html body [class*="container"][class*="root"],
        html body [class*="base-"][class*="base"],
        html body [class^="chat"][class*="chat"] > [class*="content"],
        html body [class*="chatContent"],
        html body [class*="visualRefresh"],
        html body [class*="pageWrapper"] {
            background: transparent !important;
            background-color: transparent !important;
            background-image: none !important;
        }

        #${VIDEO_ID} {
            position: fixed;
            inset: 0;
            width: 100vw;
            height: 100vh;
            object-fit: cover;
            object-position: center;
            /* z-index 0 + position: fixed puts the video at the bottom of
               its stacking context; Discord's chrome (z-index: auto / >0)
               paints over it. Using 0 instead of -1 because some Discord
               wrappers create stacking contexts that hide negative z-index
               children entirely. */
            z-index: 0;
            opacity: ${opacity};
            filter: blur(${blur}px);
            pointer-events: none;
            transition: opacity 0.3s ease, filter 0.3s ease;
        }
    `;
}

function ensureVideoEl(): HTMLVideoElement {
    let el = document.getElementById(VIDEO_ID) as HTMLVideoElement | null;
    if (!el) {
        el = document.createElement("video");
        el.id = VIDEO_ID;
        el.autoplay = true;
        el.loop = true;
        el.playsInline = true;
        el.muted = settings.store.mute;
        el.volume = 0.4;
        document.body.prepend(el);
    }
    return el;
}

function activeUrl(): string {
    // Local pick wins over typed URL when present
    if (localBlobUrl) return localBlobUrl;
    return settings.store.videoUrl?.trim() ?? "";
}

function applyVideoSettings() {
    if (!videoEl) return;
    const url = activeUrl();
    if (url && videoEl.src !== url) videoEl.src = url;
    videoEl.muted = settings.store.mute;
    videoEl.playbackRate = settings.store.playbackRate;
    if (style) style.textContent = buildCss();
}

function tearDownVideo() {
    if (videoEl) {
        tearingDown = true;
        // Detach the error handler first so the synthetic error from removing
        // src doesn't slip past the flag.
        videoEl.onerror = null;
        videoEl.onloadeddata = null;
        videoEl.pause();
        videoEl.removeAttribute("src");
        videoEl.load();
        videoEl.remove();
        videoEl = null;
        // Reset asynchronously: the `error` event from src removal fires after
        // this synchronous block, so clearing the flag synchronously would let
        // a stray error slip past the onerror guard. (Detaching onerror above
        // is the primary safeguard; this keeps the flag honest as a backstop.)
        queueMicrotask(() => { tearingDown = false; });
    }
    if (style) style.textContent = "";
}

/** The video sits at z-index 0 under Discord's chrome, so it is only visible
 *  because buildCss() forces those backgrounds transparent. When the video is
 *  demonstrably playing but invisible, some element we DIDN'T clear is painted
 *  on top. Log the element over the screen centre plus any ancestor with a
 *  non-transparent background — that names the culprit's class directly. */
function logCoverageDiagnostic() {
    try {
        const cx = Math.round(window.innerWidth / 2);
        const cy = Math.round(window.innerHeight / 2);
        const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
        console.log("[VideoBackground] diag: element over screen centre:", el?.tagName, el?.className || "(no class)");

        let node: HTMLElement | null = el;
        let found = 0;
        for (let i = 0; i < 8 && node; i++) {
            const s = getComputedStyle(node);
            const hasBg = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
            const hasImg = s.backgroundImage !== "none";
            if (hasBg || hasImg) {
                found++;
                console.warn(
                    `[VideoBackground] diag: OPAQUE ancestor -> ${node.className || node.tagName}` +
                    ` | bg=${s.backgroundColor} | img=${s.backgroundImage.slice(0, 48)}`
                );
            }
            node = node.parentElement;
        }
        if (!found) {
            console.log("[VideoBackground] diag: no opaque ancestors — backgrounds are clear. If you still can't see it, check the Opacity slider.");
        }
    } catch {
        /* diagnostic only — never affect playback */
    }
}

function refresh() {
    if (!hasTier(REQUIRED_TIER)) {
        console.log("[VideoBackground] refresh: tier check failed (need MAXXER+, got tier from claim cache or hardcoded list)");
        tearDownVideo();
        return;
    }
    if (!settings.store.enable) {
        console.log("[VideoBackground] refresh: plugin disabled in settings");
        tearDownVideo();
        return;
    }
    const url = activeUrl();
    if (!url) {
        console.log("[VideoBackground] refresh: no video URL or local file picked");
        tearDownVideo();
        return;
    }
    videoEl = ensureVideoEl();
    console.log("[VideoBackground] refresh: video element in DOM, src =", url.slice(0, 80));
    applyVideoSettings();

    // Surface the load lifecycle so the user can tell from devtools console
    // whether the video resource itself fails (CSP / CORS / 404 / format).
    videoEl.onloadeddata = () => console.log("[VideoBackground] loadeddata — video has frames");
    videoEl.onerror = () => {
        if (tearingDown) return;
        const code = videoEl?.error?.code;
        const msg = videoEl?.error?.message ?? "unknown";
        const codeLabels: Record<number, string> = {
            1: "MEDIA_ERR_ABORTED",
            2: "MEDIA_ERR_NETWORK (CSP/CORS/404)",
            3: "MEDIA_ERR_DECODE (codec)",
            4: "MEDIA_ERR_SRC_NOT_SUPPORTED (format/CSP)"
        };
        console.warn(`[VideoBackground] error ${code} (${codeLabels[code ?? -1] ?? "?"}):`, msg);

        // Hard failures (network / decode / unsupported) won't fix themselves on
        // retry — auto-clear the broken source so we don't re-toast on every
        // launch. ABORTED (1) is transient (typically a src swap mid-refresh).
        const hardFailure = code === 2 || code === 3 || code === 4;
        if (hardFailure) {
            const wasBlob = !!localBlobUrl;
            const brokenUrl = settings.store.videoUrl;
            if (localBlobUrl) {
                URL.revokeObjectURL(localBlobUrl);
                localBlobUrl = null;
            }
            // Only clear the typed videoUrl when the typed URL is what failed.
            // When a local blob failed, activeUrl() was the blob (it wins over
            // videoUrl) — wiping videoUrl would destroy a perfectly good saved
            // remote URL. Dropping the blob lets refresh() fall back to it.
            if (!wasBlob) settings.store.videoUrl = "";
            tearDownVideo();
            const sourceLabel = wasBlob
                ? "(local file)"
                : brokenUrl ? `"${brokenUrl.slice(0, 40)}${brokenUrl.length > 40 ? "…" : ""}"` : "";
            Toasts.show({
                message: `🛑 Video background — ${codeLabels[code] ?? "error"}. Cleared broken source ${sourceLabel}. Pick a new URL in VideoBackground settings or hit "Test with sample".`,
                type: Toasts.Type.FAILURE,
                id: Toasts.genId(),
                options: { duration: 8000, position: Toasts.Position.TOP }
            });
            return;
        }

        Toasts.show({
            message: `Video failed: ${codeLabels[code ?? -1] ?? "unknown"}. Open devtools (Ctrl+Shift+I) for details.`,
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: { duration: 6000, position: Toasts.Position.TOP }
        });
    };

    // Hold paused while TournamentMode is active — don't spin the GPU mid-match.
    // The poll (started in start()) resumes it the moment TM turns off. Tell the
    // user, otherwise enabling the feature looks silently broken.
    if (isTournamentModeActive()) {
        videoEl.pause();
        console.log("[VideoBackground] TournamentMode active — holding video paused to free GPU");
        Toasts.show({
            message: "🎮 TournamentMode is on, so the video background is paused to free GPU. Turn TM off to see it.",
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
            options: { duration: 6000, position: Toasts.Position.TOP }
        });
        return;
    }

    videoEl.play().then(() => {
        console.log("[VideoBackground] play() resolved — video is playing");
        // If the video plays but the user can't see it, something opaque is
        // painted over it. Name it here so diagnosing never needs devtools
        // spelunking: whatever prints as OPAQUE is what buildCss() failed to
        // clear (a Discord class we don't cover, or a third-party theme).
        logCoverageDiagnostic();
    }).catch(e => {
        console.warn("[VideoBackground] play() rejected:", e);
        Toasts.show({
            message: `Play blocked — try toggling the plugin off+on once. ${e?.message ?? ""}`,
            type: Toasts.Type.FAILURE,
            id: Toasts.genId(),
            options: { duration: 4000, position: Toasts.Position.TOP }
        });
    });
}

function pickLocalFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        if (localBlobUrl) URL.revokeObjectURL(localBlobUrl);
        localBlobUrl = URL.createObjectURL(file);
        Toasts.show({
            message: `🎬 Loaded local video: ${file.name} (${(file.size / 1_048_576).toFixed(1)} MB)`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId(),
            options: { duration: 3000, position: Toasts.Position.TOP }
        });
        if (!settings.store.enable) settings.store.enable = true;
        refresh();
    };
    input.click();
}

function clearLocalFile() {
    if (localBlobUrl) {
        URL.revokeObjectURL(localBlobUrl);
        localBlobUrl = null;
    }
    refresh();
}

function VideoControls() {
    return (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <Button onClick={pickLocalFile} size={Button.Sizes.SMALL}>
                📁 Upload local video
            </Button>
            <Button onClick={clearLocalFile} size={Button.Sizes.SMALL} color={Button.Colors.RED}>
                ✕ Clear upload
            </Button>
            <Button
                size={Button.Sizes.SMALL}
                color={Button.Colors.GREEN}
                onClick={() => {
                    if (localBlobUrl) {
                        URL.revokeObjectURL(localBlobUrl);
                        localBlobUrl = null;
                    }
                    settings.store.videoUrl = SAMPLE_VIDEO_URL;
                    if (!settings.store.enable) settings.store.enable = true;
                    refresh();
                    Toasts.show({
                        message: "🎬 Sample video applied — Big Buck Bunny",
                        type: Toasts.Type.SUCCESS,
                        id: Toasts.genId(),
                        options: { duration: 3000, position: Toasts.Position.TOP }
                    });
                }}
            >
                🎬 Test with sample
            </Button>
        </div>
    );
}

function toast(message: string, type: any = Toasts.Type.MESSAGE, durationMs = 3000) {
    Toasts.show({
        message, type,
        id: Toasts.genId(),
        options: { duration: durationMs, position: Toasts.Position.TOP }
    });
}

function SavedSlotsPanel() {
    const [slots, setSlots] = React.useState<SavedSlot[]>(() => readSlots());
    const [name, setName] = React.useState("");

    // DataStore loads async; the initial get() may be empty on first paint.
    // Re-read once the store is ready so saved slots appear without a reload.
    React.useEffect(() => {
        let alive = true;
        slotStore.ready.then(() => { if (alive) setSlots(readSlots()); });
        return () => { alive = false; };
    }, []);

    const tier = getMyTier();
    const cap = tierSlotCap(tier);
    const capLabel = cap === Infinity ? "unlimited" : `${cap}`;
    const tierName = TIER_LABELS[tier];
    const atCap = slots.length >= cap;

    const persist = (next: SavedSlot[]) => {
        writeSlots(next);
        setSlots(next);
    };

    const onSaveCurrent = () => {
        const url = (settings.store.videoUrl ?? "").trim();
        if (!url || !/^https?:\/\//i.test(url)) {
            toast("Set a https:// video URL above before saving (local file uploads can't be saved to slots).", Toasts.Type.FAILURE);
            return;
        }
        if (atCap) {
            toast(`Slot cap reached (${cap}). Delete a slot or upgrade — current tier ${tierName}.`, Toasts.Type.FAILURE, 5000);
            return;
        }
        const slot: SavedSlot = {
            id: newSlotId(),
            name: name.trim() || `Background ${slots.length + 1}`,
            url,
            opacity: settings.store.opacity,
            blur: settings.store.blur,
            sidebarOpacity: settings.store.sidebarOpacity,
            savedAt: Date.now()
        };
        persist([...slots, slot]);
        setName("");
        toast(`💾 Saved "${slot.name}" — ${slots.length + 1}/${capLabel}`, Toasts.Type.SUCCESS);
    };

    const onLoad = (slot: SavedSlot) => {
        if (localBlobUrl) {
            URL.revokeObjectURL(localBlobUrl);
            localBlobUrl = null;
        }
        settings.store.videoUrl = slot.url;
        if (typeof slot.opacity === "number") settings.store.opacity = slot.opacity;
        if (typeof slot.blur === "number") settings.store.blur = slot.blur;
        if (typeof slot.sidebarOpacity === "number") settings.store.sidebarOpacity = slot.sidebarOpacity;
        if (!settings.store.enable) settings.store.enable = true;
        refresh();
        toast(`▶ Playing "${slot.name}"`, Toasts.Type.SUCCESS);
    };

    const onDelete = (id: string) => {
        const slot = slots.find(s => s.id === id);
        persist(slots.filter(s => s.id !== id));
        if (slot) toast(`🗑 Deleted "${slot.name}"`, Toasts.Type.MESSAGE);
    };

    const wrapStyle: React.CSSProperties = {
        marginTop: 12,
        padding: "12px 14px",
        background: "rgba(226, 91, 255, 0.05)",
        border: "1px solid rgba(226, 91, 255, 0.25)",
        borderRadius: 8
    };
    const headerStyle: React.CSSProperties = {
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 10, flexWrap: "wrap", gap: 6
    };
    const titleStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "#fbefff", letterSpacing: 0.2 };
    const counterStyle: React.CSSProperties = {
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: 11,
        padding: "3px 8px",
        borderRadius: 999,
        background: atCap ? "rgba(255, 85, 85, 0.18)" : "rgba(85, 255, 255, 0.14)",
        color: atCap ? "#ff8a8a" : "#9be7ff",
        border: `1px solid ${atCap ? "rgba(255,85,85,0.3)" : "rgba(85,255,255,0.25)"}`
    };
    const inputStyle: React.CSSProperties = {
        flex: 1,
        minWidth: 140,
        padding: "7px 10px",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(0,0,0,0.3)",
        color: "#fff",
        fontSize: 12.5
    };
    const slotRow: React.CSSProperties = {
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 8px", marginTop: 4,
        background: "rgba(0,0,0,0.22)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6
    };
    const slotName: React.CSSProperties = { flex: 1, fontSize: 12.5, color: "#dde2ee", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
    const slotUrl: React.CSSProperties = { fontSize: 10.5, color: "#8a91a3", fontFamily: "ui-monospace,Menlo,Consolas,monospace", marginLeft: 8 };

    return (
        <div style={wrapStyle}>
            <div style={headerStyle}>
                <div style={titleStyle}>💾 Saved video backgrounds</div>
                <div style={counterStyle}>{slots.length} / {capLabel} · {tierName}</div>
            </div>
            {!hasTier(REQUIRED_TIER) && (
                <div style={{ fontSize: 11.5, color: "#cbd0e0", marginBottom: 8, opacity: 0.85 }}>
                    Saving is available at every tier (FREE saves 1). The video bg <em>feature</em> needs MAXXER+ to actually play — see settings above.
                </div>
            )}
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input
                    type="text"
                    placeholder="Optional slot name (e.g. 'rainy night')"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") onSaveCurrent(); }}
                    style={inputStyle}
                    spellCheck={false}
                />
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={onSaveCurrent} disabled={atCap}>
                    💾 Save current URL
                </Button>
            </div>
            {slots.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "#8a91a3", marginTop: 10, fontStyle: "italic" }}>
                    No saved slots yet. Paste a URL in the field above, optionally name it, then hit Save.
                </div>
            ) : (
                <div style={{ marginTop: 8 }}>
                    {slots.map(slot => (
                        <div key={slot.id} style={slotRow}>
                            <span style={slotName} title={slot.url}>
                                {slot.name}
                                <span style={slotUrl}>{(() => {
                                    try { return new URL(slot.url).host; } catch { return slot.url.slice(0, 30); }
                                })()}</span>
                            </span>
                            <Button size={Button.Sizes.MIN} color={Button.Colors.GREEN} onClick={() => onLoad(slot)}>
                                ▶ Load
                            </Button>
                            <Button size={Button.Sizes.MIN} color={Button.Colors.RED} onClick={() => onDelete(slot.id)}>
                                ✕
                            </Button>
                        </div>
                    ))}
                </div>
            )}
            {atCap && cap !== Infinity && (
                <div style={{ fontSize: 11.5, color: "#ff8a8a", marginTop: 8 }}>
                    🔒 Slot cap reached. Delete a saved slot, or upgrade for more (MAXXER 5 · MAXXER+ 20 · MAXXER++ unlimited).
                </div>
            )}
        </div>
    );
}

const settings = definePluginSettings({
    enable: {
        type: OptionType.BOOLEAN,
        description: "🌟 Enable video background (requires MAXXER+ tier)",
        default: false,
        onChange: () => {
            if (settings.store.enable && !hasTier(REQUIRED_TIER)) {
                Toasts.show({
                    message: `🔒 ${tierGateMessage(REQUIRED_TIER)}`,
                    type: Toasts.Type.FAILURE,
                    id: Toasts.genId(),
                    options: { duration: 5000, position: Toasts.Position.TOP }
                });
                settings.store.enable = false;
                return;
            }
            refresh();
        }
    },
    videoUrl: {
        type: OptionType.STRING,
        description:
            "Video URL — must be a DIRECT video file (the link itself ends in .mp4 or .webm). " +
            "YouTube, TikTok and other page links will NOT work: they serve a web page, not a video file. " +
            "TIP: upload your clip to catbox.moe (or any host that hands back a direct .mp4 link) and paste that link here — " +
            "a URL keeps working after a restart, unlike a local upload. " +
            "Or use 'Upload local video' below to play a file off your disk (held in memory only — cleared when you reload or restart Discordmaxxer).",
        default: "",
        onChange: refresh
    },
    videoControls: {
        type: OptionType.COMPONENT,
        description: "",
        component: VideoControls
    },
    opacity: {
        type: OptionType.SLIDER,
        description: "Opacity (0–100). 30–50 keeps Discord readable on top.",
        default: 35,
        markers: [10, 25, 35, 50, 75, 100],
        onChange: () => {
            // Only rewrite the transparency CSS when a video is actually
            // playing. Otherwise dragging a slider with the feature off (or as
            // a non-entitled user) would make Discord's chrome see-through with
            // nothing behind it — looks like a crash. refresh() re-evaluates
            // tier/enable/url so it tears down vs rebuilds correctly.
            if (style && videoEl) style.textContent = buildCss();
        }
    },
    blur: {
        type: OptionType.SLIDER,
        description: "Blur in pixels (0–40). Higher = softer background, easier on the eyes during heavy chat.",
        default: 0,
        markers: [0, 4, 8, 16, 24, 40],
        onChange: () => {
            // Only rewrite the transparency CSS when a video is actually
            // playing. Otherwise dragging a slider with the feature off (or as
            // a non-entitled user) would make Discord's chrome see-through with
            // nothing behind it — looks like a crash. refresh() re-evaluates
            // tier/enable/url so it tears down vs rebuilds correctly.
            if (style && videoEl) style.textContent = buildCss();
        }
    },
    sidebarOpacity: {
        type: OptionType.SLIDER,
        description:
            "Sidebar / chat-list darkness (0–100). 0 = fully transparent (video shows everywhere), 100 = stock Discord opaque chrome. ~70 keeps text readable.",
        default: 70,
        markers: [0, 25, 50, 70, 100],
        onChange: () => {
            // Only rewrite the transparency CSS when a video is actually
            // playing. Otherwise dragging a slider with the feature off (or as
            // a non-entitled user) would make Discord's chrome see-through with
            // nothing behind it — looks like a crash. refresh() re-evaluates
            // tier/enable/url so it tears down vs rebuilds correctly.
            if (style && videoEl) style.textContent = buildCss();
        }
    },
    savedSlots: {
        type: OptionType.COMPONENT,
        description: "",
        component: SavedSlotsPanel
    },
    mute: {
        type: OptionType.BOOLEAN,
        description: "Mute the video (recommended — Discord audio takes priority)",
        default: true,
        onChange: () => {
            if (videoEl) videoEl.muted = settings.store.mute;
        }
    },
    playbackRate: {
        type: OptionType.SLIDER,
        description: "Playback speed",
        default: 1.0,
        markers: [0.25, 0.5, 1.0, 1.5, 2.0],
        onChange: () => {
            if (videoEl) videoEl.playbackRate = settings.store.playbackRate;
        }
    }
});

export default definePlugin({
    name: "VideoBackground",
    description:
        "🌟 MAXXER+ — Plays a video as Discord's background with adjustable opacity and blur. Use any http(s):// MP4 URL. " +
        "Discord stays fully usable on top. Tier-gated; non-MAXXER+ users see the settings but can't activate.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-video-background", managedStyleRootNode);
        refresh();
        // Poll TM state so toggling TournamentMode pauses/resumes the video
        // without needing a settings change. Cheap (a property read); no-ops when
        // no video is playing.
        tmPollTimer = setInterval(reconcileTournamentMode, 1000);
    },

    stop() {
        if (tmPollTimer) { clearInterval(tmPollTimer); tmPollTimer = null; }
        tearDownVideo();
        if (localBlobUrl) {
            URL.revokeObjectURL(localBlobUrl);
            localBlobUrl = null;
        }
        style?.remove();
        // Null the ref so post-stop slider onChange handlers (which check
        // `if (style)`) don't write into an orphaned, detached <style> node.
        style = null;
    }
});

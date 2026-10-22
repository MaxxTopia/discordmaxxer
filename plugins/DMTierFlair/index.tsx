/*
 * Discordmaxxer — TierFlair plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Cross-Discordmaxxer-user status flex. Modeled on Hypixel's [MVP++] chat
 * tag — visible to OTHER Discordmaxxer users during normal Discord use,
 * driven by the public roster (worker /roster endpoint).
 *
 * Surfaces (all opt-out via plugin settings):
 *   - Avatar tier ring     — 1px tier-color outline around PFPs
 *   - Member list name tint with glow-glimmer pulse (MAXXER+)
 *   - Profile popout banner stripe (all paid tiers)
 *   - Animated profile badge for MAXXER++ (shimmer)
 *   - Founder # badge (numbered gold gem in popouts) via addProfileBadge
 *
 * Implementation: MutationObserver tags any [data-user-id] element with
 *   data-dm-tier="MAXXER" / "MAXXER_PLUS" / "MAXXER_PLUS_PLUS" + an
 *   optional data-dm-founder="N" attribute. Pure CSS handles the visuals
 *   via attribute selectors. No webpack patches required.
 *
 * Founder badge uses Vencord's addProfileBadge API (already supported by
 * the BadgeAPI plugin) so it shows up cleanly in user profile popouts
 * with a hover tooltip "Founder badge" + the numbered gem icon.
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { UserStore } from "@webpack/common";

import { getRosterFounderNumber, getRosterStatus, getRosterTier, onRosterChange, refreshRoster } from "../_dm-shared/roster";
import { getMyTier, Tier, TIER_LABELS } from "../_dm-shared/vip";

// Hypixel-inspired tier colors. MAXXER++ uses a softer champagne gold with a
// deep-wine accent so the role reads premium instead of orange-heavy.
const COLORS = {
    [Tier.MAXXER]: { ring: "#55FF55", name: "#55FF55", glow: "rgba(85, 255, 85, 0.55)" },
    [Tier.MAXXER_PLUS]: { ring: "#55FFFF", name: "#55FFFF", glow: "rgba(85, 255, 255, 0.55)" },
    [Tier.MAXXER_PLUS_PLUS]: { ring: "#F3D27A", name: "#FFE5A8", glow: "rgba(243, 210, 122, 0.55)" }
} as const;

// Founder badges shown via addProfileBadge. We register one badge per number
// 1..33 and gate its `shouldShow` to "this user owns this number" — that way
// each numbered SVG icon is generated once and Vencord routes the right one
// to the right user popout.
const FOUNDER_CAP = 33;
const FOUNDER_BADGES = new Map<string, ProfileBadge>();
const MAXXER_PLUS_PLUS_BADGE_ID = "discordmaxxer-tier-maxxer-plus-plus";
let maxxerPlusPlusBadge: ProfileBadge | null = null;
let stopRosterListener: (() => void) | null = null;

/**
 * The public roster is the source of truth for other users, but it is not
 * guaranteed to be hydrated when Discord first renders the current user's
 * popout. Use the same self-tier resolver as the tier-gated plugins for our
 * own profile, so a hardcoded owner tier or freshly-bound claim is not lost
 * just because the roster request is still in flight.
 */
function getDisplayTier(userId: string): Tier {
    try {
        if (UserStore.getCurrentUser()?.id === userId) return getMyTier();
    } catch {
        // Discord can briefly expose UserStore before it is fully initialized.
    }
    return getRosterTier(userId);
}

const BADGE_FINISH_OPTIONS = [
    { label: "Champagne Sweep", value: "gold", description: "Soft champagne gold with a deep-wine edge." },
    { label: "Sunset Ember", value: "sunset", description: "Orange-to-crimson sunset finish." },
    { label: "Aurora Ice", value: "aurora", description: "Cool cyan-to-violet aurora finish." }
] as const;

function makeFounderBadgeSvg(n: number): string {
    // Compact SVG: gold radial gem + the number centered, white text shadow
    // for legibility at small render sizes. URL-encoded data: URL works in
    // Discord avatar/badge img src without CSP fuss.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <defs>
    <radialGradient id="g${n}" cx="30%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#FFE7A8"/>
      <stop offset="55%" stop-color="#C68A1A"/>
      <stop offset="100%" stop-color="#5A3508"/>
    </radialGradient>
  </defs>
  <circle cx="12" cy="12" r="11" fill="url(#g${n})" stroke="#FFAA00" stroke-width="0.8"/>
  <text x="12" y="15.5" text-anchor="middle"
    font-family="Tungsten Bold, Bebas Neue, Oswald, Arial Black, sans-serif"
    font-size="10" font-weight="800" fill="#1a0e02"
    letter-spacing="-0.3">#${n}</text>
</svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function registerFounderBadges() {
    for (let n = 1; n <= FOUNDER_CAP; n++) {
        const id = `discordmaxxer-founder-${n}`;
        if (FOUNDER_BADGES.has(id)) continue;
        const badge: ProfileBadge = {
            id,
            description: `Founder #${n} of ${FOUNDER_CAP} — Discordmaxxer Founder badge`,
            iconSrc: makeFounderBadgeSvg(n),
            position: BadgePosition.START,
            shouldShow: ({ userId }) => getRosterFounderNumber(userId) === n
        };
        addProfileBadge(badge);
        FOUNDER_BADGES.set(id, badge);
    }
}

function unregisterFounderBadges() {
    for (const [id, badge] of FOUNDER_BADGES) {
        try {
            // Badges are stored in a Set, so removal must use the exact object
            // that was passed to addProfileBadge rather than a new { id } object.
            removeProfileBadge(badge);
        } catch (e) {
            console.warn("[TierFlair] removeProfileBadge failed for", id, e);
        }
    }
    FOUNDER_BADGES.clear();
}

function makeMaxxerPlusPlusBadgeSvg(animated: boolean, finish: string): string {
    // The badge is an ordinary data-URL image so it works in the same native
    // profile-badge slot as Founder badges. The base gradient is the static
    // fallback; the clipped sheen is an optional SMIL animation layered on
    // top, so reduced-motion/older Chromium still gets a readable badge.
    const palettes: Record<string, { light: string; mid: string; deep: string; shine: string; stroke: string; text: string }> = {
        gold: { light: "#FFF4C2", mid: "#F3D27A", deep: "#8F1D3B", shine: "#FFF9E6", stroke: "#FFE7A8", text: "#29120A" },
        sunset: { light: "#FFD0A8", mid: "#FF6B35", deep: "#C92A5A", shine: "#FFE6C7", stroke: "#FFB38A", text: "#2B0B0B" },
        aurora: { light: "#D7FFFF", mid: "#55FFFF", deep: "#7E5BFF", shine: "#F3FFFF", stroke: "#B3FFFF", text: "#07152A" }
    };
    const palette = palettes[finish] ?? palettes.gold;
    const sheen = animated
        ? `<rect x="-36" y="-4" width="7" height="40" rx="3.5" fill="${palette.shine}" opacity="0.88" transform="rotate(45 12 12)">
    <animateTransform attributeName="transform" type="translate" from="-32 32" to="32 -32" dur="2.2s" repeatCount="indefinite" additive="sum"/>
  </rect>`
        : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <defs>
    <linearGradient id="dmpp-base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.light}"/>
      <stop offset="46%" stop-color="${palette.mid}"/>
      <stop offset="100%" stop-color="${palette.deep}"/>
    </linearGradient>
    <clipPath id="dmpp-clip"><circle cx="12" cy="12" r="10.7"/></clipPath>
  </defs>
  <circle cx="12" cy="12" r="11" fill="url(#dmpp-base)" stroke="${palette.stroke}" stroke-width="0.8"/>
  <g clip-path="url(#dmpp-clip)">${sheen}</g>
  <text x="12" y="15.7" text-anchor="middle"
    font-family="Tungsten Bold, Bebas Neue, Oswald, Arial Black, sans-serif"
    font-size="9.5" font-weight="900" fill="${palette.text}" letter-spacing="-0.7">++</text>
</svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function registerMaxxerPlusPlusBadge() {
    if (maxxerPlusPlusBadge) return;
    const badge: ProfileBadge = {
        id: MAXXER_PLUS_PLUS_BADGE_ID,
        description: "MAXXER++ tier badge — selectable finish with an optional light sweep",
        iconSrc: makeMaxxerPlusPlusBadgeSvg(settings.store.animatedBadgePlusPlus, settings.store.badgeFinish),
        position: BadgePosition.START,
        link: "https://maxxtopia.com/discordmaxxer/vip/",
        shouldShow: ({ userId }: { userId: string }) => getDisplayTier(userId) >= Tier.MAXXER_PLUS_PLUS
    };
    addProfileBadge(badge);
    maxxerPlusPlusBadge = badge;
}

function unregisterMaxxerPlusPlusBadge() {
    if (!maxxerPlusPlusBadge) return;
    try {
        // See unregisterFounderBadges: the Vencord badge registry is Set-based.
        removeProfileBadge(maxxerPlusPlusBadge);
    } catch (e) {
        console.warn("[TierFlair] removeProfileBadge failed for MAXXER++ badge", e);
    }
    maxxerPlusPlusBadge = null;
}

function BadgeFinishPreview() {
    const selectedFinish = String(settings.store.badgeFinish);
    const animated = settings.store.animatedBadgePlusPlus;

    return (
        <div
            role="group"
            aria-label="MAXXER++ badge finish previews"
            style={{
                marginTop: "8px",
                padding: "12px",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.035)"
            }}
        >
            <div style={{ color: "#e7eaf2", fontSize: "13px", fontWeight: 700, marginBottom: "4px" }}>
                MAXXER++ badge finish previews
            </div>
            <div style={{ color: "#aeb5c7", fontSize: "12px", lineHeight: 1.35, marginBottom: "10px" }}>
                Pick a finish above. The selected option is outlined here, and the same badge appears in eligible profile popouts.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {BADGE_FINISH_OPTIONS.map(finish => {
                    const selected = finish.value === selectedFinish;
                    return (
                        <div
                            key={finish.value}
                            style={{
                                flex: "1 1 120px",
                                minWidth: "112px",
                                padding: "9px 8px",
                                borderRadius: "8px",
                                border: `1px solid ${selected ? "#55FFFF" : "rgba(255,255,255,0.14)"}`,
                                background: selected ? "rgba(85,255,255,0.09)" : "rgba(0,0,0,0.16)",
                                boxShadow: selected ? "0 0 12px rgba(85,255,255,0.18)" : "none",
                                textAlign: "center"
                            }}
                        >
                            <img
                                src={makeMaxxerPlusPlusBadgeSvg(animated, finish.value)}
                                alt={`${finish.label} badge preview`}
                                draggable={false}
                                style={{ width: "52px", height: "52px", display: "block", margin: "0 auto 6px" }}
                            />
                            <div style={{ color: "#e7eaf2", fontSize: "12px", fontWeight: 700 }}>{finish.label}</div>
                            <div style={{ color: selected ? "#55FFFF" : "#9299aa", fontSize: "11px", marginTop: "3px" }}>
                                {selected ? "Selected" : finish.description}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let rescanTimer: ReturnType<typeof setInterval> | null = null;
let tierFlairStarted = false;

function buildCss() {
    const showRing = settings.store.avatarRing;
    const showNameTint = settings.store.nameTint;
    const showBanner = settings.store.popoutBanner;
    const showVoiceColor = settings.store.voiceColor;
    const showAboutCredit = settings.store.aboutCredit;
    const animateMaxxerPP = settings.store.animatedBadgePlusPlus;

    const ringRule = (tier: Tier, c: typeof COLORS[Tier.MAXXER]) =>
        showRing
            ? `
        /* Avatar tier ring — target ONLY the foreignObject SVG element that
           Discord wraps every avatar in for status-indicator compositing.
           The previous selector \`[class*="avatar"]:not([class*="status"])\`
           matched multiple nested wrappers per avatar (avatarHint outer,
           avatar inner, image leaf) which all received the same box-shadow,
           producing 3-4 stacked rings at slightly different radii — that's
           what looked like ring misalignment. foreignObject is the single
           outermost circular slot, naturally one-per-avatar, no nesting. */
        [data-dm-tier="${TIER_LABELS[tier]}"] foreignObject {
            box-shadow: 0 0 0 1.5px ${c.ring}, 0 0 6px ${c.glow};
            border-radius: 50%;
            overflow: visible;
        }
    `
            : "";

    const nameRule = (tier: Tier, c: typeof COLORS[Tier.MAXXER]) =>
        showNameTint
            ? `
        [data-dm-tier="${TIER_LABELS[tier]}"] [class*="username"],
        [data-dm-tier="${TIER_LABELS[tier]}"][class*="member"] [class*="name"] {
            color: ${c.name} !important;
            text-shadow: 0 0 6px ${c.glow};
            ${tier === Tier.MAXXER_PLUS ? "animation: dm-glimmer-aqua 2.4s ease-in-out infinite;" : ""}
            ${tier === Tier.MAXXER_PLUS_PLUS && animateMaxxerPP ? "animation: dm-shimmer-gold 2.8s ease-in-out infinite;" : ""}
        }
    `
            : "";

    const bannerRule = (tier: Tier, c: typeof COLORS[Tier.MAXXER]) =>
        showBanner
            ? `
        /* Profile popout banner stripe — full-width tier color across the
           top of the popout. Selector targets the popout's banner container
           when its rendered for a tagged user. */
        [class*="userPopout"]:has([data-dm-tier="${TIER_LABELS[tier]}"]) [class*="banner"]:first-of-type::before {
            content: "";
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 4px;
            background: linear-gradient(90deg, transparent, ${c.ring}, transparent);
            box-shadow: 0 0 8px ${c.glow};
            pointer-events: none;
            z-index: 2;
        }
    `
            : "";

    return `
        @keyframes dm-glimmer-aqua {
            0%, 100% { text-shadow: 0 0 6px rgba(85, 255, 255, 0.45); }
            50%      { text-shadow: 0 0 14px rgba(85, 255, 255, 0.95), 0 0 24px rgba(85, 255, 255, 0.4); }
        }
        @keyframes dm-shimmer-gold {
            0%, 100% { text-shadow: 0 0 6px rgba(255, 170, 0, 0.45); }
            45%      { text-shadow: 0 0 14px rgba(255, 170, 0, 0.95), 0 0 26px rgba(255, 85, 85, 0.4); }
            55%      { text-shadow: 0 0 14px rgba(255, 85, 85, 0.95), 0 0 26px rgba(255, 170, 0, 0.4); }
        }

        /* Tier rings */
        ${ringRule(Tier.MAXXER, COLORS[Tier.MAXXER])}
        ${ringRule(Tier.MAXXER_PLUS, COLORS[Tier.MAXXER_PLUS])}
        ${ringRule(Tier.MAXXER_PLUS_PLUS, COLORS[Tier.MAXXER_PLUS_PLUS])}

        /* Name tints */
        ${nameRule(Tier.MAXXER, COLORS[Tier.MAXXER])}
        ${nameRule(Tier.MAXXER_PLUS, COLORS[Tier.MAXXER_PLUS])}
        ${nameRule(Tier.MAXXER_PLUS_PLUS, COLORS[Tier.MAXXER_PLUS_PLUS])}

        /* Popout banner stripes */
        ${bannerRule(Tier.MAXXER, COLORS[Tier.MAXXER])}
        ${bannerRule(Tier.MAXXER_PLUS, COLORS[Tier.MAXXER_PLUS])}
        ${bannerRule(Tier.MAXXER_PLUS_PLUS, COLORS[Tier.MAXXER_PLUS_PLUS])}

        /* Founder gem badge enhancement — applies on top of the addProfileBadge-
           rendered SVG for an extra glow halo. Hover tooltip is set on the
           badge's description property — Vencord renders it on hover. */
        [data-dm-founder] img[src*="discordmaxxer-founder"],
        img[src*="discordmaxxer-founder"] {
            filter: drop-shadow(0 0 6px rgba(255, 170, 0, 0.55));
        }

        /* Voice channel name color — MAXXER++ only. Tags the voice-channel
           member row's username so MAXXER++ users light up gold while in VC.
           Discord uses [class*="voiceUser"] for the row and [class*="name"] /
           [class*="usernameInner"] for the username text. We scope by voice
           context so we don't double-paint the existing member-list tint.
           Selector value uses TIER_LABELS so it stays in sync with the
           data-dm-tier attribute the DOM observer sets (= "MAXXER++"). */
        ${showVoiceColor ? `
        [class*="voiceUser"][data-dm-tier="${TIER_LABELS[Tier.MAXXER_PLUS_PLUS]}"] [class*="name"],
        [class*="voiceUser"][data-dm-tier="${TIER_LABELS[Tier.MAXXER_PLUS_PLUS]}"] [class*="username"],
        [class*="voiceUser"] [data-dm-tier="${TIER_LABELS[Tier.MAXXER_PLUS_PLUS]}"] [class*="name"],
        [class*="voiceUser"] [data-dm-tier="${TIER_LABELS[Tier.MAXXER_PLUS_PLUS]}"] [class*="username"] {
            color: ${COLORS[Tier.MAXXER_PLUS_PLUS].name} !important;
            text-shadow: 0 0 6px ${COLORS[Tier.MAXXER_PLUS_PLUS].glow};
            ${animateMaxxerPP ? "animation: dm-shimmer-gold 2.8s ease-in-out infinite;" : ""}
        }
        ` : ""}

        /* About credit — MAXXER++ only. Injects a "Discordmaxxer ++ supporter"
           line in the bio area of MAXXER++ users' profile popouts. Visible to
           any other Discordmaxxer user opening their popout. NOT a Discord
           account mutation — pure client-side decoration, gated by roster.
           Selector value uses TIER_LABELS to match the data-dm-tier value
           the DOM observer sets (= "MAXXER++"). */
        ${showAboutCredit ? `
        [class*="userPopout"]:has([data-dm-tier="${TIER_LABELS[Tier.MAXXER_PLUS_PLUS]}"]) [class*="bio"]::after,
        [class*="userProfile"]:has([data-dm-tier="${TIER_LABELS[Tier.MAXXER_PLUS_PLUS]}"]) [class*="bio"]::after,
        [class*="userPopout"]:has([data-dm-tier="${TIER_LABELS[Tier.MAXXER_PLUS_PLUS]}"]) [class*="userInfoSection"]:first-of-type::after {
            content: "★ Discordmaxxer++ supporter";
            display: block;
            margin-top: 8px;
            padding: 4px 10px;
            border-radius: 4px;
            background: linear-gradient(90deg, ${COLORS[Tier.MAXXER_PLUS_PLUS].glow}, transparent);
            color: ${COLORS[Tier.MAXXER_PLUS_PLUS].name};
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            text-shadow: 0 0 6px ${COLORS[Tier.MAXXER_PLUS_PLUS].glow};
            border-left: 2px solid ${COLORS[Tier.MAXXER_PLUS_PLUS].ring};
        }
        ` : ""}
    `;
}

function tagElement(el: Element) {
    const userId = el.getAttribute("data-user-id");
    // Discord virtualizes its member/voice lists: it RECYCLES the same row
    // DOM node for a different user as you scroll, mutating only its
    // data-user-id. Keying idempotency on element identity (the old WeakSet)
    // meant a recycled row kept the PREVIOUS user's tier ring/badge. Key on
    // the userId we last tagged this element for instead, and re-tag whenever
    // it changes.
    const node = el as HTMLElement;
    // Stamp the idempotency key with the roster's fetch time. The roster loads
    // asynchronously and returns FREE until the fetch resolves; without the
    // stamp, a row tagged FREE pre-load would never re-evaluate (its userId
    // hasn't changed). When the cache is replaced, the stamp changes and the
    // next scan re-tags every row with the now-correct tier.
    const rosterStamp = String(getRosterStatus().fetchedAt ?? 0);
    const wantTag = userId ? `${userId}:${rosterStamp}` : "";
    const taggedFor = node.dataset?.dmTierFor ?? "";
    if (taggedFor === wantTag) return;

    // Reset any prior user's tagging before applying the new one (or none).
    el.removeAttribute("data-dm-tier");
    el.removeAttribute("data-dm-founder");

    if (!userId) {
        if (node.dataset) delete node.dataset.dmTierFor;
        return;
    }
    if (node.dataset) node.dataset.dmTierFor = wantTag;

    const tier = getDisplayTier(userId);
    if (tier > Tier.FREE) {
        el.setAttribute("data-dm-tier", TIER_LABELS[tier]);
    }

    const founderN = getRosterFounderNumber(userId);
    if (founderN) {
        el.setAttribute("data-dm-founder", String(founderN));
    }
}

function scanRoot(root: ParentNode = document) {
    if (root instanceof Element && root.closest?.(".vc-settings-tab, [class*='standardSidebarView']")) return;
    if (root === document && document.querySelector("[class*='standardSidebarView']")) return;
    // tagElement is now idempotent per-userId, so we can scan all rows (not
    // just untagged ones) and recycled rows still get corrected.
    root.querySelectorAll("[data-user-id]").forEach(tagElement);
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            if ((m.target as Element)?.closest?.(".vc-settings-tab, [class*='standardSidebarView']")) {
                continue;
            }
            if (m.type === "attributes") {
                // A recycled row whose data-user-id changed in place.
                if (m.target instanceof Element) tagElement(m.target);
                continue;
            }
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.hasAttribute("data-user-id")) tagElement(node);
                scanRoot(node);
            }
        }
    });
    // attributeFilter keeps the attribute callbacks scoped to the one
    // attribute we care about — not a firehose of every style/class change.
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-user-id"]
    });
    scanRoot(document);
    // Low-frequency rescan so rows tagged before the async roster load (or after
    // a manual "Refresh roster") self-correct. The stamped key makes this a
    // cheap no-op when nothing changed.
    if (!rescanTimer) rescanTimer = setInterval(() => scanRoot(document), 5000);
}

function refreshTierFlairSurface() {
    if (!tierFlairStarted) return;
    // The badge registry evaluates shouldShow while a profile surface is
    // opening. Re-register after an async roster replacement so a popout that
    // opened during the initial fetch gets the newly eligible badge too.
    unregisterMaxxerPlusPlusBadge();
    registerMaxxerPlusPlusBadge();
    scanRoot(document);
}

function stopObserver() {
    observer?.disconnect();
    observer = null;
    if (rescanTimer) {
        clearInterval(rescanTimer);
        rescanTimer = null;
    }
    document.querySelectorAll<HTMLElement>("[data-dm-tier], [data-dm-founder], [data-dm-tier-for]").forEach(el => {
        el.removeAttribute("data-dm-tier");
        el.removeAttribute("data-dm-founder");
        delete el.dataset.dmTierFor;
    });
}

const settings = definePluginSettings({
    avatarRing: {
        type: OptionType.BOOLEAN,
        description: "Avatar tier ring — 1px colored outline around PFPs of Discordmaxxer users you can see in the roster.",
        default: true,
        onChange: () => { if (style) style.textContent = buildCss(); }
    },
    nameTint: {
        type: OptionType.BOOLEAN,
        description: "Member list name tint with glow-glimmer — names of MAXXER+ users pulse aqua, MAXXER++ shimmer champagne.",
        default: true,
        onChange: () => { if (style) style.textContent = buildCss(); }
    },
    popoutBanner: {
        type: OptionType.BOOLEAN,
        description: "Profile popout banner stripe — 4px tier-color stripe across the top of the popout when you open a tagged user's profile.",
        default: true,
        onChange: () => { if (style) style.textContent = buildCss(); }
    },
    animatedBadgePlusPlus: {
        type: OptionType.BOOLEAN,
        description: "Animate the MAXXER++ tier badge and name tint with a champagne→wine light sweep. Disable if it's distracting.",
        default: true,
        onChange: () => {
            if (style) style.textContent = buildCss();
            if (tierFlairStarted) {
                unregisterMaxxerPlusPlusBadge();
                registerMaxxerPlusPlusBadge();
            }
        }
    },
    badgeFinish: {
        type: OptionType.SELECT,
        description: "MAXXER++ only — choose the finish of your profile badge: Champagne Sweep, Sunset Ember, or Aurora Ice.",
        default: "gold",
        options: [
            { label: "Champagne Sweep", value: "gold", default: true },
            { label: "Sunset Ember", value: "sunset" },
            { label: "Aurora Ice", value: "aurora" }
        ],
        onChange: () => {
            if (tierFlairStarted) {
                unregisterMaxxerPlusPlusBadge();
                registerMaxxerPlusPlusBadge();
            }
        }
    },
    badgeFinishPreview: {
        type: OptionType.COMPONENT,
        description: "",
        component: BadgeFinishPreview
    },
    voiceColor: {
        type: OptionType.BOOLEAN,
        description: "Voice channel name color (MAXXER++ only) — champagne tint on MAXXER++ users while in voice channels.",
        default: true,
        onChange: () => { if (style) style.textContent = buildCss(); }
    },
    aboutCredit: {
        type: OptionType.BOOLEAN,
        description: "About credit (MAXXER++ only) — adds a 'Discordmaxxer++ supporter' strip in MAXXER++ users' profile popouts.",
        default: true,
        onChange: () => { if (style) style.textContent = buildCss(); }
    },
    refreshRoster: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => {
            const onRefresh = async () => {
                await refreshRoster();
                // Force re-tag so any newly-elevated users pick up styles.
                stopObserver();
                startObserver();
            };
            return (
                <button
                    onClick={onRefresh}
                    style={{
                        padding: "6px 12px",
                        borderRadius: "6px",
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: "rgba(255,255,255,0.06)",
                        color: "#cbd0e0",
                        fontSize: "12px",
                        cursor: "pointer",
                        marginTop: "6px"
                    }}
                >
                    🔄 Refresh roster now
                </button>
            );
        }
    }
});

export default definePlugin({
    name: "DMTierFlair",
    description:
        "Cross-user status flex (Hypixel-style). Avatar rings, name tints, popout banners, a selectable animated MAXXER++ tier badge, and numbered Founder gems for users in the public roster. Pure cosmetic, opt-out per surface, no webpack patches.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        tierFlairStarted = true;
        style = createAndAppendStyle("dm-tier-flair", managedStyleRootNode);
        style.textContent = buildCss();
        registerFounderBadges();
        registerMaxxerPlusPlusBadge();
        stopRosterListener = onRosterChange(refreshTierFlairSurface);
        startObserver();
        // Hydrate immediately rather than waiting for the first tagged row to
        // trigger a background fetch. This removes the first-open race for
        // profile badges and member-list flair.
        void refreshRoster();
    },

    stop() {
        tierFlairStarted = false;
        stopRosterListener?.();
        stopRosterListener = null;
        stopObserver();
        unregisterFounderBadges();
        unregisterMaxxerPlusPlusBadge();
        style?.remove();
        style = null;
    }
});

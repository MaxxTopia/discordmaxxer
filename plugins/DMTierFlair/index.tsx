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
 *   - Profile popout banner stripe (MAXXER+)
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

import { getRosterFounderNumber, getRosterStatus, getRosterTier, refreshRoster } from "../_dm-shared/roster";
import { Tier, TIER_LABELS } from "../_dm-shared/vip";

// Hypixel-aligned tier colors. MAXXER+ uses one bracket color; MAXXER++ has
// a second "plus" color (Hypixel's red §c) we apply as the animated shimmer.
const COLORS = {
    [Tier.MAXXER]: { ring: "#55FF55", name: "#55FF55", glow: "rgba(85, 255, 85, 0.55)" },
    [Tier.MAXXER_PLUS]: { ring: "#55FFFF", name: "#55FFFF", glow: "rgba(85, 255, 255, 0.55)" },
    [Tier.MAXXER_PLUS_PLUS]: { ring: "#FFAA00", name: "#FFD27A", glow: "rgba(255, 170, 0, 0.6)" }
} as const;

// Founder badges shown via addProfileBadge. We register one badge per number
// 1..33 and gate its `shouldShow` to "this user owns this number" — that way
// each numbered SVG icon is generated once and Vencord routes the right one
// to the right user popout.
const FOUNDER_CAP = 33;
const FOUNDER_BADGE_IDS = new Set<string>();

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
        if (FOUNDER_BADGE_IDS.has(id)) continue;
        const badge: ProfileBadge = {
            id,
            description: `Founder #${n} of ${FOUNDER_CAP} — Discordmaxxer Founder badge`,
            iconSrc: makeFounderBadgeSvg(n),
            position: BadgePosition.START,
            shouldShow: ({ userId }) => getRosterFounderNumber(userId) === n
        };
        addProfileBadge(badge);
        FOUNDER_BADGE_IDS.add(id);
    }
}

function unregisterFounderBadges() {
    for (const id of FOUNDER_BADGE_IDS) {
        try {
            removeProfileBadge({ id } as ProfileBadge);
        } catch (e) {
            console.warn("[TierFlair] removeProfileBadge failed for", id, e);
        }
    }
    FOUNDER_BADGE_IDS.clear();
}

let style: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let rescanTimer: ReturnType<typeof setInterval> | null = null;

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

    const tier = getRosterTier(userId);
    if (tier > Tier.FREE) {
        el.setAttribute("data-dm-tier", TIER_LABELS[tier]);
    }

    const founderN = getRosterFounderNumber(userId);
    if (founderN) {
        el.setAttribute("data-dm-founder", String(founderN));
    }
}

function scanRoot(root: ParentNode = document) {
    // tagElement is now idempotent per-userId, so we can scan all rows (not
    // just untagged ones) and recycled rows still get corrected.
    root.querySelectorAll("[data-user-id]").forEach(tagElement);
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver(mutations => {
        for (const m of mutations) {
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
        description: "Member list name tint with glow-glimmer — names of MAXXER+ users pulse aqua, MAXXER++ shimmer gold.",
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
        description: "Animated shimmer for MAXXER++ name tint (gold→red→gold sweep). Disable if it's distracting.",
        default: true,
        onChange: () => { if (style) style.textContent = buildCss(); }
    },
    voiceColor: {
        type: OptionType.BOOLEAN,
        description: "Voice channel name color (MAXXER++ only) — gold tint on MAXXER++ users while in voice channels.",
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
        "Cross-user status flex (Hypixel-style). Avatar rings, name tints, popout banners, and numbered Founder gems for users in the public roster. Pure cosmetic, opt-out per surface, no webpack patches.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {
        style = createAndAppendStyle("dm-tier-flair", managedStyleRootNode);
        style.textContent = buildCss();
        registerFounderBadges();
        startObserver();
    },

    stop() {
        stopObserver();
        unregisterFounderBadges();
        style?.remove();
        style = null;
    }
});

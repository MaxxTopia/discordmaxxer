/*
 * Discordmaxxer — Hypixel-style VIP tier card
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Replaces Vencord's <SpecialCard> donation slot with a 4-tier ladder
 * styled after OG Hypixel 2016 ranks. The ladder shows all tiers, with
 * the user's current tier highlighted, owned tiers checkmarked, and a
 * CTA pointing at the MaxxTopia VIP page for the next tier up.
 *
 * Color palette (verified against Minecraft chat colors §a/§b/§c/§6):
 *   FREE        gray   #9aa1ad  (placeholder; not a Hypixel color)
 *   MAXXER      green  #55FF55  (Hypixel [VIP])
 *   MAXXER+     aqua   #55FFFF  (Hypixel [MVP])
 *   MAXXER++    gold   #FFAA00  (Hypixel [MVP++], with red §c #FF5555 "+")
 *
 * Imported by the rebrand patch in overlay-scripts/rebrand-vencord.mjs,
 * which replaces the SpecialCard JSX in vencord-src's vencord settings tab.
 */

import { React } from "@webpack/common";

import { getMyTier, normalizeTier, Tier, TIER_LABELS } from "./vip";

interface TierVisual {
    tier: Tier;
    bracketColor: string;
    plusColor: string | null;
    perks: string[];
    priceLabel: string;
}

const LADDER: TierVisual[] = [
    {
        tier: Tier.FREE,
        bracketColor: "#9aa1ad",
        plusColor: null,
        perks: ["All plugins · all themes", "Tournament Mode · Hub panel", "1 saved video bg slot"],
        priceLabel: "Free forever"
    },
    {
        tier: Tier.MAXXER,
        bracketColor: "#55FF55",
        plusColor: null,
        perks: ["Custom profile banner · typing prefix · avatar ring", "5 animated cursor skins", "5 saved video bg slots"],
        priceLabel: "$4 / month"
    },
    {
        tier: Tier.MAXXER_PLUS,
        bracketColor: "#55FFFF",
        plusColor: null,
        perks: [
            "Animated profile avatar · video background playback",
            "20 saved video bg slots · 3 exclusive themes",
            "Member list name glow · profile popout tier stripe"
        ],
        priceLabel: "$9 / month"
    },
    {
        tier: Tier.MAXXER_PLUS_PLUS,
        bracketColor: "#FFAA00",
        plusColor: "#FF5555",
        perks: [
            "Profile gradient colors · animated name tint",
            "Custom presence text · voice channel name color",
            "Beta builds · plugin votes · About credit"
        ],
        priceLabel: "$17 / month"
    }
];

function rankBracket(label: string, bracketColor: string, plusColor: string | null, scale = 1) {
    // Render "[NAME]" with optional differently-colored "+" runs (Hypixel-style).
    const text = `[${label}]`;
    if (!plusColor || !label.includes("+")) {
        return (
            <span style={{
                color: bracketColor,
                fontFamily: '"Tungsten Bold", "Bebas Neue", "Oswald", "Arial Black", sans-serif',
                fontSize: `${22 * scale}px`,
                fontWeight: 700,
                letterSpacing: "0.02em",
                textShadow: `0 0 ${10 * scale}px ${bracketColor}66, 0 1px 0 #000`,
                whiteSpace: "nowrap"
            }}>
                {text}
            </span>
        );
    }
    // Split letters: bracket+letters in bracketColor, "+" runs in plusColor.
    const parts: React.ReactNode[] = [];
    let buf = "";
    let bufColor: string | null = null;
    let i = 0;
    for (const ch of text) {
        const targetColor = ch === "+" ? plusColor : bracketColor;
        if (bufColor !== null && bufColor !== targetColor) {
            parts.push(<span key={i++} style={{ color: bufColor, textShadow: `0 0 ${10 * scale}px ${bufColor}66, 0 1px 0 #000` }}>{buf}</span>);
            buf = "";
        }
        buf += ch;
        bufColor = targetColor;
    }
    if (buf && bufColor) {
        parts.push(<span key={i++} style={{ color: bufColor, textShadow: `0 0 ${10 * scale}px ${bufColor}66, 0 1px 0 #000` }}>{buf}</span>);
    }
    return (
        <span style={{
            fontFamily: '"Tungsten Bold", "Bebas Neue", "Oswald", "Arial Black", sans-serif',
            fontSize: `${22 * scale}px`,
            fontWeight: 700,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap"
        }}>
            {parts}
        </span>
    );
}

export function DiscordmaxxerVipCard() {
    const currentTier = normalizeTier(getMyTier());
    const currentVisual = LADDER.find(l => l.tier === currentTier) ?? LADDER[0];
    const nextVisual = LADDER.find(l => l.tier === currentTier + 1) ?? null;

    const heading =
        currentTier === Tier.MAXXER_PLUS_PLUS
            ? "Thanks for going MAXXER++."
            : currentTier === Tier.FREE
                ? "Welcome to Discordmaxxer."
                : `You're ${TIER_LABELS[currentTier]}.`;

    const sub =
        currentTier === Tier.MAXXER_PLUS_PLUS
            ? "Every tier-locked feature is unlocked. Thanks for going MAXXER++."
            : nextVisual
                ? `Next: ${TIER_LABELS[nextVisual.tier]} — ${nextVisual.perks.slice(0, 2).join(", ")}.`
                : "";

    const ctaText = nextVisual ? `Upgrade to ${TIER_LABELS[nextVisual.tier]}` : "View VIP perks";
    const ctaUrl = "https://maxxtopia.com/discordmaxxer/vip";

    return (
        <div style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            padding: "20px 22px",
            marginBottom: "20px",
            borderRadius: "12px",
            // Hypixel-style dark navy gradient background, subtle depth
            background: "linear-gradient(135deg, #0e1330 0%, #1a1e3d 50%, #0e1330 100%)",
            border: `1px solid ${currentVisual.bracketColor}33`,
            boxShadow: `0 0 0 1px ${currentVisual.bracketColor}1a inset, 0 8px 28px ${currentVisual.bracketColor}15`,
            overflow: "hidden"
        }}>
            {/* Top accent bar in current tier color */}
            <div style={{
                position: "absolute",
                top: 0, left: 0, right: 0,
                height: "3px",
                background: `linear-gradient(90deg, transparent, ${currentVisual.bracketColor}, transparent)`,
                opacity: 0.7
            }} />

            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
                {rankBracket(TIER_LABELS[currentTier], currentVisual.bracketColor, currentVisual.plusColor, 1.4)}
                <div style={{ display: "flex", flexDirection: "column", gap: "3px", flex: 1, minWidth: "200px" }}>
                    <div style={{
                        fontSize: "18px",
                        fontWeight: 600,
                        color: "#fff",
                        letterSpacing: "0.005em"
                    }}>
                        {heading}
                    </div>
                    {sub && (
                        <div style={{ fontSize: "13px", color: "#bcc3d3", lineHeight: 1.4 }}>
                            {sub}
                        </div>
                    )}
                    <div style={{ fontSize: "11px", color: "#8f98ad", lineHeight: 1.35 }}>
                        Higher tiers include every benefit from the tiers below.
                    </div>
                </div>
            </div>

            {/* Ladder rows */}
            <div style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                background: "rgba(0, 0, 0, 0.18)",
                border: "1px solid rgba(255, 255, 255, 0.04)",
                borderRadius: "8px",
                padding: "8px",
                fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
                fontSize: "12.5px"
            }}>
                {LADDER.map(row => {
                    const owned = row.tier <= currentTier;
                    const isCurrent = row.tier === currentTier;
                    return (
                        <div
                            key={row.tier}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                padding: "8px 10px",
                                borderRadius: "5px",
                                background: isCurrent
                                    ? `${row.bracketColor}1a`
                                    : owned ? "rgba(255, 255, 255, 0.025)" : "transparent",
                                border: isCurrent
                                    ? `1px solid ${row.bracketColor}66`
                                    : "1px solid transparent",
                                opacity: owned || isCurrent ? 1 : 0.55,
                                transition: "all 0.15s ease"
                            }}
                        >
                            <div style={{ minWidth: "110px", flexShrink: 0 }}>
                                {rankBracket(TIER_LABELS[row.tier], row.bracketColor, row.plusColor, 0.85)}
                            </div>
                            <div style={{
                                flex: 1,
                                color: owned ? "#dde2ee" : "#8a91a3",
                                lineHeight: 1.35
                            }}>
                                {row.perks.join(" · ")}
                            </div>
                            <div style={{
                                fontSize: "11px",
                                color: isCurrent ? row.bracketColor : "#6c7180",
                                fontWeight: isCurrent ? 600 : 400,
                                whiteSpace: "nowrap"
                            }}>
                                {owned ? (isCurrent ? "★ ACTIVE" : "✓ owned") : row.priceLabel}
                            </div>
                        </div>
                    );
                })}
            </div>

            {currentTier !== Tier.MAXXER_PLUS_PLUS && (
                <a
                    href={ctaUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{
                        alignSelf: "flex-start",
                        padding: "9px 18px",
                        borderRadius: "6px",
                        fontSize: "13.5px",
                        fontWeight: 600,
                        color: "#0e1330",
                        background: `linear-gradient(135deg, ${nextVisual?.bracketColor ?? "#fff"}, ${nextVisual?.bracketColor ?? "#fff"}cc)`,
                        textDecoration: "none",
                        boxShadow: `0 0 18px ${nextVisual?.bracketColor ?? "#fff"}55`,
                        cursor: "pointer",
                        letterSpacing: "0.02em",
                        textTransform: "uppercase"
                    }}
                >
                    {ctaText} →
                </a>
            )}

            {/* Founder strip — Hypixel-style scarcity slot. 33 ever, never reissued.
                Pays $67 once, gets a numbered # badge (hover: "Founder badge"),
                1 month MAXXER++ free + a 1-month MAXXER++ gift code, plus
                MAXXER++ price-locked at $12/mo for life (immune to future raises). */}
            <div style={{
                position: "relative",
                marginTop: "4px",
                padding: "14px 16px",
                borderRadius: "10px",
                background: "linear-gradient(135deg, rgba(243,175,25,0.12) 0%, rgba(255,85,85,0.10) 100%)",
                border: "1px solid rgba(243,175,25,0.45)",
                boxShadow: "0 0 0 1px rgba(243,175,25,0.18) inset, 0 6px 22px rgba(243,175,25,0.18)"
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <span style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "44px",
                        height: "44px",
                        borderRadius: "50%",
                        background: "radial-gradient(circle at 30% 30%, #FFD27A, #C68A1A 60%, #5A3508 100%)",
                        boxShadow: "0 0 14px rgba(255,170,0,0.6), inset 0 0 6px rgba(255,255,255,0.35)",
                        fontFamily: '"Tungsten Bold","Bebas Neue","Oswald","Arial Black",sans-serif',
                        fontSize: "18px",
                        fontWeight: 800,
                        color: "#1a0e02",
                        letterSpacing: "0.02em",
                        flexShrink: 0
                    }} title="Founder badge">
                        #
                    </span>
                    <div style={{ flex: 1, minWidth: "200px" }}>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#FFD580", letterSpacing: "0.01em" }}>
                            Founder · 33 ever, never reissued
                        </div>
                        <div style={{ fontSize: "12px", color: "#cbd0e0", marginTop: "3px", lineHeight: 1.4 }}>
                            $67 one-time → your own numbered badge · 1 mo MAXXER++ free · 1-mo gift code for a friend ·
                            <strong style={{ color: "#FFD27A" }}> MAXXER++ at $12/mo for life</strong> (price-locked).
                        </div>
                    </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
                    <a
                        href="https://maxxtopia.com/discordmaxxer/vip#founder"
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{
                            padding: "8px 16px",
                            borderRadius: "6px",
                            fontSize: "12.5px",
                            fontWeight: 700,
                            color: "#1a0e02",
                            background: "linear-gradient(135deg, #FFD27A, #FFAA00)",
                            textDecoration: "none",
                            boxShadow: "0 0 16px rgba(255,170,0,0.45)",
                            letterSpacing: "0.04em",
                            textTransform: "uppercase"
                        }}
                    >
                        Claim a Founder slot →
                    </a>
                    <span style={{ fontSize: "11px", color: "#8a91a3", fontFamily: 'ui-monospace,Menlo,Consolas,monospace' }}>
                        Hover the # to confirm: "Founder badge"
                    </span>
                </div>
            </div>
        </div>
    );
}

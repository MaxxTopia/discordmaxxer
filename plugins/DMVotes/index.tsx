/*
 * Discordmaxxer — DiscordmaxxerVotes plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * MAXXER++ tier perk — plugin votes. Surfaces a panel of candidate
 * features that subscribers can vote on. Aggregate counts come from a
 * Cloudflare Worker (`discordmaxxer-votes`) backed by a KV store; HWID
 * dedup means a single rig can vote for each feature exactly once.
 *
 * Tier gate enforced client-side via the in-app roster check. Worker
 * doesn't independently re-verify tier — that would require ferrying
 * a claim signature on every request, overkill for MVP polls. HWID
 * dedup keeps non-paying users from spamming counts via curl.
 *
 * Worker source: maxxtopia/votes-worker/{worker.js,wrangler.toml}.
 *
 * Top-voted candidate gets shipped in the next release. The candidate
 * list is hand-curated per release — Diggy edits CANDIDATES below and
 * runs `wrangler kv key delete count:<id>` for shipped items.
 */

import { definePluginSettings } from "@api/Settings";
import { React, Toasts } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";

import { makePersistentValue } from "../_dm-shared/persist";
import { hasTier, Tier, tierGateMessage } from "../_dm-shared/vip";

declare global {
    interface Window {
        VesktopNative: {
            hwid?: {
                get: () => Promise<{ ok: boolean; hwid?: string; error?: string }>;
            };
        };
    }
}

const VIP_GATE = Tier.MAXXER_PLUS_PLUS;
const VOTES_API = "https://discordmaxxer-votes.maxxtopia.workers.dev";
const TALLY_REFRESH_MS = 30_000;

interface Candidate {
    id: string;        // stable slug, [a-z0-9-]+, used as KV key suffix
    name: string;
    blurb: string;
}

// Curated v0.7.0 candidate list. Removes shipped items each release;
// always 5-8 candidates. Updated 2026-05-10 — twenty-mention-chimes
// and real-sound-packs-extension shipped in this same release, so
// they're out.
const CANDIDATES: Candidate[] = [
    {
        id: "voice-channel-themes",
        name: "Tier-themed voice-channel audio cues",
        blurb:
            "Custom join/leave/mute SFX matched to your active theme — replaces Discord's defaults for MAXXER+/++."
    },
    {
        id: "custom-cursor-byo",
        name: "Bring-your-own cursor (PNG upload)",
        blurb:
            "MAXXER++ uploads a custom PNG cursor instead of picking from the bundled six. Local-only, never synced."
    },
    {
        id: "tournament-mode-hotkey",
        name: "Tournament Mode global keyboard shortcut",
        blurb:
            "One-key toggle to enter performance mode without alt-tabbing. Bind whatever you like."
    },
    {
        id: "rich-presence-game-detector",
        name: "Game-aware Rich Presence",
        blurb:
            "MAXXER++ presence shows your current game's name + elapsed time, not just 'Discordmaxxer'. Auto-detects from running processes."
    },
    {
        id: "plugin-spotlight-rotation",
        name: "Hub Plugin Spotlight rotation",
        blurb:
            "Auto-rotating featured-plugin card in the Hub showing one less-known Vencord plugin each launch with a one-click enable."
    },
    {
        id: "username-gradient-nameplates",
        name: "Tier-color username gradient in chat",
        blurb:
            "Your messages render with a subtle MAXXER+/++ gradient on the username — visible only to other Discordmaxxer users."
    },
    {
        id: "afk-auto-deafen-sound",
        name: "AFK auto-deafen with custom chime",
        blurb:
            "Auto-deafen + play your active chime when you go AFK in a voice channel. Also auto-undeafens on return."
    }
];

// Persisted via DataStore (IndexedDB). Was localStorage, which modern Discord
// nukes → the "✓ Voted" state was lost every restart. (Server HWID-dedups, so
// this is UX only — but it should still stick.) The validator also fixes the
// old `new Set(JSON.parse(raw))` footgun where a non-array payload became a
// Set of characters.
const VOTED_LS_KEY = "dm-votes-voted";
const votedStore = makePersistentValue<string[]>(VOTED_LS_KEY, [], raw =>
    Array.isArray(raw) ? raw.filter(x => typeof x === "string") : null
);

function getVotedSet(): Set<string> {
    return new Set(votedStore.get());
}

function persistVoted(set: Set<string>) {
    votedStore.set([...set]);
}

async function fetchTally(): Promise<Record<string, number>> {
    try {
        const res = await fetch(`${VOTES_API}/tally`, { method: "GET" });
        if (!res.ok) return {};
        const data = await res.json();
        return data?.counts ?? {};
    } catch { return {}; }
}

async function submitVote(featureId: string): Promise<{ ok: boolean; alreadyVoted: boolean; count: number; error?: string }> {
    let hwid: string | null = null;
    try {
        const r = await window.VesktopNative?.hwid?.get?.();
        if (r?.ok && r.hwid) hwid = r.hwid;
    } catch {}
    if (!hwid) return { ok: false, alreadyVoted: false, count: 0, error: "no-hwid" };

    try {
        const res = await fetch(`${VOTES_API}/vote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feature_id: featureId, hwid })
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) {
            return { ok: false, alreadyVoted: false, count: 0, error: data?.error ?? `http-${res.status}` };
        }
        return { ok: true, alreadyVoted: !!data.alreadyVoted, count: data.count ?? 0 };
    } catch (e: any) {
        return { ok: false, alreadyVoted: false, count: 0, error: e?.message ?? "network" };
    }
}

function VotesPanel() {
    const allowed = hasTier(VIP_GATE);
    const [counts, setCounts] = React.useState<Record<string, number>>({});
    const [voted, setVoted] = React.useState<Set<string>>(() => getVotedSet());
    const [pending, setPending] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        let alive = true;
        const refresh = async () => {
            const c = await fetchTally();
            if (alive) {
                setCounts(c);
                setLoading(false);
            }
        };
        refresh();
        // DataStore loads async — re-read the voted set once it's ready so the
        // "✓ Voted" markers appear without needing a reload.
        votedStore.ready.then(() => { if (alive) setVoted(getVotedSet()); });
        const id = setInterval(refresh, TALLY_REFRESH_MS);
        return () => { alive = false; clearInterval(id); };
    }, []);

    if (!allowed) {
        return (
            <div style={{
                padding: "14px 16px",
                borderRadius: "8px",
                background: "linear-gradient(135deg, rgba(255,170,0,0.06), rgba(255,170,0,0.02))",
                border: "1px solid rgba(255,170,0,0.18)"
            }}>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#FFD27A", marginBottom: "6px" }}>
                    🔒 Plugin Votes — MAXXER++ only
                </div>
                <div style={{ fontSize: "12.5px", color: "#bcc3d3", lineHeight: 1.5 }}>
                    {tierGateMessage(VIP_GATE)}
                </div>
                <div style={{ fontSize: "11.5px", color: "#8a91a3", marginTop: "8px", lineHeight: 1.4 }}>
                    MAXXER++ subscribers vote on what features get built next. The top-voted candidate
                    ships in the next release. Visit <code>maxxtopia.com/discordmaxxer/vip</code> to upgrade.
                </div>
            </div>
        );
    }

    const handleVote = async (c: Candidate) => {
        if (voted.has(c.id) || pending) return;
        setPending(c.id);
        const r = await submitVote(c.id);
        setPending(null);

        if (!r.ok) {
            Toasts.show({
                message: r.error === "no-hwid"
                    ? "Couldn't read your HWID — restart Discordmaxxer and try again."
                    : `Vote failed: ${r.error}. Try again in a moment.`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                options: { duration: 4000 }
            });
            return;
        }

        const next = new Set(voted);
        next.add(c.id);
        setVoted(next);
        persistVoted(next);
        setCounts(prev => ({ ...prev, [c.id]: r.count }));

        Toasts.show({
            message: r.alreadyVoted
                ? `You've already voted on "${c.name.slice(0, 40)}…"`
                : `🗳️ Vote registered. Current tally: ${r.count}.`,
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS,
            options: { duration: 3500 }
        });
    };

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const sorted = [...CANDIDATES].sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0));

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{
                fontSize: "12.5px",
                color: "#bcc3d3",
                lineHeight: 1.5,
                padding: "10px 12px",
                borderRadius: "6px",
                background: "rgba(255,170,0,0.05)",
                border: "1px solid rgba(255,170,0,0.18)"
            }}>
                <strong style={{ color: "#FFD27A" }}>★ MAXXER++ — Plugin Votes</strong>
                <br />
                Vote on what ships next. One vote per feature per rig (HWID-bound). Top candidate ships in the next release.
                {!loading && (
                    <span style={{ display: "block", marginTop: "4px", fontSize: "11.5px", color: "#8a91a3" }}>
                        {total} total vote{total === 1 ? "" : "s"} · refreshes every 30s
                    </span>
                )}
            </div>

            {sorted.map(c => {
                const count = counts[c.id] ?? 0;
                const hasVoted = voted.has(c.id);
                const isPending = pending === c.id;
                return (
                    <button
                        key={c.id}
                        onClick={() => handleVote(c)}
                        disabled={hasVoted || !!pending}
                        style={{
                            textAlign: "left",
                            padding: "12px 14px",
                            borderRadius: "6px",
                            background: hasVoted ? "rgba(85,255,85,0.06)" : "rgba(255,255,255,0.04)",
                            border: hasVoted ? "1px solid rgba(85,255,85,0.30)" : "1px solid rgba(255,255,255,0.08)",
                            color: "#cbd0e0",
                            cursor: hasVoted ? "default" : (pending ? "wait" : "pointer"),
                            font: "inherit",
                            opacity: pending && !isPending ? 0.5 : 1,
                            transition: "all 0.12s ease"
                        }}
                        onMouseEnter={e => {
                            if (hasVoted || pending) return;
                            e.currentTarget.style.background = "rgba(255,170,0,0.08)";
                            e.currentTarget.style.borderColor = "rgba(255,170,0,0.30)";
                        }}
                        onMouseLeave={e => {
                            if (hasVoted) return;
                            e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                            e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "4px" }}>
                            <div style={{ fontSize: "13.5px", fontWeight: 600, color: "#ffe8b3", flex: 1 }}>
                                {c.name}
                            </div>
                            <div style={{
                                fontSize: "12.5px",
                                fontWeight: 700,
                                color: hasVoted ? "#55FF55" : "#FFD27A",
                                fontFamily: "ui-monospace, Consolas, monospace",
                                whiteSpace: "nowrap"
                            }}>
                                {count} vote{count === 1 ? "" : "s"}
                            </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#a0a6b4", lineHeight: 1.4 }}>
                            {c.blurb}
                        </div>
                        <div style={{ fontSize: "11px", color: hasVoted ? "#55FF55" : "#FFD27A", marginTop: "6px", letterSpacing: "0.04em" }}>
                            {isPending ? "Submitting…" : hasVoted ? "✓ Voted" : "Click to vote →"}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        description: "",
        component: VotesPanel
    }
});

export default definePlugin({
    name: "DMVotes",
    description:
        "MAXXER++ perk — vote on what ships next. Real-time HWID-bound voting backed by a Cloudflare Worker tally; one vote per rig per feature. The top-voted candidate ships in the next release.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {},
    stop() {}
});

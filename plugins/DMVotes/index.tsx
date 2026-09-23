/*
 * Discordmaxxer — DiscordmaxxerVotes plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * MAXXER++ tier perk — plugin votes. Surfaces a panel of concrete candidate
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
 * Top-voted candidate gets shipped in the next release. The shared candidate
 * list is hand-curated so every tally has a real label and an owner. Users
 * can still save their own local request and copy it into #vip-chat/support.
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
const REQUEST_TIMEOUT_MS = 8_000;

interface Candidate {
    id: string;        // stable slug, [a-z0-9-]+, used as KV key suffix
    name: string;
    blurb: string;
}

// Curated 2026-09-23 candidate list. These are deliberately tied to real
// profile/media/sync and voice pain points rather than filler features.
const CANDIDATES: Candidate[] = [
    {
        id: "profile-look-backup",
        name: "One-click profile look backup",
        blurb:
            "Export and restore your complete Discordmaxxer look — gradient, avatar, banner, theme, and presence — across PCs or after a reinstall."
    },
    {
        id: "banner-only-profile-copy",
        name: "Copy only a banner",
        blurb:
            "Move a banner between profiles without overwriting the avatar, gradient, or the rest of the current flair."
    },
    {
        id: "media-library-restore",
        name: "Profile media library and restore",
        blurb:
            "Keep GIFs and video sources organized with clear backup/restore guidance so local media is not lost after Windows is reinstalled."
    },
    {
        id: "profile-sync-status",
        name: "Profile sync and conflict status",
        blurb:
            "Show which PC and version last wrote shared flair, detect stale data, and offer refresh or restore instead of silently showing the wrong profile."
    },
    {
        id: "voice-screenshare-diagnostics",
        name: "Voice and screenshare self-test",
        blurb:
            "A guided check for capture, audio, echo, and recovery with clear sender/recipient results instead of unexplained toggles."
    },
    {
        id: "native-broadcast-guide",
        name: "Clear native Discord broadcast guide",
        blurb:
            "Explain the optional one-time vanilla Discord profile update, check what is actually supported, and show the exact limits before sending anything."
    }
];

const MAX_SUGGESTIONS = 10;
const MAX_SUGGESTION_LENGTH = 180;
const SUGGESTIONS_KEY = "dm-votes-suggestions";

const normalizeSuggestion = (value: string) => value.trim().replace(/\s+/g, " ").slice(0, MAX_SUGGESTION_LENGTH);

const suggestionsStore = makePersistentValue<string[]>(SUGGESTIONS_KEY, [], raw => {
    if (!Array.isArray(raw)) return null;
    return raw
        .filter((value): value is string => typeof value === "string")
        .map(normalizeSuggestion)
        .filter(Boolean)
        .slice(0, MAX_SUGGESTIONS);
});

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

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchTally(): Promise<Record<string, number>> {
    try {
        const res = await fetchWithTimeout(`${VOTES_API}/tally`, { method: "GET" });
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
        const res = await fetchWithTimeout(`${VOTES_API}/vote`, {
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

async function copySuggestion(value: string): Promise<boolean> {
    try {
        if (!navigator.clipboard?.writeText) return false;
        await navigator.clipboard.writeText(`Discordmaxxer feature request: ${value}`);
        return true;
    } catch {
        return false;
    }
}

function SuggestionBox() {
    const [draft, setDraft] = React.useState("");
    const [suggestions, setSuggestions] = React.useState<string[]>(() => suggestionsStore.get());
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        let alive = true;
        suggestionsStore.ready.then(() => {
            if (alive) setSuggestions(suggestionsStore.get());
        });
        return () => { alive = false; };
    }, []);

    const handleAdd = async () => {
        const value = normalizeSuggestion(draft);
        if (!value || saving) return;

        setSaving(true);
        await suggestionsStore.ready;
        const current = suggestionsStore.get();
        const next = [value, ...current.filter(item => item !== value)].slice(0, MAX_SUGGESTIONS);
        suggestionsStore.set(next);
        setSuggestions(next);
        setDraft("");
        setSaving(false);
        Toasts.show({
            message: "Saved on this PC. Copy it into #vip-chat or support when you want it reviewed.",
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS,
            options: { duration: 3500 }
        });
    };

    const handleCopy = async (value: string) => {
        const copied = await copySuggestion(value);
        Toasts.show({
            message: copied ? "Request copied — paste it into #vip-chat or support." : "Could not access the clipboard. Select and copy the request manually.",
            id: Toasts.genId(),
            type: copied ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE,
            options: { duration: 3500 }
        });
    };

    const handleRemove = async (value: string) => {
        await suggestionsStore.ready;
        const next = suggestionsStore.get().filter(item => item !== value);
        suggestionsStore.set(next);
        setSuggestions(next);
    };

    return (
        <div style={{
            marginTop: "2px",
            padding: "12px 14px",
            borderRadius: "6px",
            background: "rgba(120,150,255,0.06)",
            border: "1px solid rgba(120,150,255,0.20)"
        }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd8ff", marginBottom: "4px" }}>
                💡 Have your own request?
            </div>
            <div style={{ fontSize: "11.5px", color: "#9fa9c2", lineHeight: 1.45, marginBottom: "8px" }}>
                Save it locally on this PC, then copy it into <code>#vip-chat</code> or support. Custom requests are not silently sent as anonymous shared vote IDs.
            </div>
            <textarea
                value={draft}
                onChange={event => setDraft(event.currentTarget.value.slice(0, MAX_SUGGESTION_LENGTH))}
                onKeyDown={event => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                        event.preventDefault();
                        void handleAdd();
                    }
                }}
                placeholder="What should Discordmaxxer make easier?"
                maxLength={MAX_SUGGESTION_LENGTH}
                rows={2}
                style={{
                    width: "100%",
                    boxSizing: "border-box",
                    resize: "vertical",
                    minHeight: "52px",
                    padding: "8px 9px",
                    borderRadius: "5px",
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(0,0,0,0.20)",
                    color: "#e4e8f5",
                    font: "inherit",
                    fontSize: "12px"
                }}
                aria-label="Your Discordmaxxer feature request"
            />
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "7px" }}>
                <span style={{ flex: 1, fontSize: "10.5px", color: "#7f89a5" }}>
                    {draft.length}/{MAX_SUGGESTION_LENGTH} · Ctrl+Enter to save
                </span>
                <button
                    onClick={() => void handleAdd()}
                    disabled={!normalizeSuggestion(draft) || saving}
                    style={{
                        padding: "5px 10px",
                        borderRadius: "4px",
                        border: "1px solid rgba(120,150,255,0.35)",
                        background: "rgba(120,150,255,0.15)",
                        color: "#d6e0ff",
                        cursor: !normalizeSuggestion(draft) || saving ? "default" : "pointer",
                        opacity: !normalizeSuggestion(draft) || saving ? 0.5 : 1,
                        font: "inherit",
                        fontSize: "11px",
                        fontWeight: 600
                    }}
                >
                    {saving ? "Saving…" : "Save request"}
                </button>
            </div>

            {suggestions.length > 0 && (
                <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "5px" }}>
                    <div style={{ fontSize: "10.5px", color: "#7f89a5", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        Saved on this PC
                    </div>
                    {suggestions.map(value => (
                        <div key={value} style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                            <span style={{ flex: 1, minWidth: 0, fontSize: "11.5px", color: "#bcc3d3", overflowWrap: "anywhere" }}>
                                {value}
                            </span>
                            <button
                                onClick={() => void handleCopy(value)}
                                style={{ padding: "3px 7px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)", color: "#cbd0e0", cursor: "pointer", font: "inherit", fontSize: "10.5px", whiteSpace: "nowrap" }}
                            >
                                Copy
                            </button>
                            <button
                                onClick={() => void handleRemove(value)}
                                aria-label={`Remove request: ${value}`}
                                title="Remove request"
                                style={{ padding: "3px 6px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)", color: "#9fa9c2", cursor: "pointer", font: "inherit", fontSize: "10.5px" }}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function VotesPanel() {
    const allowed = hasTier(VIP_GATE);
    const [counts, setCounts] = React.useState<Record<string, number>>({});
    const [voted, setVoted] = React.useState<Set<string>>(() => getVotedSet());
    const [pending, setPending] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        if (!allowed) return;
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
    }, [allowed]);

    if (!allowed) {
        return (
            <>
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
                        ships in the next release. You can still write and copy a request below without upgrading.
                        Visit <code>maxxtopia.com/discordmaxxer/vip</code> to upgrade.
                    </div>
                </div>
                <SuggestionBox />
            </>
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

    // Ignore retired/stale worker keys from older polls. Otherwise replacing
    // a bad candidate list would make the visible total lie to the user.
    const total = CANDIDATES.reduce((sum, candidate) => sum + (counts[candidate.id] ?? 0), 0);
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
            <SuggestionBox />
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
        "MAXXER++ perk — vote on concrete roadmap candidates, or save and copy your own request. Shared votes are HWID-bound; custom requests stay local until you choose to share them.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    start() {},
    stop() {}
});

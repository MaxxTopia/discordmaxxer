/*
 * Discordmaxxer — VIP claim plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Settings panel that lets a user redeem a HWID-locked VIP code:
 *   1. Compute the rig's HWID via VesktopNative.hwid.get() (PowerShell
 *      -> WMI BIOS UUID + Serial + CPU Brand → SHA-256, first 16 bytes).
 *   2. POST { code, hwid } to the optmaxxing-vip Cloudflare Worker.
 *   3. On success, store binding in localStorage keyed dm-vip-claim.
 *   4. vip.ts reads that binding cache for getMyTier() resolution.
 *
 * On plugin start, if there's already a stored binding, re-validate it
 * against the worker (idempotent re-claim). If the worker rejects, the
 * binding is wiped and the user drops to FREE on next tier check.
 *
 * Codes minted via optimizationmaxxing/scripts/mint-unbound-codes.py.
 * Each successful claim grants the tier encoded by the claim; older codes
 * without a tier continue to default to Tier.MAXXER_PLUS_PLUS.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, Toasts, UserStore } from "@webpack/common";

import {
    bumpValidatedAt,
    ClaimBinding,
    claimAgainstWorker,
    getMyHwid,
    isValidCode,
    normalizeCode,
    readBinding,
    reValidateBinding,
    writeBinding,
    WORKER_URL
} from "../_dm-shared/vipClaim";
import { normalizeTier, Tier, TIER_LABELS } from "../_dm-shared/vip";

function currentUserId(): string | undefined {
    try {
        const me = UserStore?.getCurrentUser();
        return me?.id;
    } catch {
        return undefined;
    }
}

function toast(message: string, type: any = Toasts.Type.MESSAGE) {
    Toasts.show({ message, id: Toasts.genId(), type, options: { duration: 4000 } });
}

function formatHwid(hwid: string | null): string {
    if (!hwid) return "(loading…)";
    // Display as 8-4-4-4-8 for readability; the wire format is plain hex.
    return [hwid.slice(0, 8), hwid.slice(8, 12), hwid.slice(12, 16), hwid.slice(16, 20), hwid.slice(20)].join("-");
}

function formatCodeForDisplay(code: string): string {
    const norm = normalizeCode(code);
    const chunks: string[] = [];
    for (let i = 0; i < norm.length; i += 4) chunks.push(norm.slice(i, i + 4));
    return "MAXX-" + chunks.join("-");
}

function ClaimPanel() {
    const [hwid, setHwid] = React.useState<string | null>(null);
    const [hwidErr, setHwidErr] = React.useState<string | null>(null);
    const [binding, setBinding] = React.useState<ClaimBinding | null>(() => readBinding());
    const [code, setCode] = React.useState("");
    const [claiming, setClaiming] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        getMyHwid().then(h => {
            if (cancelled) return;
            if (!h) setHwidErr("Could not read BIOS info — VIP claim unavailable.");
            else setHwid(h);
        });
        return () => { cancelled = true; };
    }, []);

    const onClaim = async () => {
        if (!hwid) { toast("HWID not ready yet — try again in a sec.", Toasts.Type.FAILURE); return; }
        if (!isValidCode(code)) { toast("Invalid code shape. Should be 16 Crockford chars (or MAXX-XXXX-XXXX-XXXX-XXXX).", Toasts.Type.FAILURE); return; }
        setClaiming(true);
        try {
            const norm = normalizeCode(code);
            const r = await claimAgainstWorker(norm, hwid, currentUserId());
            if (r.ok) {
                const now = Date.now();
                // Legacy workers omitted tier; preserve their historical
                // MAXXER++ meaning. An explicit tier of 0/malformed data
                // stays FREE instead of being silently elevated.
                const grantedTier = r.tier === undefined
                    ? normalizeTier(undefined, r.founderNumber) || Tier.MAXXER_PLUS_PLUS
                    : normalizeTier(r.tier, r.founderNumber);
                const fresh: ClaimBinding = {
                    code: norm,
                    hwid,
                    tier: grantedTier,
                    claimedAt: now,
                    lastValidatedAt: now,
                    founderNumber: r.founderNumber,
                    ...(typeof r.expiresAt === "number" ? { expiresAt: r.expiresAt } : {}),
                    ...(typeof r.scope === "string" ? { scope: r.scope } : {})
                };
                writeBinding(fresh);
                setBinding(fresh);
                setCode("");
                const founderTag = r.founderNumber ? ` Founder #${r.founderNumber} of 33.` : "";
                toast(r.status === "claimed"
                    ? `🎉 ${TIER_LABELS[grantedTier]} unlocked.${founderTag} Restart Discordmaxxer to refresh badges.`
                    : `✅ Code already bound to this rig — ${TIER_LABELS[grantedTier]} active.${founderTag}`, Toasts.Type.SUCCESS);
            } else {
                if (r.boundHwid && r.boundHwid !== hwid) {
                    toast("That code is already claimed by another rig. One code, one machine.", Toasts.Type.FAILURE);
                } else {
                    toast(`Claim failed: ${r.error || "unknown error"}`, Toasts.Type.FAILURE);
                }
            }
        } finally {
            setClaiming(false);
        }
    };

    const onRevoke = () => {
        writeBinding(null);
        setBinding(null);
        toast("Local VIP binding cleared. The code stays bound to this rig on the server — re-enter to restore.", Toasts.Type.MESSAGE);
    };

    const wrap: React.CSSProperties = {
        display: "flex", flexDirection: "column", gap: "10px",
        padding: "14px 16px", marginTop: "10px",
        background: "linear-gradient(135deg, rgba(226,91,255,0.08), rgba(76,81,247,0.08))",
        border: "1px solid rgba(226,91,255,0.35)",
        borderRadius: "10px",
        color: "#eaeef9", fontSize: "13px", lineHeight: 1.5
    };

    const label: React.CSSProperties = { fontWeight: 700, color: "#fbefff", marginBottom: "2px" };
    const mono: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "12px", color: "#cbd0e0", userSelect: "all" };
    const input: React.CSSProperties = { padding: "9px 11px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.3)", color: "#fff", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "13px", width: "100%" };
    const btn: React.CSSProperties = { padding: "9px 16px", borderRadius: "6px", border: "none", color: "#0e1330", background: "linear-gradient(135deg,#ffaa00,#ff5555)", fontWeight: 700, cursor: "pointer", letterSpacing: "0.02em" };
    const btnSecondary: React.CSSProperties = { padding: "7px 12px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.12)", background: "transparent", color: "#cbd0e0", fontSize: "12px", cursor: "pointer" };

    return (
        <div style={wrap}>
            <div>
                <div style={label}>Your rig fingerprint (HWID)</div>
                <div style={mono}>{hwidErr ? hwidErr : formatHwid(hwid)}</div>
            </div>
            {binding ? (
                <div>
                    <div style={label}>Active claim</div>
                    <div style={mono}>{formatCodeForDisplay(binding.code)} → {TIER_LABELS[binding.tier]}</div>
                    <div style={{ ...mono, marginTop: 4, opacity: 0.7 }}>
                        Claimed {new Date(binding.claimedAt).toLocaleString()} ·
                        last checked {new Date(binding.lastValidatedAt).toLocaleString()}
                    </div>
                    <div style={{ marginTop: 10 }}>
                        <button style={btnSecondary} onClick={onRevoke}>Clear local binding</button>
                    </div>
                </div>
            ) : (
                <div>
                    <div style={label}>Redeem a VIP code</div>
                    <div style={{ marginBottom: 8, opacity: 0.85 }}>
                        Codes look like <code>MAXX-XXXX-XXXX-XXXX-XXXX</code>. Each one binds to ONE rig — the first machine to claim it wins, future attempts on other rigs are rejected.
                    </div>
                    <input
                        style={input}
                        type="text"
                        placeholder="MAXX-XXXX-XXXX-XXXX-XXXX"
                        value={code}
                        onChange={e => setCode(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") onClaim(); }}
                        spellCheck={false}
                        autoCapitalize="characters"
                        disabled={claiming || !hwid}
                    />
                    <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                        <button style={btn} onClick={onClaim} disabled={claiming || !hwid || !code.trim()}>
                            {claiming ? "Claiming…" : "Redeem"}
                        </button>
                        <span style={{ ...mono, opacity: 0.6 }}>
                            POSTs to {new URL(WORKER_URL).host}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}

const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        description: "VIP claim panel",
        component: ClaimPanel
    }
});

export default definePlugin({
    name: "DMVipClaim",
    description:
        "Redeem a HWID-locked VIP code to unlock the tier encoded by the claim (older codes default to MAXXER++). Each code binds to one rig (BIOS UUID + serial + CPU). " +
        "Same backend as optimizationmaxxing — codes work across both products on the same machine. " +
        "Validation is online; offline access trusts the cache for 24 hours.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        // Re-validate the stored binding against the worker on launch.
        // - true:    binding still alive, refresh lastValidatedAt
        // - false:   worker rejected (claim wiped or hwid mismatch), wipe local
        // - null:    network unreachable, leave alone (24h cache trust kicks in)
        //
        // Pass the current userId so pre-2026-05-10 claims (stored before
        // the userId field existed) get backfilled and start showing up in
        // the public /roster — which drives cross-user TierFlair badges.
        const b = readBinding();
        if (!b) return;
        try {
            const result = await reValidateBinding(b, currentUserId());
            if (result && typeof result === "object") writeBinding(bumpValidatedAt(result));
            else if (result === false) writeBinding(null);
            // null result: leave cached binding intact, vip.ts handles the
            // 24-hour offline trust window.
        } catch (e) {
            console.warn("[DiscordmaxxerVipClaim] revalidation failed:", e);
        }
    }
});

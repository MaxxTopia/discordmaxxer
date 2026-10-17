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
 * On plugin start, if there's already a stored binding, validate it against
 * the worker's read-only route. If the worker rejects, the binding is wiped
 * and the user drops to FREE on next tier check.
 *
 * Codes minted via optimizationmaxxing/scripts/mint-unbound-codes.py.
 * The worker is authoritative for the tier and duration. Legacy worker
 * responses without tier metadata still fall back to MAXXER++ below.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React, Toasts, UserStore } from "@webpack/common";

import {
    bumpValidatedAt,
    ClaimBinding,
    activateFreeProfile,
    claimAgainstWorker,
    getMyHwid,
    isValidCode,
    normalizeCode,
    readBinding,
    reValidateBinding,
    writeBinding,
    WORKER_URL
} from "../_dm-shared/vipClaim";
import { Tier, TIER_LABELS } from "../_dm-shared/vip";

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

function tierFromWorkerResult(tier: number | undefined): Tier {
    const numeric = Number(tier);
    return Number.isInteger(numeric) && numeric >= Tier.FREE && numeric <= Tier.MAXXER_PLUS_PLUS
        ? numeric as Tier
        : Tier.MAXXER_PLUS_PLUS;
}

function ClaimPanel() {
    const [hwid, setHwid] = React.useState<string | null>(null);
    const [hwidErr, setHwidErr] = React.useState<string | null>(null);
    const [binding, setBinding] = React.useState<ClaimBinding | null>(() => readBinding());
    const [code, setCode] = React.useState("");
    const [claiming, setClaiming] = React.useState(false);
    const [activatingFree, setActivatingFree] = React.useState(false);

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
                const grantedTier = tierFromWorkerResult(r.tier);
                const grantedLabel = TIER_LABELS[grantedTier];
                const durationLabel = r.expiresAt == null
                    ? "Lifetime access."
                    : `Access until ${new Date(r.expiresAt).toLocaleDateString()}.`;
                const fresh: ClaimBinding = {
                    code: norm,
                    hwid,
                    tier: grantedTier,
                    claimedAt: now,
                    lastValidatedAt: now,
                    founderNumber: r.founderNumber,
                    ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
                    ...(r.scope ? { scope: r.scope } : {}),
                    lastClientClockAt: now,
                };
                writeBinding(fresh);
                setBinding(fresh);
                setCode("");
                const founderTag = r.founderNumber ? ` Founder #${r.founderNumber} of 33.` : "";
                toast(r.status === "claimed"
                    ? `🎉 ${grantedLabel} unlocked. ${durationLabel}${founderTag} Restart Discordmaxxer to refresh badges.`
                    : `✅ Code already bound to this rig — ${grantedLabel} active. ${durationLabel}${founderTag}`, Toasts.Type.SUCCESS);
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

    const onActivateFree = async () => {
        if (!hwid) { toast("HWID not ready yet — try again in a sec.", Toasts.Type.FAILURE); return; }
        setActivatingFree(true);
        try {
            const result = await activateFreeProfile(hwid);
            if (result.ok && result.binding) {
                setBinding(result.binding);
                toast("Free profile flair is active. Your banner, animated avatar, and colors can now sync across Discordmaxxer PCs.", Toasts.Type.SUCCESS);
            } else {
                toast(result.error || "Free activation did not complete.", Toasts.Type.FAILURE);
            }
        } finally {
            setActivatingFree(false);
        }
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
    const freeBtn: React.CSSProperties = { padding: "9px 16px", borderRadius: "6px", border: "1px solid rgba(96, 220, 255, 0.65)", color: "#dffaff", background: "linear-gradient(135deg, rgba(57, 182, 255, 0.32), rgba(136, 92, 255, 0.35))", fontWeight: 700, cursor: "pointer", letterSpacing: "0.02em" };
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
                        last checked {new Date(binding.lastValidatedAt).toLocaleString()} ·
                        {binding.expiresAt ? ` expires ${new Date(binding.expiresAt).toLocaleDateString()}` : " lifetime access"}
                    </div>
                    <div style={{ marginTop: 10 }}>
                        <button style={btnSecondary} onClick={onRevoke}>Clear local binding</button>
                    </div>
                </div>
            ) : (
                <div>
                    <div style={{ marginBottom: 14, padding: "12px", borderRadius: "8px", border: "1px solid rgba(96, 220, 255, 0.35)", background: "linear-gradient(135deg, rgba(57, 182, 255, 0.08), rgba(136, 92, 255, 0.10))" }}>
                        <div style={label}>Activate free profile flair</div>
                        <div style={{ marginBottom: 9, opacity: 0.85 }}>
                            No payment and no VIP code. Click once, authorize the Discord account in your browser, then return here. This activates one free Tier 0 binding for this PC so your banner, animated avatar, and profile colors can sync to other Discordmaxxer users.
                        </div>
                        <button style={freeBtn} onClick={onActivateFree} disabled={activatingFree || !hwid}>
                            {activatingFree ? "Waiting for Discord…" : "Activate free profile"}
                        </button>
                    </div>
                    <div style={label}>Redeem a VIP code</div>
                    <div style={{ marginBottom: 8, opacity: 0.85 }}>
                        Paid codes still unlock higher tiers. They look like <code>MAXX-XXXX-XXXX-XXXX-XXXX</code> and bind to ONE rig — the first machine to claim one wins.
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
        "Activate free profile flair with Discord, or redeem a HWID-locked VIP code; the worker chooses the tier and duration, including lifetime Founder claims. Each binding uses one rig (BIOS UUID + serial + CPU). " +
        "Same backend as optimizationmaxxing — codes work across both products on the same machine. " +
        "Validation is online; offline access trusts the cache for 24 hours.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    async start() {
        // Re-validate the stored binding against the worker on launch.
        // - ok:      binding still alive, refresh timestamps + expiry metadata
        // - !ok:     worker rejected (revoked, expired, wrong HWID, etc.), wipe local
        // - null:    network unreachable, leave alone (24h cache trust kicks in)
        const b = readBinding();
        if (!b) return;
        try {
            const result = await reValidateBinding(b);
            if (result?.ok) writeBinding(bumpValidatedAt(b, result));
            else if (result === null) {
                // Leave cached binding intact; vip.ts handles the 24h fade.
            } else writeBinding(null);
        } catch (e) {
            console.warn("[DiscordmaxxerVipClaim] revalidation failed:", e);
        }
    }
});

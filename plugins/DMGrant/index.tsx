/*
 * Discordmaxxer — local tier grants
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Right-click any user → "Grant Discordmaxxer Tier" submenu. Stores grants
 * in plugin settings as a JSON map of userId -> Tier. Read by vip.ts via
 * Vencord.PlainSettings (avoids circular import).
 *
 * Scope (v0.1): LOCAL ONLY. A grant changes how badges + tier-locked
 * features render in YOUR client only. The friend's own Discordmaxxer
 * install does not see the grant. Remote roster sync (publish to a JSON
 * roster fetched by all clients on startup) is the v0.2 follow-up.
 */

import { definePluginSettings } from "@api/Settings";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, Toasts } from "@webpack/common";

import { getUserTier, isAdmin, Tier, TIER_LABELS } from "../_dm-shared/vip";

const settings = definePluginSettings({
    grants: {
        type: OptionType.STRING,
        description:
            "Admin/support only — a local JSON map of userId to tier number. It changes how tiers render in your client; it does not give another user a subscription or change their account.",
        default: "{}"
    }
});

function readGrants(): Record<string, Tier> {
    try {
        return JSON.parse(settings.store.grants || "{}") as Record<string, Tier>;
    } catch {
        return {};
    }
}

function writeGrants(g: Record<string, Tier>) {
    settings.store.grants = JSON.stringify(g);
}

function toast(message: string, type: number = Toasts.Type.MESSAGE) {
    Toasts.show({ message, id: Toasts.genId(), type });
}

function setGrant(userId: string, displayName: string, tier: Tier | null) {
    const g = readGrants();
    if (tier === null) {
        if (!(userId in g)) {
            toast(`${displayName} is already FREE`);
            return;
        }
        delete g[userId];
        writeGrants(g);
        toast(`Revoked Discordmaxxer tier from ${displayName}`, Toasts.Type.SUCCESS);
    } else {
        g[userId] = tier;
        writeGrants(g);
        toast(`Granted ${TIER_LABELS[tier]} to ${displayName}`, Toasts.Type.SUCCESS);
    }
}

const TIERS_GRANTABLE: Tier[] = [Tier.MAXXER, Tier.MAXXER_PLUS, Tier.MAXXER_PLUS_PLUS];

const userContextPatch: NavContextMenuPatchCallback = (children, props: any) => {
    // Admin-only — Grant menu does not appear for non-admin users. Even if
    // a determined user edits settings.json to add grants, the renderer
    // ignores them because vip.ts::getUserTier gates local-grant honoring
    // on isAdmin() too.
    if (!isAdmin()) return;
    const targetUser = props?.user;
    if (!targetUser?.id) return;

    const currentTier = getUserTier(targetUser.id);
    const displayName: string = targetUser.globalName || targetUser.username || targetUser.id;

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="dm-grant-tier" label="Grant Discordmaxxer Tier">
            {TIERS_GRANTABLE.map(t => (
                <Menu.MenuItem
                    key={`dm-grant-${t}`}
                    id={`dm-grant-${t}`}
                    label={`${TIER_LABELS[t]}${currentTier === t ? "  ✓" : ""}`}
                    action={() => setGrant(targetUser.id, displayName, t)}
                />
            ))}
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="dm-grant-revoke"
                label="Revoke (back to FREE)"
                color="danger"
                disabled={currentTier === Tier.FREE}
                action={() => setGrant(targetUser.id, displayName, null)}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "DMGrant",
    description:
        "Admin/support utility: right-click a user to preview a Discordmaxxer tier locally. It is not a customer feature, does not grant payment access, and does not change the other user's install.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,

    contextMenus: {
        "user-context": userContextPatch
    }
});

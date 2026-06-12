/*
 * Discordmaxxer — MassDelete plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Bulk-delete your own messages in a channel/DM. Opt-in, rate-limited.
 * Disabled by default; user must explicitly enable in plugin settings, and
 * confirm in a warning dialog at every invocation.
 *
 * Discord's Community Guidelines forbid self-bots. The 1-message-per-second
 * pace + 100-message cap stays well below the rates that get accounts flagged
 * (Undiscord users have been suspended at higher rates). Use sparingly.
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { Alerts, Constants, Menu, RestAPI, Toasts, UserStore } from "@webpack/common";

const HARD_CAP = 100;
const RATE_LIMIT_MS = 1000;

const settings = definePluginSettings({
    enableContextMenu: {
        type: OptionType.BOOLEAN,
        description:
            "Show 'Mass-delete my messages' in channel/DM right-click menus. " +
            "DISABLED by default — Discord's TOS forbids self-bots and aggressive use can get accounts suspended. " +
            "When on, every invocation still shows a confirmation dialog with rate-limit info.",
        default: false
    },
    defaultCount: {
        type: OptionType.NUMBER,
        description: "Default count shown in the prompt (1-100)",
        default: 25
    }
});

interface DiscordMessage {
    id: string;
    author: { id: string };
    content: string;
}

async function fetchMyRecentMessages(channelId: string, count: number): Promise<DiscordMessage[]> {
    const me = UserStore.getCurrentUser();
    const collected: DiscordMessage[] = [];
    let before: string | undefined;
    // Up to 5 pages of 100 = 500 messages scanned for up to N belonging to me.
    for (let page = 0; page < 5 && collected.length < count; page++) {
        const params = new URLSearchParams({ limit: "100" });
        if (before) params.set("before", before);
        const res: any = await RestAPI.get({
            url: `${Constants.Endpoints.MESSAGES(channelId)}?${params.toString()}`
        });
        const messages: DiscordMessage[] = res.body ?? [];
        if (!messages.length) break;
        for (const m of messages) {
            if (m.author?.id === me.id) {
                collected.push(m);
                if (collected.length >= count) break;
            }
        }
        before = messages[messages.length - 1]?.id;
    }
    return collected.slice(0, count);
}

async function deleteOne(channelId: string, messageId: string): Promise<boolean> {
    // On HTTP 429 (rate limit) Discord returns a `retry_after`. The whole
    // ban-risk premise of this plugin is "stay under the limit" — so when we
    // DO hit it, we must back off for retry_after and retry the SAME message,
    // not drop it and immediately fire the next request. Hammering a throttled
    // route is precisely the pattern that flags accounts.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, messageId) });
            return true;
        } catch (e: any) {
            const status = e?.status ?? e?.response?.status;
            if (status === 429) {
                const retrySec = Number(
                    e?.body?.retry_after ?? e?.response?.body?.retry_after ?? 1
                );
                const waitMs = Math.min(Math.max(retrySec * 1000, 1000), 60_000) + 250;
                console.warn(`[MassDelete] 429 on ${messageId}; backing off ${waitMs}ms then retrying`);
                await sleep(waitMs);
                continue; // retry the same message
            }
            // 404 (already deleted) / 403 / anything else — not retryable.
            console.warn(`[MassDelete] Failed to delete ${messageId}:`, e);
            return false;
        }
    }
    console.warn(`[MassDelete] Gave up on ${messageId} after repeated 429s`);
    return false;
}

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function massDeleteFlow(channel: Channel, requestedCount: number) {
    const count = Math.min(Math.max(1, Math.floor(requestedCount)), HARD_CAP);
    console.log(`[MassDelete] Starting flow: channel=${channel.id} requestedCount=${count}`);

    Toasts.show({
        message: `🔍 Scanning last 500 messages for up to ${count} of yours...`,
        type: Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: { duration: 2500, position: Toasts.Position.TOP }
    });

    const targets = await fetchMyRecentMessages(channel.id, count);
    if (!targets.length) {
        Toasts.show({
            message: "No recent messages of yours found in this channel.",
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
            options: { duration: 3000, position: Toasts.Position.TOP }
        });
        return;
    }

    let deleted = 0;
    let failed = 0;
    for (const msg of targets) {
        const ok = await deleteOne(channel.id, msg.id);
        if (ok) deleted++;
        else failed++;
        await sleep(RATE_LIMIT_MS);
    }

    console.log(`[MassDelete] channel=${channel.id} deleted=${deleted} failed=${failed} requested=${count}`);

    Toasts.show({
        message: failed
            ? `Deleted ${deleted}, ${failed} failed (rate-limit or already gone). Check console.`
            : `✅ Deleted ${deleted} messages.`,
        type: failed ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS,
        id: Toasts.genId(),
        options: { duration: 4000, position: Toasts.Position.TOP }
    });
}

function promptAndDelete(channel: Channel) {
    // window.prompt is unreliable inside Electron-loaded Discord renderers (often
    // returns null silently). Use the configurable defaultCount + Alerts.show as
    // the single confirmation. Users can change defaultCount in plugin settings.
    const n = Math.min(HARD_CAP, Math.max(1, Math.floor(Number(settings.store.defaultCount) || 25)));
    const channelName = (channel as any).name ?? "this channel";

    Alerts.show({
        title: "⚠️ Mass-delete confirmation",
        body:
            `About to delete up to ${n} of your most-recent messages from #${channelName}.\n\n` +
            `Pace: 1 msg/sec. Hard cap: ${HARD_CAP}.\n\n` +
            `Discord considers self-botting a TOS violation; aggressive use can suspend accounts. ` +
            `Change the count in MassDelete plugin settings → "Default count".\n\n` +
            `Continue?`,
        confirmText: `Delete ${n}`,
        confirmColor: "red" as any,
        cancelText: "Cancel",
        onConfirm: () => massDeleteFlow(channel, n)
    });
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel: Channel }) => {
    if (!settings.store.enableContextMenu) return;
    if (!channel) return;
    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="dm-mass-delete"
            label="Mass-delete my messages..."
            color="danger"
            action={() => promptAndDelete(channel)}
        />
    );
};

// Right-click on a specific message — most users intuitively expect this UX.
// Resolves the channel from the message's channel_id and runs the same flow.
const messageContextPatch: NavContextMenuPatchCallback = (children, { message }: { message: any }) => {
    if (!settings.store.enableContextMenu) return;
    if (!message?.channel_id) return;
    // Synthesize a minimal channel-shaped object from the message's channel_id
    const channel = { id: message.channel_id, name: "this channel" } as unknown as Channel;
    // Insert above the existing "Delete Message" item, near other dangerous ops.
    const deleteGroup = findGroupChildrenByChildId("delete", children) ?? children;
    deleteGroup.push(
        <Menu.MenuItem
            id="dm-mass-delete-from-message"
            label="Mass-delete my messages in this channel..."
            color="danger"
            action={() => promptAndDelete(channel)}
        />
    );
};

export default definePlugin({
    name: "MassDelete",
    description:
        "OPT-IN. Right-click a channel/DM → 'Mass-delete my messages...' deletes up to 100 of your recent messages " +
        "at 1 msg/sec, with confirmation. Discord considers self-botting a TOS violation; " +
        "aggressive use can suspend accounts. Default: disabled.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,
    contextMenus: {
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch,
        "user-context": channelContextPatch,
        "gdm-context": channelContextPatch,
        "message": messageContextPatch
    }
});

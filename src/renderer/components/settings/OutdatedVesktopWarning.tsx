/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Card, HeadingTertiary, Paragraph } from "@vencord/types/components";
import { useAwaiter } from "@vencord/types/utils";
import { useState } from "@vencord/types/webpack/common";
import type { UpdaterCheckResult } from "shared/IpcEvents";

import { cl } from "./Settings";

/**
 * Updater surface.
 *
 * This used to be `if (!isOutdated) return null` — the card, and its only
 * button, existed ONLY when the app already knew an update was waiting. And
 * `isOutdated` is the result of the single check that runs at startup, captured
 * once as a promise and never re-evaluated. So if that check failed, or simply
 * ran before a release existed, there was no button, no error, and no way to
 * retry short of relaunching. A shipped update could sit there invisible.
 *
 * Now: always render a "Check for updates" button, and show what actually
 * happened — update found / up to date / the error text.
 */
export function OutdatedVesktopWarning() {
    const [isOutdated] = useAwaiter(VesktopNative.app.isOutdated);
    const [result, setResult] = useState<UpdaterCheckResult | null>(null);
    const [checking, setChecking] = useState(false);

    async function check() {
        setChecking(true);
        try {
            setResult(await VesktopNative.app.checkForUpdates());
        } catch (e: any) {
            setResult({ status: "error", error: String(e?.message ?? e) });
        } finally {
            setChecking(false);
        }
    }

    const outdated = isOutdated || result?.status === "available";

    return (
        <Card variant={outdated ? "warning" : "normal"} className={cl("updater-card")}>
            <HeadingTertiary>{outdated ? "Your Discordmaxxer is outdated!" : "Updates"}</HeadingTertiary>

            <Paragraph>
                {outdated
                    ? "Staying up to date is important for security and stability."
                    : "Discordmaxxer checks for updates on startup and every 6 hours. You can also check right now."}
            </Paragraph>

            {result?.status === "none" && (
                <Paragraph>You're up to date{result.version ? ` (v${result.version})` : ""}.</Paragraph>
            )}
            {result?.status === "error" && (
                // Never swallow this again: if the check can't reach GitHub, say so.
                <Paragraph>Update check failed: {result.error}</Paragraph>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button onClick={check} disabled={checking} variant="secondary">
                    {checking ? "Checking..." : "Check for updates"}
                </Button>
                {outdated && (
                    <Button onClick={() => VesktopNative.app.openUpdater()} variant="secondary">
                        Open Updater
                    </Button>
                )}
            </div>
        </Card>
    );
}

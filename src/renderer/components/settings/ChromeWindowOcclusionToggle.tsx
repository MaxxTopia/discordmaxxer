/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@vencord/types/webpack/common";
import type { ChromeWindowOcclusionStatus } from "shared/IpcEvents";

import { SettingsComponent } from "./Settings";
import { VesktopSettingsSwitch } from "./VesktopSettingsSwitch";

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export const ChromeWindowOcclusionToggle: SettingsComponent = () => {
    const [status, setStatus] = useState<ChromeWindowOcclusionStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;

        VesktopNative.chromeWindowOcclusion
            .getStatus()
            .then(nextStatus => {
                if (!cancelled) setStatus(nextStatus);
            })
            .catch(reason => {
                if (!cancelled) setError(errorMessage(reason));
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const onChange = async (enabled: boolean) => {
        if (busy || !status?.canChange) return;

        setBusy(true);
        setError(null);
        try {
            setStatus(await VesktopNative.chromeWindowOcclusion.setEnabled(enabled));
        } catch (reason) {
            setError(errorMessage(reason));
        } finally {
            setBusy(false);
        }
    };

    return (
        <VesktopSettingsSwitch
            title="Keep Chrome rendering while covered"
            description={error ?? status?.message ?? "Checking Chrome's Windows policy..."}
            value={status?.enabled ?? false}
            onChange={onChange}
            disabled={busy || !status?.canChange}
        />
    );
};

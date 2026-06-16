/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText, Button, Heading, Paragraph, TextButton } from "@vencord/types/components";
import {
    Margins,
    ModalCloseButton,
    ModalContent,
    ModalHeader,
    ModalRoot,
    ModalSize,
    openModal,
    useForceUpdater
} from "@vencord/types/utils";
import { Toasts } from "@vencord/types/webpack/common";
import { Settings as SettingsStore, State } from "renderer/settings";
import { Settings } from "shared/settings";

import { cl, SettingsComponent } from "./Settings";

export const DeveloperOptionsButton: SettingsComponent = ({ settings }) => {
    return <Button onClick={() => openDeveloperOptionsModal(settings)}>Open Developer Settings</Button>;
};

function openDeveloperOptionsModal(settings: Settings) {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <BaseText size="lg" weight="semibold" tag="h3" style={{ flexGrow: 1 }}>
                    Discordmaxxer Developer Options
                </BaseText>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "1em 0" }}>
                    <Heading tag="h5">Vencord Location</Heading>
                    <VencordLocationPicker settings={settings} />

                    <Heading tag="h5" className={Margins.top16}>
                        Debugging
                    </Heading>
                    <div className={cl("button-grid")}>
                        <Button onClick={() => VesktopNative.debug.launchGpu()}>Open chrome://gpu</Button>
                        <Button onClick={() => VesktopNative.debug.launchWebrtcInternals()}>
                            Open chrome://webrtc-internals
                        </Button>
                    </div>

                    <StreamHealthSection />
                </div>
            </ModalContent>
        </ModalRoot>
    ));
}

// Self-serve diagnostics for the recurring screenshare/voice complaints
// (echo, lag/choppiness, the grey-screen-on-Go-Live audio crash). Reads only
// settings/state — no WebRTC patching — and points at chrome://webrtc-internals
// for the live encoder stat. Reachable via Settings → Discordmaxxer → Open
// Developer Settings.
function StreamHealthSection() {
    const s = SettingsStore.store as any;
    const q = (State.store as any).screenshareQuality;
    const report = [
        "Discordmaxxer — stream & voice health",
        `Hardware acceleration:        ${s.hardwareAcceleration !== false ? "ON" : "OFF"}`,
        `Hardware video acceleration:  ${s.hardwareVideoAcceleration ? "ON" : "OFF"}`,
        `Stream quality:               ${q?.resolution ?? 720}p${q?.frameRate ?? 30}`,
        `Stream audio mode:            ${s.screensharePerWindowAudio ? "Per-window (anti-echo)" : "System loopback (whole desktop)"}`,
        `Force WGC (cursor in games):  ${s.screenshareForceWgc ? "ON" : "OFF"}`
    ].join("\n");

    return (
        <>
            <Heading tag="h5" className={Margins.top16}>Stream &amp; Voice Health</Heading>
            <div style={{ background: "var(--background-secondary)", borderRadius: 6, padding: "8px 10px", margin: "6px 0" }}>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--font-code, monospace)", fontSize: 12 }}>{report}</pre>
            </div>
            <Paragraph>
                <b>Viewers hear themselves (echo):</b> your audio mode is system-loopback, which captures their voice playing back through your output. Fix: share <b>video-only</b> (uncheck “Stream With Audio”). Per-window audio avoids it but crashes on some setups.
            </Paragraph>
            <Paragraph>
                <b>Choppy / laggy to viewers:</b> open chrome://webrtc-internals (above) <i>while sharing</i> → find the outbound video stream → read <b>qualityLimitationReason</b>: <code>cpu</code> = encoder-bound (lower resolution/fps), <code>bandwidth</code> = network, <code>none</code> = fine. Try 720p30 first.
            </Paragraph>
            <Paragraph>
                <b>Grey screen / stuck on Go Live:</b> that’s per-window audio crashing — keep “Per-window stream audio” OFF.
            </Paragraph>
            <div className={cl("button-grid")}>
                <Button
                    onClick={() => {
                        try {
                            navigator.clipboard.writeText(report);
                        } catch {
                            /* ignore */
                        }
                        Toasts.show({ message: "Stream health copied", type: Toasts.Type.SUCCESS, id: Toasts.genId() });
                    }}
                >
                    Copy health report
                </Button>
                <Button
                    onClick={() => {
                        try {
                            navigator.clipboard.writeText(report);
                        } catch {
                            /* ignore */
                        }
                        try {
                            window.open("https://discord.gg/S78eecbWdx", "_blank");
                        } catch {
                            /* ignore */
                        }
                        Toasts.show({
                            message: "Report copied — paste it in the Maxxtopia Discord to send it.",
                            type: Toasts.Type.SUCCESS,
                            id: Toasts.genId()
                        });
                    }}
                >
                    Report on Discord
                </Button>
            </div>
        </>
    );
}

const VencordLocationPicker: SettingsComponent = ({ settings }) => {
    const forceUpdate = useForceUpdater();
    const usingCustomVencordDir = VesktopNative.fileManager.isUsingCustomVencordDir();

    return (
        <>
            <Paragraph>
                Vencord files are loaded from{" "}
                {usingCustomVencordDir ? (
                    <TextButton
                        variant="link"
                        onClick={e => {
                            e.preventDefault();
                            VesktopNative.fileManager.showCustomVencordDir();
                        }}
                    >
                        a custom location
                    </TextButton>
                ) : (
                    "the default location"
                )}
            </Paragraph>
            <div className={cl("button-grid")}>
                <Button
                    onClick={async () => {
                        const choice = await VesktopNative.fileManager.selectVencordDir();
                        switch (choice) {
                            case "cancelled":
                                break;
                            case "ok":
                                Toasts.show({
                                    message: "Plugin engine location changed. Fully restart Discordmaxxer to apply.",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.SUCCESS
                                });
                                break;
                            case "invalid":
                                Toasts.show({
                                    message:
                                        "You did not choose a valid Vencord install. Make sure you're selecting the dist dir!",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.FAILURE
                                });
                                break;
                        }
                        forceUpdate();
                    }}
                >
                    Change
                </Button>
                <Button
                    variant="dangerPrimary"
                    onClick={async () => {
                        await VesktopNative.fileManager.selectVencordDir(null);
                        forceUpdate();
                    }}
                >
                    Reset
                </Button>
            </div>
        </>
    );
};

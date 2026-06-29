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
import { React, Toasts } from "@vencord/types/webpack/common";
import { getOutboundVideoStats, OutboundVideoStat } from "renderer/patches/rtcStats";
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
// (echo, lag/choppiness). The "Live encoder" block is the important part: it
// polls the real sender-side WebRTC stats (encoder implementation + quality
// limitation reason + fps) WHILE you're sharing, so the long-unanswerable
// "is my stream actually smooth, and why not?" finally has a one-glance answer.
// Reachable via Settings → Discordmaxxer → Open Developer Settings.
function StreamHealthSection() {
    const s = SettingsStore.store as any;
    const q = (State.store as any).screenshareQuality;

    const [live, setLive] = React.useState<OutboundVideoStat | null>(null);
    React.useEffect(() => {
        let alive = true;
        const tick = () => getOutboundVideoStats().then(r => alive && setLive(r));
        tick();
        const iv = setInterval(tick, 1000);
        return () => {
            alive = false;
            clearInterval(iv);
        };
    }, []);

    const liveLines = live
        ? [
              `Encoder:                      ${live.encoderImplementation} [${live.encoderKind.toUpperCase()}]`,
              `Quality limitation:           ${live.qualityLimitationReason}`,
              `Sending:                      ${live.frameWidth}x${live.frameHeight} @ ${live.framesPerSecond}fps  ${live.kbps}kbps`,
              `Frames dropped at encoder:    ${live.dropPct}%`
          ].join("\n")
        : "Live encoder:                 (start a screenshare to read it)";

    // Auto-captured ~6s into the most recent Go Live (patches/streamHealthAuto.ts),
    // persisted to settings.json so it's here even after the stream ends.
    const last = (s.lastStreamHealth ?? null) as
        | null
        | {
              ts: number;
              encoderImplementation: string;
              encoderKind: string;
              qualityLimitationReason: string;
              framesPerSecond: number;
              frameWidth: number;
              frameHeight: number;
              echoFix: string;
              verdict: string;
          };
    const lastLines = last
        ? [
              `Last stream (${new Date(last.ts).toLocaleString()}):`,
              `  encoder:   ${last.encoderImplementation} [${String(last.encoderKind).toUpperCase()}]`,
              `  limited:   ${last.qualityLimitationReason}   sending ${last.frameWidth}x${last.frameHeight}@${last.framesPerSecond}`,
              `  echo fix:  ${last.echoFix}`,
              `  verdict:   ${last.verdict}`
          ].join("\n")
        : "Last stream:                  (none captured yet — go live once)";

    const report = [
        "Discordmaxxer — stream & voice health",
        `Hardware acceleration:        ${s.hardwareAcceleration !== false ? "ON" : "OFF"}`,
        `Hardware video acceleration:  ${s.hardwareVideoAcceleration ? "ON" : "OFF"}`,
        `Stream quality:               ${q?.resolution ?? 720}p${q?.frameRate ?? 30}`,
        `Force WGC (cursor in games):  ${s.screenshareForceWgc ? "ON" : "OFF"}`,
        liveLines,
        lastLines
    ].join("\n");

    // Verdict line driven by the live encoder read.
    let verdict: React.ReactNode = null;
    if (live) {
        if (live.encoderKind === "software") {
            verdict = (
                <Paragraph>
                    <b style={{ color: "var(--text-danger)" }}>⚠ Software encoder in use ({live.encoderImplementation}).</b>{" "}
                    This is the usual cause of "smooth for me, choppy for viewers" on fast motion — the CPU can't encode
                    60fps of game motion in real time, so frames are dropped. Fix below (re-enable hardware encode).
                </Paragraph>
            );
        } else if (live.qualityLimitationReason === "cpu") {
            verdict = (
                <Paragraph>
                    <b style={{ color: "var(--text-warning)" }}>Encoder is CPU-limited.</b> The GPU encoder is engaged but
                    still can't keep up — drop to 720p30, close background CPU load, or check the optimizer tweaks below.
                </Paragraph>
            );
        } else if (live.qualityLimitationReason === "bandwidth") {
            verdict = (
                <Paragraph>
                    <b>Bandwidth-limited.</b> The network (not your PC) is the bottleneck — lower resolution/fps or check
                    upload.
                </Paragraph>
            );
        } else {
            verdict = (
                <Paragraph>
                    <b style={{ color: "var(--text-positive)" }}>✓ Hardware encoder, no limitation.</b> The sender side is
                    healthy — any choppiness a viewer sees is on their end or the network.
                </Paragraph>
            );
        }
    }

    return (
        <>
            <Heading tag="h5" className={Margins.top16}>Stream &amp; Voice Health</Heading>
            <div style={{ background: "var(--background-secondary)", borderRadius: 6, padding: "8px 10px", margin: "6px 0" }}>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--font-code, monospace)", fontSize: 12 }}>{report}</pre>
            </div>
            {verdict}
            <Paragraph>
                <b>Viewers hear themselves (echo):</b> fixed in this build — stream audio is now captured as your
                game/desktop audio <i>minus</i> Discordmaxxer's own playback (winaudio exclude-self), so a viewer's voice
                can't loop back. If you ever still hear echo, share <b>video-only</b> as a fallback and report it.
            </Paragraph>
            <Paragraph>
                <b>Choppy / laggy to viewers — the fix order (for your RTX 2070, NVENC should engage):</b>
            </Paragraph>
            <Paragraph>
                1. Read the <b>Encoder</b> line above while sharing. <code>SOFTWARE</code> or limitation <code>cpu</code>
                = the problem is encode, not your settings (that's why no slider changed it). 2. Re-enable{" "}
                <b>Hardware-Accelerated GPU Scheduling</b> (your optimizer turned it OFF) — Settings → Display → Graphics,
                then restart. 3. Make sure the NVIDIA driver is a stable build (avoid the 577.00 branch). 4. In your
                optimizer, restore <b>NetworkThrottlingIndex</b> to default (it's set to an aggressive 1) and re-check. 5.
                Re-read the Encoder line: success = a hardware encoder string and limitation <code>none</code>.
            </Paragraph>
            <div className={cl("button-grid")}>
                <Button
                    onClick={() => {
                        // writeText returns a Promise — a sync try/catch can't
                        // catch its rejection (unhandled rejection + a false
                        // "copied" toast). Gate the toast on the result.
                        navigator.clipboard.writeText(report).then(
                            () => Toasts.show({ message: "Stream health copied", type: Toasts.Type.SUCCESS, id: Toasts.genId() }),
                            () => Toasts.show({ message: "Copy failed — clipboard blocked", type: Toasts.Type.FAILURE, id: Toasts.genId() })
                        );
                    }}
                >
                    Copy health report
                </Button>
                <Button
                    onClick={() => {
                        // Catch the async rejection so it can't surface as an
                        // unhandled rejection; toast reflects the real outcome.
                        navigator.clipboard.writeText(report).then(
                            () => Toasts.show({
                                message: "Report copied — paste it in the Maxxtopia Discord to send it.",
                                type: Toasts.Type.SUCCESS,
                                id: Toasts.genId()
                            }),
                            () => Toasts.show({
                                message: "Copy failed — opening Discord anyway; paste manually.",
                                type: Toasts.Type.FAILURE,
                                id: Toasts.genId()
                            })
                        );
                        try {
                            window.open("https://discord.gg/S78eecbWdx", "_blank");
                        } catch {
                            /* ignore */
                        }
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

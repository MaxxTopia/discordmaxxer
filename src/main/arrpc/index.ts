/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { resolve } from "path";
import { IpcCommands } from "shared/IpcEvents";
import { MessageChannel, Worker } from "worker_threads";

import { sendRendererCommand } from "../ipcCommands";
import { Settings } from "../settings";
import { enumerateProcesses } from "../winaudio";
import { ArRpcHostEvent, ArRpcWorkerEvent } from "./types";

let worker: Worker | undefined;

const inviteCodeRegex = /^(\w|-)+$/;

// Discordmaxxer addition: actually terminate the worker when the setting flips
// off. Upstream Vesktop's listener only ever called initArRPC, which bails
// when worker is already running — so toggling off didn't free anything.
async function teardownArRPC() {
    if (!worker) return;
    try {
        await worker.terminate();
    } catch (e) {
        console.warn("Failed to terminate arRPC worker", e);
    }
    worker = undefined;
}

async function syncArRPCToSettings() {
    if (Settings.store.arRPC) await initArRPC();
    else await teardownArRPC();
}

export async function initArRPC() {
    if (worker || !Settings.store.arRPC) return;

    try {
        const { port1: hostPort, port2: workerPort } = new MessageChannel();

        worker = new Worker(resolve(__dirname, "./arRpcWorker.js"), {
            workerData: {
                workerPort
            },
            transferList: [workerPort]
        });

        hostPort.on("message", async (message: ArRpcWorkerEvent) => {
            const { type, nonce } = message;
            switch (type) {
                case "processes-request": {
                    const response: ArRpcHostEvent = {
                        type: "processes-response",
                        nonce,
                        data: enumerateProcesses()
                    };
                    hostPort.postMessage(response);
                    break;
                }

                case "activity": {
                    sendRendererCommand(IpcCommands.RPC_ACTIVITY, message.data);
                    break;
                }

                case "invite": {
                    const invite = String(message.data);

                    const response: ArRpcHostEvent = {
                        type: "ack-invite",
                        nonce,
                        data: false
                    };

                    if (!inviteCodeRegex.test(invite)) {
                        return hostPort.postMessage(response);
                    }

                    response.data = await sendRendererCommand(IpcCommands.RPC_INVITE, invite).catch(() => false);

                    hostPort.postMessage(response);
                    break;
                }

                case "link": {
                    const response: ArRpcHostEvent = {
                        type: "ack-link",
                        nonce: nonce,
                        data: false
                    };

                    response.data = await sendRendererCommand(IpcCommands.RPC_DEEP_LINK, message.data).catch(
                        () => false
                    );

                    hostPort.postMessage(response);
                    break;
                }
            }
        });
    } catch (e) {
        console.error("Failed to start arRPC server", e);
    }
}

Settings.addChangeListener("arRPC", syncArRPCToSettings);

/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import { ipcMain } from "electron";
import { IpcEvents } from "shared/IpcEvents";

import { mainWin } from "./mainWindow";
import { validateSender } from "./utils/ipcWrappers";

const resolvers = new Map<string, Record<"resolve" | "reject", (data: any) => void>>();

export interface IpcMessage {
    nonce: string;
    message: string;
    data?: any;
}

export interface IpcResponse {
    nonce: string;
    ok: boolean;
    data?: any;
}

/**
 * Sends a message to the renderer process and waits for a response.
 * `data` must be serializable as it will be sent over IPC.
 *
 * You must add a handler for the message in the renderer process.
 */
export function sendRendererCommand<T = any>(message: string, data?: any) {
    if (mainWin.isDestroyed()) {
        console.warn("Main window is destroyed, cannot send IPC command:", message);
        return Promise.reject(new Error("Main window is destroyed"));
    }

    const nonce = randomUUID();

    const promise = new Promise<T>((resolve, reject) => {
        resolvers.set(nonce, { resolve, reject });
    });

    mainWin.webContents.send(IpcEvents.IPC_COMMAND, { nonce, message, data });

    return promise;
}

ipcMain.on(IpcEvents.IPC_COMMAND, (event, { nonce, ok, data }: IpcResponse) => {
    validateSender(event.senderFrame, IpcEvents.IPC_COMMAND);
    const resolver = resolvers.get(nonce);
    // A stale/duplicate reply (each nonce is consumed once) or a spoofed nonce
    // must be ignored, not thrown — an uncaught throw here crashes the listener.
    if (!resolver) return;

    if (ok) {
        resolver.resolve(data);
    } else {
        resolver.reject(data);
    }

    resolvers.delete(nonce);
});

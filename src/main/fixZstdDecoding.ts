/*
 * Discordmaxxer — zstd Accept-Encoding fix
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Fixes voice calls getting stuck looping "Authenticating → Disconnected"
 * (RTC close code 4017, "E2EE/DAVE protocol required").
 *
 * Root cause: Discord serves some assets — including the DAVE end-to-end
 * encryption WebAssembly module and several JS chunks/fonts — with
 * `Content-Encoding: zstd`. Once any `webRequest` listener is registered on a
 * session (Vencord registers `onHeadersReceived` to inject its CSP), Electron's
 * response-handling path can no longer decode zstd, so those responses fail
 * with `net::ERR_CONTENT_DECODING_FAILED`. The DAVE module therefore never
 * loads; Discord now *requires* DAVE for voice, so the voice server closes the
 * control socket with code 4017 and the client reconnect-loops forever — mic
 * capture (getUserMedia) succeeds but no RTCPeerConnection is ever established.
 *
 * Fix: strip `zstd` from the outgoing `Accept-Encoding` header so Discord's CDN
 * falls back to brotli/gzip, which Electron decodes correctly. No downside —
 * br/gzip are universally supported and only marginally larger than zstd.
 *
 * This can be removed once Discordmaxxer is on an Electron whose webRequest
 * response path decodes zstd (track upstream Vesktop's Electron bump).
 */

import { session } from "electron";

export function registerZstdDecodingFix() {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;

        // Header name casing isn't guaranteed; find whichever key is present.
        const key = Object.keys(headers).find(h => h.toLowerCase() === "accept-encoding");
        const value = key ? headers[key] : undefined;

        if (value && /\bzstd\b/i.test(value)) {
            headers[key!] = value
                .split(",")
                .map(token => token.trim())
                .filter(token => !/^zstd(\s*;.*)?$/i.test(token))
                .join(", ");
        }

        callback({ requestHeaders: headers });
    });
}

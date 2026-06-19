/*
 * Discordmaxxer — dm-media:// protocol proxy
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Proxies arbitrary HTTPS media URLs through a same-origin `dm-media://`
 * scheme so they bypass Chromium's Opaque Response Blocking (ORB).
 *
 * ORB blocks no-CORS cross-origin media requests in <video>/<audio> when
 * Chromium's content-type sniffer can't confidently confirm the response
 * is a media format. It runs at the network-service layer, BEFORE the
 * renderer sees the response — so neither CSP overrides nor injected
 * Cross-Origin-Resource-Policy response headers (via webRequest) help.
 *
 * The escape hatch: fetch the URL from MAIN process (Node-side, no ORB),
 * and serve the bytes through a privileged scheme registered as same-
 * origin. The renderer sees `dm-media://...` as a local resource, no
 * cross-origin check applies.
 *
 * Plugin-side usage (DMProfileFlair):
 *     const proxied = `dm-media:///${encodeURIComponent(realUrl)}`;
 *     videoEl.src = proxied;
 *
 * Security:
 *   - Only allows https:// targets (prevents file://, http://).
 *   - Blocks any target whose hostname is — or DNS-resolves to — a
 *     loopback / private / link-local / unique-local / CGNAT address.
 *     This closes the SSRF hole where a renderer (a malicious Vencord
 *     plugin or theme) could make the MAIN process read internal hosts
 *     (router admin pages, 169.254.169.254 cloud metadata, intranet apps).
 *     The check runs on the initial target AND on every redirect hop, so a
 *     public host that 302-redirects to an internal IP can't bypass it.
 *   - Caps the proxied body size (main-process memory-DoS guard).
 *   - Rejects text/html responses (a media proxy should never return a
 *     navigable HTML document).
 *   - No auth headers / cookies are forwarded — pure public-resource fetch.
 */

import { lookup } from "dns/promises";
import { app, net, protocol } from "electron";
import { isIP } from "net";

// Main-process memory guard: refuse to buffer more than this from any single
// proxied response. Banner videos are ~3MB, avatars far less; 50MB is generous
// headroom while still bounding a hostile oversized target.
const MAX_PROXY_BYTES = 50 * 1024 * 1024;
// Cap redirect chains — each hop is re-validated against the private-IP block.
const MAX_REDIRECTS = 4;

/** True if an IP literal falls in a loopback / private / link-local / ULA /
 *  CGNAT / multicast / reserved range we must never let the main process
 *  reach on the renderer's behalf. Malformed input is treated as blocked. */
function ipIsPrivate(ipRaw: string): boolean {
    const ip = ipRaw.split("%")[0]; // drop IPv6 zone id
    const fam = isIP(ip);
    if (fam === 4) {
        const p = ip.split(".").map(Number);
        if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
        const [a, b] = p;
        if (a === 0 || a === 10 || a === 127) return true;          // this-net / private / loopback
        if (a === 169 && b === 254) return true;                    // link-local (incl. cloud metadata)
        if (a === 172 && b >= 16 && b <= 31) return true;           // private
        if (a === 192 && b === 168) return true;                    // private
        if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
        if (a >= 224) return true;                                  // multicast + reserved
        return false;
    }
    if (fam === 6) {
        const v = ip.toLowerCase();
        if (v === "::1" || v === "::") return true;
        if (v.startsWith("fe80")) return true;                      // link-local
        if (v.startsWith("fc") || v.startsWith("fd")) return true;  // unique-local
        if (v.startsWith("2001:db8")) return true;                  // documentation
        if (v.startsWith("::ffff:")) return ipIsPrivate(v.slice(7));// IPv4-mapped
        return false;
    }
    return true; // not a valid IP literal where one was expected → block
}

/** Resolve a hostname and block it if it is, or maps to, a private address.
 *  Resolving (not just name-matching) defeats DNS-rebinding to internal IPs. */
async function hostIsBlocked(hostname: string): Promise<boolean> {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isIP(h)) return ipIsPrivate(h);
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
        h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
    try {
        const addrs = await lookup(h, { all: true });
        if (!addrs.length) return true;
        return addrs.some(a => ipIsPrivate(a.address));
    } catch {
        return true; // unresolvable → block rather than risk it
    }
}

/** Validate scheme + host of a URL string. Returns null if OK, else an error. */
async function validateTarget(urlStr: string): Promise<string | null> {
    let parsed: URL;
    try { parsed = new URL(urlStr); } catch { return "malformed URL"; }
    if (parsed.protocol !== "https:") return "only https:// targets allowed";
    if (await hostIsBlocked(parsed.hostname)) return "target host is not allowed";
    return null;
}

/** Fetch a URL via Electron's low-level net.request with MANUAL redirect
 *  handling so every hop is re-validated against the private-IP block, plus a
 *  hard byte cap. Returns the final response buffered (bounded by MAX_PROXY_BYTES). */
function fetchValidated(
    initialUrl: string,
    rangeHeader: string | null
): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const request = net.request({ method: "GET", url: initialUrl, redirect: "manual" });
        let hops = 0;
        request.on("redirect", (_status, _method, redirectUrl) => {
            (async () => {
                if (++hops > MAX_REDIRECTS) { request.abort(); return reject(new Error("too many redirects")); }
                const err = await validateTarget(redirectUrl);
                if (err) { request.abort(); return reject(new Error(`redirect blocked: ${err}`)); }
                request.followRedirect();
            })();
        });
        request.on("response", response => {
            const chunks: Buffer[] = [];
            let total = 0;
            response.on("data", (c: Buffer) => {
                total += c.length;
                if (total > MAX_PROXY_BYTES) { request.abort(); reject(new Error("response exceeds size cap")); return; }
                chunks.push(c);
            });
            response.on("end", () => resolve({
                status: response.statusCode,
                headers: response.headers as Record<string, string | string[]>,
                body: Buffer.concat(chunks)
            }));
            response.on("error", (e: Error) => reject(e));
        });
        request.on("error", e => reject(e));
        if (rangeHeader) request.setHeader("range", rangeHeader);
        request.end();
    });
}

// MUST be called BEFORE app.whenReady() — that's why this file is
// imported at the top of main/index.ts, where its module-level side
// effects run during the initial require pass.
protocol.registerSchemesAsPrivileged([
    {
        scheme: "dm-media",
        privileges: {
            stream: true,           // enables seekable media playback (range requests)
            supportFetchAPI: true,
            corsEnabled: true,
            bypassCSP: true,        // renderer's CSP doesn't apply to same-origin custom scheme
            standard: true,         // required for `stream: true` to take effect
            secure: true            // ALSO required for <video> URL safety check — without
                                    //   this Chromium rejects with "Media load rejected by
                                    //   URL safety check" before even fetching.
        }
    }
]);

app.whenReady().then(() => {
    protocol.handle("dm-media", async (request) => {
        // URL shape: dm-media://proxy/<url-encoded https URL>
        // Example: dm-media://proxy/https%3A%2F%2Fi.imgur.com%2Fabc.mp4
        // The `proxy` hostname is required — Chromium's <video> URL safety
        // check rejects custom-scheme URLs that lack a host component.
        const u = new URL(request.url);
        const encoded = u.pathname.replace(/^\//, "") + u.search + u.hash;
        let target: string;
        try {
            target = decodeURIComponent(encoded);
        } catch {
            return new Response("malformed target URL", { status: 400 });
        }
        const targetErr = await validateTarget(target);
        if (targetErr) {
            return new Response(targetErr, { status: targetErr === "target host is not allowed" ? 403 : 400 });
        }
        try {
            // Fetch via net.request with manual redirect validation + byte cap
            // (see fetchValidated). Each redirect hop is re-checked against the
            // private-IP block so a public host can't 302 us into the intranet.
            const upstream = await fetchValidated(target, request.headers.get("range"));

            // Normalize header values (net.request gives string | string[]).
            const pick = (k: string): string => {
                const v = upstream.headers[k] ?? upstream.headers[k.toLowerCase()];
                return Array.isArray(v) ? v[0] : (v ?? "");
            };
            const contentType = pick("content-type");
            // A media proxy must never hand back a navigable HTML document.
            if (/^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
                return new Response("refusing to proxy an HTML document", { status: 415 });
            }

            const respHeaders = new Headers();
            if (contentType) respHeaders.set("content-type", contentType);
            const contentRange = pick("content-range");
            if (contentRange) respHeaders.set("content-range", contentRange);
            respHeaders.set("content-length", String(upstream.body.length));
            // Allow ranged playback + mark cross-origin OK for any downstream check.
            respHeaders.set("accept-ranges", "bytes");
            respHeaders.set("cross-origin-resource-policy", "cross-origin");
            // Buffer is a valid Response body at runtime; the cast bridges the
            // Node typed-array generic (Uint8Array<ArrayBufferLike>) vs the DOM
            // BodyInit lib type — a TS 5.7 generic-mismatch, not a real concern.
            return new Response(upstream.body as unknown as BodyInit, {
                status: upstream.status,
                headers: respHeaders
            });
        } catch (e: any) {
            console.warn("[dm-media] proxy failed:", target.slice(0, 100), e?.message ?? e);
            return new Response(`upstream error: ${e?.message ?? "unknown"}`, { status: 502 });
        }
    });
});
